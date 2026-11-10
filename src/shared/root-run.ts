/** Paired engine root-run v1. Transport completion is independent of execution outcome. */
export type RootRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface RootRunActivity {
  phase: 'executing' | 'waiting_children'
  groups: Array<{ id: string; label: string; state: 'waiting' | 'ready' | 'consumed' | 'blocked'; total: number; settled: number; failed: number }>
}

/** Match the engine's bounded progress contract; never turn malformed counts into progress. */
export function normalizeRootRunActivity(raw: unknown): RootRunActivity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as RootRunActivity
  if (!['executing', 'waiting_children'].includes(value.phase) || !Array.isArray(value.groups) || value.groups.length > 32) return undefined
  const ids = new Set<string>(), groups: RootRunActivity['groups'] = []
  for (const group of value.groups) {
    if (!group || typeof group.id !== 'string' || !group.id.trim() || group.id.length > 240 || ids.has(group.id)
      || typeof group.label !== 'string' || !group.label.trim() || group.label.length > 240
      || !['waiting', 'ready', 'consumed', 'blocked'].includes(group.state)
      || ![group.total, group.settled, group.failed].every(count => Number.isSafeInteger(count) && count >= 0)
      || group.total < 1 || group.settled > group.total || group.failed > group.settled) return undefined
    ids.add(group.id)
    groups.push({ id: group.id, label: group.label, state: group.state, total: group.total, settled: group.settled, failed: group.failed })
  }
  return value.phase === 'waiting_children' && !groups.length ? undefined : { phase: value.phase, groups }
}
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
  cronJobId?: string
  automationRunId?: string
  cronTimeoutSeconds?: number
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
  for (const key of ['agentId', 'subagentModel', 'utilityModel', 'cronJobId', 'automationRunId'] as const) {
    if (typeof value[key] === 'string') config[key] = value[key]
  }
  for (const key of ['skills', 'mcpServers', 'knowledgeBases'] as const) {
    const ids = value[key]
    if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) config[key] = [...ids]
  }
  const thinking = value.thinkingMode
  const timeout = value.cronTimeoutSeconds
  if (typeof timeout === 'number' && Number.isSafeInteger(timeout) && timeout > 0) config.cronTimeoutSeconds = timeout
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
  activity?: RootRunActivity
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
