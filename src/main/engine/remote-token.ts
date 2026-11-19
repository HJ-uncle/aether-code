import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateRemoteInstanceToken } from './protocol'
import { remoteAuthTarget } from './remote-auth-contract'

interface StoredRemoteToken {
  version: 2
  target: string | null
  encrypted: true
  value: string
}

let initialized = false
let environmentTarget = ''
let environmentToken = ''
// If an old file could not be read or bound, changing its only known address
// would allow a later launch to misattribute it. Other settings remain usable.
let unresolvedLegacyTarget: string | undefined
export function assertRemoteTokenTargetChange(url: string): void {
  if (unresolvedLegacyTarget !== undefined && normalizedTarget(url) !== unresolvedLegacyTarget)
    throw new Error('旧实例令牌无法安全绑定。请先恢复配置目录的读写权限并重新启动，再更换服务地址。')
}

function secretsDirectory(): string { return join(app.getPath('userData'), 'engine', 'secrets') }
function tokenPath(url: string): string {
  return join(secretsDirectory(), `remote-instance-token-${createHash('sha256').update(remoteAuthTarget(url)).digest('hex')}.json`)
}
function normalizedTarget(value: string): string {
  try { return value.trim() ? remoteAuthTarget(value) : '' } catch { return '' }
}
function writeStored(file: string, stored: StoredRemoteToken): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

/** Capture startup authority before settings can change; callers must never pass a draft URL. */
export function initializeRemoteInstanceTokens(startupSavedUrl: string): void {
  if (initialized) return
  initialized = true
  const savedTarget = normalizedTarget(startupSavedUrl)
  environmentToken = process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN?.trim() ?? ''
  if (environmentToken) {
    const explicit = process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN_URL
    if (explicit !== undefined) environmentTarget = normalizedTarget(explicit)
    else {
      // Without an explicit URL, pin this installation's environment fallback across
      // restarts. Store only an address, never the token or its fingerprint.
      const binding = join(secretsDirectory(), 'environment-instance-target.json')
      try {
        if (!existsSync(binding)) {
          mkdirSync(dirname(binding), { recursive: true })
          writeFileSync(binding, JSON.stringify({ target: savedTarget || null }), { flag: 'wx', mode: 0o600 })
        }
        const pin = JSON.parse(readFileSync(binding, 'utf8')) as { target?: unknown }
        if (typeof pin?.target === 'string' && normalizedTarget(pin.target) === pin.target) environmentTarget = pin.target
      } catch { /* An unreadable/unbound pin is never inferred from a later destination. */ }
    }
  }

  const legacyFile = join(secretsDirectory(), 'remote-instance-token.json')
  if (!existsSync(legacyFile)) return
  unresolvedLegacyTarget = savedTarget
  const bytes = readFileSync(legacyFile, 'utf8')
  type Legacy = { version?: number; target?: unknown; encrypted?: unknown; value?: unknown }
  let stored: Legacy
  try { stored = JSON.parse(bytes) } catch { stored = {} }
  if (!stored || (stored.version !== 1 && stored.version !== 2) || stored.encrypted !== true || typeof stored.value !== 'string') {
    // Invalid data cannot be migrated on a future launch. Leave it untouched for recovery.
    unresolvedLegacyTarget = undefined
    throw new Error('远端令牌文件格式无效，原文件已保留。')
  }
  // Persist the old destination first. Even a crash during migration must not
  // rebind this credential to a subsequently saved address on the next launch.
  if (stored.version === 2) unresolvedLegacyTarget = undefined
  const target = stored.version === 1 ? savedTarget || null : stored.target
  if (target !== null && (typeof target !== 'string' || normalizedTarget(target) !== target)) {
    throw new Error('远端令牌绑定地址无效，原文件已保留。')
  }
  const bound: StoredRemoteToken = { version: 2, target, encrypted: true, value: stored.value }
  if (stored.version === 1) writeStored(legacyFile, bound)
  unresolvedLegacyTarget = undefined
  // Unbound legacy bytes remain recoverable but can never follow a new URL.
  if (!target) return
  const destination = tokenPath(target)
  if (!existsSync(destination)) writeStored(destination, bound)
  rmSync(legacyFile)
}

/** Read the token only in the main process. No legacy or environment fallback occurs here. */
export function getRemoteInstanceToken(url: string): string {
  const target = remoteAuthTarget(url), file = tokenPath(target)
  if (!existsSync(file)) return ''
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredRemoteToken>
    if (stored.version !== 2 || stored.target !== target || stored.encrypted !== true || typeof stored.value !== 'string') {
      throw new Error('远端令牌文件格式或绑定地址无效')
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，无法读取远端令牌')
    const token = safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
    return validateRemoteInstanceToken(token)
  } catch (error) {
    if (error instanceof Error && /远端令牌|系统密钥/.test(error.message)) throw error
    throw new Error('无法读取远端令牌，原文件已保留。请恢复系统密钥存储或清除令牌文件。')
  }
}

export function getEnvironmentRemoteInstanceToken(url: string): string {
  if (!initialized || !environmentTarget || remoteAuthTarget(url) !== environmentTarget) return ''
  return validateRemoteInstanceToken(environmentToken)
}

export function remoteInstanceTokenConfigured(url: string): boolean {
  return Boolean(getRemoteInstanceToken(url))
}

/** Empty input clears the credential. Non-empty input is encrypted with OS-backed safeStorage. */
export function setRemoteInstanceToken(url: string, value: string): { configured: boolean } {
  const target = remoteAuthTarget(url), token = validateRemoteInstanceToken(value), file = tokenPath(target)
  if (!token) {
    if (existsSync(file)) rmSync(file, { force: true })
    return { configured: false }
  }
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('系统密钥存储暂不可用，无法保存远端令牌')
  }
  writeStored(file, { version: 2, target, encrypted: true, value: safeStorage.encryptString(token).toString('base64') })
  return { configured: true }
}

export function clearRemoteInstanceToken(url: string): { configured: boolean } {
  return setRemoteInstanceToken(url, '')
}

/** Synchronous main-process save: preserve encrypted bytes if ordinary settings cannot persist. */
export function withRemoteInstanceTokenChange<T>(url: string, token: string, saveSettings: () => T): T {
  const file = tokenPath(url)
  const previous = existsSync(file) ? readFileSync(file) : null
  setRemoteInstanceToken(url, token)
  try {
    return saveSettings()
  } catch (error) {
    if (previous === null) rmSync(file, { force: true })
    else {
      const temporary = `${file}.${process.pid}.rollback.tmp`
      try {
        writeFileSync(temporary, previous, { mode: 0o600 })
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    throw error
  }
}
