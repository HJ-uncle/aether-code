/** Multi-file receipts survive live events, durable history and late background completion. */
import { expect, test } from '@playwright/test'
import { mergeFileChanges } from '../src/renderer/src/core/engine/tool-file-changes'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { attachCommandJobs } from '../src/renderer/src/core/engine/command-job-state'
import { workArtifacts } from '../src/renderer/src/contrib/work/work-state'
import { clientCapabilities, setWorkbenchConnected } from '../src/renderer/src/core/workbench/capabilities'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { EngineFileChange } from '../src/shared/ipc'
import { remoteRequestError } from '../src/main/engine/protocol'

const change = (id: string): EngineFileChange => ({ id, path: `D:/project/${id}.txt`, kind: 'write', status: 'pending',
  createdAt: 1, oldContent: null, newContent: null, truncated: true, source: 'command-observation', requiresExplicitRevert: true })
const a = change('a'), b = change('b')
const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'job', sessionId: 'session', ownerSessionId: 'session', runId: 'run', turnId: 'turn', toolCallId: 'cmd',
  version: 2, status: 'cancelled', command: 'node', args: ['generate.js'], cwd: 'D:/project', background: true,
  createdAt: 1, updatedAt: 2, finishedAt: 2, exitCode: null, signal: null, cursor: 0, earliestCursor: 0, changes: [a, b] }
const rows = [
  { id: 'assistant', role: 'assistant', conversationId: 'turn', metadata: { runId: 'run' }, toolCall: { id: 'cmd', name: 'execute_cmd', args: {} } },
  { role: 'tool', toolCallId: 'cmd', content: 'completed', metadata: { success: true, changes: [a, b] } }
]

test('all command outputs restore from history as distinct artifacts without duplicate primary receipt', () => {
  const messages = replayMessages(rows)
  expect(messages[0].tools[0].changes?.map(item => item.id)).toEqual(['a', 'b'])
  messages[0].tools[0].change = a
  expect(workArtifacts(messages).map(item => item.path).sort()).toEqual([a.path, b.path])
})

test('late pending receipts cannot reverse kept/reverted decisions or replace full snapshots', () => {
  const decided = { ...a, status: 'reverted' as const, oldContent: 'before', newContent: 'after', truncated: false }
  const merged = mergeFileChanges(decided, a, b, a)
  expect(merged).toHaveLength(2)
  expect(merged[0]).toMatchObject({ status: 'reverted', oldContent: 'before', newContent: 'after', truncated: false })
  expect(a.status).toBe('pending')
  expect(mergeFileChanges(a, { ...a, path: 'D:/other/file' })[0].path).toBe(a.path)
  expect(mergeFileChanges({ id: 'bad' }, null, [a])).toEqual([a])
})

test('background cancellation receipts refresh artifacts after the stream ends, without crossing run/session', () => {
  const messages = replayMessages(rows.map(row => row.role === 'tool' ? { ...row, metadata: { success: true } } : row))
  const attached = attachCommandJobs(messages, [job], 'session')
  expect(attached[0].tools[0]).toMatchObject({ state: 'cancelled', changes: [a, b] })
  expect(workArtifacts(attached)).toHaveLength(2)
  for (const bad of [{ ...job, runId: 'retry-run' }, { ...job, sessionId: 'other' }, { ...job, ownerSessionId: 'child' }])
    expect(attachCommandJobs(messages, [bad], 'session')).toBe(messages)
})

test('old workbench cleanup cannot erase a replacement connection or advertise a different session', () => {
  setWorkbenchConnected(123, 'one', 'old', true, 'work')
  setWorkbenchConnected(123, 'one', 'new', true, 'work')
  expect(setWorkbenchConnected(123, 'one', 'old', false, 'work')).toBe(false)
  expect(clientCapabilities(123, 'one', 'work').connected).toBe(true)
  expect(clientCapabilities(123, 'two', 'work').connected).toBe(false)
  expect(clientCapabilities(123, 'one', 'code').connected).toBe(false)
  setWorkbenchConnected(123, 'one', 'code-owner', true, 'code')
  setWorkbenchConnected(123, 'one', 'new', false, 'work')
  expect(clientCapabilities(123, 'one', 'work').connected).toBe(false)
  expect(clientCapabilities(123, 'one', 'code').connected).toBe(true)
  setWorkbenchConnected(123, 'one', 'code-owner', false, 'code')
})

test('remote workbench permits only exact authenticated POST transport endpoints', () => {
  for (const path of ['/workbench/clients', ...['poll', 'state', 'results', 'disconnect'].map(action => `/workbench/clients/client-1/${action}`)]) {
    expect(remoteRequestError('remote', 'POST', path)).toBeNull()
    for (const method of ['GET', 'DELETE', 'PUT']) expect(remoteRequestError('remote', method, path)).not.toBeNull()
  }
  for (const path of ['/workbench/execute', '/workbench/clients/client-1/evaluate', '/workbench/clients/client-1/results/extra'])
    expect(remoteRequestError('remote', 'POST', path)).not.toBeNull()
})
