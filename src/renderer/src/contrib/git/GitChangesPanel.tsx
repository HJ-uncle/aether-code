/**
 * Git 变更面板主容器（移植自 wuzu-client 的 GitChangesPanel.vue）
 *
 * 为什么存在：Agent 会在用户工作区直接改文件，用户需要一个不依赖 Agent 自述的
 * 核对手段 —— 「它到底动了哪些文件 / 现在能提交什么 / 历史上做过什么」在这里一眼可见。
 *
 * 结构对齐 VSCode 源代码管理面板与 wuzu 源组件，自上而下：
 *   1. 顶部工具条：变更计数 + 视图/排序菜单 + pull/push/fetch/refresh + 更多操作二级菜单
 *   2. 分支条（GitBranchBar）+ 同步按钮（GitSyncButton）+ 提交条（GitCommitBar）
 *   3. 多选批量操作条（选中 ≥2 时出现）
 *   4. 内容区：合并冲突横幅 → 合并更改组 → 暂存的更改组 → 更改组 → 提交历史 → 存储
 *   5. 底部汇总（+增/-删行数）
 *   6. 非仓库态 / 克隆流程中的空态
 *
 * 与源组件的关键偏差（aether 侧没有对应宿主能力）：
 *   - 行点击打开 diff：源组件在右侧编辑区内嵌 diff 编辑器；aether 没有 diff 编辑器宿主，
 *     退化为 loadDiff(path, staged) 填充 store + openFile 打开文件（偏差已上报）。
 *   - 「定位到产生该更改的会话」依赖 wuzu 的 codeChange 记录与会话库，aether 没有，菜单项省略。
 *   - 冲突文件的「按文本侧解决」依赖编辑器读写链路与 gitConflictParser，aether 未移植，
 *     保留冲突组展示与「去解决冲突」打开文件，批量解决按钮保留但走打开文件引导。
 *   - 弹窗体系：Element Plus 的 ElMessageBox 换成 aether 的 Dialog/PromptDialog/ContextMenu。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { GitFileChange, GitLogEntry, GitStashEntry } from '@shared/git-types'
import { documentKey, openFile } from '@renderer/core/editor/editor-store'
import { startCloneFlow, useGitCloneFlow } from '@renderer/core/git/git-clone-flow'
import {
  changeCountOf,
  conflictFilesOf,
  createBranch,
  createTag,
  deleteTag,
  discardFile,
  discardFiles,
  fetchRemote,
  gitInitRepo,
  loadCurrentUser,
  loadDiff,
  loadHistoryAuthors,
  loadLog,
  loadStashes,
  loadTags,
  mergeAbort,
  pull,
  push,
  pushTag,
  pushTags,
  refreshGit,
  reloadLog,
  revertCommit,
  cherryPick,
  setHistoryFilter,
  stagedFilesOf,
  stageFiles,
  stashApply,
  stashDrop,
  stashPop,
  stashPush,
  totalAdditionsOf,
  totalDeletionsOf,
  unstage,
  stage,
  unstagedFilesOf,
  unstageFiles,
  useGitStore,
  busyOperationOf
} from '@renderer/core/git/git-store'
import { setLayout } from '@renderer/core/platform/layout-state'
import { paths } from '@renderer/core/workspace/fs-client'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { Dialog } from '@renderer/workbench/Dialog'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { Select } from '@renderer/workbench/Select'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { GitBranchBar } from './GitBranchBar'
import { GitChangeRow } from './GitChangeRow'
import { GitChangeTreeNode, type GitChangeTreeNodeData } from './GitChangeTreeNode'
import { GitCommitBar } from './GitCommitBar'
import { GitCommitDetailDialog } from './GitCommitDetailDialog'
import { GitCommitHoverCard } from './GitCommitHoverCard'
import { GitHistoryGraph } from './GitHistoryGraph'
import { buildHistoryViewModels } from '@renderer/core/git/git-history-graph'
import { GitCloneDialog } from './GitCloneDialog'
import { GitCloneOverlay } from './GitCloneOverlay'
import { configureGitCloneFlow } from './clone-hooks'
import { GitPickDialog } from './GitPickDialog'
import { GitStashHoverCard } from './GitStashHoverCard'
import { GitSyncButton } from './GitSyncButton'

/** 历史每页大小，对齐源组件 LOG_PAGE_SIZE */
const LOG_PAGE_SIZE = 50

type ChangeGroup = 'staged' | 'unstaged' | 'conflict'
type ViewMode = 'list' | 'tree'
type SortBy = 'path' | 'status'

/** 状态排序权重：新增 > 修改 > 删除 > 重命名 > 复制 > 未跟踪（对齐源组件 STATUS_ORDER） */
const STATUS_ORDER: Record<string, number> = {
  added: 0,
  modified: 1,
  deleted: 2,
  renamed: 3,
  copied: 4,
  untracked: 5
}

function sortFiles(files: GitFileChange[], sortBy: SortBy): GitFileChange[] {
  const arr = [...files]
  if (sortBy === 'path') {
    arr.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
  } else {
    arr.sort((a, b) => {
      const diff = (STATUS_ORDER[a.changeType] ?? 9) - (STATUS_ORDER[b.changeType] ?? 9)
      return diff !== 0 ? diff : a.path.localeCompare(b.path, 'zh-CN')
    })
  }
  return arr
}

/** 把平铺文件列表组装成目录树（供 GitChangeTreeNode 渲染），对齐源 buildTree */
function buildTree(files: GitFileChange[]): GitChangeTreeNodeData[] {
  const roots: GitChangeTreeNodeData[] = []
  const dirMap = new Map<string, GitChangeTreeNodeData>()
  for (const file of files) {
    const parts = file.path.split('/')
    let curPath = ''
    let parentChildren = roots
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLeaf = i === parts.length - 1
      curPath = curPath ? `${curPath}/${part}` : part
      if (isLeaf) {
        parentChildren.push({ key: curPath, name: part, isDir: false, file })
      } else {
        let dir = dirMap.get(curPath)
        if (!dir) {
          dir = { key: curPath, name: part, isDir: true, children: [] }
          dirMap.set(curPath, dir)
          parentChildren.push(dir)
        }
        parentChildren = dir.children ?? []
      }
    }
  }
  const sortLevel = (nodes: GitChangeTreeNodeData[]): void => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    for (const n of nodes) if (n.children) sortLevel(n.children)
  }
  sortLevel(roots)
  return roots
}

/** 提交时间显示：短格式 MM-dd HH:mm（对齐源 formatCommitDate） */
function formatCommitDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** stash 时间：ISO → 中文相对时间，超过一周显示具体日期 */
function formatStashDate(iso?: string): string {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return iso
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)} 天前`
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** stash 默认消息前缀「On <branch>:」——拆出分支单独展示 */
const STASH_DEFAULT_RE = /^On ([^:]+):\s*/
function stashDisplayMessage(message: string): string {
  const m = STASH_DEFAULT_RE.exec(message)
  const rest = m ? message.slice(m[0].length).trim() : message.trim()
  return rest || '（无说明）'
}
function stashBranchLabel(message: string): string {
  return STASH_DEFAULT_RE.exec(message)?.[1] ?? ''
}

function fileNameOnly(path: string): string {
  return path.split('/').pop() ?? path
}
function dirNameOnly(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

/** 提交文件状态码颜色（对齐源 commitCodeColor） */
function commitCodeClass(code: string): string {
  switch (code) {
    case 'A':
    case 'U':
      return 'is-added'
    case 'D':
      return 'is-deleted'
    case 'R':
      return 'is-renamed'
    default:
      return 'is-modified'
  }
}

/** 历史视图模型：泳道几何由 core/git/git-history-graph 的 buildHistoryViewModels 预计算 */
interface HistoryVM {
  hash: string
  commit: GitLogEntry
  isIncoming: boolean
  graph: import('@renderer/core/git/git-history-graph').HistoryItemViewModel
}

interface ConfirmState {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

interface PromptState {
  title: string
  label: string
  initialValue?: string
  allowEmpty?: boolean
  resolve: (value: string | null) => void
}

interface PickState {
  title: string
  description: string
  options: { value: string; label?: string; hint?: string; description?: string }[]
  resolve: (value: string | null) => void
}

interface StashDetailState {
  index: number
  branch: string
  message: string
  date: string
  hash: string
}

interface HoverCardState {
  visible: boolean
  commit: GitLogEntry | null
  anchor: DOMRect | null
}
interface StashHoverState {
  visible: boolean
  stash: GitStashEntry | null
  anchor: DOMRect | null
}

export function GitChangesPanel(): JSX.Element {
  const git = useGitStore()
  const cloneFlow = useGitCloneFlow()

  // 克隆流程的宿主回调（目录选择/确认/打开工作区）幂等注入一次。
  useEffect(() => {
    configureGitCloneFlow()
  }, [])

  // ---------- 展开态 ----------
  const [stagedExpanded, setStagedExpanded] = useState(true)
  const [unstagedExpanded, setUnstagedExpanded] = useState(true)
  const [conflictExpanded, setConflictExpanded] = useState(true)
  const [stashExpanded, setStashExpanded] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortBy, setSortBy] = useState<SortBy>('path')
  const [initializing, setInitializing] = useState(false)
  const [notice, setNotice] = useState('')

  // ---------- 菜单 ----------
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [viewMenuPos, setViewMenuPos] = useState({ x: 0, y: 0 })
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [moreMenuPos, setMoreMenuPos] = useState({ x: 0, y: 0 })
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file: GitFileChange
  } | null>(null)
  const [commitMenu, setCommitMenu] = useState<{
    x: number
    y: number
    commit: GitLogEntry
  } | null>(null)

  // ---------- 对话框 ----------
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [pickState, setPickState] = useState<PickState | null>(null)
  const [commitDetailHash, setCommitDetailHash] = useState('')
  const [stashDetail, setStashDetail] = useState<StashDetailState | null>(null)

  // ---------- 多选 ----------
  const [selection, setSelection] = useState<Map<string, GitFileChange>>(new Map())
  const selectionAnchorRef = useRef('')
  const [batchBusy, setBatchBusy] = useState(false)
  const panelRootRef = useRef<HTMLDivElement>(null)

  // ---------- 历史 ----------
  const [expandedCommitHash, setExpandedCommitHash] = useState('')
  const [commitHover, setCommitHover] = useState<HoverCardState>({
    visible: false,
    commit: null,
    anchor: null
  })
  const commitHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // ---------- stash ----------
  const [stashHover, setStashHover] = useState<StashHoverState>({
    visible: false,
    stash: null,
    anchor: null
  })
  const stashHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [stashSelectionMode, setStashSelectionMode] = useState(false)
  const [stashSelected, setStashSelected] = useState<Set<number>>(new Set())
  const [stashBatchDropping, setStashBatchDropping] = useState(false)

  // ---------- 派生数据（useMemo 隔离，store 无 selector 会整体重渲染） ----------
  const staged = useMemo(() => sortFiles(stagedFilesOf(git), sortBy), [git, sortBy])
  const unstaged = useMemo(() => sortFiles(unstagedFilesOf(git), sortBy), [git, sortBy])
  const conflicts = useMemo(() => sortFiles(conflictFilesOf(git), sortBy), [git, sortBy])
  const stagedTree = useMemo(() => buildTree(staged), [staged])
  const unstagedTree = useMemo(() => buildTree(unstaged), [unstaged])
  const changeCount = changeCountOf(git)
  const totalAdditions = totalAdditionsOf(git)
  const totalDeletions = totalDeletionsOf(git)
  const busyOperation = busyOperationOf(git)
  const gitBusy = git.committing || busyOperation !== ''

  const historyFilterActive =
    git.historySearch.trim() !== '' ||
    git.historyAuthor.trim() !== '' ||
    git.historyRef.trim() !== ''

  const historyVMs = useMemo<HistoryVM[]>(() => {
    // 无过滤时把远端领先提交拼在本地历史之上；过滤态不拼（与 incoming 重叠会撞 key）
    const showIncoming =
      !historyFilterActive && git.commits.length > 0 && git.incomingCommits.length > 0
    const merged = showIncoming ? [...git.incomingCommits, ...git.commits] : git.commits
    const incomingHashes = new Set(git.incomingCommits.map((c) => c.hash))
    const graphs = buildHistoryViewModels(merged, git.commits[0]?.hash ?? '')
    return merged.map((commit, i) => ({
      hash: commit.hash,
      commit,
      isIncoming: showIncoming && incomingHashes.has(commit.hash),
      graph: graphs[i]
    }))
  }, [git.commits, git.incomingCommits, historyFilterActive])

  // ---------- 通用弹窗辅助 ----------
  const confirmAction = useCallback(
    (message: string, title: string, confirmLabel = '确定', danger = false): Promise<boolean> =>
      new Promise((resolve) => {
        setConfirmState({ title, message, confirmLabel, danger, resolve })
      }),
    []
  )

  const promptInput = useCallback(
    (
      title: string,
      label: string,
      options: { initialValue?: string; allowEmpty?: boolean } = {}
    ): Promise<string | null> =>
      new Promise((resolve) => {
        setPromptState({
          title,
          label,
          initialValue: options.initialValue,
          allowEmpty: options.allowEmpty,
          resolve
        })
      }),
    []
  )

  const pickOption = useCallback(
    (title: string, description: string, options: PickState['options']): Promise<string | null> =>
      new Promise((resolve) => {
        setPickState({ title, description, options, resolve })
      }),
    []
  )

  // ---------- 文件打开 ----------
  const toAbsolute = useCallback(
    (path: string): string => {
      if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')) return path
      return paths.join(git.cwd, path)
    },
    [git.cwd]
  )

  const openSourceFile = useCallback(
    (path: string): void => {
      const abs = toAbsolute(path)
      void openFile(abs)
      setLayout({ activeEditorView: documentKey(abs) })
    },
    [toAbsolute]
  )

  /**
   * 行点击加载 diff。源组件在内嵌 diff 编辑器里展示；aether 没有 diff 编辑器宿主，
   * 退化为：loadDiff 填 store（供 gutter/hunk 高亮消费）+ 打开文件本身。
   */
  const handleSelectFile = useCallback(
    async (file: GitFileChange): Promise<void> => {
      await loadDiff(file.path, file.staged)
      openSourceFile(file.path)
    },
    [openSourceFile]
  )

  // ---------- 多选逻辑 ----------
  const rowKey = (group: ChangeGroup, path: string): string => `${group}:${path}`
  const groupList = useCallback(
    (group: ChangeGroup): GitFileChange[] =>
      group === 'staged' ? staged : group === 'unstaged' ? unstaged : conflicts,
    [staged, unstaged, conflicts]
  )

  const handleRowSelect = useCallback(
    (group: ChangeGroup, file: GitFileChange, event: React.MouseEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        const key = rowKey(group, file.path)
        setSelection((prev) => {
          const next = new Map(prev)
          if (next.has(key)) next.delete(key)
          else next.set(key, file)
          return next
        })
        selectionAnchorRef.current = key
        return
      }
      if (event.shiftKey) {
        const list = groupList(group)
        const targetIdx = list.findIndex((f) => f.path === file.path)
        if (targetIdx < 0) return
        const anchorIdx = selectionAnchorRef.current
          ? list.findIndex((f) => rowKey(group, f.path) === selectionAnchorRef.current)
          : -1
        const from = anchorIdx >= 0 ? Math.min(anchorIdx, targetIdx) : targetIdx
        const to = anchorIdx >= 0 ? Math.max(anchorIdx, targetIdx) : targetIdx
        setSelection(() => {
          const next = new Map<string, GitFileChange>()
          for (let i = from; i <= to; i++) next.set(rowKey(group, list[i].path), list[i])
          return next
        })
        return
      }
      selectionAnchorRef.current = rowKey(group, file.path)
      setSelection(new Map([[rowKey(group, file.path), file]]))
      void handleSelectFile(file)
    },
    [groupList, handleSelectFile]
  )

  const clearSelection = useCallback((): void => setSelection(new Map()), [])

  const pathsOfGroup = useCallback(
    (group: ChangeGroup): string[] => {
      const prefix = `${group}:`
      return [...selection.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
    [selection]
  )
  const selectedWorktreePaths = useMemo(
    () => [...new Set([...pathsOfGroup('unstaged'), ...pathsOfGroup('conflict')])],
    [pathsOfGroup]
  )
  const selectedStagedPaths = useMemo(() => pathsOfGroup('staged'), [pathsOfGroup])
  const selectedDiscardablePaths = useMemo(
    () => [...new Set([...pathsOfGroup('unstaged'), ...pathsOfGroup('staged')])],
    [pathsOfGroup]
  )

  // 列表刷新后剔除已消失的行。刻意放在渲染期做（React 认可的 derived-state 调整
  // 模式），而非 effect 里 setState —— 后者会触发级联渲染并被
  // react-hooks/set-state-in-effect 拦截。
  const [prevGroups, setPrevGroups] = useState({ staged, unstaged, conflicts })
  const groupsChanged =
    staged !== prevGroups.staged ||
    unstaged !== prevGroups.unstaged ||
    conflicts !== prevGroups.conflicts
  if (groupsChanged) {
    setPrevGroups({ staged, unstaged, conflicts })
    if (selection.size > 0) {
      const alive = new Set<string>()
      for (const f of staged) alive.add(rowKey('staged', f.path))
      for (const f of unstaged) alive.add(rowKey('unstaged', f.path))
      for (const f of conflicts) alive.add(rowKey('conflict', f.path))
      let changed = false
      const next = new Map(selection)
      for (const key of [...next.keys()]) {
        if (!alive.has(key)) {
          next.delete(key)
          changed = true
        }
      }
      if (changed) setSelection(next)
    }
  }

  // 多选锚点（Shift 范围选的起点）也是易失状态：其指向的行被刷掉后清空。
  // ref 只能在 effect/事件里读写，不能放进上面的渲染期分支。
  useEffect(() => {
    if (!groupsChanged) return
    const anchor = selectionAnchorRef.current
    if (!anchor) return
    const alive = new Set<string>()
    for (const f of staged) alive.add(rowKey('staged', f.path))
    for (const f of unstaged) alive.add(rowKey('unstaged', f.path))
    for (const f of conflicts) alive.add(rowKey('conflict', f.path))
    if (!alive.has(anchor)) selectionAnchorRef.current = ''
  }, [groupsChanged, staged, unstaged, conflicts])

  // Ctrl+A 全选 / Esc 取消选择（限定焦点在面板内）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const root = panelRootRef.current
      if (!root || !root.contains(event.target as Node)) return
      if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
        const el = event.target as HTMLElement
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
        event.preventDefault()
        const next = new Map<string, GitFileChange>()
        for (const group of ['conflict', 'staged', 'unstaged'] as ChangeGroup[]) {
          for (const f of groupList(group)) next.set(rowKey(group, f.path), f)
        }
        setSelection(next)
        return
      }
      if (event.key === 'Escape' && selection.size > 0) {
        event.preventDefault()
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [groupList, selection.size, clearSelection])

  // ---------- 行操作 ----------
  const handleToggleStage = useCallback(async (file: GitFileChange): Promise<void> => {
    const res = file.staged ? await unstage(file.path) : await stage(file.path)
    if (!res.success) setNotice(res.error ?? '操作失败')
  }, [])

  const handleDiscard = useCallback(
    async (file: GitFileChange): Promise<void> => {
      const ok = await confirmAction(
        file.staged
          ? `确定放弃 ${file.path} 的暂存更改？此操作不可撤销。`
          : `确定放弃 ${file.path} 的工作区更改？此操作不可撤销。`,
        '放弃更改',
        '放弃更改',
        true
      )
      if (!ok) return
      const res = file.staged ? await unstage(file.path) : await discardFile(file.path)
      if (!res.success) setNotice(res.error ?? '操作失败')
    },
    [confirmAction]
  )

  const handleBatchStage = useCallback(async (): Promise<void> => {
    if (selectedWorktreePaths.length === 0 || batchBusy) return
    setBatchBusy(true)
    try {
      const res = await stageFiles(selectedWorktreePaths)
      if (res.success) clearSelection()
      else setNotice(res.error ?? '暂存失败')
    } finally {
      setBatchBusy(false)
    }
  }, [selectedWorktreePaths, batchBusy, clearSelection])

  const handleBatchUnstage = useCallback(async (): Promise<void> => {
    if (selectedStagedPaths.length === 0 || batchBusy) return
    setBatchBusy(true)
    try {
      const res = await unstageFiles(selectedStagedPaths)
      if (res.success) clearSelection()
      else setNotice(res.error ?? '取消暂存失败')
    } finally {
      setBatchBusy(false)
    }
  }, [selectedStagedPaths, batchBusy, clearSelection])

  const handleBatchDiscard = useCallback(async (): Promise<void> => {
    if (selectedDiscardablePaths.length === 0 || batchBusy) return
    const ok = await confirmAction(
      `确定放弃所选 ${selectedDiscardablePaths.length} 个文件的更改？此操作不可撤销。`,
      '批量放弃更改',
      '放弃更改',
      true
    )
    if (!ok) return
    setBatchBusy(true)
    try {
      const res = await discardFiles(selectedDiscardablePaths)
      if (res.success) clearSelection()
      else setNotice(res.error ?? '放弃更改失败')
    } finally {
      setBatchBusy(false)
    }
  }, [selectedDiscardablePaths, batchBusy, confirmAction, clearSelection])

  const handleStageAll = useCallback(async (): Promise<void> => {
    const paths = unstaged.map((f) => f.path)
    if (paths.length === 0) return
    const res = await stageFiles(paths)
    if (!res.success) setNotice(res.error ?? '操作失败')
  }, [unstaged])

  const handleUnstageAll = useCallback(async (): Promise<void> => {
    const paths = staged.map((f) => f.path)
    if (paths.length === 0) return
    const res = await unstageFiles(paths)
    if (!res.success) setNotice(res.error ?? '操作失败')
  }, [staged])

  const handleDiscardAll = useCallback(async (): Promise<void> => {
    const paths = [...new Set(unstaged.map((f) => f.path))]
    if (paths.length === 0) return
    const ok = await confirmAction(
      `确定放弃 ${paths.length} 个文件的工作区更改？已暂存的内容会保留。此操作不可撤销。`,
      '全部放弃更改',
      '放弃更改',
      true
    )
    if (!ok) return
    const res = await discardFiles(paths)
    if (!res.success) setNotice(res.error ?? '操作失败')
  }, [unstaged, confirmAction])

  // ---------- 远端操作 ----------
  const [remoteBusy, setRemoteBusy] = useState('')
  const handleRemote = useCallback(
    async (action: 'pull' | 'push' | 'fetch'): Promise<void> => {
      if (gitBusy || remoteBusy) return
      setRemoteBusy(action)
      try {
        const res =
          action === 'pull' ? await pull() : action === 'push' ? await push() : await fetchRemote()
        if (!res.success) setNotice(res.error ?? '操作失败')
      } finally {
        setRemoteBusy('')
      }
    },
    [gitBusy, remoteBusy]
  )

  // ---------- 初始化 / 克隆 ----------
  const handleInit = useCallback(async (): Promise<void> => {
    if (initializing) return
    setInitializing(true)
    try {
      const res = await gitInitRepo()
      if (!res.success) setNotice(res.error ?? '初始化失败')
    } finally {
      setInitializing(false)
    }
  }, [initializing])

  // ---------- 历史 ----------
  useEffect(() => {
    if (!historyExpanded) return
    void loadCurrentUser()
    void loadHistoryAuthors()
    if (git.commits.length === 0) void loadLog(LOG_PAGE_SIZE)
    // 仅首次展开触发；commits 由 store 管，不作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyExpanded])

  const handleHistoryFilterInput = useCallback((value: string): void => {
    void setHistoryFilter({ search: value })
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current)
    historyDebounceRef.current = setTimeout(() => {
      historyDebounceRef.current = null
      void reloadLog(LOG_PAGE_SIZE)
    }, 300)
  }, [])

  const handleHistoryFilterChange = useCallback((): void => {
    if (historyDebounceRef.current) {
      clearTimeout(historyDebounceRef.current)
      historyDebounceRef.current = null
    }
    void reloadLog(LOG_PAGE_SIZE)
  }, [])

  const clearAllHistoryFilter = useCallback((): void => {
    void setHistoryFilter({ search: '', author: '', ref: '' })
    void reloadLog(LOG_PAGE_SIZE)
  }, [])

  // 「加载更多」哨兵：进入视口自动翻页
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadLog(LOG_PAGE_SIZE, true)
      },
      { rootMargin: '60px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [historyExpanded, historyFilterActive, git.logExhausted, git.commits.length])

  const isMyCommit = useCallback(
    (commit: GitLogEntry): boolean => !!git.currentUser && commit.author === git.currentUser,
    [git.currentUser]
  )
  const isTodayCommit = useCallback((commit: GitLogEntry): boolean => {
    const d = new Date(commit.date)
    if (Number.isNaN(d.getTime())) return false
    const now = new Date()
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    )
  }, [])

  const toggleCommitExpand = useCallback((hash: string): void => {
    setExpandedCommitHash((prev) => (prev === hash ? '' : hash))
  }, [])

  // 提交 hover 卡片：400ms 延迟显示，离开 150ms 后关闭（对齐 VSCode hover 交互）
  const handleCommitHover = useCallback(
    (vm: HistoryVM, event: React.MouseEvent<HTMLElement>): void => {
      if (commitMenu) return
      if (commitHover.commit?.hash === vm.hash && commitHover.visible) return
      if (commitHoverTimerRef.current) clearTimeout(commitHoverTimerRef.current)
      const el = event.currentTarget
      commitHoverTimerRef.current = setTimeout(() => {
        setCommitHover({ visible: true, commit: vm.commit, anchor: el.getBoundingClientRect() })
      }, 400)
    },
    [commitMenu, commitHover]
  )
  const handleCommitHoverLeave = useCallback((): void => {
    if (commitHoverTimerRef.current) clearTimeout(commitHoverTimerRef.current)
    commitHoverTimerRef.current = setTimeout(() => {
      setCommitHover((prev) => ({ ...prev, visible: false }))
    }, 150)
  }, [])
  const keepCommitHover = useCallback((): void => {
    if (commitHoverTimerRef.current) clearTimeout(commitHoverTimerRef.current)
    commitHoverTimerRef.current = null
  }, [])
  const hideCommitHover = useCallback((): void => {
    setCommitHover((prev) => ({ ...prev, visible: false }))
  }, [])

  const handleCopyHash = useCallback(async (hash: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash)
      setNotice('已复制提交哈希')
    } catch {
      setNotice('复制失败')
    }
  }, [])

  const commitMenuAction = useCallback(
    async (action: string): Promise<void> => {
      const commit = commitMenu?.commit
      setCommitMenu(null)
      if (!commit) return
      switch (action) {
        case 'detail':
          setCommitDetailHash(commit.hash)
          return
        case 'create-branch': {
          const name = await promptInput(
            `基于提交 ${commit.shortHash} 创建并切换到新分支`,
            '分支名'
          )
          if (!name) return
          const res = await createBranch(name, commit.hash)
          if (res.success) await loadLog()
          else setNotice(res.error ?? '创建失败')
          return
        }
        case 'copy-hash':
          await handleCopyHash(commit.hash)
          return
        case 'copy-message': {
          const full = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject
          try {
            await navigator.clipboard.writeText(full)
            setNotice('已复制提交信息')
          } catch {
            setNotice('复制失败')
          }
          return
        }
        case 'cherry-pick': {
          const res = await cherryPick(commit.hash)
          if (res.success) await loadLog()
          else {
            setNotice(res.error ?? '拣选失败')
            await refreshGit(git.cwd)
          }
          return
        }
        case 'revert': {
          const ok = await confirmAction(
            `确定反转提交 ${commit.shortHash}（${commit.subject}）？将生成一个反向提交。`,
            '反转提交',
            '反转',
            true
          )
          if (!ok) return
          const res = await revertCommit(commit.hash)
          if (res.success) await loadLog()
          else setNotice(res.error ?? '反转失败')
          return
        }
      }
    },
    [commitMenu, promptInput, handleCopyHash, confirmAction, git.cwd]
  )

  // ---------- stash ----------
  const handleStashApply = useCallback(async (index?: number): Promise<void> => {
    const res = await stashApply(index)
    if (!res.success) setNotice(res.error ?? '恢复失败')
  }, [])
  const handleStashPop = useCallback(async (index?: number): Promise<void> => {
    const res = await stashPop(index)
    if (!res.success) setNotice(res.error ?? '恢复失败')
  }, [])
  const handleStashDrop = useCallback(
    async (index: number): Promise<void> => {
      const ok = await confirmAction(
        `确定删除存储 ${index}？其中保存的改动将不可恢复。`,
        '删除存储',
        '删除',
        true
      )
      if (!ok) return
      const res = await stashDrop(index)
      if (!res.success) setNotice(res.error ?? '删除失败')
    },
    [confirmAction]
  )
  const handleStashView = useCallback(
    (index: number): void => {
      const stash = git.stashes.find((s) => s.index === index)
      setStashDetail({
        index,
        branch: stash ? stashBranchLabel(stash.message) : '',
        message: stash ? stashDisplayMessage(stash.message) : '',
        date: stash?.date ?? '',
        hash: stash?.hash ?? ''
      })
    },
    [git.stashes]
  )

  const handleStashHover = useCallback(
    (stash: GitStashEntry, event: React.MouseEvent<HTMLElement>): void => {
      if (stashHover.stash?.index === stash.index && stashHover.visible) return
      if (stashHoverTimerRef.current) clearTimeout(stashHoverTimerRef.current)
      const el = event.currentTarget
      stashHoverTimerRef.current = setTimeout(() => {
        setStashHover({ visible: true, stash, anchor: el.getBoundingClientRect() })
      }, 400)
    },
    [stashHover]
  )
  const handleStashHoverLeave = useCallback((): void => {
    if (stashHoverTimerRef.current) clearTimeout(stashHoverTimerRef.current)
    stashHoverTimerRef.current = setTimeout(() => {
      setStashHover((prev) => ({ ...prev, visible: false }))
    }, 150)
  }, [])
  const keepStashHover = useCallback((): void => {
    if (stashHoverTimerRef.current) clearTimeout(stashHoverTimerRef.current)
    stashHoverTimerRef.current = null
  }, [])
  const hideStashHover = useCallback((): void => {
    setStashHover((prev) => ({ ...prev, visible: false }))
  }, [])

  const toggleStashSelect = useCallback((index: number): void => {
    setStashSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])
  const handleStashDropBatch = useCallback(async (): Promise<void> => {
    const indexes = [...stashSelected].sort((a, b) => a - b)
    if (indexes.length === 0 || stashBatchDropping) return
    const ok = await confirmAction(
      `确定删除所选 ${indexes.length} 条存储？删除后无法恢复。`,
      '批量删除存储',
      '删除',
      true
    )
    if (!ok) return
    setStashBatchDropping(true)
    try {
      // 倒序逐条 drop，避免重排导致索引失效（对齐源组件 stashDropBatch 语义）
      for (const index of [...indexes].reverse()) {
        await stashDrop(index)
      }
      setStashSelectionMode(false)
      setStashSelected(new Set())
      await loadStashes()
    } finally {
      setStashBatchDropping(false)
    }
  }, [stashSelected, stashBatchDropping, confirmAction])

  // ---------- tag ----------
  const handleCreateTag = useCallback(async (): Promise<void> => {
    const name = await promptInput('创建标签', '标签名')
    if (!name) return
    const message = await promptInput('标签说明（可选，留空即轻量标签）', '说明', {
      allowEmpty: true
    })
    if (message === null) return
    const res = await createTag(name, message || undefined)
    if (!res.success) setNotice(res.error ?? '创建失败')
  }, [promptInput])

  const handleDeleteTag = useCallback(async (): Promise<void> => {
    await loadTags()
    if (git.tags.length === 0) {
      setNotice('当前没有标签')
      return
    }
    const picked = await pickOption(
      '删除标签…',
      '选择要删除的本地标签',
      git.tags.map((t) => ({ value: t }))
    )
    if (!picked) return
    const ok = await confirmAction(`确定删除标签 ${picked}？`, '删除标签', '删除', true)
    if (!ok) return
    const res = await deleteTag(picked)
    if (!res.success) setNotice(res.error ?? '删除失败')
  }, [git.tags, pickOption, confirmAction])

  const handlePushTag = useCallback(async (): Promise<void> => {
    await loadTags()
    if (git.tags.length === 0) {
      setNotice('当前没有标签')
      return
    }
    const picked = await pickOption(
      '推送标签…',
      '选择要推送到 origin 的标签',
      git.tags.map((t) => ({ value: t }))
    )
    if (!picked) return
    const res = await pushTag(picked)
    if (!res.success) setNotice(res.error ?? '推送失败')
  }, [git.tags, pickOption])

  // ---------- 「更多操作」二级菜单 ----------
  interface MoreMenuGroup {
    key: string
    label: string
    icon: IconName
    items: { action: string; label: string; disabled?: boolean }[]
  }
  const moreMenuGroups: MoreMenuGroup[] = useMemo(
    () => [
      {
        key: 'sync',
        label: '拉取，推送',
        icon: 'git',
        items: [
          { action: 'sync', label: '同步' },
          { action: 'pull', label: '拉取' },
          { action: 'push', label: '推送' },
          { action: 'pushTags', label: '推送所有标签' }
        ]
      },
      {
        key: 'commit',
        label: '提交',
        icon: 'check',
        items: [{ action: 'commitEmpty', label: '空提交' }]
      },
      {
        key: 'branch',
        label: '分支',
        icon: 'git',
        items: [{ action: 'mergeAbort', label: '中止合并', disabled: !git.merging }]
      },
      {
        key: 'stash',
        label: '存储',
        icon: 'git',
        items: [
          { action: 'stashPush', label: '存储当前更改…' },
          {
            action: 'stashApplyPick',
            label: '恢复某次存储的改动…',
            disabled: git.stashes.length === 0
          },
          {
            action: 'stashDropPick',
            label: '删除某次存储…',
            disabled: git.stashes.length === 0
          }
        ]
      },
      {
        key: 'tag',
        label: '标记',
        icon: 'git',
        items: [
          { action: 'createTag', label: '创建标签…' },
          { action: 'deleteTag', label: '删除标签…' },
          { action: 'pushTag', label: '推送标签…' },
          { action: 'pushTags', label: '推送所有标签' }
        ]
      }
    ],
    [git.merging, git.stashes.length]
  )
  const handleMenuAction = useCallback(
    async (action: string): Promise<void> => {
      setMoreMenuOpen(false)
      switch (action) {
        case 'sync':
        case 'pull':
          await handleRemote('pull')
          return
        case 'push':
          await handleRemote('push')
          return
        case 'pushTags': {
          const res = await pushTags()
          if (!res.success) setNotice(res.error ?? '推送标签失败')
          return
        }
        case 'commitEmpty': {
          const msg = await promptInput('空提交不需要任何改动，请输入提交信息', '提交信息')
          if (!msg) return
          // commitEmpty 在任务摘要里列出；若无此导出会在 typecheck 暴露
          const { commitEmpty } = await import('@renderer/core/git/git-store')
          const res = await commitEmpty(msg)
          if (!res.success) setNotice(res.error ?? '空提交失败')
          return
        }
        case 'mergeAbort': {
          const res = await mergeAbort()
          if (!res.success) setNotice(res.error ?? '中止合并失败')
          return
        }
        case 'stashPush': {
          const msg = await promptInput('存储说明（可选，留空回车即存）', '说明', {
            allowEmpty: true
          })
          if (msg === null) return
          const res = await stashPush(msg || undefined)
          if (!res.success) setNotice(res.error ?? '存储失败')
          return
        }
        case 'stashApplyPick': {
          await loadStashes()
          const picked = await pickOption(
            '恢复某次存储的改动',
            '选择要恢复的存储（恢复后保留记录）',
            git.stashes.map((s) => ({
              value: String(s.index),
              label: `存储 ${s.index}  ${stashDisplayMessage(s.message)}`,
              hint: formatStashDate(s.date)
            }))
          )
          if (picked === null) return
          await handleStashApply(Number(picked))
          return
        }
        case 'stashDropPick': {
          await loadStashes()
          const picked = await pickOption(
            '删除某次存储',
            '选择要删除的存储',
            git.stashes.map((s) => ({
              value: String(s.index),
              label: `存储 ${s.index}  ${stashDisplayMessage(s.message)}`,
              hint: formatStashDate(s.date)
            }))
          )
          if (picked === null) return
          await handleStashDrop(Number(picked))
          return
        }
        case 'createTag':
          await handleCreateTag()
          return
        case 'deleteTag':
          await handleDeleteTag()
          return
        case 'pushTag':
          await handlePushTag()
          return
      }
    },
    [
      handleRemote,
      promptInput,
      git.stashes,
      pickOption,
      handleStashApply,
      handleStashDrop,
      handleCreateTag,
      handleDeleteTag,
      handlePushTag
    ]
  )

  // ---------- 文件右键菜单 ----------
  const fileContextItems = useCallback(
    (file: GitFileChange): ContextMenuItem[] => [
      { id: 'open-diff', label: '打开更改', onSelect: () => void handleSelectFile(file) },
      { id: 'open-file', label: '打开文件', onSelect: () => openSourceFile(file.path) },
      {
        id: 'discard',
        label: '放弃更改',
        danger: true,
        onSelect: () => void handleDiscard(file)
      },
      {
        id: 'toggle-stage',
        label: file.staged ? '取消暂存更改' : '暂存更改',
        onSelect: () => void handleToggleStage(file)
      }
    ],
    [handleSelectFile, openSourceFile, handleDiscard, handleToggleStage]
  )

  // ---------- 面板点击：点空白清空多选 ----------
  const handlePanelClick = useCallback(
    (event: React.MouseEvent): void => {
      if (selection.size === 0) return
      if ((event.target as HTMLElement | null)?.closest('.git-change-row')) return
      clearSelection()
    },
    [selection.size, clearSelection]
  )

  // ---------- 分组渲染辅助 ----------
  const renderChangeRow = (group: ChangeGroup, file: GitFileChange): JSX.Element => (
    <GitChangeRow
      key={`${group}-${file.path}`}
      file={file}
      active={git.selectedPath === file.path}
      selected={selection.has(rowKey(group, file.path))}
      onSelect={(f, e) => handleRowSelect(group, f, e)}
      onOpen={(f) => openSourceFile(f.path)}
      onDiscard={(f) => void handleDiscard(f)}
      onToggleStage={(f) => void handleToggleStage(f)}
      onContextMenu={(f, e) => {
        e.preventDefault()
        setContextMenu({ x: e.clientX, y: e.clientY, file: f })
      }}
    />
  )

  const renderGroupHeader = (
    title: string,
    count: number,
    expanded: boolean,
    onToggle: () => void,
    actions?: JSX.Element
  ): JSX.Element => (
    <div className="git-panel__group-head" onClick={onToggle}>
      <Icon name="chevron" size={12} className={expanded ? '' : 'is-collapsed'} />
      <span>{title}</span>
      <span className="git-panel__count">{count}</span>
      <span className="git-panel__spacer" />
      {actions}
    </div>
  )

  // ---------- 空态 ----------
  const cloneStage = cloneFlow.stage
  let content: JSX.Element
  if (cloneStage !== 'idle') {
    content = (
      <div className="git-panel__empty">
        <Icon name="git" size={32} />
        <div className="git-panel__empty-title">
          {cloneStage === 'picking' ? '请选择克隆目标目录…' : '正在克隆仓库'}
        </div>
        {cloneStage === 'running' ? (
          <div className="git-panel__empty-desc">{cloneFlow.message || '准备克隆…'}</div>
        ) : null}
      </div>
    )
  } else if (!git.isRepo) {
    content = (
      <div className="git-panel__empty">
        <Icon name="git" size={32} />
        <div className="git-panel__empty-title">当前目录不是 Git 仓库</div>
        <div className="git-panel__empty-desc">初始化仓库后可在此查看变更</div>
        <div className="git-panel__empty-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={initializing}
            onClick={() => void handleInit()}
          >
            {initializing ? '正在初始化…' : '初始化 Git 仓库'}
          </button>
          <button type="button" className="btn" onClick={() => startCloneFlow()}>
            克隆仓库
          </button>
        </div>
      </div>
    )
  } else {
    content = (
      <div className="git-panel__scroll">
        <div className="git-panel__body">
          {/* 合并进行中横幅 */}
          {conflicts.length > 0 ? (
            <div className="git-panel__merge-banner">
              <div className="git-panel__merge-banner-title">
                <Icon name="git" size={14} />
                <span>合并存在 {conflicts.length} 个冲突文件，请逐个解决后提交</span>
              </div>
              {git.mergeMessage ? (
                <div className="git-panel__merge-banner-msg">{git.mergeMessage}</div>
              ) : null}
              <div className="git-panel__merge-banner-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    const first = conflicts[0]
                    if (first) void handleSelectFile(first)
                  }}
                >
                  去解决冲突
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={gitBusy}
                  onClick={() => void mergeAbort()}
                >
                  中止合并
                </button>
              </div>
            </div>
          ) : null}

          {/* 合并冲突组 */}
          {conflicts.length > 0 ? (
            <section className="git-panel__section">
              {renderGroupHeader('合并更改', conflicts.length, conflictExpanded, () =>
                setConflictExpanded((v) => !v)
              )}
              {conflictExpanded ? (
                <div className="git-panel__group">
                  {conflicts.map((f) => renderChangeRow('conflict', f))}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* 暂存区 */}
          {staged.length > 0 ? (
            <section className="git-panel__section">
              {renderGroupHeader(
                '暂存的更改',
                staged.length,
                stagedExpanded,
                () => setStagedExpanded((v) => !v),
                <button
                  type="button"
                  className="git-panel__group-btn"
                  title="全部取消暂存"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleUnstageAll()
                  }}
                >
                  <Icon name="minimize" size={13} />
                </button>
              )}
              {stagedExpanded ? (
                <div className="git-panel__group">
                  {viewMode === 'list'
                    ? staged.map((f) => renderChangeRow('staged', f))
                    : stagedTree.map((node) => (
                        <GitChangeTreeNode
                          key={`staged-tree-${node.key}`}
                          node={node}
                          depth={0}
                          group="staged"
                          selectedPath={git.selectedPath}
                          selectedKeys={new Set(selection.keys())}
                          onSelect={(f, e) => handleRowSelect('staged', f, e)}
                          onOpen={(f) => openSourceFile(f.path)}
                          onDiscard={(f) => void handleDiscard(f)}
                          onToggleStage={(f) => void handleToggleStage(f)}
                          onContextMenuFile={(f, e) => {
                            e.preventDefault()
                            setContextMenu({ x: e.clientX, y: e.clientY, file: f })
                          }}
                        />
                      ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* 更改组 */}
          {unstaged.length > 0 ? (
            <section className="git-panel__section">
              {renderGroupHeader(
                '更改',
                unstaged.length,
                unstagedExpanded,
                () => setUnstagedExpanded((v) => !v),
                <>
                  <button
                    type="button"
                    className="git-panel__group-btn"
                    title="全部暂存"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleStageAll()
                    }}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                  <button
                    type="button"
                    className="git-panel__group-btn"
                    title="放弃全部更改（仅工作区，暂存区保留）"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDiscardAll()
                    }}
                  >
                    <Icon name="restart" size={13} />
                  </button>
                </>
              )}
              {unstagedExpanded ? (
                <div className="git-panel__group">
                  {viewMode === 'list'
                    ? unstaged.map((f) => renderChangeRow('unstaged', f))
                    : unstagedTree.map((node) => (
                        <GitChangeTreeNode
                          key={`unstaged-tree-${node.key}`}
                          node={node}
                          depth={0}
                          group="unstaged"
                          selectedPath={git.selectedPath}
                          selectedKeys={new Set(selection.keys())}
                          onSelect={(f, e) => handleRowSelect('unstaged', f, e)}
                          onOpen={(f) => openSourceFile(f.path)}
                          onDiscard={(f) => void handleDiscard(f)}
                          onToggleStage={(f) => void handleToggleStage(f)}
                          onContextMenuFile={(f, e) => {
                            e.preventDefault()
                            setContextMenu({ x: e.clientX, y: e.clientY, file: f })
                          }}
                        />
                      ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* 提交历史 */}
          <section className="git-panel__section">
            {renderGroupHeader(
              '提交历史',
              historyVMs.length,
              historyExpanded,
              () => setHistoryExpanded((v) => !v),
              <button
                type="button"
                className="git-panel__group-btn"
                title="刷新历史"
                onClick={(e) => {
                  e.stopPropagation()
                  void reloadLog(LOG_PAGE_SIZE)
                }}
              >
                <Icon name="restart" size={13} />
              </button>
            )}
            {historyExpanded ? (
              <div className="git-panel__history">
                {/* 过滤工具栏 */}
                <div className="git-panel__history-filter">
                  <div className="git-panel__history-search">
                    <Icon name="search" size={12} />
                    <input
                      type="text"
                      placeholder="搜索提交信息…"
                      value={git.historySearch}
                      onChange={(e) => handleHistoryFilterInput(e.target.value)}
                    />
                    {git.historySearch ? (
                      <button
                        type="button"
                        title="清空搜索"
                        onClick={() => {
                          void setHistoryFilter({ search: '' })
                          handleHistoryFilterChange()
                        }}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    ) : null}
                  </div>
                  <Select
                    value={git.historyAuthor}
                    options={[
                      { value: '', label: '作者' },
                      ...git.historyAuthors.map((a) => ({ value: a, label: a }))
                    ]}
                    onChange={(v) => {
                      void setHistoryFilter({ author: v })
                      handleHistoryFilterChange()
                    }}
                    title="作者"
                    width={180}
                  />
                  <Select
                    value={git.historyRef}
                    options={[
                      { value: '', label: '当前分支' },
                      { value: 'all', label: '全部分支' },
                      ...git.branches.map((b) => ({ value: b, label: b }))
                    ]}
                    onChange={(v) => {
                      void setHistoryFilter({ ref: v })
                      handleHistoryFilterChange()
                    }}
                    title="分支"
                    width={180}
                  />
                  <button
                    type="button"
                    className="git-panel__group-btn"
                    title="清除过滤"
                    onClick={clearAllHistoryFilter}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>

                {historyVMs.length === 0 ? (
                  <div className="git-panel__history-empty">
                    {historyFilterActive ? '没有符合条件的提交' : '暂无提交记录'}
                  </div>
                ) : (
                  historyVMs.map((vm) => (
                    <div key={vm.hash}>
                      <div
                        className={`git-panel__commit-row${expandedCommitHash === vm.hash ? ' is-active' : ''}`}
                        onClick={() => toggleCommitExpand(vm.hash)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          hideCommitHover()
                          setCommitMenu({ x: e.clientX, y: e.clientY, commit: vm.commit })
                        }}
                        onMouseEnter={(e) => handleCommitHover(vm, e)}
                        onMouseLeave={handleCommitHoverLeave}
                      >
                        <GitHistoryGraph item={vm.graph} />
                        <span
                          className={`git-panel__commit-subject${vm.isIncoming ? ' is-incoming' : ''}`}
                        >
                          {vm.commit.subject}
                        </span>
                        <span
                          className={`git-panel__commit-author${
                            vm.isIncoming ? ' is-incoming' : isMyCommit(vm.commit) ? ' is-mine' : ''
                          }`}
                        >
                          {vm.commit.author}
                        </span>
                        <span
                          className={`git-panel__commit-date${isTodayCommit(vm.commit) ? ' is-today' : ''}`}
                        >
                          {formatCommitDate(vm.commit.date)}
                        </span>
                      </div>
                      {expandedCommitHash === vm.hash ? (
                        <div className="git-panel__commit-files">
                          {(vm.commit.fileChanges ?? []).length === 0 ? (
                            <div className="git-panel__history-empty">该提交没有文件变更</div>
                          ) : viewMode === 'tree' ? (
                            // 树模式：按目录分组
                            Object.entries(
                              (vm.commit.fileChanges ?? []).reduce<
                                Record<string, typeof vm.commit.fileChanges>
                              >((acc, f) => {
                                const dir = dirNameOnly(f.path) || '/'
                                ;(acc[dir] ??= []).push(f)
                                return acc
                              }, {})
                            ).map(([dir, files]) => (
                              <div key={dir}>
                                <div className="git-panel__commit-dir">
                                  <Icon name="explorer" size={12} />
                                  <span>{dir}</span>
                                </div>
                                {(files ?? []).map((f) => (
                                  <div
                                    key={f.path}
                                    className="git-panel__commit-file"
                                    title={`查看 ${f.path} 在此提交中的变更`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      openSourceFile(f.path)
                                    }}
                                  >
                                    <span
                                      className={`git-panel__commit-code ${commitCodeClass(f.code)}`}
                                    >
                                      {f.code || 'M'}
                                    </span>
                                    <span className="git-panel__commit-file-name">
                                      {fileNameOnly(f.path)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ))
                          ) : (
                            (vm.commit.fileChanges ?? []).map((f) => (
                              <div
                                key={f.path}
                                className="git-panel__commit-file"
                                title={`查看 ${f.path} 在此提交中的变更`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openSourceFile(f.path)
                                }}
                              >
                                <span
                                  className={`git-panel__commit-code ${commitCodeClass(f.code)}`}
                                >
                                  {f.code || 'M'}
                                </span>
                                <span className="git-panel__commit-file-name">
                                  {fileNameOnly(f.path)}
                                </span>
                                <span className="git-panel__commit-file-dir">
                                  {dirNameOnly(f.path)}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}

                {!historyFilterActive && !git.logExhausted && git.commits.length > 0 ? (
                  <div
                    ref={sentinelRef}
                    className="git-panel__load-more"
                    onClick={() => void loadLog(LOG_PAGE_SIZE, true)}
                  >
                    <Icon name="chevron" size={13} />
                    {git.logLoadingMore ? '加载中…' : '加载更早的提交'}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* 存储区 */}
          {git.stashes.length > 0 || stashExpanded ? (
            <section className="git-panel__section">
              {renderGroupHeader(
                '存储',
                git.stashes.length,
                stashExpanded,
                () => setStashExpanded((v) => !v),
                <>
                  {stashSelectionMode ? (
                    <button
                      type="button"
                      className="git-panel__group-btn"
                      title="退出批量管理"
                      onClick={(e) => {
                        e.stopPropagation()
                        setStashSelectionMode(false)
                        setStashSelected(new Set())
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  ) : git.stashes.length > 1 ? (
                    <button
                      type="button"
                      className="git-panel__group-btn"
                      title="批量删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        setStashSelectionMode(true)
                        setStashSelected(new Set())
                      }}
                    >
                      <Icon name="check" size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="git-panel__group-btn"
                    title="刷新存储列表"
                    onClick={(e) => {
                      e.stopPropagation()
                      void loadStashes()
                    }}
                  >
                    <Icon name="restart" size={13} />
                  </button>
                </>
              )}
              {stashExpanded && stashSelectionMode && git.stashes.length > 0 ? (
                <div className="git-panel__stash-batch">
                  <span className="git-panel__spacer" />
                  <span>已选 {stashSelected.size} 条</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={stashSelected.size === 0 || stashBatchDropping}
                    onClick={() => void handleStashDropBatch()}
                  >
                    删除所选
                  </button>
                </div>
              ) : null}
              {stashExpanded ? (
                <div className="git-panel__group">
                  {git.stashes.length === 0 ? (
                    <div className="git-panel__history-empty">暂无存储记录</div>
                  ) : (
                    git.stashes.map((stash) => (
                      <div
                        key={stash.index}
                        className={`git-panel__stash-row${
                          stashSelectionMode && stashSelected.has(stash.index) ? ' is-active' : ''
                        }`}
                        onClick={() =>
                          stashSelectionMode
                            ? toggleStashSelect(stash.index)
                            : handleStashView(stash.index)
                        }
                        onMouseEnter={(e) => handleStashHover(stash, e)}
                        onMouseLeave={handleStashHoverLeave}
                      >
                        {stashSelectionMode ? (
                          <input
                            type="checkbox"
                            checked={stashSelected.has(stash.index)}
                            onChange={() => toggleStashSelect(stash.index)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : null}
                        <Icon name="git" size={13} />
                        <span className="git-panel__stash-msg">
                          {stashDisplayMessage(stash.message)}
                        </span>
                        {!stashSelectionMode ? (
                          <span className="git-panel__stash-meta">
                            {stashBranchLabel(stash.message) ? (
                              <span className="git-panel__stash-branch">
                                {stashBranchLabel(stash.message)}
                              </span>
                            ) : null}
                            <span>{formatStashDate(stash.date)}</span>
                          </span>
                        ) : null}
                        {!stashSelectionMode ? (
                          <span className="git-panel__stash-actions">
                            <button
                              type="button"
                              title="查看详情"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleStashView(stash.index)
                              }}
                            >
                              <Icon name="search" size={12} />
                            </button>
                            <button
                              type="button"
                              title="恢复改动（保留此存储）"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleStashApply(stash.index)
                              }}
                            >
                              <Icon name="check" size={12} />
                            </button>
                            <button
                              type="button"
                              title="恢复改动并删除此存储"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleStashPop(stash.index)
                              }}
                            >
                              <Icon name="plus" size={12} />
                            </button>
                            <button
                              type="button"
                              title="删除该存储"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleStashDrop(stash.index)
                              }}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div ref={panelRootRef} className="git-panel" onClick={handlePanelClick}>
      {/* 顶部工具条 */}
      <div className="git-panel__toolbar">
        <span className="git-panel__summary">
          {changeCount > 0 ? `${changeCount} 个变更` : '工作空间干净'}
        </span>
        <span className="git-panel__spacer" />

        {/* 视图与排序菜单 */}
        <button
          type="button"
          className="git-panel__tool-btn"
          title="查看与排序"
          onClick={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            setViewMenuPos({ x: rect.left, y: rect.bottom + 4 })
            setMoreMenuOpen(false)
            setViewMenuOpen((v) => !v)
          }}
        >
          <Icon name="sort" size={14} />
        </button>

        {git.isRepo ? (
          <>
            <button
              type="button"
              className="git-panel__tool-btn"
              title="拉取 (git pull)"
              disabled={gitBusy || remoteBusy !== ''}
              onClick={() => void handleRemote('pull')}
            >
              <Icon name="restart" size={14} />
              {git.behind ? (
                <span className="git-panel__badge git-panel__badge--behind">{git.behind}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="git-panel__tool-btn"
              title="推送 (git push)"
              disabled={gitBusy || remoteBusy !== ''}
              onClick={() => void handleRemote('push')}
            >
              <Icon name="send" size={14} />
              {git.ahead ? (
                <span className="git-panel__badge git-panel__badge--ahead">{git.ahead}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="git-panel__tool-btn"
              title="获取 (git fetch --all)"
              disabled={gitBusy || remoteBusy !== ''}
              onClick={() => void handleRemote('fetch')}
            >
              <Icon name="restart" size={14} />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="git-panel__tool-btn"
          title="刷新"
          disabled={git.loading}
          onClick={() => void refreshGit(git.cwd)}
        >
          <Icon name="restart" size={14} className={git.loading ? 'is-spinning' : ''} />
        </button>
        {git.isRepo ? (
          <button
            type="button"
            className="git-panel__tool-btn"
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setMoreMenuPos({ x: rect.left, y: rect.bottom + 4 })
              setViewMenuOpen(false)
              setMoreMenuOpen((v) => !v)
            }}
          >
            <Icon name="sort" size={14} />
          </button>
        ) : null}
      </div>

      {/* 分支条 + 提交条 */}
      {git.isRepo ? (
        <div className="git-panel__commit-area" key={git.cwd}>
          <GitBranchBar />
          <GitSyncButton />
          <GitCommitBar />
        </div>
      ) : null}

      {/* 多选批量操作条 */}
      {selection.size >= 2 ? (
        <div className="git-panel__batch-bar">
          <span className="git-panel__spacer">已选 {selection.size} 个文件</span>
          <button
            type="button"
            className="btn"
            disabled={batchBusy || selectedWorktreePaths.length === 0}
            onClick={() => void handleBatchStage()}
          >
            暂存
          </button>
          <button
            type="button"
            className="btn"
            disabled={batchBusy || selectedStagedPaths.length === 0}
            onClick={() => void handleBatchUnstage()}
          >
            取消暂存
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={batchBusy || selectedDiscardablePaths.length === 0}
            onClick={() => void handleBatchDiscard()}
          >
            放弃更改
          </button>
          <button
            type="button"
            className="git-panel__group-btn"
            title="取消选择（Esc）"
            onClick={clearSelection}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      {/* 错误/通知条 */}
      {notice ? (
        <div className="notice notice--error" onClick={() => setNotice('')}>
          {notice}
        </div>
      ) : null}

      {/* 内容区 */}
      <div className="git-panel__content">{content}</div>

      {/* 底部汇总 */}
      {changeCount > 0 ? (
        <div className="git-panel__footer">
          <span className="git-panel__stat git-panel__stat--add">+{totalAdditions}</span>
          <span className="git-panel__stat git-panel__stat--del">-{totalDeletions}</span>
        </div>
      ) : null}

      {/* 视图与排序菜单 */}
      {viewMenuOpen ? (
        <ContextMenu
          x={viewMenuPos.x}
          y={viewMenuPos.y}
          onClose={() => setViewMenuOpen(false)}
          items={[
            {
              id: 'view-list',
              label: viewMode === 'list' ? '✓ 以列表形式查看' : '以列表形式查看',
              onSelect: () => setViewMode('list')
            },
            {
              id: 'view-tree',
              label: viewMode === 'tree' ? '✓ 以树形式查看' : '以树形式查看',
              onSelect: () => setViewMode('tree')
            },
            {
              id: 'sort-path',
              label: sortBy === 'path' ? '✓ 按路径排序' : '按路径排序',
              onSelect: () => setSortBy('path')
            },
            {
              id: 'sort-status',
              label: sortBy === 'status' ? '✓ 按状态排序' : '按状态排序',
              onSelect: () => setSortBy('status')
            }
          ]}
        />
      ) : null}

      {/* 更多操作菜单：一级分组，hover 展开二级（简化为 ContextMenu 平铺，组名作 disabled 分隔项） */}
      {moreMenuOpen ? (
        <ContextMenu
          x={moreMenuPos.x}
          y={moreMenuPos.y}
          onClose={() => {
            setMoreMenuOpen(false)
          }}
          items={moreMenuGroups.flatMap((group) => [
            {
              id: `group-${group.key}`,
              label: `— ${group.label} —`,
              disabled: true,
              onSelect: () => {}
            },
            ...group.items.map((item) => ({
              id: item.action,
              label: item.label,
              disabled: item.disabled || gitBusy,
              onSelect: () => void handleMenuAction(item.action)
            }))
          ])}
        />
      ) : null}

      {/* 文件右键菜单 */}
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={fileContextItems(contextMenu.file)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      {/* 提交右键菜单 */}
      {commitMenu ? (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          onClose={() => setCommitMenu(null)}
          items={[
            {
              id: 'detail',
              label: '查看提交详情',
              onSelect: () => void commitMenuAction('detail')
            },
            {
              id: 'create-branch',
              label: '在此提交上新建分支…',
              onSelect: () => void commitMenuAction('create-branch')
            },
            {
              id: 'copy-hash',
              label: '复制提交哈希',
              onSelect: () => void commitMenuAction('copy-hash')
            },
            {
              id: 'copy-message',
              label: '复制提交信息',
              onSelect: () => void commitMenuAction('copy-message')
            },
            {
              id: 'cherry-pick',
              label: '拣选此提交（cherry-pick）',
              onSelect: () => void commitMenuAction('cherry-pick')
            },
            {
              id: 'revert',
              label: '反转此提交（revert）',
              danger: true,
              onSelect: () => void commitMenuAction('revert')
            }
          ]}
        />
      ) : null}

      {/* 通用确认弹窗 */}
      {confirmState ? (
        <Dialog
          title={confirmState.title}
          onClose={() => {
            confirmState.resolve(false)
            setConfirmState(null)
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  confirmState.resolve(false)
                  setConfirmState(null)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={`btn${confirmState.danger ? ' btn--danger' : ' btn--primary'}`}
                onClick={() => {
                  confirmState.resolve(true)
                  setConfirmState(null)
                }}
              >
                {confirmState.confirmLabel}
              </button>
            </>
          }
        >
          <div className="git-panel__dialog-body">{confirmState.message}</div>
        </Dialog>
      ) : null}

      {/* 通用输入弹窗 */}
      {promptState ? (
        <PromptDialog
          title={promptState.title}
          label={promptState.label}
          initialValue={promptState.initialValue}
          validate={(v) => (promptState.allowEmpty || v ? null : '内容不能为空')}
          onConfirm={(value) => {
            promptState.resolve(value)
            setPromptState(null)
          }}
          onClose={() => {
            promptState.resolve(null)
            setPromptState(null)
          }}
        />
      ) : null}

      {/* 通用选择弹窗 */}
      {pickState ? (
        <GitPickDialog
          title={pickState.title}
          description={pickState.description}
          items={pickState.options.map((o) => ({
            id: o.value,
            label: o.label,
            hint: o.hint,
            description: o.description
          }))}
          searchPlaceholder="搜索…"
          onPick={(id) => {
            pickState.resolve(id)
            setPickState(null)
          }}
          onClose={() => {
            pickState.resolve(null)
            setPickState(null)
          }}
        />
      ) : null}

      {/* 提交详情弹窗 */}
      {commitDetailHash ? (
        <GitCommitDetailDialog
          open
          hash={commitDetailHash}
          onClose={() => setCommitDetailHash('')}
        />
      ) : null}

      {/* 提交 hover 卡片 */}
      <GitCommitHoverCard
        commit={commitHover.commit}
        visible={commitHover.visible}
        anchor={commitHover.anchor}
        onKeep={keepCommitHover}
        onLeave={hideCommitHover}
      />

      {/* stash hover 卡片 */}
      <GitStashHoverCard
        stash={stashHover.stash}
        visible={stashHover.visible}
        anchor={stashHover.anchor}
        onKeep={keepStashHover}
        onLeave={hideStashHover}
      />

      {/* 存储详情弹窗 */}
      {stashDetail ? (
        <Dialog
          title={`存储 ${stashDetail.index} 详情`}
          onClose={() => setStashDetail(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setStashDetail(null)}>
                关闭
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const idx = stashDetail.index
                  setStashDetail(null)
                  void handleStashApply(idx)
                }}
              >
                恢复改动（保留存储）
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  const idx = stashDetail.index
                  setStashDetail(null)
                  void handleStashPop(idx)
                }}
              >
                恢复改动并删除存储
              </button>
            </>
          }
        >
          <div className="git-panel__stash-detail">
            <div className="git-panel__stash-detail-row">
              <span>当时分支</span>
              <span>{stashDetail.branch || '—'}</span>
            </div>
            <div className="git-panel__stash-detail-row">
              <span>说明</span>
              <span>{stashDetail.message || '—'}</span>
            </div>
            <div className="git-panel__stash-detail-row">
              <span>存储时间</span>
              <span>{formatStashDate(stashDetail.date) || '—'}</span>
            </div>
            <div className="git-panel__stash-detail-row">
              <span>版本哈希</span>
              <span className="git-panel__stash-hash">{stashDetail.hash || '—'}</span>
            </div>
          </div>
        </Dialog>
      ) : null}

      {/* 克隆流程 UI */}
      <GitCloneOverlay />
      <GitCloneDialog />
    </div>
  )
}
