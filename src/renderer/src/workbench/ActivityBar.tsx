import { useSyncExternalStore, type JSX } from 'react'
import { toggleSidebarView } from '@renderer/core/platform/layout-state'
import { IconButton } from './ui-primitives'
import type { IconName } from './icons'
import { useLayout } from './useLayout'
import { getViews, onViewsChanged } from './view-registry'

/**
 * 左侧活动栏
 *
 * 只渲染已注册的侧边栏视图并转发切换动作，不感知任何具体功能。
 * 新视图在 contrib 里注册即可出现在这里。
 */
export function ActivityBar(): JSX.Element {
  const layout = useLayout()
  const views = useSyncExternalStore(onViewsChanged, () => getViews('sidebar'))

  return (
    <nav className="activity-bar" aria-label="活动栏">
      {views.map((view) => {
        const active = layout.sidebarVisible && layout.activeView === view.id
        return (
          <IconButton
            key={view.id}
            className={`activity-bar__item${active ? ' is-active' : ''}`}
            title={view.title}
            aria-pressed={active}
            icon={view.icon as IconName}
            label={view.title}
            size={24}
            onClick={() => toggleSidebarView(view.id)}
          />
        )
      })}
    </nav>
  )
}
