import { useSyncExternalStore } from 'react'
import { getMemorySettings, setMemoryScope, setSessionMemoryEnabled, getMemoryPreferences, setMemoryPreferences,
  type MemoryScope, type MemoryPreferencesPatch } from './memory'
import { createMemoryScopeStore, createMemoryPreferencesStore, type MemoryScopeState, type MemoryPreferencesState } from './memory-state'
import { getEngineSource, subscribeEngineSource } from './source'

export type { MemoryScopeState, MemoryPreferencesState } from './memory-state'

const store = createMemoryScopeStore({ read: getMemorySettings, write: setMemoryScope, writeSession: setSessionMemoryEnabled })
const preferencesStore = createMemoryPreferencesStore({ read: getMemoryPreferences, write: setMemoryPreferences })
export const getMemoryScopeState = store.getSnapshot
export const onMemoryScopeChanged = store.subscribe
export const refreshMemoryScope = store.refresh
export const changeMemoryScope = store.change
export const changeSessionMemoryEnabled = store.changeSession
export const resetMemoryScopeStore = store.reset
export const getMemoryPreferencesState = preferencesStore.getSnapshot
export const refreshMemoryPreferences = preferencesStore.refresh
export const resetMemoryPreferencesStore = preferencesStore.reset
export async function changeMemoryPreferences(patch: MemoryPreferencesPatch): Promise<void> {
  const source = getEngineSource()
  await preferencesStore.change(patch)
  if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
  const { sessionId, loading } = store.getSnapshot()
  if (sessionId) {
    await store.refresh(sessionId)
    if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
    // A pre-existing GET/PUT may have resolved against the previous defaults.
    if (loading && store.getSnapshot().sessionId === sessionId) await store.refresh(sessionId)
  }
}

// A local and a remote engine can legitimately use the same session ID. Never
// reuse the previous engine's confirmed memory boundary after switching source.
subscribeEngineSource(() => { store.reset(); preferencesStore.reset() })

/** 隐藏旧会话快照，直到新会话的服务端设置确认完成。 */
export function useMemoryScope(sessionId: string): MemoryScopeState & {
  refresh: (sessionId: string) => Promise<void>
  change: (sessionId: string, scope: MemoryScope) => Promise<void>
  changeSession: (sessionId: string, sessionEnabled: boolean | null) => Promise<void>
} {
  const snapshot = useSyncExternalStore(onMemoryScopeChanged, getMemoryScopeState)
  if (snapshot.sessionId !== sessionId) {
    return { sessionId, scope: null, effectiveScope: null, enabled: null, loaded: false, loading: false,
      globalEnabled: null, sessionDefaultEnabled: null, sessionOverride: null, sessionEnabled: null, effectiveScopes: null,
      error: null, refresh: refreshMemoryScope, change: changeMemoryScope, changeSession: changeSessionMemoryEnabled }
  }
  return { ...snapshot, refresh: refreshMemoryScope, change: changeMemoryScope, changeSession: changeSessionMemoryEnabled }
}

export function useMemoryPreferences(): MemoryPreferencesState & {
  refresh: () => Promise<void>
  change: (patch: MemoryPreferencesPatch) => Promise<void>
} {
  const snapshot = useSyncExternalStore(preferencesStore.subscribe, getMemoryPreferencesState)
  return { ...snapshot, refresh: refreshMemoryPreferences, change: changeMemoryPreferences }
}
