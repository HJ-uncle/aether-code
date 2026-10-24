import type { MemoryScope, MemorySettings, MemoryReadScope, MemoryPreferences, MemoryPreferencesPatch } from './memory'
import { MemoryDisabledError } from './memory'
import { getEngineSource } from './source'

export interface MemoryScopeState {
  sessionId: string
  scope: MemoryScope | null
  effectiveScope: MemoryScope | null
  enabled: boolean | null
  loading: boolean
  error: string | null
  loaded: boolean
  globalEnabled: boolean | null
  sessionDefaultEnabled: boolean | null
  sessionOverride: boolean | null
  sessionEnabled: boolean | null
  effectiveScopes: MemoryReadScope[] | null
}

interface MemoryScopeTransport {
  read(sessionId: string): Promise<MemorySettings>
  write(sessionId: string, scope: MemoryScope): Promise<MemorySettings>
  writeSession?(sessionId: string, sessionEnabled: boolean | null): Promise<MemorySettings>
}

const emptyState = (): MemoryScopeState => ({
  sessionId: '', scope: null, effectiveScope: null, enabled: null,
  loading: false, error: null, loaded: false, globalEnabled: null,
  sessionDefaultEnabled: null, sessionOverride: null, sessionEnabled: null, effectiveScopes: null
})

function confirmedState(sessionId: string, settings: MemorySettings, error: string | null = null): MemoryScopeState {
  return {
    sessionId, scope: settings.memoryScope, effectiveScope: settings.enabled ? settings.effectiveScope : 'off',
    enabled: settings.enabled, loaded: true, loading: false, error,
    globalEnabled: settings.globalEnabled ?? settings.memoryScope === 'global',
    sessionDefaultEnabled: settings.sessionDefaultEnabled ?? true,
    sessionOverride: settings.sessionOverride !== undefined ? settings.sessionOverride
      : settings.memoryScope === 'session' ? true : settings.memoryScope === 'off' ? false : null,
    sessionEnabled: settings.sessionEnabled ?? settings.memoryScope === 'session',
    effectiveScopes: !settings.enabled ? [] : settings.effectiveScopes ?? (settings.effectiveScope === 'off' ? [] : [settings.effectiveScope]),
  }
}

/**
 * 会话切换时先清空旧快照，且丢弃迟到的请求结果。
 * 记忆范围决定上下文边界，不能让旧会话的响应短暂污染新会话。
 */
export function createMemoryScopeStore(transport: MemoryScopeTransport) {
  let state = emptyState()
  let generation = 0
  const listeners = new Set<() => void>()
  const inflight = new Map<string, { generation: number; source: number; kind: 'read' | 'write'; promise: Promise<void> }>()
  const pendingWrites = new Map<string, Promise<MemorySettings>>()

  const publish = (next: MemoryScopeState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const current = (sessionId: string, requestGeneration: number, source: number): boolean =>
    state.sessionId === sessionId && generation === requestGeneration && getEngineSource() === source

  const queueWrite = (sessionId: string, source: number, write: () => Promise<MemorySettings>): Promise<MemorySettings> => {
    const key = JSON.stringify([source, sessionId]), previous = pendingWrites.get(key)
    const request = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => {
      if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
      return write()
    }).finally(() => { if (pendingWrites.get(key) === request) pendingWrites.delete(key) })
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
    const source = getEngineSource(), existing = inflight.get(sessionId)
    if (state.sessionId === sessionId && existing?.generation === generation && existing.source === source) {
      // A GET must wait for a pending PUT, otherwise it could restore the old value.
      return existing.kind === 'write' ? existing.promise.catch(() => undefined) : existing.promise
    }
    const requestGeneration = ++generation
    publish({ ...emptyState(), sessionId, loading: true })
    const promise = Promise.resolve()
      .then(async () => {
        // Switching away does not cancel an earlier server mutation. Even a
        // failed response may have committed, so confirm only after it settles.
        const key = JSON.stringify([source, sessionId])
        let pending = pendingWrites.get(key)
        while (pending) {
          await pending.catch(() => undefined)
          if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
          pending = pendingWrites.get(key)
        }
        if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
        return transport.read(sessionId)
      })
      .then((settings) => {
        if (current(sessionId, requestGeneration, source)) {
          publish(confirmedState(sessionId, settings))
        }
      })
      .catch((error: unknown) => {
        if (current(sessionId, requestGeneration, source)) {
          publish({ ...emptyState(), sessionId, error: error instanceof Error ? error.message : String(error) })
        }
      })
      .finally(() => {
        if (inflight.get(sessionId)?.generation === requestGeneration) inflight.delete(sessionId)
      })
    inflight.set(sessionId, { generation: requestGeneration, source, kind: 'read', promise })
    return promise
  }

  const writeSetting = (sessionId: string, enablesMemory: boolean, write: () => Promise<MemorySettings>): Promise<void> => {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID，无法切换记忆范围'))
    if (state.sessionId === sessionId && state.enabled === false && enablesMemory) {
      const error = new MemoryDisabledError()
      publish({ ...state, error: error.message })
      return Promise.reject(error)
    }
    const confirmed = state.sessionId === sessionId && state.loaded ? state : null
    const source = getEngineSource()
    const requestGeneration = ++generation
    publish({ ...(state.sessionId === sessionId ? state : emptyState()), sessionId,
      scope: null, effectiveScope: null, loaded: false, loading: true, error: null })
    const promise = queueWrite(sessionId, source, write)
      .then((settings) => {
        if (current(sessionId, requestGeneration, source)) {
          publish(confirmedState(sessionId, settings))
        }
      })
      .catch(async (error: unknown) => {
        if (error instanceof MemoryDisabledError && current(sessionId, requestGeneration, source)) {
          let settings = error.settings
          if (!settings) {
            // A capability can change after the picker was opened. Legacy engines
            // need one authoritative read after refusal, never a retrying PUT loop.
            try { settings = await transport.read(sessionId) } catch { /* The refusal still confirms server-disabled memory. */ }
          }
          if (current(sessionId, requestGeneration, source)) {
            publish(settings
              ? confirmedState(sessionId, settings, error.message)
              : { ...(confirmed ?? emptyState()), sessionId, effectiveScope: 'off', effectiveScopes: [],
                  enabled: false, loaded: confirmed !== null, loading: false, error: error.message })
          }
          throw error
        }
        if (current(sessionId, requestGeneration, source)) {
          publish({ ...emptyState(), sessionId, enabled: state.enabled, loaded: false,
            loading: false, error: error instanceof Error ? error.message : String(error) })
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
    getSnapshot: (): MemoryScopeState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    change: (sessionId: string, scope: MemoryScope): Promise<void> =>
      writeSetting(sessionId, scope !== 'off', () => transport.write(sessionId, scope)),
    changeSession: (sessionId: string, sessionEnabled: boolean | null): Promise<void> =>
      writeSetting(sessionId, sessionEnabled === true, () => transport.writeSession
        ? transport.writeSession(sessionId, sessionEnabled) : Promise.reject(new Error('当前引擎不支持独立会话记忆开关，请升级后重试'))),
    reset
  }
}

export interface MemoryPreferencesState {
  preferences: MemoryPreferences | null
  loaded: boolean
  loading: boolean
  error: string | null
}

export function createMemoryPreferencesStore(transport: {
  read(): Promise<MemoryPreferences>
  write(patch: MemoryPreferencesPatch): Promise<MemoryPreferences>
}) {
  let state: MemoryPreferencesState = { preferences: null, loaded: false, loading: false, error: null }
  let generation = 0
  let inflight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: MemoryPreferencesState): void => { state = next; for (const listener of listeners) listener() }
  const reset = (): void => { generation++; inflight = undefined; publish({ preferences: null, loaded: false, loading: false, error: null }) }
  const run = (operation: () => Promise<MemoryPreferences>, writes: boolean): Promise<void> => {
    const previous = state, epoch = ++generation, source = getEngineSource()
    publish({ ...state, loading: true, error: null })
    const promise = Promise.resolve().then(() => {
      if (getEngineSource() !== source) throw new Error('引擎连接已变化，请在当前会话重试')
      return operation()
    }).then(preferences => {
      if (generation === epoch && getEngineSource() === source) publish({ preferences, loaded: true, loading: false, error: null })
    }).catch((error: unknown) => {
      if (generation === epoch && getEngineSource() === source) publish(error instanceof MemoryDisabledError
        ? { preferences: error.preferences ?? (previous.preferences ? { ...previous.preferences, enabled: false } : null),
            loaded: error.preferences !== undefined || previous.loaded, loading: false, error: error.message }
        : { preferences: null, loaded: false, loading: false, error: error instanceof Error ? error.message : String(error) })
      if (writes) throw error
    }).finally(() => { if (generation === epoch) inflight = undefined })
    inflight = promise
    return promise
  }
  return {
    getSnapshot: (): MemoryPreferencesState => state,
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    refresh: (): Promise<void> => inflight?.catch(() => undefined) ?? run(() => transport.read(), false),
    change: (patch: MemoryPreferencesPatch): Promise<void> => {
      if (state.preferences?.enabled === false && patch.globalEnabled === true) {
        const error = new MemoryDisabledError(); publish({ ...state, error: error.message }); return Promise.reject(error)
      }
      return run(() => transport.write(patch), true)
    },
    reset,
  }
}
