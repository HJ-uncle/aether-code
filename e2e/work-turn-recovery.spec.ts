import { expect, test } from '@playwright/test'
import type { ChatAttachment, ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { buildMentionMessage, mentionToken, type Mention } from '../src/renderer/src/contrib/chat/mention-context'
import { recoverWorkTurn } from '../src/renderer/src/contrib/work/work-turn-recovery'

function message(id: string, role: ChatMessage['role'], patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...patch }
}

const attachment: ChatAttachment = {
  path: 'attachments/original.docx', name: '原始资料.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 321, remoteUploadId: 'original-upload'
}

test.describe('Work exact-turn recovery', () => {
  for (const status of ['error', 'aborted', 'interrupted'] as const) {
    test(`recovers the original request for ${status}`, () => {
      const request = message('user-original', 'user', { content: '生成周报', runId: 'run-original', conversationId: 'turn-original', attachments: [attachment] })
      const response = message('assistant-original', 'assistant', { status, runId: 'run-original', conversationId: 'turn-original' })
      const recovered = recoverWorkTurn([request, response], response.id)
      expect(recovered).toEqual({ text: '生成周报', mentions: [], attachments: [attachment], status })
      expect(recovered!.attachments).not.toBe(request.attachments)
    })
  }

  test('an old error card cannot replay a later failure or a later unsatisfied user request', () => {
    const older = [message('user-a', 'user', { content: '指令 A' }), message('assistant-a', 'assistant', { status: 'error' })]
    const nextUser = message('user-b', 'user', { content: '指令 B' })
    expect(recoverWorkTurn([...older, nextUser], 'assistant-a')).toBeNull()
    const later = [...older, nextUser, message('assistant-b', 'assistant', { status: 'error' })]
    expect(recoverWorkTurn(later, 'assistant-a')).toBeNull()
    expect(recoverWorkTurn(later, 'assistant-b')?.text).toBe('指令 B')
  })

  test('missing original request and unknown or user target cannot recover any draft', () => {
    const response = message('assistant', 'assistant', { status: 'error' })
    expect(recoverWorkTurn([response], response.id)).toBeNull()
    expect(recoverWorkTurn([], 'missing')).toBeNull()
    expect(recoverWorkTurn([message('user', 'user', { content: '草稿不能充当失败指令' }), response], 'user')).toBeNull()
  })

  test('partial archive history cannot borrow a request from a different run or conversation', () => {
    const user = message('user-old', 'user', { content: '旧指令', runId: 'run-old', conversationId: 'turn-old' })
    expect(recoverWorkTurn([user, message('assistant', 'assistant', { status: 'error', runId: 'run-new' })], 'assistant')).toBeNull()
    expect(recoverWorkTurn([user, message('assistant', 'assistant', { status: 'error', conversationId: 'turn-new' })], 'assistant')).toBeNull()
  })

  test('recovery is unavailable while executing, awaiting a response, or after success', () => {
    for (const status of ['streaming', 'waiting', 'done'] as const) {
      expect(recoverWorkTurn([message('user', 'user', { content: '指令' }), message('assistant', 'assistant', { status })], 'assistant')).toBeNull()
    }
  })

  test('restores mention snapshots and uploaded attachment identity from the selected request', () => {
    const mention: Mention = { source: 'code', displayText: '周报.ts:2', path: 'src/周报.ts', startLine: 2, endLine: 2, content: 'const value = "原始快照"', textOffset: 4 }
    const text = `请核对 ${mentionToken(mention)} 并保留格式`
    const original = message('user', 'user', { content: buildMentionMessage(text, [mention]), attachments: [attachment] })
    const response = message('assistant', 'assistant', { status: 'error', content: '不是原指令' })
    const recovered = recoverWorkTurn([original, response], response.id)
    expect(recovered?.text).toBe(text)
    expect(recovered?.mentions).toEqual([mention])
    expect(recovered?.attachments).toEqual([attachment])
    expect(recovered?.text).not.toContain('aether-refs:')
    expect(recovered?.text).not.toContain('原始快照')
  })

  test('attachment-only requests can recover while truly empty requests cannot', () => {
    const response = message('assistant', 'assistant', { status: 'aborted' })
    expect(recoverWorkTurn([message('user', 'user', { attachments: [attachment] }), response], response.id)?.attachments).toEqual([attachment])
    expect(recoverWorkTurn([message('user', 'user', { content: ' \n ' }), response], response.id)).toBeNull()
  })
})
