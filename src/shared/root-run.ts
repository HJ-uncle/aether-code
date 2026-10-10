/** Paired engine root-run v1. Transport completion is independent of execution outcome. */
export type RootRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface RootPending {
  requestId: string
  kind: 'ask' | 'permission'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  pendingAction?: Record<string, unknown>
  description?: string
  question?: string
  options?: unknown[]
  status: 'pending' | 'answered'
  output?: string
}
/** Only safe scalar composer settings are returned by the engine. */
export interface RootRunRequestConfig {
  agentId?: string
  thinkingMode?: boolean | 'low' | 'medium' | 'high'
  subagentModel?: string
  utilityModel?: string
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  memoryScope?: 'off' | 'global' | 'session'
}

/** Keep absence distinct from false, empty strings and empty arrays. */
export function normalizeRootRunRequestConfig(raw: unknown): RootRunRequestConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>, config: RootRunRequestConfig = {}
  for (const key of ['agentId', 'subagentModel', 'utilityModel'] as const) {
    if (typeof value[key] === 'string') config[key] = value[key]
  }
  for (const key of ['skills', 'mcpServers', 'knowledgeBases'] as const) {
    const ids = value[key]
    if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) config[key] = [...ids]
  }
  const thinking = value.thinkingMode
  if (typeof thinking === 'boolean' || thinking === 'low' || thinking === 'medium' || thinking === 'high') config.thinkingMode = thinking
  const scope = value.memoryScope
  if (scope === 'off' || scope === 'global' || scope === 'session') config.memoryScope = scope
  return config
}

export interface RootRunCompaction {
  phase: 'running' | 'succeeded' | 'failed'
  startedAt: number
  finishedAt?: number
  beforeTokens?: number
  afterTokens?: number
  error?: string
}

/** Reject partial or malformed transport status instead of inventing progress. */
export function normalizeRootRunCompaction(raw: unknown): RootRunCompaction | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const phase = value.phase
  if ((phase !== 'running' && phase !== 'succeeded' && phase !== 'failed') ||
    typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) || value.startedAt < 0) return undefined
  const state: RootRunCompaction = { phase, startedAt: value.startedAt }
  for (const key of ['finishedAt', 'beforeTokens', 'afterTokens'] as const) {
    const amount = value[key]
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) state[key] = amount
  }
  if (typeof value.error === 'string') state.error = value.error
  return state
}

export interface RootRun {
  schemaVersion: 1
  runId: string
  sessionId: string
  turnId: string
  userMessageId: string
  assistantMessageId: string
  version: number
  seq: number
  status: RootRunStatus
  modelId?: string
  actualModelId?: string
  requestConfig?: RootRunRequestConfig
  compaction?: RootRunCompaction
  workspacePaths?: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string | { message: string; code?: string }
  stopReason?: string
  pending: RootPending[]
}
