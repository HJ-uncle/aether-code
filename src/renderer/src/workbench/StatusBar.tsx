import { useEffect, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useEditor } from '@renderer/core/editor/editor-store'
import { useGit } from '@renderer/core/git/git-store'
import { executeCommand } from '@renderer/core/platform/commands'
import { togglePanel, toggleSidebarView } from '@renderer/core/platform/layout-state'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { useProblems } from '@renderer/core/lsp/problems-store'
import { GitSyncButton } from '@renderer/contrib/git/GitSyncButton'
import { Icon } from './icons'
import type { EnginePhase } from '@shared/ipc'

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
 * 用户就无法判断"是我的问题还是环境的问题"。因此常驻状态栏左侧并可一键启停。
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

  const busy =
    snapshot.phase === 'starting' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'

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
      <button
        type="button"
        className={`status-bar__item status-bar__item--${snapshot.phase}`}
        title={snapshot.error ?? snapshot.baseUrl ?? '引擎状态'}
        onClick={() => void executeCommand('aether.output.show')}
      >
        <span className={`status-dot status-dot--${snapshot.phase}`} />
        引擎：{PHASE_LABEL[snapshot.phase]}
        {snapshot.baseUrl ? ` · ${snapshot.baseUrl.replace('http://', '')}` : ''}
      </button>

      <span className="status-bar__item status-bar__item--muted">
        {snapshot.mode === 'embedded' ? '本地' : '远端'}
        {snapshot.adopted ? ' · 复用已有引擎' : ''}
        {snapshot.pid ? ` · pid ${snapshot.pid}` : ''}
      </span>

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
            <Icon name="git" size={12} />
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

      {busy ? <span className="status-bar__item status-bar__item--muted">处理中…</span> : null}

      <button
        type="button"
        className="status-bar__item"
        disabled={busy}
        title="启动引擎"
        aria-label="启动引擎"
        onClick={() => void executeCommand('aether.engine.start')}
      >
        <Icon name="play" size={12} />
      </button>
      <button
        type="button"
        className="status-bar__item"
        disabled={busy || snapshot.phase === 'idle'}
        title="停止引擎"
        aria-label="停止引擎"
        onClick={() => void executeCommand('aether.engine.stop')}
      >
        <Icon name="stop" size={12} />
      </button>
      <button
        type="button"
        className="status-bar__item"
        disabled={busy}
        title="重启引擎"
        aria-label="重启引擎"
        onClick={() => void executeCommand('aether.engine.restart')}
      >
        <Icon name="restart" size={12} />
      </button>
    </footer>
  )
}
