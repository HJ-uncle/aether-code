/** D7 command ownership/version, background dispatch semantics, output cursors and recovery. */
import { expect, test } from '@playwright/test'
import type { CommandJobOutput, CommandJobSnapshot } from '../src/shared/command-job'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { RootRun } from '../src/shared/root-run'
import { attachCommandJobs, visibleChildCommandJobs, commandStatusLabels, emptyCommandOutput, exportCommandJob, mergeCommandJob, mergeCommandOutput, normalizeCommandJob } from '../src/renderer/src/core/engine/command-job-state'
import { finishTool, replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
import { restoreChatSnapshot } from '../src/renderer/src/core/engine/chat-recovery'

const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'job', sessionId: 'session', ownerSessionId: 'session', runId: 'root', turnId: 'turn', toolCallId: 'cmd', version: 1, status: 'running', command: 'node', args: ['worker.cjs'], cwd: 'D:/workspace', background: true, createdAt: 1, updatedAt: 1, exitCode: null, signal: null, cursor: 0, earliestCursor: 0 }
const tool: ToolActivity = { id: 'cmd', name: 'execute_cmd', args: '{}', result: '', state: 'running' }
const message: ChatMessage = { id: 'assistant', role: 'assistant', runId: 'root', conversationId: 'turn', content: '', thinking: '', tools: [tool], items: [{ kind: 'tool', id: 'cmd' }], status: 'streaming', createdAt: 1 }
const run: RootRun = { schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant', seq: 1, version: 2, status: 'succeeded', createdAt: 1, updatedAt: 2, pending: [] }
function page(entries: CommandJobOutput['entries'], patch: Partial<CommandJobOutput> = {}): CommandJobOutput { return { job, entries, nextCursor: entries.at(-1)?.seq ?? 0, earliestCursor: 0, truncated: false, hasMore: false, ...patch } }

test('job schema rejects wrong versions, corrupt identity, statuses and cursors', () => {
  expect(normalizeCommandJob(job)).toBe(job)
  for (const patch of [{ schemaVersion: 2 }, { jobId: 12 }, { sessionId: '' }, { ownerSessionId: '' }, { status: 'done' }, { version: -1 }, { cursor: -1 }, { earliestCursor: 1 }, { args: ['ok', 42] }]) expect(normalizeCommandJob({ ...job, ...patch })).toBeUndefined()
})
test('dispatch success preserves running background state, late dispatch cannot overwrite terminal status', () => {
  const dispatched = finishTool(tool, { success: true, output: 'launched', metadata: { commandJob: job } })
  expect(dispatched).toMatchObject({ state: 'running', commandJob: job })
  const done = { ...job, version: 3, status: 'failed' as const, exitCode: 7, error: { code: 'COMMAND_EXIT_NONZERO', message: 'exit 7' } }
  const current = { ...dispatched, commandJob: done, state: 'error' as const }
  expect(finishTool(current, { success: true, metadata: { commandJob: job } })).toMatchObject({ state: 'error', commandJob: done, error: 'exit 7' })
})
test('foreground calls keep ordinary tool behavior and do not create background cards', () => {
  const result = finishTool(tool, { success: true, output: 'done', metadata: { commandJob: { ...job, background: false } } })
  expect(result.state).toBe('done'); expect(result.commandJob).toBeUndefined()
  expect(attachCommandJobs([message], [{ ...job, background: false }], 'session')).toEqual([message])
})
test('job versions cannot rewrite ownership or revive cancelled/interrupted completion', () => {
  for (const patch of [{ sessionId: 'other' }, { ownerSessionId: 'child' }, { runId: 'other-root' }, { toolCallId: 'other' }, { turnId: 'other' }]) expect(mergeCommandJob(job, { ...job, ...patch, version: 2 })).toBe(job)
  const cancelled = { ...job, version: 4, status: 'cancelled' as const }
  expect(mergeCommandJob(cancelled, { ...job, version: 5 })).toBe(cancelled)
  expect(mergeCommandJob(cancelled, { ...cancelled, version: 3 })).toBe(cancelled)
})
test('root completion does not turn a running background job into interruption', () => {
  const launched = { ...message, tools: [finishTool(tool, { success: true, metadata: { commandJob: job } })] }
  const result = applyRootRun([launched], run)[0]
  expect(result.status).toBe('done'); expect(result.tools[0].state).toBe('running'); expect(result.tools[0].commandJob?.status).toBe('running')
})
test('root session matching also requires original turn/run and never attaches child jobs to reused tool IDs', () => {
  const other = { ...message, id: 'other', runId: 'root-2', conversationId: 'turn-2' }
  const attached = attachCommandJobs([message, other], [job], 'session')
  expect(attached[0].tools[0].commandJob).toBe(job); expect(attached[1]).toBe(other)
  expect(attachCommandJobs([message], [{ ...job, ownerSessionId: 'child', ownerRunId: 'child-run' }], 'session')).toEqual([message])
  expect(attachCommandJobs([message], [job], 'different')).toEqual([message])
  const child = { ...job, ownerSessionId: 'child', ownerRunId: 'child-run' }
  expect(visibleChildCommandJobs([message], [child], 'session')).toEqual([child])
  expect(visibleChildCommandJobs([other], [child], 'session')).toEqual([])
  expect(visibleChildCommandJobs([], [child], 'session')).toEqual([])
  expect(visibleChildCommandJobs([message], [child], 'different')).toEqual([])
  expect(visibleChildCommandJobs([message], [{ ...child, runId: undefined, turnId: undefined }], 'session')).toEqual([])
})
test('history and fresh recovery snapshot override old dispatch with cancelled job and reason', () => {
  const rows = [{ id: 'assistant', role: 'assistant', conversationId: 'turn', metadata: { runId: 'root' }, toolCall: { id: 'cmd', name: 'execute_cmd' } }, { role: 'tool', toolCallId: 'cmd', content: 'launched', metadata: { success: true, commandJob: job } }]
  expect(replayMessages(rows)[0].tools[0].state).toBe('running')
  const interrupted = { ...job, version: 3, status: 'interrupted' as const, error: { code: 'ENGINE_RESTARTED', message: 'not restarted' } }
  const restored = restoreChatSnapshot({ schemaVersion: 1, source: 'persisted', sessionId: 'session', eventId: null, finished: true, projection: [], runs: [run], history: rows, todos: [], changes: [], commandJobs: [interrupted] })
  expect(restored.messages[0].tools[0]).toMatchObject({ commandJob: interrupted, state: 'interrupted', error: 'not restarted' })
  expect(exportCommandJob(interrupted)).toContain('已中断'); expect(exportCommandJob(interrupted)).toContain('not restarted')
})
test('stdout/stderr sequence cursors append once across repeated pages and never use latest snapshot cursor', () => {
  const first = page([{ seq: 1, stream: 'stdout', text: 'one\n' }, { seq: 2, stream: 'stderr', text: 'two\n' }], { job: { ...job, cursor: 9 }, hasMore: true })
  let output = mergeCommandOutput(emptyCommandOutput, first)
  expect(output.cursor).toBe(2)
  output = mergeCommandOutput(output, first)
  output = mergeCommandOutput(output, page([{ seq: 2, stream: 'stderr', text: 'two\n' }, { seq: 3, stream: 'stdout', text: 'three\n' }]))
  expect(output.entries.map(entry => entry.text).join('')).toBe('one\ntwo\nthree\n'); expect(output.cursor).toBe(3)
})
test('expired output cursors preserve explicit gap warning and renderer output stays bounded', () => {
  let output = mergeCommandOutput(emptyCommandOutput, page([{ seq: 11, stream: 'stdout', text: 'tail' }], { earliestCursor: 10, truncated: true }))
  expect(output.truncated).toBe(true); expect(output.cursor).toBe(11)
  for (let seq = 12; seq < 20; seq++) output = mergeCommandOutput(output, page([{ seq, stream: 'stdout', text: 'x'.repeat(65536) }]))
  expect(output.bytes).toBeLessThanOrEqual(256 * 1024); expect(output.entries.at(-1)?.seq).toBe(19); expect(output.truncated).toBe(true)
})
test('malformed or backwards output pages are refused and every terminal reason remains distinct', () => {
  expect(() => mergeCommandOutput({ ...emptyCommandOutput, cursor: 4 }, page([], { nextCursor: 3 }))).toThrow()
  expect(() => mergeCommandOutput(emptyCommandOutput, page([{ seq: 2, stream: 'stdout', text: 'b' }, { seq: 1, stream: 'stdout', text: 'a' }], { nextCursor: 2 }))).toThrow()
  expect(commandStatusLabels).toMatchObject({ cancelled: '已取消', timed_out: '已超时', interrupted: '已中断', failed: '失败', cancelling: '正在停止' })
})
