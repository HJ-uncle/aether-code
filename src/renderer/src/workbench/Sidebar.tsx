import { useSyncExternalStore, type JSX } from 'react'
import { useLayout } from './useLayout'
import { getViews, onViewsChanged } from './view-registry'

/**
 * 侧边栏容器
 *
 * 按当前激活视图 ID 找到已注册组件并渲染；视图本身不关心自己被放在哪。
 */
export function Sidebar(): JSX.Element | null {
  const layout = useLayout()
  const views = useSyncExternalStore(onViewsChanged, () => getViews('sidebar'))

  // 激活视图可能尚未注册或已被移除，回退到第一个可用视图
  const view = views.find((item) => item.id === layout.activeView) ?? views[0]
  if (!view) return null

  const Component = view.component

  return (
    <section className="sidebar" aria-label={view.title}>
      <header className="sidebar__header">{view.title}</header>
      <div className="sidebar__body">
        <Component />
      </div>
    </section>
  )
}
