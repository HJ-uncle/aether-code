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

/**
 * 统一设置（主区固定标签，可关闭）
 *
 * 聚合各配置域的入口，避免功能散落在多个视图里：
 *   - 通用：引擎运行方式 / 端口 / 启停（复用侧栏的引擎设置组件）
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
  component: () => JSX.Element
}

const SECTIONS: Section[] = [
  { id: 'general', label: '通用', component: EngineSettingsView },
  { id: 'appearance', label: '外观', component: AppearanceSettingsView },
  { id: 'files', label: '文件', component: FilesExcludeSettingsView },
  { id: 'search', label: '搜索', component: SearchExcludeSettingsView },
  { id: 'models', label: '模型', component: ModelsSettingsView },
  { id: 'security', label: '安全', component: SecurityView },
  { id: 'codegraph', label: '代码图', component: CodeGraphSettingsView }
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
      <aside className="app-settings__nav" role="tablist" aria-label="设置分区">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active}
            className={`app-settings__nav-item${item.id === active ? ' is-active' : ''}`}
            onClick={() => setActive(item.id)}
          >
            {item.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__body">
        <SectionBody />
      </div>
    </div>
  )
}
