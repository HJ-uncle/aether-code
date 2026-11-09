/** Rollback protocol, confirmation cancellation, partial progress and preview invalidation. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import { getRevertReport, revertConversationFrom, revertSummary, type RevertReport } from '../src/renderer/src/core/engine/change-revert'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'
import { workPreviewRevision } from '../src/renderer/src/core/workbench/preview-request'
import { remoteRequestError } from '../src/main/engine/protocol'

const user = { id: 'user', role: 'user', content: '生成文档' }
const changes = [{ id: 'command', path: '/project/generator.js', status: 'accepted', requiresExplicitRevert: true },
  { id: 'file', path: '/project/交付/report.txt', status: 'pending' }]
const complete: RevertReport = { total: 2, reverted: 2, conflicts: 0, unavailable: 0, failed: 0,
  results: changes.map(item => ({ id: item.id, path: item.path, status: 'reverted' })) }
test.beforeEach(({}, info) => publishEngineSource({ mode: 'remote', baseUrl: `http://rollback/${info.title}`, phase: 'ready' }))

function fixture(report = complete) {
  const calls: EngineRequestInput[] = []
  const request = async <T>(input: EngineRequestInput): Promise<T> => {
    calls.push(input)
    return (input.path === '/conversation/history' ? [{ ...user, conversationId: 'turn-1' }]
      : input.path === '/changes/revert-preview' ? { total: changes.length, changes }
        : input.path === '/changes/revert-batch' ? report : {}) as T
  }
  return { calls, request }
}

test('remote mode allows both reviewed rollback routes and rejects unrelated mutations', () => {
  expect(remoteRequestError('remote', 'POST', '/changes/revert-preview')).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/changes/revert-batch')).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/changes/revert-anything')).not.toBeNull()
})

test('summary includes implicitly cleaned folders without counting them as files or twice', () => {
  const report: RevertReport = { ...complete, total: 3, reverted: 3,
    removedDirectories: ['/project/交付', '/project/explicit'],
    results: [...complete.results, { id: 'directory', path: '/project/explicit', entryType: 'directory', status: 'reverted' }] }
  expect(revertSummary(report)).toBe('已撤回 2 个文件、2 个文件夹（3 处改动）')
})

test('one scope preview confirms command IDs and truncates only after all files succeed', async () => {
  const { calls, request } = fixture()
  const source = getEngineSource(), before = workPreviewRevision(source, 'session', undefined)
  await revertConversationFrom(request, 'session', user, async preview => {
    expect(preview.changes).toEqual(changes)
    expect(calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-preview'])
    return true
  })
  expect(calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-preview', '/changes/revert-batch', '/conversation/truncate'])
  expect(calls[2].body).toEqual({ sessionId: 'session', scope: 'all', fromTurnId: 'turn-1', reviewedCommandChangeIds: ['command'] })
  expect(calls[3].body).toEqual({ sessionId: 'session', messageId: 'user' })
  expect(workPreviewRevision(source, 'session', undefined)).toBeGreaterThan(before)
  expect(workPreviewRevision(source, 'session', '/unmounted/file')).toBeGreaterThan(before)
  expect(workPreviewRevision(source, 'other-session', undefined)).toBe(0)
})

test('cancel after scope preview performs no rollback or history mutation', async () => {
  const { calls, request } = fixture()
  expect(await revertConversationFrom(request, 'cancelled', user, async () => false)).toBeNull()
  expect(calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-preview'])
  expect(getRevertReport('cancelled')).toBeNull()
})

test('partial rollback publishes persistent result and invalidates files before preserving history', async () => {
  const partial: RevertReport = { ...complete, reverted: 1, conflicts: 1, results: [complete.results[1],
    { ...complete.results[0], status: 'conflict', message: 'generator.js has a newer edit' }] }
  const { calls, request } = fixture(partial)
  const source = getEngineSource()
  await expect(revertConversationFrom(request, 'partial', user, async () => true)).rejects.toThrow('对话历史已保留')
  expect(calls.some(call => call.path === '/conversation/truncate')).toBe(false)
  expect(getRevertReport('partial')).toEqual(partial)
  expect(workPreviewRevision(source, 'partial', '/project/交付/report.txt')).toBeGreaterThan(0)
})

test('changing engine while confirmation is open cannot mutate the new engine', async () => {
  const { calls, request } = fixture()
  await expect(revertConversationFrom(request, 'session', user, async () => {
    publishEngineSource({ mode: 'remote', baseUrl: 'http://other-engine', phase: 'ready' })
    return true
  })).rejects.toThrow('引擎连接已变化')
  expect(calls).toHaveLength(2)
})
