/** Pure composer identity, pasted text labels and numbering: file order, repeated references,
 * frozen messages and stale drag events; no Electron/engine required. */
import { test, expect } from '@playwright/test'
import { attachmentIdentity, attachmentMention, attachmentReferences, draftAttachmentSelection, freezeAttachmentReferences, referencesAttachment, reorderAttachments } from '../src/renderer/src/features/conversation/shared/attachment-references'
import { storedAttachments } from '../src/renderer/src/features/conversation/shared/attachment-storage'
import type { ChatAttachment } from '../src/renderer/src/core/engine/useChat'
import { pastedTextLabel } from '../src/shared/pasted-text-label'

const file = (id: string, type = 'image/png'): ChatAttachment => ({ attachmentId: id, path: `${id}.png`, name: '同名附件', type, size: 10 })

test('inline documents show filenames while image and pasted-text references keep their compact labels', () => {
  const references = attachmentReferences([file('image'), { ...file('yaml', 'text/yaml'), name: 'latest.yml' },
    { ...file('paste', 'text/plain'), name: '粘贴的文本-需求.txt' }])
  expect(references.map(attachmentMention).map(mention => mention.displayText)).toEqual(['图1', 'latest.yml', '粘贴文本 · 需求'])
  expect(references.map(reference => reference.label)).toEqual(['图1', '附件1', '粘贴文本 · 需求'])
})

test('deleting inline document tags excludes their receipts and undo restores each receipt only once', () => {
  const selected = { ...file('selected', 'text/plain'), inlineReference: true, remoteUploadId: 'keep-token' }
  const removed = { ...file('removed', 'application/pdf'), inlineReference: true }
  const image = { ...file('image'), inlineReference: true }
  const legacy = file('legacy', 'text/plain')
  const files = [selected, removed, image, legacy]
  const [selectedMention, removedMention] = attachmentReferences(files).map(attachmentMention)
  expect(draftAttachmentSelection(files, [])).toEqual([image, legacy])
  expect(draftAttachmentSelection(files, [selectedMention, selectedMention])).toEqual([selected, image, legacy])
  expect(draftAttachmentSelection(files, [selectedMention, removedMention])).toEqual(files)
  expect(draftAttachmentSelection(files, [{ ...removedMention, origin: 'workspace' }])).toEqual([image, legacy])
  expect(selected.remoteUploadId).toBe('keep-token')
})

test('draft persistence retains inline selection state without retaining live upload tokens', () => {
  const receipt = { ...file('document', 'text/plain'), inlineReference: true, remoteUploadId: 'temporary-token' }
  const [restored] = storedAttachments(JSON.parse(JSON.stringify([receipt])))
  expect(restored).toEqual({ ...file('document', 'text/plain'), inlineReference: true })
  expect(draftAttachmentSelection([restored], [])).toEqual([])
  expect(draftAttachmentSelection([restored], [attachmentMention(attachmentReferences([restored])[0])])).toEqual([restored])
  expect(storedAttachments([{ ...receipt, inlineReference: 'true' }])[0].inlineReference).toBeUndefined()
})

test('pasted text labels recognize only the generated plain-text filenames', () => {
  expect(pastedTextLabel('粘贴的文本.txt', 'text/plain')).toBe('粘贴文本')
  expect(pastedTextLabel('粘贴的文本-需求说明.txt', 'text/plain;charset=utf-8')).toBe('粘贴文本 · 需求说明')
  expect(pastedTextLabel('粘贴的文本-需求说明.txt', 'Text/Plain; charset=UTF-8')).toBe('粘贴文本 · 需求说明')
  for (const name of ['说明.txt', '旧粘贴的文本.txt', '粘贴的文本-.txt', '粘贴的文本.txt.bak',
    '粘贴的文本.TXT', '粘贴的文本.txt\n', 'folder/粘贴的文本.txt', '粘贴的文本-标题-副标题.txt', '粘贴的文本- 标题.txt',
    `粘贴的文本-${'字'.repeat(49)}.txt`]) {
    expect(pastedTextLabel(name, 'text/plain'), name).toBeNull()
  }
  for (const mime of ['', 'text/markdown', 'application/octet-stream', 'image/png', 'text/plain-extra']) {
    expect(pastedTextLabel('粘贴的文本-需求说明.txt', mime), mime).toBeNull()
  }
})

test('pasted text excerpts preserve whole Unicode characters at the label boundary', () => {
  const exact = '字'.repeat(24)
  expect(pastedTextLabel(`粘贴的文本-${exact}.txt`, 'text/plain')).toBe(`粘贴文本 · ${exact}`)
  expect(pastedTextLabel(`粘贴的文本-${exact}尾.txt`, 'text/plain')).toBe(`粘贴文本 · ${exact}…`)
  expect(pastedTextLabel(`粘贴的文本-${'😀'.repeat(48)}.txt`, 'text/plain')).toBe(`粘贴文本 · ${'😀'.repeat(24)}…`)
  for (const emoji of ['😀', '👍🏽', '👨‍👩‍👧‍👦']) {
    const title = 'a'.repeat(23) + emoji
    expect(pastedTextLabel(`粘贴的文本-${title}尾.txt`, 'text/plain')).toBe(`粘贴文本 · ${title}…`)
  }
})

test('pasted text keeps its semantic label across reorder and freeze without consuming file numbers', () => {
  const pasted = { ...file('paste', 'text/plain;charset=utf-8'), name: '粘贴的文本-需求说明.txt' }
  const blank = { ...file('blank', 'text/plain'), name: '粘贴的文本.txt' }
  const files = [file('image'), pasted, file('document', 'text/plain'), blank, file('pdf', 'application/pdf')]
  expect(attachmentReferences(files).map(({ id, label }) => [id, label])).toEqual([
    ['image', '图1'], ['paste', '粘贴文本 · 需求说明'], ['document', '附件1'], ['blank', '粘贴文本'], ['pdf', '附件2']
  ])
  const sent = freezeAttachmentReferences(files)
  const changed = freezeAttachmentReferences(reorderAttachments(files, ['pdf', 'blank', 'paste']))
  expect(sent.map(item => item.referenceLabel)).toEqual(['图1', '粘贴文本 · 需求说明', '附件1', '粘贴文本', '附件2'])
  expect(changed.map(item => item.referenceLabel)).toEqual(['附件1', '粘贴文本', '粘贴文本 · 需求说明', '图1', '附件2'])
  expect(attachmentMention(attachmentReferences([pasted])[0])).toMatchObject({
    attachmentId: 'paste', path: pasted.path, displayText: '粘贴文本 · 需求说明'
  })
  expect(pasted.referenceLabel).toBeUndefined()
})

test('image and document labels follow their own order while same filenames retain separate identities', () => {
  const files = [file('a'), file('b', 'text/plain'), file('c'), file('d', 'application/pdf')]
  expect(attachmentReferences(files).map(({ id, label }) => [id, label])).toEqual([
    ['a', '图1'], ['b', '附件1'], ['c', '图2'], ['d', '附件2']
  ])
  expect(attachmentReferences([file('a'), { ...file('a'), path: 'edited.png' }]).map(item => item.id)).toEqual(['a', 'a'])
  expect(attachmentIdentity({ path: 'folder\\old.png' })).toBe(attachmentIdentity({ path: 'folder/old.png' }))
})

test('reordering preserves reference targets and never loses concurrently added uploads', () => {
  const files = [file('a'), file('b'), file('c')]
  const original = attachmentReferences(files).map(attachmentMention)
  const reordered = reorderAttachments(files, ['b', 'a', 'missing', 'b'])
  expect(reordered.map(item => item.attachmentId)).toEqual(['b', 'a', 'c'])
  const refs = attachmentReferences(reordered)
  expect(refs.find(ref => referencesAttachment(original[0], ref))?.label).toBe('图2')
  expect(files.map(item => item.attachmentId)).toEqual(['a', 'b', 'c'])
  expect(reordered[0]).toBe(files[1])
})

test('frozen sent labels are independent of subsequent ordering including two-digit numbers', () => {
  const files = Array.from({ length: 11 }, (_, index) => file(String(index)))
  const sent = freezeAttachmentReferences(files)
  const changed = freezeAttachmentReferences(reorderAttachments(files, ['10', ...files.map(attachmentIdentity)]))
  expect(sent[9]).toMatchObject({ attachmentId: '9', referenceLabel: '图10' })
  expect(changed[10]).toMatchObject({ attachmentId: '9', referenceLabel: '图11' })
  expect(sent[0]).toMatchObject({ attachmentId: '0', referenceLabel: '图1' })
  expect(files[0].referenceLabel).toBeUndefined()
})

test('only attachment references count as referenced, including legacy anchored mentions', () => {
  const ref = attachmentReferences([file('a')])[0]
  const mention = attachmentMention(ref)
  expect(referencesAttachment(mention, ref)).toBe(true)
  expect(referencesAttachment({ ...mention, attachmentId: undefined }, ref)).toBe(true)
  expect(referencesAttachment({ ...mention, origin: 'workspace' }, ref)).toBe(false)
  expect(referencesAttachment({ ...mention, content: 'snapshot' }, ref)).toBe(false)
  expect(referencesAttachment({ ...mention, attachmentId: 'different' }, ref)).toBe(false)
})
