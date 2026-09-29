/** D0 pure contracts: runtime choice, safe key migration, and strict metadata parsing. */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadOrCreateEncryptionKey, type SecretEncryption } from '../src/main/engine/secret-store'
import { selectRuntimeEntry } from '../src/main/engine/runtime-location'
import {
  assertEngineHealth,
  engineHeaders,
  normalizeEnginePath,
  parseEngineMeta,
  remoteRequestError
} from '../src/main/engine/protocol'

const fixtureRoot = resolve(__dirname, '..', '.e2e-tmp')
let fixture: string
const storage: SecretEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => {
    const text = value.toString()
    if (!text.startsWith('encrypted:')) throw new Error('unreadable')
    return text.slice('encrypted:'.length)
  }
}
const key = 'a'.repeat(64)
function paths(): { target: string; legacy: string } {
  const root = join(fixture, 'engine')
  mkdirSync(root, { recursive: true })
  return {
    target: join(root, 'secrets', 'engine-secrets.json'),
    legacy: join(root, 'engine-secrets.json')
  }
}

test.beforeEach(() => {
  mkdirSync(fixtureRoot, { recursive: true })
  fixture = mkdtempSync(join(fixtureRoot, 'd0-storage-'))
})
test.afterEach(() => {
  if (dirname(fixture) !== fixtureRoot)
    throw new Error('Refusing fixture cleanup outside test root')
  rmSync(fixture, { recursive: true, force: true })
})

test('旧加密密钥暂不可读时保留字节且不创建替代密钥', () => {
  const { target, legacy } = paths()
  const original = JSON.stringify({
    encrypted: true,
    encryptionKey: storage.encryptString(key).toString('base64')
  })
  writeFileSync(legacy, original)
  const unavailable = { ...storage, isEncryptionAvailable: () => false }
  expect(() => loadOrCreateEncryptionKey(target, legacy, unavailable)).toThrow(/原文件已保留/)
  expect(readFileSync(legacy, 'utf8')).toBe(original)
  expect(existsSync(target)).toBe(false)
})

test('旧密钥只复制一次，后续读取目标且不修改源文件', () => {
  const { target, legacy } = paths()
  const original = JSON.stringify({
    encrypted: true,
    encryptionKey: storage.encryptString(key).toString('base64')
  })
  writeFileSync(legacy, original)
  expect(loadOrCreateEncryptionKey(target, legacy, storage)).toEqual({ key, encryptedAtRest: true })
  expect(readFileSync(target, 'utf8')).toBe(original)
  expect(readFileSync(legacy, 'utf8')).toBe(original)
  writeFileSync(legacy, 'invalid legacy data after successful migration')
  expect(loadOrCreateEncryptionKey(target, legacy, storage).key).toBe(key)
  expect(readFileSync(target, 'utf8')).toBe(original)
})

test('损坏的当前密钥不能回退旧文件或被自动覆盖', () => {
  const { target, legacy } = paths()
  writeFileSync(legacy, JSON.stringify({ encrypted: false, encryptionKey: key }))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '{broken')
  expect(() => loadOrCreateEncryptionKey(target, legacy, storage)).toThrow(/原文件已保留/)
  expect(readFileSync(target, 'utf8')).toBe('{broken')
})

test('首次密钥保存后保持稳定，加密能力消失也不覆盖', () => {
  const { target, legacy } = paths()
  const first = loadOrCreateEncryptionKey(target, legacy, storage)
  const original = readFileSync(target, 'utf8')
  expect(first.key).toMatch(/^[a-f0-9]{64}$/)
  expect(loadOrCreateEncryptionKey(target, legacy, storage)).toEqual(first)
  expect(() =>
    loadOrCreateEncryptionKey(target, legacy, { ...storage, isEncryptionAvailable: () => false })
  ).toThrow()
  expect(readFileSync(target, 'utf8')).toBe(original)
})

test('开发态只选择显式入口或同级dist，打包态忽略开发覆盖', () => {
  const options = {
    packaged: false,
    resourcesPath: join(fixture, 'resources'),
    appPath: join(fixture, 'aether-code'),
    platform: 'win32-x64'
  }
  expect(selectRuntimeEntry(options)).toEqual({
    entryPath: join(fixture, 'ai-agent-engine', 'dist', 'main.js'),
    source: 'dev-sibling'
  })
  expect(
    selectRuntimeEntry({ ...options, override: join(fixture, 'custom', 'dist', 'main.js') }).source
  ).toBe('env')
  expect(
    selectRuntimeEntry({
      ...options,
      packaged: true,
      override: join(fixture, 'custom', 'dist', 'main.js')
    })
  ).toEqual({
    entryPath: join(fixture, 'resources', 'engine', 'win32-x64', 'dist', 'main.js'),
    source: 'bundled'
  })
})

test('握手拒绝错误构建、旧协议、缺少code范围和伪健康信封', () => {
  const data = {
    version: '2.0.0',
    buildId: `sha256:${'a'.repeat(64)}`,
    protocolVersion: 1,
    toolProfiles: ['general', 'code'],
    subagentSchemaVersion: 1,
    instanceId: 'instance-1'
  }
  expect(parseEngineMeta({ code: 200, data }, data.buildId).instanceId).toBe('instance-1')
  expect(() => parseEngineMeta({ code: 200, data }, `sha256:${'b'.repeat(64)}`)).toThrow(
    /构建不一致/
  )
  expect(() => parseEngineMeta({ code: 200, data: { ...data, protocolVersion: 2 } })).toThrow(
    /不兼容/
  )
  expect(() =>
    parseEngineMeta({ code: 200, data: { ...data, toolProfiles: ['general'] } })
  ).toThrow(/不兼容/)
  expect(() => assertEngineHealth({ status: 'ok' })).toThrow()
  expect(() => assertEngineHealth({ code: 200, data: { status: 'ok' } })).not.toThrow()
})

test('普通HTTP与恢复SSE共用实例头和根路径规则', () => {
  expect(engineHeaders('synthetic-token')).toEqual({
    'X-Aether-Tool-Profile': 'code',
    'X-Aether-Instance-Token': 'synthetic-token'
  })
  expect(normalizeEnginePath('/meta')).toBe('/meta')
  expect(normalizeEnginePath('/auth/user')).toBe('/auth/user')
  expect(normalizeEnginePath('/chat/stream')).toBe('/api/v1/chat/stream')
  expect(normalizeEnginePath('/api/v1/tools')).toBe('/api/v1/tools')
})

test('remote 未有共享工作区约定时仅允许元数据读取，不发送本地路径', () => {
  expect(remoteRequestError('remote', 'GET', '/models')).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/chat')).toContain('工作区映射')
  expect(remoteRequestError('remote', 'GET', '/api/v1/workspace/file/content')).toContain('工作区映射')
  expect(remoteRequestError('remote', 'POST', '/changes/revert')).toContain('工作区映射')
  expect(remoteRequestError('embedded', 'POST', '/chat')).toBeNull()
})
