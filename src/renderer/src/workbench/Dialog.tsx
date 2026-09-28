import { useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'

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
  onClose
}: DialogProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 打开时把焦点移进面板，避免焦点留在背后的页面上导致 Esc / Tab 行为错乱
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    // 优先聚焦首个可交互控件（输入框），没有则聚焦面板本身
    const focusable = panel.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'
    )
    if (focusable) focusable.focus()
    else panel.focus()
  }, [])

  // 焦点归还：记录打开前的焦点，卸载时还原。元素可能已不在 DOM，判 connected 兜底
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      if (previous && previous.isConnected) {
        try {
          previous.focus()
        } catch {
          /* 元素可能已不可聚焦，忽略 */
        }
      }
    }
  }, [])

  // 焦点陷阱：Tab / Shift+Tab 在弹窗内的可聚焦元素之间循环，不逃到背后界面
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (el) =>
        !el.hasAttribute('disabled') &&
        el.getAttribute('aria-hidden') !== 'true' &&
        (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
    )
    if (focusables.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault()
        last.focus()
      }
    } else {
      if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <header className="modal__header">
          <span>{title}</span>
          <button type="button" className="modal__close" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="modal__body">{children}</div>

        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}
