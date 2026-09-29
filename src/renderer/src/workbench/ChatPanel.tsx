import { useSyncExternalStore, type JSX } from 'react'
import { setLayout } from '@renderer/core/platform/layout-state'
import { Icon } from './icons'
import { getView, getViews, onViewsChanged } from './view-registry'

/**
 * 右侧对话面板（对标 VS Code 的 AI 助手侧栏）
 *
 * 与 Sidebar 同构：内容来自视图注册表的 'right' 位置，布局组件不认识具体功能。
 * 常驻右侧可折叠 —— 对话是本 IDE 的高频入口，钉在固定位置比藏在标签页里
 * 少一次「找对话在哪」的心智负担。
 *
 * 订阅方式用 useSyncExternalStore：快照取视图 ID（原始值，引用稳定），
 * 再按 ID 取注册对象，避免 getViews 每次新建数组导致的无限重渲染。
 */
export function ChatPanel(): JSX.Element | null {
  const viewId = useSyncExternalStore(onViewsChanged, () => getViews('right')[0]?.id ?? null)
  const view = viewId ? getView(viewId) : undefined

  if (!view) return null

  const Component = view.component

  return (
    <section className="chat-panel" aria-label={view.title}>
      <header className="chat-panel__header">
        <span className="chat-panel__title">{view.title}</span>
        <button
          type="button"
          className="chat-panel__close"
          title="关闭对话面板"
          aria-label="关闭对话面板"
          onClick={() => setLayout({ chatPanelVisible: false })}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="chat-panel__body">
        <Component />
      </div>
    </section>
  )
}
