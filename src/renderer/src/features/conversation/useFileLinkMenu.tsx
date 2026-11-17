import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react'
import { OPEN_WITH_APP_IDS, type OpenWithApp, type OpenWithAppId } from '@shared/ipc'
import { getEngineSource, getExpectedEngine, isRemoteEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { assertSessionFileTarget, readSessionFile, resolveSessionFilePath, saveSessionFile } from '@renderer/core/workspace/fs-client'
import { copyFilePaths, revealFile } from '@renderer/core/editor/file-context-actions'
import { toast } from '@renderer/core/toast'
import { ContextMenu, type ContextMenuItem } from '@renderer/ui/ContextMenu'
import { Icon } from '@renderer/ui/icons'
import type { ChatFileContext } from './shared/chat-link'
import { conversationFileLink } from './file-link-target'

interface FileMenuRequest {
  id: number
  scope: string
  anchor: HTMLAnchorElement
  path: string
  x: number
  y: number
}

const supportedApps = new Set<string>(OPEN_WITH_APP_IDS)

export function useFileLinkMenu(context: ChatFileContext, active: boolean, openFile: (path: string) => void) {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const scope = JSON.stringify([source, context.sessionId, context.workspaceRoot, active])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const sequence = useRef(0)
  const [request, setRequest] = useState<FileMenuRequest | null>(null)
  useEffect(() => { setRequest(null) }, [scope])

  const show = useCallback((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, keyboard: boolean): void => {
    if (!active || event.defaultPrevented) return
    const link = conversationFileLink(event.target, context.sessionId, getExpectedEngine().baseUrl)
    if (!link || (link.target.kind !== 'file' && link.target.kind !== 'artifact')) return
    // A nested child transcript owns its own session, never the parent's menu.
    if (link.anchor.closest('.work-message') !== event.currentTarget) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = link.anchor.getBoundingClientRect()
    const mouse = event as MouseEvent<HTMLElement>
    setRequest({ id: ++sequence.current, scope, anchor: link.anchor, path: link.target.path,
      x: keyboard ? bounds.left : mouse.clientX, y: keyboard ? bounds.bottom : mouse.clientY })
  }, [active, context.sessionId, scope])
  const onContextMenu = useCallback((event: MouseEvent<HTMLElement>): void => show(event, event.detail === 0 && event.clientX === 0 && event.clientY === 0), [show])
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) show(event, true)
  }, [show])
  const assertCurrent = (captured: FileMenuRequest): void => {
    if (scopeRef.current !== captured.scope || source !== getEngineSource() || !captured.anchor.isConnected)
      throw new Error('会话或文件链接已变化，请重新打开菜单。')
  }
  return {
    onContextMenu, onKeyDown,
    menu: request?.scope === scope && active ? <FileLinkMenu key={request.id} request={request} context={context}
      assertCurrent={() => assertCurrent(request)} openFile={openFile} onClose={() => setRequest(null)} /> : null
  }
}

function FileLinkMenu({ request, context, assertCurrent, openFile, onClose }: {
  request: FileMenuRequest
  context: ChatFileContext
  assertCurrent: () => void
  openFile: (path: string) => void
  onClose: () => void
}) {
  const remote = isRemoteEngine()
  const [catalog, setCatalog] = useState<{ apps?: OpenWithApp[]; error?: string }>({})
  const detecting = useRef(false)
  const busy = useRef(false)
  const run = (action: () => Promise<void> | void): void => {
    if (busy.current) return
    busy.current = true
    void (async () => { assertCurrent(); await action() })().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '文件操作失败，请重试。')
    }).finally(() => { busy.current = false })
  }
  const resolve = async () => {
    assertCurrent()
    const resolved = await resolveSessionFilePath(context.sessionId, request.path, context.workspaceRoot)
    assertCurrent()
    assertSessionFileTarget(resolved.target)
    return resolved
  }
  const localAction = async (app?: OpenWithAppId): Promise<void> => {
    if (isRemoteEngine()) throw new Error('远端文件无法使用本机应用打开。')
    const resolved = await resolve()
    // Access is granted by the explicit action, never by right clicking a link.
    await window.aether.fs.allowRoot(resolved.root)
    assertCurrent()
    assertSessionFileTarget(resolved.target)
    if (isRemoteEngine()) throw new Error('工作区连接已变化，请重新打开菜单。')
    if (app) await window.aether.system.openWith(resolved.path, app)
    else await revealFile(resolved.path)
  }
  const loadApps = (): void => {
    if (remote || detecting.current || catalog.apps) return
    detecting.current = true
    void window.aether.system.getOpenWithApps().then(apps => {
      assertCurrent()
      setCatalog({ apps: apps.filter(app => app.available && app.id !== 'file-explorer' && supportedApps.has(app.id)) })
    }).catch((error: unknown) => setCatalog({ error: error instanceof Error ? error.message : '无法检测应用' }))
      .finally(() => { detecting.current = false })
  }
  const applications: ContextMenuItem[] = catalog.apps?.map(app => ({ id: `open-with-${app.id}`, label: app.label,
    onSelect: () => run(() => localAction(app.id)) })) ?? []
  const items: ContextMenuItem[] = [
    { id: 'open-file', label: '打开文件', icon: <Icon name="file" size={14} />, onSelect: () => run(() => openFile(request.path)) },
    { id: 'open-with', label: '打开方式', icon: <Icon name="open-in-new" size={14} />, disabled: remote,
      title: remote ? '远端文件无法使用本机应用打开' : undefined, onSelect: () => {}, onOpen: loadApps,
      children: applications.length ? applications : [{ id: 'open-with-empty', disabled: true,
        label: catalog.error ? '无法检测应用' : catalog.apps ? '未检测到可用应用' : '正在检测应用…', title: catalog.error, onSelect: () => {} }] },
    { id: 'save-file', label: '另存为…', icon: <Icon name="download" size={14} />, onSelect: () => run(async () => {
      await resolve()
      const result = await saveSessionFile(context.sessionId, request.path, context.workspaceRoot)
      if (result.saved) toast.success('文件已保存')
    }) },
    { id: 'copy-file-path', label: '复制路径', icon: <Icon name="copy" size={14} />, separatorBefore: true,
      onSelect: () => run(async () => { const resolved = await resolve(); await copyFilePaths([resolved.path]) }) },
    { id: 'copy-file-content', label: '复制文件内容', icon: <Icon name="content-copy" size={14} />, onSelect: () => run(async () => {
      const file = await readSessionFile(context.sessionId, request.path, context.workspaceRoot)
      assertCurrent()
      if (file.isBinary) throw new Error('此文件不是文本，无法复制文件内容。')
      if (file.truncated || file.tooLarge) throw new Error('文件内容过长，请使用“另存为…”获取完整文件。')
      await navigator.clipboard.writeText(file.content)
      toast.success('文件内容已复制')
    }) },
    { id: 'reveal-file', label: '在资源管理器中显示', icon: <Icon name="folder-outline" size={14} />, separatorBefore: true,
      disabled: remote, title: remote ? '远端文件无法在本机资源管理器中显示' : undefined, onSelect: () => run(() => localAction()) }
  ]
  return <ContextMenu x={request.x} y={request.y} anchor={request.anchor} items={items} onClose={onClose} />
}
