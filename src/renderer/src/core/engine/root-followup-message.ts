export interface RootFollowupMessage {
  messageId: string
  rootRunId: string
  turnId: string
}

interface MessageIdentity {
  role?: string
  runId?: string
  conversationId?: string
  rootFollowup?: RootFollowupMessage
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192
}

/** Only the engine's consistent delivery envelope identifies a supplement.
 * Body text, ID prefixes and adjacent messages cannot establish its owner. */
export function normalizeRootFollowupMessage(row: { id?: string; role?: string; conversationId?: string; metadata?: unknown }): RootFollowupMessage | undefined {
  if (row.role !== 'user' || !identity(row.id) || !record(row.metadata)) return undefined
  const metadata = row.metadata, delivery = metadata.collaborationDelivery
  if (!record(delivery) || delivery.version !== 1 || delivery.source !== 'user-controller' ||
    !identity(delivery.messageId) || !identity(delivery.rootRunId) || !identity(delivery.recipientInvocationRunId) ||
    metadata.rootRunId !== delivery.rootRunId || metadata.runId !== undefined && metadata.runId !== delivery.rootRunId ||
    !identity(metadata.turnId) || row.conversationId !== undefined && row.conversationId !== metadata.turnId) return undefined
  return { messageId: delivery.messageId, rootRunId: delivery.rootRunId, turnId: metadata.turnId }
}

/** The physical transcript stays segmented; only its display owner is shared. */
export function isRootFollowupFor(message: MessageIdentity, owner: MessageIdentity | undefined): boolean {
  const followup = message.rootFollowup
  return Boolean(message.role === 'user' && followup && owner?.role === 'user' && !owner.rootFollowup &&
    message.runId === followup.rootRunId && message.conversationId === followup.turnId &&
    owner.runId === followup.rootRunId && owner.conversationId === followup.turnId)
}
