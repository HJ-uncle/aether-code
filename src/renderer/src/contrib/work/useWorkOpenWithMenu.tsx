import { useRef, useState, useSyncExternalStore } from 'react'
import { OPEN_WITH_APP_IDS, type OpenWithApp, type OpenWithAppId } from '@shared/ipc'
import { getEngineSource, isEngineReady, isRemoteEngine, subscribeEngineReadiness, subscribeEngineSource } from '@renderer/core/engine/source'
import { sessionWorkspaceContext } from '@renderer/core/workspace/fs-client'
import { toast } from '@renderer/core/toast'
import type { ContextMenuItem } from '@renderer/workbench/ContextMenu'
import type { WorkTask } from './work-state'

const supportedApplications = new Set<string>(OPEN_WITH_APP_IDS)

/** Resolve the task being acted on, including scratch workspaces; the active
 * Code folder and a persisted task hint can both belong to a different root. */
export function useWorkOpenWithMenu(task: WorkTask): ContextMenuItem {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const ready = useSyncExternalStore(subscribeEngineReadiness, isEngineReady)
  const remote = isRemoteEngine()
  const draft = task.status === 'draft'
  const scope = JSON.stringify([source, task.id, draft, task.workspacePath])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const pending = useRef<string | null>(null)
  const opening = useRef(false)
  const [catalog, setCatalog] = useState<{ scope: string; apps?: OpenWithApp[]; error?: string }>()
  const current = catalog?.scope === scope ? catalog : undefined
  const disabledReason = remote ? '远端工作区无法使用本机应用打开'
    : draft && !task.workspacePath ? '请先选择工作目录'
    : !draft && !ready ? '连接引擎后可打开当前工作区' : undefined

  const assertCurrent = (): void => {
    if (source !== getEngineSource() || scopeRef.current !== scope || isRemoteEngine())
      throw new Error('工作区连接已变化，请重新打开菜单。')
  }
  const loadApps = (): void => {
    if (disabledReason || pending.current === scope) return
    pending.current = scope
    void window.aether.system.getOpenWithApps().then(apps => {
      if (scopeRef.current === scope) setCatalog({ scope, apps })
    }).catch((error: unknown) => {
      if (scopeRef.current === scope) setCatalog({ scope, error: error instanceof Error ? error.message : '无法检测应用，请重新打开菜单' })
    }).finally(() => { if (pending.current === scope) pending.current = null })
  }
  const openWith = (app: OpenWithAppId): void => {
    if (opening.current) return
    opening.current = true
    void (async () => {
      assertCurrent()
      const root = draft ? task.workspacePath : (await sessionWorkspaceContext(task.id)).root
      assertCurrent()
      if (!root) throw new Error('请先为任务选择工作目录。')
      // This explicit local action authorizes the resolved directory, just as
      // choosing a folder does; merely opening the menu never grants access.
      await window.aether.fs.allowRoot(root)
      assertCurrent()
      await window.aether.system.openWith(root, app)
    })().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '打开失败，请重试。')
    }).finally(() => { opening.current = false })
  }

  // A renderer hot update can briefly share an older desktop process. Only
  // project tools from this UI's contract belong in the menu, even then.
  const apps = current?.apps?.filter(app => app.available && supportedApplications.has(app.id))
  const tools = apps?.filter(app => app.id !== 'file-explorer') ?? []
  const directory = apps?.find(app => app.id === 'file-explorer')
  const children: ContextMenuItem[] = tools.map(app => ({
    id: `open-with-${app.id}`, label: app.label, onSelect: () => openWith(app.id)
  }))
  if (directory) children.push({ id: 'open-with-file-explorer', label: '项目目录',
    separatorBefore: tools.length > 0, onSelect: () => openWith(directory.id) })

  return {
    id: 'open-with', label: '打开方式',
    disabled: Boolean(disabledReason), hint: disabledReason, onSelect: () => {}, onOpen: loadApps,
    children: children.length ? children : [{ id: 'open-with-loading', label: current?.error ? '无法检测应用' : '正在检测应用…',
      title: current?.error, disabled: true, onSelect: () => {} }]
  }
}
