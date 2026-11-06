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
  if (specifier === '@renderer/core/workspace/file-tree-memory') return { fileTreePathKey: value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() }
  if (specifier === '@renderer/core/workspace/exclude') return { compileExclude: () => [], isExcluded: () => false }
  if (specifier === './FileTreeRow') return { FileTreeRow: () => null, FILE_TREE_ROW_HEIGHT: 30 }
  if (specifier === './file-tree-motion') return { useFileTreeMotion: () => null }
  if (specifier.endsWith('.css')) return {}
  if (specifier === '@renderer/workbench/ui-primitives') return { Spinner: () => null }
  if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
  throw new Error(`Unexpected ${specifier}`)
}, exports)
const { buildFileTreeRows } = exports
const entry = (name, directory = false) => ({ name, path: `C:\\root\\${name}`, isDirectory: directory, size: 0, mtimeMs: 0 })
const children = new Map([['C:\\root', [entry('docs', true), entry('b.txt'), entry('a.txt')]]])
const snapshot = { root: 'C:\\root', showRoot: true, children, expanded: new Set(['C:\\root']), loading: new Set(), activeFilePath: null, selection: new Set() }

test('shared tree retains expanded ancestors and reveals only loaded matching descendants when filtering', () => {
  children.set('C:\\root\\docs', [{ name: 'match.txt', path: 'C:\\root\\docs\\match.txt', isDirectory: false, size: 0, mtimeMs: 0 }])
  const rows = buildFileTreeRows({ snapshot, filter: 'match' })
  assert.deepEqual(rows.map(row => row.entry.name), ['root', 'docs', 'match.txt'])
  assert.deepEqual(rows.filter(row => row.entry.isDirectory).map(row => row.isExpanded), [true, true])
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

test('deep matches retain every loaded ancestor, hide sibling branches, and restore collapsed state without mutating snapshot', () => {
  const treeChildren = new Map([
    ['C:\\root', [entry('docs', true), entry('other', true), entry('a.txt')]],
    ['C:\\root\\docs', [{ ...entry('guides', true), path: 'C:\\root\\docs\\guides' }, { ...entry('readme.txt'), path: 'C:\\root\\docs\\readme.txt' }]],
    ['C:\\root\\docs\\guides', [{ ...entry('match.txt'), path: 'C:\\root\\docs\\guides\\match.txt' }, { ...entry('miss.txt'), path: 'C:\\root\\docs\\guides\\miss.txt' }]],
    ['C:\\root\\other', [{ ...entry('other.txt'), path: 'C:\\root\\other\\other.txt' }]]
  ])
  const treeSnapshot = { ...snapshot, children: treeChildren, expanded: new Set(['C:\\root']) }
  const filtered = buildFileTreeRows({ snapshot: treeSnapshot, filter: 'match' })
  assert.deepEqual(filtered.map(row => [row.entry.name, row.depth, row.isExpanded]), [
    ['root', 0, true], ['docs', 1, true], ['guides', 2, true], ['match.txt', 3, false]
  ])
  assert.deepEqual([...treeSnapshot.expanded], ['C:\\root'], 'presentation expansion must not modify snapshot.expanded')
  assert.deepEqual(buildFileTreeRows({ snapshot: treeSnapshot }).map(row => [row.entry.name, row.isExpanded]), [
    ['root', true], ['docs', false], ['other', false], ['a.txt', false]
  ])
})
