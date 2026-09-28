import type { JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { setLayout, LAYOUT_LIMITS } from '@renderer/core/platform/layout-state'
import { useTheme } from '@renderer/core/useTheme'
import { ActivityBar } from './ActivityBar'
import { ChatPanel } from './ChatPanel'
import { CommandPalette } from './CommandPalette'
import { EditorArea } from './EditorArea'
import { QuickOpen } from './QuickOpen'
import { MenuBar } from './MenuBar'
import { PanelArea } from './PanelArea'
import { Resizer } from './Resizer'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { useLayout } from './useLayout'

/**
 * 工作台骨架（对标 VS Code 布局）
 *
 * 布局结构：
 *   ┌─────────────────────────────────────────────────┐
 *   │ MenuBar                                          │
 *   ├─────────────────────────────────────────────────┤
 *   │ ActivityBar │ Sidebar │ 主区      │ ChatPanel    │
 *   │             │         ├──────────┤              │
 *   │             │         │ Panel    │              │
 *   ├─────────────────────────────────────────────────┤
 *   │ StatusBar                                        │
 *   └─────────────────────────────────────────────────┘
 *
 * 只负责摆放区域与分隔条，区域内部实现全部由各自组件/注册表决定。
 */
export function Workbench(): JSX.Element {
  const layout = useLayout()
  const { settings } = useApp()

  // 把外观设置同步到 <html>，具体配色由 tokens.css 决定
  useTheme(settings.appearance, settings.accent)

  return (
    <div className="workbench">
      <MenuBar />

      <div className="workbench__body">
        <ActivityBar />

        {layout.sidebarVisible ? (
          <>
            <div className="workbench__sidebar" style={{ width: layout.sidebarWidth }}>
              <Sidebar />
            </div>
            <Resizer
              orientation="vertical"
              ariaLabel="调整侧边栏宽度"
              onDelta={(delta) => setLayout({ sidebarWidth: layout.sidebarWidth + delta })}
            />
          </>
        ) : null}

        {/* 对话面板换位：夹在侧边栏与主区之间（与 wuzu-client 的「交换对话区与源码区」一致） */}
        {layout.chatPanelVisible && layout.chatOnLeft ? (
          <>
            <div
              className="workbench__chat workbench__chat--left"
              style={{ width: layout.chatPanelWidth }}
            >
              <ChatPanel />
            </div>
            <Resizer
              orientation="vertical"
              ariaLabel="调整对话面板宽度"
              // 面板在左侧：向右拖（delta>0）变宽，与右侧的「向左拖变宽」相反
              onDelta={(delta) => setLayout({ chatPanelWidth: layout.chatPanelWidth + delta })}
            />
          </>
        ) : null}

        <div className="workbench__main">
          <EditorArea />

          {layout.panelVisible ? (
            <Resizer
              orientation="horizontal"
              ariaLabel="调整面板高度"
              onDelta={(delta) => setLayout({ panelHeight: layout.panelHeight - delta })}
            />
          ) : null}
          {/* 收起时仅隐藏不卸载（keep-alive）：面板内是终端这类有状态视图，
              重建 DOM 会丢掉 xterm 的画面与会话绑定 */}
          <div
            className="workbench__panel"
            style={{
              height: layout.panelVisible ? layout.panelHeight : 0,
              display: layout.panelVisible ? undefined : 'none'
            }}
          >
            <PanelArea />
          </div>
        </div>

        {layout.chatPanelVisible && !layout.chatOnLeft ? (
          <>
            <Resizer
              orientation="vertical"
              ariaLabel="调整对话面板宽度"
              onDelta={(delta) => setLayout({ chatPanelWidth: layout.chatPanelWidth - delta })}
            />
            <div className="workbench__chat" style={{ width: layout.chatPanelWidth }}>
              <ChatPanel />
            </div>
          </>
        ) : null}
      </div>

      <StatusBar />

      <CommandPalette />
      <QuickOpen />
    </div>
  )
}

/** 供布局边界检查使用的最小/最大值，避免魔法数字散落各处 */
export { LAYOUT_LIMITS }
