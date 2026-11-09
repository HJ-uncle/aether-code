import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMotionDismiss, useMotionPresence, useMotionValue } from './MotionPresence'
import { OverlayScope, useOverlay } from './overlay'

export interface ContextMenuItem {
  id: string
  label: string
  /** 右侧的次要说明（快捷键、类型等） */
  hint?: string
  /** Full explanation when the compact hint is not enough. */
  title?: string
  /** 左侧色板圆点（颜色选择等场景），值为 CSS 颜色 */
  swatch?: string
  /** Decorative icon; the visible label remains the accessible name. */
  icon?: ReactNode
  /** 危险操作（删除等）用警示色 */
  danger?: boolean
  disabled?: boolean
  /** Visual/semantic grouping without adding a keyboard stop. */
  separatorBefore?: boolean
  /** 二级菜单：存在时本项为分组入口，hover 展开子面板，点击不再触发 onSelect */
  children?: ContextMenuItem[]
  /** Resolve lazy menu contents only when the user opens this group. */
  onOpen?: () => void
  onSelect: () => void
}

interface ContextMenuProps {
  /** 鼠标位置（视口坐标） */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** Restore owned focus before the exiting menu becomes inert. */
  onDismiss?: () => void
  /** 菜单锚点；仅锚点所在的可滚动祖先滚动时关闭，避免激活标签时编辑器恢复视图误关菜单。 */
  anchor?: Element | null
  /** Already-portaled hosts may own menu focus and keyboard navigation via DOM containment. */
  inline?: boolean
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

function navigateMenu(event: ReactKeyboardEvent, panel: HTMLElement | null): boolean {
  if (!panel || event.defaultPrevented || event.nativeEvent.isComposing) return false
  const buttons = [...panel.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)')]
  const current = buttons.findIndex(button => button === document.activeElement)
  let next: number
  if (event.key === 'ArrowDown') next = (current + 1) % buttons.length
  else if (event.key === 'ArrowUp') next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  else return false
  event.preventDefault()
  event.stopPropagation()
  buttons[next]?.focus({ preventScroll: true })
  buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return true
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
export function ContextMenu({ x, y, items, onClose: dismiss, onDismiss, anchor = null, inline = false }: ContextMenuProps): JSX.Element {
  const motion = useMotionDismiss(dismiss, `${x}:${y}`)
  const onClose = useCallback(() => {
    onDismiss?.()
    motion.close()
  }, [onDismiss, motion.close])
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  triggerRef.current = anchor instanceof HTMLElement ? anchor : null
  const overlay = useOverlay({ open: motion.show, present: motion.present, panelRef: ref, triggerRef, onClose, initialFocus: true })
  const [pos, setPos] = useState({ left: x, top: y })
  /** 当前展开的子菜单：父项 id + 锚点矩形（决定子面板摆放边） */
  const [submenu, setSubmenu] = useState<{ id: string; anchor: DOMRect; element: HTMLElement; focusFirst: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos(clampToViewport(el.getBoundingClientRect(), x, y))
  }, [x, y])

  useEffect(() => {
    if (!motion.show) return
    const openedAt = performance.now()
    // 右键标签时，激活非焦点编辑组会同步 Monaco 视图并让标签栏自动滚动。
    // 这次滚动发生在菜单挂载之后，但并不表示用户已经滚动了锚点；忽略这
    // 一小段同步窗口，否则菜单会在首帧被自己的激活动作卸载。
    const anchorTabBar = anchor?.closest('.editor-tabs') ?? null
    const ignoreAnchorScrollUntil = anchorTabBar ? performance.now() + 250 : 0
    // 滚动后菜单位置就不再对应目标行，直接关闭比留在原地更不容易误点
    const onScroll = (event: Event): void => {
      // Installed tools may exceed the viewport. Scrolling within a menu must
      // keep its keyboard/pointer interaction alive, including portaled submenus.
      if (event.type === 'scroll' && event.target instanceof Element && event.target.closest('.context-menu')) {
        // A parent row can move out from under its portaled child panel.
        if (event.target === ref.current) setSubmenu(null)
        return
      }
      // Focusing/revealing the clicked row can queue a scroll before this
      // menu exists, then deliver it after mounting. Only subsequent scrolls
      // invalidate the coordinates captured by the contextmenu event.
      if (event.type === 'scroll' && event.timeStamp < openedAt) return
      if (
        anchorTabBar &&
        performance.now() < ignoreAnchorScrollUntil &&
        event.target instanceof Node &&
        anchorTabBar.contains(event.target)
      ) return
      // 切换标签会让 Monaco 内容区恢复滚动位置；它与标签锚点无关，
      // 不应把刚打开的标签菜单吞掉。真正滚动锚点所在容器（或页面）时仍关闭。
      if (anchor && event.target instanceof Node && event.target !== document && !event.target.contains(anchor)) return
      onClose()
    }

    window.addEventListener('resize', onScroll)
    window.addEventListener('blur', onScroll)
    // capture: 捕获阶段，任意可滚动容器（侧边栏、编辑器）滚动都能收到
    document.addEventListener('scroll', onScroll, true)

    return () => {
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('blur', onScroll)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, anchor, motion.show, x, y])

  const openSubmenu = (item: ContextMenuItem, element: HTMLElement, focusFirst = false): void => {
    if (!item.children || item.disabled) return
    if (submenu?.id !== item.id) item.onOpen?.()
    setSubmenu({ id: item.id, anchor: element.getBoundingClientRect(), element, focusFirst })
  }

  const activeChildren = submenu
    ? (items.find((item) => item.id === submenu.id)?.children ?? null)
    : null
  const submenuMotion = useMotionPresence(Boolean(submenu && activeChildren))
  const lastSubmenu = useMotionValue(submenu && activeChildren ? { anchor: submenu.anchor, element: submenu.element, items: activeChildren, focusFirst: submenu.focusFirst } : null)

  const dismissForTab = (): void => {
    onClose()
    const target = triggerRef.current
    if (target?.matches('button, [href], [tabindex], [contenteditable="true"]')) target.focus({ preventScroll: true })
    else target?.querySelector<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]')?.focus({ preventScroll: true })
  }

  const content = (
    <div
      className="context-menu"
      {...motion.motionProps}
      {...overlay.layerProps}
      data-motion-axis="y"
      role="menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top, zIndex: overlay.zIndex }}
      // 菜单自身的按下事件不该冒泡给 document 的关闭监听
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Submenus are React descendants but have their own keyboard surface.
        if (!motion.show || event.defaultPrevented || !ref.current?.contains(event.target as Node) || event.nativeEvent.isComposing) return
        if (navigateMenu(event, ref.current)) { setSubmenu(null); return }
        if (event.key === 'ArrowRight') {
          const element = document.activeElement
          const item = element instanceof HTMLElement ? items.find(item => item.id === element.dataset.menuItemId) : undefined
          if (item?.children && element instanceof HTMLElement) {
            event.preventDefault()
            event.stopPropagation()
            openSubmenu(item, element, true)
          }
        } else if (event.key === 'Tab' && !inline) dismissForTab()
      }}
    >
      {items.map((item, index) => <Fragment key={item.id}>
        {index > 0 && item.separatorBefore ? <div className="context-menu__separator" role="separator" /> : null}
        {item.children ? (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-menu-item-id={item.id}
            aria-haspopup="menu"
            aria-expanded={submenu?.id === item.id}
            className={`context-menu__item context-menu__item--submenu${
              submenu?.id === item.id ? ' is-open' : ''
            }`}
            disabled={item.disabled}
            title={item.title ?? item.hint}
            onMouseEnter={(event) => openSubmenu(item, event.currentTarget)}
            onClick={(event) =>
              openSubmenu(item, event.currentTarget, true)
            }
          >
            {item.icon ? <span className="context-menu__icon" aria-hidden="true">{item.icon}</span> : null}
            <span className={item.icon ? 'context-menu__icon-label' : undefined}>{item.label}</span>
            <span className="context-menu__submenu-arrow" aria-hidden="true">›</span>
          </button>
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
            disabled={item.disabled}
            title={item.title ?? item.hint}
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.icon ? <span className="context-menu__icon" aria-hidden="true">{item.icon}</span> : null}
            {item.swatch ? (
              <span className="context-menu__swatch" style={{ background: item.swatch }} />
            ) : null}
            <span className={item.icon ? 'context-menu__icon-label' : undefined}>{item.label}</span>
            {item.hint ? <span className="context-menu__hint">{item.hint}</span> : null}
          </button>
        )}
      </Fragment>)}
      {submenuMotion.present && lastSubmenu ? (
        // portal 到 body：父菜单的 backdrop-filter 会让它成为 fixed 后代的包含块，
        // 子菜单不挪出去就会按「父菜单盒子 + 视口坐标」双重偏移，飞到屏幕远处
        createPortal(
          <SubmenuPanel anchor={lastSubmenu.anchor} element={lastSubmenu.element} items={lastSubmenu.items} onClose={onClose}
            onDismiss={() => setSubmenu(null)} onTab={dismissForTab} focusFirst={lastSubmenu.focusFirst} motionState={motion.show ? submenuMotion.state : 'closing'} />,
          document.body
        )
      ) : null}
    </div>
  )
  // Animated workspaces create fixed-position containing blocks. An existing
  // portal host may keep DOM ownership for keyboard navigation and focus.
  return <OverlayScope id={overlay.id}>{inline ? content : createPortal(content, document.body)}</OverlayScope>
}

/** 二级面板：贴父项右侧展开，空间不足翻到左侧；只做叶子项，不再嵌套 */
function SubmenuPanel({
  anchor,
  element,
  items,
  onClose,
  onDismiss,
  onTab,
  focusFirst,
  motionState
}: {
  anchor: DOMRect
  element: HTMLElement
  items: ContextMenuItem[]
  onClose: () => void
  onDismiss: () => void
  onTab: () => void
  focusFirst: boolean
  motionState: 'entering' | 'open' | 'closing'
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(element)
  triggerRef.current = element
  const overlay = useOverlay({ open: motionState !== 'closing', present: true, panelRef: ref, triggerRef, onClose: onDismiss })
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
  }, [anchor, items])

  useLayoutEffect(() => {
    if (!focusFirst || !pos || motionState === 'closing' || ref.current?.contains(document.activeElement)) return
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
  }, [focusFirst, pos, motionState, items])

  return (
    <div
      ref={ref}
      {...overlay.layerProps}
      data-motion-state={motionState}
      data-motion-axis="x"
      inert={motionState === 'closing' || undefined}
      aria-hidden={motionState === 'closing' || undefined}
      className="context-menu context-menu--submenu"
      role="menu"
      style={{ ...(pos ?? { left: anchor.right + 2, top: anchor.top - 4, visibility: 'hidden' }), zIndex: overlay.zIndex }}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (motionState === 'closing' || event.defaultPrevented || event.nativeEvent.isComposing || navigateMenu(event, ref.current)) return
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
          element.focus({ preventScroll: true })
        } else if (event.key === 'Tab') onTab()
      }}
    >
      {items.map((item, index) => <Fragment key={item.id}>
        {index > 0 && item.separatorBefore ? <div className="context-menu__separator" role="separator" /> : null}
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
          disabled={item.disabled}
          title={item.title ?? item.hint}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon ? <span className="context-menu__icon" aria-hidden="true">{item.icon}</span> : null}
          {item.swatch ? (
            <span className="context-menu__swatch" style={{ background: item.swatch }} />
          ) : null}
          <span className={item.icon ? 'context-menu__icon-label' : undefined}>{item.label}</span>
          {item.hint ? <span className="context-menu__hint">{item.hint}</span> : null}
        </button>
      </Fragment>)}
    </div>
  )
}
