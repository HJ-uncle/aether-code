/**
 * 全局 toast 宿主：挂 App 顶层，右下角堆叠。
 * 点击单条可立即关闭（错误类常含可读详情，不强迫用户等 5 秒）。
 */
import { useLayoutEffect, useState, type JSX } from 'react'
import { useToasts, dismissToast, type ToastItem } from '../core/toast'
import { Icon } from './icons'
import { useMotionPresence } from './MotionPresence'

const ICON_OF: Record<ToastItem['kind'], Parameters<typeof Icon>[0]['name']> = {
  success: 'check',
  error: 'close',
  warning: 'warning',
  info: 'info'
}

export function ToastHost(): JSX.Element | null {
  const toasts = useToasts()
  const [retained, setRetained] = useState(toasts)
  useLayoutEffect(() => {
    setRetained(previous => [...toasts, ...previous.filter(item => !toasts.some(current => current.id === item.id))])
  }, [toasts])
  if (retained.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {retained.map((item) => <ToastRow key={item.id} item={item} show={toasts.some(current => current.id === item.id)}
        onExited={() => setRetained(previous => previous.filter(value => value.id !== item.id))} />)}
    </div>
  )
}

function ToastRow({ item, show, onExited }: { item: ToastItem; show: boolean; onExited: () => void }): JSX.Element | null {
  const motion = useMotionPresence(show, { onExited })
  if (!motion.present) return null
  return <button
          {...motion.motionProps}
          data-motion-axis="x"
          type="button"
          className={`toast-host__item toast-host__item--${item.kind}`}
          onClick={() => dismissToast(item.id)}
        >
          <Icon name={ICON_OF[item.kind]} size={16} />
          <span className="toast-host__text">{item.message}</span>
        </button>
}
