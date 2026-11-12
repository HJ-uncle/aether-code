/** Pure mixed text/chip undo checks: atomic attachment operations share history
 * with ordinary typing; external draft replacement is an explicit boundary. */
import { expect, test } from '@playwright/test'
import { createMentionEditHistory, type MentionDraft } from '../src/renderer/src/features/conversation/shared/mention-edit-history'

const empty: MentionDraft = { text: '', mentions: [] }
const chip: MentionDraft = { text: '@a.png ', mentions: [
  { source: 'file', origin: 'attachment', attachmentId: 'a', path: 'a.png', displayText: '图1', textOffset: 0 }
] }

test('insert, text edit, chip move and deletion undo and redo as complete drafts', () => {
  const history = createMentionEditHistory()
  const typed = { ...chip, text: '@a.png 说明' }
  const moved = { text: '说明 @a.png ', mentions: [{ ...chip.mentions[0], textOffset: 3 }] }
  const removed = { text: '说明  ', mentions: [] }
  history.record(empty, chip)
  history.record(chip, typed, true, 1)
  history.record(typed, moved)
  history.record(moved, removed)
  expect(history.undo(removed)).toEqual(moved)
  expect(history.undo(moved)).toEqual(typed)
  expect(history.undo(typed)).toEqual(chip)
  expect(history.undo(chip)).toEqual(empty)
  expect(history.redo(empty)).toEqual(chip)
  expect(history.redo(chip)).toEqual(typed)
  expect(history.redo(typed)).toEqual(moved)
  expect(history.redo(moved)).toEqual(removed)
})

test('adjacent typing groups without absorbing attachment edits or later typing', () => {
  const history = createMentionEditHistory()
  const first = { text: 'a', mentions: [] }, second = { text: 'ab', mentions: [] }, third = { text: 'abc', mentions: [] }
  history.record(empty, first, true, 1)
  history.record(first, second, true, 200)
  history.record(second, third, true, 1000)
  expect(history.undo(third)).toEqual(second)
  expect(history.undo(second)).toEqual(empty)
})

test('derived attachment numbering is not an undo step and does not invalidate history', () => {
  const history = createMentionEditHistory()
  history.record(empty, chip)
  const numbered = { ...chip, mentions: [{ ...chip.mentions[0], displayText: '图2' }] }
  history.record(chip, numbered)
  expect(history.undo(numbered)).toEqual(empty)
})

test('external replacements cannot cross history boundaries or revive removed resources', () => {
  const history = createMentionEditHistory()
  history.record(empty, chip)
  expect(history.undo({ text: 'other draft', mentions: [] })).toBeNull()
  history.reset()
  expect(history.undo(chip)).toBeNull()
  expect(history.redo(empty)).toBeNull()
})
