/** Pure language protocol invariants: workspace edits, command/action shapes, symbol filtering and position chains. */
import { expect, test } from '@playwright/test'
import type { languages } from 'monaco-editor'
import {
  parseLspCodeAction,
  parseWorkspaceTextEdits
} from '../src/renderer/src/core/lsp/workspace-edit'
import {
  filterDocumentSymbols,
  findDocumentSymbolPath
} from '../src/renderer/src/core/editor/document-symbol-utils'

const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
const edit = { range, newText: 'renamed' }

test('standard TextDocumentEdit has no kind and preserves its version', () => {
  expect(
    parseWorkspaceTextEdits({
      documentChanges: [
        { textDocument: { uri: 'file:///d:/project/a.ts', version: 7 }, edits: [edit] }
      ]
    })
  ).toEqual([{ uri: 'file:///d:/project/a.ts', version: 7, edits: [edit] }])
})
test('documentChanges take precedence over fallback changes instead of applying edits twice', () => {
  expect(
    parseWorkspaceTextEdits({
      changes: { 'file:///d:/a.ts': [edit] },
      documentChanges: [{ textDocument: { uri: 'file:///d:/a.ts', version: null }, edits: [edit] }]
    })
  ).toEqual([{ uri: 'file:///d:/a.ts', version: null, edits: [edit] }])
})
test('resource operations reject the entire edit before any partial text mutation', () => {
  for (const kind of ['create', 'rename', 'delete']) {
    expect(() =>
      parseWorkspaceTextEdits({
        documentChanges: [
          { textDocument: { uri: 'file:///d:/a.ts' }, edits: [edit] },
          { kind, uri: 'file:///d:/b.ts' }
        ]
      })
    ).toThrow('没有应用任何编辑')
  }
})
test('malformed and reversed ranges are rejected instead of silently clamped', () => {
  expect(() =>
    parseWorkspaceTextEdits({
      changes: {
        'file:///d:/a.ts': [
          {
            range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } },
            newText: ''
          }
        ]
      }
    })
  ).toThrow('无效的文本编辑')
  expect(() =>
    parseWorkspaceTextEdits({
      changes: {
        'file:///d:/a.ts': [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 1, character: 1 } },
            newText: ''
          }
        ]
      }
    })
  ).toThrow('倒置')
})
test('bare commands and lazy CodeActions retain the correct execution payload', () => {
  expect(parseLspCodeAction({ title: 'Fix', command: '_typescript.fix', arguments: [1] })).toEqual({
    title: 'Fix',
    command: { title: 'Fix', command: '_typescript.fix', arguments: [1] }
  })
  const action = parseLspCodeAction({
    title: 'Extract',
    kind: 'refactor.extract',
    data: { id: 3 },
    command: { command: '_typescript.extract', arguments: ['a.ts'] },
    disabled: { reason: 'Not applicable' }
  })
  expect(action?.data).toEqual({ id: 3 })
  expect(action?.command?.arguments).toEqual(['a.ts'])
  expect(action?.disabled?.reason).toBe('Not applicable')
})

const method: languages.DocumentSymbol = {
  name: 'renderDetails',
  detail: '',
  kind: 5,
  tags: [],
  range: { startLineNumber: 3, startColumn: 3, endLineNumber: 6, endColumn: 4 },
  selectionRange: { startLineNumber: 3, startColumn: 3, endLineNumber: 3, endColumn: 16 }
}
const parent: languages.DocumentSymbol = {
  name: 'Page',
  detail: '',
  kind: 4,
  tags: [],
  children: [method],
  range: { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 2 },
  selectionRange: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 }
}
test('outline matching keeps ancestors without mutating the shared symbol tree', () => {
  expect(filterDocumentSymbols([parent], 'DETAIL')).toEqual([parent])
  expect(filterDocumentSymbols([parent], 'unknown')).toEqual([])
  expect(parent.children).toEqual([method])
})
test('cursor navigation returns the nested symbol chain and excludes positions outside ranges', () => {
  expect(
    findDocumentSymbolPath([parent], { lineNumber: 4, column: 8 }).map((symbol) => symbol.name)
  ).toEqual(['Page', 'renderDetails'])
  expect(
    findDocumentSymbolPath([parent], { lineNumber: 2, column: 1 }).map((symbol) => symbol.name)
  ).toEqual(['Page'])
  expect(findDocumentSymbolPath([parent], { lineNumber: 9, column: 3 })).toEqual([])
})
