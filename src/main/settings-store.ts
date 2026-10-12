/**
 * 设置持久化
 *
 * 存放于 <userData>/settings.json。刻意保持极简：读一次、写整体、无迁移框架。
 * 引擎侧的模型/密钥等业务配置走引擎自己的 DB，不在这里重复。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/ipc'
import { normalizeAccentHex } from '../shared/accent-color'
import { defaultGraphicsMode, isGraphicsMode, isVisualEffects } from '../shared/graphics'
import { validateRemoteWorkspaceRoot } from './engine/remote-workspace'

let cache: AppSettings | null = null
const defaults: AppSettings = {
  ...DEFAULT_SETTINGS,
  graphicsMode: defaultGraphicsMode(process.platform)
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache

  const file = settingsPath()
  if (!existsSync(file)) {
    cache = { ...defaults }
    return cache
  }

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
    // 与默认值合并，保证新增字段在老配置文件上也有值
    cache = { ...defaults, ...raw }
    cache.customAccentColor =
      normalizeAccentHex(raw.customAccentColor) ?? DEFAULT_SETTINGS.customAccentColor
    cache.graphicsMode = isGraphicsMode(raw.graphicsMode) ? raw.graphicsMode : defaults.graphicsMode
    cache.visualEffects = isVisualEffects(raw.visualEffects)
      ? raw.visualEffects
      : DEFAULT_SETTINGS.visualEffects
  } catch (err) {
    console.warn('[settings] 解析失败，回退默认设置:', err)
    cache = { ...defaults }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.graphicsMode !== undefined && !isGraphicsMode(patch.graphicsMode))
    throw new Error('无效的图形加速设置')
  if (patch.visualEffects !== undefined && !isVisualEffects(patch.visualEffects))
    throw new Error('无效的视觉效果设置')
  if (patch.customAccentColor !== undefined) {
    const color = normalizeAccentHex(patch.customAccentColor)
    if (!color) throw new Error('自定义强调色需要使用 #RGB 或 #RRGGBB 格式')
    patch = { ...patch, customAccentColor: color }
  }
  if (patch.remoteWorkspaceRoot !== undefined) {
    patch = {
      ...patch,
      remoteWorkspaceRoot: validateRemoteWorkspaceRoot(patch.remoteWorkspaceRoot)
    }
  }
  const next: AppSettings = { ...getSettings(), ...patch }
  const file = settingsPath()
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf-8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* preserve write failure */
    }
    throw error
  }
  cache = next
  return next
}
