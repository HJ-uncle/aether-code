import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AccountUser } from '../../shared/account'

export interface AccountCredential {
  user: AccountUser
  accessToken: string
  refreshToken: string
  expiresAt: string
  recoveryKey?: string
  refreshRequestId?: string
}
interface Entry { credential: AccountCredential | null; persistence: 'encrypted' | 'session' | 'none'; managed: boolean }
const cache = new Map<string, Entry>()
function file(scope: string): string {
  return join(app.getPath('userData'), 'accounts', createHash('sha256').update(scope).digest('hex') + '.json')
}
export function readAccountCredential(scope: string): Entry {
  const cached = cache.get(scope)
  if (cached) return cached
  const path = file(scope)
  let entry: Entry = { credential: null, persistence: 'none', managed: false }
  if (existsSync(path)) {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'))
      if (stored.version !== 1) throw new Error()
      if (stored.signedOut === true) entry = { ...entry, managed: true }
      else {
        if (!safeStorage.isEncryptionAvailable() || stored.encrypted !== true || typeof stored.value !== 'string') throw new Error()
        const credential: AccountCredential = JSON.parse(safeStorage.decryptString(Buffer.from(stored.value, 'base64')))
        if (!validCredential(credential)) throw new Error()
        entry = { credential, persistence: 'encrypted', managed: true }
      }
    } catch { throw new Error('无法解密已保存的账号凭证，请恢复系统密钥存储后重试；原凭证文件已保留。') }
  }
  cache.set(scope, entry)
  return entry
}
export function validCredential(value: unknown): value is AccountCredential {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<AccountCredential>
  return typeof v.accessToken === 'string' && /^[\x21-\x7e]{16,16384}$/.test(v.accessToken) &&
    typeof v.refreshToken === 'string' && /^[\x21-\x7e]{16,16384}$/.test(v.refreshToken) &&
    typeof v.expiresAt === 'string' && Number.isFinite(Date.parse(v.expiresAt)) &&
    validAccountUser(v.user)
}
export function validAccountUser(value: unknown): value is AccountUser {
  if (!value || typeof value !== 'object') return false
  const user = value as Partial<AccountUser>
  const optionalText = (item: unknown): boolean => item === null || typeof item === 'string'
  const data = (item: unknown): boolean => !!item && typeof item === 'object' && !Array.isArray(item)
  return typeof user.id === 'string' && !!user.id && typeof user.tenantId === 'string' && !!user.tenantId &&
    typeof user.name === 'string' && optionalText(user.email) && optionalText(user.avatarUrl) && optionalText(user.bio) &&
    typeof user.createdAt === 'string' && Number.isFinite(Date.parse(user.createdAt)) && data(user.userData) &&
    Array.isArray(user.identities) && user.identities.every(identity => !!identity && typeof identity.providerId === 'string' &&
      typeof identity.subject === 'string' && (identity.userData === undefined || data(identity.userData)))
}
export function saveAccountCredential(scope: string, credential: AccountCredential | null): Entry {
  const path = file(scope)
  const encrypted = safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  const entry: Entry = { credential, persistence: credential ? (encrypted ? 'encrypted' : 'session') : 'none', managed: true }
  // A tombstone prevents a signed-out account falling back to an old environment/API key.
  // Without OS encryption the session stays exclusively in memory.
  const stored = credential && encrypted
    ? { version: 1, encrypted: true, value: safeStorage.encryptString(JSON.stringify(credential)).toString('base64') }
    : { version: 1, signedOut: true }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  cache.set(scope, entry)
  return entry
}
