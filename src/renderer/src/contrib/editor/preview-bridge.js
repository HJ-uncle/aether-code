// Runs in an opaque sandbox origin. Only scroll ratios and local link requests cross the boundary.
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
    if (event.source !== parent || event.data?.type !== 'aether.preview.scrollTo' || event.data.channel !== channel) return
    const ratio = event.data.ratio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return
    const maximum = Math.max(0, root().scrollHeight - innerHeight)
    expectedScrollTop = Math.max(0, Math.min(1, ratio)) * maximum
    scrollTo({ top: expectedScrollTop, behavior: 'instant' })
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
