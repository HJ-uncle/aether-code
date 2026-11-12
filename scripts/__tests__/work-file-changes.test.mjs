/** Pure path/filter contract tests for work-file-changes.ts. No Electron, IPC or engine. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const sourceFile = path.resolve('src/renderer/src/features/artifacts/file-changes.ts')
const module = { exports: {} }
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  fileName: sourceFile,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
new vm.Script('(function(module,exports){' + compiled + '\n})', { filename: sourceFile })
  .runInThisContext({ timeout: 1000 })(module, module.exports)
const { sessionChangePathKey, changesForSessionFile } = module.exports

const change = (id, sessionId, filePath, status = 'pending') => ({ id, sessionId, path: filePath, status,
  kind: 'write', oldContent: null, newContent: '', truncated: false, createdAt: Number(id) || 1 })

test('absolute and workspace-relative paths resolve to the same Windows key', () => {
  assert.equal(sessionChangePathKey('src\\Report.docx', 'D:\\Company\\Dept'), 'd:/company/dept/src/report.docx')
  assert.equal(sessionChangePathKey('D:/Company/Dept/./src/../Report.docx'), 'd:/company/dept/report.docx')
  assert.equal(sessionChangePathKey('d:\\company\\dept\\report.docx'), 'd:/company/dept/report.docx')
  assert.deepEqual(changesForSessionFile([
    change('1', 'sales', 'D:\\Company\\Dept\\Report.docx'),
    change('2', 'sales', 'D:/Company/Dept/other.docx'),
  ], 'sales', 'src/../Report.docx', 'D:/Company/Dept'), [
    change('1', 'sales', 'D:\\Company\\Dept\\Report.docx'),
  ])
})

test('Windows drive and UNC forms are case-insensitive while POSIX paths preserve case', () => {
  assert.equal(sessionChangePathKey('C:/Users/A/File.txt'), 'c:/users/a/file.txt')
  assert.equal(sessionChangePathKey('c:\\users\\a\\FILE.TXT'), 'c:/users/a/file.txt')
  assert.equal(sessionChangePathKey('\\\\SERVER\\Share\\A.TXT'), '//server/share/a.txt')
  assert.equal(sessionChangePathKey('/Workspace/Readme.md'), '/Workspace/Readme.md')
  assert.notEqual(sessionChangePathKey('/Workspace/Readme.md'), sessionChangePathKey('/workspace/readme.md'))
})

test('same basename from departments and sessions does not cross-match', () => {
  const changes = [
    change('1', 'sales', 'D:/Company/Sales/plan.xlsx'),
    change('2', 'engineering', 'D:/Company/Engineering/plan.xlsx'),
    change('3', 'sales', 'D:/Company/Engineering/plan.xlsx'),
  ]
  assert.deepEqual(changesForSessionFile(changes, 'sales', 'D:/Company/Sales/plan.xlsx').map(item => item.id), ['1'])
  assert.deepEqual(changesForSessionFile(changes, 'engineering', 'D:/Company/Engineering/plan.xlsx').map(item => item.id), ['2'])
  assert.deepEqual(changesForSessionFile(changes, 'sales', 'D:/Company/Engineering/plan.xlsx').map(item => item.id), ['3'])
})

test('only pending changes are returned, preserving server order and ignoring absent/empty paths', () => {
  const changes = [
    change('1', 'one', 'D:/repo/a.txt', 'kept'),
    change('2', 'one', 'D:/repo/a.txt', 'pending'),
    change('3', 'one', 'D:/repo/a.txt', 'reverted'),
    change('4', 'one', 'D:/repo/a.txt', 'pending'),
  ]
  assert.deepEqual(changesForSessionFile(changes, 'one', 'D:/repo/a.txt').map(item => item.id), ['2', '4'])
  assert.deepEqual(changesForSessionFile(changes, 'one', ''), [])
  assert.deepEqual(changesForSessionFile(changes, 'one', 'a.txt', null), [])
})

test('dot segments normalize consistently for workspace-relative and absolute paths', () => {
  assert.equal(sessionChangePathKey('./src/./a.ts', '/workspace/project'), '/workspace/project/src/a.ts')
  assert.equal(sessionChangePathKey('src/dir/../../a.ts', '/workspace/project'), '/workspace/project/a.ts')
  assert.equal(sessionChangePathKey('../outside.txt', '/workspace/project'), '/workspace/outside.txt')
  assert.equal(sessionChangePathKey('C:/repo/dir/../../a.ts'), 'c:/a.ts')
})

test('relative paths without a root remain relative and do not match absolute paths', () => {
  assert.equal(sessionChangePathKey('./src/file.ts'), 'src/file.ts')
  assert.equal(sessionChangePathKey('src/file.ts'), 'src/file.ts')
  assert.notEqual(sessionChangePathKey('src/file.ts'), sessionChangePathKey('/repo/src/file.ts'))
  assert.deepEqual(changesForSessionFile([change('1', 'one', '/repo/src/file.ts')], 'one', 'src/file.ts'), [])
})
