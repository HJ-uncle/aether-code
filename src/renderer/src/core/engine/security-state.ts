import { isSecurityMode, type SecurityMode } from './security'
import { getEngineSource, getEngineStorageKey, sessionStorageKey } from './source'

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

/**
 * 引擎把安全模式保存在进程内会话 Map 中，重启后会回到默认值。
 * 客户端按「引擎端点 + 会话」记住用户最后一次确认的模式，并在下一次
 * 读取时补写回引擎；这样不会把一个远端端点的权限选择带到另一个端点。
 */
const persistedModeKey = (sessionId: string, storageSource: string): string =>
  `${sessionStorageKey('aether:security-mode', storageSource)}:${encodeURIComponent(sessionId)}`

function readPersistedMode(sessionId: string, storageSource: string): SecurityMode | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(persistedModeKey(sessionId, storageSource))
    return isSecurityMode(value) ? value : null
  } catch {
    return null
  }
}

function writePersistedMode(sessionId: string, mode: SecurityMode, storageSource: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(persistedModeKey(sessionId, storageSource), mode)
  } catch {
    // Storage is optional (private mode or a locked profile must not block a change).
  }
}

const emptyState = (): SecurityModeState => ({
  sessionId: '', mode: null, loading: false, error: null, loaded: false
})

/** Keep request ordering independent of React so delayed real transport promises are testable. */
export function createSecurityModeStore(transport: SecurityModeTransport) {
  let state = emptyState()
  let generation = 0
  const listeners = new Set<() => void>()
  const inflight = new Map<string, { generation: number; source: number; kind: 'read' | 'write'; promise: Promise<void> }>()
  const pendingWrites = new Map<string, Promise<boolean>>()
  const publish = (next: SecurityModeState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const current = (sessionId: string, requestGeneration: number, source: number): boolean =>
    state.sessionId === sessionId && generation === requestGeneration && getEngineSource() === source

  const write = (sessionId: string, mode: SecurityMode, source: number, shouldWrite = () => true): Promise<boolean> => {
    const key = JSON.stringify([source, sessionId])
    const previous = pendingWrites.get(key)
    // A restore may already be in flight when the user picks another mode.
    // Serialize both paths so the explicit choice is always the final server PUT.
    const request = (previous ? previous.catch(() => false) : Promise.resolve()).then(async () => {
      if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
      if (!shouldWrite()) return false
      await transport.write(sessionId, mode)
      return true
    }).finally(() => {
      if (pendingWrites.get(key) === request) pendingWrites.delete(key)
    })
    pendingWrites.set(key, request)
    return request
  }

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
    // Capture the endpoint before awaiting transport. A connection switch while
    // this request is in flight must never write the preference into the new
    // endpoint's namespace.
    const storageSource = getEngineStorageKey()
    const source = getEngineSource()
    const existing = inflight.get(sessionId)
    if (state.sessionId === sessionId && existing?.generation === generation && existing.source === source) {
      // A refresh must not race a pending PUT with a GET of the old server value.
      return existing.kind === 'write' ? existing.promise.catch(() => undefined) : existing.promise
    }
    const requestGeneration = ++generation
    publish({ sessionId, mode: null, loaded: false, loading: true, error: null })
    const promise = Promise.resolve()
      .then(async () => {
        // Switching away and back gives this session a new UI generation, but
        // its earlier PUT still owns the server value until it settles. Read
        // only after all queued writes, including ones whose response failed:
        // a failed response does not prove that the server rejected the write.
        const writeKey = JSON.stringify([source, sessionId])
        let pendingWrite = pendingWrites.get(writeKey)
        while (pendingWrite) {
          await pendingWrite.catch(() => false)
          if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
          pendingWrite = pendingWrites.get(writeKey)
        }
        if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
        return transport.read(sessionId)
      })
      .then(async (serverMode) => {
        // A newer change, session switch, or endpoint switch owns the state now.
        // Do not let this late GET perform a restore write on its behalf.
        if (!current(sessionId, requestGeneration, source)) return serverMode
        const persistedMode = readPersistedMode(sessionId, storageSource)
        // The server value is authoritative when there is no local preference.
        // After a restart, restore the user's last explicit choice before exposing
        // the loaded state so the UI never briefly advertises the default mode.
        if (persistedMode && persistedMode !== serverMode) {
          const restored = await write(sessionId, persistedMode, source, () => current(sessionId, requestGeneration, source))
          return restored ? persistedMode : serverMode
        }
        return serverMode
      })
      .then((mode) => {
        if (current(sessionId, requestGeneration, source)) {
          publish({ sessionId, mode, loaded: true, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration, source)) {
          publish({ sessionId, mode: null, loaded: false, loading: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })
      .finally(() => {
        if (inflight.get(sessionId)?.generation === requestGeneration) inflight.delete(sessionId)
      })
    inflight.set(sessionId, { generation: requestGeneration, source, kind: 'read', promise })
    return promise
  }

  const change = (sessionId: string, mode: SecurityMode): Promise<void> => {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID，无法切换安全模式'))
    const storageSource = getEngineStorageKey()
    const source = getEngineSource()
    const requestGeneration = ++generation
    // A network failure may happen after the server applied a PUT. Neither optimistic
    // success nor restoring an earlier local mode is evidence of the server's state.
    publish({ sessionId, mode: null, loaded: false, loading: true, error: null })
    const promise = write(sessionId, mode, source)
      .then(() => {
        // A confirmed selection still belongs to its original session after the
        // user switches sessions. Source changes must not persist a stale result.
        if (getEngineSource() === source) {
          writePersistedMode(sessionId, mode, storageSource)
        }
        if (current(sessionId, requestGeneration, source)) {
          publish({ sessionId, mode, loaded: true, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration, source)) {
          publish({ sessionId, mode: null, loaded: false, loading: false,
            error: error instanceof Error ? error.message : String(error) })
        }
        throw error
      })
      .finally(() => {
        if (inflight.get(sessionId)?.generation === requestGeneration) inflight.delete(sessionId)
      })
    inflight.set(sessionId, { generation: requestGeneration, source, kind: 'write', promise })
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
