/** Pure projections only: no Electron, workspace writes or engine process. */
import { expect, test } from '@playwright/test'
import { workArtifacts } from '../src/renderer/src/contrib/work/work-state'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { EngineFileChange } from '../src/shared/ipc'

const change = (id: string, seq = 1): EngineFileChange => ({ id, sessionId: 'root-session', path: `D:/project/${id}.txt`,
  seq, kind: 'write', status: 'pending', createdAt: seq, oldContent: null, newContent: `file ${id}`, truncated: false })
const parent: ChatMessage = { id: 'parent', role: 'assistant', runId: 'root-run', conversationId: 'root-turn',
  status: 'done', content: '', thinking: '', tools: [], items: [], createdAt: 1 }
const child: CommandJobSnapshot = { schemaVersion: 1, jobId: 'child-job', sessionId: 'root-session', ownerSessionId: 'child-session',
  runId: 'root-run', ownerRunId: 'child-run', turnId: 'root-turn', toolCallId: 'child-command', version: 2,
  command: 'node', args: ['generate.js'], cwd: 'D:/project', background: true, status: 'succeeded',
  createdAt: 1, updatedAt: 2, finishedAt: 2, exitCode: 0, signal: null, cursor: 0, earliestCursor: 0,
  changes: [change('report'), change('notes', 2)] }

test('a visible matching root run exposes child command artifacts without a root command card', () => {
  const artifacts = workArtifacts([parent], [child], 'root-session')
  expect(parent.tools).toEqual([])
  expect(artifacts.map(item => [item.id, item.status])).toEqual([['notes', 'ready'], ['report', 'ready']])
  expect(workArtifacts([parent])).toEqual([])
  expect(workArtifacts([parent], [child])).toEqual([])
})

test('child receipts cannot cross root session, run or turn boundaries', () => {
  for (const patch of [{ sessionId: 'other-session' }, { runId: 'other-run' }, { turnId: 'other-turn' },
    { runId: undefined, turnId: undefined }, { ownerSessionId: 'root-session' }, { background: false }]) {
    expect(workArtifacts([parent], [{ ...child, ...patch }], 'root-session'), JSON.stringify(patch)).toEqual([])
  }
  expect(workArtifacts([parent], [child], 'another-session')).toEqual([])
  expect(workArtifacts([parent], [{ ...child, changes: [{ ...change('foreign'), sessionId: 'another-session' }] }], 'root-session')).toEqual([])
})

test('retained child jobs do not resurrect artifacts after their owning parent turn is removed', () => {
  expect(workArtifacts([], [child], 'root-session')).toEqual([])
  const unrelated = { ...parent, id: 'unrelated', runId: 'new-run', conversationId: 'new-turn' }
  expect(workArtifacts([unrelated], [child], 'root-session')).toEqual([])
  expect(workArtifacts([unrelated, parent], [child], 'root-session')).toHaveLength(2)
})

test('duplicate child and tool receipts produce one artifact and preserve an explicit revert', () => {
  const receipt = change('same')
  const message = { ...parent, tools: [{ id: 'tool', name: 'subagent_wait', args: '{}', result: '', state: 'done' as const,
    change: receipt, changes: [receipt] }] }
  const job = { ...child, changes: [receipt, receipt] }
  expect(workArtifacts([message], [job, job], 'root-session')).toHaveLength(1)
  const reverted = { ...receipt, status: 'reverted' as const }
  expect(workArtifacts([{ ...message, tools: [{ ...message.tools[0], change: reverted, changes: [reverted] }] }], [job], 'root-session')).toEqual([])
})

test('failed and cancelled child writes stay inspectable but never become certified artifacts', () => {
  for (const status of ['failed', 'cancelled', 'cancelling', 'timed_out', 'interrupted'] as const) {
    expect(workArtifacts([parent], [{ ...child, status }], 'root-session').map(item => item.status), status).toEqual(['unverified', 'unverified'])
  }
  expect(workArtifacts([parent], [{ ...child, status: 'running' }], 'root-session').map(item => item.status)).toEqual(['draft', 'draft'])
})

test('child deletion receipts apply chronological path history without reviving deleted versions', () => {
  const original = change('file', 1), removed = { ...change('delete', 2), path: original.path, kind: 'delete' as const },
    recreated = { ...change('new', 3), path: original.path }
  const result = workArtifacts([parent], [{ ...child, changes: [recreated, removed, original] }], 'root-session')
  expect(result.map(item => [item.id, item.status])).toEqual([['new', 'ready'], ['file', 'deleted']])
})
