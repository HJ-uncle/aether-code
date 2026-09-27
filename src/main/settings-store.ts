/**
 * 设置持久化
 *
 * 存放于 <userData>/settings.json。刻意保持极简：读一次、写整体、无迁移框架。
 * 引擎侧的模型/密钥等业务配置走引擎自己的 DB，不在这里重复。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/ipc'

let cache: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache

  const file = settingsPath()
  if (!existsSync(file)) {
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
    // 与默认值合并，保证新增字段在老配置文件上也有值
    cache = { ...DEFAULT_SETTINGS, ...raw }
  } catch (err) {
    console.warn('[settings] 解析失败，回退默认设置:', err)
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch }
  cache = next

  const file = settingsPath()
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
