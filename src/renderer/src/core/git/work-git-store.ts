import { createGitStore, type GitStore } from './git-store-instance'
import { captureSessionGitTarget } from './git-target'
import { getEngineSource, sessionStorageKey } from '../engine/source'
import { bindSessionWorkspace } from '../workspace/fs-client'

interface Entry {
  store: GitStore
  users: number
}
const stores = new Map<string, Entry>()
const MAX_IDLE_STORES = 16

/** A hidden task retains its draft and running command, but owns no polling timer. */
export function workGitStoreFor(
  source: number,
  sessionId: string,
  cwd: string,
  repositoryPath = ''
): GitStore {
  const key = JSON.stringify([source, sessionId, cwd, repositoryPath])
  const cached = stores.get(key)
  if (cached) {
    stores.delete(key)
    stores.set(key, cached)
    return cached.store
  }
  const store = createGitStore({
    initialCwd: repositoryPath ? `${cwd || '.'}/${repositoryPath}` : cwd || '.',
    draftKey: sessionStorageKey(
      `aether:workGitDraft:${encodeURIComponent(sessionId)}:${encodeURIComponent(cwd)}:${encodeURIComponent(repositoryPath)}`
    ),
    identity: () => JSON.stringify([getEngineSource(), sessionId, cwd, repositoryPath]),
    captureTarget: async () => {
      if (source !== getEngineSource()) throw new Error('Git 连接已变化，请在当前任务重试')
      if (cwd) await bindSessionWorkspace(sessionId, cwd)
      if (source !== getEngineSource()) throw new Error('Git 连接已变化，请在当前任务重试')
      // The authenticated binding is authoritative; the saved directory is a
      // recovery hint and can differ from the engine's scratch workspace.
      return captureSessionGitTarget(sessionId, repositoryPath)
    }
  })
  stores.set(key, { store, users: 0 })
  return store
}

export function retainWorkGitStore(store: GitStore): () => void {
  const entry = [...stores.values()].find((value) => value.store === store)
  if (entry) entry.users += 1
  return () => {
    if (entry) entry.users -= 1
    if (entry?.users) return
    store.stopGitAutoFetch()
    const idle = [...stores].filter(([, value]) => {
      const state = value.store.getGitState()
      const operation = state.repositoryOperation?.getSnapshot()
      return (
        !value.users &&
        !state.operation &&
        !state.committing &&
        !operation?.pending &&
        operation?.phase !== 'running'
      )
    })
    for (const [key, value] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_STORES))) {
      value.store.disposeGitStore()
      stores.delete(key)
    }
  }
}
