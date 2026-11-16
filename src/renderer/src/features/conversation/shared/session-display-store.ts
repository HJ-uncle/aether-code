import { useCallback, useSyncExternalStore } from 'react'
import { getEngineStorageKey, sessionStorageKey, subscribeEngineSource } from '@renderer/core/engine/source'

const STORAGE_KEY = 'aether:sessionThinkingVisibility'
const tables = new Map<string, Record<string, boolean>>()
const listeners = new Set<() => void>()

function tableFor(source: string): Record<string, boolean> {
  const key = sessionStorageKey(STORAGE_KEY, source)
  const cached = tables.get(key)
  if (cached) return cached
  const table = Object.create(null) as Record<string, boolean>
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [sessionId, visible] of Object.entries(parsed)) {
        if (typeof visible === 'boolean') table[sessionId] = visible
      }
    }
  } catch {
    // Historical messages remain readable when local preference storage is unavailable.
  }
  tables.set(key, table)
  return table
}

function changed(): void { for (const listener of listeners) listener() }

function storageChanged(event: StorageEvent): void {
  if (event.key === null) tables.clear()
  else if (event.key === STORAGE_KEY || event.key.startsWith(`${STORAGE_KEY}:`)) tables.delete(event.key)
  else return
  changed()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', storageChanged)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', storageChanged)
  }
}

export function loadSessionThinkingVisible(sessionId: string, source = getEngineStorageKey()): boolean {
  return tableFor(source)[sessionId] === true
}

export function saveSessionThinkingVisible(sessionId: string, visible: boolean, source = getEngineStorageKey()): void {
  const table = tableFor(source)
  if (table[sessionId] === visible) return
  table[sessionId] = visible
  try {
    localStorage.setItem(sessionStorageKey(STORAGE_KEY, source), JSON.stringify(table))
  } catch {
    // The local display choice still updates every mounted message when persistence fails.
  }
  changed()
}

/** Display preference only: hiding reasoning never changes the model's requested effort. */
export function useSessionThinkingVisible(sessionId: string): readonly [boolean, (visible: boolean) => void] {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineStorageKey)
  const read = useCallback(() => loadSessionThinkingVisible(sessionId, source), [sessionId, source])
  const visible = useSyncExternalStore(subscribe, read)
  const save = useCallback((next: boolean) => saveSessionThinkingVisible(sessionId, next, source), [sessionId, source])
  return [visible, save] as const
}
