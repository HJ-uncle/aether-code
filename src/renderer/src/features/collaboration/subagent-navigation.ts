export interface SessionSubagentReveal {
  source: number
  sessionId: string
  childSessionId?: string
  toolCallId: string
  publishedRunId?: string
}

const listeners = new Set<(request: SessionSubagentReveal) => void>()

/** The parent view owns opening the pane, including when it is not mounted yet. */
export function requestSessionSubagent(request: SessionSubagentReveal): void {
  for (const listener of listeners) listener(request)
}

export function onSessionSubagentRequest(listener: (request: SessionSubagentReveal) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
