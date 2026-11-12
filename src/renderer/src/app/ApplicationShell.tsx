import { useEffect, useState, type JSX } from 'react'
import { ApplicationView } from '@renderer/app/ApplicationView'
import { AppSettingsView } from '@renderer/features/settings/AppSettingsView'
import { subscribeSectionRequest } from '@renderer/features/settings/app-settings-navigation'
import { Dialog } from '../ui/Dialog'
import { IconProvider } from '../ui/icons'
import { useApp } from '@renderer/core/app-context'
import { useTheme } from '@renderer/core/useTheme'
import { useVisualEffects } from '@renderer/core/useVisualEffects'
import { CommandPalette } from '../ui/CommandPalette'
import { MenuBar } from './MenuBar'
import { StatusBar } from './StatusBar'
import { GitDiffHost } from '@renderer/features/git/GitDiffHost'
import './shell.css'

/** The application owns one workspace surface and shared global overlays. */
export function ApplicationShell(): JSX.Element {
  const { settings } = useApp()
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)
  useEffect(
    () =>
      subscribeSectionRequest(() => {
        setSessionSettingsOpen(true)
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
          <ApplicationView />
        </IconProvider>
      </div>
      <StatusBar />
      <Dialog
        open={sessionSettingsOpen}
        title="设置"
        width={1000}
        className="work-settings-dialog"
        onClose={() => setSessionSettingsOpen(false)}
      >
        <AppSettingsView />
      </Dialog>
      <CommandPalette />
      <GitDiffHost />
    </div>
  )
}
