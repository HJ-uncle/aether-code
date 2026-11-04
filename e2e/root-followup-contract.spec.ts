/** Pure composer contracts. Does not launch Electron or claim mailbox delivery. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import { rootFollowupLimitation, rootFollowupMessage, rootFollowupRun } from '../src/renderer/src/contrib/chat/root-followup'
import { userMessageDraft } from '../src/renderer/src/contrib/chat/mention-context'

const run: RootRun = { schemaVersion: 1, runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1', userMessageId: 'u', assistantMessageId: 'a', version: 1, seq: 1, status: 'running', createdAt: 1, updatedAt: 1, pending: [] }
test('current composer uses the independently bound run and newest status, never an older active run', () => {
  const history = [{ run }, { run: { ...run, version: 3, status: 'cancelled' as const } }, { run: { ...run, version: 2 } }]
  expect(rootFollowupRun(history, 'session-1', 'run-1')?.status).toBe('cancelled')
  expect(rootFollowupRun(history, 'session-2', 'run-1')).toBeUndefined()
  expect(rootFollowupRun(history, 'session-1', 'run-2')).toBeUndefined()
  expect(rootFollowupRun(history, 'session-1', undefined)).toBeUndefined()
  expect(rootFollowupRun([{ run, runId: 'different' }], 'session-1', 'run-1')).toBeUndefined()
})
test('immediate followup serializes exact selected code and can recover its original chip', () => {
  const mentions = [{ source: 'code' as const, path: 'src/a.ts', displayText: '选中的代码', startLine: 3, endLine: 4, content: 'const exact = 42', textOffset: 3 }]
  const text = '检查 @src/a.ts:3-4'
  const message = rootFollowupMessage(text, mentions, [])
  expect(message).toContain('const exact = 42')
  expect(userMessageDraft(message).mentions[0].content).toBe('const exact = 42')
})
test('mailbox text does not silently drop attachments or executable agent delegation', () => {
  const attachment = { path: 'remote/opaque', name: 'image.png', type: 'image/png', size: 10, remoteUploadId: 'upload-1' }
  expect(rootFollowupLimitation([], [attachment])).toContain('附件请排到下一轮')
  expect(() => rootFollowupMessage('看图', [], [attachment])).toThrow(/附件请排到下一轮/)
  expect(() => rootFollowupMessage('@agent 执行', [{ source: 'agent', path: 'agent-1', displayText: 'Agent', textOffset: 0 }], [])).toThrow(/协作 Agent 请排到下一轮/)
  expect(rootFollowupMessage('先处理这个要求', [], [])).toBe('先处理这个要求')
})
