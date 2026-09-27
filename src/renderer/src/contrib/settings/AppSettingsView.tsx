import { useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { showEditorView } from '@renderer/core/platform/layout-state'
import { EngineSettingsView } from './EngineSettingsView'
import { AppearanceSettingsView } from './AppearanceSettingsView'
import { CodeGraphSettingsView } from './CodeGraphSettingsView'
import { ModelsSettingsView } from '../models/ModelsSettingsView'
import { SecurityView } from '../security/SecurityView'

/**
 * 统一设置（主区固定标签，可关闭）
 *
 * 聚合各配置域的入口，避免功能散落在多个视图里：
 *   - 通用：引擎运行方式 / 端口 / 启停（复用侧栏的引擎设置组件）
 *   - 外观：明暗模式与强调色
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
  { id: 'models', label: '模型', component: ModelsSettingsView },
  { id: 'security', label: '安全', component: SecurityView },
  { id: 'codegraph', label: '代码图', component: CodeGraphSettingsView }
]

// ── 打开设置时定位到指定分区 ────────────────────────────────────────────────
// 原先「模型」「安全」是主区独立标签，现已并入本视图；命令/快捷键/对话页的
// 跳转统一走 openAppSettings(section)，既处理未打开时的初始定位，也处理
// 已打开时再次触发（如 Ctrl+Shift+M 切到模型分区）的分区切换。

interface SectionRequest {
  section: string
  nonce: number
}

let sectionRequest: SectionRequest | null = null
let nonceCounter = 0
const sectionListeners = new Set<() => void>()

/** 打开设置主区视图；传分区 id 时定位到该分区（默认通用） */
export function openAppSettings(section?: string): void {
  sectionRequest = { section: section ?? SECTIONS[0].id, nonce: ++nonceCounter }
  showEditorView('app-settings')
  for (const listener of sectionListeners) listener()
}

function subscribeSectionRequest(listener: () => void): () => void {
  sectionListeners.add(listener)
  return () => sectionListeners.delete(listener)
}

export function AppSettingsView(): JSX.Element {
  const request = useSyncExternalStore(subscribeSectionRequest, () => sectionRequest)
  const [active, setActive] = useState(request?.section ?? SECTIONS[0].id)
  const consumedRef = useRef(request?.nonce ?? 0)
  // 渲染期消费新请求（React 官方模式）：覆盖「已挂载时再次跳转」的场景
  if (request && request.nonce !== consumedRef.current) {
    consumedRef.current = request.nonce
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
