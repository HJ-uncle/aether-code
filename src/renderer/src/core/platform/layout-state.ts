/**
 * 布局状态
 *
 * 侧边栏宽度、面板高度、当前视图等 UI 布局状态集中在这里，
 * 并持久化到 localStorage —— 用户调整后下次启动保持一致。
 *
 * 之所以独立成模块而不是放进组件 state：布局是跨区域的（拖动侧边栏要同时
 * 影响编辑区宽度），放在组件里会形成难以维护的回调链。
 */

export interface LayoutState {
  sidebarWidth: number
  panelHeight: number
  sidebarVisible: boolean
  panelVisible: boolean
  /** 当前侧边栏视图 ID（取值由视图注册表决定，此处不写死） */
  activeView: string
  /** 当前面板视图 ID */
  activePanelView: string
  /** 当前主区视图 ID */
  activeEditorView: string
  /** 已被用户关闭的主区固定视图（可关闭的视图关闭后记录在此，可重新打开） */
  closedEditorViews: string[]
  /** 右侧对话面板（对标 VS Code 的 Copilot 侧栏） */
  chatPanelVisible: boolean
  chatPanelWidth: number
}

const STORAGE_KEY = 'aether.ide.layout'

const DEFAULTS: LayoutState = {
  sidebarWidth: 320,
  panelHeight: 220,
  sidebarVisible: true,
  panelVisible: false,
  activeView: 'explorer',
  activePanelView: 'output',
  activeEditorView: 'app-settings',
  closedEditorViews: [],
  chatPanelVisible: true,
  chatPanelWidth: 420
}

export const LAYOUT_LIMITS = {
  sidebarMin: 200,
  sidebarMax: 640,
  panelMin: 100,
  panelMax: 640,
  chatPanelMin: 280,
  chatPanelMax: 800
}

let state: LayoutState = load()
const listeners = new Set<() => void>()

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LayoutState>) }
  } catch {
    return { ...DEFAULTS }
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时忽略：布局丢失不影响功能
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getLayout(): LayoutState {
  return state
}

export function setLayout(patch: Partial<LayoutState>): void {
  const next: LayoutState = { ...state, ...patch }

  next.sidebarWidth = clamp(next.sidebarWidth, LAYOUT_LIMITS.sidebarMin, LAYOUT_LIMITS.sidebarMax)
  next.panelHeight = clamp(next.panelHeight, LAYOUT_LIMITS.panelMin, LAYOUT_LIMITS.panelMax)
  next.chatPanelWidth = clamp(
    next.chatPanelWidth,
    LAYOUT_LIMITS.chatPanelMin,
    LAYOUT_LIMITS.chatPanelMax
  )

  let changed = false
  for (const key of Object.keys(next) as (keyof LayoutState)[]) {
    if (state[key] !== next[key]) {
      changed = true
      break
    }
  }
  if (!changed) return

  state = next
  persist()
  for (const listener of listeners) listener()
}

export function onLayoutChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 切换侧边栏视图；重复点击同一图标时收起侧边栏（与 VS Code 行为一致） */
export function toggleSidebarView(view: string): void {
  if (state.activeView === view && state.sidebarVisible) {
    setLayout({ sidebarVisible: false })
  } else {
    setLayout({ activeView: view, sidebarVisible: true })
  }
}

export function togglePanel(view?: string): void {
  if (view && state.activePanelView === view && state.panelVisible) {
    setLayout({ panelVisible: false })
  } else {
    setLayout({ panelVisible: true, ...(view ? { activePanelView: view } : {}) })
  }
}

/** 切换到某个主区视图（不改变可见性，主区始终可见）；被关闭过的固定视图会随之恢复 */
export function showEditorView(view: string): void {
  setLayout({
    activeEditorView: view,
    ...(state.closedEditorViews.includes(view)
      ? { closedEditorViews: state.closedEditorViews.filter((id) => id !== view) }
      : {})
  })
}

/** 关闭主区的可关闭固定视图：从标签栏移除，激活项回落到第一个仍可见的视图 */
export function closeEditorView(view: string): void {
  if (!state.closedEditorViews.includes(view)) {
    setLayout({ closedEditorViews: [...state.closedEditorViews, view] })
  }
  if (state.activeEditorView === view || state.closedEditorViews.includes(state.activeEditorView)) {
    setLayout({ activeEditorView: '' })
  }
}

/** 切换右侧对话面板的可见性 */
export function toggleChatPanel(): void {
  setLayout({ chatPanelVisible: !state.chatPanelVisible })
}

/** 确保右侧对话面板可见（幂等，用于会话历史等「点条目即回到对话」的入口） */
export function showChatPanel(): void {
  if (!state.chatPanelVisible) setLayout({ chatPanelVisible: true })
}

/** 强制显示某个面板视图（用于状态栏等「必须可见」的入口） */
export function showPanel(view: string): void {
  setLayout({ panelVisible: true, activePanelView: view })
}
