export type WorkTerminalAction = 'toggle' | 'new'

const listeners = new Set<(action: WorkTerminalAction) => void>()

/** Global terminal commands follow the visible mode rather than opening a hidden Code panel. */
export function requestWorkTerminal(action: WorkTerminalAction): void {
  for (const listener of listeners) listener(action)
}

export function onWorkTerminalRequest(listener: (action: WorkTerminalAction) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
