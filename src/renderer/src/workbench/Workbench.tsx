import { useEffect, useState, type JSX } from 'react'
import { WorkView } from '@renderer/contrib/work/WorkView'
import { AppSettingsView } from '@renderer/contrib/settings/AppSettingsView'
import { subscribeSectionRequest } from '@renderer/contrib/settings/app-settings-navigation'
import { Dialog } from './Dialog'
import { IconProvider } from './icons'
import { useApp } from '@renderer/core/app-context'
import { useTheme } from '@renderer/core/useTheme'
import { useVisualEffects } from '@renderer/core/useVisualEffects'
import { CommandPalette } from './CommandPalette'
import { MenuBar } from './MenuBar'
import { StatusBar } from './StatusBar'
import './workbench-shell.css'

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
  const { settings } = useApp()
  const [workSettingsOpen, setWorkSettingsOpen] = useState(false)
  useEffect(
    () =>
      subscribeSectionRequest(() => {
        setWorkSettingsOpen(true)
      }),
    []
  )

  // 把外观设置同步到 <html>，具体配色由 tokens.css 决定
  useTheme(settings.appearance, settings.accent, settings.customAccentColor)
  useVisualEffects(settings.visualEffects)

  return (
    <div className="workbench">
      <MenuBar />
      <div className="mode-deck">
        <IconProvider variant="outline">
          <WorkView />
        </IconProvider>
      </div>
      <StatusBar />
      <Dialog
        open={workSettingsOpen}
        title="设置"
        width={1000}
        className="work-settings-dialog"
        onClose={() => setWorkSettingsOpen(false)}
      >
        <AppSettingsView />
      </Dialog>
      <CommandPalette />
    </div>
  )
}
