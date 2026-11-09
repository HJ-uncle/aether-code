export interface WorkSubagentReveal {
  source: number
  sessionId: string
  childSessionId?: string
  toolCallId: string
  publishedRunId?: string
}

const listeners = new Set<(request: WorkSubagentReveal) => void>()

/** The parent view owns opening the pane, including when it is not mounted yet. */
export function requestWorkSubagent(request: WorkSubagentReveal): void {
  for (const listener of listeners) listener(request)
}

export function onWorkSubagentRequest(listener: (request: WorkSubagentReveal) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
