import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

/** 浮层展开方向 */
export type PopoverPlacement = 'up' | 'down'

/** 浮层相对触发区的水平对齐 */
export type PopoverAlign = 'start' | 'end'

interface PopoverProps {
  /** 触发区内容（浮层开关由本组件接管，业务不用自己维护 open 状态） */
  trigger: (state: { open: boolean }) => ReactNode
  /** 浮层内容 */
  children: ReactNode
  /** 首选展开方向：up=向上（贴底元素用），down=向下（顶部元素用） */
  placement?: PopoverPlacement
  /** 水平对齐：start=左对齐，end=右对齐 */
  align?: PopoverAlign
  /** 浮层宽度；不传则由内容决定 */
  width?: number
  /** 触发区外层类名 */
  className?: string
  /** 浮层的无障碍名称 */
  label?: string
  /** 去掉面板内边距（菜单/列表类内容自带内边距并需要裁切圆角） */
  flush?: boolean
}

/** 浮层与触发区之间的间距 */
const GAP = 6
/** 与视口边缘的最小留白 */
const MARGIN = 8

interface Position {
  left: number
  top: number
  /** 实际生效的方向：可能与请求的 placement 不同（空间不足时会翻转） */
  placement: PopoverPlacement
}

/**
 * 通用浮层（popover）
 *
 * 统一解决四件每次复用都会踩的事，避免各业务各修一遍：
 * 1. **层级**：通过 portal 挂到 body 顶层，不会被消息流/滚动容器/工具栏的
 *    层叠上下文盖住。这一点很关键 —— 放在原地时，只要祖先元素带了
 *    transform / filter / overflow，浮层就会被裁切或压住；
 * 2. **定位**：读触发区的视口矩形，按 placement/align 算出坐标，并在
 *    空间不足时自动翻转方向、贴边收拢。这是"弹窗跑到窗口外"的根治办法；
 * 3. **交互**：点击外部关闭、Esc 关闭、滚动/resize 跟随重算，全部内置；
 * 4. **外观**：面板样式（磨砂材质、圆角、投影）集中由 .popover__panel 定义。
 *
 * 触发区通过 render-prop 拿到 open，用于给自己加选中态。
 */
export function Popover({
  trigger,
  children,
  placement = 'down',
  align = 'start',
  width,
  className,
  label,
  flush
}: PopoverProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Position | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 关闭时清掉上一次的定位（React 官方「渲染时调整 state」模式），
  // 避免在 effect 里同步 setState 触发级联渲染
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) setPos(null)
  }

  /**
   * 计算面板坐标。
   * 用 useLayoutEffect 在绘制前完成，因此用户看不到"先出现在错误位置再跳回来"。
   */
  const reposition = useCallback((): void => {
    const anchor = triggerRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return

    const rect = anchor.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // 垂直：优先用请求的方向，该侧放不下且另一侧更宽裕时翻转
    let side = placement
    const belowTop = rect.bottom + GAP
    const aboveBottom = rect.top - GAP
    const fitsBelow = belowTop + panelRect.height <= vh - MARGIN
    const fitsAbove = aboveBottom - panelRect.height >= MARGIN
    if (side === 'down' && !fitsBelow && fitsAbove) side = 'up'
    else if (side === 'up' && !fitsAbove && fitsBelow) side = 'down'

    let top = side === 'down' ? belowTop : aboveBottom - panelRect.height
    // 两侧都放不下时（面板比可用空间还高），贴边并允许内部滚动
    top = Math.max(MARGIN, Math.min(top, vh - panelRect.height - MARGIN))
    if (panelRect.height + MARGIN * 2 > vh) top = MARGIN

    // 水平：按 align 对齐，然后钳制进视口 —— 右侧贴边的元素（比如输入框右下角
    // 的模型选择器）最容易把面板顶出窗口，这里是那类问题的兜底
    let left = align === 'start' ? rect.left : rect.right - panelRect.width
    left = Math.max(MARGIN, Math.min(left, vw - panelRect.width - MARGIN))

    setPos({ left, top, placement: side })
  }, [placement, align])

  // 打开后先量一次；面板尺寸可能因内容异步变化（列表加载完成），用 ResizeObserver 跟随
  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const panel = panelRef.current
    if (!panel) return
    const observer = new ResizeObserver(() => reposition())
    observer.observe(panel)
    return () => observer.disconnect()
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      // 嵌套弹层的面板也是 portal 到 body 的兄弟节点（如对话偏好里的下拉菜单），
      // 点击落在「另一个」面板里不能算外部，否则会把外层一起关掉、连带卸载内层内容。
      // 单层场景下页面上只有自己的面板，上一行已拦住，本行不会误伤。
      if ((target as Element).closest?.('.popover__panel')) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    // 滚动/resize 后触发区位置就变了，重算而不是关闭（浮层常贴在输入框上，关闭太激进）
    const onReflow = (): void => reposition()

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReflow)
    // capture: 捕获阶段，任意可滚动容器（消息流、侧边栏）滚动都能收到
    document.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReflow)
      document.removeEventListener('scroll', onReflow, true)
    }
  }, [open, reposition])

  return (
    <div className={`popover${className ? ` ${className}` : ''}`} ref={triggerRef}>
      <div className="popover__trigger" onClick={() => setOpen((value) => !value)}>
        {trigger({ open })}
      </div>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              className={`popover__panel popover__panel--${pos?.placement ?? placement} popover__panel--${align}${
                flush ? ' popover__panel--flush' : ''
              }${pos ? ' is-positioned' : ''}`}
              role="dialog"
              aria-label={label}
              style={{
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                width: width ?? undefined
              }}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
