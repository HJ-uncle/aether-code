import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { getRevertReport, subscribeReverts } from '@renderer/core/engine/change-revert'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import { requestSessionPreview } from '@renderer/core/workbench/preview-request'
import { sessionWorkspaceContext } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { Select } from '@renderer/ui/Select'
import { Popover } from '@renderer/ui/Popover'
import { FileTreeRow } from '../explorer/FileTreeRow'
import { FileGlyph } from '../explorer/FileGlyph'
import { FileChangeCard } from '../conversation/shared/FileChangeCard'
import { ChangeReviewActions } from './ChangeReviewActions'
import { ArtifactPanel, type ArtifactPanelProps } from './ArtifactPanel'
import { sessionProgressRetryDelay } from '../conversation/progress-state'
import { sessionFileChangeCode, sessionFilePrefersPreview } from './file-change-presentation'
import { sessionChangePathKey } from './file-changes'
import {
  ARTIFACT_PROJECTION_NOTICES, artifactChangeStats, artifactChangeStatus, artifactFileIsDeleted, artifactSelectionAvailable, artifactToolRevision,
  artifactChangeTurnScope, artifactTurnScopeKey, buildArtifactTurnOptions,
  buildSessionArtifactFiles, buildSessionArtifactTree, currentArtifactForFile, defaultArtifactView, ownedArtifactChanges, resolveArtifactChoice,
  filterSessionArtifactFiles, reconcileArtifactChanges, scopeArtifactChanges, searchArtifactFiles,
  type SessionArtifactChoice, type SessionArtifactDetailView, type SessionArtifactSelection, type SessionArtifactTreeNode,
  type SessionArtifactTurnOption, type SessionArtifactTurnScope, type SessionArtifactView, type SessionArtifactFile
} from './session-artifacts'
import './session-artifacts.css'

export type { SessionArtifactSelection } from './session-artifacts'

export interface SessionArtifactsProps {
  sessionId: string
  workspacePath?: string | null
  ready: boolean
  streaming: boolean
  active?: boolean
  tools: ToolActivity[]
  messages: ChatMessage[]
  selection: SessionArtifactSelection | null
  onOpenCurrentFile: (path: string) => void
  onAddToConversation?: ArtifactPanelProps['onAddToConversation']
}

/** The change ledger owns this tree. Browsing older chat pages cannot remove
 * files, and a file shared by two tasks cannot lend either task its history. */
export const SessionArtifacts = memo(function SessionArtifacts(props: SessionArtifactsProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ScopedSessionArtifacts key={JSON.stringify([source, props.sessionId, props.workspacePath])} {...props} source={source} />
})

function selectionKey(selection: SessionArtifactSelection | null): string {
  return JSON.stringify(selection ? [selection.sessionId, selection.changeId, selection.path, selection.view, selection.turnScope, selection.revision] : null)
}

function ChangeCount({ view }: { view: SessionArtifactView | null }): JSX.Element {
  if (!view) return <></>
  const stats = view.change.kind === 'delete' ? null : artifactChangeStats(view.change)
  const scopeLabel = view?.scope === 'net' ? '待确认改动的当前片段' : '该次修改'
  const code = sessionFileChangeCode(view.change)
  const statusLabel = code === 'U' ? '新增' : code === 'D' ? '删除' : '修改'
  return stats ? <span className="work-session-artifacts__count" title={scopeLabel} aria-label={`${scopeLabel}：${stats.approximate ? '估算' : ''}增加 ${stats.added} 行，删除 ${stats.removed} 行`}>
    <b>{stats.approximate ? '≈' : ''}+{stats.added}</b><i>{stats.approximate ? '≈' : ''}−{stats.removed}</i>
  </span> : <span className="work-session-artifacts__file-status" data-file-status={code} title={`${scopeLabel}：${statusLabel}`} aria-label={`${scopeLabel}：${statusLabel}`}>{code}</span>
}

function DeletedArtifact({ path }: { path: string }): JSX.Element {
  return <div className="work-session-artifacts__deleted" role="status">
    <FileGlyph name={path} size={24} /><strong>已删除</strong><span>文件已删除，修改记录仍可查看。</span>
  </div>
}

function choiceFor(file: SessionArtifactFile, view = defaultArtifactView(file)): SessionArtifactChoice {
  return { kind: 'view', fileKey: file.key, scope: view.scope, changeId: view.change.id }
}

function turnOptionLabel(option: SessionArtifactTurnOption): string {
  const time = option.createdAt ? new Date(option.createdAt).toLocaleString() : ''
  return `${option.summary}${time ? ` · ${option.timeSource === 'change' ? '首次修改 ' : ''}${time}` : ''}`
}

// Assistant tokens and refresh indicators do not change the tree. Keep its rows
// outside that render path so an open, large result list stays responsive.
const ArtifactTree = memo(function ArtifactTree({ rows, collapsed, selectedFile, selectedView, active, selectionRevision, onSelect, onToggle }: {
  rows: SessionArtifactTreeNode[]
  collapsed: ReadonlySet<string>
  selectedFile: SessionArtifactFile | undefined
  selectedView: SessionArtifactView | null
  active: boolean
  selectionRevision: number | undefined
  onSelect: (file: SessionArtifactFile) => void
  onToggle: (node: SessionArtifactTreeNode, expand?: boolean) => void
}): JSX.Element {
  const treeRef = useRef<HTMLDivElement>(null)
  const lastRevealed = useRef('')
  // Toggling visibility only changes the reveal effect. Reuse the row elements
  // too, so returning to a retained tab does not render every file again.
  const content = useMemo(() => {
    const activate = (node: SessionArtifactTreeNode): void => { if (node.file) onSelect(node.file); else onToggle(node) }
    return rows.map(node => <FileTreeRow key={node.key} name={node.name} path={node.file?.path ?? node.name} depth={node.depth}
      isDirectory={!node.file} isExpanded={!collapsed.has(node.key)} isSelected={Boolean(node.file && selectedFile?.key === node.file.key)}
      title={node.file ? `${node.file.displayPath} · ${node.file.operations.length} 次操作` : node.name}
      onClick={() => activate(node)} onActivate={() => activate(node)}
      trailing={node.file ? <ChangeCount view={selectedFile?.key === node.file.key ? selectedView : defaultArtifactView(node.file)} /> : null} />)
  }, [rows, collapsed, selectedFile, selectedView, onSelect, onToggle])
  const treeKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const index = elements.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    const node = rows[index]
    if (event.key === 'ArrowRight' && !node.file && collapsed.has(node.key)) { onToggle(node, true); return }
    if (event.key === 'ArrowLeft' && !node.file && !collapsed.has(node.key)) { onToggle(node, false); return }
    const parent = event.key === 'ArrowLeft' ? rows.slice(0, index).findLastIndex(item => item.depth < node.depth) : -1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowLeft' ? parent
      : index + (event.key === 'ArrowUp' ? -1 : 1)
    elements[Math.max(0, Math.min(elements.length - 1, next))]?.focus()
  }
  useEffect(() => {
    if (!selectedFile) { lastRevealed.current = ''; return }
    if (!active) return
    const revealKey = JSON.stringify([selectedFile.key, selectionRevision])
    if (lastRevealed.current === revealKey) return
    const container = treeRef.current
    const selectedRow = container?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!container || !selectedRow) return
    lastRevealed.current = revealKey
    // Reveal inside the list only; scrollIntoView can also move pane ancestors.
    const bounds = container.getBoundingClientRect(), row = selectedRow.getBoundingClientRect()
    if (row.top < bounds.top) container.scrollTop -= bounds.top - row.top
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom
  }, [active, rows, selectedFile?.key, selectionRevision])
  return <div ref={treeRef} className="work-session-artifacts__tree" role="tree" aria-label="本会话文件树" onKeyDown={treeKeys}>
    {content}
  </div>
})

function ScopedSessionArtifacts({ sessionId, workspacePath: workspaceHint, ready, streaming, active = true, tools, messages, selection, onOpenCurrentFile, onAddToConversation, source }: SessionArtifactsProps & { source: number }): JSX.Element {
  const visible = useWorkbenchVisible()
  const enabled = Boolean(sessionId && ready && active && visible)
  const [records, setRecords] = useState<EngineFileChange[]>([])
  const [net, setNet] = useState<EngineFileChange[]>([])
  const [loaded, setLoaded] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [changeError, setError] = useState('')
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspacePending, setWorkspacePending] = useState(true)
  const [workspaceError, setWorkspaceError] = useState('')
  const error = workspaceError || changeError
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [choice, setChoice] = useState<SessionArtifactChoice | null>(() => selection?.sessionId === sessionId ? { kind: 'request', request: selection } : null)
  const [detailView, setDetailView] = useState<SessionArtifactDetailView | null>(selection?.sessionId === sessionId ? selection.view ?? (selection.changeId ? 'operation' : null) : null)
  const [requestWaiting, setRequestWaiting] = useState(false)
  const [turnScope, setTurnScope] = useState<SessionArtifactTurnScope>({ kind: 'session' })
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const lastSelection = useRef('')
  const report = useSyncExternalStore(subscribeReverts, () => getRevertReport(sessionId))
  const revision = useMemo(() => artifactToolRevision(sessionId, tools), [sessionId, tools])
  const refresh = useCallback(() => setRefreshRevision(value => value + 1), [])
  const requested = choice?.kind === 'request' && choice.request.path ? choice.request : null
  const requestKey = selectionKey(requested)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = (): boolean => alive && source === getEngineSource()
    const resolveWorkspace = async (): Promise<void> => {
      setWorkspacePending(true)
      try {
        // The same read-only resolver owns the workspace tree. A persisted
        // task hint may be absent or stale; it must never define this tree.
        const context = await sessionWorkspaceContext(sessionId, workspaceHint)
        if (!current()) return
        setWorkspacePath(context.root)
        setWorkspaceError('')
      } catch (reason) {
        if (!current()) return
        setWorkspaceError(reason instanceof Error ? reason.message : String(reason))
        timer = setTimeout(() => { void resolveWorkspace() }, sessionProgressRetryDelay(++failures))
      } finally { if (current()) setWorkspacePending(false) }
    }
    void resolveWorkspace()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [enabled, source, sessionId, workspaceHint, refreshRevision])

  useLayoutEffect(() => {
    const next = selectionKey(selection)
    if (lastSelection.current === next) return
    lastSelection.current = next
    if (!selection || selection.sessionId !== sessionId) return
    setChoice(selection.path ? { kind: 'request', request: selection } : null)
    setDetailView(selection.view ?? (selection.changeId ? 'operation' : null))
    setRequestWaiting(Boolean(selection.path))
    setQuery('')
    setTurnScope(selection.turnScope ?? { kind: 'session' })
    setCollapsed(new Set())
    refresh()
  }, [selection, sessionId, refresh])

  useLayoutEffect(() => {
    if (choice?.kind !== 'request' || !choice.request.changeId || choice.request.turnScope) return
    const requested = records.find(change => change.id === choice.request.changeId)
    if (!requested) return
    const owner = artifactChangeTurnScope(requested)
    setTurnScope(previous => artifactTurnScopeKey(previous) === artifactTurnScopeKey(owner) ? previous : owner)
  }, [choice, records])

  useEffect(() => {
    if (!enabled) return
    setRequestWaiting(Boolean(requested))
    let alive = true
    let failures = 0
    let missingAttempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const expectedEngine = getExpectedEngine()
    const current = (): boolean => alive && source === getEngineSource()
    const load = async (): Promise<void> => {
      setSyncing(true)
      try {
        const [history, pending] = await Promise.all([
          requestOrThrow<unknown>({ method: 'GET', path: '/changes', query: { sessionId }, expectedEngine }),
          requestOrThrow<unknown>({ method: 'GET', path: '/changes', query: { sessionId, status: 'pending', view: 'net' }, expectedEngine })
        ])
        if (!current()) return
        if (!Array.isArray(history) || !Array.isArray(pending)) throw new Error('文件改动响应格式无效，请重试')
        const log = ownedArtifactChanges(sessionId, history)
        setRecords(previous => reconcileArtifactChanges(previous, log))
        const nextNet = ownedArtifactChanges(sessionId, pending).filter(change => change.status === 'pending')
        setNet(previous => reconcileArtifactChanges(previous, nextNet))
        setLoaded(true)
        setError('')
        failures = 0
        const missing = requested && !artifactSelectionAvailable(sessionId, log, requested, workspacePath)
        const waiting = Boolean(missing && ++missingAttempts < 4)
        setRequestWaiting(waiting)
        if (waiting || streaming || log.some(change => change.status === 'pending')) timer = setTimeout(() => { void load() }, waiting ? 1000 : 4000)
      } catch (reason) {
        if (!current()) return
        if (++missingAttempts >= 4) setRequestWaiting(false)
        setError(reason instanceof Error ? reason.message : String(reason))
        timer = setTimeout(() => { void load() }, sessionProgressRetryDelay(++failures))
      } finally { if (current()) setSyncing(false) }
    }
    void load()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [enabled, source, sessionId, streaming, revision, report, refreshRevision, requestKey, workspacePath])

  const turnOptions = useMemo(() => buildArtifactTurnOptions(sessionId, messages, records), [sessionId, messages, records])
  const scopedChanges = useMemo(() => scopeArtifactChanges(sessionId, records, net, turnScope), [sessionId, records, net, turnScope])
  const scopedFiles = useMemo(() => {
    if (!workspacePath) return []
    const files = buildSessionArtifactFiles(sessionId, scopedChanges.records, scopedChanges.net, workspacePath)
    const preserveKey = requested?.path && (requested.changeId || requested.view === 'operation')
      ? sessionChangePathKey(requested.path, workspacePath) : undefined
    return filterSessionArtifactFiles(files, preserveKey)
  }, [sessionId, scopedChanges, workspacePath, requested])
  const files = useMemo(() => searchArtifactFiles(scopedFiles, query), [scopedFiles, query])
  const batchRecords = useMemo(() => files.flatMap(file => file.operations), [files])
  const uncombinedIds = useMemo(() => new Set(scopedChanges.uncombinedChangeIds), [scopedChanges])
  const tree = useMemo(() => buildSessionArtifactTree(files), [files])
  const selected = useMemo(() => resolveArtifactChoice(files, sessionId, choice, workspacePath), [files, sessionId, choice, workspacePath])
  const rows = useMemo(() => {
    const result: SessionArtifactTreeNode[] = []
    const visit = (nodes: SessionArtifactTreeNode[]): void => { for (const node of nodes) { result.push(node); if (!collapsed.has(node.key)) visit(node.children) } }
    visit(tree)
    return result
  }, [tree, collapsed])
  const selectedFile = selected?.file
  const currentDeleted = useMemo(() => Boolean(selectedFile && artifactFileIsDeleted(sessionId, selectedFile.path, records, workspacePath)), [sessionId, selectedFile, records, workspacePath])
  const prefersPreview = Boolean(selectedFile && sessionFilePrefersPreview(selectedFile.path))
  // A turn's files may have later edits. Its default must use that turn's
  // operation snapshot, even when a cross-turn net segment was excluded.
  const displayedView = detailView ?? (prefersPreview ? 'current' : turnScope.kind === 'turn' ? 'operation'
    : !selectedFile?.net.length ? 'current' : 'net')
  const selectedView = displayedView === 'current' || requested?.changeId && !selected?.view ? null : selected?.view?.scope === displayedView ? selected.view
    : selectedFile?.[displayedView === 'net' ? 'net' : 'operations'][0]
      ? { scope: displayedView, change: selectedFile[displayedView === 'net' ? 'net' : 'operations'][0] } : null
  const actionsDisabled = !enabled || Boolean(error) || !loaded || !workspacePath || workspacePending
  const missingRequested = Boolean(requested && (!selectedFile || requested.changeId && !selected?.view))
  const requestNotice = requestWaiting || !loaded ? '正在同步请求的文件与修改记录…' : '未找到请求的文件或修改记录。可刷新重试，或从文件树选择其他记录。'
  const batchLabel = `${turnScope.kind === 'session' ? '整个会话' : turnScope.kind === 'turn' ? '当前轮次' : '未关联轮次'}${query.trim() ? ' · 当前筛选' : ''}`
  const uncombinedCount = selectedFile?.operations.filter(change => uncombinedIds.has(change.id)).length ?? 0
  const selectedTurn = turnOptions.find(option => option.key === artifactTurnScopeKey(turnScope))
  const selectedVersions = selectedFile && selectedView ? selectedFile[selectedView.scope === 'net' ? 'net' : 'operations'] : []
  const selectedVersionIndex = selectedView ? selectedVersions.findIndex(change => change.id === selectedView.change.id) : -1
  const viewDescription = displayedView === 'current' ? '显示当前文件内容；轮次范围仅筛选涉及文件。'
    : uncombinedCount ? '跨轮次的净变化仅在“整个会话”查看。'
      : !selectedFile?.net.length ? '当前范围暂无待确认净变化，可查看修改记录。'
        : displayedView === 'net' ? '仅显示待确认的连续修改，不代表整个会话的累计差异。' : '查看所选修改发生时的前后内容。'
  const currentArtifact = useMemo(() => selectedFile ? currentArtifactForFile(selectedFile) : null, [selectedFile])
  const reviewContext = JSON.stringify([selectedFile?.key, displayedView, selectedView?.scope, selectedView?.change.id, artifactTurnScopeKey(turnScope), query])
  const currentReviewContext = useRef(reviewContext)
  currentReviewContext.current = reviewContext
  const refreshSelectedFile = (): void => {
    if (source !== getEngineSource()) return
    if (selectedFile) requestSessionPreview(source, sessionId, selectedFile.path, workspacePath)
    refresh()
  }
  const refreshReview = (): void => {
    if (source !== getEngineSource()) return
    // Completion retains the reviewed version only while that same context is
    // still visible. Switching files, filters or views owns the newer choice.
    if (currentReviewContext.current === reviewContext && selectedFile && selectedView) {
      const operation = selectedView.scope === 'operation' ? selectedView.change : selectedFile.operations.find(change =>
        change.id === selectedView.change.changeIds?.at(-1)) ?? selectedFile.operations[0]
      if (operation) {
        setChoice(choiceFor(selectedFile, { scope: 'operation', change: operation }))
        setDetailView('operation')
      }
    }
    refresh()
  }

  const changeTurnScope = (key: string): void => {
    const option = turnOptions.find(item => item.key === key)
    if (!option) return
    setTurnScope(option.scope)
    setChoice(null)
    setDetailView(null)
    setCollapsed(new Set())
  }

  const selectFile = useCallback((file: SessionArtifactFile): void => {
    if (file.key === selectedFile?.key) return
    setChoice(choiceFor(file))
    // A view belongs to the selected file. Carrying a text diff into an image
    // (or an empty net segment) otherwise hides a perfectly readable artifact.
    setDetailView(null)
  }, [selectedFile?.key])
  const toggleDirectory = useCallback((node: SessionArtifactTreeNode, expand?: boolean): void => setCollapsed(previous => {
    const next = new Set(previous)
    if (expand ?? previous.has(node.key)) next.delete(node.key)
    else next.add(node.key)
    return next
  }), [])
  const setScope = (scope: SessionArtifactDetailView): void => {
    if (!selectedFile) return
    setDetailView(scope)
    const change = scope === 'current' ? undefined : selectedFile[scope === 'net' ? 'net' : 'operations'][0]
    setChoice(change && scope !== 'current' ? choiceFor(selectedFile, { scope, change }) : choiceFor(selectedFile))
  }

  return <section className="work-session-artifacts" aria-label="本会话成果与改动" data-session-id={sessionId} aria-busy={syncing || workspacePending}>
    <div className="work-session-artifacts__toolbar" aria-label="文件改动范围与搜索">
      <div className="work-session-artifacts__controls">
        <div className="work-session-artifacts__turn" data-turn-scope={artifactTurnScopeKey(turnScope)}>
          <Select ariaLabel="文件改动轮次" value={artifactTurnScopeKey(turnScope)} title={selectedTurn ? turnOptionLabel(selectedTurn) : '查看文件范围'}
            triggerLabel={selectedTurn?.summary} width={360} panelClassName="work-artifact-picker work-session-artifacts__popover"
            options={turnOptions.map(option => ({ value: option.key, label: option.summary,
              description: option.createdAt ? `${option.timeSource === 'change' ? '首次修改' : '请求时间'} · ${new Date(option.createdAt).toLocaleString()}` : undefined }))}
            onChange={changeTurnScope} />
        </div>
        <label className="work-session-artifacts__search" title="搜索当前范围的全部文件"><span className="work-session-artifacts__control-label">搜索文件</span><Icon name="search" size={13} />
          <input className="ui-input ui-input--compact" type="search" aria-label="搜索当前范围文件" placeholder="搜索文件或路径" value={query} onChange={event => {
            const value = event.currentTarget.value
            const matching = searchArtifactFiles(scopedFiles, value)
            const next = resolveArtifactChoice(matching, sessionId, choice, workspacePath)?.file ?? matching[0]
            setQuery(value)
            // Filtering a still-visible file must retain its chosen historical
            // operation; only a newly selected file owns a fresh default view.
            if (next?.key !== selectedFile?.key) {
              setChoice(next ? choiceFor(next) : null)
              setDetailView(null)
            }
            setCollapsed(new Set())
          }} />
        </label>
        <button type="button" className="work-session-artifacts__refresh" aria-label="刷新" title="刷新文件记录与当前内容" disabled={!enabled || syncing} onClick={refreshSelectedFile}>
          {syncing ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
        </button>
      </div>
    </div>
    {error ? <div className="work-session-artifacts__error" role="alert"><span>改动同步失败，已保留上次记录。</span>
      <button type="button" disabled={!enabled || syncing} onClick={refreshSelectedFile}>重试</button><details><summary>查看原因</summary>{error}</details>
    </div> : null}
    <div className="work-session-artifacts__batch" aria-label={`${batchLabel}的文件改动操作`}>
      <header className="work-session-artifacts__header" title={`${batchLabel}${selectedTurn?.createdAt ? ` · ${turnOptionLabel(selectedTurn)}` : ''}${turnScope.kind === 'unassociated' ? ' · 这些记录未携带可靠的轮次标识，已单独列出。' : ''}`}>
        <span aria-label={`${query.trim() ? `${files.length} / ${scopedFiles.length}` : files.length} 个涉及文件`}>{query.trim() ? `${files.length} / ${scopedFiles.length}` : files.length} 个文件</span>
        {streaming && batchRecords.length ? <span className="work-session-artifacts__activity" role="status" title="任务正在运行，请结束后重新确认文件改动">任务运行中</span> : null}
      </header>
      <ChangeReviewActions sessionId={sessionId} workspacePath={workspacePath} changes={batchRecords} streaming={streaming} disabled={actionsDisabled}
        refreshing={syncing} onChanged={refreshReview} presentation="menu" compact showBlockedHint={false} />
    </div>
    {files.length ? <div className="work-session-artifacts__split">
      <ArtifactTree rows={rows} collapsed={collapsed} selectedFile={selectedFile} selectedView={selectedView ?? selected?.view ?? null} active={active}
        selectionRevision={selection?.revision} onSelect={selectFile} onToggle={toggleDirectory} />
      <div className="work-session-artifacts__detail">
        {selectedFile ? <header className="work-session-artifacts__file-header">
          <strong title={selectedFile.path}>{selectedFile.name}</strong>
          {!missingRequested ? <Select className="work-session-artifacts__view-select" ariaLabel="差异范围" title={viewDescription} value={displayedView} width={240} panelClassName="work-session-artifacts__popover"
            options={[
              { value: 'current', label: '当前内容', description: '读取当前文件，可预览、引用和保存' },
              { value: 'net', label: '待确认改动', description: '当前范围内仍待确认的连续修改' },
              { value: 'operation', label: '修改记录', description: '查看每次写入前后的历史内容' }
            ]} onChange={value => { if (value === 'current' || value === 'net' || value === 'operation') setScope(value) }} /> : null}
          <ChangeCount view={selectedView ?? defaultArtifactView(selectedFile)} />
          <Popover key={reviewContext} label="文件改动信息" className="work-session-artifacts__info" panelClassName="work-session-artifacts__popover work-session-artifacts__info-panel" align="end" width={320}
            trigger={({ open }) => <button type="button" className="work-session-artifacts__info-trigger" aria-label="文件改动信息" aria-expanded={open} title="文件路径、修改时间与范围说明"><Icon name="info" size={14} /></button>}>
            <dl>
              <div><dt>文件路径</dt><dd>{selectedFile.path}</dd></div>
              <div><dt>文件范围</dt><dd>{selectedTurn?.summary || batchLabel}</dd></div>
              {selectedTurn?.createdAt ? <div><dt>{selectedTurn.timeSource === 'change' ? '首次修改' : '请求时间'}</dt><dd><time>{new Date(selectedTurn.createdAt).toLocaleString()}</time></dd></div> : null}
              {selectedView ? <div><dt>当前记录</dt><dd>{artifactChangeStatus(selectedView.change.status)} · <time>{new Date(selectedView.change.createdAt).toLocaleString()}</time></dd></div> : null}
            </dl>
            <p>{viewDescription}</p>
            {turnScope.kind === 'unassociated' ? <p>这些记录未携带可靠的轮次标识，已单独列出。</p> : null}
          </Popover>
          {!currentDeleted ? <button type="button" aria-label="打开当前文件" title="打开当前文件" disabled={!enabled} onClick={() => onOpenCurrentFile(selectedFile.path)}><Icon name="file" size={15} /></button> : null}
        </header> : null}
        {missingRequested ? <p className="work-session-artifacts__empty" role="status">{requestNotice}</p> : selectedFile ? <>
          {selectedView ? <div className="work-session-artifacts__scope">
            {selectedView && selectedVersions.length > 1 ? <Select className="work-session-artifacts__versions"
              ariaLabel={selectedView.scope === 'net' ? '选择净变化片段' : '选择单次修改'} value={selectedView.change.id} width={280}
              panelClassName="work-session-artifacts__popover" title={`${new Date(selectedView.change.createdAt).toLocaleString()} · ${artifactChangeStatus(selectedView.change.status)}`}
              triggerLabel={selectedView.scope === 'net' ? `片段 ${selectedVersionIndex + 1} / ${selectedVersions.length}` : `记录 ${selectedVersions.length - selectedVersionIndex} / ${selectedVersions.length}`}
              options={selectedVersions.map((change, index) => ({ value: change.id,
                label: selectedView.scope === 'net' ? `片段 ${index + 1} · ${change.changeIds?.length ?? 1} 次修改` : new Date(change.createdAt).toLocaleString(),
                description: artifactChangeStatus(change.status) }))}
              onChange={value => {
                const change = selectedVersions.find(item => item.id === value)
                if (change) setChoice(choiceFor(selectedFile, { scope: selectedView.scope, change }))
            }} /> : selectedView?.scope === 'operation' && selectedView.change.status !== 'pending' ? <span className="work-session-artifacts__version-status" title={`${new Date(selectedView.change.createdAt).toLocaleString()} · ${artifactChangeStatus(selectedView.change.status)}`}>{artifactChangeStatus(selectedView.change.status)}</span> : null}
            {selectedView ? <ChangeReviewActions sessionId={sessionId} workspacePath={workspacePath} changes={[selectedView.change]} streaming={streaming} disabled={actionsDisabled}
              refreshing={syncing} onChanged={refreshReview} mode="single" compact showBlockedHint={false} /> : null}
          </div> : null}
          {displayedView === 'current' ? currentDeleted ? <DeletedArtifact path={selectedFile.path} /> : <>
            <div className="work-session-artifacts__preview" data-artifact-view="current">
              <ArtifactPanel artifact={currentArtifact} sessionId={sessionId} workspaceRoot={workspacePath} active={active}
                inResourceTab onAddToConversation={onAddToConversation} />
            </div>
          </> : <>
          {selectedView?.change.projectionIssue ? <p className="work-session-artifacts__notice" role="note">{ARTIFACT_PROJECTION_NOTICES[selectedView.change.projectionIssue]}</p> : null}
          {prefersPreview ? currentDeleted ? <DeletedArtifact path={selectedFile.path} /> : <>
            <p className="work-session-artifacts__notice" role="note">{selectedView?.change.kind === 'delete'
              ? '此记录删除了文件。下方读取当前路径；若文件已重新创建，显示重新创建后的内容。'
              : '此类文件不显示文本差异。下方预览当前文件，不代表所选历史版本。'}</p>
            <div className="work-session-artifacts__preview" data-artifact-view="current" data-preview-context="history">
              <ArtifactPanel artifact={currentArtifact} sessionId={sessionId} workspaceRoot={workspacePath} active={active}
                inResourceTab onAddToConversation={onAddToConversation} />
            </div>
          </> : selectedView ? <div className="work-session-artifacts__diff" data-change-id={selectedView.change.id} data-diff-scope={selectedView.scope}>
            <FileChangeCard key={`${selectedView.scope}:${selectedView.change.id}`} change={selectedView.change} state="done" defaultOpen embedded
              memoryKey={`work-artifacts:${source}:${sessionId}:${selectedView.scope}:${selectedView.change.id}`}
              fileContext={{ sessionId, workspaceRoot: workspacePath }} onOpenFile={onOpenCurrentFile} />
          </div> : <p className="work-session-artifacts__empty" role="status">{displayedView === 'net' ? '此文件在当前范围没有待确认改动。' : '此文件在当前范围没有修改记录。'}</p>}
          </>}
        </> : null}
      </div>
    </div> : <p className="work-session-artifacts__empty" role="status">{!ready ? '连接引擎后查看本会话的文件改动。' : workspacePending || syncing && !loaded ? '正在读取本会话的文件记录…' : error ? '文件记录暂未同步，请重试。'
      : missingRequested ? requestNotice
        : query.trim() ? '当前范围没有匹配的文件。' : turnScope.kind === 'session' ? records.length ? '本会话没有净文件变化。' : '本会话还没有文件改动。' : '当前轮次没有文件改动。'}</p>}
  </section>
}
