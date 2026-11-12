import { useSyncExternalStore } from 'react'

export type AppMode = 'code' | 'work'
const listeners = new Set<() => void>()
// Work is the sole user-facing workbench. Keep the union type temporarily so
// shared protocol code can be removed independently without widening this diff.
const mode: AppMode = 'work'

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
  // The Code surface was retired before release; old navigation calls are
  // intentionally ignored instead of resurrecting a second workbench.
  if (next !== 'work') return
  for (const listener of listeners) listener()
}
export function useAppMode(): AppMode {
  return useSyncExternalStore(onAppModeChanged, getAppMode)
}

/** Commands now run against the single Work surface. */
export function isCommandAvailableInMode(id: string): boolean {
  if (id.startsWith('aether.work.')) return mode === 'work'
  if (id.startsWith('aether.mode.') || id.startsWith('aether.code.')) return false
  if (/^aether\.(?:workspace|file|explorer|editor|lsp)\./.test(id)) return false
  if (['aether.view.explorer', 'aether.view.sessionHistory', 'aether.view.search', 'aether.view.git',
    'aether.view.chat', 'aether.chat.newSession', 'aether.panel.problems', 'aether.panel.output', 'aether.output.show'].includes(id)) return false
  return true
}
