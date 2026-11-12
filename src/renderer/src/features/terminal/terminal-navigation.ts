export type SessionTerminalAction = 'toggle' | 'new'

const listeners = new Set<(action: SessionTerminalAction) => void>()

/** Global terminal commands follow the visible mode rather than opening a hidden Code panel. */
export function requestSessionTerminal(action: SessionTerminalAction): void {
  for (const listener of listeners) listener(action)
}

export function onSessionTerminalRequest(listener: (action: SessionTerminalAction) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
