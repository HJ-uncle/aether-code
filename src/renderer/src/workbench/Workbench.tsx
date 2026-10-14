import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { getAppMode, useAppMode } from '@renderer/core/platform/app-mode'
import { WorkView } from '@renderer/contrib/work/WorkView'
import { AppSettingsView } from '@renderer/contrib/settings/AppSettingsView'
import { subscribeSectionRequest } from '@renderer/contrib/settings/app-settings-navigation'
import { ModeSurface } from './ModeSurface'
import { Dialog } from './Dialog'
import './app-mode.css'
import { watchOpenDocuments } from '@renderer/core/editor/document-sync'
import { startEditorRecovery } from '@renderer/core/editor/editor-recovery'
import { useApp } from '@renderer/core/app-context'
import { setLayout, LAYOUT_LIMITS } from '@renderer/core/platform/layout-state'
import { useTheme } from '@renderer/core/useTheme'
import { useVisualEffects } from '@renderer/core/useVisualEffects'
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
import { codePaneBudget } from './code-pane-budget'

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
  useEffect(watchOpenDocuments, [])
  useEffect(startEditorRecovery, [])
  const layout = useLayout()
  const { settings } = useApp()
  const mode = useAppMode()
  const bodyRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [workSettingsOpen, setWorkSettingsOpen] = useState(false)
  const [codeGeometry, setCodeGeometry] = useState({ width: Infinity, chromeWidth: 0, sidebarRendered: layout.sidebarVisible })
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || mode !== 'code') return
    const measure = (): void => {
      const width = body.getBoundingClientRect().width
      if (!width) return
      const chromeWidth = [...body.querySelectorAll<HTMLElement>(':scope > .activity-bar, :scope > .resizer--vertical')]
        .reduce((total, element) => total + element.getBoundingClientRect().width, 0)
      const sidebarRendered = Boolean(layout.sidebarVisible && sidebarRef.current && getComputedStyle(sidebarRef.current).display !== 'none')
      setCodeGeometry(previous => previous.width === width && previous.chromeWidth === chromeWidth && previous.sidebarRendered === sidebarRendered
        ? previous : { width, chromeWidth, sidebarRendered })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [mode, layout])
  const codePanes = codePaneBudget({ ...codeGeometry, sidebarVisible: codeGeometry.sidebarRendered,
    sidebarWidth: layout.sidebarWidth, chatPanelVisible: layout.chatPanelVisible, chatPanelWidth: layout.chatPanelWidth }, LAYOUT_LIMITS)
  useEffect(
    () =>
      subscribeSectionRequest(() => {
        if (getAppMode() === 'work') setWorkSettingsOpen(true)
      }),
    []
  )
  useEffect(() => {
    setWorkSettingsOpen(false)
  }, [mode])

  // 把外观设置同步到 <html>，具体配色由 tokens.css 决定
  useTheme(settings.appearance, settings.accent, settings.customAccentColor)
  useVisualEffects(settings.visualEffects)

  return (
    <div className="workbench">
      <MenuBar />
      <div className="mode-deck">
        <ModeSurface mode="code" active={mode === 'code'}>
          <div ref={bodyRef} className="workbench__body">
            <ActivityBar />

            {layout.sidebarVisible ? (
              <>
                <div
                  ref={sidebarRef}
                  className="workbench__sidebar"
                  style={{ width: codePanes.sidebarWidth }}
                >
                  <Sidebar />
                </div>
                <Resizer
                  orientation="vertical"
                  ariaLabel="调整侧边栏宽度"
                  targetRef={sidebarRef}
                  size={codePanes.sidebarWidth}
                  min={codePanes.sidebarMin}
                  max={codePanes.sidebarMax}
                  active={mode === 'code'}
                  onResize={(sidebarWidth) => setLayout({ sidebarWidth })}
                />
              </>
            ) : null}

            {/* 对话面板换位：夹在侧边栏与主区之间（与 wuzu-client 的「交换对话区与源码区」一致） */}
            {layout.chatPanelVisible && layout.chatOnLeft ? (
              <>
                <div
                  ref={chatRef}
                  className="workbench__chat workbench__chat--left"
                  style={{ width: codePanes.chatPanelWidth }}
                >
                  <ChatPanel />
                </div>
                <Resizer
                  orientation="vertical"
                  ariaLabel="调整对话面板宽度"
                  targetRef={chatRef}
                  size={codePanes.chatPanelWidth}
                  min={codePanes.chatMin}
                  max={codePanes.chatMax}
                  active={mode === 'code'}
                  onResize={(chatPanelWidth) => setLayout({ chatPanelWidth })}
                />
              </>
            ) : null}

            <div className="workbench__main" style={{ minWidth: codePanes.mainMin }}>
              <EditorArea />

              {layout.panelVisible ? (
                <Resizer
                  orientation="horizontal"
                  ariaLabel="调整面板高度"
                  targetRef={panelRef}
                  size={layout.panelHeight}
                  min={LAYOUT_LIMITS.panelMin}
                  max={LAYOUT_LIMITS.panelMax}
                  direction={-1}
                  active={mode === 'code'}
                  onResize={(panelHeight) => setLayout({ panelHeight })}
                />
              ) : null}
              {/* 收起时仅隐藏不卸载（keep-alive）：面板内是终端这类有状态视图，
              重建 DOM 会丢掉 xterm 的画面与会话绑定 */}
              <div
                ref={panelRef}
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
                  targetRef={chatRef}
                  size={codePanes.chatPanelWidth}
                  min={codePanes.chatMin}
                  max={codePanes.chatMax}
                  direction={-1}
                  active={mode === 'code'}
                  onResize={(chatPanelWidth) => setLayout({ chatPanelWidth })}
                />
                <div
                  ref={chatRef}
                  className="workbench__chat"
                  style={{ width: codePanes.chatPanelWidth }}
                >
                  <ChatPanel />
                </div>
              </>
            ) : null}
          </div>

          <StatusBar />
        </ModeSurface>
        <ModeSurface mode="work" active={mode === 'work'}>
          <WorkView />
        </ModeSurface>
      </div>
      {workSettingsOpen && mode === 'work' ? (
        <Dialog
          title="设置"
          width={1000}
          className="work-settings-dialog"
          onClose={() => setWorkSettingsOpen(false)}
        >
          <AppSettingsView />
        </Dialog>
      ) : null}
      <CommandPalette />
      <QuickOpen />
    </div>
  )
}

/** 供布局边界检查使用的最小/最大值，避免魔法数字散落各处 */
export { LAYOUT_LIMITS }
