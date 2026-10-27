import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(directory, 'FileTreeView.tsx'), 'utf8')
const exports = {}
new vm.Script(`(function(require,exports){${ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText}\n})`).runInThisContext()(specifier => {
  if (specifier === 'react') return {}
  if (specifier === '@renderer/core/workspace/fs-client') return { paths: path.win32 }
  if (specifier === '@renderer/core/workspace/exclude') return { compileExclude: () => [], isExcluded: () => false }
  if (specifier === './FileTreeRow') return { FileTreeRow: () => null, FILE_TREE_ROW_HEIGHT: 30 }
  if (specifier === '@renderer/workbench/ui-primitives') return { Spinner: () => null }
  if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
  throw new Error(`Unexpected ${specifier}`)
}, exports)
const { buildFileTreeRows } = exports
const entry = (name, directory = false) => ({ name, path: `C:\\root\\${name}`, isDirectory: directory, size: 0, mtimeMs: 0 })
const children = new Map([['C:\\root', [entry('docs', true), entry('b.txt'), entry('a.txt')]]])
const snapshot = { root: 'C:\\root', showRoot: true, children, expanded: new Set(['C:\\root']), loading: new Set(), activeFilePath: null, selection: new Set() }

test('shared tree retains root and reveals only already loaded descendants when filtering', () => {
  children.set('C:\\root\\docs', [{ name: 'match.txt', path: 'C:\\root\\docs\\match.txt', isDirectory: false, size: 0, mtimeMs: 0 }])
  const rows = buildFileTreeRows({ snapshot, filter: 'match' })
  assert.deepEqual(rows.map(row => row.entry.name), ['root', 'match.txt'])
})

test('shared tree uses bounded virtualizable row data and preserves collapsed hierarchy', () => {
  children.delete('C:\\root\\docs')
  const collapsed = buildFileTreeRows({ snapshot })
  assert.deepEqual(collapsed.map(row => row.entry.name), ['root', 'docs', 'b.txt', 'a.txt'])
  assert.equal(buildFileTreeRows({ snapshot, sortMode: 'name' }).at(-1).entry.name, 'docs')
  children.set('C:\\root\\docs', [{ name: 'match.txt', path: 'C:\\root\\docs\\match.txt', isDirectory: false, size: 0, mtimeMs: 0 }])
  const expanded = buildFileTreeRows({ snapshot: { ...snapshot, expanded: new Set(['C:\\root', 'C:\\root\\docs']) } })
  assert.equal(expanded.find(row => row.entry.name === 'match.txt').depth, 2)
  assert.equal(buildFileTreeRows({ snapshot: { ...snapshot, expanded: new Set() } }).length, 1)
})
