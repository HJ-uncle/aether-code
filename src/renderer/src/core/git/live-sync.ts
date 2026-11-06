/** Keep Git badges and the changes panel current after terminal/other-client writes. */
import { getEngineSource, isRemoteEngine } from '../engine/source'
import { getAppMode, onAppModeChanged } from '../platform/app-mode'
import { getLayout, onLayoutChanged } from '../platform/layout-state'
import { captureWorkspaceTarget, onWorkspaceConnectionChanged, workspaceConnectionKey } from '../workspace/connection'
import { getWorkspaceState, onWorkspaceChanged } from '../workspace/workspace-store'
import { codeGitStore } from './git-store'
import { wireGitStoreLiveSync } from './store-live-sync'

let wired = false
export function wireGitLiveSync(): () => void {
  if (wired) return () => {}
  wired = true
  const target = (): string => JSON.stringify([
    workspaceConnectionKey(), isRemoteEngine() ? getEngineSource() : null, getWorkspaceState().root
  ])
  const stop = wireGitStoreLiveSync({
    store: codeGitStore,
    target,
    cwd: () => getWorkspaceState().root,
    profile: 'code',
    sessionId: () => isRemoteEngine() && workspaceConnectionKey() !== 'remote:unavailable'
      ? captureWorkspaceTarget().sessionId : undefined,
    eligible: () => {
      const layout = getLayout()
      return getAppMode() === 'code' && layout.sidebarVisible &&
        (layout.activeView === 'git' || layout.activeView === 'explorer') &&
        Boolean(getWorkspaceState().root) && workspaceConnectionKey() !== 'remote:unavailable'
    },
    subscribe: wake => {
      let previousTarget = target()
      const changed = (): void => {
        const next = target()
        if (next !== previousTarget) { previousTarget = next; wake() }
      }
      let previousView = `${getLayout().sidebarVisible}:${getLayout().activeView}`
      const disposeLayout = onLayoutChanged(() => {
        const next = `${getLayout().sidebarVisible}:${getLayout().activeView}`
        if (next !== previousView) { previousView = next; wake() }
      })
      const disposeWorkspace = onWorkspaceChanged(changed)
      const disposeConnection = onWorkspaceConnectionChanged(changed)
      const disposeMode = onAppModeChanged(wake)
      return () => { disposeLayout(); disposeWorkspace(); disposeConnection(); disposeMode() }
    }
  })
  return () => { wired = false; stop() }
}
