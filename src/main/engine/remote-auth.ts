import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RemoteAuthCredential, RemoteAuthStatus } from '../../shared/ipc'
import { remoteAuthTarget, validateRemoteAuth } from './remote-auth-contract'

function credentialPath(url: string): string {
  const target = remoteAuthTarget(url)
  return join(app.getPath('userData'), 'engine', 'secrets', `remote-auth-${createHash('sha256').update(target).digest('hex')}.json`)
}

/** Credentials are bound to the exact service, so changing the URL cannot leak them. */
export function getRemoteAuth(url: string): { credential: RemoteAuthCredential | null; source: RemoteAuthStatus['source'] } {
  const file = credentialPath(url)
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      if (stored.version !== 1 || stored.encrypted !== true || typeof stored.value !== 'string') throw new Error()
      if (!safeStorage.isEncryptionAvailable()) throw new Error()
      const credential = validateRemoteAuth(JSON.parse(safeStorage.decryptString(Buffer.from(stored.value, 'base64'))))
      return { credential, source: 'stored' }
    } catch {
      throw new Error('无法读取远端用户凭据，请重新输入或清除；原文件已保留。')
    }
  }
  // Environment credentials also need a destination; a later URL edit must not
  // send the operator's API key to an unrelated engine.
  const target = process.env.AETHER_IDE_REMOTE_AUTH_URL
  if (target && remoteAuthTarget(target) === remoteAuthTarget(url)) {
    const apiKey = process.env.AETHER_IDE_REMOTE_API_KEY
    const bearer = process.env.AETHER_IDE_REMOTE_BEARER_TOKEN
    if (apiKey || bearer) return {
      credential: validateRemoteAuth({ type: apiKey ? 'api-key' : 'bearer', value: apiKey || bearer }), source: 'environment'
    }
  }
  return { credential: null, source: 'none' }
}

export function remoteAuthStatus(url: string): RemoteAuthStatus {
  if (!url.trim()) return { configured: false, type: null, source: 'none' }
  const { credential, source } = getRemoteAuth(url)
  return { configured: !!credential, type: credential?.type ?? null, source }
}

/** Roll back encrypted bytes when the combined connection-settings save fails. */
export function withRemoteAuthChange<T>(url: string, value: RemoteAuthCredential | null | undefined, save: () => T): T {
  if (value === undefined) return save()
  const credential = value === null ? null : validateRemoteAuth(value)
  const file = credentialPath(url)
  const previous = existsSync(file) ? readFileSync(file) : null
  const temporary = `${file}.${process.pid}.tmp`
  try {
    if (credential) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，无法保存用户凭据')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ version: 1, encrypted: true, value: safeStorage.encryptString(JSON.stringify(credential)).toString('base64') }), { mode: 0o600 })
      renameSync(temporary, file)
    } else rmSync(file, { force: true })
    try { return save() } catch (error) {
      if (previous === null) rmSync(file, { force: true })
      else { writeFileSync(temporary, previous, { mode: 0o600 }); renameSync(temporary, file) }
      throw error
    }
  } finally { rmSync(temporary, { force: true }) }
}
