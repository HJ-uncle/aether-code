import { installHorizontalScrollbar } from './horizontal-scrollbar'

const horizontalScrollSelector = '[data-scroll-axis="x"]'
const nativeOverflow = /^(auto|scroll)$/

/** 显式标记单轴区域，避免根据当前内容高度误把双向编辑器当成标签栏。 */
export function horizontalWheelTarget(event: WheelEvent): HTMLElement | null {
  if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.altKey
    || event.deltaX !== 0 || !Number.isFinite(event.deltaY) || event.deltaY === 0) return null
  const target = event.target instanceof Element ? event.target : null
  const scroller = target?.closest<HTMLElement>(horizontalScrollSelector)
  if (!target || !scroller || scroller.clientWidth === 0 || scroller.scrollWidth <= scroller.clientWidth) return null

  const style = getComputedStyle(scroller)
  if (!nativeOverflow.test(style.overflowX) || nativeOverflow.test(style.overflowY)) return null

  // 嵌套滚动区和可编辑控件拥有自己的滚轮语义，即使已到边缘也不接管它们。
  for (let node: Element | null = target; node && node !== scroller; node = node.parentElement) {
    if (node.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null
    if (node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) continue
    const nestedStyle = getComputedStyle(node)
    if ((nativeOverflow.test(nestedStyle.overflowY) && node.scrollHeight > node.clientHeight)
      || (nativeOverflow.test(nestedStyle.overflowX) && node.scrollWidth > node.clientWidth)) return null
  }

  const max = scroller.scrollWidth - scroller.clientWidth
  const minLeft = style.direction === 'rtl' ? -max : 0
  const maxLeft = style.direction === 'rtl' ? 0 : max
  return event.deltaY < 0
    ? (scroller.scrollLeft > minLeft ? scroller : null)
    : (scroller.scrollLeft < maxLeft ? scroller : null)
}

export function handleHorizontalWheel(event: WheelEvent): void {
  const scroller = horizontalWheelTarget(event)
  if (!scroller) return
  const style = getComputedStyle(scroller)
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientWidth
    : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16)
      : 1
  const before = scroller.scrollLeft
  scroller.scrollLeft += event.deltaY * unit
  // 到边缘或没有实际位移时，继续交给外层原生滚动链。
  if (scroller.scrollLeft !== before) event.preventDefault()
}

/** 使用一个冒泡监听器支持动态标签和 Markdown；原生横向触控板、缩放手势不重映射。 */
export function installHorizontalWheelScrolling(): () => void {
  const disposeScrollbar = installHorizontalScrollbar()
  document.addEventListener('wheel', handleHorizontalWheel, { passive: false })
  return () => {
    document.removeEventListener('wheel', handleHorizontalWheel)
    disposeScrollbar()
  }
}
