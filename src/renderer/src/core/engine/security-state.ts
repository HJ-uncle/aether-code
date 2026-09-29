import type { SecurityMode } from './security'

export interface SecurityModeState {
  sessionId: string
  /** null means the server mode has not been confirmed for this session. */
  mode: SecurityMode | null
  loading: boolean
  error: string | null
  loaded: boolean
}

interface SecurityModeTransport {
  read(sessionId: string): Promise<SecurityMode>
  write(sessionId: string, mode: SecurityMode): Promise<void>
}

const emptyState = (): SecurityModeState => ({
  sessionId: '', mode: null, loading: false, error: null, loaded: false
})

/** Keep request ordering independent of React so delayed real transport promises are testable. */
export function createSecurityModeStore(transport: SecurityModeTransport) {
  let state = emptyState()
  let generation = 0
  const listeners = new Set<() => void>()
  const inflight = new Map<string, { generation: number; kind: 'read' | 'write'; promise: Promise<void> }>()
  const publish = (next: SecurityModeState): void => {
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
      // A refresh must not race a pending PUT with a GET of the old server value.
      return existing.kind === 'write' ? existing.promise.catch(() => undefined) : existing.promise
    }
    const requestGeneration = ++generation
    publish({ sessionId, mode: null, loaded: false, loading: true, error: null })
    const promise = Promise.resolve()
      .then(() => transport.read(sessionId))
      .then((mode) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, mode, loaded: true, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, mode: null, loaded: false, loading: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })
      .finally(() => {
        if (inflight.get(sessionId)?.generation === requestGeneration) inflight.delete(sessionId)
      })
    inflight.set(sessionId, { generation: requestGeneration, kind: 'read', promise })
    return promise
  }

  const change = (sessionId: string, mode: SecurityMode): Promise<void> => {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID，无法切换安全模式'))
    const requestGeneration = ++generation
    // A network failure may happen after the server applied a PUT. Neither optimistic
    // success nor restoring an earlier local mode is evidence of the server's state.
    publish({ sessionId, mode: null, loaded: false, loading: true, error: null })
    const promise = Promise.resolve()
      .then(() => transport.write(sessionId, mode))
      .then(() => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, mode, loaded: true, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration)) {
          publish({ sessionId, mode: null, loaded: false, loading: false,
            error: error instanceof Error ? error.message : String(error) })
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
    getSnapshot: (): SecurityModeState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh, change, reset
  }
}
