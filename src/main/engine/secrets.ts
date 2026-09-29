import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { loadOrCreateEncryptionKey } from './secret-store'

/** Reuse the validated legacy key once; an unreadable existing key is never replaced. */
export function ensureEncryptionKey(): { key: string; encryptedAtRest: boolean } {
  const root = join(app.getPath('userData'), 'engine')
  return loadOrCreateEncryptionKey(
    join(root, 'secrets', 'engine-secrets.json'),
    join(root, 'engine-secrets.json'),
    safeStorage
  )
}
