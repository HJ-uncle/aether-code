import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  id: string
  label: string
  /** 右侧的次要说明（快捷键、类型等） */
  hint?: string
  /** 左侧色板圆点（颜色选择等场景），值为 CSS 颜色 */
  swatch?: string
  /** 危险操作（删除等）用警示色 */
  danger?: boolean
  disabled?: boolean
  /** 二级菜单：存在时本项为分组入口，hover 展开子面板，点击不再触发 onSelect */
  children?: ContextMenuItem[]
  onSelect: () => void
}

interface ContextMenuProps {
  /** 鼠标位置（视口坐标） */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/** 把矩形钳制进视口（四周留 margin），返回修正后的 left/top */
function clampToViewport(
  rect: { width: number; height: number },
  x: number,
  y: number
): { left: number; top: number } {
  const margin = 4
  return {
    left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
    top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
  }
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
 *
 * 二级菜单：item 带 children 时，hover/点击该入口在右侧展开子面板
 * （右侧空间不足则翻到左侧）；子面板里的项都是叶子，不再嵌套。
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  /** 当前展开的子菜单：父项 id + 锚点矩形（决定子面板摆放边） */
  const [submenu, setSubmenu] = useState<{ id: string; anchor: DOMRect } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos(clampToViewport(el.getBoundingClientRect(), x, y))
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      // 点在主菜单或任一子菜单内部都不算「点外部」
      if (ref.current?.contains(target)) return
      if ((target as HTMLElement).closest?.('.context-menu')) return
      onClose()
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

  const openSubmenu = (item: ContextMenuItem, anchor: DOMRect): void => {
    if (!item.children || item.disabled) return
    setSubmenu({ id: item.id, anchor })
  }

  const activeChildren = submenu
    ? (items.find((item) => item.id === submenu.id)?.children ?? null)
    : null

  return (
    <div
      className="context-menu"
      role="menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      // 菜单自身的按下事件不该冒泡给 document 的关闭监听
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item) =>
        item.children ? (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenu?.id === item.id}
            className={`context-menu__item context-menu__item--submenu${
              submenu?.id === item.id ? ' is-open' : ''
            }`}
            disabled={item.disabled}
            title={item.hint}
            onMouseEnter={(event) => openSubmenu(item, event.currentTarget.getBoundingClientRect())}
            onClick={(event) =>
              openSubmenu(item, event.currentTarget.getBoundingClientRect())
            }
          >
            <span>{item.label}</span>
            <span className="context-menu__submenu-arrow">›</span>
          </button>
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
            disabled={item.disabled}
            title={item.hint}
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.swatch ? (
              <span className="context-menu__swatch" style={{ background: item.swatch }} />
            ) : null}
            <span>{item.label}</span>
            {item.hint ? <span className="context-menu__hint">{item.hint}</span> : null}
          </button>
        )
      )}
      {submenu && activeChildren ? (
        // portal 到 body：父菜单的 backdrop-filter 会让它成为 fixed 后代的包含块，
        // 子菜单不挪出去就会按「父菜单盒子 + 视口坐标」双重偏移，飞到屏幕远处
        createPortal(
          <SubmenuPanel anchor={submenu.anchor} items={activeChildren} onClose={onClose} />,
          document.body
        )
      ) : null}
    </div>
  )
}

/** 二级面板：贴父项右侧展开，空间不足翻到左侧；只做叶子项，不再嵌套 */
function SubmenuPanel({
  anchor,
  items,
  onClose
}: {
  anchor: DOMRect
  items: ContextMenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 默认贴父项右缘；右侧放不下则翻到左缘
    const preferRight = anchor.right + 2
    const fitsRight = preferRight + rect.width <= window.innerWidth - 4
    const x = fitsRight ? preferRight : anchor.left - rect.width - 2
    setPos(clampToViewport(rect, x, anchor.top - 4))
  }, [anchor])

  return (
    <div
      ref={ref}
      className="context-menu context-menu--submenu"
      role="menu"
      style={pos ?? { left: anchor.right + 2, top: anchor.top - 4, visibility: 'hidden' }}
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
          {item.swatch ? (
            <span className="context-menu__swatch" style={{ background: item.swatch }} />
          ) : null}
          <span>{item.label}</span>
          {item.hint ? <span className="context-menu__hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  )
}
