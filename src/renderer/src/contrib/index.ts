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
import {
  restartEngine,
  startEngine,
  stopEngine,
  updateSettings
} from '@renderer/core/engine/client'
import {
  getDocument,
  reopenLastClosedFile,
  saveActiveDocument,
  saveAllDocuments
} from '@renderer/core/editor/editor-store'
import {
  closeAllFileTabs,
  closeOtherFileTabs,
  closeTabByKey,
  closeTabsToRightOfActive,
  switchActiveTab
} from '@renderer/workbench/EditorArea'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { diagnoseDocument } from '@renderer/core/lsp/diagnostics'
import { undoLastFileOp, trashEntries, pasteFromClipboard } from '@renderer/core/workspace/file-ops'
import {
  getSelection,
  getWorkspaceState,
  pickAndOpenFolder,
  setClipboard
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
import { AppSettingsView } from './settings/AppSettingsView'
import { openAppSettings } from './settings/app-settings-navigation'
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
      id: 'aether.file.saveAll',
      title: '保存全部文件',
      category: '文件',
      run: () => saveAllDocuments()
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
        const confirmed = await confirmDialog({
          title: '移入回收站',
          body: question,
          confirmText: '移入回收站',
          danger: true
        })
        if (!confirmed) return
        await trashEntries(targets)
      }
    },
    {
      id: 'aether.explorer.cut',
      title: '剪切选中的文件',
      category: '文件',
      when: 'explorerHasSelection',
      run: () => {
        const targets = [...getSelection()]
        if (targets.length > 0) setClipboard(targets, 'cut')
      }
    },
    {
      id: 'aether.explorer.copy',
      title: '复制选中的文件',
      category: '文件',
      when: 'explorerHasSelection',
      run: () => {
        const targets = [...getSelection()]
        if (targets.length > 0) setClipboard(targets, 'copy')
      }
    },
    {
      // 粘贴的落点由资源管理器视图决定（光标行所在的目录），这里只负责触发；
      // 没有剪贴板内容时命令不生效，避免"点了没反应"
      id: 'aether.explorer.paste',
      title: '粘贴文件',
      category: '文件',
      when: 'explorerClipboardReady',
      run: () => pasteFromClipboard()
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
    // ── 编辑器标签 ──
    // 统一用 editorTabsCount 做 when：没有文件标签时这些命令在命令面板里
    // 就应该是置灰的，而不是点了没反应
    {
      id: 'aether.editor.closeTab',
      title: '关闭编辑器',
      category: '编辑器',
      when: 'editorTabsCount > 0',
      run: () => void closeTabByKey(getLayout().activeEditorView)
    },
    {
      id: 'aether.editor.closeOthers',
      title: '关闭其他编辑器',
      category: '编辑器',
      when: 'editorTabsCount > 1',
      run: () => {
        const active = getLayout().activeEditorView
        if (!active.startsWith('doc:')) return
        closeOtherFileTabs(active.slice(4))
      }
    },
    {
      id: 'aether.editor.closeToRight',
      title: '关闭右侧编辑器',
      category: '编辑器',
      when: 'editorTabsCount > 1',
      run: () => closeTabsToRightOfActive()
    },
    {
      id: 'aether.editor.closeAll',
      title: '全部关闭编辑器',
      category: '编辑器',
      when: 'editorTabsCount > 0',
      run: () => closeAllFileTabs()
    },
    {
      id: 'aether.editor.reopenClosed',
      title: '重新打开已关闭的编辑器',
      category: '编辑器',
      run: () => reopenLastClosedFile().then(() => undefined)
    },
    {
      id: 'aether.editor.nextTab',
      title: '切换到下一个编辑器',
      category: '编辑器',
      when: 'editorTabsCount > 1',
      run: () => switchActiveTab(1)
    },
    {
      id: 'aether.editor.previousTab',
      title: '切换到上一个编辑器',
      category: '编辑器',
      when: 'editorTabsCount > 1',
      run: () => switchActiveTab(-1)
    },
    // ── 视图 ──
    {
      id: 'aether.view.toggleSidebar',
      title: '切换侧边栏可见性',
      category: '视图',
      run: () => toggleSidebarView(getLayout().activeView)
    },
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
      run: () => openAppSettings('keybindings')
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
    // 剪贴板三键同样只在资源管理器持有焦点时生效：
    // 全局监听在捕获阶段先于编辑器拿到按键，无条件绑定会抢掉 Monaco 的复制粘贴
    // （Ctrl+C 拷代码、Ctrl+V 粘贴都得留给编辑器）。
    { key: 'ctrl+x', command: 'aether.explorer.cut', when: 'explorerFocused' },
    { key: 'ctrl+c', command: 'aether.explorer.copy', when: 'explorerFocused' },
    { key: 'ctrl+v', command: 'aether.explorer.paste', when: 'explorerFocused' },
    // ── 编辑器标签（对齐 VS Code EditorTab 的默认键位） ──
    // Ctrl+W 是 VS Code 的「关闭编辑器」。要拦：不拦会被 Chromium 当成关窗口，
    // 那会直接把整个 IDE 关掉 —— 这是最需要 preventDefault 的一条
    { key: 'ctrl+w', command: 'aether.editor.closeTab', when: 'editorTabsCount > 0' },
    // Ctrl+K 本身不绑命令：它是 VS Code 的「和弦」前缀（Ctrl+K 后再按一个键）。
    // 派发器只认单键组合，故 Ctrl+K 保留给后续和弦实现，这里只登记文档里的 Ctrl+K W 语义
    // Ctrl+Shift+T 与浏览器/VS Code 一致：重开最近关闭的编辑器
    { key: 'ctrl+shift+t', command: 'aether.editor.reopenClosed' },
    { key: 'ctrl+shift+s', command: 'aether.file.saveAll' },
    // Ctrl+B 切换侧边栏（VS Code 主键位）
    { key: 'ctrl+b', command: 'aether.view.toggleSidebar' },
    // Mac 用 Ctrl+Tab 切系统标签，故 VS Code 在 mac 上只提供 Ctrl+PageUp/Down；
    // 本项目不做平台分支，两个都给上，任选其一即可
    { key: 'ctrl+tab', command: 'aether.editor.nextTab', when: 'editorTabsCount > 1' },
    { key: 'ctrl+pagedown', command: 'aether.editor.nextTab', when: 'editorTabsCount > 1' },
    { key: 'ctrl+pageup', command: 'aether.editor.previousTab', when: 'editorTabsCount > 1' },
    { key: 'ctrl+shift+e', command: 'aether.view.explorer' },
    { key: 'ctrl+shift+f', command: 'aether.view.search' },
    { key: 'ctrl+shift+c', command: 'aether.view.chat' },
    { key: 'ctrl+shift+m', command: 'aether.view.models' },
    // Ctrl+Shift+S 原本绑「安全策略」，已让位给「保存全部文件」（VS Code 语义）。
    // 安全策略改由命令面板/菜单栏进入
    { key: 'ctrl+shift+o', command: 'aether.view.security' },
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
