import { useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useEditor } from '@renderer/core/editor/editor-store'
import { useProblems } from '@renderer/core/lsp/problems-store'
import { openAppSettings } from '@renderer/features/settings/app-settings-navigation'
import { connectionLabel } from '@renderer/core/engine/connection-status'
import { extensionRegistry, extensionVisible, useExtensionContext } from '@renderer/features/extensions'
import { executeExtensionCommand, runExtensionAction } from '@renderer/features/extensions/interactions'
import { ServiceTray } from '@renderer/features/services/ServiceTray'
import { extensionIcon } from './navigation'
import { Icon } from '@renderer/ui/icons'
import '../ui/status-bar.css'

/**
 * 状态栏
 *
 * 引擎状态是 IDE 里最关键的可观测项：不知道引擎是否可用，
 * 用户就无法判断"是我的问题还是环境的问题"。状态常驻，维护操作统一放在引擎管理。
 */
export function StatusBar(): JSX.Element {
  const { engine } = useApp()
  const { snapshot } = engine
  const editor = useEditor()
  const { byFile: problemFiles } = useProblems()
  const extensions = useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  const context = useExtensionContext()

  let problemErrors = 0
  let problemWarnings = 0
  for (const items of problemFiles.values()) {
    for (const item of items) {
      if (item.severity === 'error') problemErrors++
      else if (item.severity === 'warning') problemWarnings++
    }
  }

  return (
    <footer className="status-bar">
      <div className="status-bar__engine">
        {/* Connection details and raw errors belong in the explicit settings
         * view, not in a persistent surface or its hover text. */}
        <button
          type="button"
          className={`status-bar__item status-bar__item--${snapshot.phase}`}
          title="打开引擎设置"
          onClick={() => openAppSettings('general')}
        >
          <span className={`status-dot status-dot--${snapshot.phase}`} aria-hidden="true" />
          引擎：{connectionLabel(snapshot)}
        </button>
      </div>

      <div className="status-bar__spacer" />
      {extensions.statusBar.filter(item => extensionVisible(item.scope ?? 'global', item.when, context)).map(item => <button key={item.id} type="button" className="status-bar__item" title={item.title} aria-label={item.title} onClick={() => {
        const registration = extensionRegistry.getRegistration(item.identity.pluginId)
        if (registration) runExtensionAction(() => executeExtensionCommand(registration, item.command, { ...context }))
      }}>{item.icon ? <Icon name={extensionIcon(item.icon)} size={13} /> : null}{item.title}</button>)}

      {problemErrors + problemWarnings > 0 ? (
        <span className="status-bar__item" title={`错误 ${problemErrors} · 警告 ${problemWarnings}`}>
          <span className="problems-view__dot is-error" aria-hidden="true" />
          {problemErrors}
          <span className="problems-view__dot is-warning" aria-hidden="true" />
          {problemWarnings}
        </span>
      ) : null}

      {/*
        光标位置：VS Code 把它放在状态栏右侧、紧邻语言模式。
        它不是缓存值 —— Monaco 只在光标真的动了才上报，所以这里读到的
        永远是当前值；不在编辑器里（设置页等）则整块不出现 ——
        故要同时满足「有读数」且「读数属于当前激活文件」，否则切标签的
        瞬间会短暂显示上一个文件的行列号。
      */}
      {editor.cursor && editor.cursor.filePath === editor.activePath ? (
        <span
          className="status-bar__item status-bar__item--muted"
          title="光标位置（行，列）"
          data-testid="status-cursor"
        >
          Ln {editor.cursor.line}, Col {editor.cursor.column}
        </span>
      ) : null}

      <ServiceTray variant="activity" sessionId={null} jobs={[]} />
      <ServiceTray variant="history" sessionId={null} jobs={[]} />

    </footer>
  )
}
