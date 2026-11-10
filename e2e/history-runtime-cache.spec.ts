/** History mutations evict rolled-back work and fence delayed cache reads;
 * retained work can be hydrated again without losing Code/Work ownership. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import type { SubagentRunV1 } from '../src/shared/subagent'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import { invalidateHistoryRuntimeCache } from '../src/renderer/src/core/engine/history-runtime-cache'
import { getSubagentRuns, ingestSubagentRun, refreshSubagentRun, restartSubagentDirectory } from '../src/renderer/src/core/engine/subagent-store'
import { activateCommandSession, deactivateCommandSession, getCommandJobs, ingestCommandJob,
  refreshCommandJobs, refreshCommandOutput } from '../src/renderer/src/core/engine/command-job-store'
import { attachSubagentRuns } from '../src/renderer/src/core/engine/subagent-state'
import { sumUsage } from '../src/renderer/src/contrib/chat/usage'

function child(id: string, sessionId = 'parent', totalTokens = 100): SubagentRunV1 {
  return { schemaVersion: 1, runId: id, tenantId: 'test', rootSessionId: sessionId,
    parentSessionId: sessionId, parentConversationId: 'removed-turn', parentMessageId: `message-${id}`,
    parentToolCallId: `tool-${id}`, childSessionId: `session-${id}`, task: id, description: id,
    modelId: 'fixture-model', status: 'succeeded', lastSeq: 2, createdAt: 1000, startedAt: 1000,
    updatedAt: 298365, finishedAt: 298365, toolCalls: [], usage: { totalTokens } }
}
function command(id: string, sessionId = 'parent'): CommandJobSnapshot {
  return { schemaVersion: 1, jobId: id, sessionId, ownerSessionId: sessionId, runId: `root-${id}`,
    turnId: `turn-${id}`, version: 1, status: 'succeeded', command: 'fixture', args: [], cwd: '/fixture',
    background: true, createdAt: 1000, updatedAt: 2000, finishedAt: 2000, exitCode: 0, signal: null,
    cursor: 0, earliestCursor: 0 }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let read: (input: EngineRequestInput) => Promise<unknown>
let windowDescriptor: PropertyDescriptor | undefined
test.beforeEach(() => {
  windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  publishEngineSource({ mode: 'remote', baseUrl: 'http://runtime-cache.fixture', instanceId: test.info().title, phase: 'ready' })
  read = async input => { throw new Error(`Unexpected fixture request ${input.path}`) }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => input.path === '/subagent/capabilities'
      ? { ok: false, code: 404, message: 'Legacy fixture' }
      : { ok: true, code: 200, data: await read(input) }
  } } } })
})
test.afterEach(() => {
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'idle' })
})

test('rolled-back child usage cannot reappear as orphan messages; retained sessions and rehydrated work survive', () => {
  ingestSubagentRun(child('removed-word', 'parent', 143847))
  ingestSubagentRun(child('removed-excel', 'parent', 496410))
  ingestSubagentRun(child('other-child', 'other-parent', 23))
  const stale = attachSubagentRuns([], getSubagentRuns('parent'), true)
  expect(sumUsage(stale).total).toBe(640257)
  invalidateHistoryRuntimeCache('parent')
  expect(attachSubagentRuns([], getSubagentRuns('parent'), true)).toEqual([])
  expect(getSubagentRuns('other-parent').map(run => run.runId)).toEqual(['other-child'])
  ingestSubagentRun(child('retained-earlier', 'parent', 57))
  expect(sumUsage(attachSubagentRuns([], getSubagentRuns('parent'), true)).total).toBe(57)
})

test('an old child directory response cannot recreate a rolled-back run or overwrite its replacement read', async () => {
  const pending = deferred<unknown>(), requested = deferred<void>()
  read = async input => { expect(input.path).toBe('/subagent/runs'); requested.resolve(); return pending.promise }
  const oldRead = restartSubagentDirectory('parent')
  await requested.promise
  invalidateHistoryRuntimeCache('parent')
  read = async () => [child('retained-earlier')]
  await restartSubagentDirectory('parent')
  pending.resolve([child('removed')])
  await oldRead
  expect(getSubagentRuns('parent').map(run => run.runId)).toEqual(['retained-earlier'])
})

test('an old child detail response is fenced after history mutation', async () => {
  ingestSubagentRun(child('removed'))
  const pending = deferred<unknown>(), requested = deferred<void>()
  read = async input => { expect(input.path).toBe('/subagent/runs/removed'); requested.resolve(); return pending.promise }
  const oldRead = refreshSubagentRun('removed')
  await requested.promise
  invalidateHistoryRuntimeCache('parent')
  pending.resolve(child('removed'))
  await oldRead
  expect(getSubagentRuns('parent')).toEqual([])
})

test('command cache replacement fences old listings and output while keeping both surface owners subscribed', async () => {
  activateCommandSession('parent', 'work')
  activateCommandSession('parent', 'code')
  ingestCommandJob(command('removed'))
  const listing = deferred<unknown>(), output = deferred<unknown>()
  read = async input => input.path === '/command-jobs' ? listing.promise : output.promise
  const oldListing = refreshCommandJobs('parent')
  const oldOutput = refreshCommandOutput('parent', 'removed').then(() => 'unexpected success', error => String(error))
  invalidateHistoryRuntimeCache('parent')
  expect(getCommandJobs('parent')).toEqual([])
  // Keeping the second owner matters when one surface leaves after rollback.
  deactivateCommandSession('work')
  expect(ingestCommandJob(command('retained-earlier'))?.jobId).toBe('retained-earlier')
  listing.resolve({ jobs: [command('removed')] })
  output.resolve({ job: command('removed'), entries: [], nextCursor: 0, earliestCursor: 0, truncated: false, hasMore: false })
  await oldListing
  expect(await oldOutput).toContain('命令会话已切换')
  expect(getCommandJobs('parent').map(job => job.jobId)).toEqual(['retained-earlier'])
})
