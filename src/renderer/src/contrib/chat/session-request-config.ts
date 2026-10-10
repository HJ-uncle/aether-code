import { normalizeRootRunRequestConfig, type RootRunRequestConfig } from '../../../../shared/root-run'
import type { SessionThinkingMode } from './session-thinking-store'

export type ComposerThinkingMode = SessionThinkingMode | 'medium' | 'on'
export interface SessionRequestSelection {
  anchorRunId?: string
  config: RootRunRequestConfig
  /** Explicit Auto must remove a previous server thinking tier after a reload. */
  omitThinkingMode?: boolean
}
const key = (sessionId: string, source: string): string => 'aether:session-request:' + (source || 'embedded') + ':' + sessionId

export function loadSessionRequestSelection(sessionId: string, source: string): SessionRequestSelection | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(sessionId, source)) || 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.anchorRunId !== undefined && typeof record.anchorRunId !== 'string') return null
    const config = normalizeRootRunRequestConfig(record.config)
    return config ? { anchorRunId: record.anchorRunId as string | undefined, config, omitThinkingMode: record.omitThinkingMode === true } : null
  } catch { return null }
}
export function saveSessionRequestSelection(sessionId: string, source: string, selection: SessionRequestSelection): void {
  if (!sessionId) return
  try { localStorage.setItem(key(sessionId, source), JSON.stringify(selection)) } catch { /* In-memory choices still work. */ }
}

/** A new external run supersedes unsent local choices anchored to an older run. */
export function resolveSessionRequestConfig(input: {
  serverConfig?: RootRunRequestConfig
  runId?: string
  selection?: SessionRequestSelection | null
  fallbackConfig: RootRunRequestConfig
}): RootRunRequestConfig {
  const base = input.serverConfig ?? input.fallbackConfig
  const overrides = input.selection?.anchorRunId === input.runId ? input.selection?.config : undefined
  const result = { ...base, ...overrides }
  if (input.selection?.anchorRunId === input.runId && input.selection?.omitThinkingMode) delete result.thinkingMode
  return result
}

export function requestedThinkingMode(mode: SessionThinkingMode): RootRunRequestConfig['thinkingMode'] {
  return mode === 'off' ? false : mode === 'high' ? undefined : mode === 'max' ? 'high' : 'low'
}
export function composerThinkingMode(value: RootRunRequestConfig['thinkingMode']): ComposerThinkingMode {
  return value === false ? 'off' : value === true ? 'on' : value === 'high' ? 'max' : value === 'medium' ? 'medium' : value === 'low' ? 'low' : 'high'
}
