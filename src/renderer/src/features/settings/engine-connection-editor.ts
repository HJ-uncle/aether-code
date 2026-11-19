import { useSyncExternalStore } from 'react'
import type { EngineMode } from '@shared/ipc'

export interface ConnectionDraft {
  mode?: EngineMode
  port?: string
  address?: string
  autoStart?: boolean
}
type Operation = 'apply' | 'stop' | 'restart'
interface EditorState { draft: ConnectionDraft; operation: Operation | null; error: string }
let state: EditorState = { draft: {}, operation: null, error: '' }
let generation = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const publish = (patch: Partial<EditorState>): void => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

// The settings tabs unmount their bodies. Keep only non-secret draft fields in
// this renderer while the dialog is open. Passwords live in the page component.
export const connectionEditor = {
  edit(patch: ConnectionDraft): void { publish({ draft: { ...state.draft, ...patch }, error: '' }) },
  clearDraft(): void { publish({ draft: {}, error: '' }) },
  begin(operation: Operation): number | null {
    // An explicit stop can cancel a preflight or a restart before it publishes.
    if (state.operation && !(operation === 'stop' && state.operation !== 'stop')) return null
    const id = ++generation
    publish({ operation, error: '' })
    return id
  },
  current(id: number): boolean { return id === generation },
  finish(id: number, error = ''): void { if (id === generation) publish({ operation: null, error }) }
}
export function useConnectionEditor(): EditorState {
  return useSyncExternalStore(subscribe, () => state)
}
