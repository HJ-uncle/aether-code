/** Keep Git badges and the changes panel current after terminal/other-client writes. */
import { onStreamEvent } from '../engine/client'
import { getEngineSource, isRemoteEngine } from '../engine/source'
import { getLayout, onLayoutChanged } from '../platform/layout-state'
import { onWorkspaceConnectionChanged, workspaceConnectionKey } from '../workspace/connection'
import { getWorkspaceState, onWorkspaceChanged } from '../workspace/workspace-store'
import { getGitState, refreshGit } from './git-store'

const MIN_DELAY = 2_500
const MAX_DELAY = 8_000
let wired = false

export function wireGitLiveSync(): () => void {
  if (wired) return () => {}
  wired = true
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline = 0
  let running = false
  let queued = false
  let delay = MIN_DELAY

  const target = (): string => JSON.stringify([
    workspaceConnectionKey(), isRemoteEngine() ? getEngineSource() : null, getWorkspaceState().root
  ])
  const eligible = (): boolean => {
    const layout = getLayout()
    return !disposed && document.visibilityState !== 'hidden' && layout.sidebarVisible &&
      (layout.activeView === 'git' || layout.activeView === 'explorer') &&
      Boolean(getWorkspaceState().root) && workspaceConnectionKey() !== 'remote:unavailable'
  }
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    deadline = 0
  }
  const schedule = (ms: number): void => {
    clear()
    if (eligible()) {
      deadline = Date.now() + ms
      timer = setTimeout(() => { timer = null; deadline = 0; void refresh() }, ms)
    }
  }
  const refresh = async (): Promise<void> => {
    if (!eligible()) return
    if (running) { queued = true; return }
    // A status process contending with a write can leave an unnecessary index.lock
    // error. The write owns its refresh; the next poll observes the final state.
    if (getGitState().operation || getGitState().committing) { schedule(MIN_DELAY); return }
    running = true
    const started = target()
    const before = getGitState().status
    try {
      await refreshGit(getWorkspaceState().root, { background: true })
      if (started === target()) delay = before === getGitState().status ? Math.min(MAX_DELAY, delay * 2) : MIN_DELAY
    } finally {
      running = false
      const immediate = queued || started !== target()
      queued = false
      schedule(immediate ? 0 : delay)
    }
  }
  const wake = (): void => { delay = MIN_DELAY; schedule(0) }
  let previousTarget = target()
  const changed = (): void => {
    const next = target()
    if (next === previousTarget) return
    previousTarget = next
    wake()
  }
  let previousView = `${getLayout().sidebarVisible}:${getLayout().activeView}`
  const disposeLayout = onLayoutChanged(() => {
    const next = `${getLayout().sidebarVisible}:${getLayout().activeView}`
    if (next === previousView) return
    previousView = next
    wake()
  })
  const disposeWorkspace = onWorkspaceChanged(changed)
  const disposeConnection = onWorkspaceConnectionChanged(changed)
  const disposeStream = onStreamEvent((event) => {
    if (event.type !== 'payload') return
    const payload = event.payload
    if (payload.fileChange || payload.toolResult || payload.toolEnd) {
      delay = MIN_DELAY
      // Coalesce a burst of tool completions without resetting a pending timer.
      if (timer === null || deadline > Date.now() + 80) schedule(80)
    }
  })
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  wake()
  return () => {
    disposed = true
    wired = false
    clear()
    disposeLayout()
    disposeWorkspace()
    disposeConnection()
    disposeStream()
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
  }
}
