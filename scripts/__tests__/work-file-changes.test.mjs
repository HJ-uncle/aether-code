/** Pure path/filter contract tests for work-file-changes.ts. No Electron, IPC or engine. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const sourceFile = path.resolve('src/renderer/src/contrib/work/work-file-changes.ts')
const module = { exports: {} }
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  fileName: sourceFile,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
new vm.Script('(function(module,exports){' + compiled + '\n})', { filename: sourceFile })
  .runInThisContext({ timeout: 1000 })(module, module.exports)
const { workChangePathKey, changesForWorkFile } = module.exports

const change = (id, sessionId, filePath, status = 'pending') => ({ id, sessionId, path: filePath, status,
  kind: 'write', oldContent: null, newContent: '', truncated: false, createdAt: Number(id) || 1 })

test('absolute and workspace-relative paths resolve to the same Windows key', () => {
  assert.equal(workChangePathKey('src\\Report.docx', 'D:\\Company\\Dept'), 'd:/company/dept/src/report.docx')
  assert.equal(workChangePathKey('D:/Company/Dept/./src/../Report.docx'), 'd:/company/dept/report.docx')
  assert.equal(workChangePathKey('d:\\company\\dept\\report.docx'), 'd:/company/dept/report.docx')
  assert.deepEqual(changesForWorkFile([
    change('1', 'sales', 'D:\\Company\\Dept\\Report.docx'),
    change('2', 'sales', 'D:/Company/Dept/other.docx'),
  ], 'sales', 'src/../Report.docx', 'D:/Company/Dept'), [
    change('1', 'sales', 'D:\\Company\\Dept\\Report.docx'),
  ])
})

test('Windows drive and UNC forms are case-insensitive while POSIX paths preserve case', () => {
  assert.equal(workChangePathKey('C:/Users/A/File.txt'), 'c:/users/a/file.txt')
  assert.equal(workChangePathKey('c:\\users\\a\\FILE.TXT'), 'c:/users/a/file.txt')
  assert.equal(workChangePathKey('\\\\SERVER\\Share\\A.TXT'), '//server/share/a.txt')
  assert.equal(workChangePathKey('/Workspace/Readme.md'), '/Workspace/Readme.md')
  assert.notEqual(workChangePathKey('/Workspace/Readme.md'), workChangePathKey('/workspace/readme.md'))
})

test('same basename from departments and sessions does not cross-match', () => {
  const changes = [
    change('1', 'sales', 'D:/Company/Sales/plan.xlsx'),
    change('2', 'engineering', 'D:/Company/Engineering/plan.xlsx'),
    change('3', 'sales', 'D:/Company/Engineering/plan.xlsx'),
  ]
  assert.deepEqual(changesForWorkFile(changes, 'sales', 'D:/Company/Sales/plan.xlsx').map(item => item.id), ['1'])
  assert.deepEqual(changesForWorkFile(changes, 'engineering', 'D:/Company/Engineering/plan.xlsx').map(item => item.id), ['2'])
  assert.deepEqual(changesForWorkFile(changes, 'sales', 'D:/Company/Engineering/plan.xlsx').map(item => item.id), ['3'])
})

test('only pending changes are returned, preserving server order and ignoring absent/empty paths', () => {
  const changes = [
    change('1', 'one', 'D:/repo/a.txt', 'kept'),
    change('2', 'one', 'D:/repo/a.txt', 'pending'),
    change('3', 'one', 'D:/repo/a.txt', 'reverted'),
    change('4', 'one', 'D:/repo/a.txt', 'pending'),
  ]
  assert.deepEqual(changesForWorkFile(changes, 'one', 'D:/repo/a.txt').map(item => item.id), ['2', '4'])
  assert.deepEqual(changesForWorkFile(changes, 'one', ''), [])
  assert.deepEqual(changesForWorkFile(changes, 'one', 'a.txt', null), [])
})

test('dot segments normalize consistently for workspace-relative and absolute paths', () => {
  assert.equal(workChangePathKey('./src/./a.ts', '/workspace/project'), '/workspace/project/src/a.ts')
  assert.equal(workChangePathKey('src/dir/../../a.ts', '/workspace/project'), '/workspace/project/a.ts')
  assert.equal(workChangePathKey('../outside.txt', '/workspace/project'), '/workspace/outside.txt')
  assert.equal(workChangePathKey('C:/repo/dir/../../a.ts'), 'c:/a.ts')
})

test('relative paths without a root remain relative and do not match absolute paths', () => {
  assert.equal(workChangePathKey('./src/file.ts'), 'src/file.ts')
  assert.equal(workChangePathKey('src/file.ts'), 'src/file.ts')
  assert.notEqual(workChangePathKey('src/file.ts'), workChangePathKey('/repo/src/file.ts'))
  assert.deepEqual(changesForWorkFile([change('1', 'one', '/repo/src/file.ts')], 'one', 'src/file.ts'), [])
})
