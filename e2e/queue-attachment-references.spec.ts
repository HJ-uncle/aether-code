/** Pure queue freezing regressions: authored reference identity, UTF-16 offsets,
 * untouched user text and persisted mention replay. No Electron or engine. */
import { expect, test } from '@playwright/test'
import type { QueueMention } from '../src/shared/next-turn-queue'
import { remapQueueAttachmentReferences } from '../src/shared/queue-attachment-references'
import { buildMentionMessage, userMessageDraft } from '../src/renderer/src/contrib/chat/mention-context'

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
