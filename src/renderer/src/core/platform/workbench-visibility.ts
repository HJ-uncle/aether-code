import { useSyncExternalStore } from 'react'
import { createWorkbenchVisibility } from './visibility-state'

let shared: ReturnType<typeof createWorkbenchVisibility> | undefined
function store(): ReturnType<typeof createWorkbenchVisibility> {
  return shared ??= createWorkbenchVisibility({
    hidden: () => document.hidden,
    onDocument: listener => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
    readNative: () => window.aether.window.getVisibility(),
    onNative: listener => window.aether.window.onVisibility(listener)
  })
}
export function getWorkbenchVisible(): boolean { return store().getSnapshot() }
export function onWorkbenchVisibility(listener: () => void): () => void { return store().subscribe(listener) }
export function useWorkbenchVisible(): boolean {
  return useSyncExternalStore(onWorkbenchVisibility, getWorkbenchVisible, () => false)
}
