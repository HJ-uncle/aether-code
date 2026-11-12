/** Pure attachment identity contracts: wire labels, draft persistence, queue
 * staging/merge, remote sanitization, history replay and readable export. */
import { expect, test } from '@playwright/test'
import { buildMentionMessage, parseMentionContent, userMessageDraft, type Mention } from '../src/renderer/src/contrib/chat/mention-context'
import { loadChatDraftState, saveChatDraft, saveChatDraftForSubmission } from '../src/renderer/src/contrib/chat/draft-store'
import { dispatchChatRequest } from '../src/renderer/src/core/engine/chat-send-request'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { serializeMessages } from '../src/renderer/src/contrib/chat/message-export'
import { remoteAttachmentsForRequest, rememberRemoteAttachment, clearRemoteAttachments } from '../src/main/engine/remote-attachments'
import { mergeQueueAttachmentReferences, remapQueueAttachmentReferences } from '../src/shared/queue-attachment-references'
import type { QueueAttachmentReceipt } from '../src/shared/next-turn-queue'

const file = { path: '.ae/attachments/a.png', name: '设计原稿.png', type: 'image/png', size: 25, attachmentId: 'attachment-a', referenceLabel: '图1' }
const ref = (path = file.path, id = file.attachmentId, label = '图1'): Mention => ({ source: 'file', origin: 'attachment', path, attachmentId: id, displayText: label, textOffset: 0 })

test('attachment label and identity survive a frozen path and repeated references without promoting hand-written text', () => {
  const text = `手写 @${file.path}；比较 @${file.path} 与 @b.png，再看 @${file.path}`
  const mentions = [{ ...ref(), textOffset: text.indexOf('；比较 ') + 4 },
    { ...ref('b.png', 'attachment-b', '图2'), textOffset: text.indexOf('@b.png') },
    { ...ref(), textOffset: text.lastIndexOf('@' + file.path) }]
  const frozen = remapQueueAttachmentReferences({ text, mentions: mentions.map(item => ({ ...item, textOffset: item.textOffset! })), revision: 1 }, new Map([[file.path, 'D:/repo/.ae/attachments/next-turn-a.png']]))
  const wire = buildMentionMessage(frozen.text, frozen.mentions)
  expect(wire).toContain('图1（文件：D:/repo/.ae/attachments/next-turn-a.png）')
  expect(wire).toContain('图2（文件：b.png）')
  expect(wire).toContain(`手写 @${file.path}`)
  // Existing serialization separates a chip from adjoining punctuation, so the
  // later reference moves by one UTF-16 code unit on its first wire round trip.
  expect(userMessageDraft(wire)).toEqual({ text: frozen.text.replace('@b.png，', '@b.png ，'),
    mentions: [frozen.mentions[0], frozen.mentions[1], { ...frozen.mentions[2], textOffset: frozen.mentions[2].textOffset + 1 }] })
  expect(parseMentionContent(wire).refs.map(item => item.a)).toEqual(['attachment-a', 'attachment-b', 'attachment-a'])
})

test('draft persists attachment-only content, keeps nonempty edits, and clears submitted attachments', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  } })
  try {
    saveChatDraft('test', '', 'attachment-tests', [], 1, { attachments: [file], root: 'D:/repo' })
    expect(loadChatDraftState('test', 'attachment-tests')).toMatchObject({ attachments: [file], attachmentRoot: 'D:/repo' })
    saveChatDraft('test', '检查设计', 'attachment-tests')
    expect(loadChatDraftState('test', 'attachment-tests').attachments).toEqual([file])
    saveChatDraftForSubmission('test', '', 'attachment-tests', [], 5, { attachments: [{ ...file, remoteUploadId: 'live-only' }], root: null })
    expect(loadChatDraftState('test', 'attachment-tests')).toEqual({ text: '', mentions: [], revision: 5, attachments: [file] })
    saveChatDraft('test', '', 'attachment-tests')
    expect(loadChatDraftState('test', 'attachment-tests').attachments).toBeUndefined()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('direct and remote requests retain the exact attachment label snapshot', async () => {
  const bodies: Record<string, unknown>[] = []
  await dispatchChatRequest(async body => { bodies.push(body) }, '正文', { sessionId: 's', attachments: [file] }, false)
  await dispatchChatRequest(async body => { bodies.push(body) }, '正文', { sessionId: 's', attachments: [{ ...file, remoteUploadId: 'token' }] }, true)
  expect(bodies[0].attachments).toEqual([{ name: file.path, type: file.type, displayName: file.name, size: file.size, attachmentId: file.attachmentId, referenceLabel: '图1' }])
  expect(bodies[1].attachments).toEqual([{ remoteUploadId: 'token', displayName: file.name, size: file.size, attachmentId: file.attachmentId, referenceLabel: '图1' }])
})

test('remote attachment sanitizer preserves metadata after resolving the session-owned upload receipt', () => {
  const target = { mode: 'remote' as const, baseUrl: 'https://attachment.invalid', instanceId: 'test' }
  try {
    const remoteUploadId = rememberRemoteAttachment(target, 's', file.path, file.type)
    const input = { remoteUploadId, attachmentId: file.attachmentId, referenceLabel: '图9', displayName: file.name, size: file.size }
    expect(remoteAttachmentsForRequest([input], target, 's')).toEqual([{ name: file.path, type: file.type, ...input, remoteUploadId: undefined }].map(({ remoteUploadId: _id, ...saved }) => saved))
    expect(() => remoteAttachmentsForRequest([input], target, 'other')).toThrow('会话已变化')
  } finally { clearRemoteAttachments() }
})

test('history and export retain original filenames and frozen labels', () => {
  const wire = buildMentionMessage(`检查 @${file.path}`, [{ ...ref(), textOffset: 3 }])
  const messages = replayMessages([{ id: 'user', role: 'user', content: wire, metadata: { attachments: [{ name: file.path, displayName: file.name,
    type: file.type, size: file.size, attachmentId: file.attachmentId, referenceLabel: '图1' }] } }])
  expect(messages[0].attachments).toEqual([file])
  expect(userMessageDraft(messages[0].content).mentions[0]).toMatchObject({ attachmentId: 'attachment-a', displayText: '图1' })
  const exported = serializeMessages(messages)
  expect(exported).toContain('检查 图1')
  expect(exported).toContain(`图1：${file.name}（${file.path}）`)
  expect(exported).not.toContain('aether-refs')
})

function receipt(id: string, path: string, hash = 'a'.repeat(64)): QueueAttachmentReceipt {
  return { kind: 'local-workspace', scope: { source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 't', namespace: { id: 'n', generation: 'g' }, owner: 'work', taskId: 's' },
    attachmentId: id, referenceLabel: '图1', path, name: path, mime: 'image/png', bytes: 25, receiptId: path, sha256: hash }
}

test('merging numbered queue messages deduplicates stable IDs and rewrites only their authored paths', () => {
  const a = receipt('a', '.ae/a.png'), b = receipt('b', '.ae/b.png'), repeated = receipt('a', '.ae/copy-a.png')
  const text = '@D:/repo/.ae/a.png @D:/repo/.ae/b.png @D:/repo/.ae/copy-a.png'
  const mentions = [ref('D:/repo/.ae/a.png', 'a'), ref('D:/repo/.ae/b.png', 'b'), ref('D:/repo/.ae/copy-a.png', 'a')]
    .map(mention => ({ ...mention, textOffset: text.indexOf('@' + mention.path) }))
  const merged = mergeQueueAttachmentReferences({ text, mentions, revision: 2 }, [a, b, repeated])
  expect(merged.attachments.map(item => [item.attachmentId, item.referenceLabel])).toEqual([['a', '图1'], ['b', '图2']])
  expect(merged.draft.text).toBe('@D:/repo/.ae/a.png @D:/repo/.ae/b.png @D:/repo/.ae/a.png')
  expect(merged.draft.mentions.map(item => item.displayText)).toEqual(['图1', '图2', '图1'])
  expect(userMessageDraft(buildMentionMessage(merged.draft.text, merged.draft.mentions)).mentions).toEqual(merged.draft.mentions)
  expect(() => mergeQueueAttachmentReferences({ text: '', mentions: [], revision: 1 }, [a, { ...repeated, sha256: 'b'.repeat(64) }])).toThrow('内容在待发消息之间已变化')
})
