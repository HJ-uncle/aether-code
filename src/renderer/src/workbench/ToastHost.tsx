/**
 * 全局 toast 宿主：挂 App 顶层，右下角堆叠。
 * 点击单条可立即关闭（错误类常含可读详情，不强迫用户等 5 秒）。
 */
import type { JSX } from 'react'
import { useToasts, dismissToast, type ToastItem } from '../core/toast'
import { Icon } from './icons'

const ICON_OF: Record<ToastItem['kind'], Parameters<typeof Icon>[0]['name']> = {
  success: 'check',
  error: 'close',
  warning: 'warning',
  info: 'info'
}

export function ToastHost(): JSX.Element | null {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`toast-host__item toast-host__item--${item.kind}`}
          onClick={() => dismissToast(item.id)}
        >
          <Icon name={ICON_OF[item.kind]} size={16} />
          <span className="toast-host__text">{item.message}</span>
        </button>
      ))}
    </div>
  )
}
