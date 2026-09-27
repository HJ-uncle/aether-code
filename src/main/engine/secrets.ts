/**
 * 引擎加密密钥管理
 *
 * 引擎用 ENCRYPTION_KEY 加密数据库中的敏感字段（各厂商 API Key），
 * 且要求「一旦设置不可更改」，否则历史密文全部无法解密。
 * 因此这里在首次启动时生成一次并永久保留。
 *
 * 存储策略：优先用 Electron safeStorage（走系统钥匙串/DPAPI）加密后落盘；
 * 系统不支持时降级为明文，并在日志中提示 —— 不能因为加密能力缺失就让应用不可用。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const FILE_NAME = 'engine-secrets.json'

interface SecretsFile {
  /** 是否经 safeStorage 加密 */
  encrypted: boolean
  /** base64；encrypted 为 true 时是密文，否则是明文 hex */
  encryptionKey: string
}

function secretsPath(): string {
  return join(app.getPath('userData'), 'engine', FILE_NAME)
}

/**
 * 取得（必要时生成）引擎加密密钥。
 * 返回值直接作为 ENCRYPTION_KEY 注入引擎进程环境。
 */
export function ensureEncryptionKey(): { key: string; encryptedAtRest: boolean } {
  const file = secretsPath()

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as SecretsFile
      if (parsed.encryptionKey) {
        if (parsed.encrypted && safeStorage.isEncryptionAvailable()) {
          return {
            key: safeStorage.decryptString(Buffer.from(parsed.encryptionKey, 'base64')),
            encryptedAtRest: true
          }
        }
        if (!parsed.encrypted) {
          return { key: parsed.encryptionKey, encryptedAtRest: false }
        }
      }
    } catch (err) {
      // 文件损坏时不能静默重新生成 —— 那会让旧密文永久失效。
      // 抛出让上层显式暴露问题，由用户决定是否重置数据。
      throw new Error(
        `引擎密钥文件损坏，无法读取（${file}）。` +
          `若确认要丢弃已加密的模型凭证，请手动删除该文件后重启。原始错误：${
            err instanceof Error ? err.message : String(err)
          }`
      )
    }
  }

  const key = randomBytes(32).toString('hex')
  const canEncrypt = safeStorage.isEncryptionAvailable()

  const payload: SecretsFile = canEncrypt
    ? { encrypted: true, encryptionKey: safeStorage.encryptString(key).toString('base64') }
    : { encrypted: false, encryptionKey: key }

  mkdirSync(join(app.getPath('userData'), 'engine'), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')

  if (!canEncrypt) {
    console.warn('[engine] safeStorage 不可用，ENCRYPTION_KEY 以明文存放于', file)
  }

  return { key, encryptedAtRest: canEncrypt }
}
