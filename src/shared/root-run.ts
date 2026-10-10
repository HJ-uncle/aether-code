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
  workspacePaths?: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string | { message: string; code?: string }
  stopReason?: string
  pending: RootPending[]
}
