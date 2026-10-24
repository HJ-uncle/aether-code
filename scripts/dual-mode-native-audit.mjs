/** Native acceptance helpers for the existing dual-mode campaign application.
 * This module never launches an app/server/browser and never installs game state.
 * readDOM callbacks are reviewable, read-only DOM probes; they are not a sandbox.
 * Call only from the campaign's idle audit hook, after both durable roots settle.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const AUDIT_VIEWPORTS = Object.freeze([
  { name: 'phone-360', width: 360, height: 800, mobile: true, deviceScaleFactor: 1 },
  { name: 'phone-390', width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true, deviceScaleFactor: 1 },
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 }
].map(Object.freeze))

const active = new Set(['preparing', 'running', 'waiting', 'cancelling'])
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'])
const originOf = value => { try { return new URL(value).origin } catch { return null } }
const fingerprint = entry => JSON.stringify(entry)
const safeName = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'evidence'

async function until(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  do {
    try {
      last = await read()
      if (accept(last)) return last
    } catch (error) { last = { error: error.message } }
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(last).slice(0, 1000)}`)
}

/** request is the campaign's authenticated, identity-pinned engine request helper.
 * Returned handles use native Electron mouse/key events; selectors only locate
 * and inspect targets. Caller assertions must verify the resulting game behavior.
 */
export function createNativeAudit({ app, page, state, request, artifact, log = () => {} }) {
  if (!app || !page || !state?.evidenceRoot || typeof request !== 'function') {
    throw new Error('Native audit requires the live app, page, campaign state and request helper')
  }
  const handles = new Map()
  const evidenceRoot = resolve(state.evidenceRoot)
  const prefix = `native-${Date.now()}`
  let sequence = 0, idleCheckedAt = 0

  async function assertIdle(force = false) {
    for (const mode of ['code', 'work']) {
      const owner = state.modes?.[mode]
      if (!owner?.sessionId) throw new Error(`Missing ${mode} campaign owner`)
      if (owner.submissions?.some(item => !item.terminalOutcome)) throw new Error(`${mode} still has unsettled submissions`)
    }
    // Avoid one HTTP round trip per stone, while rechecking the durable roots
    // throughout a long audit. The campaign control loop awaits this audit.
    if (!force && Date.now() - idleCheckedAt < 1000) return
    const values = await Promise.all(['code', 'work'].map(async mode => ({ mode,
      status: await request('GET', '/chat/status', undefined, { sessionId: state.modes[mode].sessionId }, mode) })))
    for (const { mode, status } of values) {
      const outcome = status?.run?.status
      if (active.has(outcome) || (outcome && !terminal.has(outcome))) throw new Error(`${mode} durable root is not idle: ${outcome}`)
    }
    idleCheckedAt = Date.now()
  }

  const tabs = () => page.evaluate(() => window.aether.browser.list())
  async function selectMode(mode) {
    await assertIdle()
    await page.getByRole('tab', { name: mode === 'code' ? 'Code 开发' : 'Work 办公', exact: true }).click()
    await page.locator(`#mode-${mode}[aria-hidden="false"]`).waitFor({ state: 'visible' })
    return until(() => page.evaluate(() => window.aether.browser.getConnection()), value =>
      value.status === 'connected' && value.sessionId === state.modes[mode].sessionId,
    `${mode} browser bridge must retain the campaign session`)
  }

  async function reveal(mode, tabId) {
    const connection = await selectMode(mode)
    if (mode === 'work') {
      const workspaceTab = page.locator('#mode-work #work-tab-browser')
      if (!await workspaceTab.isVisible()) {
        const openWorkspace = page.locator('#mode-work').getByRole('button', { name: '打开工作区', exact: true })
        if (await openWorkspace.isVisible()) await openWorkspace.click()
      }
      if (await workspaceTab.isVisible()) await workspaceTab.click()
      else await page.locator('#mode-work .work-navigation').getByRole('button', { name: '浏览器', exact: true }).click()
    } else if (!await page.locator('#mode-code .browser-view:visible').count()) {
      await page.keyboard.press('Control+Alt+b')
    }
    const button = page.locator(`.browser-view:visible .browser-tab[data-browser-tab-id="${tabId}"]`).getByRole('tab')
    await button.click()
    return connection
  }

  async function open(mode, { tabId: requestedTabId } = {}) {
    if (!['code', 'work'].includes(mode)) throw new Error(`Invalid campaign mode: ${mode}`)
    await assertIdle(true)
    const connection = await selectMode(mode)
    const origin = originOf(state.origins?.[mode])
    if (!origin || !/^https?:/.test(origin)) throw new Error(`Invalid ${mode} project origin`)
    if (origin === originOf(state.origins?.[mode === 'code' ? 'work' : 'code'])) throw new Error('Project origins are not isolated')
    const sessionId = state.modes[mode].sessionId
    const engineId = connection.engineId
    if (!engineId) throw new Error('Connected browser is missing engine identity')
    let candidates = (await tabs()).filter(tab => originOf(tab.url) === origin &&
      tab.context?.sessionId === sessionId && tab.context?.engineId === engineId && (!requestedTabId || tab.tabId === requestedTabId))
    if (candidates.length > 1) throw new Error(`Ambiguous ${mode} browser tabs; pass a specific tabId`)
    if (requestedTabId && !candidates.length) throw new Error('Requested tab does not belong to this project/session')
    let provenance = 'existing-model-or-user-tab'
    if (!candidates.length) {
      const created = await page.evaluate(url => window.aether.browser.create({ url }), origin + '/')
      candidates = [created]
      provenance = 'harness-created-reopened; not evidence of model browser usage'
    }
    const initial = candidates[0]
    const handleKey = `${mode}:${initial.tabId}`
    if (handles.has(handleKey)) { await reveal(mode, initial.tabId); return handles.get(handleKey) }
    const originalViewport = initial.viewport ? { ...initial.viewport } : null
    const originalZoom = initial.zoomFactor
    await reveal(mode, initial.tabId)
    let guestId, restored = false
    const operations = [], captures = []
    const identity = { mode, origin, sessionId, engineId, tabId: initial.tabId, provenance }

    async function identify({ visible = false } = {}) {
      const tab = (await tabs()).find(item => item.tabId === initial.tabId)
      if (!tab || tab.context?.sessionId !== sessionId || tab.context?.engineId !== engineId || originOf(tab.url) !== origin) {
        throw new Error(`Browser identity changed: ${mode}/${initial.tabId}`)
      }
      if (visible) {
        const context = await page.evaluate(() => window.aether.browser.getConnection())
        if (context.status !== 'connected' || context.sessionId !== sessionId || context.engineId !== engineId) throw new Error('The browser bridge has switched owners')
      }
      const guests = await app.evaluate(({ BrowserWindow, WebContentsView }, url) =>
        BrowserWindow.getAllWindows().flatMap(host => host.contentView.children
          .filter(view => view instanceof WebContentsView && !view.webContents.isDestroyed() && view.webContents.getURL() === url)
          .map(view => ({ id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds(),
            hostVisible: host.isVisible(), minimized: host.isMinimized(), zoom: view.webContents.getZoomFactor() }))), tab.url)
      if (guests.length !== 1) throw new Error(`Expected one native guest for ${tab.url}, found ${guests.length}`)
      const guest = guests[0]
      if (guestId && guest.id !== guestId) throw new Error('Native guest was replaced during the audit')
      guestId = guest.id
      if (visible && (!guest.visible || !guest.hostVisible || guest.minimized || guest.bounds.width < 1 || guest.bounds.height < 1)) {
        throw new Error('Native browser input requires a visible guest in the existing, unminimized Aether window')
      }
      return { tab, guest }
    }

    await until(() => identify({ visible: true }), value => !value.tab.loading, 'Native page load')

    async function readDOM(reader, argument) {
      if (typeof reader !== 'function') throw new Error('readDOM expects a reviewed read-only function')
      const source = reader.toString()
      const { tab, guest } = await identify()
      return app.evaluate(({ webContents }, input) => {
        const wc = webContents.fromId(input.id)
        if (!wc || wc.isDestroyed() || wc.getURL() !== input.url) throw new Error('Guest navigation changed before DOM inspection')
        return wc.executeJavaScript(`(${input.source})(${JSON.stringify(input.argument) ?? 'undefined'})`)
      }, { id: guest.id, url: tab.url, source, argument })
    }

    async function perform(type, payload = {}) {
      await assertIdle()
      const { tab, guest } = await identify({ visible: true })
      const result = await app.evaluate(async ({ BrowserWindow, WebContentsView }, input) => {
        const pair = BrowserWindow.getAllWindows().flatMap(host => host.contentView.children
          .filter(view => view instanceof WebContentsView && view.webContents.id === input.id)
          .map(view => ({ host, view })))[0]
        if (!pair || !pair.view.getVisible() || !pair.host.isVisible() || pair.host.isMinimized()) throw new Error('Native target became hidden')
        const wc = pair.view.webContents
        if (wc.isDestroyed() || wc.getURL() !== input.url) throw new Error('Native target navigated')
        const bounds = pair.view.getBounds()
        if (['x', 'y', 'width', 'height'].some(key => bounds[key] !== input.bounds[key])) throw new Error('Native view moved before input')
        const geometry = await wc.executeJavaScript(`(() => {
          const v = window.visualViewport;
          return { width: v?.width ?? innerWidth, height: v?.height ?? innerHeight,
            left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0 };
        })()`)
        if (geometry.width <= 0 || geometry.height <= 0) throw new Error('Invalid page viewport')
        // sendInputEvent accepts view DIPs. The visual viewport-to-view ratio
        // includes the native device-emulation fit scale and page zoom.
        const scaleX = bounds.width / geometry.width, scaleY = bounds.height / geometry.height
        if (Math.abs(scaleX / scaleY - 1) > 0.02) throw new Error('Inconsistent CSS/native coordinate scale')
        const data = input.payload
        // Electron requires the containing window to be focused. This reuses
        // the campaign window; it never opens or unhides another application.
        pair.host.focus()
        wc.focus()
        if (input.type === 'click') {
          const target = await wc.executeJavaScript(`((selector, allowDisabled) => {
            const nodes = document.querySelectorAll(selector);
            if (nodes.length !== 1) throw new Error('Click selector must identify exactly one element');
            const element = nodes[0], style = getComputedStyle(element), rect = element.getBoundingClientRect();
            if ((!allowDisabled && element.matches(':disabled,[aria-disabled="true"]')) || style.visibility !== 'visible' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0)
              throw new Error('Click target is disabled or hidden');
            const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
            const top = document.elementFromPoint(x, y);
            if (!top || (top !== element && !element.contains(top))) throw new Error('Click target is offscreen or covered; use native scroll first');
            return { x, y, text: element.textContent?.trim().slice(0, 120), tag: element.tagName };
          })(${JSON.stringify(data.selector)}, ${data.allowDisabled === true})`)
          const x = Math.round((target.x - geometry.left) * scaleX), y = Math.round((target.y - geometry.top) * scaleY)
          if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw new Error('Click is outside native viewport')
          wc.sendInputEvent({ type: 'mouseMove', x, y })
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
          return { ...target, nativeX: x, nativeY: y, scaleX, scaleY }
        }
        if (input.type === 'key') {
          wc.sendInputEvent({ type: 'keyDown', keyCode: data.key, modifiers: data.modifiers })
          wc.sendInputEvent({ type: 'keyUp', keyCode: data.key, modifiers: data.modifiers })
          return { key: data.key, modifiers: data.modifiers }
        }
        if (input.type === 'text') { await wc.insertText(data.text); return { characters: data.text.length } }
        if (input.type === 'scroll') {
          const x = data.x == null ? Math.floor(bounds.width / 2) : Math.round((data.x - geometry.left) * scaleX)
          const y = data.y == null ? Math.floor(bounds.height / 2) : Math.round((data.y - geometry.top) * scaleY)
          if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw new Error('Scroll position is outside native viewport')
          // Positive API deltaY means scroll down, matching browser_scroll.
          wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -data.deltaX, deltaY: -data.deltaY, canScroll: true })
          return { x, y, deltaX: data.deltaX, deltaY: data.deltaY }
        }
        throw new Error('Unsupported native action')
      }, { id: guest.id, url: tab.url, bounds: guest.bounds, type, payload })
      const current = (await tabs()).find(item => item.tabId === initial.tabId)
      if (!current || current.navigationId !== tab.navigationId) throw new Error('Page navigated during native action; re-open and review before continuing')
      operations.push({ at: Date.now(), type, ...result })
      return result
    }

    async function read(kind) {
      await identify()
      const result = await page.evaluate(input => window.aether.browser.read(input.tabId, input.kind), { tabId: initial.tabId, kind })
      if (!result.success) throw new Error(`Browser ${kind}: ${result.error}`)
      return result.output
    }

    async function network() {
      const pages = [], entries = new Map()
      let offset = 0
      for (let count = 0; count < 5; count++) {
        const result = await page.evaluate(input => window.aether.browser.network(input.tabId, { offset: input.offset, limit: 200 }), { tabId: initial.tabId, offset })
        for (const entry of result.entries) entries.set(entry.id, entry)
        pages.push({ ...result, entries: undefined })
        if (!result.hasMore || result.nextOffset == null || result.nextOffset <= offset) break
        offset = result.nextOffset
      }
      return { entries: [...entries.values()], pages, truncated: pages.at(-1)?.hasMore === true }
    }

    const baselineConsole = await read('console'), baselineNetwork = await network()
    const consoleBefore = new Set((baselineConsole?.entries || []).map(fingerprint))
    const networkBefore = new Set(baselineNetwork.entries.map(fingerprint))
    const baselinePath = artifact?.(`${prefix}-${mode}-baseline.json`, { identity, console: baselineConsole, network: baselineNetwork })

    async function setViewport(viewport) {
      await assertIdle()
      await identify({ visible: true })
      const value = viewport == null ? null : { width: viewport.width, height: viewport.height,
        mobile: viewport.mobile, deviceScaleFactor: viewport.deviceScaleFactor }
      // Four CSS viewport sizes are comparable only at page zoom 1. Preserve
      // and restore the user's existing zoom with the original viewport.
      await page.evaluate(tabId => window.aether.browser.action({ tabId, action: 'zoom', zoomFactor: 1 }), initial.tabId)
      await page.evaluate(input => window.aether.browser.action({ tabId: input.tabId, action: 'viewport', viewport: input.viewport }), { tabId: initial.tabId, viewport: value })
      await until(() => readDOM(() => ({ width: innerWidth, height: innerHeight, ready: document.readyState })),
        data => data.ready === 'complete' && (!value || Math.abs(data.width - value.width) <= 1 && Math.abs(data.height - value.height) <= 1),
        'Requested CSS viewport did not settle')
      restored = false
      operations.push({ at: Date.now(), type: 'viewport', viewport: value })
    }

    async function capture(label) {
      await identify({ visible: true })
      const screenshot = await read('screenshot')
      if (!screenshot?.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Native screenshot did not return PNG data')
      mkdirSync(evidenceRoot, { recursive: true })
      const basename = `${prefix}-${String(++sequence).padStart(3, '0')}-${mode}-${safeName(label)}`
      const imagePath = join(evidenceRoot, basename + '.png')
      writeFileSync(imagePath, Buffer.from(screenshot.dataUrl.slice('data:image/png;base64,'.length), 'base64'))
      const console = await read('console'), traffic = await network()
      const layout = await readDOM(() => ({ title: document.title, url: location.href,
        width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight, activeElement: document.activeElement?.outerHTML?.slice(0, 500) }))
      const evidence = { identity, label, at: Date.now(), imagePath, screenshot: { ...screenshot, dataUrl: undefined }, layout,
        console, network: traffic, newConsole: (console?.entries || []).filter(entry => !consoleBefore.has(fingerprint(entry))),
        newNetwork: traffic.entries.filter(entry => !networkBefore.has(fingerprint(entry))), operations: [...operations], baselinePath }
      const metadataPath = artifact?.(basename + '.json', evidence)
      captures.push({ label, imagePath, metadataPath })
      return { ...evidence, metadataPath }
    }

    const handle = {
      identity, originalViewport, originalZoom, operations, captures, readDOM, setViewport, capture,
      activate: () => reveal(mode, initial.tabId),
      // Explicit pointer attempts on disabled board cells help assert that an
      // occupied/ended move leaves state unchanged; they never force DOM events.
      click: (selector, { allowDisabled = false } = {}) => perform('click', { selector, allowDisabled }),
      key: (key, { modifiers = [] } = {}) => perform('key', {
        key: ({ ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space' })[key] || key,
        modifiers }),
      scroll: (deltaY, { deltaX = 0, x, y } = {}) => perform('scroll', { deltaY, deltaX, x, y }),
      async reload() {
        await assertIdle()
        const before = await identify({ visible: true })
        await page.evaluate(tabId => window.aether.browser.action({ tabId, action: 'reload' }), initial.tabId)
        await until(() => identify({ visible: true }), value =>
          value.tab.navigationId !== before.tab.navigationId && !value.tab.loading, 'Native page reload')
        await until(() => readDOM(() => document.readyState), value => value === 'complete', 'Reloaded DOM readiness')
        operations.push({ at: Date.now(), type: 'browser-api-reload' })
      },
      async fill(selector, text) {
        if (typeof text !== 'string' || text.length > 100_000) throw new Error('Invalid native text input')
        const editable = await readDOM(selector => {
          const element = document.querySelector(selector)
          return !!element && !element.matches(':disabled,[readonly],[aria-disabled="true"]') &&
            (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && !['file', 'hidden', 'checkbox', 'radio', 'button', 'submit'].includes(element.type) || element.isContentEditable)
        }, selector)
        if (!editable) throw new Error('Fill target is not an editable field')
        await perform('click', { selector })
        await perform('key', { key: 'A', modifiers: ['control'] })
        const focused = await readDOM(selector => document.activeElement === document.querySelector(selector), selector)
        if (!focused) throw new Error('Native text target did not receive focus')
        return perform('text', { text })
      },
      async restore() {
        if (restored) return
        await reveal(mode, initial.tabId)
        await assertIdle(true)
        await identify({ visible: true })
        await page.evaluate(input => window.aether.browser.action({ tabId: input.tabId, action: 'viewport', viewport: input.viewport }),
          { tabId: initial.tabId, viewport: originalViewport })
        await page.evaluate(input => window.aether.browser.action({ tabId: input.tabId, action: 'zoom', zoomFactor: input.zoom }),
          { tabId: initial.tabId, zoom: originalZoom })
        restored = true
        operations.push({ at: Date.now(), type: 'restore-viewport', viewport: originalViewport, zoomFactor: originalZoom })
      }
    }
    handles.set(handleKey, handle)
    log('native-audit-open', identity)
    return handle
  }

  return { open, assertIdle, viewports: AUDIT_VIEWPORTS,
    async restore() {
      const errors = []
      for (const handle of [...handles.values()].reverse()) {
        try { await handle.restore() } catch (error) { errors.push(`${handle.identity.mode}: ${error.message}`) }
      }
      if (errors.length) throw new Error('Native viewport restoration failed: ' + errors.join('; '))
    } }
}
