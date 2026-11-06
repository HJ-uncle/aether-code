import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { requestOrThrow } from './client'
import { getEngineSource, getExpectedEngine, subscribeEngineSource } from './source'
import { codegraphIndexState, EMPTY_CODEGRAPH_INDEX, type CodegraphIndexState, type CodegraphStatus } from './codegraph-index-state'

/** Both composers use the engine's existing project index and job runner. */
export function useCodegraphIndex({ sessionId, path, active, ready }: {
  sessionId: string
  path?: string
  active: boolean
  ready: boolean
}): CodegraphIndexState & { start: () => void; refresh: () => void } {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const scope = JSON.stringify([source, sessionId, path ?? null, active, ready])
  const liveScope = useRef(scope)
  liveScope.current = scope
  const [snapshot, setSnapshot] = useState({ scope, state: EMPTY_CODEGRAPH_INDEX })
  const actions = useRef({ start: () => {}, refresh: () => {} })

  useEffect(() => {
    if (!active || !ready || !sessionId) return
    let disposed = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let state = EMPTY_CODEGRAPH_INDEX
    const expectedEngine = getExpectedEngine()
    const current = (): boolean => !disposed && liveScope.current === scope && source === getEngineSource()
    const publish = (next: CodegraphIndexState): void => {
      if (!current()) return
      state = next
      setSnapshot({ scope, state })
    }
    const clearTimer = (): void => { clearTimeout(timer); timer = undefined }
    const failure = (cause: unknown): void => publish({ ...state, checking: false, busy: false,
      label: '状态查询失败', error: cause instanceof Error ? cause.message : String(cause), queryFailed: true })

    const read = async (): Promise<void> => {
      if (!current() || pending) return
      pending = true
      clearTimer()
      try {
        const result = await requestOrThrow<CodegraphStatus>({ method: 'GET', path: '/codegraph/status',
          query: { sessionId, path }, expectedEngine })
        if (!current()) return
        publish(codegraphIndexState(result))
        // Schedule after completion: slow requests never pile up. Hidden Work
        // popovers and inactive modes dispose this watcher without stopping jobs.
        if (result.indexing) timer = setTimeout(() => { void read() }, 1500)
      } catch (cause) { if (current()) failure(cause) }
      finally { pending = false }
    }
    const start = async (): Promise<void> => {
      if (!current() || pending || state.busy || state.initialized) return
      pending = true
      clearTimer()
      publish({ ...state, busy: true, error: null, queryFailed: false, label: '启动中…' })
      try {
        const result = await requestOrThrow<{ started: boolean; alreadyRunning?: boolean; alreadyInitialized?: boolean }>({
          method: 'POST', path: '/codegraph/index', body: { sessionId, path }, expectedEngine
        })
        if (!current()) return
        if (result.alreadyInitialized && !result.started) {
          publish({ ...EMPTY_CODEGRAPH_INDEX, known: true, initialized: true })
          return
        }
        pending = false
        await read()
      } catch (cause) {
        if (current()) publish({ ...state, busy: false, label: '索引失败',
          error: cause instanceof Error ? cause.message : String(cause), queryFailed: false })
      } finally { pending = false }
    }
    actions.current = {
      start: () => { void start() },
      refresh: () => {
        if (!current() || pending) return
        publish({ ...state, checking: true, error: null })
        void read()
      }
    }
    publish({ ...EMPTY_CODEGRAPH_INDEX, checking: true })
    void read()
    return () => { disposed = true; clearTimer() }
  }, [scope, source, sessionId, path, active, ready])

  return {
    ...(snapshot.scope === scope ? snapshot.state : EMPTY_CODEGRAPH_INDEX),
    start: () => actions.current.start(), refresh: () => actions.current.refresh()
  }
}
