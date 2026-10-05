import { useState, useSyncExternalStore, type JSX } from 'react'
import {
  DEFAULT_SETTINGS_SECTION,
  getSectionRequest,
  subscribeSectionRequest
} from './app-settings-navigation'
import { EngineSettingsView } from './EngineSettingsView'
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
import type { IconName } from '@renderer/workbench/icons'
import { Icon } from '@renderer/workbench/icons'

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
  group: '基础' | '工作区' | '高级'
  description: string
  component: () => JSX.Element
}

const SECTIONS: Section[] = [
  {
    id: 'general',
    label: '引擎管理',
    icon: 'settings',
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
  }
]

const SECTION_GROUPS: { label: Section['group']; items: Section[] }[] = [
  { label: '基础', items: SECTIONS.filter((item) => item.group === '基础') },
  { label: '工作区', items: SECTIONS.filter((item) => item.group === '工作区') },
  { label: '高级', items: SECTIONS.filter((item) => item.group === '高级') }
]

export function AppSettingsView(): JSX.Element {
  const request = useSyncExternalStore(subscribeSectionRequest, getSectionRequest)
  const [active, setActive] = useState(request?.section ?? DEFAULT_SETTINGS_SECTION)
  const [consumedNonce, setConsumedNonce] = useState(request?.nonce ?? 0)
  // 渲染期消费新请求（React 官方「渲染时调整 state」模式）：覆盖「已挂载时再次跳转」的场景
  if (request && request.nonce !== consumedNonce) {
    setConsumedNonce(request.nonce)
    setActive(request.section)
  }
  const section = SECTIONS.find((item) => item.id === active) ?? SECTIONS[0]
  const SectionBody = section.component

  return (
    <div className="app-settings">
      <aside className="app-settings__nav" aria-label="设置分区">
        <div className="app-settings__nav-header">
          <div className="app-settings__nav-header-icon" aria-hidden="true">
            <Icon name="settings" size={18} />
          </div>
          <div>
            <strong>设置</strong>
            <span>应用与工作区</span>
          </div>
        </div>
        <div className="app-settings__nav-list" role="tablist" aria-label="设置分区">
          {SECTION_GROUPS.map((group) => (
            <div className="app-settings__nav-group" key={group.label} role="presentation">
              <div className="app-settings__nav-group-title">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={item.id === active}
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
      </aside>
      <main className="app-settings__body">
        <header className="app-settings__header" aria-label={`${section.label}设置`}>
          <div className="app-settings__header-eyebrow">设置 / {section.group}</div>
          <h1 className="app-settings__title">{section.label}</h1>
          <p className="app-settings__subtitle">{section.description}</p>
        </header>
        <SectionBody />
      </main>
    </div>
  )
}
