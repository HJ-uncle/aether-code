/** Pure source Git edit boundaries, HEAD line mapping and malformed conflict rejection. */
import { expect, test } from '@playwright/test'
import type { editor } from 'monaco-editor'
import { originalLineForModified, revertLineChange } from '../src/renderer/src/core/git/source-git-utils'
import { planConflictEdit, resolveConflictText, scanConflicts } from '../src/renderer/src/core/git/git-conflict-parser'

const change = (oldStart: number, oldEnd: number, newStart: number, newEnd: number): editor.ILineChange => ({ originalStartLineNumber: oldStart, originalEndLineNumber: oldEnd, modifiedStartLineNumber: newStart, modifiedEndLineNumber: newEnd })
const restore = (original: string, modified: string, hunk: editor.ILineChange): string => {
  const edit = revertLineChange(original, modified, hunk)
  return modified.slice(0, edit.startOffset) + edit.text + modified.slice(edit.endOffset)
}

test('源Git单块撤销只恢复所选更改并保留其它修改', () => {
  expect(restore('a\nb\nc\nd\n', 'a\nB\nc\nD\n', change(2, 2, 2, 2))).toBe('a\nb\nc\nD\n')
  expect(restore('a\nb\nc\n', 'a\ninserted\nb\nc\n', change(1, 0, 2, 2))).toBe('a\nb\nc\n')
})

test('源Git单块撤销处理文件开头、末尾与末尾换行', () => {
  expect(restore('a\nb\nc\n', 'c\n', change(1, 2, 0, 0))).toBe('a\nb\nc\n')
  expect(restore('a\nb', 'a', change(2, 2, 1, 0))).toBe('a\nb')
  expect(restore('a', 'a\nb', change(1, 0, 2, 2))).toBe('a')
  expect(restore('a\n', 'a', change(2, 2, 1, 0))).toBe('a\n')
  expect(restore('a', 'a\n', change(1, 0, 2, 2))).toBe('a')
  expect(restore('a\r\nb\r\n', 'a\r\nB\r\n', change(2, 2, 2, 2))).toBe('a\r\nb\r\n')
})

test('blame把未改行映射回HEAD，新增和修改行无提交归属', () => {
  const changes = [change(1, 0, 2, 3), change(4, 5, 5, 0), change(7, 7, 7, 7)]
  expect(originalLineForModified(1, changes)).toBe(1)
  expect(originalLineForModified(2, changes)).toBeNull()
  expect(originalLineForModified(4, changes)).toBe(2)
  expect(originalLineForModified(6, changes)).toBe(6)
  expect(originalLineForModified(7, changes)).toBeNull()
})

test('冲突解析拒绝缺少分隔符、嵌套和未闭合标记', () => {
  expect(scanConflicts('<<<<<<< HEAD\ntext\n>>>>>>> other')).toEqual([])
  expect(scanConflicts('<<<<<<< HEAD\n<<<<<<< nested\nx\n=======\ny\n>>>>>>> nested\n=======\nz\n>>>>>>> other')).toEqual([])
  expect(scanConflicts('<<<<<<< HEAD\nx\n=======\ny')).toEqual([])
})

test('diff3祖先区不混入当前内容，采用双方移除所有标记', () => {
  const content = 'prefix\n<<<<<<< HEAD\ncurrent\n||||||| base\nancestor\n=======\nincoming\n>>>>>>> other\nsuffix'
  const [conflict] = scanConflicts(content)
  expect(conflict.commonAncestors).toEqual([{ start: 5, end: 5 }])
  expect(resolveConflictText(content, conflict, 'current')).toBe('prefix\ncurrent\nsuffix')
  expect(resolveConflictText(content, conflict, 'incoming')).toBe('prefix\nincoming\nsuffix')
  expect(resolveConflictText(content, conflict, 'both')).toBe('prefix\ncurrent\nincoming\nsuffix')
})

test('空侧冲突删除整块，保留文件其它内容', () => {
  const content = 'prefix\n<<<<<<< HEAD\n=======\nincoming\n>>>>>>> other\nsuffix'
  const [conflict] = scanConflicts(content)
  expect(resolveConflictText(content, conflict, 'current')).toBe('prefix\nsuffix')
})

test('CRLF末尾冲突解决不添加换行或留下孤立回车', () => {
  const content = 'prefix\r\n<<<<<<< HEAD\r\ncurrent\r\n=======\r\nincoming\r\n>>>>>>> other'
  const [conflict] = scanConflicts(content)
  expect(resolveConflictText(content, conflict, 'current')).toBe('prefix\r\ncurrent')
  expect(resolveConflictText(content, conflict, 'both')).toBe('prefix\r\ncurrent\r\nincoming')
  expect(planConflictEdit(content, conflict, 'both').text).toBe('current\r\nincoming')
})

test('只有一个空白行的冲突侧保留该空行，与空侧删除不同', () => {
  const content = 'prefix\n<<<<<<< HEAD\n\n=======\nincoming\n>>>>>>> other\nsuffix'
  const [conflict] = scanConflicts(content)
  expect(resolveConflictText(content, conflict, 'current')).toBe('prefix\n\nsuffix')
  expect(resolveConflictText(content, conflict, 'both')).toBe('prefix\n\nincoming\nsuffix')
  expect(planConflictEdit(content, conflict, 'current').includeTrailingNewline).toBe(false)
})
