/**
 * Register shared editor commands, engine actions and application navigation.
 * The workspace surface owns its session and panel navigation.
 */
import { registerCommands } from '@renderer/core/platform/commands'
import { registerKeybindings } from '@renderer/core/platform/keybindings'
import { restartEngine, startEngine, stopEngine } from '@renderer/core/engine/client'
import { saveActiveDocument, saveAllDocuments } from '@renderer/core/editor/editor-store'
import { registerEditorCommands } from '../features/editor/editor-commands'
import { openAppSettings } from '../features/settings/app-settings-navigation'
import { requestSessionTerminal } from '../features/terminal/terminal-navigation'
import { registerBrowserContribution } from '../features/browser'

export function registerContributions(): () => void {
  const disposeEditorCommands = registerEditorCommands()
  const disposeBrowser = registerBrowserContribution()
  const disposeCommands = registerCommands([
    { id: 'aether.file.save', title: '保存文件', category: '文件', run: () => saveActiveDocument() },
    { id: 'aether.file.saveAll', title: '保存全部文件', category: '文件', run: () => saveAllDocuments() },
    { id: 'aether.engine.start', title: '启动引擎', category: '引擎', when: '!engineBusy',
      run: () => startEngine().then(() => undefined) },
    { id: 'aether.engine.stop', title: '停止引擎', category: '引擎', when: 'engineReady',
      run: () => stopEngine().then(() => undefined) },
    { id: 'aether.engine.restart', title: '重启引擎', category: '引擎', when: '!engineBusy',
      run: () => restartEngine().then(() => undefined) },
    { id: 'aether.terminal.newLocal', title: '新建终端', category: '终端', run: () => requestSessionTerminal('new') },
    { id: 'aether.panel.terminal', title: '切换终端面板', category: '视图', run: () => requestSessionTerminal('toggle') },
    { id: 'aether.view.models', title: '管理模型', category: '视图', run: () => openAppSettings('models') },
    { id: 'aether.view.security', title: '安全策略', category: '视图', run: () => openAppSettings('security') },
    { id: 'aether.view.appSettings', title: '打开设置', category: '视图', run: () => openAppSettings() },
    { id: 'aether.view.codegraph', title: '代码图索引', category: '视图', run: () => openAppSettings('codegraph') },
    { id: 'aether.preferences.openKeybindings', title: '打开键盘快捷方式', category: '首选项',
      run: () => openAppSettings('keybindings') }
  ])
  const disposeKeybindings = registerKeybindings([
    { key: 'ctrl+s', command: 'aether.file.save' },
    { key: 'ctrl+shift+s', command: 'aether.file.saveAll' },
    { key: 'ctrl+shift+m', command: 'aether.view.models' },
    { key: 'ctrl+,', command: 'aether.view.appSettings' },
    { key: 'ctrl+`', command: 'aether.panel.terminal' }
  ])
  return () => {
    disposeKeybindings()
    disposeCommands()
    disposeBrowser()
    disposeEditorCommands()
  }
}
