/** Pure queue freezing regressions: pasted text labels, authored reference identity, UTF-16 offsets,
 * untouched user text and persisted mention replay. No Electron or engine. */
import { expect, test } from '@playwright/test'
import type { QueueAttachmentReceipt, QueueMention } from '../src/shared/next-turn-queue'
import { mergeQueueAttachmentReferences, remapQueueAttachmentReferences } from '../src/shared/queue-attachment-references'
import { buildMentionMessage, userMessageDraft } from '../src/renderer/src/contrib/chat/mention-context'
import { freezeAttachmentReferences } from '../src/renderer/src/contrib/chat/attachment-references'

test('queue merging and composer freezing agree on pasted text labels and independent file numbering', () => {
  const receipt = (id: string, name: string, mime: string): QueueAttachmentReceipt => ({
    kind: 'local-workspace', scope: { source: { mode: 'embedded', endpoint: '', accountId: null },
      tenantId: 't', namespace: { id: 'n', generation: 'g' }, owner: 'work', taskId: 's' },
    attachmentId: id, referenceLabel: '附件9', path: `.ae/${id}`, name, mime, bytes: 25,
    receiptId: id, sha256: 'a'.repeat(64)
  })
  const pasted = receipt('paste', `粘贴的文本-${'字'.repeat(24)}尾.txt`, 'text/plain;charset=utf-8')
  const receipts = [receipt('image', '截图.png', 'image/png'), pasted,
    receipt('document', '说明.txt', 'text/plain'), receipt('blank', '粘贴的文本.txt', 'text/plain'),
    receipt('pdf', '资料.pdf', 'application/pdf')]
  const repeated = { ...pasted, receiptId: 'paste-copy', path: '.ae/paste-copy' }
  const input = [...receipts, repeated]
  const text = input.map(file => '@' + file.path).join(' ')
  const mentions: QueueMention[] = input.map(file => ({ source: 'file', origin: 'attachment',
    attachmentId: file.attachmentId, path: file.path, displayText: '附件9', textOffset: text.indexOf('@' + file.path) }))
  const before = structuredClone({ text, mentions, input })
  const result = mergeQueueAttachmentReferences({ text, mentions, revision: 3 }, input)
  const labels = ['图1', `粘贴文本 · ${'字'.repeat(24)}…`, '附件1', '粘贴文本', '附件2']
  expect(result.attachments.map(file => file.referenceLabel)).toEqual(labels)
  expect(result.draft.mentions.map(mention => mention.displayText)).toEqual([...labels, labels[1]])
  expect(result.draft.mentions.at(-1)).toMatchObject({ attachmentId: 'paste', path: pasted.path })
  expect(result.draft.text).toBe([...receipts, pasted].map(file => '@' + file.path).join(' '))
  const frozen = freezeAttachmentReferences(receipts.map(file => ({ attachmentId: file.attachmentId,
    path: file.path, name: file.name, type: file.mime, size: file.bytes })))
  expect(frozen.map(file => file.referenceLabel)).toEqual(labels)
  expect(userMessageDraft(buildMentionMessage(result.draft.text, result.draft.mentions))).toEqual({
    text: result.draft.text, mentions: result.draft.mentions
  })
  expect({ text, mentions, input }).toEqual(before)
})

test('freezing queued files preserves plain labels and shifts later chips after longer and shorter paths', () => {
  const prefix = '😀 原文 @report.txt；参考 '
  const middle = ' 再看 '
  const tail = ' 然后 @reviewer，保留原文 @report.txt'
  const text = `${prefix}@report.txt${middle}@some/long/source.txt${tail}`
  const first = { source: 'file' as const, displayText: '粘贴的文本.txt', path: 'report.txt', textOffset: prefix.length, origin: 'attachment' as const }
  const second = { source: 'file' as const, displayText: '说明.txt', path: 'some/long/source.txt', textOffset: prefix.length + '@report.txt'.length + middle.length }
  const agent: QueueMention = { source: 'agent', displayText: '审阅者', path: 'reviewer', textOffset: text.indexOf('@reviewer') }
  const draft = { text, revision: 3, mentions: [first, second, agent] }
  const before = structuredClone(draft)
  const frozen = '.ae/attachments/next-turn-report.txt'
  const result = remapQueueAttachmentReferences(draft, new Map([['report.txt', frozen], ['some/long/source.txt', 'b.txt']]))
  const expected = `${prefix}@${frozen}${middle}@b.txt${tail}`
  expect(result.text).toBe(expected)
  expect(result.mentions).toEqual([
    { ...first, path: frozen },
    { ...second, path: 'b.txt', textOffset: expected.indexOf('@b.txt') },
    { ...agent, textOffset: expected.indexOf('@reviewer') }
  ])
  expect(result.revision).toBe(3)
  expect(draft).toEqual(before)
  expect(result.mentions[0]).not.toBe(draft.mentions[0])
})

test('snapshot and non-file references retain identity, even when their path names an attachment', () => {
  const text = '@report.txt @src/app.ts:4 @report.txt'
  const draft = { text, revision: 1, mentions: [
    { source: 'file' as const, displayText: '快照', path: 'report.txt', textOffset: 0, content: '' },
    { source: 'code' as const, displayText: '源码', path: 'src/app.ts', startLine: 4, textOffset: text.indexOf('@src/') },
    { source: 'dir' as const, displayText: '目录', path: 'report.txt', textOffset: text.lastIndexOf('@report.txt') }
  ] }
  expect(remapQueueAttachmentReferences(draft, new Map([['report.txt', 'frozen.txt'], ['src/app.ts', 'frozen.ts']]))).toEqual(draft)
})

test('Windows path separators match while the frozen absolute path and friendly label survive history replay', () => {
  const path = '.ae\\attachments\\paste.txt'
  const frozen = 'D:\\workspace\\.ae\\attachments\\next-turn-id.txt'
  const draft = { text: `检查 @${path} 后回复。`, revision: 1, mentions: [
    { source: 'file' as const, displayText: '粘贴的文本.txt', path, textOffset: '检查 '.length }
  ] }
  const result = remapQueueAttachmentReferences(draft, new Map([['.ae/attachments/paste.txt', frozen]]))
  const sent = buildMentionMessage(result.text, result.mentions)
  const restored = userMessageDraft(sent)
  expect(result.text).toBe(`检查 @${frozen} 后回复。`)
  expect(restored).toEqual({ text: result.text, mentions: result.mentions })
  expect(sent).not.toContain('<reference')
  expect(result.mentions[0].content).toBeUndefined()
})

test('repeated authored references map independently and untracked labels never acquire metadata', () => {
  const text = '@a.txt / @a.txt / @a.txt'
  const draft = { text, revision: 2, mentions: [
    { source: 'file' as const, displayText: 'A', path: 'a.txt', textOffset: 0 },
    { source: 'file' as const, displayText: 'A again', path: 'a.txt', textOffset: text.lastIndexOf('@a.txt') }
  ] }
  const result = remapQueueAttachmentReferences(draft, new Map([['a.txt', 'queued.txt']]))
  expect(result.text).toBe('@queued.txt / @a.txt / @queued.txt')
  expect(result.mentions).toHaveLength(2)
  expect(result.mentions[1].textOffset).toBe('@queued.txt / @a.txt / '.length)
})

test('a stale authored offset fails instead of rewriting a similarly named user label', () => {
  const draft = { text: 'plain @a.txt', revision: 1, mentions: [
    { source: 'file' as const, displayText: 'A', path: 'a.txt', textOffset: 0 }
  ] }
  expect(() => remapQueueAttachmentReferences(draft, new Map([['a.txt', 'queued.txt']]))).toThrow('Mention position does not match the authored chip')
})
