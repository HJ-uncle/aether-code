import { useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { changeSecurityMode, useSecurityMode } from '@renderer/core/engine/security-store'
import { MODE_DESCRIPTORS, isRiskyMode, type SecurityMode } from '@renderer/core/engine/security'
import { Icon } from '@renderer/workbench/icons'

interface SecurityModePickerProps {
  /** 当前对话的会话 ID。模式是会话级的，没有会话就没得切。 */
  sessionId: string
  /** 打开安全视图（策略规则表） */
  onManage: () => void
}

/**
 * 输入框旁的安全模式快捷入口
 *
 * 放在对话里而不是只放在安全页：被拦截时用户正盯着输入框，
 * 要让他在这就能把本会话放宽，而不是切页、找设置、再切回来。
 *
 * 状态来自 security-store，所以授权卡片上的「一键放行」也会实时反映到这里。
 */
export function SecurityModePicker({ sessionId, onManage }: SecurityModePickerProps): JSX.Element {
  const { ready } = useApp()
  const { mode, loaded, loading, error, refresh } = useSecurityMode()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 会话就绪后拉取一次；引擎重启会把 store 清空，loaded 变 false 会再拉
  useEffect(() => {
    if (ready && sessionId && !loaded && !loading) void refresh(sessionId)
  }, [ready, sessionId, loaded, loading, refresh])

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const descriptor = MODE_DESCRIPTORS.find((item) => item.value === mode)
  const risky = isRiskyMode(mode)

  const pick = async (next: SecurityMode): Promise<void> => {
    setOpen(false)
    if (next === mode) return
    setBusy(true)
    setActionError(null)
    try {
      await changeSecurityMode(sessionId, next)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const disabled = !ready || !sessionId

  return (
    <div className="sec-picker" ref={rootRef}>
      <button
        type="button"
        className={`sec-picker__trigger${open ? ' is-open' : ''}${
          risky ? ' sec-picker__trigger--risky' : ''
        }`}
        disabled={disabled || busy}
        title={
          !sessionId
            ? '先发一条消息建立会话，之后才能设置安全模式'
            : `本会话安全模式：${descriptor?.label ?? mode}；点击切换`
        }
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="shield" size={12} />
        {busy ? '切换中…' : (descriptor?.label ?? mode)}
        <span className="sec-picker__caret">⌃</span>
      </button>

      {open ? (
        <div className="sec-picker__popup" role="menu">
          <div className="sec-picker__section">本会话安全模式</div>
          {MODE_DESCRIPTORS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitem"
              className={`sec-picker__item${item.value === mode ? ' is-active' : ''}`}
              onClick={() => void pick(item.value)}
            >
              <span className="sec-picker__item-head">
                {item.label}
                {item.value === mode ? <span className="sec-picker__mark">当前</span> : null}
              </span>
              <small>{item.summary}</small>
              {item.warning ? <small className="sec-picker__warn">{item.warning}</small> : null}
            </button>
          ))}

          {error || actionError ? (
            <div className="sec-picker__hint sec-picker__hint--error">{actionError ?? error}</div>
          ) : null}

          <div className="sec-picker__footer">
            <button
              type="button"
              className="sec-picker__action"
              onClick={() => {
                setOpen(false)
                onManage()
              }}
            >
              安全策略与规则
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
