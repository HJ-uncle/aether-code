import type { ChatMessage } from '@renderer/core/engine/useChat'

export interface SubagentControllerScope { source: number; sessionId: string; rootRunId: string }

/** A card belongs to its containing message's root, never the newest root in
 * the composer. Old child work can remain active after its parent finishes. */
export function subagentControllerScope(message: Pick<ChatMessage, 'run' | 'runId'>, sessionId: string, source: number | undefined): SubagentControllerScope | undefined {
  const run = message.run
  if (source === undefined || !run || !run.runId || run.sessionId !== sessionId || (message.runId !== undefined && message.runId !== run.runId)) return undefined
  return { source, sessionId, rootRunId: run.runId }
}
