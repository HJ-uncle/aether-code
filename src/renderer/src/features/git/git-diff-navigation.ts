import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { assertGitTarget, captureSessionGitTarget, gitFilePath, type GitTarget } from '@renderer/core/git/git-target'
import { sessionGitStoreFor } from '@renderer/core/git/session-git-store'
import type { GitStore } from '@renderer/core/git/git-store-instance'
import { getSessionState } from '../sessions/state'

export interface GitDiffRequest {
  id: number
  source: number
  sessionId: string
  path: string
  staged: boolean
  target: GitTarget
  store: GitStore
}

let request: GitDiffRequest | null = null
let sequence = 0
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of listeners) listener() }
export function getGitDiffRequest(): GitDiffRequest | null { return request }
export function subscribeGitDiffRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function currentGitDiffSession(): string | null {
  const state = getSessionState(getEngineStorageKey())
  return state.activeTaskId ?? state.homeSessionId
}
export function closeGitDiff(id: number): void {
  if (request?.id !== id) return
  request = null
  notify()
}

/** Resolve the authenticated session binding before opening a snapshot viewer. */
export async function openGitDiff(cwd: string, path: string, staged = false, sessionId = currentGitDiffSession()): Promise<void> {
  if (!sessionId) throw new Error('请先选择文件所属会话。')
  const id = ++sequence, source = getEngineSource(), file = gitFilePath(path)
  const target = await captureSessionGitTarget(sessionId, cwd)
  assertGitTarget(target)
  if (id !== sequence || source !== getEngineSource() || currentGitDiffSession() !== sessionId) return
  request = { id, source, sessionId, path: file, staged, target,
    store: sessionGitStoreFor(source, sessionId, target.root, target.cwd === '.' ? '' : target.cwd) }
  notify()
}
