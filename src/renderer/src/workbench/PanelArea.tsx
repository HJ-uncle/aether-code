import { useSyncExternalStore, type JSX } from 'react'
import { setLayout } from '@renderer/core/platform/layout-state'
import { Icon } from './icons'
import { useLayout } from './useLayout'
import { getViews, onViewsChanged } from './view-registry'

/**
 * 底部面板容器
 *
 * 与侧边栏同构：按 ID 找注册的视图组件。
 * 标签栏由注册表驱动，因此新增面板视图不需要改这里。
 *
 * 所有注册视图始终挂载、用 CSS 显隐（keep-alive）：
 * 终端等有状态视图（xterm）在切换标签/收起面板时不能重建 DOM。
 */
export function PanelArea(): JSX.Element | null {
  const layout = useLayout()
  const views = useSyncExternalStore(onViewsChanged, () => getViews('panel'))

  if (views.length === 0) return null

  const view = views.find((item) => item.id === layout.activePanelView) ?? views[0]

  return (
    <section className="panel" aria-label={view.title}>
      <header className="panel__tabs">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`panel__tab${item.id === view.id ? ' is-active' : ''}`}
            onClick={() => setLayout({ activePanelView: item.id })}
          >
            {item.title}
          </button>
        ))}
        <div className="panel__tabs-spacer" />
        <button
          type="button"
          className="panel__action"
          title="收起面板"
          aria-label="收起面板"
          onClick={() => setLayout({ panelVisible: false })}
        >
          <Icon name="chevron-up" size={16} />
        </button>
        <button
          type="button"
          className="panel__action"
          title="关闭面板"
          aria-label="关闭面板"
          onClick={() => setLayout({ panelVisible: false })}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="panel__body">
        {views.map((item) => {
          const Component = item.component
          const active = item.id === view.id
          return (
            <div
              key={item.id}
              className="panel__view"
              style={{ display: active ? 'block' : 'none' }}
            >
              <Component />
            </div>
          )
        })}
      </div>
    </section>
  )
}
