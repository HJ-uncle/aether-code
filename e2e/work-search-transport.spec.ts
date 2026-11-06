/** Work 搜索传输纯逻辑：冻结后端文件集、会话隔离、越界读写、取消、完整读取保护与替换落盘计数。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { FsFileContent, SearchOptions } from '../src/shared/ipc'
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
  const contents = new Map<string, FsFileContent>()
  const calls: { method: string; path: string; target: SessionFileTarget }[] = []
  const writes: { path: string; content: string }[] = []
  const absolute = (path: string): string => path ? `${root}/${path}` : root
  const content = (path: string, text: string, extra: Partial<FsFileContent> = {}): FsFileContent =>
    ({ path: absolute(path), content: text, isBinary: false, truncated: false, size: text.length, ...extra })
  const deps: WorkSearchDependencies = {
    assertTarget(actual) { expect(actual).toBe(target); if (!engineCurrent) throw new Error('引擎连接已变化') },
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
  return { root, target, deps, contents, calls, writes, content, absolute,
    current: () => current, cancel: () => { current = false }, changeEngine: () => { engineCurrent = false } }
}

for (const mode of ['embedded', 'remote'] as const) {
  test(`${mode} Work 搜索和替换始终使用捕获的会话工作区`, async () => {
    const f = fixture(mode)
    f.contents.set(f.absolute('src/hello.txt'), f.content('src/hello.txt', 'hello world\nhello again'))
    const transport = createWorkSearchTransport(f.target, f.current, ['src/hello.txt'], f.deps)
    const result = await search.searchRemoteWorkspace(transport, 'hello', options, {})
    expect(result.hits.map(hit => [hit.path, hit.line])).toEqual([['src/hello.txt', 1], ['src/hello.txt', 2]])
    const replaced = await search.replaceRemoteWorkspace(transport, 'hello', options, 'welcome', {})
    expect(replaced).toEqual({ files: ['src/hello.txt'], replacements: 2 })
    expect(f.writes).toEqual([{ path: f.absolute('src/hello.txt'), content: 'welcome world\nwelcome again' }])
    expect(f.calls.every(call => call.target === f.target && call.path.startsWith(f.root))).toBe(true)
    expect(f.calls.map(call => call.method)).toContain('write')
  })
}

test('后端文件集在创建时冻结，读取列表不访问目录或文件', async () => {
  const f = fixture()
  const files = ['src/nested/keep.ts', 'README.md', 'src/nested/keep.ts']
  const transport = createWorkSearchTransport(f.target, f.current, files, f.deps)
  files.splice(0, files.length, 'outside.txt')
  expect(search.flattenRemoteFiles(await transport.listFiles())).toEqual(['src/nested/keep.ts', 'README.md'])
  expect(f.calls).toEqual([])
  await expectRejection(transport.readFile('outside.txt'), '文件不在本次搜索结果中')
  expect(f.calls).toEqual([])
})

test('后端指定的大于 2000 条路径和 52 层文件保持完整，无前端目录遍历上限', async () => {
  const f = fixture()
  const deep = `${Array.from({ length: 52 }, (_, index) => `level-${index}`).join('/')}/deep.txt`
  const files = [...Array.from({ length: 2500 }, (_, index) => `directory-${index}/file.txt`), deep]
  const transport = createWorkSearchTransport(f.target, f.current, files, f.deps)
  expect(search.flattenRemoteFiles(await transport.listFiles())).toEqual(files)
  expect(f.calls).toEqual([])
  f.contents.set(f.absolute(deep), f.content(deep, 'needle'))
  expect((await transport.readFile(deep)).content).toBe('needle')
  expect(f.calls.map(call => [call.method, call.path])).toEqual([['read', f.absolute(deep)]])
})

test('空的后端文件集保持为空，预览不读取文件也不枚举工作区', async () => {
  const f = fixture()
  f.contents.set(f.absolute('unselected.txt'), f.content('unselected.txt', 'needle'))
  const transport = createWorkSearchTransport(f.target, f.current, [], f.deps)
  const preview = await search.previewRemoteReplace(transport, 'needle', options, 'replacement', {})
  expect(preview).toEqual({ files: [], total: 0, truncated: false, error: undefined })
  expect(f.calls).toEqual([])
  expect(f.writes).toEqual([])
})

test('文件读取失败保留其它命中并明确标记结果不完整', async () => {
  const f = fixture()
  f.contents.set(f.absolute('good.txt'), f.content('good.txt', 'needle'))
  const result = await search.searchRemoteWorkspace(createWorkSearchTransport(f.target, f.current, ['good.txt', 'unreadable.txt'], f.deps), 'needle', options, {})
  expect(result.hits.map(hit => hit.path)).toEqual(['good.txt'])
  expect(result.truncated).toBe(true)
  expect(result.error).toContain('unreadable.txt')
})

test('文件集外的合法路径不能读取或写入，即使已经存在于同一工作区', async () => {
  const f = fixture()
  for (const path of ['selected.txt', 'unselected.txt']) f.contents.set(f.absolute(path), f.content(path, 'needle'))
  const transport = createWorkSearchTransport(f.target, f.current, ['selected.txt'], f.deps)
  await transport.readFile('selected.txt')
  // Mutating the presentation tree must not grant filesystem access either.
  const tree = await transport.listFiles()
  tree.children!.push({ name: 'unselected.txt', type: 'file' })
  await expectRejection(transport.readFile('unselected.txt'), '文件不在本次搜索结果中')
  await expectRejection(transport.writeFile('unselected.txt', 'replacement'), '文件不在本次搜索结果中')
  expect(f.calls.map(call => [call.method, call.path])).toEqual([['read', f.absolute('selected.txt')]])
  expect(f.writes).toEqual([])
  expect(f.contents.get(f.absolute('unselected.txt'))?.content).toBe('needle')
})

test('无效文件集和读写路径在文件请求前被拒绝', async () => {
  const f = fixture()
  const transport = createWorkSearchTransport(f.target, f.current, ['selected.txt'], f.deps)
  for (const path of ['../outside.txt', '%2e%2e/outside.txt', '%252e%252e/outside.txt', '/outside.txt',
    'D:/code-workspace/other.txt', 'src/../../outside.txt', 'src//file.txt', 'nul\u0000.txt']) {
    expect(() => createWorkSearchTransport(f.target, f.current, [path], f.deps)).toThrow('无效文件路径')
    await expectRejection(transport.readFile(path), '无效文件路径')
    await expectRejection(transport.writeFile(path, 'replacement'), '无效文件路径')
  }
  expect(f.calls).toEqual([])
})

test('切会话后冻结列表和后续读取立即失效', async () => {
  const f = fixture()
  const transport = createWorkSearchTransport(f.target, f.current, ['selected.txt'], f.deps)
  expect(search.flattenRemoteFiles(await transport.listFiles())).toEqual(['selected.txt'])
  f.cancel()
  await expectRejection(transport.listFiles(), '搜索已取消')
  await expectRejection(transport.readFile('selected.txt'), '搜索已取消')
  expect(f.calls).toEqual([])
})

test('切换引擎使正在读取的结果失效且禁止后续写入', async () => {
  const f = fixture()
  const pending = deferred<FsFileContent>()
  f.deps.readFile = async () => pending.promise
  const transport = createWorkSearchTransport(f.target, f.current, ['late.txt'], f.deps)
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
    f.contents.set(f.absolute('partial.txt'), f.content('partial.txt', 'needle', { [flag]: true }))
    const transport = createWorkSearchTransport(f.target, f.current, ['partial.txt'], f.deps)
    const result = await search.replaceRemoteWorkspace(transport, 'needle', options, 'replacement', {})
    expect(result.files).toEqual([])
    expect(result.error).toContain('文件内容被截断或超过读取上限')
    await expectRejection(transport.writeFile('partial.txt', 'replacement'), '尚未完整读取')
  }
  f.contents.set(f.absolute('binary.bin'), f.content('binary.bin', '', { isBinary: true }))
  const binary = createWorkSearchTransport(f.target, f.current, ['binary.bin'], f.deps)
  await binary.readFile('binary.bin')
  await expectRejection(binary.writeFile('binary.bin', 'replacement'), '尚未完整读取')
  expect(f.writes).toEqual([])
})

test('替换读取期间切会话取消写入', async () => {
  const f = fixture()
  const started = deferred<void>(), pending = deferred<FsFileContent>()
  f.deps.readFile = async () => { started.resolve(); return pending.promise }
  const operation = search.replaceRemoteWorkspace(createWorkSearchTransport(f.target, f.current, ['late.txt'], f.deps), 'needle', options, 'replacement', {})
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
  for (const path of ['first.txt', 'second.txt']) f.contents.set(f.absolute(path), f.content(path, 'needle'))
  const write = f.deps.writeFile
  f.deps.writeFile = async (path, content, target) => { await write(path, content, target); f.cancel() }
  const result = await search.replaceRemoteWorkspace(createWorkSearchTransport(f.target, f.current, ['first.txt', 'second.txt'], f.deps), 'needle', options, 'replacement', {})
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
  f.contents.set(f.absolute('anchors.txt'), f.content('anchors.txt', original))
  const transport = createWorkSearchTransport(f.target, f.current, ['anchors.txt'], f.deps)
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
  f.contents.set(f.absolute('long.txt'), f.content('long.txt', `heading\n${line}`))
  const result = await search.searchRemoteWorkspace(createWorkSearchTransport(f.target, f.current, ['long.txt'], f.deps), 'needle', options, {})
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
  f.contents.set(f.absolute('multiline.txt'), f.content('multiline.txt', original))
  const transport = createWorkSearchTransport(f.target, f.current, ['multiline.txt'], f.deps)
  const preview = await search.previewRemoteReplace(transport, 'foo\\s+bar', config, 'changed', {})
  expect(preview.error).toContain('跨行正则替换需要在编辑器中确认')
  expect(preview.total).toBe(0)
  const result = await search.replaceRemoteWorkspace(transport, 'foo\\s+bar', config, 'changed', {})
  expect(result.error).toContain('跨行正则替换需要在编辑器中确认')
  expect(result.replacements).toBe(0)
  expect(f.writes).toEqual([])
  expect(f.contents.get(f.absolute('multiline.txt'))?.content).toBe(original)
})
