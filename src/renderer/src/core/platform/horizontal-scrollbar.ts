const selector = '[data-scroll-axis="x"]'
const scrollable = /^(auto|scroll)$/
const clipped = /^(auto|scroll|hidden|clip)$/
const hitHeight = 8

/** 按需浮在底边的轨道，不给动态标签和代码块增加布局包装层。 */
export function installHorizontalScrollbar(): () => void {
  const bar = document.createElement('div')
  bar.className = 'horizontal-scrollbar'
  bar.setAttribute('role', 'scrollbar')
  bar.setAttribute('aria-orientation', 'horizontal')
  bar.setAttribute('aria-label', '水平滚动')
  bar.tabIndex = 0
  bar.hidden = true
  const thumb = document.createElement('div')
  thumb.className = 'horizontal-scrollbar__thumb'
  bar.append(thumb)
  let active: HTMLElement | null = null
  let ancestors: HTMLElement[] = []
  let generatedId: string | undefined
  let sequence = 0, frame = 0, travel = 0, maximum = 0
  let rtl = false, hovered = false, disposed = false
  let restoringFocus = false
  let previousFocus: HTMLElement | null = null
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let drag: { id: number; x: number; left: number } | undefined
  let resize: ResizeObserver, mutation: MutationObserver

  const schedule = (): void => {
    if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; update() })
  }
  const offset = (): number => active ? active.scrollLeft + (rtl ? maximum : 0) : 0
  const setOffset = (value: number): void => {
    if (active) active.scrollLeft = Math.max(0, Math.min(maximum, value)) - (rtl ? maximum : 0)
    schedule()
  }
  const releaseDrag = (): void => {
    const id = drag?.id
    drag = undefined
    if (id !== undefined && bar.hasPointerCapture(id)) bar.releasePointerCapture(id)
    bar.classList.remove('is-dragging')
  }
  const restoreFocus = (): void => {
    if (document.activeElement === bar) {
      restoringFocus = true
      if (previousFocus?.isConnected && previousFocus.getClientRects().length
        && !previousFocus.closest('[hidden], [inert], [aria-hidden="true"]')) previousFocus.focus({ preventScroll: true })
      else bar.blur()
      restoringFocus = false
    }
  }
  const hide = (): void => {
    releaseDrag()
    // display:none 会先让 Chromium 丢掉焦点，必须在隐藏之前归还给原控件。
    restoreFocus()
    bar.hidden = true
  }
  const clear = (): void => {
    hide()
    clearTimeout(hideTimer)
    resize.disconnect()
    mutation.disconnect()
    if (active && generatedId && active.id === generatedId) active.removeAttribute('id')
    generatedId = undefined
    active = null
    ancestors = []
    hovered = false
    bar.remove()
  }
  const deferHide = (): void => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!drag && !hovered && !active?.contains(document.activeElement) && document.activeElement !== bar) clear()
    }, 600)
  }
  const observe = (): void => {
    resize.disconnect()
    mutation.disconnect()
    if (!active) return
    ancestors = []
    resize.observe(active)
    for (const child of active.children) resize.observe(child)
    mutation.observe(active, { attributes: true, childList: true, characterData: true, subtree: true })
    // Monaco 用祖先 style.top 移动工具栏，不一定触发原生 scroll。
    for (let parent = active.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent)
      resize.observe(parent)
      mutation.observe(parent, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert', 'aria-hidden'], childList: true })
    }
  }
  const activate = (target: HTMLElement): void => {
    if (drag && active !== target) return
    clearTimeout(hideTimer)
    if (active !== target) {
      clear()
      active = target
      if (!target.id) { generatedId = `horizontal-scroll-${++sequence}`; target.id = generatedId }
      bar.setAttribute('aria-controls', target.id)
      // 保持模态内轨道属于模态，参与已有的焦点陷阱。
      const host = target.parentElement?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body
      host.append(bar)
      observe()
    }
    schedule()
  }
  const update = (): void => {
    if (!active) return
    if (!active.isConnected || active.closest('[hidden], [inert], [aria-hidden="true"]')) { clear(); return }
    if (active.parentElement !== ancestors[0]) observe()
    const style = getComputedStyle(active)
    if (!scrollable.test(style.overflowX) || scrollable.test(style.overflowY)
      || style.visibility !== 'visible' || !active.clientWidth || !active.clientHeight) { hide(); return }
    maximum = active.scrollWidth - active.clientWidth
    if (maximum <= 0) { hide(); return }
    rtl = style.direction === 'rtl'
    const bounds = active.getBoundingClientRect()
    const sx = bounds.width / active.offsetWidth || 1, sy = bounds.height / active.offsetHeight || 1
    let left = Math.max(0, bounds.left + active.clientLeft * sx)
    let right = Math.min(innerWidth, bounds.left + (active.clientLeft + active.clientWidth) * sx)
    const bottom = bounds.top + (active.clientTop + active.clientHeight) * sy
    let clipTop = 0, clipBottom = innerHeight
    for (const parent of ancestors) {
      const parentStyle = getComputedStyle(parent), rect = parent.getBoundingClientRect()
      if (parentStyle.visibility !== 'visible') { hide(); return }
      const px = rect.width / parent.offsetWidth || 1, py = rect.height / parent.offsetHeight || 1
      if (clipped.test(parentStyle.overflowX)) {
        left = Math.max(left, rect.left + parent.clientLeft * px)
        right = Math.min(right, rect.left + (parent.clientLeft + parent.clientWidth) * px)
      }
      if (clipped.test(parentStyle.overflowY)) {
        clipTop = Math.max(clipTop, rect.top + parent.clientTop * py)
        clipBottom = Math.min(clipBottom, rect.top + (parent.clientTop + parent.clientHeight) * py)
      }
    }
    // 被裁掉的底边不能重新绘制到相邻区域，命中区也全部留在目标内部。
    if (right - left < 24 || bottom > clipBottom + 0.5 || bottom - hitHeight < Math.max(clipTop, bounds.top)) {
      hide()
      return
    }
    bar.hidden = false
    const width = right - left
    const thumbWidth = Math.min(width, Math.max(24, width * active.clientWidth / active.scrollWidth))
    travel = width - thumbWidth
    let hx = 1, hy = 1, x = left, y = bottom - hitHeight
    bar.style.position = bar.parentElement === document.body ? 'fixed' : 'absolute'
    if (bar.style.position === 'absolute' && bar.offsetParent instanceof HTMLElement) {
      const parent = bar.offsetParent, rect = parent.getBoundingClientRect()
      hx = rect.width / parent.offsetWidth || 1
      hy = rect.height / parent.offsetHeight || 1
      x = (left - rect.left) / hx - parent.clientLeft + parent.scrollLeft
      y = (bottom - hitHeight - rect.top) / hy - parent.clientTop + parent.scrollTop
    }
    bar.style.left = `${x}px`
    bar.style.top = `${y}px`
    bar.style.width = `${width / hx}px`
    bar.style.height = `${hitHeight / hy}px`
    thumb.style.width = `${thumbWidth / hx}px`
    thumb.style.transform = `translateX(${Math.max(0, Math.min(maximum, offset())) / maximum * travel / hx}px)`
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', String(maximum))
    bar.setAttribute('aria-valuenow', String(Math.round(offset())))
  }
  resize = new ResizeObserver(schedule)
  mutation = new MutationObserver(() => {
    if (active) for (const child of active.children) resize.observe(child)
    schedule()
  })
  const onPointerOver = (event: PointerEvent): void => {
    const node = event.target instanceof Element ? event.target : null
    if (node && bar.contains(node)) { hovered = true; clearTimeout(hideTimer); return }
    const target = node?.closest<HTMLElement>(selector)
    if (target) { activate(target); hovered = active === target }
    else { hovered = false; deferHide() }
  }
  const onPointerOut = (event: PointerEvent): void => {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null
    if (next && (active?.contains(next) || bar.contains(next))) return
    hovered = false
    deferHide()
  }
  const onFocus = (event: FocusEvent): void => {
    if (restoringFocus) return
    const node = event.target instanceof Element ? event.target : null
    if (node === bar) {
      previousFocus = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
      return
    }
    const target = node?.closest<HTMLElement>(selector)
    if (target) activate(target)
    else deferHide()
  }
  const onScroll = (event: Event): void => {
    if (event.target instanceof HTMLElement && event.target.matches(selector)) {
      if (!active || event.target === active) { activate(event.target); deferHide() }
    }
    schedule()
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (!active || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    update()
    if (bar.hidden || travel <= 0) return
    bar.focus({ preventScroll: true })
    if (event.target !== thumb) {
      const track = bar.getBoundingClientRect(), grip = thumb.getBoundingClientRect()
      setOffset((event.clientX - track.left - grip.width / 2) / travel * maximum)
    }
    drag = { id: event.pointerId, x: event.clientX, left: offset() }
    bar.setPointerCapture(event.pointerId)
    bar.classList.add('is-dragging')
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id || travel <= 0) return
    event.preventDefault()
    setOffset(drag.left + (event.clientX - drag.x) / travel * maximum)
  }
  const endDrag = (): void => {
    const wasDragging = Boolean(drag)
    releaseDrag()
    if (wasDragging) restoreFocus()
    deferHide()
  }
  const onWheel = (event: WheelEvent): void => {
    if (!active || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.altKey) return
    const pixels = (element: HTMLElement, delta: number, page: number): number => {
      const style = getComputedStyle(element)
      return delta * (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? page
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? (parseFloat(style.lineHeight) || 16) : 1)
    }
    const delta = event.deltaX || event.deltaY
    if (!Number.isFinite(delta) || !delta) return
    const before = active.scrollLeft
    setOffset(offset() + pixels(active, delta, active.clientWidth))
    if (active.scrollLeft !== before) { event.preventDefault(); return }
    // 轨道是浮层，不在原滚动链里；边缘向外的纵轮仍交给最近可滚动祖先。
    if (event.deltaX) return
    for (const parent of ancestors) {
      const style = getComputedStyle(parent)
      if (!scrollable.test(style.overflowY)) continue
      const top = parent.scrollTop
      parent.scrollTop += pixels(parent, event.deltaY, parent.clientHeight)
      if (parent.scrollTop !== top) { event.preventDefault(); return }
      if (style.overscrollBehaviorY !== 'auto') return
    }
  }
  const onKey = (event: KeyboardEvent): void => {
    if (!active || event.ctrlKey || event.metaKey || event.altKey) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? maximum
      : event.key === 'ArrowLeft' ? offset() - 40 : event.key === 'ArrowRight' ? offset() + 40
        : event.key === 'PageUp' ? offset() - active.clientWidth : event.key === 'PageDown' ? offset() + active.clientWidth : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    setOffset(next)
  }
  bar.addEventListener('pointerdown', onPointerDown)
  bar.addEventListener('pointermove', onPointerMove)
  bar.addEventListener('pointerup', endDrag)
  bar.addEventListener('pointercancel', endDrag)
  bar.addEventListener('lostpointercapture', endDrag)
  bar.addEventListener('keydown', onKey)
  bar.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('pointerover', onPointerOver)
  document.addEventListener('pointerout', onPointerOut)
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', deferHide)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', schedule)
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    clear()
    document.removeEventListener('pointerover', onPointerOver)
    document.removeEventListener('pointerout', onPointerOut)
    document.removeEventListener('focusin', onFocus)
    document.removeEventListener('focusout', deferHide)
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', schedule)
  }
}
