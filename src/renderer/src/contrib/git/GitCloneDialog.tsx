/**
 * Git 面板「克隆仓库」URL 输入弹窗（移植自 wuzu-client GitCloneDialog.vue）
 *
 * 仅负责收集与校验仓库地址；确认后由克隆流程（git-clone-flow.runCloneFlow）
 * 接力目录选择与克隆执行。弹窗显隐由 useGitCloneFlow().dialogVisible 驱动。
 * 挂载一次即可（GitChangesPanel 或应用根部）。
 */
import { useState, type JSX } from 'react'
import { Dialog } from '@renderer/workbench/Dialog'
import {
  closeCloneDialog,
  resetCloneProgress,
  runCloneFlow,
  useGitCloneFlow
} from '@renderer/core/git/git-clone-flow'

/** 容忍整条 `git clone <url>` 命令（对齐 VSCode cloneManager 的清洗） */
function cleanUrl(raw: string): string {
  return raw.trim().replace(/^git\s+clone\s+/i, '')
}

/** 轻校验：https/ssh/git/file 协议、scp 形式、或本地路径 */
const URL_SHAPE =
  /^(?:(?:https?|ssh|git|file):\/\/|git@)[^\s]+$|^[A-Za-z]:[\\/][^\s]+$|^[\\/][^\s]+$/

export function GitCloneDialog(): JSX.Element | null {
  const { dialogVisible } = useGitCloneFlow()
  const [url, setUrl] = useState('')
  const [validationError, setValidationError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!dialogVisible) return null

  const cleaned = cleanUrl(url)
  const canSubmit = URL_SHAPE.test(cleaned) && !busy

  const close = (): void => {
    setUrl('')
    setValidationError('')
    closeCloneDialog()
  }

  const handleConfirm = async (): Promise<void> => {
    if (!cleaned) {
      setValidationError('请输入仓库地址')
      return
    }
    if (!URL_SHAPE.test(cleaned)) {
      setValidationError('请输入有效的仓库地址，例如 https://github.com/user/repo.git')
      return
    }
    setBusy(true)
    setValidationError('')
    resetCloneProgress()
    try {
      await runCloneFlow(cleaned)
      setUrl('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="克隆仓库"
      width={440}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={() => void handleConfirm()}
          >
            克隆
          </button>
        </>
      }
    >
      <div className="git-clone__hint">
        粘贴仓库地址，或整条 <code>git clone &lt;url&gt;</code> 命令，克隆完成后可选择打开该仓库。
      </div>
      <label className="field">
        <input
          className={`field__input${validationError ? ' git-clone__input--invalid' : ''}`}
          placeholder="https://github.com/user/repo.git"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setValidationError('')
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              void handleConfirm()
            }
          }}
        />
      </label>
      {validationError ? <div className="notice notice--error">{validationError}</div> : null}
    </Dialog>
  )
}
