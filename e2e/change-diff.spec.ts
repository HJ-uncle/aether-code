/** Full-file diff accounting, newline semantics, bounded fallback, and lossless rows; no Electron. */
import { expect, test } from '@playwright/test'
import {
  computeLineDiff, diffForDeletedFile, diffForNewFile, diffStats, MAX_RENDER_ROWS, type DiffRow
} from '../src/renderer/src/contrib/chat/diff'

function rebuild(rows: readonly DiffRow[], side: 'old' | 'new'): string {
  return rows
    .filter(row => row.type !== (side === 'old' ? 'add' : 'del'))
    .map(row => row.text + (row.noNewline ? '' : '\n'))
    .join('')
}

function expectLossless(oldText: string, newText: string, rows = computeLineDiff(oldText, newText)): void {
  expect(rebuild(rows, 'old')).toBe(oldText)
  expect(rebuild(rows, 'new')).toBe(newText)
  expect(rows.filter(row => row.type !== 'add').map(row => row.oldNo))
    .toEqual(rows.filter(row => row.type !== 'add').map((_, index) => index + 1))
  expect(rows.filter(row => row.type !== 'del').map(row => row.newNo))
    .toEqual(rows.filter(row => row.type !== 'del').map((_, index) => index + 1))
}

test('empty files and terminal newlines count physical text lines without phantom rows', () => {
  for (const [text, count] of [['', 0], ['\n', 1], ['a', 1], ['a\n', 1], ['a\n\n', 2], ['\n\n', 2], ['a\r\n', 1]] as const) {
    const added = diffForNewFile(text)
    const removed = diffForDeletedFile(text)
    expect(diffStats(added)).toEqual({ added: count, removed: 0, approximate: false })
    expect(diffStats(removed)).toEqual({ added: 0, removed: count, approximate: false })
    expectLossless('', text, added)
    expectLossless(text, '', removed)
  }
})

test('equal files retain content without claiming an addition or deletion', () => {
  for (const text of ['', 'a', 'a\n', 'a\n\n', 'a\r\nb\r\n']) {
    const rows = computeLineDiff(text, text)
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0, approximate: false })
    expect(rows.every(row => row.type === 'context')).toBe(true)
    expectLossless(text, text, rows)
  }
})

test('a terminal newline edit changes the last real line and exposes the missing newline', () => {
  expect(computeLineDiff('a', 'a\n')).toEqual([
    { type: 'del', text: 'a', oldNo: 1, noNewline: true },
    { type: 'add', text: 'a', newNo: 1 }
  ])
  for (const [oldText, newText] of [['a', 'a\n'], ['a\n', 'a'], ['a\nb', 'a\nb\n']]) {
    const rows = computeLineDiff(oldText, newText)
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1, approximate: false })
    expectLossless(oldText, newText, rows)
  }
  const appended = computeLineDiff('a', 'a\nb')
  expect(diffStats(appended)).toEqual({ added: 2, removed: 1, approximate: false })
  expectLossless('a', 'a\nb', appended)
})

test('CRLF, true blank lines and EOF content survive row reconstruction', () => {
  const oldText = 'a\r\n\r\nb\r\nlast'
  const newText = 'a\r\nb changed\r\nlast\r\n'
  expectLossless(oldText, newText)
  expect(diffStats(computeLineDiff('a\r\n', 'a\n'))).toEqual({ added: 1, removed: 1, approximate: false })
})

test('edits beyond line 800 keep exact counts, tail content and original line numbers', () => {
  const oldLines = Array.from({ length: 1800 }, (_, i) => 'line ' + i)
  const newLines = [...oldLines]
  newLines[1700] = 'changed beyond the former cutoff'
  const oldText = oldLines.join('\n') + '\n'
  const newText = newLines.join('\n') + '\n'
  const rows = computeLineDiff(oldText, newText)
  expect(diffStats(rows)).toEqual({ added: 1, removed: 1, approximate: false })
  expect(rows.filter(row => row.type !== 'context')).toEqual([
    { type: 'del', text: 'line 1700', oldNo: 1701 },
    { type: 'add', text: 'changed beyond the former cutoff', newNo: 1701 }
  ])
  expectLossless(oldText, newText, rows)
})

test('render folding at 400 rows never limits full-file statistics', () => {
  const text = Array.from({ length: 950 }, (_, i) => 'added ' + i).join('\n') + '\n'
  const rows = computeLineDiff('', text)
  expect(rows.length).toBeGreaterThan(MAX_RENDER_ROWS)
  expect(diffStats(rows)).toEqual({ added: 950, removed: 0, approximate: false })
  expect(diffStats(diffForDeletedFile(text))).toEqual({ added: 0, removed: 950, approximate: false })
  expectLossless('', text, rows)
})

test('different content with the same line count reports replacements, not zero', () => {
  const oldText = Array.from({ length: 600 }, (_, i) => 'old ' + i).join('\n') + '\n'
  const newText = Array.from({ length: 600 }, (_, i) => 'new ' + i).join('\n') + '\n'
  const rows = computeLineDiff(oldText, newText)
  expect(diffStats(rows)).toEqual({ added: 600, removed: 600, approximate: false })
  expectLossless(oldText, newText, rows)
})

test('large disjoint blocks can be counted exactly without a quadratic table', () => {
  const oldText = Array.from({ length: 1500 }, (_, i) => 'old ' + i).join('\n') + '\n'
  const newText = Array.from({ length: 1500 }, (_, i) => 'new ' + i).join('\n') + '\n'
  const rows = computeLineDiff(oldText, newText)
  expect(diffStats(rows)).toEqual({ added: 1500, removed: 1500, approximate: false })
  expect(rows.some(row => row.approximate)).toBe(false)
  expectLossless(oldText, newText, rows)
})

test('over-budget overlapping blocks are complete and explicitly estimated while equal edges remain exact', () => {
  const oldLines = Array.from({ length: 1500 }, (_, i) => 'old ' + i)
  const newLines = Array.from({ length: 1500 }, (_, i) => 'new ' + i)
  oldLines[750] = newLines[750] = 'a common interior line'
  const oldText = ['unchanged prefix', ...oldLines, 'unchanged suffix'].join('\n')
  const newText = ['unchanged prefix', ...newLines, 'unchanged suffix'].join('\n')
  const rows = computeLineDiff(oldText, newText)
  expect(diffStats(rows)).toEqual({ added: 1500, removed: 1500, approximate: true })
  expect(rows[0]).toEqual({ type: 'context', text: 'unchanged prefix', oldNo: 1, newNo: 1 })
  expect(rows.at(-1)).toEqual({ type: 'context', text: 'unchanged suffix', oldNo: 1502, newNo: 1502, noNewline: true })
  expect(rows.filter(row => row.type !== 'context').every(row => row.approximate)).toBe(true)
  expectLossless(oldText, newText, rows)
})

test('long narrow comparisons remain exact without creating one DP allocation per input row', () => {
  const oldText = Array.from({ length: 30_000 }, (_, i) => 'line ' + i).join('\n') + '\n'
  const newText = 'line 15000\n'
  const rows = computeLineDiff(oldText, newText)
  expect(diffStats(rows)).toEqual({ added: 0, removed: 29_999, approximate: false })
  expectLossless(oldText, newText, rows)
})

test('repeated lines align as a minimal edit script rather than positional replacements', () => {
  const oldText = 'a\nb\na\nc\n'
  const newText = 'a\na\nb\nc\n'
  const rows = computeLineDiff(oldText, newText)
  expect(diffStats(rows)).toEqual({ added: 1, removed: 1, approximate: false })
  expect(rows.some(row => row.approximate)).toBe(false)
  expectLossless(oldText, newText, rows)
})
