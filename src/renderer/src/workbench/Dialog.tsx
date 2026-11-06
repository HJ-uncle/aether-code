import { useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'
import { useMotionPresence } from './MotionPresence'
import { OverlayScope, useOverlay } from './overlay'

interface DialogProps {
  /** 标题栏文案 */
  title: string
  /** 正文内容 */
  children: ReactNode
  /** 底部操作区；不传则不渲染 footer */
  footer?: ReactNode
  /** 面板宽度；默认 520px */
  width?: number
  /** 附加到面板的类名（比如 modal--prompt 这类宽度/形态微调） */
  className?: string
  onClose: () => void
  /** Keep the component mounted while controlled visibility animates out. */
  open?: boolean
  /** Preserve a caller's pending-operation guard before starting dismissal. */
  closeDisabled?: boolean
  ownerId?: string | null
}

/**
 * 通用模态对话框
 *
 * 为什么要有这一层：之前 PromptDialog 和 ModelFormDialog 各自写了一遍
 * overlay + header + body + footer。两份实现很快就开始漂移 —— 圆角不一样、
 * 遮罩黑度不一样、一个支持 Esc 一个不支持、一个点了遮罩能关另一个不能。
 * 这类"每个弹窗各写一遍"的重复，正是 UI 不统一和位置错乱的来源。
 *
 * 因此把结构、材质、遮罩、Esc 关闭、点击遮罩关闭、焦点管理等收在这里，
 * 业务组件只负责"里面放什么"。
 *
 * 视觉：面板走磨砂玻璃材质（同 Popover/菜单），遮罩只做轻微压暗，
 * 让底层内容仍可感知，符合 macOS 弹窗"纸张浮起"而非"黑屏切换"的观感。
 */
export function Dialog({
  title,
  children,
  footer,
  width = 520,
  className,
  onClose,
  open,
  closeDisabled = false,
  ownerId
}: DialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [dismissed, setDismissed] = useState(false)
  const show = open ?? !dismissed
  const motion = useMotionPresence(show, { onExited: () => { if (open === undefined) onClose() } })
  const close = (): void => {
    if (closeDisabled) return
    if (open === undefined) setDismissed(true)
    else onClose()
  }

  const overlay = useOverlay({ open: show, present: motion.present, modal: true, panelRef, ownerId,
    closeOnOutside: !closeDisabled, onClose: close })

  if (!motion.present) return null
  return createPortal(
    <OverlayScope id={overlay.id}><div className="modal-overlay" {...motion.motionProps} {...overlay.layerProps} style={{ zIndex: overlay.zIndex }} data-motion-axis="y">
      <div
        ref={panelRef}
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <span>{title}</span>
          <button type="button" className="modal__close" aria-label="关闭" disabled={closeDisabled} onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="modal__body">{children}</div>

        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div></OverlayScope>,
    document.body
  )
}
