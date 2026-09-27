/**
 * 内置功能注册
 *
 * 所有视图、命令、键位在这里集中登记，应用启动时调用一次。
 * 新增功能时只在对应目录加组件、在这里加一行注册，
 * 不需要改动 Workbench / ActivityBar / Sidebar 等布局代码。
 */
import { registerCommands } from '@renderer/core/platform/commands'
import { registerKeybindings } from '@renderer/core/platform/keybindings'
import {
  getLayout,
  showChatPanel,
  showEditorView,
  showPanel,
  toggleChatPanel,
  togglePanel,
  toggleSidebarView
} from '@renderer/core/platform/layout-state'
import { restartEngine, startEngine, stopEngine, updateSettings } from '@renderer/core/engine/client'
import { getDocument, saveActiveDocument } from '@renderer/core/editor/editor-store'
import { diagnoseDocument } from '@renderer/core/lsp/diagnostics'
import { undoLastFileOp, trashEntries } from '@renderer/core/workspace/file-ops'
import {
  getSelection,
  getWorkspaceState,
  pickAndOpenFolder
} from '@renderer/core/workspace/workspace-store'
import { requestSearchFocus } from './search/search-store'
import { registerDocumentRenderer, registerViews } from '@renderer/workbench/view-registry'
import { ChatView } from './chat/ChatView'
import { DocumentView } from './editor/DocumentView'
import { ExplorerView } from './explorer/ExplorerView'
import { GitView } from './git/GitView'
import { SessionHistoryView } from './history/SessionHistoryView'
import { OutputView } from './output/OutputView'
import { ProblemsView } from './problems/ProblemsView'
import { SearchView } from './search/SearchView'
import { AppSettingsView, openAppSettings } from './settings/AppSettingsView'
import { KeybindingsSettingsView } from './settings/KeybindingsSettingsView'
import { createLocalSession } from './terminal/terminal-store'
import { TerminalView } from './terminal/TerminalView'

export function registerContributions(): () => void {
  // 文件标签的渲染实现（workbench 只认识注册表，不认识具体组件）
  registerDocumentRenderer(DocumentView)

  const disposeViews = registerViews([
    {
      id: 'session-history',
      title: '会话历史',
      location: 'sidebar',
      icon: 'chat',
      order: 1,
      component: SessionHistoryView
    },
    {
      id: 'explorer',
      title: '资源管理器',
      location: 'sidebar',
      icon: 'explorer',
      order: 5,
      component: ExplorerView
    },
    {
      id: 'search',
      title: '搜索',
      location: 'sidebar',
      icon: 'search',
      order: 10,
      component: SearchView
    },
    {
      id: 'git',
      title: '版本控制',
      location: 'sidebar',
      icon: 'git',
      order: 10,
      component: GitView
    },
    {
      id: 'chat',
      title: '对话',
      location: 'right',
      icon: 'chat',
      order: 10,
      component: ChatView
    },
    {
      id: 'app-settings',
      title: '设置',
      location: 'editor',
      icon: 'settings',
      order: 10,
      closable: true,
      component: AppSettingsView
    },
    {
      id: 'keybindings',
      title: '键盘快捷方式',
      location: 'editor',
      icon: 'keyboard',
      order: 15,
      closable: true,
      component: KeybindingsSettingsView
    },
    {
      id: 'problems',
      title: '问题',
      location: 'panel',
      icon: 'output',
      order: 3,
      component: ProblemsView
    },
    {
      id: 'terminal',
      title: '终端',
      location: 'panel',
      icon: 'terminal',
      order: 5,
      component: TerminalView
    },
    {
      id: 'output',
      title: '输出',
      location: 'panel',
      icon: 'output',
      order: 10,
      component: OutputView
    }
  ])

  const disposeCommands = registerCommands([
    // ── 文件 ──
    {
      id: 'aether.workspace.openFolder',
      title: '打开文件夹',
      category: '文件',
      run: () => pickAndOpenFolder()
    },
    {
      id: 'aether.file.save',
      title: '保存文件',
      category: '文件',
      run: () => saveActiveDocument()
    },
    {
      id: 'aether.file.undo',
      title: '撤销文件操作',
      category: '文件',
      // 栈为空时命令不生效：快捷键与菜单项都不该在没东西可撤销时"点了一下没反应"
      when: 'fileOpUndoable',
      run: () => undoLastFileOp().then(() => undefined)
    },
    {
      id: 'aether.explorer.deleteSelected',
      title: '删除选中的文件',
      category: '文件',
      when: 'explorerHasSelection',
      run: async () => {
        const targets = [...getSelection()]
        if (targets.length === 0) return
        const question =
          targets.length > 1
            ? `确定把选中的 ${targets.length} 项移入回收站吗？`
            : `确定把「${targets[0]}」移入回收站吗？`
        if (!window.confirm(question)) return
        await trashEntries(targets)
      }
    },
    // ── 引擎 ──
    {
      id: 'aether.engine.start',
      title: '启动引擎',
      category: '引擎',
      when: '!engineBusy',
      run: () => startEngine().then(() => undefined)
    },
    {
      id: 'aether.engine.stop',
      title: '停止引擎',
      category: '引擎',
      when: 'engineReady',
      run: () => stopEngine().then(() => undefined)
    },
    {
      id: 'aether.engine.restart',
      title: '重启引擎',
      category: '引擎',
      when: '!engineBusy',
      run: () => restartEngine().then(() => undefined)
    },
    // ── 终端 ──
    {
      id: 'aether.terminal.newLocal',
      title: '新建终端',
      category: '终端',
      run: () => {
        showPanel('terminal')
        return createLocalSession(getWorkspaceState().root ?? undefined).then(() => undefined)
      }
    },
    // ── LSP ──
    {
      id: 'aether.lsp.diagnose',
      title: '诊断当前文件',
      category: 'LSP',
      when: 'engineReady',
      run: async () => {
        const active = getLayout().activeEditorView
        const doc = active.startsWith('doc:') ? getDocument(active.slice(4)) : undefined
        if (!doc || doc.isBinary) return
        showPanel('problems')
        await diagnoseDocument(doc.path, doc.content)
      }
    },
    // ── 视图 ──
    {
      id: 'aether.view.explorer',
      title: '显示资源管理器',
      category: '视图',
      run: () => toggleSidebarView('explorer')
    },
    {
      id: 'aether.view.sessionHistory',
      title: '显示会话历史',
      category: '视图',
      run: () => toggleSidebarView('session-history')
    },
    {
      id: 'aether.chat.newSession',
      title: '新建会话',
      category: '对话',
      run: () => {
        const generated = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`
        void updateSettings({ lastSessionId: generated }).then(() => showChatPanel())
      }
    },
    {
      id: 'aether.view.search',
      title: '全局搜索',
      category: '视图',
      // 与 VS Code 一致：重复触发不收起，而是确保视图打开并聚焦输入框
      run: () => requestSearchFocus()
    },
    {
      id: 'aether.view.chat',
      title: '切换对话面板',
      category: '视图',
      run: () => toggleChatPanel()
    },
    {
      id: 'aether.view.models',
      title: '管理模型',
      category: '视图',
      run: () => openAppSettings('models')
    },
    {
      id: 'aether.view.security',
      title: '安全策略',
      category: '视图',
      run: () => openAppSettings('security')
    },
    {
      id: 'aether.view.git',
      title: '版本控制',
      category: '视图',
      run: () => toggleSidebarView('git')
    },
    {
      id: 'aether.view.appSettings',
      title: '打开设置',
      category: '视图',
      run: () => showEditorView('app-settings')
    },
    {
      id: 'aether.view.codegraph',
      title: '代码图索引',
      category: '视图',
      run: () => openAppSettings('codegraph')
    },
    {
      id: 'aether.preferences.openKeybindings',
      title: '打开键盘快捷方式',
      category: '首选项',
      run: () => showEditorView('keybindings')
    },
    {
      id: 'aether.panel.problems',
      title: '切换问题面板',
      category: '视图',
      run: () => togglePanel('problems')
    },
    {
      id: 'aether.panel.terminal',
      title: '切换终端面板',
      category: '视图',
      run: () => togglePanel('terminal')
    },
    {
      id: 'aether.panel.output',
      title: '切换输出面板',
      category: '视图',
      run: () => togglePanel('output')
    },
    {
      id: 'aether.output.show',
      title: '显示输出面板',
      category: '视图',
      run: () => showPanel('output')
    }
  ])

  const disposeKeybindings = registerKeybindings([
    // 拦截 Ctrl+S：不拦会被 Chromium 当成"保存网页"
    { key: 'ctrl+s', command: 'aether.file.save' },
    // 加 when 是为了让编辑器里的 Ctrl+Z 仍然走 Monaco 的文本撤销：
    // 全局监听在捕获阶段先于 Monaco 拿到按键，无条件绑定会抢掉代码撤销
    { key: 'ctrl+z', command: 'aether.file.undo', when: 'explorerFocused' },
    { key: 'delete', command: 'aether.explorer.deleteSelected', when: 'explorerFocused' },
    { key: 'ctrl+shift+e', command: 'aether.view.explorer' },
    { key: 'ctrl+shift+f', command: 'aether.view.search' },
    { key: 'ctrl+shift+c', command: 'aether.view.chat' },
    { key: 'ctrl+shift+m', command: 'aether.view.models' },
    { key: 'ctrl+shift+s', command: 'aether.view.security' },
    { key: 'ctrl+shift+g', command: 'aether.view.git' },
    { key: 'ctrl+shift+j', command: 'aether.panel.output' },
    { key: 'ctrl+`', command: 'aether.panel.terminal' },
    { key: 'ctrl+,', command: 'aether.view.appSettings' },
    { key: 'ctrl+alt+r', command: 'aether.engine.restart' }
  ])

  return () => {
    disposeViews()
    disposeCommands()
    disposeKeybindings()
  }
}
