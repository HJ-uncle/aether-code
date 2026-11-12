import { memo, type JSX, useRef, useState, useCallback, useEffect, type KeyboardEvent, useLayoutEffect, type DragEvent, type CSSProperties, useMemo } from 'react'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { toast } from '@renderer/core/toast'
import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { requestOrThrow } from '@renderer/core/engine/client'
import { type IconName, Icon } from '@renderer/ui/icons'
import type { ActionMenuItem } from '@renderer/ui/ActionMenu'
import { IconButton } from '@renderer/ui/ui-primitives'
import { FileGlyph } from '../explorer/FileGlyph'
import { openFileFromChat } from '../conversation/shared/open-file'
import { Browser } from '../browser/Browser'
import { useSessionReferenceNavigation } from '../conversation/ReferenceNavigation'
import { ArtifactPanel, type ArtifactPanelProps } from '../artifacts/ArtifactPanel'
import { fileContentBytes } from '@renderer/core/workspace/file-content-bytes'
import { resourcePreviewEntries } from './resource-preview-policy'
import { useRetainedPreviews } from '@renderer/core/editor/useRetainedPreviews'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import { SourcePreview, useSessionSourceFile } from './SourcePreview'
import { assertSessionFileTarget, paths, readLocalRecoveryFile, resolveSessionFilePath, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { GitPanel } from '../git/GitPanel'
import { type SessionFileRevealRequest, WorkspacePanel } from './WorkspacePanel'
import { SubagentsPanel } from '../collaboration/SubagentsPanel'
import { ArtifactsWorkspace } from '../artifacts/ArtifactsWorkspace'
import type { SessionArtifactSelection } from '../artifacts/session-artifacts'
import { useMotionPresence } from '@renderer/ui/MotionPresence'
import { getSessionState, type SessionArtifact } from '../sessions/state'
import { useBrowserState, selectBrowserTab, browserAction } from '../browser/browser-store'
import { ResourceTabs } from './ResourceTabs'
import { useSessionResources, sessionResourceBrowserTabs, resolvedSessionResourceId, selectSessionResource, closeSessionResource, openExternalSessionFileResource } from './resource-store'
import { type SessionFileChange, sessionChangePathKey } from '../artifacts/file-changes'
import { type TerminalPanelProps, TerminalPanel } from '../terminal/TerminalPanel'
import { type SessionSubagentReveal } from '../collaboration/subagent-navigation'
import { type SessionController, type FinalSelection, type ArtifactNavigation, reportError, useSessionTools, EmptyState, filename, fileSize } from '../sessions/session-presentation'
import { type WorkspaceTab, type WorkspaceEntry } from '../../app/navigation'
import { SessionPanelDivider } from '../../ui/PaneDivider'
import { ExtensionPage, useExtensionContributions } from '@renderer/features/extensions'
import { isExtensionDestination, extensionIcon } from '../../app/navigation'

const StableSessionSubagentsPanel = memo(SubagentsPanel)

const StableSessionGitPanel = memo(GitPanel)

export function Workspace({
  motionProps,
  controller,
  active,
  tab,
  setTab,
  onClose,
  selectedArtifact,
  fileRevealRequest,
  onDidReveal,
  selectArtifact,
  changeSelection,
  finalSelection,
  terminalReveal,
  subagentReveal,
  onOpenArtifacts
}: {
  motionProps: ReturnType<typeof useMotionPresence>['motionProps']
  controller: SessionController
  active: boolean
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  onClose: () => void
  selectedArtifact: string | null
  fileRevealRequest: SessionFileRevealRequest | null
  onDidReveal: (request: SessionFileRevealRequest) => void
  selectArtifact: (id: string, openResource?: boolean) => void
  changeSelection: SessionArtifactSelection | null
  finalSelection: FinalSelection | null
  terminalReveal: TerminalPanelProps['reveal']
  subagentReveal: SessionSubagentReveal | null
  onOpenArtifacts: (request: ArtifactNavigation) => void
}): JSX.Element {
  const sessionId = controller.activeTask!.id
  const extensionContext = useMemo(() => ({ sessionId, workspacePath: controller.activeTask?.workspacePath, engineReady: controller.ready }), [sessionId, controller.activeTask?.workspacePath, controller.ready])
  const extensions = useExtensionContributions(extensionContext)
  const extensionTabs = extensions.workspaceTabs
  const resources = useSessionResources(sessionId)
  const browser = useBrowserState('work')
  const webTabs = sessionResourceBrowserTabs(browser.tabs, sessionId)
  const resourceCandidates = [
    ...resources.files.map(file => ({ id: file.id, name: file.name, title: file.path, file: true, fileName: file.name, directory: false })),
    ...webTabs.map(item => ({ id: `web:${item.tabId}`, name: item.title || (item.url === 'about:blank' ? '新网页' : item.url),
      title: item.localFile?.path ?? item.url, file: false, fileName: item.localFile?.name, directory: item.localFile?.kind === 'directory' }))
  ]
  const resourceOrder = useRef<string[]>([])
  resourceOrder.current = [
    ...resourceOrder.current.filter(id => resourceCandidates.some(item => item.id === id)),
    ...resourceCandidates.map(item => item.id).filter(id => !resourceOrder.current.includes(id))
  ]
  const orderedResources = resourceOrder.current.flatMap(id => {
    const item = resourceCandidates.find(candidate => candidate.id === id)
    return item ? [item] : []
  })
  const resourceIds = orderedResources.map(item => item.id)
  const resourceSignature = resourceIds.join('\u0000')
  const selectedResource = resolvedSessionResourceId(resources, webTabs.map(item => item.tabId), browser.activeTabId)
  // A single ordered entry list is the Work equivalent of Codex's unified tab
  // controller. Resource files/pages and built-in Work surfaces share the
  // same activation, close, keyboard and layout path.
  const [openEntries, setOpenEntries] = useState<WorkspaceEntry[]>(() => [{ kind: 'surface', id: tab }])
  useEffect(() => {
    const exists = (id: string): boolean => !isExtensionDestination(id) || extensionTabs.some(item => item.id === id)
    setOpenEntries(previous => previous.some(entry => entry.kind === 'surface' && !exists(entry.id)) ? previous.filter(entry => entry.kind !== 'surface' || exists(entry.id)) : previous)
    if (!exists(tab)) setTab('files')
  }, [extensionTabs, tab, setTab])
  const activateTab = useCallback((next: WorkspaceTab): void => {
    setOpenEntries(previous => previous.some(entry => entry.kind === 'surface' && entry.id === next)
      ? previous
      : [...previous, { kind: 'surface', id: next }])
    setTab(next)
  }, [setTab])
  useEffect(() => {
    // Closing the last tab can leave this pane mounted during its exit.
    // Reopening it must restore the remembered surface even if tab is unchanged.
    if (!active) return
    setOpenEntries(previous => previous.some(entry => entry.kind === 'surface' && entry.id === tab)
      ? previous
      : [...previous, { kind: 'surface', id: tab }])
  }, [tab, active])
  useEffect(() => {
    const live = new Set(resourceIds)
    setOpenEntries(previous => {
      const next = previous.filter(entry => entry.kind === 'surface' || live.has(entry.id))
      const existing = new Set(next.flatMap(entry => entry.kind === 'resource' ? [entry.id] : []))
      for (const id of resourceIds) {
        if (!existing.has(id)) next.push({ kind: 'resource', id })
      }
      const unchanged = next.length === previous.length && next.every((entry, index) => {
        const current = previous[index]
        return current?.kind === entry.kind && current.id === entry.id
      })
      return unchanged ? previous : next
    })
  }, [resourceSignature])
  const tabs: Array<[WorkspaceTab, string, IconName]> = [
    ['files', '成果', 'file-check'],
    ['workspace', '工作区', 'folder-outline'],
    ['sources', '资料', 'library'],
    ['subagents', '子代理', 'users'],
    ['terminal', '终端', 'terminal'],
    ['git', 'Git', 'git'],
    ...extensionTabs.flatMap(item => isExtensionDestination(item.id) ? [[item.id, item.title, extensionIcon(item.icon)] as [WorkspaceTab, string, IconName]] : [])
  ]
  const labelFor = (id: WorkspaceTab): string => tabs.find(([candidate]) => candidate === id)?.[1] ?? '成果'
  const iconFor = (id: WorkspaceTab): IconName => tabs.find(([candidate]) => candidate === id)?.[2] ?? 'file-check'
  const resourceById = new Map(orderedResources.map(item => [item.id, item]))
  const visibleEntries = openEntries.filter(entry => {
    // Browser is an implementation surface for resource tabs, not a second
    // workspace destination. Keep it mounted when needed, but expose the
    // actual web/file tabs in the same strip as Code instead of a dead
    // "资源" placeholder tab.
    if (entry.kind === 'surface') return entry.id !== 'browser'
    return resourceById.has(entry.id)
  })
  const activateResource = useCallback((id: string): void => {
    const resource = resourceById.get(id)
    if (!resource) return
    if (id.startsWith('web:')) selectBrowserTab(id.slice(4))
    selectSessionResource(sessionId, id)
    setOpenEntries(previous => previous.some(entry => entry.kind === 'resource' && entry.id === id)
      ? previous
      : [...previous, { kind: 'resource', id }])
    setTab('browser')
  }, [resourceById, sessionId, setTab])
  const closeResource = useCallback((id: string): void => {
    const resource = resourceById.get(id)
    if (!resource) return
    const index = visibleEntries.findIndex(entry => entry.kind === 'resource' && entry.id === id)
    const remainingVisible = visibleEntries.filter(entry => !(entry.kind === 'resource' && entry.id === id))
    const fallback = remainingVisible[Math.max(0, Math.min(index - 1, remainingVisible.length - 1))]
    const removingLastResource = orderedResources.length === 1
    setOpenEntries(previous => previous.filter(entry =>
      !(entry.kind === 'resource' && entry.id === id) &&
      !(removingLastResource && entry.kind === 'surface' && entry.id === 'browser')
    ))
    if (!fallback) {
      // Browser is only a host for resource tabs. Reopening a closed, empty
      // workspace should return to a real surface rather than an empty host.
      setTab('files')
      onClose()
    }
    else if (tab === 'browser' && selectedResource === id) {
      if (fallback.kind === 'resource') activateResource(fallback.id)
      else setTab(fallback.id)
    }
    if (resource.file) {
      closeSessionResource(sessionId, id)
      return
    }
    browserAction(async () => {
      const source = getEngineSource()
      await window.aether.browser.close(id.slice(4))
      if (source !== getEngineSource() || getSessionState(getEngineStorageKey()).activeTaskId !== sessionId) return
      if (resources.selected === id) closeSessionResource(sessionId, id)
    })
  }, [activateResource, browserAction, getEngineStorageKey, onClose, orderedResources, resourceById, resources.selected, selectedResource, sessionId, setTab, tab, visibleEntries])
  const closeTab = useCallback((closed: WorkspaceTab): void => {
    const index = visibleEntries.findIndex(entry => entry.kind === 'surface' && entry.id === closed)
    const remaining = openEntries.filter(entry => !(entry.kind === 'surface' && entry.id === closed))
    const remainingVisible = visibleEntries.filter(entry => !(entry.kind === 'surface' && entry.id === closed))
    setOpenEntries(remaining)
    if (!remainingVisible.length) { onClose(); return }
    if (tab !== closed) return
    const fallback = remainingVisible[Math.max(0, Math.min(index - 1, remainingVisible.length - 1))]
    if (!fallback) return
    if (fallback.kind === 'resource') activateResource(fallback.id)
    else setTab(fallback.id)
  }, [activateResource, onClose, openEntries, setTab, tab, visibleEntries])
  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Delete' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w')) {
      event.preventDefault(); event.stopPropagation()
      const entry = visibleEntries.find(item => item.kind === 'surface' ? `work-tab-${item.id}` === event.currentTarget.id : `work-resource-tab-${encodeURIComponent(item.id)}` === event.currentTarget.id)
      if (entry?.kind === 'resource') closeResource(entry.id)
      else if (entry) closeTab(entry.id)
      requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus())
      return
    }
    const list = event.currentTarget.closest('[role="tablist"]')
    const buttons = list ? [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(button => !button.disabled) : []
    const current = buttons.indexOf(event.currentTarget)
    const next = event.key === 'ArrowRight' ? (current + 1) % buttons.length : event.key === 'ArrowLeft' ? (current - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
    if (next < 0 || !buttons.length) return
    event.preventDefault()
    buttons[next]?.click()
    buttons[next]?.focus()
  }, [closeResource, closeTab, visibleEntries])
  const moreItems: ActionMenuItem[] = [
    {
      id: 'artifacts',
      label: '成果',
      icon: 'file-check',
      onSelect: () => activateTab('files')
    },
    {
      id: 'workspace',
      label: '工作区',
      icon: 'folder-outline',
      onSelect: () => activateTab('workspace')
    },
    { id: 'sources', label: '资料', icon: 'library', onSelect: () => activateTab('sources') },
    { id: 'subagents', label: '子代理', icon: 'users', onSelect: () => activateTab('subagents') },
    { id: 'terminal', label: '终端', icon: 'terminal', onSelect: () => activateTab('terminal') },
    { id: 'git', label: 'Git', icon: 'git', onSelect: () => activateTab('git') },
    ...extensionTabs.map(item => ({ id: item.id, label: item.title, icon: extensionIcon(item.icon), onSelect: () => { if (isExtensionDestination(item.id)) activateTab(item.id) } }))
  ]
  const tabsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const strip = tabsRef.current
    const activeEntry = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.closest<HTMLElement>('.work-workspace__tab')
    if (!strip || !activeEntry) return
    // scrollIntoView also moves ancestor scrollers, including the workspace.
    // Revealing a tab should only change this strip's horizontal position.
    const viewport = strip.getBoundingClientRect(), entry = activeEntry.getBoundingClientRect()
    const left = viewport.left + strip.clientLeft, right = left + strip.clientWidth
    if (entry.left < left) strip.scrollLeft += entry.left - left
    else if (entry.right > right) strip.scrollLeft += entry.right - right
  }, [selectedResource, tab, visibleEntries.length])
  return (
    <section className="work-workspace" aria-label="任务工作区" {...motionProps} data-motion-axis="x"
      onDragOver={(event: DragEvent<HTMLElement>) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        // Composer and attachment controls handle their own drops. Do not
        // also open the same file as a read-only resource tab when the event
        // bubbles through the workspace shell.
        if (event.defaultPrevented) return
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        const file = Array.from(event.dataTransfer.files).find(item => item.name)
        if (!file) return
        try {
          openExternalSessionFileResource(file, controller.activeTask!.id)
          // External files remain read-only resources. They are opened only
          // by an explicit drop/pick action, so this is the one path that
          // intentionally enters the resource surface.
          activateTab('browser')
        } catch (error) {
          reportError(error)
        }
      }}>
      <div className="work-workspace__tab-strip" role="toolbar" aria-label="工作区标签">
        <ResourceTabs sessionId={sessionId} onSelect={() => activateTab('browser')} items={moreItems} />
        <div ref={tabsRef} className="work-workspace__tabs" data-scroll-axis="x" role="tablist" aria-label="已打开的工作区">
          {visibleEntries.map((entry) => {
            if (entry.kind === 'surface') {
              const active = tab === entry.id
              return <div className={`work-workspace__tab${active ? ' is-active' : ''}`} key={`surface:${entry.id}`}>
                <button type="button" role="tab" id={`work-tab-${entry.id}`} aria-controls={`work-panel-${entry.id}`} aria-selected={active} tabIndex={active ? 0 : -1} className="work-workspace__tab-button" onClick={() => activateTab(entry.id)} onKeyDown={onTabKeyDown}>
                  <Icon name={iconFor(entry.id)} size={16} />
                  <span className="work-workspace__tab-label">{labelFor(entry.id)}</span>
                </button>
                <button type="button" className="work-workspace__tab-close" aria-label={`关闭${labelFor(entry.id)}`} onClick={() => closeTab(entry.id)}><Icon name="close" size={12} /></button>
              </div>
            }
            const resource = resourceById.get(entry.id)
            if (!resource) return null
            const active = tab === 'browser' && selectedResource === resource.id
            return <div className={`work-workspace__tab work-workspace__tab--resource${active ? ' is-active' : ''}`} key={`resource:${resource.id}`}>
              <button type="button" role="tab" id={`work-resource-tab-${encodeURIComponent(resource.id)}`} aria-controls="work-panel-browser" aria-selected={active} tabIndex={active ? 0 : -1} className="work-workspace__tab-button" title={resource.title} onClick={() => activateResource(resource.id)} onKeyDown={onTabKeyDown}>
                {resource.directory ? <Icon name="folder-outline" size={16} /> : resource.fileName
                  ? <FileGlyph name={resource.fileName} size={16} /> : <Icon name="globe" size={16} />}
                <span className="work-workspace__tab-label">{resource.name}</span>
              </button>
              <button type="button" className="work-workspace__tab-close" aria-label={`关闭${resource.file ? '文档' : '网页'} ${resource.name}`} onClick={() => closeResource(resource.id)}><Icon name="close" size={12} /></button>
            </div>
          })}
        </div>
      </div>
      <div className="work-workspace__panes">
        {openEntries.filter((entry): entry is { kind: 'surface'; id: WorkspaceTab } => entry.kind === 'surface').map(({ id }) => isExtensionDestination(id) ? (
          tab === id && extensionTabs.some(item => item.id === id) ? <div key={id} className="work-workspace__body" role="tabpanel" id={`work-panel-${id}`} aria-labelledby={`work-tab-${id}`}>
            <ExtensionPage contributionId={extensionTabs.find(item => item.id === id)!.page} context={extensionContext} />
          </div> : null
        ) : (
          <WorkspacePane
            key={id}
            id={id}
            hidden={tab !== id}
            active={active && tab === id}
            controller={controller}
            selectedArtifact={selectedArtifact}
            fileRevealRequest={fileRevealRequest}
            onDidReveal={onDidReveal}
            selectArtifact={selectArtifact}
            changeSelection={changeSelection}
            finalSelection={finalSelection}
            onOpenArtifacts={onOpenArtifacts}
            openTab={activateTab}
            source={getEngineSource()}
            terminalReveal={terminalReveal}
            subagentReveal={subagentReveal}
          />
        ))}
      </div>
    </section>
  )
}

/** Visited panes retain local drafts and selection, but hidden panes do not
 * rebuild message-derived diffs/activity on every incoming token. */
const WorkspacePane = memo(function WorkspacePane({ id, hidden, active, controller, selectedArtifact, fileRevealRequest, onDidReveal, selectArtifact, changeSelection, finalSelection, terminalReveal, subagentReveal, onOpenArtifacts, openTab }: {
  id: WorkspaceTab
  hidden: boolean
  active: boolean
  controller: SessionController
  selectedArtifact: string | null
  fileRevealRequest: SessionFileRevealRequest | null
  onDidReveal: (request: SessionFileRevealRequest) => void
  selectArtifact: (id: string, openResource?: boolean) => void
  changeSelection: SessionArtifactSelection | null
  finalSelection: FinalSelection | null
  onOpenArtifacts: (request: ArtifactNavigation) => void
  openTab: (tab: WorkspaceTab) => void
  source: number
  terminalReveal: TerminalPanelProps['reveal']
  subagentReveal: SessionSubagentReveal | null
}): JSX.Element {
  const previewRevision = useRef(0)
  const previewScope = JSON.stringify([getEngineSource(), controller.activeTask?.id, controller.activeTask?.workspacePath])
  const [previewReveal, setPreviewReveal] = useState<{ path: string; reveal: TextPreviewReveal; scope: string } | null>(null)
  const selectWorkspaceFile = useCallback((path: string, reveal?: TextPreviewReveal): void => {
    // Keep the workspace tree as its own tab while reusing the same preview
    // component for the selected session-scoped file.
    setPreviewReveal(reveal ? { path, reveal: { ...reveal, revision: ++previewRevision.current }, scope: previewScope } : null)
    selectArtifact(`path:${path}`)
    openTab('workspace')
  }, [openTab, selectArtifact, previewScope])
  const openGitFile = useCallback((path: string): void => {
    selectArtifact(`path:${path}`)
    openTab('workspace')
  }, [openTab, selectArtifact])
  // Keep one derived tool snapshot per pane. `useChat` replaces the active
  // message object for each streamed token, while its tool receipt arrays stay
  // referentially stable until a tool actually changes. Passing this snapshot
  // lets the heavy activity/artifact/subagent panes skip text-only renders.
  const tools = useSessionTools(controller.messages)
  const [workspaceSplitRatio, setWorkspaceSplitRatio] = useState(32)
  return <div
    className={`work-workspace__body work-workspace__body--${id}`}
    hidden={hidden}
    inert={hidden || undefined}
    aria-hidden={hidden || undefined}
    role="tabpanel"
    id={`work-panel-${id}`}
    aria-labelledby={`work-tab-${id}`}
  >
    {!active && id === 'sources' ? null : id === 'files' ? (
            <ArtifactsWorkspace sessionId={controller.activeTask!.id} workspacePath={controller.activeTask?.workspacePath}
              ready={controller.ready} streaming={controller.streaming || controller.launching || ['running', 'waiting'].includes(controller.activeTask?.status ?? '')}
              active={active} tools={tools} messages={controller.messages} selection={changeSelection} finalSelection={finalSelection} onOpenCurrentFile={selectWorkspaceFile}
              onAddToConversation={(...args) => addSessionArtifactToConversation(controller, 'artifact', ...args)} />
          ) : id === 'workspace' ? (
            <div className="work-files-workspace" style={{ '--work-panel-split-ratio': `${workspaceSplitRatio}%` } as CSSProperties}>
              <div className="work-files-workspace__tree">
                <WorkspacePanel
                  sessionId={controller.activeTask?.id}
                  workspaceRoot={controller.activeTask?.workspacePath}
                  active={active}
                  revealRequest={fileRevealRequest}
                  onDidReveal={onDidReveal}
                  onOpenFile={selectWorkspaceFile}
                  onAddToConversation={controller.addWorkspaceReferences}
                />
              </div>
              <SessionPanelDivider ratio={workspaceSplitRatio} setRatio={setWorkspaceSplitRatio} label="调整工作区文件与预览宽度" min={24} max={54} />
              <div className="work-files-workspace__preview">
                <TaskArtifactPanel
                  controller={controller}
                  active={active}
                  selectedId={selectedArtifact}
                  revealTarget={previewReveal?.scope === previewScope ? previewReveal : null}
                  onOpenFile={(item) => {
                    void openFileFromChat(item.path, {
                      sessionId: controller.activeTask?.id ?? '',
                      workspaceRoot: controller.activeTask?.workspacePath
                    }).then(() => openTab('browser')).catch(reportError)
                  }}
                />
              </div>
            </div>
          ) : id === 'sources' ? (
            <SourcePanel controller={controller} />
          ) : id === 'subagents' ? (
            <StableSessionSubagentsPanel
              reveal={subagentReveal}
              sessionId={controller.activeTask?.id ?? null}
              rootRunId={controller.workspaceRunId}
              tools={tools}
              active={active}
              publishedFixedChildren={controller.publishedFixedChildren}
              busy={controller.streaming || controller.loading || controller.pending.length > 0 || controller.uploading}
              onContinue={controller.continueSubagent}
              attachments={[...(controller.activeTask?.sources ?? []), ...controller.attachments]}
            />
          ) : id === 'terminal' ? (
            <TerminalPanel sessionId={controller.activeTask!.id} cwd={controller.activeTask?.workspacePath}
              jobs={controller.commandJobs} active={active} reveal={terminalReveal} />
          ) : id === 'git' ? (
            <StableSessionGitPanel
              // Never fall back to the Code workspace when Work has no active
              // task. Git operations must stay scoped to the selected Work
              // task's directory and session.
              cwd={controller.activeTask?.workspacePath}
              sessionId={controller.activeTask?.id}
              workspaceRunId={controller.workspaceRunId}
              active={active}
              onOpenFile={openGitFile}
            />
          ) : (
            <SessionResourcePane key={JSON.stringify([getEngineSource(), controller.activeTask?.id, controller.activeTask?.workspacePath])} controller={controller} onOpenArtifacts={onOpenArtifacts} active={active} />
          )}
  </div>
}, (previous, next) => !previous.active && !next.active && previous.hidden === next.hidden && previous.source === next.source && previous.controller.activeTask?.id === next.controller.activeTask?.id && previous.controller.activeTask?.workspacePath === next.controller.activeTask?.workspacePath)

function SessionResourcePane({ controller, onOpenArtifacts, active }: {
  controller: SessionController
  onOpenArtifacts: (request: ArtifactNavigation) => void
  active: boolean
}): JSX.Element {
  const sessionId = controller.activeTask!.id
  const resources = useSessionResources(sessionId)
  const browser = useBrowserState('work')
  const webTabs = sessionResourceBrowserTabs(browser.tabs, sessionId)
  const selected = resolvedSessionResourceId(resources, webTabs.map(tab => tab.tabId), browser.activeTabId)
  const file = resources.files.find(item => item.id === selected)
  const web = selected?.startsWith('web:') ? webTabs.find(item => item.tabId === selected.slice(4)) : undefined
  const selectedFileId = file?.id ?? null
  const retained = useRetainedPreviews(resourcePreviewEntries(resources.files), active ? selectedFileId : null,
    JSON.stringify([getEngineSource(), sessionId, controller.activeTask?.workspacePath]))
  const retainedIds = new Set(retained.map(entry => entry.id))
  if (active && selectedFileId) retainedIds.add(selectedFileId)
  return <>
    {/* Native browser bounds are released on hide; only file previews stay mounted. */}
    {active && web ? <div className="work-resource-browser"><Browser tabId={web.tabId} hideTabStrip /></div> : null}
    {!file && !web ? <EmptyState icon="file" title="文件和网页，在同一个地方查看" description="从成果、资料或对话中打开文件，也可以拖入电脑文件，或在“更多工作区”菜单中打开文件与网页。" /> : null}
    {resources.files.filter(item => retainedIds.has(item.id)).map(item => <SessionResourceFile
      key={JSON.stringify([getEngineSource(), sessionId, item.id])} controller={controller} file={item} onOpenArtifacts={onOpenArtifacts} active={active && item.id === file?.id} />)}
  </>
}

/** External resources cannot acquire a session history merely by sharing a filename. */
function useResourceArtifactPath(controller: SessionController, file: ReturnType<typeof useSessionResources>['files'][number], active = true): string | null {
  const sessionId = controller.activeTask?.id
  const source = getEngineSource()
  const identity = JSON.stringify([source, sessionId, file.path, file.target?.key])
  const [match, setMatch] = useState<{ identity: string; path: string } | null>(null)

  useEffect(() => {
    let subscribed = true
    const target = file.target
    setMatch(null)
    if (!target || target.sessionId !== sessionId || target.source !== source || !sessionId || !controller.ready || !active) {
      return () => { subscribed = false }
    }
    void (async () => {
      assertSessionFileTarget(target)
      const result = await requestOrThrow<SessionFileChange[]>({
        method: 'GET', path: '/changes', query: { sessionId }, expectedEngine: target.expectedEngine
      })
      assertSessionFileTarget(target)
      if (!subscribed) return
      const pathKey = sessionChangePathKey(file.path, target.root)
      const change = (Array.isArray(result) ? result : []).find(item =>
        item.sessionId === sessionId && sessionChangePathKey(item.path, target.root) === pathKey)
      if (change) setMatch({ identity, path: /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(change.path) ? change.path : paths.join(target.root, change.path) })
    })().catch(() => {
      // Only authenticated history can offer this link; a later activation retries.
      if (subscribed && source === getEngineSource()) setMatch(null)
    })
    return () => { subscribed = false }
  }, [controller.ready, controller.streaming, file.id, file.path, file.target, identity, sessionId, source, active])

  return match?.identity === identity ? match.path : null
}

function SessionResourceFile({ controller, file, onOpenArtifacts, active }: {
  controller: SessionController
  file: ReturnType<typeof useSessionResources>['files'][number]
  onOpenArtifacts: (request: ArtifactNavigation) => void
  active: boolean
}): JSX.Element {
  // External resources still belong to the visible Work conversation for
  // references/drafts, while their preview deliberately carries no session
  // file target and therefore cannot be written by the Agent.
  const sessionId = controller.activeTask?.id ?? file.target?.sessionId
  const artifactPath = useResourceArtifactPath(controller, file, active)
  const openArtifactHistory = (): void => {
    if (!artifactPath || !file.target || file.target.sessionId !== sessionId || !sessionId) return
    try {
      assertSessionFileTarget(file.target)
      onOpenArtifacts({ sessionId, path: artifactPath, view: 'operation', turnScope: { kind: 'session' } })
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
  }
  const addExternalToConversation = async (): Promise<void> => {
    let input = file.externalFile
    if (!input && file.externalPath) {
      const result = await readLocalRecoveryFile(file.externalPath)
      if (result.tooLarge || result.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请缩小文件后重试')
      const bytes = fileContentBytes(result)
      input = new File([bytes.buffer as ArrayBuffer], file.name, { type: 'application/octet-stream', lastModified: Date.now() })
    }
    if (!input) throw new Error('外部文件已失效，请重新选择或拖拽文件')
    await controller.addFiles([input])
    toast.success('已加入对话资料，发送时将上传副本')
  }
  return <div className="work-artifacts-shell__detail work-resource-file" hidden={!active}>
    {artifactPath ? <div className="work-artifacts-shell__tabs" aria-label="文件成果导航">
      <button type="button" onClick={openArtifactHistory} title="查看此文件在当前会话中的修改记录">在成果中查看改动</button>
    </div> : null}
    <ArtifactPanel
    artifact={{ id: file.id, path: file.path, name: file.name, content: null, status: 'ready', createdAt: 0 }}
    workspaceRoot={file.target?.root ?? controller.activeTask?.workspacePath} sessionId={sessionId} externalFile={file.externalFile} externalPath={file.externalPath} inResourceTab active={active}
    onAddToConversation={(item, selection, coverage, mention) => {
      if (mention || selection) {
        addSessionArtifactToConversation(controller, 'workspace', item, selection, coverage, mention)
      } else if (file.externalFile || file.externalPath) {
        void addExternalToConversation().catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : String(reason)))
      } else {
        try { controller.addWorkspaceReferences([{ path: item.path, kind: 'file' }]) }
        catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
      }
    }}
  />
  </div>
}

function addSessionArtifactToConversation(controller: SessionController, origin: 'workspace' | 'artifact', ...[item, selection, coverage, mention]: Parameters<NonNullable<ArtifactPanelProps['onAddToConversation']>>): void {
  try {
    if (origin === 'workspace' && !selection && !mention) {
      controller.addWorkspaceReferences([{ path: item.path, kind: 'file' }])
      return
    }
    controller.addMentions([mention ? { ...mention, origin } : { source: 'file', origin, path: item.path,
      displayText: selection ? `${item.name}（选区）` : item.name,
      ...(selection ? { content: coverage && coverage !== 'current' ? `来自${coverage === 'receipt' ? '历史回执' : '预览片段'}的选中内容：\n${selection}` : selection } : {}) }])
  } catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
}

function TaskArtifactPanel({ controller, active, selectedId, revealTarget, onOpenFile }: {
  controller: SessionController
  active: boolean
  selectedId: string | null
  revealTarget?: { path: string; reveal: TextPreviewReveal } | null
  onOpenFile: (item: SessionArtifact) => void
}): JSX.Element {
  const path = selectedId?.startsWith('path:') ? selectedId.slice(5) : null
  const artifact = path ? { id: selectedId!, path, name: filename(path), content: null, status: 'ready' as const, createdAt: 0 }
    : controller.artifacts.find(item => item.id === selectedId) ?? null
  const root = controller.activeTask?.workspacePath
  const reveal = artifact && revealTarget && sessionChangePathKey(artifact.path, root) === sessionChangePathKey(revealTarget.path, root)
    ? revealTarget.reveal : undefined
  return <ArtifactPanel artifact={artifact} sessionId={controller.activeTask?.id} workspaceRoot={controller.activeTask?.workspacePath}
    active={active} reveal={reveal} onOpenFile={onOpenFile} onAddToConversation={(...args) => addSessionArtifactToConversation(controller, 'workspace', ...args)} />
}

function SourcePanel({ controller }: { controller: SessionController }): JSX.Element {
  const references = useSessionReferenceNavigation()
  const requested = references?.sourceSelection?.sessionId === controller.activeTask?.id ? references?.sourceSelection : null
  const sources = useMemo(() => {
    const files = [...(controller.activeTask?.sources ?? []), ...controller.attachments]
    return files.filter((file, index) => files.findIndex(other => other.path === file.path) === index)
  }, [controller.activeTask?.sources, controller.attachments])
  const root = controller.activeTask?.workspacePath ?? null
  const [selectedPath, setSelectedPath] = useState<string | null>(sources[0]?.path ?? null)
  const selected = sources.find((item) => item.path === selectedPath) ?? null
  useEffect(() => { if (requested) setSelectedPath(requested.source.path) }, [requested])
  useEffect(() => {
    // Keep a valid selection as the task's source list changes (attach / remove / task switch).
    if (!sources.some((item) => item.path === selectedPath)) setSelectedPath(sources[0]?.path ?? null)
  }, [sources, selectedPath])
  return sources.length ? (
    <div className="work-sources work-sources--manager">
      <h3>
        任务资料 <span>{sources.length}</span>
      </h3>
      <div className="work-sources__split">
        <ul className="work-sources__list" role="listbox" aria-label="资料文件">
          {sources.map((source) => (
            <SourceRow
              key={`${controller.draftSource}:${controller.activeTask?.id}:${source.path}`}
              controller={controller}
              source={source}
              root={root}
              selected={selected?.path === source.path}
              onSelect={() => setSelectedPath(source.path)}
            />
          ))}
        </ul>
        <div className="work-sources__preview">
          {selected ? (
            <SourcePreview source={selected} root={root} sessionId={controller.activeTask?.id}
              onAddFile={() => { controller.addMentions([{ source: 'file', origin: 'attachment', path: selected.path, displayText: selected.name }]) }}
              onAddSelection={text => { controller.addMentions([{ source: 'file', origin: 'attachment', path: selected.path,
                displayText: `${selected.name}（选区）`, content: text }]) }} />
          ) : (
            <div className="work-sources__preview-empty">
              <Icon name="file" size={20} />
              <span>选择左侧资料查看内容</span>
            </div>
          )}
        </div>
      </div>
    </div>
  ) : (
    <EmptyState
      icon="paperclip"
      title="还没有添加资料"
      description="在对话输入区选择“添加资料”，或将文件拖入输入区。资料会随消息一起发送。"
    />
  )
}

/** 单个资料行：缩略图 + 名称/大小 + 悬浮操作（添加到对话、在文件夹中显示、删除） */
function SourceRow({
  controller,
  source,
  root,
  selected,
  onSelect
}: {
  controller: SessionController
  source: ChatAttachment
  root: string | null
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const isImage = source.type.startsWith('image/')
  const { file } = useSessionSourceFile(source, controller.activeTask?.id, root, isImage)
  const thumb = file?.base64 ? `data:${source.type};base64,${file.base64}` : null
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3200)
    return () => clearTimeout(timer)
  }, [confirming])
  const reveal = async (): Promise<void> => {
    try {
      if (controller.remote) throw new Error('远端资料无法在本机文件夹中显示，可在右侧预览')
      const sessionId = controller.activeTask?.id
      let target = sessionId ? await resolveSessionFilePath(sessionId, source.path, root)
        : root ? { path: paths.join(root, source.path) } : null
      if (!target) throw new Error('资料没有关联任务')
      await window.aether.fs.reveal(target.path)
    } catch (error) {
      // A restored local task can still point at a project root that the
      // engine's session binder has not persisted.  Reveal the same bounded
      // task-root candidates used by the read-only preview instead of hiding
      // the file behind a misleading session-path error.
      if (!controller.remote && root) {
        const candidates = workspaceRecoveryCandidates(source.path, root)
        for (const candidate of candidates) {
          try {
            await readLocalRecoveryFile(candidate)
            await window.aether.fs.reveal(candidate)
            return
          } catch { /* try the next bounded root */ }
        }
      }
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const remove = (): void => {
    controller.removeSource(source.path)
    setConfirming(false)
    toast.success('已从任务资料移除，历史附件仍保留')
  }
  return (
    <li className={`work-source-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="work-source-row__main"
        role="option"
        aria-selected={selected}
        title={source.path}
        onClick={onSelect}
      >
        {isImage && thumb ? (
          <img className="work-source-row__thumb" src={thumb} alt={source.name} />
        ) : (
          <span className="work-source-row__thumb work-source-row__thumb--icon">
            <FileGlyph name={source.name} size={18} />
          </span>
        )}
        <span className="work-source-row__info">
          <strong>{source.name}</strong>
          <span>{fileSize(source.size)}</span>
        </span>
      </button>
      <span className="work-source-row__actions">
        <button
          type="button"
          className="work-quiet-button"
          title="把该资料引用进当前对话草稿"
          onClick={() => {
            controller.addSourceReference(source)
            toast.success('已添加到对话草稿')
          }}
        >
          添加到对话
        </button>
        {!controller.remote && <IconButton icon="folder-outline" label="在文件夹中显示" size={14} onClick={() => void reveal()} />}
        <IconButton
          icon={confirming ? 'warning' : 'delete-outline'}
          label={confirming ? `确认移除 ${source.name}` : `从任务资料移除 ${source.name}`}
          size={14}
          onClick={() => (confirming ? remove() : setConfirming(true))}
        />
      </span>
    </li>
  )
}
