import { type IconName } from '@renderer/ui/icons'

export type ExtensionDestination = `plugin:${string}`
export type Page = 'home' | 'projects' | 'browser' | 'automations' | 'agents' | 'plugins' | 'monitor' | ExtensionDestination

export type WorkspaceTab = 'files' | 'workspace' | 'sources' | 'browser' | 'subagents' | 'git' | 'terminal' | ExtensionDestination

export function isExtensionDestination(value: string): value is ExtensionDestination { return value.startsWith('plugin:') }

/** Host-owned icons keep arbitrary plugin metadata out of the SVG renderer. */
export function extensionIcon(value: string): IconName {
  const icons: Record<string, IconName> = { puzzle: 'puzzle', clock: 'clock-outline', 'clock-outline': 'clock-outline', activity: 'activity', terminal: 'terminal', folder: 'folder-outline', file: 'file', bell: 'info', settings: 'settings', globe: 'globe', users: 'users' }
  return icons[value] ?? 'puzzle'
}

export type WorkspaceEntry = { kind: 'surface'; id: WorkspaceTab } | { kind: 'resource'; id: string }

export type ViewState = {
  page: Page
  collapsed: boolean
  workspace: boolean
  tab: WorkspaceTab
  pane: 'conversation' | 'workspace'
  ratio: number
}

export const VIEW_KEY = 'aether.work.view.v1'

export const NAVIGATION: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'home', label: '工作台', icon: 'dashboard' },
  { id: 'projects', label: '项目', icon: 'folder-outline' },
  { id: 'agents', label: 'Agent', icon: 'account-outline' },
  { id: 'plugins', label: '插件', icon: 'puzzle' },
  { id: 'browser', label: '浏览器', icon: 'globe' },
  { id: 'automations', label: '自动化', icon: 'clock-outline' },
  { id: 'monitor', label: '引擎监控', icon: 'activity' }
]

export function initialView(): ViewState {
  const fallback: ViewState = {
    page: 'home',
    collapsed: false,
    // Start with the conversation; files open when explicitly requested.
    workspace: false,
    tab: 'files',
    pane: 'conversation',
    // Keep the conversation as the primary surface.  The workspace is a
    // supporting inspector, so it should open at a useful but compact width.
    ratio: 56
  }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
    if (!value || typeof value !== 'object') return fallback
    const record = value as Record<string, unknown>
    const storedRatio = typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? record.ratio : null
    // 44% was the old default and made the workspace consume most of the
    // desktop on first launch.  Migrate only that untouched default; a user
    // who dragged the divider keeps their chosen ratio.
    const ratio = storedRatio === 44 ? 56 : storedRatio
    const workspace = record.workspace === true
    return {
      page: NAVIGATION.some((item) => item.id === record.page) ? (record.page as Page) : 'home',
      collapsed: record.collapsed === true,
      workspace,
      tab: (() => {
        const stored = String(record.tab)
        // Saved destinations must follow their replacement after navigation merges.
        if (stored === 'artifacts' || stored === 'activity' || stored === 'changes') return 'files'
        return ['files', 'workspace', 'sources', 'browser', 'subagents', 'git', 'terminal'].includes(stored)
          ? (stored as WorkspaceTab)
          : 'files'
      })(),
      pane: workspace && record.pane === 'workspace' ? 'workspace' : 'conversation',
      ratio: ratio === null ? 56 : Math.min(62, Math.max(35, ratio))
    }
  } catch {
    return fallback
  }
}
