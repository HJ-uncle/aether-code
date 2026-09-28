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
import { pickFolder, readDir } from './fs-client'
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

export function onWorkspaceChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 加载某目录的子项并写入缓存 */
async function loadChildren(dir: string): Promise<void> {
  setState({ loading: new Set(state.loading).add(dir) })
  try {
    const entries = await readDir(dir)
    const nextChildren = new Map(state.children)
    nextChildren.set(dir, entries)
    const nextLoading = new Set(state.loading)
    nextLoading.delete(dir)
    setState({ children: nextChildren, loading: nextLoading, error: null })
  } catch (err) {
    const nextLoading = new Set(state.loading)
    nextLoading.delete(dir)
    setState({ loading: nextLoading, error: ipcErrorMessage(err) })
  }
}

/** 打开指定文件夹（已授权则直接切换） */
export async function openFolderAt(root: string): Promise<void> {
  // 根目录默认展开：树的第一行是根节点本身（见 ExplorerView），
  // 不在 expanded 里的话打开文件夹只会看到光秃秃的一行根。
  setState({
    root,
    children: new Map(),
    expanded: new Set([root]),
    loading: new Set(),
    error: null,
    activeFilePath: null,
    selection: new Set(),
    selectionAnchor: null
  })
  await loadChildren(root)
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

/** 应用启动时恢复上次打开的文件夹 */
export async function restoreLastFolder(): Promise<void> {
  try {
    const settings = await getSettings()
    if (!settings.lastFolder) return
    await openFolderAt(settings.lastFolder)
  } catch (err) {
    // 目录已被删除或无权限：不打断启动，也不清空设置，让用户自己重新选择
    setState({ error: ipcErrorMessage(err), root: null })
  }
}

export async function toggleExpand(dir: string): Promise<void> {
  const nextExpanded = new Set(state.expanded)
  if (nextExpanded.has(dir)) {
    nextExpanded.delete(dir)
    setState({ expanded: nextExpanded })
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
 * 收起全部目录，但保留 root 本身已加载的子项。
 *
 * 只清 expanded，不清 children：缓存留着，用户再展开时是瞬时的，
 * 不必重新读盘。换根目录才需要丢掉缓存（见 openFolderAt）。
 */
export function collapseAll(): void {
  if (state.expanded.size === 0) return
  setState({ expanded: new Set() })
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
