import { useEffect, useRef, useState, type JSX } from 'react'
import { Dialog } from './Dialog'

interface PromptDialogProps {
  title: string
  label: string
  /** 输入框初始值（重命名时为原名） */
  initialValue?: string
  confirmLabel?: string
  /** 返回错误文案表示不允许提交；返回 null 表示合法 */
  validate?: (value: string) => string | null
  onConfirm: (value: string) => void | Promise<void>
  onClose: () => void
}

/**
 * 单行输入对话框
 *
 * 为什么需要它：Electron 里 window.prompt 未实现（调用直接抛错），
 * 而"新建文件 / 重命名"这类操作必须让用户输入一个名字。
 * 与其在每处各写一套，不如按 VS Code 的做法收成一个通用原语。
 *
 * 结构与外观全部交给 <Dialog>，这里只负责"一个输入框 + 校验 + 提交"。
 */
export function PromptDialog({
  title,
  label,
  initialValue = '',
  confirmLabel = '确定',
  validate,
  onConfirm,
  onClose
}: PromptDialogProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开即全选：重命名时用户可直接覆写，不必先删掉原名
  // （聚焦由 Dialog 统一处理，这里只补一个"全选"）
  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = value.trim()
    const invalid = validate?.(trimmed) ?? (trimmed ? null : '名称不能为空')
    if (invalid) {
      setError(invalid)
      return
    }

    setBusy(true)
    setError(null)
    try {
      await onConfirm(trimmed)
      onClose()
    } catch (err) {
      // 失败时保持对话框打开：用户改个名字就能重试，不必重新走一遍右键
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={title}
      className="modal--prompt"
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
      onClose={onClose}
    >
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          className="field__input"
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            // 中文输入法组合期间的回车属于确认候选词，不能当作提交
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </label>

      {error ? <div className="notice notice--error">{error}</div> : null}
    </Dialog>
  )
}
