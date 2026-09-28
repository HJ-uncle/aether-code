/**
 * 「克隆仓库」全局单例 UI（移植自 wuzu-client GitCloneOverlay.vue）
 *
 * 组合：URL 输入弹窗（GitCloneDialog）+ 右下角浮动进度卡（对齐 VSCode Notification 进度）。
 * 流程状态在 core/git/git-clone-flow（模块级单例），各空状态入口共享同一份；
 * 进度订阅也只在这里挂一次（subscribeCloneProgress）。
 *
 * 挂载：在应用根部（或 GitChangesPanel）挂一次，并在挂载前调用 configureGitCloneFlow()。
 */
import { useEffect, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { GitCloneDialog } from './GitCloneDialog'
import {
  cancelCloneFlow,
  subscribeCloneProgress,
  useGitCloneFlow
} from '@renderer/core/git/git-clone-flow'
import { Icon } from '@renderer/workbench/icons'

export function GitCloneOverlay(): JSX.Element {
  const { stage, percentage, message } = useGitCloneFlow()

  // 进度订阅全局只挂一次：主进程按 cloneId 推送，flow 内部保证百分比只前进
  useEffect(() => subscribeCloneProgress(), [])

  return (
    <>
      <GitCloneDialog />
      {stage === 'running'
        ? createPortal(
            <div className="git-clone__float">
              <div className="git-clone__float-head">
                <Icon name="git" size={14} className="git-clone__float-icon" />
                <span className="git-clone__float-title">正在克隆仓库</span>
                <button
                  type="button"
                  className="git-clone__float-cancel"
                  title="取消克隆"
                  onClick={() => void cancelCloneFlow()}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
              <div className="git-clone__progress">
                <div className="git-clone__progress-bar" style={{ width: `${percentage}%` }} />
              </div>
              <div className="git-clone__float-message">{message || '准备克隆…'}</div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
