import { useEffect, useSyncExternalStore, type JSX } from 'react'
import { getEngineSource, getEngineStorageKey, subscribeEngineSource } from '@renderer/core/engine/source'
import { retainSessionGitStore } from '@renderer/core/git/session-git-store'
import { useSessionState } from '../sessions/state'
import { GitDiff } from './GitDiff'
import { Dialog } from '@renderer/ui/Dialog'
import { closeGitDiff, getGitDiffRequest, subscribeGitDiffRequests } from './git-diff-navigation'
import './git-panel.css'

/** A shared snapshot dialog replaces the retired editor-view registration. */
export function GitDiffHost(): JSX.Element | null {
  const request = useSyncExternalStore(subscribeGitDiffRequests, getGitDiffRequest)
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const state = useSessionState(getEngineStorageKey())
  const sessionId = state.activeTaskId ?? state.homeSessionId
  const current = request?.source === source && request.sessionId === sessionId
  useEffect(() => request && current ? retainSessionGitStore(request.store) : undefined, [request, current])
  useEffect(() => { if (request && !current) closeGitDiff(request.id) }, [request, current])
  if (!request || !current) return null
  const close = (): void => closeGitDiff(request.id)
  return <Dialog open title="文件差异" width={1100} onClose={close}>
    <div style={{ height: 'min(70vh, 760px)', minHeight: 280 }}>
      <GitDiff key={request.id} store={request.store} path={request.path} staged={request.staged} onClose={close} />
    </div>
  </Dialog>
}
