/** Pure security contracts: engine diagnostics never expose credentials and
 * the local engine key never falls back to plaintext when OS storage is down. */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadOrCreateEncryptionKey, type SecretEncryption } from '../src/main/engine/secret-store'
import { onEngineLog, redactEngineLogLine } from '../src/main/engine/logger'
import { startProcess } from '../src/main/engine/sdk/process-manager'

const root = resolve(__dirname, '..', '.e2e-tmp')

test('引擎日志会脱敏动态环境凭据和常见认证格式', () => {
  const encryptionKey = 'a'.repeat(64)
  const instanceToken = 'instance-token-for-security-test'
  const line = `ENCRYPTION_KEY=${encryptionKey} AETHER_INSTANCE_TOKEN=${instanceToken} Authorization: Bearer bearer-secret-123456`
  const safe = redactEngineLogLine(line, { ENCRYPTION_KEY: encryptionKey, AETHER_INSTANCE_TOKEN: instanceToken })
  expect(safe).not.toContain(encryptionKey)
  expect(safe).not.toContain(instanceToken)
  expect(safe).not.toContain('bearer-secret-123456')
  expect(safe).toContain('[REDACTED]')
})

test('系统密钥存储不可用时拒绝创建明文引擎密钥', () => {
  const fixture = mkdtempSync(join(root, 'security-storage-'))
  try {
    const target = join(fixture, 'engine', 'secrets', 'engine-secrets.json')
    const legacy = join(fixture, 'engine', 'engine-secrets.json')
    const unavailable: SecretEncryption = {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    }
    expect(() => loadOrCreateEncryptionKey(target, legacy, unavailable)).toThrow(/不会以明文降级/)
    expect(existsSync(target)).toBe(false)

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ encrypted: false, encryptionKey: 'b'.repeat(64) }))
    expect(() => loadOrCreateEncryptionKey(target, legacy, unavailable)).toThrow(/无法读取引擎密钥/)
    expect(readFileSync(target, 'utf8')).toContain('"encrypted":false')
  } finally {
    if (dirname(fixture) !== root) throw new Error('Unsafe security fixture cleanup')
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('已有明文密钥仅在 OS 加密可用时迁移并清除明文字节', () => {
  const fixture = mkdtempSync(join(root, 'security-migrate-'))
  try {
    const target = join(fixture, 'engine', 'secrets', 'engine-secrets.json')
    const legacy = join(fixture, 'engine', 'engine-secrets.json')
    mkdirSync(dirname(target), { recursive: true })
    const key = 'd'.repeat(64)
    writeFileSync(target, JSON.stringify({ encrypted: false, encryptionKey: key }))
    const storage: SecretEncryption = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`encrypted:${value}`),
      decryptString: value => value.toString().slice('encrypted:'.length)
    }
    expect(loadOrCreateEncryptionKey(target, legacy, storage)).toEqual({ key, encryptedAtRest: true })
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('"encrypted":true')
    expect(content).not.toContain(key)
  } finally {
    if (dirname(fixture) !== root) throw new Error('Unsafe security fixture cleanup')
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('实际引擎子进程的 stdout/stderr 转发先完成凭据脱敏', async () => {
  const fixture = mkdtempSync(join(root, 'security-process-'))
  const script = join(fixture, 'emit-secret.cjs')
  const encryptionKey = 'c'.repeat(64)
  const instanceToken = 'instance-token-process-test'
  writeFileSync(script, `process.stdout.write('ENCRYPTION_KEY=' + process.env.ENCRYPTION_KEY + '\\n'); process.stderr.write('AETHER_INSTANCE_TOKEN=' + process.env.AETHER_INSTANCE_TOKEN + '\\n');`)
  const logs: string[] = []
  const off = onEngineLog(entry => logs.push(entry.line))
  let handle: ReturnType<typeof startProcess> | undefined
  try {
    handle = startProcess({ binPath: script, nodePath: process.execPath, port: 12597, env: { ENCRYPTION_KEY: encryptionKey, AETHER_INSTANCE_TOKEN: instanceToken } })
    await new Promise<void>((resolveExit, reject) => {
      handle!.process.once('error', reject)
      handle!.process.once('exit', () => resolveExit())
    })
    await handle.lifecycle.closed
    expect(logs.join('\n')).not.toContain(encryptionKey)
    expect(logs.join('\n')).not.toContain(instanceToken)
    expect(logs.join('\n')).toContain('[REDACTED]')
  } finally {
    off()
    if (handle?.process.exitCode === null && handle.process.signalCode === null) await handle.stop(1000)
    if (dirname(fixture) !== root) throw new Error('Unsafe security fixture cleanup')
    rmSync(fixture, { recursive: true, force: true })
  }
})
