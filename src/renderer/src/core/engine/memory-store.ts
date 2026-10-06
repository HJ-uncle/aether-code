import { useSyncExternalStore } from 'react'
import { getMemorySettings, setMemoryScope, type MemoryScope } from './memory'
import { createMemoryScopeStore, type MemoryScopeState } from './memory-state'
import { subscribeEngineSource } from './source'

export type { MemoryScopeState } from './memory-state'

const store = createMemoryScopeStore({ read: getMemorySettings, write: setMemoryScope })
export const getMemoryScopeState = store.getSnapshot
export const onMemoryScopeChanged = store.subscribe
export const refreshMemoryScope = store.refresh
export const changeMemoryScope = store.change
export const resetMemoryScopeStore = store.reset

// A local and a remote engine can legitimately use the same session ID. Never
// reuse the previous engine's confirmed memory boundary after switching source.
subscribeEngineSource(() => store.reset())

/** 隐藏旧会话快照，直到新会话的服务端设置确认完成。 */
export function useMemoryScope(sessionId: string): MemoryScopeState & {
  refresh: (sessionId: string) => Promise<void>
  change: (sessionId: string, scope: MemoryScope) => Promise<void>
} {
  const snapshot = useSyncExternalStore(onMemoryScopeChanged, getMemoryScopeState)
  if (snapshot.sessionId !== sessionId) {
    return { sessionId, scope: null, effectiveScope: null, enabled: null, loaded: false, loading: false,
      error: null, refresh: refreshMemoryScope, change: changeMemoryScope }
  }
  return { ...snapshot, refresh: refreshMemoryScope, change: changeMemoryScope }
}
