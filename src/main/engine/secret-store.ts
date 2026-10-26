import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  /** Chromium reports `basic_text` on some Windows configurations. */
  getSelectedStorageBackend?: () => string
}

function encryptionAvailable(storage: SecretEncryption): boolean {
  try {
    return storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text'
  } catch {
    return false
  }
}

let windowsOwnerSid: string | null | undefined

/**
 * POSIX mode bits do not restrict ACLs on NTFS.  Use the current user's SID
 * and icacls on Windows so a secret file cannot inherit a broad profile ACL.
 * The result is cached for this process; failure is fail-closed rather than
 * silently claiming that mode 600 provided protection.
 */
function hardenWindowsAcl(file: string): void {
  if (process.platform !== 'win32') return
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  if (windowsOwnerSid === undefined) {
    try {
      const output = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      })
      windowsOwnerSid = output.match(/S-\d-(?:\d+-?)+/i)?.[0] ?? null
    } catch {
      windowsOwnerSid = null
    }
  }
  if (!windowsOwnerSid) throw new Error('无法确定当前 Windows 用户 SID，拒绝保存引擎密钥')
  try {
    execFileSync(join(system32, 'icacls.exe'), [
      file,
      '/inheritance:r',
      // Remove common broad explicit grants as well as inherited grants.
      '/remove:g', '*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11', '*S-1-5-4',
      '/grant:r', `*${windowsOwnerSid}:F`
    ], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']
    })
  } catch {
    throw new Error('无法加固 Windows 引擎密钥文件权限，拒绝继续')
  }
}

function writeSecretFile(file: string, content: string, replace: boolean): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const backup = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.bak`
  let movedOriginal = false
  let preserveBackup = false
  try {
    writeFileSync(temporary, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    if (replace && process.platform === 'win32' && existsSync(file)) {
      // Windows rename does not replace an existing file. Move the original
      // aside first and restore it if installing the encrypted replacement
      // fails; callers never silently lose a usable key.
      renameSync(file, backup)
      movedOriginal = true
      try {
        renameSync(temporary, file)
      } catch (error) {
        try { renameSync(backup, file); movedOriginal = false } catch { preserveBackup = true }
        throw error
      }
    } else {
      renameSync(temporary, file)
    }
    // chmod is effective on POSIX. On Windows the file is encrypted and the
    // explicit owner ACL is installed below; mode 600 is retained for
    // cross-platform callers and tools that inspect the metadata.
    try { chmodSync(file, 0o600) } catch { /* ACLs are managed by the OS on Windows. */ }
    hardenWindowsAcl(file)
  } finally {
    rmSync(temporary, { force: true })
    if (movedOriginal && !preserveBackup) rmSync(backup, { force: true })
  }
}

export function loadOrCreateEncryptionKey(
  file: string,
  legacyFile: string,
  storage: SecretEncryption
): { key: string; encryptedAtRest: boolean } {
  const source = existsSync(file) ? file : existsSync(legacyFile) ? legacyFile : null
  if (source) {
    try {
      // Harden before parsing a legacy plaintext file as well. The migration
      // below removes its cleartext bytes, but must not expose them meanwhile.
      hardenWindowsAcl(source)
      const content = readFileSync(source, 'utf-8')
      const parsed = JSON.parse(content) as { encrypted?: unknown; encryptionKey?: unknown }
      if (typeof parsed.encrypted !== 'boolean' || typeof parsed.encryptionKey !== 'string') {
        throw new Error('密钥文件格式无效')
      }
      const encryptedStorageAvailable = encryptionAvailable(storage)
      if (parsed.encrypted && !encryptedStorageAvailable) {
        throw new Error('系统密钥存储暂不可用')
      }
      if (!parsed.encrypted && !encryptedStorageAvailable) {
        // A plaintext engine key is equivalent to the database encryption key
        // being public. Never continue on Windows/basic_text or write another
        // plaintext copy when the OS keychain is unavailable.
        throw new Error('系统密钥存储暂不可用，无法读取未加密引擎密钥')
      }
      const key = parsed.encrypted
        ? storage.decryptString(Buffer.from(parsed.encryptionKey, 'base64'))
        : parsed.encryptionKey
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('密钥长度或格式无效')
      if (parsed.encrypted) {
        if (source !== file) writeSecretFile(file, content, false)
      } else {
        // Repair a legacy plaintext file in place before copying it to the
        // current location, so no plaintext duplicate remains on disk.
        const encryptedContent = JSON.stringify({ encrypted: true, encryptionKey: storage.encryptString(key).toString('base64') })
        writeSecretFile(source, encryptedContent, true)
        if (source !== file) writeSecretFile(file, encryptedContent, false)
      }
      return { key, encryptedAtRest: true }
    } catch {
      throw new Error(
        `无法读取引擎密钥（${source}），原文件已保留。请恢复系统密钥存储或显式重置开发数据。`
      )
    }
  }

  const key = randomBytes(32).toString('hex')
  if (!encryptionAvailable(storage)) {
    throw new Error('系统密钥存储暂不可用，无法保存引擎密钥；不会以明文降级')
  }
  const payload = { encrypted: true, encryptionKey: storage.encryptString(key).toString('base64') }
  writeSecretFile(file, JSON.stringify(payload, null, 2), false)
  return { key, encryptedAtRest: true }
}
