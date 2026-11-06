import type { StreamEvent } from '@shared/ipc'
import type { GitStore } from './git-store-instance'
import { onSnapshot, onStreamEvent } from '../engine/client'
import { getEngineSource, isEngineReady } from '../engine/source'
import { getStreamOwner } from '../engine/stream-owner'
import { createGitSyncScheduler } from './live-sync-scheduler'

type ReadStore = Pick<GitStore, 'getGitState' | 'refreshGit' | 'startGitAutoFetch' | 'stopGitAutoFetch'>

/** Only the transport's current source/session may invalidate this store. */
export function gitStreamInvalidates(event: StreamEvent, profile: 'code' | 'general', sessionId?: string): boolean {
  if (event.type !== 'payload') return false
  const payload = event.payload
  if (!payload.fileChange && !payload.toolResult && !payload.toolEnd) return false
  const stream = getStreamOwner(event.streamId, getEngineSource())
  if (!stream || stream.profile !== profile || sessionId && stream.sessionId !== sessionId) return false
  const owner = [payload.fileChange, payload.toolResult, payload.toolEnd]
    .flatMap(value => value && typeof value === 'object' && 'sessionId' in value && typeof value.sessionId === 'string'
      ? [value.sessionId] : [])
  return owner.every(id => id === stream.sessionId)
}

/** Browser lifecycle and tool hints share a scheduler, independent of React. */
export function wireGitStoreLiveSync(options: {
  store: ReadStore
  target: () => string
  cwd: () => string | null
  eligible: () => boolean
  sessionId?: () => string | undefined
  profile: 'code' | 'general'
  subscribe?: (wake: () => void) => () => void
}): () => void {
  const { store } = options
  let disposed = false
  const eligible = (): boolean => !disposed && document.visibilityState !== 'hidden' && options.eligible()
  const scheduler = createGitSyncScheduler({
    target: options.target,
    eligible,
    busy: () => {
      const state = store.getGitState()
      const repository = state.repositoryOperation?.getSnapshot()
      // A new task store starts with loading=true before its first request.
      // Only a loaded store's foreground refresh can temporarily own this gate.
      return Boolean(state.operation || state.committing || state.loaded && state.loading || repository?.pending || repository?.phase === 'running')
    },
    refresh: async () => {
      const before = store.getGitState().status
      await store.refreshGit(options.cwd(), { background: true })
      const after = store.getGitState()
      return { changed: before !== after.status, failed: Boolean(after.errorMessage) }
    }
  })
  const wake = (): void => {
    if (disposed) return
    if (eligible()) store.startGitAutoFetch()
    else store.stopGitAutoFetch()
    scheduler.wake()
  }
  const unsubscribe = options.subscribe?.(wake)
  const disposeStream = onStreamEvent(event => {
    if (eligible() && gitStreamInvalidates(event, options.profile, options.sessionId?.())) scheduler.changed()
  })
  let ready = isEngineReady()
  const disposeSnapshot = onSnapshot(snapshot => {
    const nextReady = snapshot.phase === 'ready'
    if (ready === nextReady) return
    ready = nextReady
    // Readiness can recover without a source-generation notification. Defer
    // until useEngine has published the same snapshot, regardless of listener order.
    queueMicrotask(wake)
  })
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  // This also coalesces React's development mount replay before issuing reads.
  wake()
  return () => {
    disposed = true
    scheduler.dispose()
    unsubscribe?.()
    disposeStream()
    disposeSnapshot()
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
    store.stopGitAutoFetch()
  }
}
