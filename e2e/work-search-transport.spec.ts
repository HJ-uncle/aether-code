/** Work 搜索专项纯逻辑：会话隔离、排除剪枝、边界/失败、取消、完整读取保护与替换落盘计数。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { FsEntry, FsFileContent, SearchOptions } from '../src/shared/ipc'
import type { SessionFileTarget } from '../src/renderer/src/core/workspace/fs-client'
import type { WorkSearchDependencies } from '../src/renderer/src/contrib/work/work-search-transport'
import * as search from '../src/renderer/src/contrib/search/remote-search'
import * as pathSafety from '../src/shared/path-safety'

type TransportModule = typeof import('../src/renderer/src/contrib/work/work-search-transport')

// Execute the implementation with explicit file dependencies, without mounting
// renderer singletons or inheriting the development instance's Code workspace.
function loadTransport(): TransportModule {
  const filename = resolve(__dirname, '../src/renderer/src/contrib/work/work-search-transport.ts')
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const dependencies: Record<string, unknown> = {
    '@shared/path-safety': pathSafety,
    '../../core/workspace/fs-client': {},
    '../search/remote-search': search
  }
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected Work search dependency: ${name}`)
    return dependencies[name]
  } }, { filename })
  return module.exports as TransportModule
}

const { createWorkSearchTransport, workSearchFileTree } = loadTransport()
const options: SearchOptions = { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function expectRejection(operation: Promise<unknown>, message: string): Promise<void> {
  // VM promises use another realm; normalizing the outcome avoids the test
  // runner's Promise identity check while still failing on successful resolves.
  const result = await operation.then(
    () => ({ rejected: false, message: '' }),
    reason => ({ rejected: true, message: String(reason) })
  )
  expect(result.rejected).toBe(true)
  expect(result.message).toContain(message)
}

function fixture(mode: 'embedded' | 'remote' = 'embedded') {
  const root = mode === 'embedded' ? 'D:/engine/work-home/task-a' : '/engine/work/task-a'
  const target: SessionFileTarget = { source: 8, expectedEngine: { mode, baseUrl: 'http://engine.test', instanceId: 'engine-a' },
    sessionId: 'work-task-a', root, bindingEpoch: 'epoch-a', key: 'task-a-bound' }
  let current = true, engineCurrent = true
  const directories = new Map<string, FsEntry[]>()
  const contents = new Map<string, FsFileContent>()
  const calls: { method: string; path: string; target: SessionFileTarget }[] = []
  const writes: { path: string; content: string }[] = []
  const absolute = (path: string): string => path ? `${root}/${path}` : root
  const entry = (path: string, isDirectory = false): FsEntry => ({ name: path.split('/').pop()!, path: absolute(path), isDirectory, size: 10, mtimeMs: 1 })
  const content = (path: string, text: string, extra: Partial<FsFileContent> = {}): FsFileContent =>
    ({ path: absolute(path), content: text, isBinary: false, truncated: false, size: text.length, ...extra })
  const deps: WorkSearchDependencies = {
    assertTarget(actual) { expect(actual).toBe(target); if (!engineCurrent) throw new Error('引擎连接已变化') },
    async readDir(path, target) {
      calls.push({ method: 'directory', path, target })
      const result = directories.get(path)
      if (!result) throw new Error('目录无法读取')
      return result
    },
    async readFile(path, target) {
      calls.push({ method: 'read', path, target })
      const result = contents.get(path)
      if (!result) throw new Error('文件无法读取')
      return result
    },
    async writeFile(path, text, target) {
      calls.push({ method: 'write', path, target })
      writes.push({ path, content: text })
      contents.set(path, content(path.slice(root.length + 1), text))
    }
  }
  return { root, target, deps, directories, contents, calls, writes, entry, content, absolute,
    current: () => current, cancel: () => { current = false }, changeEngine: () => { engineCurrent = false } }
}

for (const mode of ['embedded', 'remote'] as const) {
  test(`${mode} Work 搜索和替换始终使用捕获的会话工作区`, async () => {
    const f = fixture(mode)
    f.directories.set(f.root, [f.entry('src', true)])
    f.directories.set(f.absolute('src'), [f.entry('src/hello.txt')])
    f.contents.set(f.absolute('src/hello.txt'), f.content('src/hello.txt', 'hello world\nhello again'))
    const transport = createWorkSearchTransport(f.target, f.current, options, {}, f.deps)
    const result = await search.searchRemoteWorkspace(transport, 'hello', options, {})
    expect(result.hits.map(hit => [hit.path, hit.line])).toEqual([['src/hello.txt', 1], ['src/hello.txt', 2]])
    const replaced = await search.replaceRemoteWorkspace(transport, 'hello', options, 'welcome', {})
    expect(replaced).toEqual({ files: ['src/hello.txt'], replacements: 2 })
    expect(f.writes).toEqual([{ path: f.absolute('src/hello.txt'), content: 'welcome world\nwelcome again' }])
    expect(f.calls.every(call => call.target === f.target && call.path.startsWith(f.root))).toBe(true)
    expect(f.calls.map(call => call.method)).toContain('write')
  })
}

test('目录遍历按排除设置剪枝，包含文件 glob 不阻断上层目录', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('src', true), f.entry('private', true), f.entry('node_modules', true), f.entry('.git', true)])
  f.directories.set(f.absolute('src'), [f.entry('src/nested', true)])
  f.directories.set(f.absolute('src/nested'), [f.entry('src/nested/keep.ts'), f.entry('src/nested/note.txt')])
  f.contents.set(f.absolute('src/nested/keep.ts'), f.content('src/nested/keep.ts', 'needle'))
  const config = { ...options, include: '**/*.ts', exclude: '**/private' }
  const excludes = { '**/node_modules': true }
  const transport = createWorkSearchTransport(f.target, f.current, config, excludes, f.deps)
  const result = await search.searchRemoteWorkspace(transport, 'needle', config, excludes)
  expect(result).toEqual({ hits: [{ path: 'src/nested/keep.ts', line: 1, text: 'needle', column: 1, length: 6 }], truncated: false, strategy: 'scan', error: undefined })
  expect(f.calls.filter(call => call.method === 'directory').map(call => call.path)).toEqual([f.root, f.absolute('src'), f.absolute('src/nested')])
  expect(f.calls.filter(call => call.method === 'read').map(call => call.path)).toEqual([f.absolute('src/nested/keep.ts')])
})

test('关闭排除项后能够搜索依赖目录', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('node_modules', true)])
  f.directories.set(f.absolute('node_modules'), [f.entry('node_modules/dependency.txt')])
  f.contents.set(f.absolute('node_modules/dependency.txt'), f.content('node_modules/dependency.txt', 'needle'))
  const transport = createWorkSearchTransport(f.target, f.current, options, { '**/node_modules': false }, f.deps)
  const result = await search.searchRemoteWorkspace(transport, 'needle', options, {})
  expect(result.hits.map(hit => hit.path)).toEqual(['node_modules/dependency.txt'])
})

test('目录读取失败明确报告目录，不返回无匹配的成功结果', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('unreadable', true)])
  const transport = createWorkSearchTransport(f.target, f.current, options, {}, f.deps)
  await expectRejection(search.searchRemoteWorkspace(transport, 'needle', options, {}), '无法搜索目录 unreadable')
})

test('文件读取失败保留其它命中并明确标记结果不完整', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('good.txt'), f.entry('unreadable.txt')])
  f.contents.set(f.absolute('good.txt'), f.content('good.txt', 'needle'))
  const result = await search.searchRemoteWorkspace(createWorkSearchTransport(f.target, f.current, options, {}, f.deps), 'needle', options, {})
  expect(result.hits.map(hit => hit.path)).toEqual(['good.txt'])
  expect(result.truncated).toBe(true)
  expect(result.error).toContain('unreadable.txt')
})

test('文件数、目录数、深度上限均明确失败，不返回被截短的文件树', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('a.txt'), f.entry('b.txt')])
  await expectRejection(createWorkSearchTransport(f.target, f.current, options, {}, f.deps, { files: 1, directories: 10, depth: 10 }).listFiles(), '文件超过搜索上限')
  f.directories.set(f.root, [f.entry('nested', true)])
  await expectRejection(createWorkSearchTransport(f.target, f.current, options, {}, f.deps, { files: 10, directories: 1, depth: 10 }).listFiles(), '目录超过搜索上限')
  await expectRejection(createWorkSearchTransport(f.target, f.current, options, {}, f.deps, { files: 10, directories: 10, depth: 0 }).listFiles(), '超过搜索深度')
})

test('目录响应不能循环、越出会话根目录或重复同一路径', async () => {
  const f = fixture()
  const transport = createWorkSearchTransport(f.target, f.current, options, {}, f.deps)
  f.directories.set(f.root, [{ ...f.entry('loop', true), path: f.root }])
  await expectRejection(transport.listFiles(), '路径不一致')
  f.directories.set(f.root, [{ ...f.entry('other.txt'), path: 'D:/code-workspace/other.txt' }])
  await expectRejection(transport.listFiles(), '路径不一致')
  f.directories.set(f.root, [f.entry('same.txt'), f.entry('same.txt')])
  await expectRejection(transport.listFiles(), '重复路径')
  await expectRejection(transport.readFile('../outside.txt'), '无效文件路径')
  await expectRejection(transport.readFile('%2e%2e/outside.txt'), '无效文件路径')
  expect(f.calls.filter(call => call.method === 'read')).toEqual([])
})

test('切会话后迟到的目录回包不能继续扫描子目录', async () => {
  const f = fixture()
  const pending = deferred<FsEntry[]>()
  const paths: string[] = []
  f.deps.readDir = async path => { paths.push(path); return pending.promise }
  const operation = createWorkSearchTransport(f.target, f.current, options, {}, f.deps).listFiles()
  f.cancel()
  pending.resolve([f.entry('nested', true)])
  await expectRejection(operation, '搜索已取消')
  expect(paths).toEqual([f.root])
})

test('切换引擎使正在读取的结果失效且禁止后续写入', async () => {
  const f = fixture()
  const pending = deferred<FsFileContent>()
  f.deps.readFile = async () => pending.promise
  const transport = createWorkSearchTransport(f.target, f.current, options, {}, f.deps)
  const operation = transport.readFile('late.txt')
  f.changeEngine()
  pending.resolve(f.content('late.txt', 'needle'))
  await expectRejection(operation, '引擎连接已变化')
  await expectRejection(transport.writeFile('late.txt', 'replacement'), '引擎连接已变化')
  expect(f.writes).toEqual([])
})

test('截断、大文件和二进制均不能成为替换写入来源', async () => {
  const f = fixture()
  for (const flag of ['truncated', 'tooLarge'] as const) {
    f.directories.set(f.root, [f.entry('partial.txt')])
    f.contents.set(f.absolute('partial.txt'), f.content('partial.txt', 'needle', { [flag]: true }))
    const transport = createWorkSearchTransport(f.target, f.current, options, {}, f.deps)
    const result = await search.replaceRemoteWorkspace(transport, 'needle', options, 'replacement', {})
    expect(result.files).toEqual([])
    expect(result.error).toContain('文件内容被截断或超过读取上限')
    await expectRejection(transport.writeFile('partial.txt', 'replacement'), '尚未完整读取')
  }
  f.contents.set(f.absolute('binary.bin'), f.content('binary.bin', '', { isBinary: true }))
  const binary = createWorkSearchTransport(f.target, f.current, options, {}, f.deps)
  await binary.readFile('binary.bin')
  await expectRejection(binary.writeFile('binary.bin', 'replacement'), '尚未完整读取')
  expect(f.writes).toEqual([])
})

test('替换读取期间切会话取消写入', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('late.txt')])
  const started = deferred<void>(), pending = deferred<FsFileContent>()
  f.deps.readFile = async () => { started.resolve(); return pending.promise }
  const operation = search.replaceRemoteWorkspace(createWorkSearchTransport(f.target, f.current, options, {}, f.deps), 'needle', options, 'replacement', {})
  await started.promise
  f.cancel()
  pending.resolve(f.content('late.txt', 'needle'))
  const result = await operation
  expect(result.replacements).toBe(0)
  expect(result.error).toContain('搜索已取消')
  expect(f.writes).toEqual([])
})

test('取消发生在写入完成期间时保留已落盘计数并停止后续文件', async () => {
  const f = fixture()
  f.directories.set(f.root, [f.entry('first.txt'), f.entry('second.txt')])
  for (const path of ['first.txt', 'second.txt']) f.contents.set(f.absolute(path), f.content(path, 'needle'))
  const write = f.deps.writeFile
  f.deps.writeFile = async (path, content, target) => { await write(path, content, target); f.cancel() }
  const result = await search.replaceRemoteWorkspace(createWorkSearchTransport(f.target, f.current, options, {}, f.deps), 'needle', options, 'replacement', {})
  expect(result.files).toEqual(['first.txt'])
  expect(result.replacements).toBe(1)
  expect(result.error).toContain('搜索已取消')
  expect(f.writes).toEqual([{ path: f.absolute('first.txt'), content: 'replacement' }])
  expect(f.calls.filter(call => call.method === 'read').map(call => call.path)).toEqual([f.absolute('first.txt')])
})

test('冻结替换文件集保持层级、去重且拒绝无效/冲突路径', () => {
  expect(search.flattenRemoteFiles(workSearchFileTree(['src/a.ts', 'src/nested/b.ts', 'src/a.ts', 'readme.md']))).toEqual(['src/a.ts', 'src/nested/b.ts', 'readme.md'])
  expect(() => workSearchFileTree(['../escape.txt'])).toThrow('无效文件路径')
  expect(() => workSearchFileTree(['a', 'a/nested.txt'])).toThrow('路径冲突')
})

test('逐行锚定正则的预览与应用一致，并保留混合换行和末尾换行', async () => {
  const f = fixture()
  const config = { ...options, useRegex: true }
  const original = 'foo\r\nuntouched\nfoo\rfoo\n'
  f.directories.set(f.root, [f.entry('anchors.txt')])
  f.contents.set(f.absolute('anchors.txt'), f.content('anchors.txt', original))
  const transport = createWorkSearchTransport(f.target, f.current, config, {}, f.deps)
  const preview = await search.previewRemoteReplace(transport, '^(foo)$', config, '$1-updated', {})
  expect(preview.total).toBe(3)
  expect(preview.truncated).toBe(false)
  expect(preview.error).toBeUndefined()
  expect(preview.files).toEqual([{ path: 'anchors.txt', lines: [
    { line: 1, before: 'foo', after: 'foo-updated' },
    { line: 3, before: 'foo', after: 'foo-updated' },
    { line: 4, before: 'foo', after: 'foo-updated' }
  ] }])
  expect(f.writes).toEqual([])
  const result = await search.replaceRemoteWorkspace(transport, '^(foo)$', config, '$1-updated', {})
  expect(result).toEqual({ files: ['anchors.txt'], replacements: preview.total })
  expect(f.contents.get(f.absolute('anchors.txt'))?.content).toBe('foo-updated\r\nuntouched\nfoo-updated\rfoo-updated\n')
  expect(f.writes).toHaveLength(1)
})

test('长行搜索保留原始匹配坐标，并在展示片段中保留命中', async () => {
  const f = fixture()
  const prefix = 'x'.repeat(620)
  const line = `${prefix}needle${'y'.repeat(300)}`
  f.directories.set(f.root, [f.entry('long.txt')])
  f.contents.set(f.absolute('long.txt'), f.content('long.txt', `heading\n${line}`))
  const result = await search.searchRemoteWorkspace(createWorkSearchTransport(f.target, f.current, options, {}, f.deps), 'needle', options, {})
  expect(result.hits).toHaveLength(1)
  const hit = result.hits[0]
  expect(hit).toMatchObject({ path: 'long.txt', line: 2, column: 621, length: 6 })
  expect(hit.text.length).toBeLessThanOrEqual(240)
  expect(hit.text).toContain('needle')
  expect(line.slice(hit.column! - 1, hit.column! - 1 + hit.length!)).toBe('needle')
})

test('跨行正则在预览与直接应用时均说明限制且不改文件', async () => {
  const f = fixture()
  const config = { ...options, useRegex: true }
  const original = 'foo\r\nbar'
  f.directories.set(f.root, [f.entry('multiline.txt')])
  f.contents.set(f.absolute('multiline.txt'), f.content('multiline.txt', original))
  const transport = createWorkSearchTransport(f.target, f.current, config, {}, f.deps)
  const preview = await search.previewRemoteReplace(transport, 'foo\\s+bar', config, 'changed', {})
  expect(preview.error).toContain('跨行正则替换需要在编辑器中确认')
  expect(preview.total).toBe(0)
  const result = await search.replaceRemoteWorkspace(transport, 'foo\\s+bar', config, 'changed', {})
  expect(result.error).toContain('跨行正则替换需要在编辑器中确认')
  expect(result.replacements).toBe(0)
  expect(f.writes).toEqual([])
  expect(f.contents.get(f.absolute('multiline.txt'))?.content).toBe(original)
})
