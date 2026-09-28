import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { FsEntry } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { documentKey, openFile } from '@renderer/core/editor/editor-store'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { changeCode, changeTitle, normalizeGitPath } from '@renderer/core/git/git-format'
import { useGit } from '@renderer/core/git/git-store'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { setContextKey } from '@renderer/core/platform/context-keys'
import { setLayout } from '@renderer/core/platform/layout-state'
import { compileExclude, isExcluded } from '@renderer/core/workspace/exclude'
import { paths } from '@renderer/core/workspace/fs-client'
import {
  forgetRecentFolder,
  getRecentFolders,
  onRecentFoldersChanged
} from '@renderer/core/workspace/recent-folders'
import {
  copyEntries,
  createFileIn,
  createFolderIn,
  moveEntries,
  onUndoStackChanged,
  peekUndoLabel,
  renameEntry,
  setPasteTargetProvider,
  toCacheKey,
  trashEntries,
  undoLastFileOp,
  validateEntryName
} from '@renderer/core/workspace/file-ops'
import {
  clearClipboard,
  clearSelection,
  closeFolder,
  collapseAll,
  expandDirectory,
  getClipboard,
  getSelection,
  getWorkspaceState,
  onWorkspaceChanged,
  openFolderAt,
  pickAndOpenFolder,
  refreshDirectory,
  selectAllVisible,
  selectEntry,
  setClipboard,
  setSelection,
  setSelectionAnchor,
  toggleExpand,
  type WorkspaceState
} from '@renderer/core/workspace/workspace-store'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { Icon } from '@renderer/workbench/icons'
import { resolveFileIcon } from './file-icons'

/** 行高，必须与 .tree-row 的 margin/字号保持协调（虚拟滚动按它换算偏移） */
const ROW_HEIGHT = 24
/** 视口外多渲染的行数：留一屏缓冲，快速滚动时才不会看到空白 */
const OVERSCAN = 10
/**
 * 判定「这是拖拽而不是点击」的位移阈值（像素）。
 *
 * 系统双击距离是 4px，但自动化测试的合成点击也可能带上 1~2px 抖动，
 * 卡在 4px 会让「点目录展开」偶发失效；放宽到 8px，人手仍感觉不到差别。
 */
const DRAG_THRESHOLD = 8

/**
 * 拖拽悬停在收起目录上多久后自动展开（毫秒）。
 *
 * 取 700ms：比双击间隔略长，足以避免"拖过一行"被误判为"想放进这一行"，
 * 又短到不会让有意放置的用户觉得卡顿。系统文件管理器约 800ms，VS Code 约 500ms。
 */
const HOVER_EXPAND_MS = 700

interface Row {
  entry: FsEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  isActive: boolean
  isSelected: boolean
  /**
   * 紧凑文件夹被合并掉的中间链条（如 `utils/helpers`），末端的真实名字在 entry.name。
   * 有值才渲染尾注；普通行不设该字段。
   */
  compactChain?: string
  /**
   * 该项已被「剪切」但尚未粘贴 —— 渲染成半透明。
   *
   * 状态放核心板（workspace.clipboard）而非视图里：剪贴板要跨视图、跨重新挂载存活，
   * 放在视图 state 会在切换侧边栏视图后丢失。这里只是把它算成逐行的展示标记。
   */
  isCut: boolean
  /**
   * git 状态角标（M/A/D/U/R/C…），无改动时不设。
   *
   * 目录不显示：文件行给出确切状态，目录行在链尾用一个小圆点表示「这底下有改动」——
   * 目录本身没有 XY 状态，硬要合并成单个字母只会误导（收起的目录里可能混着几种）。
   */
  gitCode?: string
  /** 目录是否包含改动（仅在收起时提示，展开后子项自己会说明） */
  gitDirty?: boolean
  /** git 角标的悬浮说明（沿用版本控制视图的文案） */
  gitTitle?: string
}

/**
 * 行内左侧的缩进参考线。
 *
 * VS Code 只有在「悬停」或「活动路径」上才把参考线显形，其余行保持透明，
 * 目的是让当前所在的层级从一屏竖直细线里凸显出来。这里用 CSS 的
 * hover 无法做到（参考线是行的子元素、行本身不随悬停改样式），
 * 因此由容器把「当前悬停行 / 活动路径」算出来，逐行决定要不要画。
 */
const INDENT_BASE = 6
const INDENT_STEP = 12
/** 右键菜单的位置与目标 */
interface MenuState {
  x: number
  y: number
  entry: FsEntry | null
  /** 若右键时存在选区，则记录当时的选区快照（菜单是异步打开的） */
  selection: string[]
}

/**
 * 由根目录路径拼一个 FsEntry（树的第一行展示根目录本身）。
 *
 * readDir 只返回子项，根的路径/目录标记都有，唯独没有名字 ——
 * 名字从路径末尾取（basename 已处理结尾分隔符），不引入额外的读盘。
 */
function rootEntryOf(root: string): FsEntry {
  // size/mtimeMs 在目录行上不展示，占位即可（readDir 不返回根本身，无从取真值）
  return { name: paths.basename(root), path: root, isDirectory: true, size: 0, mtimeMs: 0 }
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
  /**
   * 剪贴板快照，原样保存 store 里的对象引用（setClipboard / clearClipboard 每次
   * 都换新对象，引用比较即可判断变化）。
   *
   * 不能只留「剪切了哪些路径」：复制态与空剪贴板的 cutPaths 都是空集，
   * 二者会被判定为"没变化"，于是复制完剪贴板状态推不到视图里 ——
   * 右键菜单的粘贴项因此不出现（见 diffSnapshot 里的说明）。
   */
  clipboard: WorkspaceState['clipboard']
}

/** 剪贴板里的剪切路径集合；复制态与空剪贴板在这里等价（都无视觉差异） */
function cutPathsOf(clipboard: WorkspaceState['clipboard']): ReadonlySet<string> {
  return clipboard?.mode === 'cut' ? new Set(clipboard.paths) : (EMPTY_SET as ReadonlySet<string>)
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

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

/**
 * git 角标的配色分组。
 *
 * 与版本控制视图的 codeClass 同义（修改黄、新增绿、删除红、重命名/复制用强调色），
 * 但不抽到 git-format 里共用：那里是「数据 → 文案」的纯函数，
 * 而这是视觉分组，资源管理器与版本控制视图的 DOM 结构与既有类名都不同，
 * 强行共用一个返回类名的函数会让两处样式互相牵制。
 */
function gitCodeClass(code: string): string {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
    case 'U':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    default:
      return 'other'
  }
}

function sameSnapshot(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return (
    a.root === b.root &&
    a.error === b.error &&
    a.activeFilePath === b.activeFilePath &&
    sameChildren(a.children, b.children) &&
    sameSet(a.expanded, b.expanded) &&
    sameSet(a.loading, b.loading) &&
    sameSet(a.selection, b.selection) &&
    a.clipboard === b.clipboard
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
    selection: workspace.selection,
    clipboard: workspace.clipboard
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
  if (prev.clipboard !== next.clipboard) {
    // 只标记「剪切」的路径会丢信息：复制态没有视觉差异，于是同样的 cutPaths
    // （都是空集）对应着两种截然不同的 store 状态 —— 空剪贴板、以及"复制了
    // N 项的剪贴板"。快照判定认为"没变"就不会 patch，本地 workspace.clipboard
    // 便一直停在上一次剪切的值上（或 null）。复制之后 workspace.clipboard 若是
    // null，右键菜单的粘贴项直接不出现，粘贴功能看着像坏的。
    // 因此比较剪贴板时按 mode 与 paths 全量比对，复制/清空都能推进快照。
    patch.clipboard = next.clipboard
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
  /** git 状态只读订阅：资源管理器不在自己这一侧触发刷新，随 git-store 的既有节奏走 */
  const git = useGit()
  const { settings } = useApp()
  const [busy, setBusy] = useState(false)
  /** 树内按名筛选（工具栏漏斗按钮展开的输入条）；空串 = 不过滤 */
  const [nameFilterRaw, setNameFilterRaw] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const nameFilter = nameFilterRaw.trim().toLowerCase()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [nameAction, setNameAction] = useState<NameAction | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [undoLabel, setUndoLabel] = useState<string | null>(null)
  /**
   * 树是否持有键盘焦点。
   *
   * 选中底色与焦点描边都要看它：焦点在编辑器/终端时选中行必须降级，
   * 否则用户看不出方向键此刻作用在哪个面板。CSS 的 :focus-within 做不到 ——
   * 树容器本身可聚焦，但焦点也可能落在行内的输入框上，两者语义不同。
   */
  const [focused, setFocused] = useState(false)
  /** 键盘移动到的行（VS Code 的 "cursor"），与鼠标多选集合相互独立 */
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  /**
   * 排序方式。VS Code 默认「文件夹在前」，且是目录树，这里提供两种：
   *   - default：目录在前，同类按名称（与 readDir 的返回顺序一致）
   *   - name：完全按名称，目录与文件混排
   * 只影响展示，不动磁盘。
   */
  const [sortMode, setSortMode] = useState<'default' | 'name'>('default')

  const treeRef = useRef<HTMLDivElement>(null)

  /**
   * 点击行/空白处时把键盘焦点交给树容器。
   *
   * 行本身不可聚焦，点它不会像点输入框那样自动移交焦点 —— 浏览器只把焦点
   * 给最近的可聚焦祖先，而 pointerdown 被容器捕获后这条默认行为也一并丢了。
   * 不主动聚焦，`is-focused` 就永远是 false：选中行不会带描边，方向键也接不上。
   * preventScroll 是必须的：聚焦会让容器把当前行滚进视口，把用户刚滚到的位置顶走。
   */
  const focusTree = useCallback(() => {
    treeRef.current?.focus({ preventScroll: true })
  }, [])

  /** 排序只发生在"取子项"这一步，下游（压平、虚拟滚动、拖拽）全部无感 */
  const childrenOf = useCallback(
    (dir: string): FsEntry[] => {
      const entries = workspace.children.get(dir)
      if (!entries) return []
      if (sortMode === 'default') return entries
      return [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    },
    [workspace.children, sortMode]
  )

  /** 剪贴板里处于「剪切」态的路径；复制态不做视觉标记，故在此过滤掉 */
  const cutPaths = useMemo(() => [...cutPathsOf(workspace.clipboard)], [workspace.clipboard])

  /** 剪贴板内容（复制/剪切共享），菜单与键位都要用它判断"粘贴是否可用" */
  const clipboard = workspace.clipboard

  /**
   * git 状态索引，把「工作区相对路径」映射成角标。
   *
   * 与版本控制视图共用 git-store —— 它已经在工作区根变化、保存文件、
   * Agent 一轮对话结束后自动刷新，这里不必另开刷新时机。
   *
   * 除了逐文件的角标，还顺带算出「哪些目录下有改动」：树的展开状态是
   * 用户自己控制的，一个收起的目录里可能藏着改动，光看可见行会漏掉。
   */
  const gitIndex = useMemo(() => {
    // 键一律用正斜杠：paths.join/dirname 产出的是 /，而文件系统条目给的
    // 是 Windows 反斜杠，不归一化就会全程「查不到」——徽章永远不出现。
    const byPath = new Map<string, { code: string; title: string }>()
    const dirtyDirs = new Set<string>()

    const status = git.status
    const root = workspace.root
    if (!status?.isRepo || !root) return { byPath, dirtyDirs, isRepo: false }

    const rootKey = root.replace(/\\/g, '/')
    for (const change of status.changes) {
      const absolute = paths.join(rootKey, normalizeGitPath(change.path))
      byPath.set(absolute, { code: changeCode(change), title: changeTitle(change) })

      // 逐级向上标记父目录：改动数不多，这里的成本可以忽略，
      // 换来的是目录折叠时也能看出"底下的东西动过"
      let dir = paths.dirname(absolute)
      while (paths.contains(rootKey, dir) && dir !== rootKey) {
        dirtyDirs.add(dir)
        const parent = paths.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }

    return { byPath, dirtyDirs, isRepo: true }
  }, [git.status, workspace.root])

  const rows = useMemo(() => {
    const out: Row[] = []
    const excludeRules = compileExclude(settings.filesExclude)

    /**
     * 树的第一行是根目录本身（对齐 VS Code / wuzu-client：根节点可折叠、
     * 选中后新建/粘贴都落在它身上）。它不受 files.exclude 与树内筛选影响 ——
     * 把根滤掉等于整棵树消失，没有任何场景需要这样。
     */
    const root = workspace.root
    if (root) {
      const rootGitKey = root.replace(/\\/g, '/')
      const isRootExpanded = workspace.expanded.has(root)
      out.push({
        entry: rootEntryOf(root),
        depth: 0,
        isExpanded: isRootExpanded,
        isLoading: workspace.loading.has(root),
        isActive: false,
        isSelected: workspace.selection.has(root),
        isCut: false,
        gitDirty: !isRootExpanded && gitIndex.dirtyDirs.has(rootGitKey)
      })
      // 根收起时整棵树只剩这一行（VS Code 同样如此）
      if (!isRootExpanded) return out
    }

    /**
     * 某条目（相对工作区根）是否被 files.exclude 隐藏。
     * `parentHidden` 由调用方沿链传下来实现「父隐藏则子树全隐藏」。
     */
    const hidden = (entry: FsEntry, parentHidden: boolean): boolean => {
      if (excludeRules.length === 0) return false
      const rel = workspace.root ? paths.relative(workspace.root, entry.path) : entry.path
      return isExcluded(excludeRules, rel, entry.name, parentHidden)
    }

    /**
     * 紧凑文件夹（Compact Folders）：把「只有一个子目录」的链条合并成一行。
     *
     * src/utils/helpers/strings.ts 这种三层结构，在逐行展开的树里要占三行、
     * 每层还要吃掉 14px 缩进 —— 纵向空间全用在"路过"上。VS Code 的做法是
     * 合并展示为 `strings.ts  src/utils/helpers`（真实名字在前，链条作尾注），
     * 一次点击展开到链条末端。
     *
     * 只在"有且仅有一个子项、且该子项是目录、且链条中间层都处于展开态"时合并：
     * - 折叠的中间层不应该被穿透 —— 用户点收了 utils，就不该还显示到更深一层
     * - 子项一旦是文件也停，因为文件是要操作的对象，不是"路过"的层级
     * - 子目录未被加载（children 里没有）时也停，否则会把"未知"当成"只有一个"
     */
    const compactChain = (
      start: FsEntry,
      startDepth: number,
      startHidden: boolean
    ): { entry: FsEntry; depth: number; chain: string } | null => {
      let current = start
      let depth = startDepth
      let chain = ''
      let parentHidden = startHidden
      for (;;) {
        const kids = childrenOf(current.path)
        // 被排除的项在链条里不算「子项」，否则会把「只有一个可见子目录」误判成两个
        const visibleKids = kids.filter((kid) => !hidden(kid, parentHidden))
        if (visibleKids.length !== 1) break
        const only = visibleKids[0]
        if (!only.isDirectory) break
        // 中间层没展开就说明用户主动收起了，链条到此为止
        if (!workspace.expanded.has(current.path)) break

        // 链条记的是「被合并掉的中间层」的名字（current 自己），而不是后代的名字 ——
        // 记 only.name 会把末端目录自己的名字也拼进去，显示成 `sdk sdk` 这种重复
        chain = chain ? `${chain}/${current.name}` : current.name
        current = only
        depth += 1
        parentHidden = parentHidden || hidden(only, parentHidden)
      }
      return chain ? { entry: current, depth, chain } : null
    }

    const walk = (dir: string, depth: number, parentHidden: boolean): void => {
      for (const entry of childrenOf(dir)) {
        // files.exclude：命中的条目连同其整棵子树都不展示。
        // 注意这里只是「不渲染」，不是「不加载」—— 目录仍可被展开、
        // 其子项仍在缓存里，把规则去掉后立刻重新出现。
        const entryHidden = hidden(entry, parentHidden)
        if (entryHidden) continue

        // 树内按名筛选：命中项保留，目录始终下钻（其子项可能命中）
        if (nameFilter && !entry.name.toLowerCase().includes(nameFilter)) {
          if (entry.isDirectory) walk(entry.path, depth + 1, entryHidden)
          continue
        }

        const compact = nameFilter ? null : entry.isDirectory ? compactChain(entry, depth, entryHidden) : null
        const shown = compact?.entry ?? entry
        const shownDepth = compact?.depth ?? depth
        const isExpanded = shown.isDirectory && workspace.expanded.has(shown.path)
        // gitIndex 的键是正斜杠（paths.join 的产出），条目路径在 Windows 上是
        // 反斜杠，查表前必须归一化，否则角标永远查不到
        const gitKey = shown.path.replace(/\\/g, '/')
        const change = gitIndex.byPath.get(gitKey)

        out.push({
          entry: shown,
          depth: shownDepth,
          isExpanded,
          isLoading: workspace.loading.has(shown.path),
          isActive: !shown.isDirectory && shown.path === workspace.activeFilePath,
          isSelected: workspace.selection.has(shown.path),
          compactChain: compact?.chain,
          // 剪切态用「祖先在剪贴板里」而非精确匹配：剪切一个目录后，
          // 其子项若展开着，视觉上也应当一并变淡 —— 否则会像是"只剪了这一层"。
          isCut: cutPaths.some((cutPath) => paths.contains(cutPath, shown.path)),
          gitCode: change?.code,
          gitTitle: change?.title,
          // 目录只在「收起」时提示有改动：展开后每个子项自己会写明状态，
          // 父目录再挂个聚合标记纯属重复，还会跟子项的角标抢视线。
          gitDirty: !shown.isDirectory ? undefined : !isExpanded && gitIndex.dirtyDirs.has(gitKey)
        })
        if (isExpanded) walk(shown.path, shownDepth + 1, false)
      }
    }
    // 根目录的子项从第二层（depth 1）开始：第一层是根节点行本身
    if (root) walk(root, 1, false)
    return out
  }, [
    childrenOf,
    workspace.expanded,
    workspace.loading,
    workspace.root,
    workspace.activeFilePath,
    workspace.selection,
    cutPaths,
    gitIndex,
    settings.filesExclude,
    nameFilter
  ])

  /** 可见行的路径序列，供全选与 Shift 连选使用 */
  const visiblePaths = useMemo(() => rows.map((row) => row.entry.path), [rows])

  /**
   * 粘性父级链（Sticky Scroll）：滚动时把当前位置的祖先目录钉在树顶。
   *
   * 没有它，滚进深层目录后「自己在哪个目录里」就完全丢失 —— 父级行被滚出视口，
   * 只剩缩进参考线，用户要靠心算层级（wuzu-client 与 VS Code 都把祖先钉在顶部）。
   *
   * 算法：取视口内第一个可见行，向前回溯收集它的各级祖先（depth 逐级减一的目录行）。
   * 祖先的下标一定小于首个可见行（深度优先展开序），因此它们必然已滚出视口，
   * 不会与粘性幻影重复出现，无需做占位纠正。
   *
   * 链高封顶在视口的 40%：深层嵌套 + 矮侧边栏时，不封顶会把整棵树盖没。
   * 超限时保留「最深」的几级 —— 离当前位置越近的父级越能回答"我在哪"。
   */
  const stickyChain = useMemo(() => {
    if (rows.length === 0 || viewportHeight === 0) return []
    const firstVisible = Math.min(rows.length - 1, Math.floor(scrollTop / ROW_HEIGHT))
    const chain: Row[] = []
    let needDepth = rows[firstVisible].depth - 1
    for (let i = firstVisible - 1; i >= 0 && needDepth >= 0; i--) {
      const row = rows[i]
      if (row.depth === needDepth && row.entry.isDirectory) {
        chain.unshift(row)
        needDepth -= 1
      }
    }
    const maxSticky = Math.max(1, Math.floor((viewportHeight * 0.4) / ROW_HEIGHT))
    return chain.length > maxSticky ? chain.slice(chain.length - maxSticky) : chain
  }, [rows, scrollTop, viewportHeight])

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
   *
   * 声明位置在 foldCursor 之前：键盘展开也要写这个待办，函数提升不管 ref。
   */
  const revealDirRef = useRef<string | null>(null)

  /**
   * 键盘导航：上下移动光标行。
   *
   * 光标行只在树持有焦点时存在，且与鼠标多选分开维护 —— 这正是 VS Code 的
   * 模型：`focused` 决定「键盘作用在哪」，`selection` 决定「操作哪些项」。
   * 混在一起会导致方向键一动就把辛苦选好的多项选区冲掉。
   *
   * Shift 扩展选区的语义交给 selectEntry 的 range 模式（它按可见顺序切片），
   * 因此这里只负责算出目标行并把它滚进视口。
   */
  const moveCursor = useCallback(
    (delta: number, extend: boolean) => {
      if (rows.length === 0) return

      const currentIndex = cursorPath ? rows.findIndex((row) => row.entry.path === cursorPath) : -1
      // 没有光标时：向下从第一行起步，向上从最后一行起步
      const nextIndex =
        currentIndex < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, currentIndex + delta))

      const target = rows[nextIndex]
      if (!target) return

      setCursorPath(target.entry.path)
      if (extend) selectEntry(target.entry.path, 'range', visiblePaths)
      else selectEntry(target.entry.path, 'plain', visiblePaths)
      scrollRowIntoView(target.entry.path)
    },
    [cursorPath, rows, visiblePaths, scrollRowIntoView]
  )

  /**
   * Type-ahead：连续键入可打印字符，把光标跳到下一个匹配的行。
   *
   * 两个必须处理的细节：
   * 1. 前缀要在短时间内累积（VS Code 是约 1s）。否则打 "st" 会被当成两次
   *    独立的 "s" 和 "t"，永远跳不到 src/types.ts 这种需要两个字符才唯一的目标。
   * 2. 匹配从「当前光标的下一个」开始并环形回绕，这样连按同一个字母可以在
   *    多个同前缀项之间循环，而不是每次都停在第一个。
   */
  const typeaheadRef = useRef<{ prefix: string; at: number }>({ prefix: '', at: 0 })
  const TYPEAHEAD_RESET_MS = 1000

  const typeahead = useCallback(
    (char: string, extend: boolean) => {
      if (rows.length === 0) return

      const now = Date.now()
      const isFresh = now - typeaheadRef.current.at < TYPEAHEAD_RESET_MS
      const prefix = (isFresh ? typeaheadRef.current.prefix : '') + char
      typeaheadRef.current = { prefix, at: now }

      // 单字符时忽略大小写；多字符时要求前缀连续匹配（大小写不敏感），
      // 否则 "ab" 会跳到一个只含 a 后面随便跟 b 的文件
      const needle = prefix.toLowerCase()
      const currentIndex = cursorPath ? rows.findIndex((row) => row.entry.path === cursorPath) : -1

      for (let offset = 1; offset <= rows.length; offset += 1) {
        const index = (currentIndex + offset + rows.length) % rows.length
        const row = rows[index]
        if (row.entry.name.toLowerCase().startsWith(needle)) {
          setCursorPath(row.entry.path)
          if (extend) selectEntry(row.entry.path, 'range', visiblePaths)
          else selectEntry(row.entry.path, 'plain', visiblePaths)
          scrollRowIntoView(row.entry.path)
          return
        }
      }
      // 没有命中就什么都不做，但前缀已累积 —— 用户接着打字仍能修正
    },
    [cursorPath, rows, visiblePaths, scrollRowIntoView]
  )

  /**
   * F2 重命名当前光标行（VS Code 的键位）。
   * 复用与右键菜单相同的 PromptDialog 流程，不另做一套行内编辑 ——
   * 两套输入路径会产生两套校验与两套焦点处理，收益却只是省一次对话框。
   */
  const renameCursor = useCallback(() => {
    const row = cursorPath ? rows.find((item) => item.entry.path === cursorPath) : null
    if (!row) return
    setNameAction({ kind: 'rename', entry: row.entry })
  }, [cursorPath, rows])

  /**
   * 左右方向键：右键展开、左键收起（VS Code 的语义是
   * 「右键 → 展开或进入第一个子项；左键 → 收起或回到父目录」，
   * 这里只保留展开/收起，不做"进入子项"——那需要额外的焦点模型）。
   */
  const foldCursor = useCallback(
    (expand: boolean) => {
      const row = cursorPath ? rows.find((item) => item.entry.path === cursorPath) : null
      if (!row || !row.entry.isDirectory) return

      if (expand && !row.isExpanded) {
        revealDirRef.current = row.entry.path
        void expandDirectory(row.entry.path)
      } else if (!expand && row.isExpanded) {
        void toggleExpand(row.entry.path)
      }
    },
    [cursorPath, rows]
  )

  /** 回车：等同于用鼠标点一下光标行 */
  const openCursor = useCallback(() => {
    const row = cursorPath ? rows.find((item) => item.entry.path === cursorPath) : null
    if (row) openEntry(row.entry)
  }, [cursorPath, rows])

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

  /**
   * 「定位当前文件」：把当前打开文件所在的目录链全部展开，再把它滚进视口。
   *
   * 自动 reveal 只在激活文件换人时滚一次（上面那条 effect 的记账规则），
   * 用户手动触发时必须显式清账，否则同一文件第二次点击会没有反应。
   * 展开是从根往下逐级 await 的：父目录没加载出来，子目录路径在树的
   * children 缓存里根本不存在，一次性并行展开会漏掉中间层。
   */
  const handleRevealActive = useCallback(async (): Promise<void> => {
    const target = workspace.activeFilePath
    const root = getWorkspaceState().root
    if (!target || !root) return

    revealedFileRef.current = null

    const normalize = (p: string): string => p.replace(/\\/g, '/')
    const rootNorm = normalize(root).replace(/\/+$/, '')
    const ancestors: string[] = []
    let dir = paths.dirname(target)
    while (normalize(dir).length >= rootNorm.length) {
      ancestors.unshift(dir)
      if (normalize(dir) === rootNorm) break
      const parent = paths.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const ancestor of ancestors) await expandDirectory(ancestor)

    // 祖先本已展开时，上面的展开不会改变 rows，滚动的 effect 不会重跑，
    // 这里直接补滚一次（行已在树里就立即到位）；行还没加载出来时返回 false，
    // 由 revealedFileRef 已清账的那条 effect 在 rows 更新后补滚。
    scrollRowIntoView(target)
  }, [workspace.activeFilePath, scrollRowIntoView])

  // 外部命令（快捷键 / 命令面板）执行时，视图自身没有触发点，靠上下文键告知它有选区可选
  useEffect(() => {
    setContextKey('explorerHasSelection', workspace.selection.size > 0)
  }, [workspace.selection])

  // 有剪贴板内容才让「粘贴」命令出现在命令面板/快捷键表中
  useEffect(() => {
    setContextKey('explorerClipboardReady', workspace.clipboard !== null)
  }, [workspace.clipboard])

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

  /**
   * 空态的「最近打开」列表：与欢迎页、Git 面板同源（localStorage）。
   * 点击直接打开该项目；目录已删/无权限时 readDir 报错会落到 workspace.error 上，
   * 摆到用户眼前，用户可自行用行尾的「×」把这条记录摘掉。
   */
  const recentFolders = useSyncExternalStore(onRecentFoldersChanged, getRecentFolders)
  const recentProjects = useMemo(
    () =>
      recentFolders
        .filter((folder) => folder !== workspace.root)
        .map((folder) => ({
          path: folder,
          name: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
        })),
    [recentFolders, workspace.root]
  )
  const openRecentProject = useCallback((folder: string): void => {
    void openFolderAt(folder).catch(() => forgetRecentFolder(folder))
  }, [])

  const handleRefresh = useCallback(async () => {
    if (!workspace.root) return
    setBusy(true)
    await refreshDirectory(workspace.root)
    setBusy(false)
  }, [workspace.root])

  /** 收起全部：清空展开集合即可（子项缓存留着，再展开时无需重新读盘） */
  const handleCollapseAll = useCallback(() => {
    collapseAll()
  }, [])

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

      // 点行即接管键盘焦点：否则选中行拿不到描边，方向键也接不上
      focusTree()

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

      // 鼠标点哪儿，键盘光标就跟到哪儿（VS Code 同样如此）：
      // 点完一行再按方向键，应从这一行的下/上一行继续，而不是凭空跳到树顶。
      setCursorPath(entry.path)

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
    [visiblePaths, setDragState, workspace.selection, focusTree]
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
      // 一律走 root 的路径写法（paths.dirname 给的是正斜杠，root 是反斜杠）。
      // 同一个菜单里"右键目录"和"右键文件"必须算出同一种落点，否则
      // "粘贴到哪"会随右键对象在两种写法间跳。
      if (!entry || entry.isDirectory) return entry?.path ?? workspace.root
      return toCacheKey(paths.dirname(entry.path))
    },
    [workspace.root]
  )

  /** 菜单作用的目标集合：右键在选区内则是整个选区，否则是右键那一项 */
  const menuTargets = useCallback((state: MenuState): string[] => {
    if (state.entry && state.selection.includes(state.entry.path)) return state.selection
    return state.entry ? [state.entry.path] : []
  }, [])

  /**
   * 删除（移入回收站）的唯一入口。
   *
   * 菜单项、Delete 键、Backspace 键三条路径都走这里 —— 否则确认文案会分叉，
   * 用户从键盘删除和从菜单删除看到的提示不一样，后续改文案也必然漏改一处。
   */
  const handleTrash = useCallback(
    async (targets: string[], label?: string): Promise<void> => {
      if (targets.length === 0) return
      const question =
        targets.length > 1
          ? `确定把选中的 ${targets.length} 项移入回收站吗？`
          : `确定把「${label ?? paths.basename(targets[0])}」移入回收站吗？`
      const confirmed = await confirmDialog({
        title: '移入回收站',
        body: question,
        confirmText: '移入回收站',
        danger: true
      })
      if (!confirmed) return
      await runOp(() => trashEntries(targets))
    },
    [runOp]
  )

  /** 键盘删除：作用于整个选区（与 Delete 键在系统文件管理器里的语义一致） */
  const trashSelection = useCallback(() => {
    void handleTrash([...workspace.selection], undefined)
  }, [handleTrash, workspace.selection])

  /** 记住「剪切」：贴在剪贴板上的是一组路径 + 意图（cut），粘贴时才决定移动还是复制 */
  const cutSelection = useCallback(() => {
    const targets = [...workspace.selection]
    if (targets.length === 0) return
    setClipboard(targets, 'cut')
  }, [workspace.selection])

  const copySelection = useCallback(() => {
    const targets = [...workspace.selection]
    if (targets.length === 0) return
    setClipboard(targets, 'copy')
  }, [workspace.selection])

  /**
   * 粘贴到目标目录。
   *
   * 落点规则与右键菜单的 targetDir 一致：有光标行就贴进它（目录贴进去、
   * 文件贴到它旁边），否则贴到工作区根目录。这样"键盘粘贴"不需要先点一下空白处
   * 把选区清掉——光标行天然就是落点，符合用户"粘贴到当前所在位置"的直觉。
   *
   * 粘贴成功后清空剪贴板：剪切的含义已被消费掉；复制则保留——
   * 系统里允许连续复制多份，清掉会逼用户重新复制一次。
   */
  const pasteInto = useCallback(
    (targetDirPath: string | null): void => {
      const clip = getClipboard()
      if (!clip || !targetDirPath) return

      const isCut = clip.mode === 'cut'
      void runOp(async () => {
        if (isCut) {
          // 只有真的搬动了才清剪贴板。剪切一个文件、粘贴到它自己所在的目录时
          // planMoves 会跳过（已经在目标位置），此时若清空，用户就白白丢了剪贴板 ——
          // 而"贴错地方了，换个目录再贴"恰恰是剪切后最常见的动作。
          const moved = await moveEntries(clip.paths, targetDirPath)
          if (moved > 0) clearClipboard()
        } else {
          const created = await copyEntries(clip.paths, targetDirPath)
          // 复制出来的副本就地选中，让用户看清生成了什么
          if (created.length > 0) {
            setSelection(created)
            setSelectionAnchor(created[0])
          }
        }
      })
    },
    [runOp]
  )

  /**
   * 键盘粘贴的落点目录。
   *
   * 光标行是目录 → 贴进它；是文件 → 贴到它旁边；
   * 无光标 → 贴到工作区根目录（粘贴的常见语境是"贴到这个项目里"）。
   */
  const pasteTargetDir = useCallback((): string | null => {
    if (!workspace.root) return null
    const row = cursorPath ? rows.find((item) => item.entry.path === cursorPath) : null
    if (!row) return workspace.root
    return row.entry.isDirectory ? row.entry.path : paths.dirname(row.entry.path)
  }, [workspace.root, cursorPath, rows])

  /**
   * 把「粘贴落点从哪来」交给 core 层。
   *
   * 命令与全局快捷键在 core 层注册，它们不知道光标停在哪一行 ——
   * 由视图把算落点的函数注册进去。依赖里带上 pasteTargetDir（它随光标行变化），
   * 保证注册的永远是当前这一份闭包，否则粘贴会贴到很久以前的光标位置上。
   */
  useEffect(() => {
    setPasteTargetProvider(pasteTargetDir)
    return () => setPasteTargetProvider(null)
  }, [pasteTargetDir])

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
        hint: 'F2',
        onSelect: () => setNameAction({ kind: 'rename', entry })
      })
    }

    // 剪切 / 复制 / 粘贴：作用于"选区"而非"右键那一项"，与系统文件管理器一致 ——
    // 右键在选区内时整批生效，右键在选区外时选区已被换成这一项。
    if (targets.length > 0) {
      items.push(
        {
          id: 'cut',
          label: targets.length > 1 ? `剪切 ${targets.length} 项` : '剪切',
          hint: 'Ctrl+X',
          onSelect: () => setClipboard(targets, 'cut')
        },
        {
          id: 'copy',
          label: targets.length > 1 ? `复制 ${targets.length} 项` : '复制',
          hint: 'Ctrl+C',
          onSelect: () => setClipboard(targets, 'copy')
        }
      )
    }

    // 粘贴只在有剪贴板内容且能算出落点目录时出现；dir 为空说明右键在树外，无处可贴
    if (clipboard && dir) {
      items.push({
        id: 'paste',
        label: clipboard.mode === 'cut' ? `粘贴（移动 ${clipboard.paths.length} 项）` : '粘贴',
        hint: 'Ctrl+V',
        onSelect: () => pasteInto(dir)
      })
    }

    if (targets.length > 0) {
      items.push({
        id: 'trash',
        label:
          targets.length > 1 ? `删除 ${targets.length} 项（移入回收站）` : '删除（移入回收站）',
        hint: 'Delete',
        danger: true,
        onSelect: () => void handleTrash(targets, entry?.name)
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
  }, [
    menu,
    workspace.root,
    targetDir,
    menuTargets,
    undoLabel,
    runOp,
    handleTrash,
    clipboard,
    pasteInto
  ])

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
   * 悬停自动展开：拖拽时把光标停在收起的目标目录上约 0.7s，就把它展开。
   *
   * 没有它，往深层目录拖文件就得先中断拖拽、展开、再重新拖一次 ——
   * 系统文件管理器与 VS Code 都提供这个能力，用户默认它会存在。
   *
   * 记在 ref 里而不是 state：这只是"过一会儿要做的事"，不参与渲染，
   * 写进 state 会为了每次移动都重渲染一遍（pointermove 是高频事件）。
   * 计数器用于取消：光标离开或换了目标，旧的计时必须作废，
   * 否则会展开一个用户只是"路过"的目录。
   */
  const hoverExpandRef = useRef<{
    dir: string | null
    timer: ReturnType<typeof setTimeout> | null
  }>({ dir: null, timer: null })

  /**
   * workspace 的最新引用。
   *
   * 悬停展开的计时器在 setTimeout 里读 expanded，而回调是排期那一刻的闭包 ——
   * 直接读 workspace 会拿到过期快照（比如目录已经被别的操作展开了却仍判为收起）。
   * 用 ref 镜像最新值，判定始终基于当前状态，同时让 scheduleHoverExpand 不必
   * 依赖 workspace.expanded（否则每次展开都要重建回调，连带 handlePointerMove 一起换）。
   */
  const dirRef = useRef(workspace)
  dirRef.current = workspace

  const cancelHoverExpand = useCallback(() => {
    const state = hoverExpandRef.current
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    state.dir = null
  }, [])

  const scheduleHoverExpand = useCallback((dir: string | null) => {
    const state = hoverExpandRef.current
    // 光标还在同一个目录上：让已有计时继续跑，不要重置，否则轻微抖动会不断推迟
    if (state.dir === dir) return

    if (state.timer !== null) clearTimeout(state.timer)
    state.dir = dir
    state.timer = null

    // 只对"收起着的目录"排期：已是展开态再排期只会白白触发一次刷新
    if (!dir || dirRef.current.expanded.has(dir)) return

    state.timer = setTimeout(() => {
      state.timer = null
      state.dir = null
      revealDirRef.current = dir
      void expandDirectory(dir)
    }, HOVER_EXPAND_MS)
  }, [])

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

      const target = dropTargetAt(event.clientX, event.clientY, treeRef.current)
      setDropDirState(target)
      scheduleHoverExpand(target)
    },
    [setDragState, setDropDirState, scheduleHoverExpand]
  )

  /** 松手：位移够大就是拖拽，否则算一次点击 */
  const handlePointerUp = useCallback(() => {
    const current = dragRef.current
    const target = dropDirRef.current
    setDragState(null)
    setDropDirState(null)
    // 拖拽已结束，任何在途的"悬停展开"都必须作废 —— 否则松手后目录才姗姗展开
    cancelHoverExpand()

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
  }, [rows, runOp, setDragState, setDropDirState, visiblePaths, cancelHoverExpand])

  /** 点击空白处清除选区；同时把焦点收回树容器，让 Ctrl+A / Ctrl+Z 有落点 */
  const handleTreeMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || event.button !== 0) return
      clearSelection()
      focusTree()
    },
    [focusTree]
  )

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
        {recentProjects.length > 0 ? (
          <div className="explorer__recent">
            <div className="explorer__recent-title">最近打开</div>
            <div className="explorer__recent-list">
              {recentProjects.map((project) => (
                <div key={project.path} className="explorer__recent-row">
                  <button
                    type="button"
                    className="explorer__recent-item"
                    title={project.path}
                    onClick={() => openRecentProject(project.path)}
                  >
                    <Icon name="explorer" size={13} />
                    <span className="explorer__recent-name">{project.name}</span>
                  </button>
                  <button
                    type="button"
                    className="explorer__recent-del"
                    title="从最近打开中移除"
                    aria-label={`从最近打开中移除 ${project.name}`}
                    onClick={() => forgetRecentFolder(project.path)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {workspace.error ? <div className="notice notice--error">{workspace.error}</div> : null}
      </div>
    )
  }

  return (
    <div className="explorer">
      <div className="explorer__toolbar">
        <span className="explorer__root" title={workspace.root}>
          <span className="explorer__root-label">资源</span>
          <span className="explorer__root-name">{paths.basename(workspace.root).toUpperCase()}</span>
        </span>
        <div className="explorer__toolbar-spacer" />

        {filterOpen ? (
          <input
            type="text"
            className="explorer__filter"
            placeholder="筛选文件名…"
            autoFocus
            value={nameFilterRaw}
            onChange={(event) => setNameFilterRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setNameFilterRaw('')
                setFilterOpen(false)
              }
            }}
          />
        ) : null}
        <button
          type="button"
          className="explorer__btn"
          title={sortMode === 'default' ? '排序：默认（文件夹在前）' : '排序：按名称'}
          aria-label="切换排序方式"
          onClick={() => setSortMode((prev) => (prev === 'default' ? 'name' : 'default'))}
        >
          <Icon name="sort" size={13} />
        </button>
        <button
          type="button"
          className="explorer__btn"
          title="全部收起"
          aria-label="全部收起"
          onClick={handleCollapseAll}
        >
          <Icon name="collapse-all" size={13} />
        </button>
        <button
          type="button"
          className={`explorer__btn${filterOpen || nameFilter ? ' is-on' : ''}`}
          title="按名称筛选（在已加载的树内过滤）"
          onClick={() => setFilterOpen((open) => !open)}
        >
          <Icon name="search" size={13} />
        </button>
        <button
          type="button"
          className="explorer__btn"
          title="定位当前文件"
          disabled={!workspace.activeFilePath}
          onClick={handleRevealActive}
        >
          <Icon name="locate" size={13} />
        </button>
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
          className={`explorer__btn${busy ? ' is-refreshing' : ''}`}
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

      {/* 树区容器：粘性父级行相对它定位，工具栏/错误提示条的高度变化不会让它错位 */}
      <div className="explorer__body">
        <div
          className={`explorer__tree${focused ? ' is-focused' : ''}`}
        ref={attachTree}
        role="tree"
        aria-multiselectable
        tabIndex={0}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onMouseDown={handleTreeMouseDown}
        onFocus={() => {
          setFocused(true)
          setContextKey('explorerFocused', true)
        }}
        onBlur={() => {
          setFocused(false)
          setContextKey('explorerFocused', false)
        }}
        onKeyDown={(event) => {
          // 与系统文件管理器一致：Ctrl+A 全选可见项，Esc 取消选择
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault()
            selectAllVisible(visiblePaths)
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') {
            // 先在树内处理 Ctrl+X/C/V 并 stopPropagation：
            // 全局派发器此刻同步执行命令，而树内 React 合成事件是异步的、
            // 排在其后 —— 不挡住的话剪贴板命令会先跑一次，这里的处理再跑一次。
            event.preventDefault()
            event.stopPropagation()
            cutSelection()
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
            event.preventDefault()
            event.stopPropagation()
            copySelection()
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
            event.preventDefault()
            event.stopPropagation()
            pasteInto(pasteTargetDir())
          } else if (event.key === 'Escape') {
            clearSelection()
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveCursor(1, event.shiftKey)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveCursor(-1, event.shiftKey)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            foldCursor(true)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            foldCursor(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            openCursor()
          } else if (event.key === 'F2') {
            // VS Code 的 F2；也必须拦掉，不然会走浏览器/系统的默认行为
            event.preventDefault()
            renameCursor()
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            // Backspace 与 Delete 同义：两个键都是文件管理器里的"删除"直觉。
            // 树里没有文本输入，不存在误删字符的风险。
            // 必须 stopPropagation：全局派发器还挂着一条带 window.confirm 的
            // delete 绑定（命令面板/菜单入口共用），它会先于 React 合成事件跑完，
            // 在无头环境下 confirm 会一直挂住，删除看着像"按了没反应"。
            event.preventDefault()
            event.stopPropagation()
            trashSelection()
          } else if (
            // Type-ahead：可打印单字符，且没有按下 Ctrl/Alt（避免抢走 Ctrl+C 等）
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            event.key.length === 1
          ) {
            event.preventDefault()
            typeahead(event.key, event.shiftKey)
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
          cancelHoverExpand()
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
                isCursor={row.entry.path === cursorPath}
                nameFilter={nameFilter}
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
        {/* 根行恒在：空目录 = 根已展开却没有任何子项行 */}
        {rows.length <= 1 && workspace.root && workspace.expanded.has(workspace.root) ? (
          <div className="explorer__hint">目录为空</div>
        ) : null}
      </div>

      {/* 粘性父级行：钉在树顶，与树容器平级 —— 若放在滚动内容内部会跟着滚走。
          点击语义是「定位」而不是折叠：把被滚走的原行滚回视口（与 VS Code 一致），
          滚回原行后它进入视口，粘性链自然消失。 */}
      {stickyChain.length > 0 ? (
        <div className="explorer__sticky" aria-hidden>
          {stickyChain.map((row) => (
            <TreeRow
              key={row.entry.path}
              row={row}
              isCursor={row.entry.path === cursorPath}
              isDropTarget={false}
              onContextMenu={(event) => openMenu(event, row.entry)}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                selectEntry(row.entry.path, 'plain', visiblePaths)
                setCursorPath(row.entry.path)
                focusTree()
                scrollRowIntoView(row.entry.path)
              }}
            />
          ))}
        </div>
      ) : null}
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

/** 筛选时把命中的片段包上 <mark>（无筛选或未命中返回原名） */
function highlightName(name: string, filter: string | undefined): JSX.Element | string {
  if (!filter) return name
  const index = name.toLowerCase().indexOf(filter)
  if (index < 0) return name
  return (
    <>
      {name.slice(0, index)}
      <mark className="tree-match">{name.slice(index, index + filter.length)}</mark>
      {name.slice(index + filter.length)}
    </>
  )
}

/** 文件类型矢量图标（mdi 图标集 + seti 色板，映射表见 file-icons.ts） */
function FileGlyph({ name }: { name: string }): JSX.Element {
  const icon = resolveFileIcon(name)
  return (
    <svg
      className="tree-row__glyph"
      viewBox="0 0 24 24"
      width={15}
      height={15}
      style={{ color: icon.color }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  )
}

function TreeRow({
  row,
  isCursor,
  isDropTarget,
  nameFilter,
  onContextMenu,
  onMouseDown
}: {
  row: Row
  isCursor: boolean
  isDropTarget: boolean
  nameFilter?: string

  onContextMenu: (event: ReactMouseEvent) => void
  onMouseDown: (event: ReactMouseEvent) => void
}): JSX.Element {
  const { entry, depth, isExpanded, isLoading, isActive, isSelected, isCut } = row

  const className = [
    'tree-row',
    isActive ? 'is-active' : '',
    isSelected ? 'is-selected' : '',
    isCursor ? 'is-cursor' : '',
    isCut ? 'is-cut' : '',
    isDropTarget ? 'is-drop-target' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      role="treeitem"
      aria-expanded={entry.isDirectory ? isExpanded : undefined}
      aria-selected={isSelected}
      aria-level={depth + 1}
      className={className}
      data-path={entry.path}
      // 拖拽落点解析读这两个属性：目录落在自身上，文件落在其父目录
      data-dir={entry.isDirectory ? entry.path : undefined}
      data-parent-dir={entry.isDirectory ? undefined : paths.dirname(entry.path)}
      style={
        { paddingLeft: INDENT_BASE + depth * INDENT_STEP, height: ROW_HEIGHT } as CSSProperties
      }
      title={entry.path}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      {/* 每往里一层就多一条竖线，画在这一层的起始缩进处。
          depth 为 0 的顶层没有父级，自然不画。 */}
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="explorer__indent"
          style={{ left: INDENT_BASE + level * INDENT_STEP + 6 }}
          aria-hidden
        />
      ))}

      <span className={`tree-row__chevron${isExpanded ? ' is-open' : ''}`}>
        {entry.isDirectory ? <span className="tree-row__chevron-glyph" /> : null}
      </span>

      {entry.isDirectory ? (
        <span className={`tree-row__icon tree-row__icon--dir${isExpanded ? ' is-open' : ''}`} />
      ) : (
        <FileGlyph name={entry.name} />
      )}

      {/* 名字区占据整行的剩余宽度：右侧标记因它撑满而被顶到行尾，
          长文件名则在区内收缩省略，不把标记挤出视口 */}
      <span className="tree-row__labels">
        <span
          className={`tree-row__name${row.gitCode ? ` tree-row__name--${gitCodeClass(row.gitCode)}` : ''}${
            row.gitDirty ? ' tree-row__name--dirty' : ''
          }`}
        >
          {highlightName(entry.name, nameFilter)}
        </span>
        {/* 紧凑链条作尾注：真实名字在前、被合并掉的层级在后且淡化。
            反过来（链条在前）会让"这一行到底是什么"要读完才知道。 */}
        {row.compactChain ? (
          <span className="tree-row__chain" title={row.compactChain}>
            {row.compactChain}
          </span>
        ) : null}
      </span>
      {/* git 角标：固定在行尾右侧，状态变化在固定位置竖向扫读即可对准 */}
      {row.gitCode ? (
        <span
          className={`tree-row__git tree-row__git--${gitCodeClass(row.gitCode)}`}
          title={row.gitTitle}
          aria-label={row.gitTitle}
        >
          {row.gitCode}
        </span>
      ) : row.gitDirty ? (
        <span className="tree-row__git tree-row__git--dirty" title="该目录下有改动" aria-hidden>
          ●
        </span>
      ) : null}
      {isLoading ? <span className="tree-row__loading" aria-label="加载中" /> : null}
    </div>
  )
}

/**
 * 文件类型图标已抽到 file-icons.ts（mdi 矢量图标 + seti 色板，
 * 照抄 wuzu-client 的 languageMap）—— TreeRow 的 FileGlyph 使用。
 */
