import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateRemoteInstanceToken } from './protocol'

const TOKEN_FILE = 'remote-instance-token.json'

interface StoredRemoteToken {
  version: 1
  encrypted: true
  value: string
}

function tokenPath(): string {
  return join(app.getPath('userData'), 'engine', 'secrets', TOKEN_FILE)
}

/** Read the token only in the main process. The renderer receives presence, never this value. */
export function getRemoteInstanceToken(): string {
  const file = tokenPath()
  if (!existsSync(file)) return ''
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredRemoteToken>
    if (stored.version !== 1 || stored.encrypted !== true || typeof stored.value !== 'string') {
      throw new Error('远端令牌文件格式无效')
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，无法读取远端令牌')
    const token = safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
    return validateRemoteInstanceToken(token)
  } catch (error) {
    if (error instanceof Error && /远端令牌|系统密钥/.test(error.message)) throw error
    throw new Error('无法读取远端令牌，原文件已保留。请恢复系统密钥存储或清除令牌文件。')
  }
}

export function remoteInstanceTokenConfigured(): boolean {
  return Boolean(getRemoteInstanceToken())
}

/** Empty input clears the credential. Non-empty input is encrypted with OS-backed safeStorage. */
export function setRemoteInstanceToken(value: string): { configured: boolean } {
  const token = validateRemoteInstanceToken(value)
  const file = tokenPath()
  if (!token) {
    if (existsSync(file)) rmSync(file, { force: true })
    return { configured: false }
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，无法保存远端令牌')
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const stored: StoredRemoteToken = {
    version: 1,
    encrypted: true,
    value: safeStorage.encryptString(token).toString('base64')
  }
  try {
    writeFileSync(temporary, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    try { if (existsSync(temporary)) rmSync(temporary, { force: true }) } catch { /* preserve the original write error */ }
    throw error
  }
  return { configured: true }
}

export function clearRemoteInstanceToken(): { configured: boolean } {
  return setRemoteInstanceToken('')
}

/** Synchronous main-process save: preserve encrypted bytes if ordinary settings cannot persist. */
export function withRemoteInstanceTokenChange<T>(token: string, saveSettings: () => T): T {
  const file = tokenPath()
  const previous = existsSync(file) ? readFileSync(file) : null
  setRemoteInstanceToken(token)
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
