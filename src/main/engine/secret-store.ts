import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export function loadOrCreateEncryptionKey(
  file: string,
  legacyFile: string,
  storage: SecretEncryption
): { key: string; encryptedAtRest: boolean } {
  const source = existsSync(file) ? file : existsSync(legacyFile) ? legacyFile : null
  if (source) {
    try {
      const content = readFileSync(source, 'utf-8')
      const parsed = JSON.parse(content) as { encrypted?: unknown; encryptionKey?: unknown }
      if (typeof parsed.encrypted !== 'boolean' || typeof parsed.encryptionKey !== 'string') {
        throw new Error('密钥文件格式无效')
      }
      if (parsed.encrypted && !storage.isEncryptionAvailable()) {
        throw new Error('系统密钥存储暂不可用')
      }
      const key = parsed.encrypted
        ? storage.decryptString(Buffer.from(parsed.encryptionKey, 'base64'))
        : parsed.encryptionKey
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('密钥长度或格式无效')
      if (source !== file) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
      }
      return { key, encryptedAtRest: parsed.encrypted }
    } catch {
      throw new Error(
        `无法读取引擎密钥（${source}），原文件已保留。请恢复系统密钥存储或显式重置开发数据。`
      )
    }
  }

  const key = randomBytes(32).toString('hex')
  const encryptedAtRest = storage.isEncryptionAvailable()
  const payload = encryptedAtRest
    ? { encrypted: true, encryptionKey: storage.encryptString(key).toString('base64') }
    : { encrypted: false, encryptionKey: key }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 2), {
    encoding: 'utf-8',
    flag: 'wx',
    mode: 0o600
  })
  return { key, encryptedAtRest }
}
