/** Pure editor transfer checks: foreign drags cannot supply resources; copied
 * attachment occurrences rebind only to still-owned IDs, without altering prose. */
import { expect, test } from '@playwright/test'
import { attachmentReferences, attachmentMention } from '../src/renderer/src/contrib/chat/attachment-references'
import { attachmentDragKey, attachmentDropReference, rebindAttachmentClipboard } from '../src/renderer/src/contrib/chat/attachment-editor-transfer'

const files = attachmentReferences([
  { attachmentId: 'photo-a', path: 'a.png', name: 'a.png', type: 'image/png', size: 1 },
  { attachmentId: 'photo-b', path: 'b.png', name: 'b.png', type: 'image/png', size: 2 }
])

test('attachment drops select current IDs and never adopt a transferred path', () => {
  expect(attachmentDropReference(JSON.stringify({ id: 'photo-a', path: 'C:/foreign.png' }), files)).toBe(files[0])
  for (const raw of ['null', '{}', '{', '"photo-a"', '{"id":"missing"}', '{"id":1}'])
    expect(attachmentDropReference(raw, files)).toBeUndefined()
})

test('an internal chip drag belongs to its exact input instance', () => {
  expect(attachmentDragKey('{"owner":"code","key":"m3"}', 'code')).toBe('m3')
  expect(attachmentDragKey('{"owner":"work","key":"m3"}', 'code')).toBeUndefined()
  expect(attachmentDragKey('{"owner":"code","key":12}', 'code')).toBeUndefined()
  expect(attachmentDragKey('broken', 'code')).toBeUndefined()
})

test('clipboard preserves repeated occurrences and rebinds changed paths and labels by ID', () => {
  const text = '手写 @a.png；比较 @a.png 与 @a.png，最后 @b.png。'
  const first = text.indexOf('@a.png', text.indexOf('比较')), second = text.indexOf('@a.png', first + 1)
  const draft = { text, mentions: [
    { ...attachmentMention(files[0]), textOffset: first },
    { ...attachmentMention(files[0]), textOffset: second },
    { ...attachmentMention(files[1]), textOffset: text.indexOf('@b.png') }
  ] }
  const current = attachmentReferences([files[1].file, { ...files[0].file, path: 'edited/photo-a.png' }])
  const result = rebindAttachmentClipboard(draft, current)!
  expect(result.text).toBe('手写 @a.png；比较 @edited/photo-a.png 与 @edited/photo-a.png，最后 @b.png。')
  expect(result.mentions.map(mention => mention.displayText)).toEqual(['图2', '图2', '图1'])
  expect(result.mentions.map(mention => result.text.slice(mention.textOffset, mention.textOffset! + `@${mention.path}`.length)))
    .toEqual(['@edited/photo-a.png', '@edited/photo-a.png', '@b.png'])
  expect(draft.text).toBe(text)
  expect(draft.mentions[0].path).toBe('a.png')
})

test('clipboard cannot revive removed attachments or turn ordinary text into chips', () => {
  const draft = { text: '@a.png', mentions: [{ ...attachmentMention(files[0]), textOffset: 0 }] }
  expect(rebindAttachmentClipboard(draft, [files[1]])).toBeNull()
  expect(rebindAttachmentClipboard({ ...draft, mentions: [] }, files)).toBeNull()
  expect(rebindAttachmentClipboard({ ...draft, mentions: [{ ...draft.mentions[0], textOffset: 2 }] }, files)).toBeNull()
})
