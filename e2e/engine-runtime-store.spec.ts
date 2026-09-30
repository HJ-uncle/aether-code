/** Pure filesystem contracts: selection persistence, failed switches, and state isolation. */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getActiveRuntimeId, getLocalRuntimeRoot, listLocalRuntimes, removeLocalRuntime, setActiveRuntimeId } from '../src/main/engine/local-runtime-store'
import { selectRuntimeEntry } from '../src/main/engine/runtime-location'

const fixtures = resolve(__dirname, '..', '.e2e-tmp')
let fixture: string
test.beforeEach(() => {
  mkdirSync(fixtures, { recursive: true })
  fixture = mkdtempSync(join(fixtures, 'runtime-store-'))
})
test.afterEach(() => {
  if (dirname(fixture) !== fixtures) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

function addRuntime(id: string, importedAt = 1): void {
  const directory = getLocalRuntimeRoot(fixture, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'runtime-info.json'), JSON.stringify({
    id, version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, fileName: 'engine.tgz', importedAt
  }))
}

test('选择持久化，恢复默认保留已导入包和用户数据', () => {
  addRuntime('runtime-first')
  addRuntime('runtime-second', 2)
  const database = join(fixture, 'engine', 'state', 'agent.db')
  mkdirSync(dirname(database), { recursive: true })
  writeFileSync(database, 'existing user data')
  expect(getActiveRuntimeId(fixture)).toBeNull()
  setActiveRuntimeId(fixture, 'runtime-first')
  expect(getActiveRuntimeId(fixture)).toBe('runtime-first')
  setActiveRuntimeId(fixture, 'runtime-second')
  expect(getActiveRuntimeId(fixture)).toBe('runtime-second')
  setActiveRuntimeId(fixture, null)
  expect(getActiveRuntimeId(fixture)).toBeNull()
  expect(listLocalRuntimes(fixture).map(item => item.id)).toEqual(['runtime-second', 'runtime-first'])
  expect(readFileSync(database, 'utf8')).toBe('existing user data')
})

test('失败的切换与越界标识不能覆盖原选择', () => {
  addRuntime('runtime-first')
  setActiveRuntimeId(fixture, 'runtime-first')
  const pointer = join(fixture, 'engine', 'runtimes', 'active-runtime.json')
  const before = readFileSync(pointer, 'utf8')
  for (const id of ['../../state', 'C:\\engine', '/absolute', 'runtime-missing']) {
    expect(() => setActiveRuntimeId(fixture, id)).toThrow()
    expect(readFileSync(pointer, 'utf8')).toBe(before)
  }
  expect(() => getLocalRuntimeRoot(fixture, '../state')).toThrow()
})

test('只允许删除未启用版本，当前版本必须先恢复默认', () => {
  addRuntime('runtime-active')
  addRuntime('runtime-unused', 2)
  setActiveRuntimeId(fixture, 'runtime-active')
  expect(() => removeLocalRuntime(fixture, 'runtime-active')).toThrow('当前使用的本地引擎不能删除')
  removeLocalRuntime(fixture, 'runtime-unused')
  expect(listLocalRuntimes(fixture).map(item => item.id)).toEqual(['runtime-active'])
  expect(getActiveRuntimeId(fixture)).toBe('runtime-active')
})

test('旧版元数据缺少名称时从已安装 package.json 恢复配置名称', () => {
  addRuntime('runtime-legacy')
  writeFileSync(join(getLocalRuntimeRoot(fixture, 'runtime-legacy'), 'package.json'), JSON.stringify({ name: 'aether-engine' }))
  expect(listLocalRuntimes(fixture)[0].name).toBe('aether-engine')
})

test('临时目录、损坏清单和与目录不符的清单不会成为候选引擎', () => {
  addRuntime('runtime-valid')
  addRuntime('runtime-wrong')
  writeFileSync(join(getLocalRuntimeRoot(fixture, 'runtime-wrong'), 'runtime-info.json'), JSON.stringify({
    ...listLocalRuntimes(fixture)[0], id: 'runtime-valid'
  }))
  addRuntime('runtime-broken')
  writeFileSync(join(getLocalRuntimeRoot(fixture, 'runtime-broken'), 'runtime-info.json'), '{broken')
  mkdirSync(join(fixture, 'engine', 'runtimes', '.import-incomplete'))
  expect(listLocalRuntimes(fixture).map(item => item.id)).toEqual(['runtime-valid'])
})

test('用户选择的导入引擎在安装和开发模式中均实际生效，恢复默认回到原来源', () => {
  const importedRoot = join(fixture, 'engine', 'runtimes', 'runtime-selected')
  const options = { resourcesPath: join(fixture, 'resources'), appPath: fixture, platform: 'win32-x64', override: join(fixture, 'dev', 'dist', 'main.js') }
  for (const packaged of [true, false]) {
    expect(selectRuntimeEntry({ ...options, packaged, importedRoot })).toEqual({
      entryPath: join(importedRoot, 'dist', 'main.js'), source: 'imported'
    })
    expect(selectRuntimeEntry({ ...options, packaged }).source).toBe(packaged ? 'bundled' : 'env')
  }
})
