import { useCallback, useSyncExternalStore } from 'react'
import { patchProjectPreferences, readProjectPreferences, subscribeProjectPreferences, type ProjectPreferences, type ProjectPreferencesChange } from './project-preferences'

export function useProjectPreferences(storageKey: string): readonly [ProjectPreferences, (change: ProjectPreferencesChange) => void] {
  const subscribe = useCallback((listener: () => void) => subscribeProjectPreferences(storageKey, listener), [storageKey])
  const snapshot = useCallback(() => readProjectPreferences(storageKey), [storageKey])
  const preferences = useSyncExternalStore(subscribe, snapshot, snapshot)
  const persist = useCallback((change: ProjectPreferencesChange): void => { patchProjectPreferences(storageKey, change) }, [storageKey])
  return [preferences, persist]
}
