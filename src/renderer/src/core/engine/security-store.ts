import { useSyncExternalStore } from 'react'
import { getSecurityMode, setSecurityMode } from './security'
import { createSecurityModeStore, type SecurityModeState } from './security-state'

export type { SecurityModeState } from './security-state'

const store = createSecurityModeStore({ read: getSecurityMode, write: setSecurityMode })
export const getSecurityModeState = store.getSnapshot
export const onSecurityModeChanged = store.subscribe
export const refreshSecurityMode = store.refresh
export const changeSecurityMode = store.change
export const resetSecurityModeStore = store.reset

/** Hide an old session synchronously, before the new session's effect starts its request. */
export function useSecurityMode(sessionId: string): SecurityModeState & {
  refresh: (sessionId: string) => Promise<void>
} {
  const snapshot = useSyncExternalStore(onSecurityModeChanged, getSecurityModeState)
  if (snapshot.sessionId !== sessionId) {
    return { sessionId, mode: null, loaded: false, loading: false, error: null, refresh: refreshSecurityMode }
  }
  return { ...snapshot, refresh: refreshSecurityMode }
}
