/**
 * 工作区状态（资源管理器的数据源）
 *
 * 采用「按需展开」而非一次性递归建树：
 *   - 大仓库下一次性递归会阻塞且产生巨量数据
 *   - 实际用户只展开少数几个目录
 * 因此 children 是按目录路径缓存的，展开时才请求。
 *
 * 同时负责把「已打开的文件夹」写进设置，下次启动自动恢复
 * （主进程会用该路径重新授权白名单，见 main/fs/file-service.ts）。
 */
import { useSyncExternalStore } from 'react'
import type { FsEntry } from '@shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { allowRoot, paths, pickFolder, readDir } from './fs-client'
import { rememberRecentFolder } from './recent-folders'
import { getSettings, updateSettings } from '../engine/client'

export interface WorkspaceState {
  root: string | null
  /** 目录绝对路径 → 子项（仅已加载的目录） */
  children: Map<string, FsEntry[]>
  expanded: Set<string>
  loading: Set<string>
  error: string | null
  /** 最近一次被打开文件的路径，用于文件树高亮 */
  activeFilePath: string | null
  /** 文件树的多选：存路径而非 FsEntry，刷新目录后仍能按路径匹配 */
  selection: Set<string>
  /** 连选的起点（上次点击的行），Shift 点击时以它为另一端 */
  selectionAnchor: string | null
  /**
   * 文件剪贴板。mode 决定粘贴时是「移动」还是「复制」：
   * 剪切必须显式记录，否则粘贴时无从区分二者（系统剪贴板只给内容不给意图）。
   * 不落地、不跨进程 —— 进程重启后谈"粘贴上次剪切的东西"没有意义。
   */
  clipboard: { paths: string[]; mode: 'copy' | 'cut' } | null
}

let state: WorkspaceState = {
  root: null,
  children: new Map(),
  expanded: new Set(),
  loading: new Set(),
  error: null,
  activeFilePath: null,
  selection: new Set(),
  selectionAnchor: null,
  clipboard: null
}

const listeners = new Set<() => void>()

function setState(patch: Partial<WorkspaceState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getWorkspaceState(): WorkspaceState {
  return state
}

// ==================== 树展开状态持久化（按项目，对齐 wuzu expandedDirs） ====================

const EXPANDED_DIRS_KEY = 'aether.expandedDirs'

type ExpandedDirsTable = Record<string, string[]>

function readExpandedDirsTable(): ExpandedDirsTable {
  try {
    const raw = localStorage.getItem(EXPANDED_DIRS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const table: ExpandedDirsTable = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) table[key] = value.filter((v): v is string => typeof v === 'string')
    }
    return table
  } catch {
    return {}
  }
}

function loadExpandedDirs(root: string): string[] {
  return readExpandedDirsTable()[root] ?? []
}

/**
 * Paths returned by the main process use the platform separator, while older
 * persisted entries may have been written by a renderer using the other one.
 * Keep the original path for IPC, but compare normalized keys when rebuilding
 * the expansion tree. Windows drive/UNC paths are case-insensitive; POSIX
 * paths retain their case.
 */
function expandedPathKey(path: string): string {
  const slashPath = path.replace(/\\/g, '/')
  // Keep the two leading slashes of a UNC path, but collapse duplicate
  // separators elsewhere so hand-edited/older localStorage entries still
  // match the canonical path returned by readDir.
  const prefix = slashPath.startsWith('//') ? '//' : ''
  const normalized =
    `${prefix}${slashPath.slice(prefix.length).replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '') || '/'
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}

function expandedPathDepth(path: string): number {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).length
}

function isExpandedPathWithin(root: string, candidate: string): boolean {
  const rootKey = expandedPathKey(root)
  const candidateKey = expandedPathKey(candidate)
  if (candidateKey === rootKey) return true
  return rootKey === '/' ? candidateKey.startsWith('/') : candidateKey.startsWith(`${rootKey}/`)
}

function sameExpandedPath(left: string, right: string): boolean {
  return expandedPathKey(left) === expandedPathKey(right)
}

/** 表按项目裁剪到最近 20 个，避免 localStorage 无限增长 */
function persistExpandedDirs(): void {
  const root = state.root
  if (!root) return
  const table = readExpandedDirsTable()
  table[root] = [...state.expanded]
  const keys = Object.keys(table)
  if (keys.length > 20) {
    // 当前项目必保留；其余按插入序丢最旧的（Object 键序即插入序）
    for (const key of keys) {
      if (key === root) continue
      delete table[key]
      if (Object.keys(table).length <= 20) break
    }
  }
  try {
    localStorage.setItem(EXPANDED_DIRS_KEY, JSON.stringify(table))
  } catch {
    // 存储写失败不打断交互
  }
}

export function onWorkspaceChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 加载某目录的子项并写入缓存。恢复旧展开状态时，过期目录的失败应被静默忽略。 */
async function loadChildren(
  dir: string,
  options: { reportError?: boolean } = {}
): Promise<FsEntry[] | null> {
  const reportError = options.reportError ?? true
  setState({ loading: new Set(state.loading).add(dir) })
  try {
    const entries = await readDir(dir)
    const nextChildren = new Map(state.children)
    nextChildren.set(dir, entries)
    const nextLoading = new Set(state.loading)
    nextLoading.delete(dir)
    setState({ children: nextChildren, loading: nextLoading, error: null })
    return entries
  } catch (err) {
    const nextLoading = new Set(state.loading)
    nextLoading.delete(dir)
    setState(
      reportError ? { loading: nextLoading, error: ipcErrorMessage(err) } : { loading: nextLoading }
    )
    return null
  }
}

/**
 * 恢复某个项目上次展开的目录。
 *
 * 旧实现只读取 root，却把所有路径直接放进 expanded。这样重启后如果
 * root/one/two 曾经展开，two 会是「展开但没有 children 缓存」的幽灵节点，
 * 视图既看不到它，也不会主动再读盘。这里按层级读取，并且只接受父目录
 * 当前 readDir 返回的真实目录项；被删除、改名、变成文件或不在 root 内的
 * 持久化路径会被丢弃，不会触发越界 IPC 或把错误显示给用户。
 */
async function restoreExpandedDirs(
  root: string,
  persisted: string[],
  rootEntries: FsEntry[] | null
): Promise<Set<string>> {
  const restored = new Set<string>([root])
  if (!rootEntries) return restored

  const loaded = new Map<string, FsEntry[]>([[expandedPathKey(root), rootEntries]])
  const candidates = [...new Set(persisted)]
    .filter(
      (candidate) => !sameExpandedPath(candidate, root) && isExpandedPathWithin(root, candidate)
    )
    .sort((left, right) => expandedPathDepth(left) - expandedPathDepth(right))

  for (const candidate of candidates) {
    // A child is restorable only when its parent was itself persisted and
    // validated. This preserves the meaning of collapsing a parent even when
    // an older state left one of its descendants in localStorage.
    const parent = paths.dirname(candidate)
    const parentKey = expandedPathKey(parent)
    if (!restoredHasKey(restored, parentKey)) continue

    const entries = loaded.get(parentKey)
    const entry = entries?.find(
      (item) => item.isDirectory && sameExpandedPath(item.path, candidate)
    )
    if (!entry) continue

    const childEntries = await loadChildren(entry.path, { reportError: false })
    if (!childEntries) continue
    restored.add(entry.path)
    loaded.set(expandedPathKey(entry.path), childEntries)
  }

  return restored
}

function restoredHasKey(restored: Set<string>, key: string): boolean {
  for (const path of restored) {
    if (expandedPathKey(path) === key) return true
  }
  return false
}

/** 打开指定文件夹（已授权则直接切换） */
export async function openFolderAt(root: string): Promise<void> {
  // 授权前置：主进程的文件白名单在内存里，不经「打开文件夹」选择框进来的目录
  // （最近打开、启动恢复）必须显式补授权，否则 readDir 会被越界校验拦下
  await allowRoot(root)
  // 根目录默认展开：树的第一行是根节点本身（见 ExplorerView），
  // 不在 expanded 里的话打开文件夹只会看到光秃秃的一行根。
  const persisted = loadExpandedDirs(root)
  setState({
    root,
    children: new Map(),
    // 恢复上次该项目的展开状态；首次打开只展开根
    // 其余目录在 root 成功加载后按层级恢复，避免显示「展开但未加载」的幽灵节点。
    expanded: new Set([root]),
    loading: new Set(),
    error: null,
    activeFilePath: null,
    selection: new Set(),
    selectionAnchor: null
  })
  const rootEntries = await loadChildren(root)
  const restored = await restoreExpandedDirs(root, persisted, rootEntries)
  setState({ expanded: restored })
  // 删除已经不存在或不再位于工作区内的旧路径，避免每次重启都重复尝试。
  const persistedKeys = new Set([root, ...persisted].map(expandedPathKey))
  const restoredKeys = new Set([...restored].map(expandedPathKey))
  if (
    rootEntries &&
    (persistedKeys.size !== restoredKeys.size ||
      [...persistedKeys].some((key) => !restoredKeys.has(key)))
  ) {
    persistExpandedDirs()
  }
  // 记入「最近打开的项目」：启动时自动恢复也算一次使用，下次仍在列表最前
  rememberRecentFolder(root)
  // 记住当前项目，下次启动自动恢复（restoreLastFolder 读 settings.lastFolder）
  void updateSettings({ lastFolder: root })
}

/** 弹出目录选择框并打开 */
export async function pickAndOpenFolder(): Promise<void> {
  try {
    const folder = await pickFolder()
    if (!folder) return
    await openFolderAt(folder)
  } catch (err) {
    setState({ error: ipcErrorMessage(err) })
  }
}

/** 启动恢复只跑一次；重复调用复用同一 promise（见 workspaceRestoreSettled） */
let restorePromise: Promise<void> | null = null

/** 应用启动时恢复上次打开的文件夹 */
export function restoreLastFolder(): Promise<void> {
  restorePromise ??= (async (): Promise<void> => {
    try {
      const settings = await getSettings()
      if (!settings.lastFolder) return
      await openFolderAt(settings.lastFolder)
    } catch (err) {
      // 目录已被删除或无权限：不打断启动，也不清空设置，让用户自己重新选择
      setState({ error: ipcErrorMessage(err), root: null })
    }
  })()
  return restorePromise
}

/**
 * 「启动时的工作区恢复已结束」——无论成功、失败还是压根没恢复过。
 *
 * 需要工作区才能确定自身初值的东西（如终端的启动目录）必须等它：
 * restoreLastFolder 是异步的，而渲染首帧就跑完了，此时 root 还是 null，
 * 照拍脑袋创建出来的东西会落在主目录而不是当前项目里。
 */
export function workspaceRestoreSettled(): Promise<void> {
  return restorePromise ?? Promise.resolve()
}

export async function toggleExpand(dir: string): Promise<void> {
  const nextExpanded = new Set(state.expanded)
  if (nextExpanded.has(dir)) {
    nextExpanded.delete(dir)
    setState({ expanded: nextExpanded })
    persistExpandedDirs()
    return
  }

  await expandDirectory(dir)
}

/**
 * 展开目录（已展开时只保证子项已加载）。
 *
 * 与 toggleExpand 分开：新建文件/文件夹之后要「确保能看到结果」，
 * 用 toggleExpand 会把已展开的目录收起来 —— 正好相反。
 */
export async function expandDirectory(dir: string): Promise<void> {
  if (!state.expanded.has(dir)) {
    setState({ expanded: new Set(state.expanded).add(dir) })
    persistExpandedDirs()
  }
  if (!state.children.has(dir)) {
    await loadChildren(dir)
  }
}

/** 重新读取目录（文件操作后刷新） */
export async function refreshDirectory(dir: string): Promise<void> {
  if (state.children.has(dir) || state.root === dir) {
    await loadChildren(dir)
  }
}

/**
 * 先把已删除的条目从树缓存中摘掉，再等待目录重读。
 *
 * Windows 的系统回收站可能在 IPC 返回后才完成目录通知；如果只依赖一次
 * readDir，旧条目会在虚拟树里短暂复活，甚至在读目录结果先后交错时一直残留。
 * 这里按规范化路径同步移除，随后由 file-ops 再做一次磁盘刷新。
 */
export function removeEntriesFromWorkspace(targetPaths: string[]): void {
  if (targetPaths.length === 0) return
  const targets = targetPaths.map(expandedPathKey)
  const isTarget = (path: string): boolean => targets.some((target) =>
    expandedPathKey(path) === target || expandedPathKey(path).startsWith(`${target}/`)
  )
  const nextChildren = new Map(state.children)
  let changed = false
  for (const [dir, entries] of nextChildren) {
    const filtered = entries.filter((entry) => !isTarget(entry.path))
    if (filtered.length !== entries.length) {
      nextChildren.set(dir, filtered)
      changed = true
    }
  }
  if (!changed) return
  const selection = new Set([...state.selection].filter((path) => !isTarget(path)))
  const selectionAnchor = state.selectionAnchor && isTarget(state.selectionAnchor) ? null : state.selectionAnchor
  setState({ children: nextChildren, selection, selectionAnchor })
}

/**
 * 收起全部目录，但保留 root 本身已加载的子项。
 *
 * 只清 expanded，不清 children：缓存留着，用户再展开时是瞬时的，
 * 不必重新读盘。换根目录才需要丢掉缓存（见 openFolderAt）。
 */
export function collapseAll(): void {
  if (state.expanded.size === 0) return
  setState({ expanded: new Set() })
  persistExpandedDirs()
}

/** 记录当前打开的文件（用于文件树高亮） */
export function setActiveFile(filePath: string | null): void {
  setState({ activeFilePath: filePath })
}

/** 关闭工作区 */
export function closeFolder(): void {
  setState({
    root: null,
    children: new Map(),
    expanded: new Set(),
    loading: new Set(),
    error: null,
    activeFilePath: null,
    selection: new Set(),
    selectionAnchor: null
  })
  void updateSettings({ lastFolder: '' })
}

// ==================== 多选 ====================

/** 当前选中的条目路径（调用方通常再复制一份，避免持有内部引用） */
export function getSelection(): Set<string> {
  return state.selection
}

export function setSelection(paths: Iterable<string>): void {
  setState({ selection: new Set(paths) })
}

/**
 * 点选某一行。
 *
 * 三种语义与 VS Code / 系统文件管理器一致：
 *   - 普通点击：只选中这一行
 *   - Ctrl 点击：在该行上取反
 *   - Shift 点击：从上次点击处连选一段
 * 传入 order 是因为连选要知道"屏幕上从哪到哪"，而这只有视图知道。
 * 右键不用这里：右键已选中的行不应把选区缩成一行，
 * 否则"选中多个再右键删除"这个最常用的动作会永远删不干净。
 */
export function selectEntry(
  path: string,
  mode: 'plain' | 'toggle' | 'range',
  order: string[]
): void {
  if (mode === 'toggle') {
    const next = new Set(state.selection)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setState({ selection: next, selectionAnchor: path })
    return
  }

  if (mode === 'range' && state.selectionAnchor) {
    const from = order.indexOf(state.selectionAnchor)
    const to = order.indexOf(path)
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from]
      setState({ selection: new Set(order.slice(start, end + 1)) })
      return
    }
  }

  setState({ selection: new Set([path]), selectionAnchor: path })
}

/** 保留选区，仅把锚点移到该行（右键已选中行时用） */
export function setSelectionAnchor(path: string): void {
  setState({ selectionAnchor: path })
}

/** 全选可见行（Ctrl+A）。锚点留在最后一行，之后 Shift 点击仍能连选。 */
export function selectAllVisible(order: string[]): void {
  setState({ selection: new Set(order), selectionAnchor: order[order.length - 1] ?? null })
}

export function clearSelection(): void {
  if (state.selection.size === 0 && state.selectionAnchor === null) return
  setState({ selection: new Set(), selectionAnchor: null })
}

/**
 * 写入文件剪贴板。
 *
 * 空数组视为"清空剪贴板"而不是"记住了 0 个"：否则粘贴项会一直可点，
 * 点下去却什么都不发生。
 */
export function setClipboard(paths: string[], mode: 'copy' | 'cut'): void {
  setState({ clipboard: paths.length > 0 ? { paths: [...paths], mode } : null })
}

export function getClipboard(): { paths: string[]; mode: 'copy' | 'cut' } | null {
  return state.clipboard
}

/** 粘贴完成后清掉剪贴板：剪切的语义是一次性的，系统的复制也只在粘贴后失效于该次 */
export function clearClipboard(): void {
  if (!state.clipboard) return
  setState({ clipboard: null })
}

/** 订阅工作区状态（store 内部整体替换 state，引用稳定可作快照） */
export function useWorkspace(): WorkspaceState {
  return useSyncExternalStore(onWorkspaceChanged, getWorkspaceState)
}

/**
 * 当前工作区路径列表，供 chat 的 workspacePaths 使用。
 * 非组件环境（命令回调）也能安全调用。
 */
export function currentWorkspacePaths(): string[] {
  const root = getWorkspaceState().root
  return root ? [root] : []
}
