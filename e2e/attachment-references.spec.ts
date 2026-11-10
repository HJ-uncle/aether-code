/** Pure composer identity and numbering: file order, repeated references,
 * frozen messages and stale drag events; no Electron/engine required. */
import { test, expect } from '@playwright/test'
import { attachmentIdentity, attachmentMention, attachmentReferences, freezeAttachmentReferences, referencesAttachment, reorderAttachments } from '../src/renderer/src/contrib/chat/attachment-references'
import type { ChatAttachment } from '../src/renderer/src/core/engine/useChat'

const file = (id: string, type = 'image/png'): ChatAttachment => ({ attachmentId: id, path: `${id}.png`, name: '同名附件', type, size: 10 })

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
