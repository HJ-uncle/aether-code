/** Input observations are snapshots; none of these fields are billing increments. */
export interface ConfirmedContextInput {
  used: number
  contextWindow?: number
  modelId?: string
}

export function readConfirmedContext(value: unknown): ConfirmedContextInput | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.used !== 'number' || !Number.isFinite(raw.used) || raw.used < 0) return undefined
  return { used: raw.used,
    ...(typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0 ? { contextWindow: raw.contextWindow } : {}),
    ...(typeof raw.modelId === 'string' && raw.modelId ? { modelId: raw.modelId } : {}) }
}

export function retainConfirmedContext(previous: unknown, incoming: Record<string, unknown>, owner: { modelId?: string; estimated?: boolean }): ConfirmedContextInput | undefined {
  const prior = previous && typeof previous === 'object' ? readConfirmedContext((previous as Record<string, unknown>).confirmedContext) : undefined
  const supplied = readConfirmedContext(incoming.confirmedContext)
  const input = incoming.currentPromptTokens ?? (incoming.usageScope !== 'turn' ? incoming.promptTokens : undefined)
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0 && owner.estimated === false && incoming.contextUsageProvisional !== true) {
    return readConfirmedContext({ used: input, contextWindow: incoming.contextWindow, modelId: owner.modelId })
  }
  return supplied ?? prior
}
