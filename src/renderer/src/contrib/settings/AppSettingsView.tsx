import { useMemo, useState, useSyncExternalStore, type JSX } from 'react'
import {
  DEFAULT_SETTINGS_SECTION,
  getSectionRequest,
  subscribeSectionRequest
} from './app-settings-navigation'
import { EngineSettingsView } from './EngineSettingsView'
import { AccountSettingsView } from '../account/AccountSettingsView'
import { AppearanceSettingsView } from './AppearanceSettingsView'
import { CodeGraphSettingsView } from './CodeGraphSettingsView'
import { FilesExcludeSettingsView } from './FilesExcludeSettingsView'
import { SearchExcludeSettingsView } from './SearchExcludeSettingsView'
import { ModelsSettingsView } from '../models/ModelsSettingsView'
import { SecurityView } from '../security/SecurityView'
import { KeybindingsSettingsView } from './KeybindingsSettingsView'
import { SkillsSettingsView } from './SkillsSettingsView'
import { KnowledgeSettingsView } from './KnowledgeSettingsView'
import { McpSettingsView } from './McpSettingsView'
import { MemorySettingsView } from './MemorySettingsView'
import { EditorSettingsView } from './EditorSettingsView'
import { TerminalSettingsView } from './TerminalSettingsView'
import { GitSettingsView } from './GitSettingsView'
import { WorkbenchSettingsView } from './WorkbenchSettingsView'
import { BrowserSettingsView } from '../browser/BrowserSettingsView'
import { useBrowserState } from '../browser/browser-store'
import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser'
import { getEditorDisplayOptions, onEditorDisplayOptionsChanged } from '@renderer/core/editor/editor-display-options'
import { DEFAULT_EDITOR_DISPLAY_OPTIONS } from '@renderer/core/editor/editor-display-options'
import { DEFAULT_TERMINAL_PREFERENCES, getTerminalPreferences, onTerminalPreferencesChanged } from '@renderer/contrib/terminal/terminal-preferences'
import { DEFAULT_GIT_AUTO_FETCH, DEFAULT_GIT_AUTO_FETCH_INTERVAL_MS, getGitPreferences, onGitPreferencesChanged } from '@renderer/core/git/git-pref'
import { DEFAULT_LAYOUT, getLayout, onLayoutChanged } from '@renderer/core/platform/layout-state'
import { getUserKeybindingRules, onUserKeybindingsChanged } from '@renderer/core/platform/user-keybindings'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { getSettingsDefinitions, onSettingsRegistryChanged, searchSettings, type SettingDefinition } from './settings-registry'
import type { IconName } from '@renderer/workbench/icons'
import { Icon } from '@renderer/workbench/icons'
import { SettingsScopeContext } from './settings-scope'

/**
 * 统一设置（主区固定标签，可关闭）
 *
 * 聚合各配置域的入口，避免功能散落在多个视图里：
 *   - 引擎管理：引擎运行方式 / 端口 / 启停（复用侧栏的引擎设置组件）
 *   - 外观：明暗模式与强调色
 *   - 文件：文件排除规则（files.exclude）
 *   - 搜索：搜索排除规则（search.exclude）
 *   - 模型：API Key 与模型管理
 *   - 安全：安全策略模式
 *   - 代码图：索引状态与重建
 * 各域组件保持独立注册的视图不变，这里只做壳 —— 后续新增配置域时
 * 在 SECTIONS 里加一行即可。
 */

interface Section {
  id: string
  label: string
  icon: IconName
  group: '基础' | '文本编辑器' | '工作区' | '功能' | '高级'
  description: string
  component: () => JSX.Element
}

const SECTIONS: Section[] = [
  {
    id: 'account',
    label: '个人账号',
    icon: 'account-outline',
    group: '基础',
    description: '管理个人资料、登录方式和账号安全。',
    component: AccountSettingsView
  },
  {
    id: 'general',
    label: '引擎管理',
    icon: 'engine',
    group: '基础',
    description: '管理引擎连接、启动方式和运行状态。',
    component: EngineSettingsView
  },
  {
    id: 'appearance',
    label: '外观',
    icon: 'palette',
    group: '基础',
    description: '调整主题、强调色和界面的整体表现。',
    component: AppearanceSettingsView
  },
  {
    id: 'editor',
    label: '文本编辑器',
    icon: 'file-edit-outline',
    group: '文本编辑器',
    description: '调整字体、缩进、换行、小地图和编辑器显示。',
    component: EditorSettingsView
  },
  {
    id: 'terminal',
    label: '终端',
    icon: 'terminal',
    group: '文本编辑器',
    description: '调整集成终端的字体、光标和滚动体验。',
    component: TerminalSettingsView
  },
  {
    id: 'models',
    label: '模型',
    icon: 'model',
    group: '工作区',
    description: '配置模型、服务地址以及默认模型。',
    component: ModelsSettingsView
  },
  {
    id: 'files',
    label: '文件',
    icon: 'file',
    group: '工作区',
    description: '设置资源管理器中的文件排除规则。',
    component: FilesExcludeSettingsView
  },
  {
    id: 'search',
    label: '搜索',
    icon: 'search',
    group: '工作区',
    description: '设置全局搜索时需要忽略的路径和文件。',
    component: SearchExcludeSettingsView
  },
  {
    id: 'keybindings',
    label: '键盘',
    icon: 'keyboard',
    group: '工作区',
    description: '查看和调整常用操作的键盘快捷键。',
    component: KeybindingsSettingsView
  },
  {
    id: 'git',
    label: '源代码管理',
    icon: 'git',
    group: '功能',
    description: '配置 Git 自动同步和远端更新检查。',
    component: GitSettingsView
  },
  {
    id: 'workbench',
    label: '工作台',
    icon: 'layout-sidebar',
    group: '功能',
    description: '调整侧边栏、面板和对话区的布局偏好。',
    component: WorkbenchSettingsView
  },
  {
    id: 'browser', label: '浏览器', icon: 'eye-outline', group: '功能',
    description: '在编辑区运行网页，调整浏览器会话、视口与 AI 操作偏好。',
    component: BrowserSettingsView
  },
  {
    id: 'security',
    label: '安全',
    icon: 'shield',
    group: '高级',
    description: '控制当前会话的工具权限与安全模式。',
    component: SecurityView
  },
  {
    id: 'codegraph',
    label: '代码图',
    icon: 'graph',
    group: '高级',
    description: '管理代码索引并查看代码图状态。',
    component: CodeGraphSettingsView
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: 'cloud-upload-outline',
    group: '高级',
    description: '配置可连接的 MCP 服务及其作用域。',
    component: McpSettingsView
  },
  {
    id: 'skills',
    label: '技能',
    icon: 'package-variant-closed',
    group: '高级',
    description: '导入、创建和管理可复用的技能。',
    component: SkillsSettingsView
  },
  {
    id: 'knowledge',
    label: '知识库',
    icon: 'folder-outline',
    group: '高级',
    description: '管理文档、知识库和检索内容。',
    component: KnowledgeSettingsView
  },
  {
    id: 'memory',
    label: '记忆',
    icon: 'brain',
    group: '高级',
    description: '管理全局记忆和指定会话的记忆条目。',
    component: MemorySettingsView
  }
]

const SECTION_GROUPS: { label: Section['group']; items: Section[] }[] = [
  { label: '基础', items: SECTIONS.filter((item) => item.group === '基础') },
  { label: '文本编辑器', items: SECTIONS.filter((item) => item.group === '文本编辑器') },
  { label: '工作区', items: SECTIONS.filter((item) => item.group === '工作区') },
  { label: '功能', items: SECTIONS.filter((item) => item.group === '功能') },
  { label: '高级', items: SECTIONS.filter((item) => item.group === '高级') }
]

export function AppSettingsView(): JSX.Element {
  const { settings } = useApp()
  const request = useSyncExternalStore(subscribeSectionRequest, getSectionRequest)
  const editorOptions = useSyncExternalStore(onEditorDisplayOptionsChanged, getEditorDisplayOptions)
  const terminalPreferences = useSyncExternalStore(onTerminalPreferencesChanged, getTerminalPreferences)
  const gitPreferences = useSyncExternalStore(onGitPreferencesChanged, getGitPreferences)
  const layout = useSyncExternalStore(onLayoutChanged, getLayout)
  const userKeybindings = useSyncExternalStore(onUserKeybindingsChanged, getUserKeybindingRules)
  const settingDefinitions = useSyncExternalStore(onSettingsRegistryChanged, getSettingsDefinitions)
  const { settings: browserSettings } = useBrowserState()
  const [active, setActive] = useState(request?.section ?? DEFAULT_SETTINGS_SECTION)
  const [consumedNonce, setConsumedNonce] = useState(request?.nonce ?? 0)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'user' | 'workspace'>('user')
  const [modifiedOnly, setModifiedOnly] = useState(false)
  // 渲染期消费新请求（React 官方「渲染时调整 state」模式）：覆盖「已挂载时再次跳转」的场景
  if (request && request.nonce !== consumedNonce) {
    setConsumedNonce(request.nonce)
    setActive(request.section)
  }
  const modifiedKeys = useMemo(() => {
    const keys = getModifiedKeys(settings, editorOptions, terminalPreferences, gitPreferences, layout, userKeybindings)
    for (const key of ['homeUrl', 'zoomFactor', 'defaultViewport', 'persistSession', 'aiEnabled'] as const) {
      if (JSON.stringify(browserSettings[key]) !== JSON.stringify(DEFAULT_BROWSER_SETTINGS[key])) keys.add(`browser.${key}`)
    }
    return keys
  }, [browserSettings, editorOptions, gitPreferences, layout, settings, terminalPreferences, userKeybindings])
  const results = useMemo(() => {
    const candidates = query.trim()
      ? searchSettings(query, scope, modifiedKeys)
      : settingDefinitions.filter((item) => item.scope === 'both' || item.scope === scope)
    return modifiedOnly ? candidates.filter((item) => modifiedKeys.has(item.key)) : candidates
  }, [modifiedKeys, modifiedOnly, query, scope, settingDefinitions])
  const visibleSections = useMemo(() => {
    if (!query.trim() && !modifiedOnly) return SECTIONS
    const ids = new Set(results.map((result) => result.section))
    return SECTIONS.filter((item) => ids.has(item.id))
  }, [modifiedOnly, query, results])
  const visibleGroups = useMemo(
    () => SECTION_GROUPS
      .map((group) => ({ ...group, items: group.items.filter((item) => visibleSections.includes(item)) }))
      .filter((group) => group.items.length > 0),
    [visibleSections]
  )
  const section = SECTIONS.find((item) => item.id === active) ?? SECTIONS[0]
  const visibleSection = visibleSections.find((item) => item.id === section.id) ?? visibleSections[0] ?? section
  const SectionBody = visibleSection.component
  const selectedSectionId = visibleSection.id
  const resultLabel = (result: SettingDefinition): string =>
    SECTIONS.find((item) => item.id === result.section)?.label ?? result.section

  return (
    <div className="app-settings">
      <div className="app-settings__toolbar" role="search">
        <div className="app-settings__search-wrap">
          <Icon name="magnify" size={16} />
          <input
            className="app-settings__search"
            aria-label="搜索设置"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设置（例如：字体、换行、MCP）"
          />
          {query ? (
            <button type="button" className="app-settings__search-clear" aria-label="清除设置搜索" onClick={() => setQuery('')}>
              <Icon name="close" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className={`app-settings__filter${modifiedOnly ? ' is-active' : ''}`}
            aria-pressed={modifiedOnly}
            title="仅显示已修改设置"
            onClick={() => setModifiedOnly((value) => !value)}
          >
            <Icon name="filter-remove" size={15} />
          </button>
        </div>
        <div className="app-settings__scope" role="tablist" aria-label="设置范围">
          <button type="button" role="tab" aria-selected={scope === 'user'} className={scope === 'user' ? 'is-active' : ''} onClick={() => setScope('user')}>
            用户
          </button>
          <button type="button" role="tab" aria-selected={scope === 'workspace'} className={scope === 'workspace' ? 'is-active' : ''} onClick={() => setScope('workspace')}>
            工作区
          </button>
        </div>
        {query.trim() ? (
          <div className="app-settings__search-results" role="listbox" aria-label="设置搜索结果">
            {results.length > 0 ? results.map((result) => (
              <button
                type="button"
                role="option"
                aria-selected={result.section === selectedSectionId}
                className="app-settings__search-result"
                key={result.key}
                onClick={() => {
                  setActive(result.section)
                  setQuery('')
                }}
              >
                <span className="app-settings__search-result-copy">
                  <strong>{result.label}</strong>
                  <small>{result.description}</small>
                </span>
                <span className="app-settings__search-result-meta">{resultLabel(result)}</span>
              </button>
            )) : <div className="app-settings__search-empty">未找到匹配的设置</div>}
          </div>
        ) : null}
      </div>
      <aside className="app-settings__nav" aria-label="设置分区">
        <div className="app-settings__nav-list" role="tablist" aria-label="设置分区">
          {visibleGroups.map((group) => (
            <div className="app-settings__nav-group" key={group.label} role="presentation">
              <div className="app-settings__nav-group-title">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={item.id === selectedSectionId}
                  aria-label={item.label}
                  title={item.label}
                  className={`app-settings__nav-item${item.id === active ? ' is-active' : ''}`}
                  onClick={() => setActive(item.id)}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        {query.trim() && visibleSections.length === 0 ? <p className="app-settings__nav-empty">没有匹配的分区</p> : null}
      </aside>
      <main className="app-settings__body">
        <header className="app-settings__header" aria-label={`${visibleSection.label}设置`}>
          <div className="app-settings__header-eyebrow">设置 / {visibleSection.group}</div>
          <h1 className="app-settings__title">{visibleSection.label}</h1>
          <p className="app-settings__subtitle">{visibleSection.description}</p>
        </header>
        <SettingsScopeContext.Provider value={scope}>
          <SectionBody />
        </SettingsScopeContext.Provider>
      </main>
    </div>
  )
}

function getModifiedKeys(
  settings: AppSettings,
  editorOptions: ReturnType<typeof getEditorDisplayOptions>,
  terminalPreferences: ReturnType<typeof getTerminalPreferences>,
  gitPreferences: ReturnType<typeof getGitPreferences>,
  layout: ReturnType<typeof getLayout>,
  userKeybindings: ReturnType<typeof getUserKeybindingRules>
): Set<string> {
  const modified = new Set<string>()
  if (editorOptions.fontFamily !== DEFAULT_EDITOR_DISPLAY_OPTIONS.fontFamily) modified.add('editor.fontFamily')
  if (editorOptions.fontSize !== DEFAULT_EDITOR_DISPLAY_OPTIONS.fontSize) modified.add('editor.fontSize')
  if (editorOptions.lineHeight !== DEFAULT_EDITOR_DISPLAY_OPTIONS.lineHeight) modified.add('editor.lineHeight')
  if (editorOptions.fontLigatures !== DEFAULT_EDITOR_DISPLAY_OPTIONS.fontLigatures) modified.add('editor.fontLigatures')
  if (editorOptions.tabSize !== DEFAULT_EDITOR_DISPLAY_OPTIONS.tabSize) modified.add('editor.tabSize')
  if (editorOptions.wordWrap !== DEFAULT_EDITOR_DISPLAY_OPTIONS.wordWrap) modified.add('editor.wordWrap')
  if (editorOptions.minimapEnabled !== DEFAULT_EDITOR_DISPLAY_OPTIONS.minimapEnabled) modified.add('editor.minimap.enabled')
  if (terminalPreferences.fontFamily !== DEFAULT_TERMINAL_PREFERENCES.fontFamily) modified.add('terminal.integrated.fontFamily')
  if (terminalPreferences.fontSize !== DEFAULT_TERMINAL_PREFERENCES.fontSize) modified.add('terminal.integrated.fontSize')
  if (terminalPreferences.lineHeight !== DEFAULT_TERMINAL_PREFERENCES.lineHeight) modified.add('terminal.integrated.lineHeight')
  if (terminalPreferences.cursorBlink !== DEFAULT_TERMINAL_PREFERENCES.cursorBlink) modified.add('terminal.integrated.cursorBlinking')
  if (terminalPreferences.scrollback !== DEFAULT_TERMINAL_PREFERENCES.scrollback) modified.add('terminal.integrated.scrollback')
  if (gitPreferences.autoFetch !== DEFAULT_GIT_AUTO_FETCH) modified.add('git.autofetch')
  if (gitPreferences.autoFetchIntervalMs !== DEFAULT_GIT_AUTO_FETCH_INTERVAL_MS) modified.add('git.autofetchInterval')
  if (layout.sidebarVisible !== DEFAULT_LAYOUT.sidebarVisible) modified.add('workbench.sidebar.visible')
  if (layout.panelVisible !== DEFAULT_LAYOUT.panelVisible) modified.add('workbench.panel.visible')
  if (layout.chatPanelVisible !== DEFAULT_LAYOUT.chatPanelVisible) modified.add('workbench.chatPanel.visible')
  if (layout.chatOnLeft !== DEFAULT_LAYOUT.chatOnLeft) modified.add('workbench.chatPanel.position')
  if (userKeybindings.length > 0) modified.add('aether.keybindings')
  if (JSON.stringify(settings.filesExclude) !== JSON.stringify(DEFAULT_SETTINGS.filesExclude)) modified.add('files.exclude')
  if (JSON.stringify(settings.searchExclude) !== JSON.stringify(DEFAULT_SETTINGS.searchExclude)) modified.add('search.exclude')
  if (settings.engineMode !== DEFAULT_SETTINGS.engineMode) modified.add('aether.engine.mode')
  if (settings.autoStartEngine !== DEFAULT_SETTINGS.autoStartEngine) modified.add('aether.engine.autoStart')
  if (settings.appearance !== DEFAULT_SETTINGS.appearance) modified.add('aether.appearance.theme')
  if (settings.accent !== DEFAULT_SETTINGS.accent || settings.customAccentColor !== DEFAULT_SETTINGS.customAccentColor) modified.add('aether.appearance.accent')
  if (settings.lastModelId !== DEFAULT_SETTINGS.lastModelId) modified.add('aether.models.default')
  return modified
}
