import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'

export interface ContextMenuItem {
  id: string
  label: string
  /** 右侧的次要说明（快捷键、类型等） */
  hint?: string
  /** 危险操作（删除等）用警示色 */
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

interface ContextMenuProps {
  /** 鼠标位置（视口坐标） */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * 通用右键菜单
 *
 * 独立成 workbench 层的通用组件而不是塞进资源管理器：
 * 右键菜单是「布局/交互原语」，后续编辑器标签、聊天消息都会用到，
 * 让它跟着某个业务视图走会逼下一个使用者去 import 资源管理器。
 *
 * 定位：菜单在视口坐标下渲染（position: fixed），并在首帧内完成
 * 溢出钳制 —— 用 useLayoutEffect 测量后修正，发生在浏览器绘制之前，
 * 因此不会看到菜单"先跑出屏幕再跳回来"。
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 4
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // 滚动后菜单位置就不再对应目标行，直接关闭比留在原地更不容易误点
    const onScroll = (): void => onClose()

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('blur', onScroll)
    // capture: 捕获阶段，任意可滚动容器（侧边栏、编辑器）滚动都能收到
    document.addEventListener('scroll', onScroll, true)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('blur', onScroll)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  return (
    <div
      className="context-menu"
      role="menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      // 菜单自身的按下事件不该冒泡给 document 的关闭监听
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
          disabled={item.disabled}
          title={item.hint}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          <span>{item.label}</span>
          {item.hint ? <span className="context-menu__hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  )
}
