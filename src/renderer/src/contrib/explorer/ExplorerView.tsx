import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { FsEntry } from '@shared/ipc'
import { documentKey, openFile } from '@renderer/core/editor/editor-store'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { setContextKey } from '@renderer/core/platform/context-keys'
import { setLayout } from '@renderer/core/platform/layout-state'
import { paths } from '@renderer/core/workspace/fs-client'
import {
  createFileIn,
  createFolderIn,
  moveEntries,
  onUndoStackChanged,
  peekUndoLabel,
  renameEntry,
  trashEntries,
  undoLastFileOp,
  validateEntryName
} from '@renderer/core/workspace/file-ops'
import {
  clearSelection,
  closeFolder,
  expandDirectory,
  getSelection,
  getWorkspaceState,
  onWorkspaceChanged,
  pickAndOpenFolder,
  refreshDirectory,
  selectAllVisible,
  selectEntry,
  setSelection,
  setSelectionAnchor,
  toggleExpand,
  type WorkspaceState
} from '@renderer/core/workspace/workspace-store'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { Icon } from '@renderer/workbench/icons'

/** 行高，必须与 app.css 的 .tree-row 保持一致（虚拟滚动按它换算偏移） */
const ROW_HEIGHT = 22
/** 视口外多渲染的行数：留一屏缓冲，快速滚动时才不会看到空白 */
const OVERSCAN = 10
/**
 * 判定「这是拖拽而不是点击」的位移阈值（像素）。
 *
 * 系统双击距离是 4px，但自动化测试的合成点击也可能带上 1~2px 抖动，
 * 卡在 4px 会让「点目录展开」偶发失效；放宽到 8px，人手仍感觉不到差别。
 */
const DRAG_THRESHOLD = 8

interface Row {
  entry: FsEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  isActive: boolean
  isSelected: boolean
}

/** 右键菜单的位置与目标 */
interface MenuState {
  x: number
  y: number
  entry: FsEntry | null
  /** 若右键时存在选区，则记录当时的选区快照（菜单是异步打开的） */
  selection: string[]
}

/** 需要用户输入名称的操作 */
type NameAction =
  | { kind: 'newFile'; dir: string }
  | { kind: 'newFolder'; dir: string }
  | { kind: 'rename'; entry: FsEntry }

/**
 * 指针按下的状态：拖动与点击共用。
 *
 * 不能只把它当拖拽状态：pointerdown 之后行组件收不到 click（指针已被捕获），
 * 因此"点了一下"这个动作必须在这里收尾 —— 没超过阈值的按下即视为点击。
 */
interface DragState {
  paths: string[]
  x: number
  y: number
  didMove: boolean
  /** 产生这次按下的修饰键语义，决定松手时是否打开文件 */
  mode: 'plain' | 'toggle' | 'range'
  /** 按下时所在的行，决定松手时打开哪一个条目 */
  anchor: string
}

/**
 * 用「跨渲染持久的 ref + 有序快照」替代 useSyncExternalStore。
 *
 * useSyncExternalStore 判定状态是否变化靠 Object.is 比较快照。store 的每个
 * action 都会把 state 换成新对象，于是任何一次 action 都让快照不等 ——
 * 即便本次加载的子项与上次完全相同。拖拽流程里一次按下会连着派发好几个
 * action（选中 + 展开 + 子项加载），每次都会让本组件重新渲染；
 * 虚拟滚动的可见区间是按 scrollTop / 视口高在渲染时算出来的，
 * 一旦在指针事件与随后的 scroll 事件之间插入一次额外渲染，
 * 这个区间就会用过期的高度算错，行随之外移或消失。
 *
 * 这里改成「每次渲染后在 effect 里比对，只有真正相关的内容变了才 setState 重渲染」，
 * 因此拖拽期间不会有多余渲染插进事件序列。快照字段全部保存引用/内容值，
 * 不持有 store 的内部集合（避免后续 action 就地改动它们）。
 */
interface WorkspaceSnapshot {
  root: string | null
  children: ReadonlyMap<string, FsEntry[]>
  expanded: ReadonlySet<string>
  loading: ReadonlySet<string>
  error: string | null
  activeFilePath: string | null
  selection: ReadonlySet<string>
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

function sameChildren(
  a: ReadonlyMap<string, FsEntry[]>,
  b: ReadonlyMap<string, FsEntry[]>
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [dir, entries] of a) {
    if (b.get(dir) !== entries) return false
  }
  return true
}

function sameSnapshot(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return (
    a.root === b.root &&
    a.error === b.error &&
    a.activeFilePath === b.activeFilePath &&
    sameChildren(a.children, b.children) &&
    sameSet(a.expanded, b.expanded) &&
    sameSet(a.loading, b.loading) &&
    sameSet(a.selection, b.selection)
  )
}

function toSnapshot(workspace: WorkspaceState): WorkspaceSnapshot {
  return {
    root: workspace.root,
    children: workspace.children,
    expanded: workspace.expanded,
    loading: workspace.loading,
    error: workspace.error,
    activeFilePath: workspace.activeFilePath,
    selection: workspace.selection
  }
}

/** 从两份快照里挑出变化过的字段，只 patch 这些，其余引用保持不动 */
function diffSnapshot(
  prev: WorkspaceSnapshot,
  next: WorkspaceSnapshot
): Partial<WorkspaceState> | null {
  const patch: Partial<WorkspaceState> = {}
  let changed = false

  if (prev.root !== next.root) {
    patch.root = next.root
    changed = true
  }
  if (prev.error !== next.error) {
    patch.error = next.error
    changed = true
  }
  if (prev.activeFilePath !== next.activeFilePath) {
    patch.activeFilePath = next.activeFilePath
    changed = true
  }
  if (!sameChildren(prev.children, next.children)) {
    patch.children = next.children as Map<string, FsEntry[]>
    changed = true
  }
  if (!sameSet(prev.expanded, next.expanded)) {
    patch.expanded = next.expanded as Set<string>
    changed = true
  }
  if (!sameSet(prev.loading, next.loading)) {
    patch.loading = next.loading as Set<string>
    changed = true
  }
  if (!sameSet(prev.selection, next.selection)) {
    patch.selection = next.selection as Set<string>
    changed = true
  }

  return changed ? patch : null
}

/**
 * 资源管理器
 *
 * 懒加载树：只渲染已展开目录的子项。这里先在父组件把树压平成一维数组，
 * 再逐行渲染 —— 层级只体现为缩进，行组件不订阅 store（否则每行一个订阅，
 * 大目录下开销可观），展开状态由父组件计算后传入。
 *
 * 压平成一维数组还让虚拟滚动变得简单：总高 = 行数 × 行高，
 * 由滚动位置算出该渲染哪一段，只挂载可见的那十几行。
 * 因此 node_modules 这类上万条目的目录展开后依然不掉帧。
 */
export function ExplorerView(): JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceState>(getWorkspaceState)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [nameAction, setNameAction] = useState<NameAction | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [undoLabel, setUndoLabel] = useState<string | null>(null)

  const treeRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (dir: string, depth: number): void => {
      for (const entry of workspace.children.get(dir) ?? []) {
        // P1 不展示依赖目录：node_modules 动辄数万条目，展开会把整棵树撑满，
        // 用户真正要找的项目文件被挤出视口。等 P2 做「按需展开」再放开。
        if (entry.isDirectory && entry.name === 'node_modules') continue
        const isExpanded = entry.isDirectory && workspace.expanded.has(entry.path)
        out.push({
          entry,
          depth,
          isExpanded,
          isLoading: workspace.loading.has(entry.path),
          isActive: !entry.isDirectory && entry.path === workspace.activeFilePath,
          isSelected: workspace.selection.has(entry.path)
        })
        if (isExpanded) walk(entry.path, depth + 1)
      }
    }
    if (workspace.root) walk(workspace.root, 0)
    return out
  }, [
    workspace.children,
    workspace.expanded,
    workspace.loading,
    workspace.root,
    workspace.activeFilePath,
    workspace.selection
  ])

  /** 可见行的路径序列，供全选与 Shift 连选使用 */
  const visiblePaths = useMemo(() => rows.map((row) => row.entry.path), [rows])

  /**
   * 订阅工作区变更，但只在"内容真的变了"时才重渲染。
   *
   * 见上面 WorkspaceSnapshot 的说明：store 每次 action 都换新对象，
   * 直接订阅会让展开、加载、刷新这些本该无关的步骤都触发一轮渲染，
   * 而这恰好会打断拖拽（视口高度是渲染时读的，多余渲染会让命中区间算错）。
   */
  const snapshotRef = useRef<WorkspaceSnapshot>(toSnapshot(workspace))
  useEffect(() => {
    const sync = (): void => {
      const next = toSnapshot(getWorkspaceState())
      if (sameSnapshot(snapshotRef.current, next)) return
      // 先算好 patch 并推进快照，再进 setState：
      // StrictMode 会把 updater 调用两次，若把 ref 推进写在 updater 内部，
      // 第二次调用时 diffSnapshot(next, next) 会得到空 patch 并返回旧 prev，
      // 导致这次变更被静默丢弃（资源管理器重启后一直空着，直到重新挂载）。
      const patch = diffSnapshot(snapshotRef.current, next)
      snapshotRef.current = next
      if (!patch) return
      setWorkspace((prev) => ({ ...prev, ...patch }))
    }
    // 订阅之前可能已经变过（effect 的注册晚于渲染），先补一次
    sync()
    const off = onWorkspaceChanged(sync)
    return off
  }, [])

  /**
   * 拖拽状态同时放一份在 ref 里。
   *
   * pointermove / pointerup 是连续高频事件，若只在 state 里读，
   * 事件到达时拿到的可能是上一轮渲染的旧闭包（React 的事件处理器
   * 绑定在渲染结果上）；ref 永远是最新值，判定"是否拖动过"才不会漏。
   */
  const dragRef = useRef<DragState | null>(null)
  const setDragState = useCallback((next: DragState | null) => {
    dragRef.current = next
    setDrag(next)
  }, [])

  const dropDirRef = useRef<string | null>(null)
  const setDropDirState = useCallback((next: string | null) => {
    dropDirRef.current = next
    setDropDir(next)
  }, [])

  // ── 虚拟滚动 ──
  // ResizeObserver 而不是 window.resize：侧边栏拖宽、面板收起都会改变高度，
  // 这些变化不会触发 window 的 resize 事件。
  useLayoutEffect(() => {
    const el = treeRef.current
    if (!el) return

    setViewportHeight(el.clientHeight)
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [workspace.root])

  const totalHeight = rows.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
  )
  const visibleRows = rows.slice(startIndex, endIndex)

  // 撤销栈在 core 层（命令与快捷键也要用），这里只订阅"栈顶标签"用于菜单文案
  useEffect(() => {
    const sync = (): void => setUndoLabel(peekUndoLabel())
    sync()
    return onUndoStackChanged(sync)
  }, [])

  /**
   * 虚拟滚动下把某一行滚进视口，返回该行是否存在于 rows。
   *
   * 关键：改动必须由行号算出（index * 行高），绝不能读目标行当前的
   * getBoundingClientRect 再按差值微调。目标行不在虚化窗口里时压根没渲染，
   * 读不到它的位置；就算读到了，那样也只是把"当前可见的那一行"当作目标
   * 反复挪，滚动会一次一小步地爬，永远收敛不到真正想去的地方
   * （快速打开一个深层文件时表现为：文件是打开了，树却停在中途，目标行没露面）。
   * 行高固定，用行号算一次就能精确落位，不存在收敛问题。
   *
   * 返回值供调用方记账：false 表示该行还没加载出来（父目录未展开），
   * 调用方可以留着待办，等 rows 变化后再补滚。
   */
  const scrollRowIntoView = useCallback(
    (path: string): boolean => {
      const el = treeRef.current
      if (!el) return false

      const index = rows.findIndex((row) => row.entry.path === path)
      if (index < 0) return false

      const top = index * ROW_HEIGHT
      const bottom = top + ROW_HEIGHT
      // 已经在视口内就什么都不做，避免轻微抖动把用户的滚动位置顶走
      if (top < el.scrollTop) el.scrollTop = top
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
      return true
    },
    [rows]
  )

  /**
   * 刚展开的目录：等子项加载出来后再把它的首个子项亮出来。
   *
   * 虚拟滚动只挂载可见的那十几行：如果目录刚好在视口底部，展开出来的子项
   * 全在窗口之外，用户点了目录却看不到任何变化（滚动条变长是唯一线索）。
   * 这里让展开这个动作本身带上"看见结果"的反馈。
   *
   * 用 ref 而不是 state 记这个待办：它只是"下一轮 rows 变化时要做的事"，
   * 不参与渲染。写成 state 会为了清空它多走一轮渲染，而 effect 里同步
   * setState 又会引出级联渲染。
   *
   * 只认「新增的展开项」：否则折叠任意目录也会触发滚动，把视口顶走。
   */
  const revealDirRef = useRef<string | null>(null)
  const expandedRef = useRef(workspace.expanded)
  useEffect(() => {
    const previous = expandedRef.current
    expandedRef.current = workspace.expanded

    // 换根目录意味着整棵树重建：此时还去补滚动，会和"新工作区从头看起"的预期打架
    if (previous.size === 0) return

    for (const dir of workspace.expanded) {
      if (previous.has(dir)) continue
      revealDirRef.current = dir
      break
    }
  }, [workspace.expanded])

  /**
   * 把「刚展开目录」的首个子项亮出来。
   *
   * 展开的那一瞬间子项还在异步加载，rows 里根本没有它们，所以必须等 rows
   * 变化后再动手 —— 这也是本 effect 依赖 rows 的原因。
   */
  useEffect(() => {
    const dir = revealDirRef.current
    if (!dir) return

    const first = rows.find((row) => paths.dirname(row.entry.path) === dir)
    if (!first) return

    scrollRowIntoView(first.entry.path)
    revealDirRef.current = null
  }, [rows, scrollRowIntoView])

  /**
   * 换文件夹后把滚动条归零。
   *
   * 树节点是复用的：换了根目录时滚动位置还停在上一个工作区留下的地方，
   * 而新树的行数可能完全不同——用户打开新目录，第一眼看到的却是半空中
   * 若干行，开头的内容全在视口之上。与 VS Code 打开文件夹的行为一致。
   *
   * 用回调 ref 而不是 effect：回调 ref 可以带依赖，根目录一变就会重跑，
   * 正好是"重新绑定到新工作区"的时机；在渲染期读写 ref 则被 React 明确禁止。
   */
  const { root } = workspace
  const attachTree = useCallback(
    (el: HTMLDivElement | null) => {
      treeRef.current = el
      if (!el) return

      // 挂载/换根时归零。但"刚展开子目录"要的是把子项亮出来，方向正好相反：
      // 这里不参与，交给 revealDir 那条链路（它在挂载时本来就没有待办）。
      // 换根后残留的 revealDir 会被同一次 commit 里跑的那个 effect 消费掉，
      // 而那时 rows 已换成新树、旧目录名匹配不到，自然什么都不做。
      el.scrollTop = 0
    },
    // root 是依赖（而非被读取的变量）：它变化时让 React 重跑回调 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root]
  )

  /**
   * 激活文件换人时把它滚进视口，但每次激活只滚一次。
   *
   * 虚拟滚动只挂载可见的那十几行，落在窗口外的行根本不在 DOM 里；
   * 不清掉残留的滚动位置，从搜索/快速打开跳到深层文件时用户会看到空屏。
   *
   * 但绝不能「rows 一变就滚」：展开任何目录都会换来一份新 rows，若当前
   * 打开的文件恰好在树的后段，树会被强行拽到那里，刚展开的目录反而看不见
   * ——E2E 里展开 big 后视口被拽到 move-a.txt 所在的树尾、目标行没露面，
   * 就是这条 effect 和上面的 reveal effect 在同一轮 commit 里打架。
   * 因此按激活路径记一次账：滚到过就不再滚，直到激活文件换人。
   * 行还没加载出来时（父目录尚未展开）先记账不动，等 rows 里出现再补滚。
   */
  const revealedFileRef = useRef<string | null>(null)
  useEffect(() => {
    const path = workspace.activeFilePath
    if (!path) {
      // 关闭文件夹/最后一个标签会清空激活文件：顺手清账，
      // 重开同一文件夹后恢复的激活文件才有机会再被补滚一次
      revealedFileRef.current = null
      return
    }
    if (revealedFileRef.current === path) return
    if (scrollRowIntoView(path)) revealedFileRef.current = path
  }, [workspace.activeFilePath, rows, scrollRowIntoView])

  // 外部命令（快捷键 / 命令面板）执行时，视图自身没有触发点，靠上下文键告知它有选区可选
  useEffect(() => {
    setContextKey('explorerHasSelection', workspace.selection.size > 0)
  }, [workspace.selection])

  // 工作区关闭后命令不应再生效
  useEffect(() => {
    if (!workspace.root) {
      setContextKey('explorerFocused', false)
      setContextKey('explorerHasSelection', false)
    }
  }, [workspace.root])

  const handleOpenFolder = useCallback(async () => {
    setBusy(true)
    await pickAndOpenFolder()
    setBusy(false)
  }, [])

  const handleRefresh = useCallback(async () => {
    if (!workspace.root) return
    setBusy(true)
    await refreshDirectory(workspace.root)
    setBusy(false)
  }, [workspace.root])

  /** 统一收集文件操作的失败原因并展示，避免每处各写一遍 try/catch */
  const runOp = useCallback(async (action: () => Promise<void>) => {
    setOpError(null)
    try {
      await action()
    } catch (err) {
      setOpError(ipcErrorMessage(err))
    }
  }, [])

  /** 左键点击行：先按修饰键决定选区，再决定是否打开 */
  const handleRowMouseDown = useCallback(
    (event: ReactMouseEvent, entry: FsEntry) => {
      // 只处理左键；右键与中键交给各自的处理器
      if (event.button !== 0) return

      // 在 pointerdown 阶段就选中：拖拽依赖「按下时选区已就绪」，
      // 若等到 click 才选，拖动一个未选中的文件会拖不动。
      // 行点击与拖拽因此共用同一条路径，不需要各写一套。
      const mode = event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'range' : 'plain'

      // 按在「已经选中的行」上且没按修饰键：先把选区原样留住。
      // 这一步是为了拖一组文件 —— 若此刻就收缩成这一行，用户永远拖不动多选；
      // 真正的收缩推迟到松手（见 handlePointerUp），那时若确实没拖动，
      // 才把它当成一次普通点击。与 VS Code 的列表行为一致。
      const keepSelection = mode === 'plain' && workspace.selection.has(entry.path)
      if (!keepSelection) selectEntry(entry.path, mode, visiblePaths)

      const current = getSelection()
      setDragState({
        paths: [...current],
        x: event.clientX,
        y: event.clientY,
        didMove: false,
        // 只有普通点击才可能打开：加选/连选时用户是在挑一批东西，
        // 此时松手不该打开文件打断这个动作
        mode,
        anchor: entry.path
      })
    },
    [visiblePaths, setDragState, workspace.selection]
  )

  const openMenu = useCallback(
    (event: ReactMouseEvent, entry: FsEntry | null) => {
      event.preventDefault()
      event.stopPropagation()
      setOpError(null)

      // 右键落在已选中的行上：保留整个选区（菜单随后作用于全部选中项）；
      // 落在选区之外：把选区换成这一行，与系统文件管理器一致。
      const current = workspace.selection
      if (entry && !current.has(entry.path)) {
        setSelection([entry.path])
        setSelectionAnchor(entry.path)
        setMenu({ x: event.clientX, y: event.clientY, entry, selection: [entry.path] })
        return
      }

      setMenu({
        x: event.clientX,
        y: event.clientY,
        entry,
        selection: [...current]
      })
    },
    [workspace.selection]
  )

  /** 右键目标若是目录则作用于它本身，否则作用于其父目录 */
  const targetDir = useCallback(
    (entry: FsEntry | null): string | null => {
      if (!workspace.root) return null
      if (!entry || entry.isDirectory) return entry?.path ?? workspace.root
      return paths.dirname(entry.path)
    },
    [workspace.root]
  )

  /** 菜单作用的目标集合：右键在选区内则是整个选区，否则是右键那一项 */
  const menuTargets = useCallback((state: MenuState): string[] => {
    if (state.entry && state.selection.includes(state.entry.path)) return state.selection
    return state.entry ? [state.entry.path] : []
  }, [])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu || !workspace.root) return []
    const { entry } = menu
    const dir = targetDir(entry)
    const targets = menuTargets(menu)

    const items: ContextMenuItem[] = []

    if (entry && !entry.isDirectory) {
      items.push({
        id: 'open',
        label: '打开',
        onSelect: () => void openEntry(entry)
      })
    }

    if (dir) {
      items.push(
        {
          id: 'newFile',
          label: '新建文件',
          onSelect: () => setNameAction({ kind: 'newFile', dir })
        },
        {
          id: 'newFolder',
          label: '新建文件夹',
          onSelect: () => setNameAction({ kind: 'newFolder', dir })
        }
      )
    }

    if (entry) {
      items.push({
        id: 'rename',
        label: targets.length > 1 ? `重命名（仅「${entry.name}」）` : '重命名',
        onSelect: () => setNameAction({ kind: 'rename', entry })
      })
    }

    if (targets.length > 0) {
      items.push({
        id: 'trash',
        label:
          targets.length > 1 ? `删除 ${targets.length} 项（移入回收站）` : '删除（移入回收站）',
        danger: true,
        onSelect: () => {
          const question =
            targets.length > 1
              ? `确定把选中的 ${targets.length} 项移入回收站吗？`
              : `确定把「${entry?.name}」移入回收站吗？`
          if (!window.confirm(question)) return
          void runOp(() => trashEntries(targets))
        }
      })
    }

    items.push({
      id: 'undo',
      label: undoLabel ? `撤销 ${undoLabel}` : '撤销文件操作',
      hint: 'Ctrl+Z',
      disabled: !undoLabel,
      onSelect: () => void runOp(() => undoLastFileOp().then(() => undefined))
    })

    return items
  }, [menu, workspace.root, targetDir, menuTargets, undoLabel, runOp])

  const submitNameAction = useCallback(
    async (name: string): Promise<void> => {
      const action = nameAction
      if (!action) return

      if (action.kind === 'rename') {
        // 重命名后把选区跟到新路径，否则选区里留的是已经不存在的老路径
        const nextPath = await renameEntry(action.entry.path, name)
        setSelection([nextPath])
        setSelectionAnchor(nextPath)
        return
      }

      if (action.kind === 'newFile') await createFileIn(action.dir, name)
      else await createFolderIn(action.dir, name)

      // 新建后把目录展开，否则在收起状态下点"新建"看不到任何结果
      await expandDirectory(action.dir)
    },
    [nameAction]
  )

  /**
   * 拖拽移动。
   *
   * 不用 HTML5 draggable：那条链路在 Electron 里拿不到可靠的自定义数据，
   * 且落点高亮需要每行写 onDragOver/onDragLeave（进出子元素时会闪）。
   * 这里改成指针事件 —— 位置都是视口坐标，落点由「光标在哪一行上」算出，
   * 与行组件解耦，行组件因此完全不需要知道拖拽存在。
   *
   * 指针在按下时被容器捕获，后续事件一律派发到容器上，
   * 所以判定逻辑全部集中在容器，行组件只需要在 mousedown 时给出"按的是谁"。
   */
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = dragRef.current
      if (!current) return

      const moved =
        current.didMove ||
        Math.abs(event.clientX - current.x) > DRAG_THRESHOLD ||
        Math.abs(event.clientY - current.y) > DRAG_THRESHOLD
      if (!moved) return

      // 一旦越过阈值就升级为拖拽，并记录落点。
      // 判定只在越过时做一次（didMove 后不再读坐标）：松手前鼠标可能因为
      // 抖动回到原处，若那时才判"没动过"，拖拽会被误当成点击。
      if (!current.didMove) setDragState({ ...current, didMove: true })
      setDropDirState(dropTargetAt(event.clientX, event.clientY, treeRef.current))
    },
    [setDragState, setDropDirState]
  )

  /** 松手：位移够大就是拖拽，否则算一次点击 */
  const handlePointerUp = useCallback(() => {
    const current = dragRef.current
    const target = dropDirRef.current
    setDragState(null)
    setDropDirState(null)

    if (!current) return

    if (!current.didMove) {
      if (current.mode === 'plain') {
        // 按下时为了能拖动多选而暂时留住了整个选区，既然没拖动，
        // 这里补上那次收缩：点哪一行就只剩哪一行。
        selectEntry(current.anchor, 'plain', visiblePaths)
        const entry = findEntry(rows, current.anchor)
        if (entry) openEntry(entry)
      }
      return
    }

    if (!target) return
    void runOp(async () => {
      await moveEntries(current.paths, target)
    })
  }, [rows, runOp, setDragState, setDropDirState, visiblePaths])

  /** 点击空白处清除选区；同时把焦点收回树容器，让 Ctrl+A / Ctrl+Z 有落点 */
  const handleTreeMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.button === 0) clearSelection()
  }, [])

  const handleTreeContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) openMenu(event, null)
    },
    [openMenu]
  )

  if (!workspace.root) {
    return (
      <div className="explorer explorer--empty">
        <p className="explorer__empty-text">
          尚未打开文件夹。
          <br />
          打开一个项目后即可浏览与编辑，Agent 也会作用于同一份代码。
        </p>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void handleOpenFolder()}
        >
          <Icon name="plus" size={13} />
          {busy ? '打开中…' : '打开文件夹'}
        </button>
        {workspace.error ? <div className="notice notice--error">{workspace.error}</div> : null}
      </div>
    )
  }

  return (
    <div className="explorer">
      <div className="explorer__toolbar">
        <span className="explorer__root" title={workspace.root}>
          {paths.basename(workspace.root)}
        </span>
        <div className="explorer__toolbar-spacer" />
        <button
          type="button"
          className="explorer__btn"
          title="换一个文件夹"
          disabled={busy}
          onClick={() => void handleOpenFolder()}
        >
          <Icon name="plus" size={13} />
        </button>
        <button
          type="button"
          className="explorer__btn"
          title="刷新"
          disabled={busy}
          onClick={() => void handleRefresh()}
        >
          <Icon name="restart" size={13} />
        </button>
        <button type="button" className="explorer__btn" title="关闭文件夹" onClick={closeFolder}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {workspace.error ? <div className="notice notice--error">{workspace.error}</div> : null}
      {opError ? <div className="notice notice--error">{opError}</div> : null}

      <div
        className="explorer__tree"
        ref={attachTree}
        role="tree"
        aria-multiselectable
        tabIndex={0}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onMouseDown={handleTreeMouseDown}
        onFocus={() => setContextKey('explorerFocused', true)}
        onBlur={() => setContextKey('explorerFocused', false)}
        onKeyDown={(event) => {
          // 与系统文件管理器一致：Ctrl+A 全选可见项，Esc 取消选择
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault()
            selectAllVisible(visiblePaths)
          } else if (event.key === 'Escape') {
            clearSelection()
          }
        }}
        // 空白处右键：作用于工作区根目录，否则根目录下无法新建
        onContextMenu={handleTreeContextMenu}
        // 指针在按下时由容器捕获：拖动一个未选中的项时，后续 pointermove
        // 一律派发到容器，不会因为光标划出该行而丢失事件
        onPointerDown={(event) => {
          if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          setDragState(null)
          setDropDirState(null)
        }}
      >
        {/* 撑起总高度，让滚动条长度反映真实行数（而不是只渲染了可见的十几行） */}
        <div className="explorer__rows" style={{ height: totalHeight, position: 'relative' }}>
          {/* 把可见行整体平移到它们本应在的位置 */}
          <div style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
            {visibleRows.map((row) => (
              <TreeRow
                key={row.entry.path}
                row={row}
                isDropTarget={
                  dropDir !== null &&
                  row.entry.isDirectory &&
                  paths.contains(dropDir, row.entry.path)
                }
                onContextMenu={(event) => openMenu(event, row.entry)}
                onMouseDown={(event) => handleRowMouseDown(event, row.entry)}
              />
            ))}
          </div>
        </div>
        {rows.length === 0 ? <div className="explorer__hint">目录为空</div> : null}
      </div>

      {/* 落点提示浮层：不接收指针事件，否则会打断拖拽过程中的 pointermove */}
      {drag?.didMove ? (
        <div
          className="explorer__drag-ghost"
          style={{ left: drag.x + 12, top: drag.y + 10 }}
          aria-hidden
        >
          <span className={`explorer__drag-arrow${dropDir ? ' is-active' : ''}`} aria-hidden />
          拖动 {drag.paths.length} 项
        </div>
      ) : null}

      {menu && menuItems.length > 0 ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}

      {nameAction ? (
        <PromptDialog
          title={DIALOG_TITLE[nameAction.kind]}
          label={nameAction.kind === 'rename' ? '新名称' : '名称'}
          initialValue={nameAction.kind === 'rename' ? nameAction.entry.name : ''}
          confirmLabel={nameAction.kind === 'rename' ? '重命名' : '创建'}
          validate={validateEntryName}
          onConfirm={submitNameAction}
          onClose={() => setNameAction(null)}
        />
      ) : null}
    </div>
  )
}

const DIALOG_TITLE: Record<NameAction['kind'], string> = {
  newFile: '新建文件',
  newFolder: '新建文件夹',
  rename: '重命名'
}

/**
 * 由指针位置算出落点目录。
 *
 * 命中文件时取它的父目录 —— 用户把东西拖到某个文件上，意图几乎总是"放到这个文件旁边"。
 * 顶部工具栏、标签栏等不在任何行上的位置返回 null（不移动），
 * 而不是回退到根目录：一次误拖不该把文件搬去别处。
 */
function dropTargetAt(
  clientX: number,
  clientY: number,
  tree: HTMLDivElement | null
): string | null {
  if (!tree) return null

  const rect = tree.getBoundingClientRect()
  if (clientY < rect.top || clientY > rect.bottom) return null
  if (clientX < rect.left || clientX > rect.right) return null

  const container = tree.querySelector<HTMLElement>('.explorer__rows')
  if (!container) return null

  // 用坐标反查 DOM 而不是用 clientY 除法：读 offsetTop 需要额外布局计算，
  // elementFromPoint 直接命中真实渲染结果，滚动了也不会算错。
  const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.tree-row')
  if (!hit || !container.contains(hit)) return null

  return hit.dataset.dir ?? hit.dataset.parentDir ?? null
}

/** 打开条目：目录切换展开，文件打开为标签。行点击与右键菜单共用 */
function openEntry(entry: FsEntry): void {
  if (entry.isDirectory) {
    void toggleExpand(entry.path)
    return
  }
  void openFile(entry.path)
  setLayout({ activeEditorView: documentKey(entry.path) })
}

/** 从压平的树里找回某一行：松手时才需要条目，按下时只存路径 */
function findEntry(rows: Row[], path: string): FsEntry | null {
  return rows.find((row) => row.entry.path === path)?.entry ?? null
}

function TreeRow({
  row,
  isDropTarget,
  onContextMenu,
  onMouseDown
}: {
  row: Row
  isDropTarget: boolean
  onContextMenu: (event: ReactMouseEvent) => void
  onMouseDown: (event: ReactMouseEvent) => void
}): JSX.Element {
  const { entry, depth, isExpanded, isLoading, isActive, isSelected } = row

  const className = [
    'tree-row',
    isActive ? 'is-active' : '',
    isSelected ? 'is-selected' : '',
    isDropTarget ? 'is-drop-target' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      role="treeitem"
      aria-expanded={entry.isDirectory ? isExpanded : undefined}
      aria-selected={isSelected}
      className={className}
      data-path={entry.path}
      // 拖拽落点解析读这两个属性：目录落在自身上，文件落在其父目录
      data-dir={entry.isDirectory ? entry.path : undefined}
      data-parent-dir={entry.isDirectory ? undefined : paths.dirname(entry.path)}
      style={{ paddingLeft: 6 + depth * 14, height: ROW_HEIGHT } as CSSProperties}
      title={entry.path}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      <span className={`tree-row__chevron${isExpanded ? ' is-open' : ''}`}>
        {entry.isDirectory ? <span className="tree-row__triangle" /> : null}
      </span>

      {entry.isDirectory ? (
        <span className="tree-row__icon tree-row__icon--dir" />
      ) : (
        <span className="tree-row__icon" style={{ background: colorForFile(entry.name) }} />
      )}

      <span className="tree-row__name">{entry.name}</span>
      {isLoading ? <span className="tree-row__loading">…</span> : null}
    </div>
  )
}

/**
 * 按扩展名给文件一个稳定的标识色。
 *
 * 不引入图标库：P1 用色块已足够区分类型。后续要换成 vscode-icons 之类
 * 完整图标体系时，只需替换这里的实现，不影响其它代码。
 */
const EXT_COLORS: Record<string, string> = {
  ts: '#3178c6',
  tsx: '#3178c6',
  mts: '#3178c6',
  js: '#e2c069',
  jsx: '#e2c069',
  mjs: '#e2c069',
  json: '#cbcb41',
  md: '#519aba',
  css: '#519aba',
  scss: '#c6538c',
  less: '#2a4d80',
  html: '#e37933',
  vue: '#41b883',
  svelte: '#ff3e00',
  py: '#3572a5',
  rs: '#dea584',
  go: '#00add8',
  java: '#b07219',
  kt: '#a97bff',
  c: '#555555',
  h: '#555555',
  cpp: '#f34b7d',
  hpp: '#f34b7d',
  cs: '#178600',
  php: '#4f5d95',
  rb: '#701516',
  sh: '#89e051',
  ps1: '#012456',
  yml: '#cb171e',
  yaml: '#cb171e',
  toml: '#9c4221',
  ini: '#6a6a6a',
  sql: '#e38c00',
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  svg: '#ffb13b',
  webp: '#a074c4',
  ico: '#a074c4',
  mp4: '#e34c26',
  webm: '#e34c26',
  pdf: '#d93831',
  zip: '#8a8a8a',
  lock: '#8a8a8a'
}

function colorForFile(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : ''
  return EXT_COLORS[ext] ?? '#6a6a6a'
}
