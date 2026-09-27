import { useEffect, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useGit } from '@renderer/core/git/git-store'
import { executeCommand } from '@renderer/core/platform/commands'
import { toggleSidebarView } from '@renderer/core/platform/layout-state'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
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
  // 只取 refresh：它在 store 里是模块级函数，引用稳定，放进依赖数组不会导致重复请求
  const { refresh: refreshGit, ...git } = useGit()

  const busy =
    snapshot.phase === 'starting' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'

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

      {/* 版本控制：Agent 改了什么以 git 为准，给一个常驻的核对入口 */}
      {workspace.root ? (
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
      ) : null}

      <div className="status-bar__spacer" />

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
