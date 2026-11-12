import { useEffect, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useEditor } from '@renderer/core/editor/editor-store'
import { useGit } from '@renderer/core/git/git-store'
import { togglePanel, toggleSidebarView } from '@renderer/core/platform/layout-state'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { useProblems } from '@renderer/core/lsp/problems-store'
import { GitSyncButton } from '@renderer/contrib/git/GitSyncButton'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import { Icon } from './icons'
import type { EnginePhase } from '@shared/ipc'
import './status-bar.css'

const PHASE_LABEL: Record<EnginePhase, string> = {
  idle: '未启动',
  installing: '安装中',
  starting: '启动中',
  ready: '就绪',
  stopping: '关闭中',
  error: '异常'
}

/**
 * 状态栏
 *
 * 引擎状态是 IDE 里最关键的可观测项：不知道引擎是否可用，
 * 用户就无法判断"是我的问题还是环境的问题"。状态常驻，维护操作统一放在引擎管理。
 */
export function StatusBar(): JSX.Element {
  const { engine } = useApp()
  const { snapshot } = engine
  const workspace = useWorkspace()
  const editor = useEditor()
  // 只取 refresh：它在 store 里是模块级函数，引用稳定，放进依赖数组不会导致重复请求
  const { refresh: refreshGit, ...git } = useGit()
  // 问题计数：点击打开问题面板（对齐 VS Code 状态栏的错误/警告计数）
  const { byFile: problemFiles } = useProblems()

  // A remote retry shares the starting phase but needs a distinct status label.
  const remoteReconnecting = snapshot.mode === 'remote' && snapshot.phase === 'starting' && snapshot.error?.includes('正在重新连接') === true

  let problemErrors = 0
  let problemWarnings = 0
  for (const items of problemFiles.values()) {
    for (const item of items) {
      if (item.severity === 'error') problemErrors++
      else if (item.severity === 'warning') problemWarnings++
    }
  }

  // 工作区分支跟随根目录变化重新拉取；与 Git 视图共用 store，不会重复请求
  useEffect(() => {
    void refreshGit(workspace.root)
  }, [workspace.root, refreshGit])

  const gitLabel = ((): string => {
    if (git.error) return 'git 不可用'
    if (git.status?.isRepo) {
      const count = git.status.changes.length
      return `${git.status.branch || 'HEAD'}${count > 0 ? ` · ${count} 处改动` : ''}`
    }
    if (git.status && !git.status.isRepo) return '非 Git 仓库'
    return 'git…'
  })()

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
          引擎：{remoteReconnecting ? '重新连接中' : snapshot.mode === 'remote' && snapshot.phase === 'starting' ? '连接中' : PHASE_LABEL[snapshot.phase]}
        </button>
      </div>

      {/* 版本控制：分支 + 同步操作 + 改动计数，对齐 wuzu-client 状态栏布局 */}
      {workspace.root ? (
        <>
          <button
            type="button"
            className="status-bar__item"
            title={
              git.error ??
              `打开版本控制视图\n仓库：${workspace.root}${
                git.status?.isRepo ? `\n分支：${git.status.branch}` : ''
              }`
            }
            onClick={() => toggleSidebarView('git')}
          >
            <Icon name="git" size={16} />
            {gitLabel}
          </button>
          {/* 同步/拉取/推送按钮组：只在仓库有效时出现 */}
          {git.status?.isRepo ? <GitSyncButton /> : null}
        </>
      ) : null}
      <div className="status-bar__spacer" />

      {problemErrors + problemWarnings > 0 ? (
        <button
          type="button"
          className="status-bar__item"
          title={`打开问题面板\n错误 ${problemErrors} · 警告 ${problemWarnings}`}
          onClick={() => togglePanel('problems')}
        >
          <span className="problems-view__dot is-error" aria-hidden="true" />
          {problemErrors}
          <span className="problems-view__dot is-warning" aria-hidden="true" />
          {problemWarnings}
        </button>
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

    </footer>
  )
}
