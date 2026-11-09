const selector = '[data-scroll-axis="x"]'
const scrollable = /^(auto|scroll)$/
const edgeAttribute = 'data-scroll-edges'

/** 提示需要在鼠标进入前可见，不能依赖只服务于当前悬停区域的浮动滚动条。 */
export function installHorizontalScrollHints(): () => void {
  const targets = new Map<HTMLElement, Set<Element>>()
  const owners = new Map<Element, Set<HTMLElement>>()
  const pending = new Set<HTMLElement>()
  let frame = 0

  const flush = (): void => {
    frame = 0
    // 先完成所有尺寸读取，再统一写属性，避免多条标签栏反复触发布局。
    const updates = [...pending].map(target => {
      let edges = ''
      if (target.isConnected && target.clientWidth && target.clientHeight) {
        const style = getComputedStyle(target)
        const maximum = target.scrollWidth - target.clientWidth
        if (maximum > 1 && scrollable.test(style.overflowX) && !scrollable.test(style.overflowY)) {
          const offset = target.scrollLeft + (style.direction === 'rtl' ? maximum : 0)
          // Chromium 在缩放后可能留下小数误差，避免已到底仍残留一条渐变。
          const left = offset > 1, right = maximum - offset > 1
          edges = left && right ? 'both' : left ? 'left' : right ? 'right' : ''
        }
      }
      return { target, edges }
    })
    pending.clear()
    for (const { target, edges } of updates) {
      if (edges) {
        if (target.getAttribute(edgeAttribute) !== edges) target.setAttribute(edgeAttribute, edges)
      } else target.removeAttribute(edgeAttribute)
    }
  }
  const schedule = (target: HTMLElement): void => {
    pending.add(target)
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const resize = new ResizeObserver(entries => {
    for (const { target } of entries) for (const owner of owners.get(target) ?? []) schedule(owner)
  })
  const unobserve = (element: Element, target: HTMLElement): void => {
    const list = owners.get(element)
    list?.delete(target)
    if (!list?.size) { resize.unobserve(element); owners.delete(element) }
  }
  const refresh = (target: HTMLElement): void => {
    // 同批MutationObserver还可能带着已卸载子树的记录，不能把它重新注册。
    if (!target.isConnected) { remove(target); return }
    const previous = targets.get(target) ?? new Set<Element>()
    const next = new Set<Element>([target, ...target.children])
    for (const element of previous) if (!next.has(element)) unobserve(element, target)
    for (const element of next) {
      if (previous.has(element)) continue
      const list = owners.get(element) ?? new Set<HTMLElement>()
      list.add(target)
      owners.set(element, list)
      resize.observe(element)
    }
    targets.set(target, next)
    schedule(target)
  }
  const remove = (target: HTMLElement): void => {
    for (const element of targets.get(target) ?? []) unobserve(element, target)
    targets.delete(target)
    pending.delete(target)
    target.removeAttribute(edgeAttribute)
  }
  const within = (node: Node, visit: (target: HTMLElement) => void): void => {
    if (!(node instanceof Element)) return
    if (node instanceof HTMLElement && node.matches(selector)) visit(node)
    node.querySelectorAll<HTMLElement>(selector).forEach(visit)
  }
  const queueParents = (node: Node, visit = refresh): void => {
    let target = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(selector)
    while (target) {
      visit(target)
      target = target.parentElement?.closest<HTMLElement>(selector)
    }
  }
  const mutation = new MutationObserver(records => {
    const dirty = new Set<HTMLElement>()
    const visit = (target: HTMLElement): void => { dirty.add(target) }
    const changed = new Set<Node>()
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) within(node, visit)
        for (const node of record.removedNodes) within(node, target => {
          if (!target.isConnected) remove(target)
        })
      } else if (record.type === 'attributes') {
        const node = record.target
        if (node instanceof HTMLElement && targets.has(node) && !node.matches(selector)) remove(node)
        // 祖先的class/style可能切换单轴/双轴或显示状态，也要更新内部区域。
        if (!changed.has(node)) { within(node, visit); changed.add(node) }
      }
      queueParents(record.target, visit)
    }
    for (const target of dirty) refresh(target)
  })
  const queueAll = (): void => { for (const target of targets.keys()) schedule(target) }
  const onScroll = (event: Event): void => {
    if (event.target instanceof HTMLElement && targets.has(event.target)) schedule(event.target)
  }
  const onLoad = (event: Event): void => {
    if (event.target instanceof Node) queueParents(event.target)
  }
  within(document.documentElement, refresh)
  mutation.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    // 不观察自己维护的edge属性，防止每次滚动触发新一轮测量。
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'dir', 'data-scroll-axis']
  })
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('load', onLoad, true)
  document.fonts.addEventListener('loadingdone', queueAll)
  window.addEventListener('resize', queueAll)
  return () => {
    cancelAnimationFrame(frame)
    mutation.disconnect()
    resize.disconnect()
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('load', onLoad, true)
    document.fonts.removeEventListener('loadingdone', queueAll)
    window.removeEventListener('resize', queueAll)
    for (const target of targets.keys()) target.removeAttribute(edgeAttribute)
    targets.clear()
    owners.clear()
    pending.clear()
  }
}
