import { useSyncExternalStore } from 'react'

export type AppMode = 'code' | 'work'
const STORAGE_KEY = 'aether.app.mode'
const listeners = new Set<() => void>()
let mode: AppMode = 'code'
try {
  if (localStorage.getItem(STORAGE_KEY) === 'work') mode = 'work'
} catch {
  /* 模式存储不可用时仍可进入默认工作台。 */
}

export function getAppMode(): AppMode {
  return mode
}
export function onAppModeChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function setAppMode(next: AppMode): void {
  if (mode === next) return
  mode = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 本次切换仍然生效。 */
  }
  for (const listener of listeners) listener()
}
export function useAppMode(): AppMode {
  return useSyncExternalStore(onAppModeChanged, getAppMode)
}

/** 隐藏 Code 工作台时，不让全局快捷键修改它的文件、布局或会话。 */
export function isCommandAvailableInMode(id: string): boolean {
  if (id.startsWith('aether.work.')) return mode === 'work'
  return (
    mode === 'code' ||
    id.startsWith('aether.mode.') ||
    id.startsWith('aether.engine.') ||
    [
      'aether.commandPalette.toggle',
      'aether.view.appSettings',
      'aether.view.models',
      'aether.view.security'
    ].includes(id)
  )
}
