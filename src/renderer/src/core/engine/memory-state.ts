import type { MemoryScope, MemorySettings } from './memory'

export interface MemoryScopeState {
  sessionId: string
  scope: MemoryScope | null
  effectiveScope: MemoryScope | null
  enabled: boolean | null
  loading: boolean
  error: string | null
  loaded: boolean
}

interface MemoryScopeTransport {
  read(sessionId: string): Promise<MemorySettings>
  write(sessionId: string, scope: MemoryScope): Promise<MemorySettings>
}

const emptyState = (): MemoryScopeState => ({
  sessionId: '', scope: null, effectiveScope: null, enabled: null,
  loading: false, error: null, loaded: false
})

/**
 * 会话切换时先清空旧快照，且丢弃迟到的请求结果。
 * 记忆范围决定上下文边界，不能让旧会话的响应短暂污染新会话。
 */
export function createMemoryScopeStore(transport: MemoryScopeTransport) {
  let state = emptyState()
  let generation = 0
  const listeners = new Set<() => void>()
  const inflight = new Map<string, { generation: number; kind: 'read' | 'write'; promise: Promise<void> }>()

  const publish = (next: MemoryScopeState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const current = (sessionId: string, requestGeneration: number): boolean =>
    state.sessionId === sessionId && generation === requestGeneration

  const reset = (): void => {
    generation++
    inflight.clear()
    publish(emptyState())
  }

  const refresh = (sessionId: string): Promise<void> => {
    if (!sessionId) {
      reset()
      return Promise.resolve()
    }
    const existing = inflight.get(sessionId)
    if (state.sessionId === sessionId && existing?.generation === generation) {
      // A GET must wait for a pending PUT, otherwise it could restore the old value.
      return existing.kind === 'write' ? existing.promise.catch(() => undefined) : existing.promise
    }
    const requestGeneration = ++generation
    publish({ sessionId, scope: null, effectiveScope: null, enabled: null, loaded: false, loading: true, error: null })
    const promise = Promise.resolve()
      .then(() => transport.read(sessionId))
      .then((settings) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, scope: settings.memoryScope, effectiveScope: settings.effectiveScope,
            enabled: settings.enabled, loaded: true, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, scope: null, effectiveScope: null, enabled: null, loaded: false,
            loading: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
      .finally(() => {
        if (inflight.get(sessionId)?.generation === requestGeneration) inflight.delete(sessionId)
      })
    inflight.set(sessionId, { generation: requestGeneration, kind: 'read', promise })
    return promise
  }

  const change = (sessionId: string, scope: MemoryScope): Promise<void> => {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID，无法切换记忆范围'))
    const requestGeneration = ++generation
    publish({ sessionId, scope: null, effectiveScope: null, enabled: state.enabled, loaded: false, loading: true, error: null })
    const promise = Promise.resolve()
      .then(() => transport.write(sessionId, scope))
      .then((settings) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, scope: settings.memoryScope, effectiveScope: settings.effectiveScope,
            enabled: settings.enabled, loaded: true, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, scope: null, effectiveScope: null, enabled: state.enabled, loaded: false,
            loading: false, error: error instanceof Error ? error.message : String(error) })
        }
        throw error
      })
      .finally(() => {
        if (inflight.get(sessionId)?.generation === requestGeneration) inflight.delete(sessionId)
      })
    inflight.set(sessionId, { generation: requestGeneration, kind: 'write', promise })
    return promise
  }

  return {
    getSnapshot: (): MemoryScopeState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    change,
    reset
  }
}
