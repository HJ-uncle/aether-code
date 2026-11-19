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
import { remoteServiceUrl } from '../shared/remote-service-url'

// Only the current service's resolved path is exposed through AppSettings/IPC.
// The directory table and public preferences share one atomic settings.json replacement.
let workspaceRoots = new Map<string, string>()
let cache: AppSettings | null = null
const defaults: AppSettings = {
  ...DEFAULT_SETTINGS,
  graphicsMode: defaultGraphicsMode(process.platform)
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function serviceKey(value: unknown): string {
  try { return typeof value === 'string' ? remoteServiceUrl(value) : '' } catch { return '' }
}
function storedRoots(value: unknown, legacy?: { url: unknown; root: unknown }): Map<string, string> {
  const result = new Map<string, string>()
  const insert = (url: unknown, path: unknown): void => {
    const key = serviceKey(url)
    if (!key) return
    try {
      const root = validateRemoteWorkspaceRoot(path)
      if (root) result.set(key, root)
    } catch { /* Do not route invalid saved paths to a service. */ }
  }
  if (legacy) insert(legacy.url, legacy.root)
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [url, path] of Object.entries(value)) insert(url, path)
  }
  return result
}

/** A full settings object from an old renderer carries the previous service's root.
 * Treat it as an edit only when the saved service still matches; switching restores the destination. */
export function workspaceRootForConnection(mode: AppSettings['engineMode'], url: string, override?: string): string {
  const saved = getSettings(), key = serviceKey(url)
  if (mode !== 'remote' || !key) return ''
  if (override !== undefined && saved.engineMode === 'remote' && serviceKey(saved.remoteBaseUrl) === key) {
    return validateRemoteWorkspaceRoot(override)
  }
  return workspaceRoots.get(key) ?? ''
}

export function getSettings(): AppSettings {
  if (cache) return cache

  const file = settingsPath()
  if (!existsSync(file)) {
    cache = { ...defaults }
    return cache
  }

  try {
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings> & { remoteWorkspaceRoots?: unknown }
    const { remoteWorkspaceRoots, remoteWorkspaceRoot, ...raw } = stored
    // Migrate the old scalar only to the service saved alongside it, never the next draft.
    const legacy = Object.hasOwn(stored, 'remoteWorkspaceRoots') ? undefined : { url: raw.remoteBaseUrl, root: remoteWorkspaceRoot }
    workspaceRoots = storedRoots(remoteWorkspaceRoots, legacy)
    cache = { ...defaults, ...raw, remoteWorkspaceRoot: raw.engineMode === 'remote' ? workspaceRoots.get(serviceKey(raw.remoteBaseUrl)) ?? '' : '' }
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
  const current = getSettings(), next = { ...current, ...patch, remoteWorkspaceRoot: current.remoteWorkspaceRoot }
  let nextRoots = workspaceRoots
  if (next.engineMode !== current.engineMode || next.remoteBaseUrl !== current.remoteBaseUrl || patch.remoteWorkspaceRoot !== undefined) {
    next.remoteWorkspaceRoot = workspaceRootForConnection(next.engineMode, next.remoteBaseUrl, patch.remoteWorkspaceRoot)
    const key = next.engineMode === 'remote' ? serviceKey(next.remoteBaseUrl) : ''
    if (key && next.remoteWorkspaceRoot !== (workspaceRoots.get(key) ?? '')) {
      nextRoots = new Map(workspaceRoots)
      if (next.remoteWorkspaceRoot) nextRoots.set(key, next.remoteWorkspaceRoot)
      else nextRoots.delete(key)
    }
  }
  const file = settingsPath()
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    // The active scalar is a projection, not a second persistent source of truth.
    const stored = { ...next, remoteWorkspaceRoot: undefined, remoteWorkspaceRoots: Object.fromEntries(nextRoots) }
    writeFileSync(temporary, JSON.stringify(stored, null, 2), 'utf-8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* preserve write failure */
    }
    throw error
  }
  workspaceRoots = nextRoots
  cache = next
  return next
}
