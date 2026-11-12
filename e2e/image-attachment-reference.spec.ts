/** Pure draft-reference checks: edited images replace only owned chips, retain
 * user prose and snapshots, and reject stale anchors before changing a draft. */
import { expect, test } from '@playwright/test'
import { replaceImageAttachmentReferences } from '../src/renderer/src/features/conversation/shared/image-attachment-reference'
import type { Mention } from '../src/renderer/src/features/conversation/shared/mention-context'

test('edited attachment updates repeated chips and later offsets without rewriting identical typed text', () => {
  const text = '保留手写 @old.png；请比较 @old.png 和 @old.png，再看 @notes.md。'
  const first = text.indexOf('@old.png', text.indexOf('请比较'))
  const second = text.indexOf('@old.png', first + 1), notes = text.indexOf('@notes.md')
  const mentions: Mention[] = [
    { source: 'file', origin: 'attachment', path: 'old.png', displayText: '原图', textOffset: first },
    { source: 'file', origin: 'attachment', path: 'old.png', displayText: '原图', textOffset: second },
    { source: 'file', origin: 'workspace', path: 'notes.md', displayText: '笔记', textOffset: notes }
  ]
  const result = replaceImageAttachmentReferences({ text, mentions }, { path: 'old.png' }, { path: '.ae/attachments/edited.png', name: 'edited.png' })
  expect(result.text).toBe('保留手写 @old.png；请比较 @.ae/attachments/edited.png 和 @.ae/attachments/edited.png，再看 @notes.md。')
  expect(result.mentions.slice(0, 2).map(mention => [mention.path, mention.displayText])).toEqual([
    ['.ae/attachments/edited.png', 'edited.png'], ['.ae/attachments/edited.png', 'edited.png']
  ])
  expect(result.mentions.map(mention => result.text.slice(mention.textOffset, mention.textOffset! + `@${mention.path}`.length)))
    .toEqual(['@.ae/attachments/edited.png', '@.ae/attachments/edited.png', '@notes.md'])
  expect(mentions[0].path).toBe('old.png')
})

test('embedded snapshots and unrelated references remain exact while path separator aliases match', () => {
  const text = '@folder\\image.png @folder/image.png @other.png'
  const mentions: Mention[] = [
    { source: 'file', path: 'folder\\image.png', displayText: '图片', textOffset: 0 },
    { source: 'file', path: 'folder/image.png', displayText: '快照', content: '原始不可变内容', textOffset: text.indexOf('@folder/') },
    { source: 'file', path: 'other.png', displayText: '其它', textOffset: text.indexOf('@other') }
  ]
  const result = replaceImageAttachmentReferences({ text, mentions }, { path: 'folder/image.png' }, { path: 'new.png', name: '新图片.png' })
  expect(result.text).toBe('@new.png @folder/image.png @other.png')
  expect(result.mentions[1]).toMatchObject({ path: 'folder/image.png', content: '原始不可变内容', textOffset: 9 })
  expect(result.mentions[2]).toMatchObject({ path: 'other.png', textOffset: 27 })
})

test('missing or stale chip anchors reject replacement and leave the original draft intact', () => {
  for (const textOffset of [undefined, 0, 99]) {
    const draft = { text: '手写 @old.png', mentions: [{ source: 'file' as const, path: 'old.png', displayText: '原图', textOffset }] }
    const original = JSON.stringify(draft)
    expect(() => replaceImageAttachmentReferences(draft, { path: 'old.png' }, { path: 'new.png', name: 'new.png' })).toThrow('引用的位置已变化')
    expect(JSON.stringify(draft)).toBe(original)
  }
})
