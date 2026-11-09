// Runs in an opaque sandbox origin. The trusted parent validates each message's source and channel.
(() => {
  const channel = document.querySelector('meta[name="aether-preview-channel"]')?.content
  if (!channel) return
  const root = () => document.scrollingElement || document.documentElement
  let expectedScrollTop = null
  const send = () => {
    const element = root()
    const echo = expectedScrollTop !== null && Math.abs(element.scrollTop - expectedScrollTop) <= 2
    expectedScrollTop = null
    if (echo) return
    const maximum = Math.max(0, element.scrollHeight - innerHeight)
    parent.postMessage({ type: 'aether.preview.scroll', channel, ratio: maximum ? element.scrollTop / maximum : 0 }, '*')
  }
  addEventListener('scroll', send, { passive: true })
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.channel !== channel) return
    if (event.data.type === 'aether.preview.selectAll') {
      getSelection()?.selectAllChildren(document.body)
      return
    }
    if (event.data.type !== 'aether.preview.scrollTo') return
    const ratio = event.data.ratio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return
    const maximum = Math.max(0, root().scrollHeight - innerHeight)
    expectedScrollTop = Math.max(0, Math.min(1, ratio)) * maximum
    scrollTo({ top: expectedScrollTop, behavior: 'instant' })
  })
  const openMenu = (x, y) => {
    const selection = getSelection()
    const text = selection?.anchorNode && selection.focusNode && document.body.contains(selection.anchorNode) && document.body.contains(selection.focusNode)
      ? selection.toString() : ''
    parent.postMessage({ type: 'aether.preview.contextMenu', channel, x, y, text }, '*')
  }
  document.addEventListener('contextmenu', event => {
    if (event.target instanceof Element && event.target.closest('input,textarea,select,button,[contenteditable="true"]')) return
    event.preventDefault()
    openMenu(event.clientX, event.clientY)
  })
  document.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    if (event.target instanceof Element && event.target.closest('input,textarea,select,button,[contenteditable="true"]')) return
    event.preventDefault()
    const selection = getSelection()
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
    openMenu(rect?.left ?? 16, rect?.bottom ?? 16)
  })
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    const path = anchor.getAttribute('data-aether-local-path')
    if (!path && href.startsWith('#')) return
    event.preventDefault()
    if (path) parent.postMessage({ type: 'aether.preview.openFile', channel, path }, '*')
  })
  parent.postMessage({ type: 'aether.preview.ready', channel }, '*')
})()
