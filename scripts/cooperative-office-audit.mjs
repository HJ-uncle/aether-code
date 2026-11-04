/** Audit the running acceptance window. No launch, model call, or workspace writes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { expect } from '@playwright/test'

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const native = new Set(['.docx', '.xlsx', '.pptx', '.pdf'])
const twoFrames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
const visiblePanel = page => page.locator('#mode-work .work-resource-file:not([hidden]) .work-artifact-panel-v2[data-document-active="true"]:visible')
const visiblePreview = page => visiblePanel(page).locator('.document-preview')
const kindOf = path => extname(path).toLowerCase()

// CF_UNICODETEXT on Windows normalizes LF to CRLF; preserve every other byte
// of the decoded text when comparing actual clipboard contents.
export const normalizeClipboardText = text => text.replace(/\r\n/g, '\n')

export function resolveOfficeFiles(input, manifest) {
  const source = input.files !== undefined ? input.files : manifest?.files
    ? Object.values(manifest.files) : Object.keys(manifest?.documents?.current ?? {})
  assert.ok(Array.isArray(source), 'Office files must be an array')
  assert.ok(source.every(path => typeof path === 'string' && path.trim()), 'Office file entries must be nonempty paths')
  const files = [...new Set(input.files !== undefined ? source : source.filter(path => /^product[\\/]/.test(path)))]
  assert.ok(files.length && files.length <= 32, 'Office audit requires 1–32 product files')
  return files
}

export function officeCapacityPlan(fileCount, capacities = [1, 5, 10]) {
  assert.ok(Array.isArray(capacities) && capacities.length && capacities.every((n, i) => Number.isInteger(n) && n > 0 && n <= 32 && (!i || n > capacities[i - 1])), 'Capacities must be increasing integers within 1–32')
  return capacities.map(capacity => ({ capacity, available: capacity <= fileCount }))
}

// One failed action must not hide unrelated controls. Cancellation still exits
// the audit instead of being downgraded to an ordinary failed button.
export async function runOfficeControl({ guard, report, path, action, operation, capture, save }) {
  const result = { path, action, status: 'running' }
  report.controls.push(result)
  try { await guard.check(); await operation(result); if (result.status === 'running') result.status = 'passed' }
  catch (error) { await guard.check(); result.status = 'failed'; result.error = error.message; report.errors.push({ path, action, message: error.message }) }
  if (capture) {
    try { result.screenshot = await capture() }
    catch (error) { await guard.check(); result.screenshotError = error.message; report.errors.push({ path, action, message: 'Screenshot: ' + error.message }) }
  }
  save?.()
  return result
}

const fileTabs = page => page.locator('#mode-work .work-workspace__tab--resource').filter({ has: page.locator('button[aria-label^="关闭文档 "]') }).locator('[role="tab"]')

// Readiness and the timing stop both run in the renderer. Driver-side identity
// checks deliberately happen outside this clock and may finish much later.
async function installMeasurement(page, sessionId) {
  await page.evaluate(sessionId => {
    window.__cooperativeOfficeMeasure = target => {
      cancelAnimationFrame(window.__cooperativeOfficeMeasureFrame)
      const sample = { target, sessionId, startedAt: performance.now(), readyAt: null, finishedAt: null, ms: null, error: null, stableFrames: 0 }
      window.__cooperativeOfficeMeasurement = sample
      window.__cooperativeOfficeLongTasks = []
      let identitySeen = false
      const intersects = (element, viewport) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom && box.right > viewport.left && box.left < viewport.right
      }
      const readable = () => {
        if (document.querySelector('#mode-work')?.getAttribute('aria-hidden') !== 'false') throw new Error('AUDIT_MODE_CHANGED')
        const tab = document.getElementById('work-resource-tab-' + encodeURIComponent(target.resourceId))
        const panels = [...document.querySelectorAll('#mode-work .work-resource-file:not([hidden]) .work-artifact-panel-v2[data-document-active="true"]')]
          .filter(element => element.getClientRects().length)
        const panel = panels.length === 1 ? panels[0] : null
        const bound = tab?.getAttribute('aria-selected') === 'true' && panel?.dataset.documentSession === sessionId &&
          [target.name, target.path].includes(panel?.dataset.documentPath)
        if (!bound) { if (identitySeen) throw new Error('AUDIT_TARGET_CHANGED'); return false }
        identitySeen = true
        const preview = panel.querySelector('.document-preview')
        const error = panel.querySelector('.work-artifact-preview [role="alert"]')
        if (error) throw new Error('DOCUMENT_ERROR: ' + error.textContent)
        if (panel.dataset.fileReadStatus !== 'current') return false
        if (!['.docx', '.pptx', '.pdf', '.xlsx'].includes(target.kind)) return Boolean(panel.querySelector('.work-artifact-preview')?.textContent.trim())
        if (!preview) return false
        const body = preview.querySelector('.document-preview__body')
        if (!body) return false
        const viewport = body.getBoundingClientRect()
        if (target.kind === '.xlsx') {
          const cells = [...body.querySelectorAll('tbody tr:not([aria-hidden="true"]) td:not([aria-hidden="true"])')].filter(cell => intersects(cell, viewport))
          return cells.length > 0 && cells.every(cell => cell.hasAttribute('title')) && cells.some(cell => cell.textContent.trim())
        }
        const pages = [...body.querySelectorAll('[data-document-page]')].filter(item => intersects(item, viewport))
        return pages.length > 0 && pages.every(item => {
          if (target.kind === '.pdf') {
            const canvas = item.querySelector('canvas')
            return canvas?.dataset.renderedPage === item.dataset.documentPage && canvas.width > 0 && canvas.height > 0
          }
          const doc = item.querySelector('iframe')?.contentDocument
          const content = doc?.querySelector('section.docx, .slide-container')
          return content?.getBoundingClientRect().height > 0 && [...doc.images].every(image => image.complete && image.naturalWidth > 0)
        })
      }
      const tick = () => {
        if (window.__cooperativeOfficeMeasurement !== sample) return
        try {
          if (performance.now() - sample.startedAt > 65000) throw new Error('DOCUMENT_READY_TIMEOUT')
          if (readable()) {
            if (sample.stableFrames++ === 0) sample.readyAt = performance.now()
            if (sample.stableFrames >= 3) { sample.finishedAt = performance.now(); sample.ms = sample.finishedAt - sample.startedAt; return }
          } else { sample.stableFrames = 0; sample.readyAt = null }
        } catch (error) { sample.error = error.message; return }
        window.__cooperativeOfficeMeasureFrame = requestAnimationFrame(tick)
      }
      window.__cooperativeOfficeMeasureFrame = requestAnimationFrame(tick)
    }
  }, sessionId)
}

// Cancel waits without letting a later loop mutate another surface. Mutations
// are awaited to completion (never raced), then checked before the next action.
export function createAuditGuard({ page, signal, cancelFile }) {
  let reason, timer, checking = false, rejectStopped
  const stopped = new Promise((_, reject) => { rejectStopped = reject })
  stopped.catch(() => {})
  const stop = error => { if (!reason) { reason = error; rejectStopped(error) } }
  const aborted = () => stop(signal.reason instanceof Error ? signal.reason : new Error('AUDIT_CANCELLED'))
  signal?.addEventListener('abort', aborted, { once: true })
  const check = async () => {
    if (signal?.aborted) aborted()
    if (cancelFile && existsSync(cancelFile)) stop(new Error('AUDIT_CANCELLED: cancellation file detected'))
    if (reason) throw reason
    const workActive = await page.evaluate(() => document.querySelector('#mode-work')?.getAttribute('aria-hidden') === 'false')
    if (!workActive) stop(new Error('AUDIT_MODE_CHANGED: Work is no longer the active surface'))
    if (reason) throw reason
  }
  return {
    check,
    async start() {
      await check()
      timer = setInterval(async () => {
        if (checking || reason) return
        checking = true
        try { await check() } catch (error) { stop(error) } finally { checking = false }
      }, 100)
      timer.unref()
    },
    async read(operation) { await check(); const value = await Promise.race([operation(), stopped]); await check(); return value },
    async action(operation) { await check(); const value = await operation(); await check(); return value },
    dispose() { clearInterval(timer); signal?.removeEventListener('abort', aborted) }
  }
}

export function verifiedFileIdentity(path, expected, actual, sessionId) {
  assert.equal(actual.name, basename(path), 'Imported File name differs from source')
  assert.equal(actual.size, expected.size, 'Imported File size differs from source')
  assert.equal(actual.sha256, expected.sha256, 'Imported File bytes differ from source')
  assert.ok(Number.isSafeInteger(actual.lastModified) && actual.lastModified >= 0, 'Imported File has invalid modification time')
  const resourceId = `external:${actual.name.toLowerCase()}:${actual.size}:${actual.lastModified}`
  return { path, ...actual, sessionId, resourceId, tabId: `work-resource-tab-${encodeURIComponent(resourceId)}` }
}

const resourceTab = (page, identity) => page.locator(`#mode-work [id=${JSON.stringify(identity.tabId)}]`)

// offsetTop is relative to offsetParent, which may be the app rather than the
// scroll body. Rect differences plus current scroll stay in one coordinate space.
const pageGeometry = item => item.evaluate(element => {
  const body = element.closest('.document-preview__body'), box = element.getBoundingClientRect(), viewport = body.getBoundingClientRect()
  const innerTop = viewport.top + body.clientTop, innerBottom = innerTop + body.clientHeight
  return { top: body.scrollTop + box.top - innerTop, height: box.height, viewHeight: body.clientHeight,
    scrollTop: body.scrollTop, maxTop: Math.max(0, body.scrollHeight - body.clientHeight),
    visibleStart: Math.max(0, innerTop - box.top), visibleEnd: Math.min(box.height, innerBottom - box.top) }
})

export function assertCovered(intervals, length) {
  assert.ok(length > 0 && intervals.length, 'No visible page coverage')
  let end = 0
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    assert.ok(interval.end > interval.start && interval.start <= end + 2, 'Page screenshot coverage has a gap')
    end = Math.max(end, interval.end)
  }
  assert.ok(end >= length - 2, `Page screenshot coverage stopped at ${end} of ${length}`)
}

function targetFile(state, relative) {
  const path = resolve(state.workspace, relative)
  assert.ok(path.toLowerCase().startsWith(resolve(state.workspace).toLowerCase() + sep), 'File outside acceptance workspace')
  assert.ok(existsSync(path), 'File missing: ' + relative)
  return path
}

async function ready(page, path, identity, guard) {
  return guard.read(async () => {
  assert.ok(identity, 'File must have a verified import identity')
  const tab = resourceTab(page, identity)
  await expect(tab).toHaveCount(1)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(tab).toHaveAttribute('title', identity.name)
  await expect(tab).toHaveText(identity.name)
  const panel = visiblePanel(page)
  await expect(panel).toHaveCount(1, { timeout: 65000 })
  await expect(panel).toBeVisible({ timeout: 65000 })
  await expect(panel).toHaveAttribute('data-document-session', identity.sessionId)
  await expect.poll(async () => [identity.name, path].includes(await panel.getAttribute('data-document-path')), { timeout: 65000 }).toBe(true)
  identity.panelPath = await panel.getAttribute('data-document-path')
  await expect(panel).toHaveAttribute('data-file-read-status', 'current', { timeout: 65000 })
  if (native.has(kindOf(path))) {
    await expect.poll(() => visiblePreview(page).evaluate(element => {
      const error = element.querySelector('[role="alert"]')
      if (error) return 'error:' + error.textContent
      const kind = element.dataset.documentPreview
      if (kind === 'xlsx') return [...element.querySelectorAll('td[title]')].some(cell => cell.textContent.trim()) ? 'ready' : 'waiting'
      if (kind === 'pdf') return [...element.querySelectorAll('canvas[data-rendered-page]')].some(canvas => Number(canvas.dataset.renderedPage) > 0 && canvas.width && canvas.height) ? 'ready' : 'waiting'
      const doc = element.querySelector('iframe')?.contentDocument
      return doc?.querySelector('section.docx, .slide-container') && [...doc.images].every(image => image.complete && image.naturalWidth) ? 'ready' : 'waiting'
    }), { timeout: 65000 }).toBe('ready')
  } else {
    await expect(panel.locator('.work-artifact-preview [role="alert"]')).toHaveCount(0)
    await expect(panel.locator('.work-artifact-preview')).not.toBeEmpty()
  }
  await twoFrames(page)
  })
}

async function showWorkspace(page, guard) {
  const open = page.locator('#mode-work').getByRole('button', { name: '打开工作区', exact: true })
  if (await open.isVisible()) await guard.action(() => open.click({ timeout: 3000 }))
  await guard.read(() => expect(page.locator('#mode-work input.work-resource-tabs__file-input')).toBeAttached())
}

async function openFile(page, path, expected, sessionId, guard) {
  await showWorkspace(page, guard)
  const input = page.locator('#mode-work input.work-resource-tabs__file-input')
  // React clears input.files in its change handler; capture the actual File
  // first, then hash those exact bytes asynchronously without changing it.
  await guard.action(() => input.evaluate(element => {
    window.__cooperativeOfficeImported = null
    element.addEventListener('change', () => {
      const file = element.files?.[0]
      if (file) window.__cooperativeOfficeMeasure({ resourceId: `external:${file.name.toLowerCase()}:${file.size}:${file.lastModified}`,
        name: file.name, path: file.name, kind: '.' + file.name.split('.').pop().toLowerCase() })
      window.__cooperativeOfficeImported = file ? file.arrayBuffer().then(async bytes => ({ name: file.name, size: file.size,
        lastModified: file.lastModified, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('') })) : null
    }, { capture: true, once: true })
  }))
  await guard.action(() => input.setInputFiles(path, { timeout: 3000 }))
  const actual = await guard.read(() => page.evaluate(() => window.__cooperativeOfficeImported))
  assert.ok(actual, 'Input change observer did not capture the imported File')
  const identity = verifiedFileIdentity(path, expected, actual, sessionId)
  await ready(page, path, identity, guard)
  return identity
}

async function metrics(page, guard) {
  await guard.read(() => expect.poll(() => page.evaluate(() => {
    const sample = window.__cooperativeOfficeMeasurement
    return Boolean(sample?.finishedAt || sample?.error)
  }), { timeout: 65000 }).toBe(true))
  const value = await page.evaluate(() => ({ ...window.__cooperativeOfficeMeasurement,
    longTasks: (window.__cooperativeOfficeLongTasks ?? []).filter(item => item.startTime >= window.__cooperativeOfficeMeasurement.startedAt &&
      item.startTime <= window.__cooperativeOfficeMeasurement.finishedAt).map(item => item.duration),
    retainedPreviews: document.querySelectorAll('.document-preview').length,
    retainedFrames: document.querySelectorAll('.document-preview iframe').length,
    heapBytes: performance.memory?.usedJSHeapSize ?? null }))
  assert.equal(value.error, null, 'Renderer timing failed: ' + value.error)
  assert.ok(Number.isFinite(value.ms) && value.finishedAt >= value.startedAt, 'Renderer has not recorded a completed readiness measurement')
  return value
}

export async function auditOffice(context, input = {}) {
  const { page, app, state, select, artifact } = context
  context.signal?.throwIfAborted()
  await select('product')
  const guard = createAuditGuard(context), identities = new Map()
  const files = resolveOfficeFiles(input, input.files !== undefined ? null : JSON.parse(readFileSync(join(state.workspace, 'handoff/product-ready.json'), 'utf8')))
  const paths = files.map(file => targetFile(state, file))
  const originals = paths.map(path => { const bytes = readFileSync(path); return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  const phase = input.phase || 'timing'
  assert.ok(['timing', 'pages', 'controls'].includes(phase), 'Unknown office audit phase')
  const prefix = `office-ui/${new Date().toISOString().replace(/[:.]/g, '-')}-${phase}`
  const directory = join(state.evidence, prefix); mkdirSync(directory, { recursive: true })
  const report = { at: new Date().toISOString(), phase, round: state.round, workspace: state.workspace,
    boundary: 'Real Electron DOM/IPC automation; renderer change/click capture to exact bound visible content readable plus two subsequent rAF frames. Driver checks and File hashing completion are outside the timing stop. Not OS presentation timing or native desktop input. Screenshots require separate visual review.',
    files: originals, imports: [], status: 'running', samples: [], capacities: [], pages: [], controls: [], errors: [] }
  const ownedTabs = new Set(), originalTabs = new Set()
  const save = () => artifact(`${prefix}/report.json`, report)
  const capture = async name => guard.read(async () => { const path = join(directory, name + '.png'); await page.screenshot({ path }); return path })
  const open = async path => {
    const before = new Set(await fileTabs(page).evaluateAll(tabs => tabs.map(tab => tab.id)))
    const identity = await openFile(page, path, originals.find(file => file.path === path), state.roles.product.sessionId, guard)
    if (!before.has(identity.tabId) && !originalTabs.has(identity.tabId)) ownedTabs.add(identity.tabId)
    identities.set(path, identity); report.imports.push(identity); return identity
  }
  const waitReady = path => ready(page, path, identities.get(path), guard)
  const onError = error => report.errors.push({ scope: 'renderer', message: error.message })
  page.on('pageerror', onError)
  try {
  await guard.start()
  await showWorkspace(page, guard)
  report.originalTabs = await fileTabs(page).evaluateAll(tabs => tabs.map(tab => ({ id: tab.id, title: tab.title })))
  for (const tab of report.originalTabs) originalTabs.add(tab.id)
  await guard.action(() => installMeasurement(page, state.roles.product.sessionId))
  await guard.action(() => page.evaluate(() => {
    window.__cooperativeOfficeObserver?.disconnect()
    window.__cooperativeOfficeLongTasks = []
    window.__cooperativeOfficeObserver = new PerformanceObserver(list => window.__cooperativeOfficeLongTasks.push(...list.getEntries().map(item => ({ startTime: item.startTime, duration: item.duration }))))
    window.__cooperativeOfficeObserver.observe({ type: 'longtask' })
  }))
    if (phase === 'timing') {
      assert.equal(originalTabs.size, 0, 'Exact 1/5/10 capacity timing requires a session with no pre-existing document tabs; original tabs will not be closed')
      let imported = 0
      for (const stage of officeCapacityPlan(paths.length, input.capacities)) {
        const capacity = { ...stage, status: 'running', sampleStart: report.samples.length }
        report.capacities.push(capacity)
        if (!stage.available) { capacity.status = 'not-covered'; capacity.reason = 'Insufficient distinct input files'; report.errors.push({ scope: 'capacity', capacity: stage.capacity, message: capacity.reason }); continue }
        for (let index = imported; index < stage.capacity; index++) {
        const path = paths[index]
        await guard.check()
        const openIds = await page.locator('#mode-work .work-workspace__tab-button').evaluateAll(tabs => tabs.map(tab => tab.id))
        try { const identity = await open(path); report.samples.push({ path, resourceId: identity.resourceId, kind: openIds.includes(identity.tabId) ? 'reopen' : 'first-open-in-window', targetCapacity: stage.capacity, openCount: await fileTabs(page).count(), ...(await metrics(page, guard)) }) }
        catch (error) { await guard.check(); report.samples.push({ path, error: error.message }); report.errors.push({ path, message: error.message }); await capture(`open-failure-${index}`) }
        save()
      }
      imported = stage.capacity
      capacity.openCount = await fileTabs(page).count()
      if (capacity.openCount !== stage.capacity) { capacity.status = 'failed'; report.errors.push({ scope: 'capacity', capacity: stage.capacity, message: `Expected ${stage.capacity} file tabs, observed ${capacity.openCount}` }); continue }
      for (let tour = 1; tour <= 3; tour++) for (const [index, path] of paths.slice(0, stage.capacity).entries()) {
        await guard.check()
        try {
          const identity = identities.get(path)
          assert.ok(identity, 'Cannot switch to a file whose imported bytes were not verified')
          const tab = resourceTab(page, identity)
          const reactivation = await tab.getAttribute('aria-selected') === 'true'
          await guard.action(() => tab.evaluate((element, target) => element.addEventListener('click', () => window.__cooperativeOfficeMeasure(target), { capture: true, once: true }),
            { resourceId: identity.resourceId, path: identity.path, name: identity.name, kind: kindOf(path) }))
          await guard.action(() => tab.click({ timeout: 3000 })); await waitReady(path)
          const openCount = await fileTabs(page).count()
          assert.equal(openCount, stage.capacity, 'File capacity changed during sampling')
          report.samples.push({ path, kind: reactivation ? 'reactivation' : 'tab-switch', tour, targetCapacity: stage.capacity, openCount, ...(await metrics(page, guard)) })
        } catch (error) { await guard.check(); capacity.status = 'failed'; report.errors.push({ path, tour, capacity: stage.capacity, message: error.message }); await capture(`switch-failure-${stage.capacity}-${tour}-${index}`) }
      }
      capacity.sampleEnd = report.samples.length
      if (capacity.status === 'running') capacity.status = 'completed'
      save()
      }
    }
    if (phase === 'pages') for (const [index, path] of paths.entries()) {
      await guard.check()
      try {
        await open(path)
        const preview = visiblePreview(page)
        if (kindOf(path) === '.xlsx') {
          const tabs = preview.getByRole('tab')
          for (let sheet = 0; sheet < await tabs.count(); sheet++) {
            await guard.action(() => tabs.nth(sheet).click({ timeout: 3000 })); await waitReady(path)
            const body = preview.locator('.document-preview__body--sheet')
            await guard.read(() => expect(tabs.nth(sheet)).toHaveAttribute('aria-selected', 'true'))
            await guard.read(() => expect(body).toHaveAttribute('data-document-sheet', String(sheet)))
            const dimensions = await body.evaluate(element => ({ height: element.scrollHeight, width: element.scrollWidth, viewHeight: element.clientHeight, viewWidth: element.clientWidth }))
            for (let top = 0, tile = 0; top < dimensions.height; top += Math.max(100, dimensions.viewHeight - 50), tile++) {
              for (let left = 0, col = 0; left < dimensions.width; left += Math.max(100, dimensions.viewWidth - 80), col++) {
                await guard.action(() => body.evaluate((element, point) => element.scrollTo(point), { top, left })); await guard.read(() => twoFrames(page))
                let viewport
                await guard.read(() => expect.poll(async () => {
                  viewport = await body.evaluate(element => {
                    const box = element.getBoundingClientRect()
                    const cells = [...element.querySelectorAll('tbody tr:not([aria-hidden="true"]) td:not([aria-hidden="true"])')].filter(cell => {
                      const rect = cell.getBoundingClientRect()
                      return rect.bottom > box.top + 30 && rect.top < box.bottom && rect.right > box.left + 52 && rect.left < box.right
                    })
                    return { top: element.scrollTop, left: element.scrollLeft, rowStart: element.dataset.documentRowStart,
                      cells: cells.map(cell => ({ row: cell.parentElement.querySelector('th')?.textContent, text: cell.textContent, loaded: cell.hasAttribute('title') })) }
                  })
                  return viewport.cells.length > 0 && viewport.cells.every(cell => cell.loaded)
                }, { timeout: 65000 }).toBe(true))
                assert.ok(Math.abs(viewport.top - Math.min(top, dimensions.height - dimensions.viewHeight)) < 2, 'Sheet vertical scroll did not reach requested offset')
                assert.ok(Math.abs(viewport.left - Math.min(left, dimensions.width - dimensions.viewWidth)) < 2, 'Sheet horizontal scroll did not reach requested offset')
                report.pages.push({ path, sheet, tile, col, requested: { top, left }, viewport,
                  screenshot: await capture(`${index}-sheet-${sheet}-${tile}-${col}`) })
              }
            }
          }
        } else if (native.has(kindOf(path))) {
          const body = preview.locator('.document-preview__body--continuous')
          await guard.read(() => twoFrames(page))
          const count = Number(await body.getAttribute('data-document-pages'))
          assert.ok(Number.isSafeInteger(count) && count > 0, 'Native preview reported no pages')
          const expectedCount = input.expectedPages?.[files[index]]
          if (expectedCount !== undefined) assert.equal(count, expectedCount, 'Preview page count differs from independent expected count')
          for (let number = 1; number <= count; number++) {
            await guard.check()
            const item = body.locator(`[data-document-page="${number}"]`)
            await guard.action(() => item.scrollIntoViewIfNeeded({ timeout: 3000 }))
            if (kindOf(path) === '.pdf') await guard.read(() => expect(item.locator('canvas')).toHaveAttribute('data-rendered-page', String(number), { timeout: 65000 }))
            else await guard.read(() => expect.poll(() => item.locator('iframe').evaluateAll(frames => frames.length === 1 && frames.every(frame => {
              const doc = frame.contentDocument, main = doc?.querySelector('main.document-page')
              return main && main.getBoundingClientRect().height > 0 && [...doc.images].every(image => image.complete && image.naturalWidth)
            })), { timeout: 65000 }).toBe(true))
            await guard.read(() => twoFrames(page))
            // Fit-width PDF pages resize when the continuous scroll bar appears.
            // Measure after layout settles; never compare screenshots with the
            // pre-resize page height.
            let previousSize = '', stableSizeSamples = 0
            await guard.read(() => expect.poll(async () => {
              const geometry = await pageGeometry(item)
              const size = `${geometry.height}:${geometry.viewHeight}`
              stableSizeSamples = size === previousSize ? stableSizeSamples + 1 : 0
              previousSize = size
              return stableSizeSamples
            }, { timeout: 5000, intervals: [100, 100, 100, 250] }).toBeGreaterThanOrEqual(2))
            const dimensions = await pageGeometry(item), coverage = []
            for (let tile = 0, offset = 0; offset < dimensions.height; offset += Math.max(100, dimensions.viewHeight - 60), tile++) {
              await guard.action(() => body.evaluate((element, point) => { element.scrollTop = point }, dimensions.top + offset))
              await guard.read(() => twoFrames(page))
              const actual = await pageGeometry(item)
              assert.ok(Math.abs(actual.height - dimensions.height) < 2, 'Page resized during screenshot coverage; repeat with stable layout')
              assert.ok(Math.abs(actual.scrollTop - Math.min(dimensions.top + offset, actual.maxTop)) < 2, 'Page scroll did not reach requested offset')
              assert.ok(actual.visibleEnd > actual.visibleStart, 'Screenshot target page is outside the viewport')
              coverage.push({ start: actual.visibleStart, end: actual.visibleEnd })
              report.pages.push({ path, page: number, tile, actual, screenshot: await capture(`${index}-page-${number}-${tile}`) })
            }
            assertCovered(coverage, dimensions.height)
            if (kindOf(path) === '.pptx') {
              await guard.action(() => body.evaluate((element, point) => { element.scrollTop = point }, dimensions.top)); await guard.read(() => twoFrames(page))
              const notes = preview.locator('summary')
              if (await notes.count()) {
                await guard.read(() => expect(notes).toHaveText(`备注 · 第 ${number} 页`))
                await guard.action(() => notes.click({ timeout: 3000 }))
                const content = preview.locator('.document-preview__notes-content')
                await guard.read(() => expect(content).toHaveAttribute('data-presentation-notes', String(number)))
                report.pages.push({ path, page: number, notes: await content.innerText(), screenshot: await capture(`${index}-notes-${number}`) }); await guard.action(() => notes.click({ timeout: 3000 }))
              }
            }
          }
          await guard.read(() => twoFrames(page))
          assert.equal(Number(await body.getAttribute('data-document-pages')), count, 'Page count changed during audit; repeat after document finished loading')
          report.pages.push({ path, observedPageCount: count, independentExpectedPageCount: expectedCount ?? null, completenessIndependentlyVerified: expectedCount !== undefined })
        } else report.pages.push({ path, screenshot: await capture(`${index}-text`), displayedText: await visiblePanel(page).locator('.work-artifact-preview').innerText() })
      } catch (error) { await guard.check(); report.errors.push({ path, message: error.message }); await capture(`pages-failure-${index}`) }
      save()
    }
    if (phase === 'controls') for (const [index, path] of paths.entries()) {
      await guard.check()
      let actionIndex = 0
      const control = (action, operation) => runOfficeControl({ guard, report, path, action, operation, save,
        capture: () => capture(`${index}-${actionIndex++}-${action}`) })
      const imported = await control('open', async () => { await open(path) })
      if (imported.status !== 'passed') continue
      const panel = visiblePanel(page)
      await control('inventory', async result => {
        result.buttons = await panel.locator('button:visible').evaluateAll(elements => elements.map(element => ({ text: element.textContent, label: element.getAttribute('aria-label'), disabled: element.disabled })))
      })
      await control('copy', async result => {
        const button = panel.getByRole('button', { name: /^复制(?:片段|回执)?$/, exact: true })
        if (await button.isDisabled()) { result.status = 'disabled'; result.reason = 'Binary preview exposes no copyable text'; return }
        const expected = new TextDecoder().decode(readFileSync(path)).replace(/^\uFEFF/, '')
        const previous = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), formats: clipboard.availableFormats().map(format => ({ format, bytes: clipboard.readBuffer(format).toString('base64') })) }))
        try {
          await guard.action(() => button.click({ timeout: 3000 }))
          await guard.read(() => expect.poll(async () => normalizeClipboardText(await app.evaluate(({ clipboard }) => clipboard.readText()))).toBe(normalizeClipboardText(expected)))
          const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
          result.characters = expected.length
          result.sha256 = createHash('sha256').update(expected).digest('hex')
          result.clipboardSha256 = createHash('sha256').update(copied).digest('hex')
          result.nativeLineEndingConversion = copied !== expected
        } finally {
          result.clipboardRestored = await app.evaluate(({ clipboard }, data) => {
            if (clipboard.readText().replace(/\r\n/g, '\n') !== data.expected.replace(/\r\n/g, '\n')) return false
            clipboard.clear()
            for (const item of data.previous.formats) clipboard.writeBuffer(item.format, Buffer.from(item.bytes, 'base64'))
            return true
          }, { expected, previous })
        }
      })
      await control('save', async result => {
        const button = panel.getByRole('button', { name: /^保存(?:原文件|副本|预览片段|历史回执)$/, exact: true })
        if (await button.isDisabled()) { result.status = 'disabled'; return }
        const destination = join(directory, 'downloads', String(index), basename(path))
        mkdirSync(join(directory, 'downloads', String(index)), { recursive: true })
        result.destination = destination
        await saveOfficeDownload({ page, app, guard, button, destination, expectedName: basename(path) }, result)
        const source = originals.find(file => file.path === path)
        result.sourceSha256 = source.sha256
        result.sha256 = hash(destination)
        result.size = readFileSync(destination).length
        assert.equal(result.sha256, source.sha256, 'Saved file differs from original bytes')
      })
      const zoom = panel.getByRole('combobox', { name: '缩放', exact: true })
      if (await zoom.count()) {
        const initial = await zoom.inputValue(), geometry = []
        for (const value of await zoom.locator('option').evaluateAll(options => options.map(option => option.value))) {
          await control('zoom-' + value, async result => {
            await guard.action(() => zoom.selectOption(value, { timeout: 3000 })); await waitReady(path)
            assert.equal(await zoom.inputValue(), value)
            result.geometry = await previewGeometry(panel)
            assert.ok(result.geometry.width > 0 && result.geometry.height > 0, 'Zoom left no measurable rendered page')
            geometry.push({ value, ...result.geometry })
          })
        }
        await control('zoom-restore', async result => {
          await guard.action(() => zoom.selectOption(initial, { timeout: 3000 })); await waitReady(path)
          result.geometry = geometry
          const explicit = geometry.filter(item => Number(item.value) > 0)
          assert.ok(new Set(explicit.map(item => Math.round(item.width))).size > 1, 'Zoom option changed but page width did not')
        })
      }
      await control('refresh', async () => {
        await guard.action(() => panel.getByRole('button', { name: '刷新成果预览', exact: true }).click({ timeout: 3000 })); await waitReady(path)
      })
      if (kindOf(path) === '.xlsx') {
        const tabs = visiblePreview(page).getByRole('tab')
        for (let sheet = 0; sheet < await tabs.count(); sheet++) await control('sheet-' + sheet, async result => {
          result.name = await tabs.nth(sheet).innerText()
          await guard.action(() => tabs.nth(sheet).click({ timeout: 3000 })); await waitReady(path)
          await guard.read(() => expect(tabs.nth(sheet)).toHaveAttribute('aria-selected', 'true'))
          const body = visiblePreview(page).locator('.document-preview__body--sheet')
          await guard.read(() => expect(body).toHaveAttribute('data-document-sheet', String(sheet)))
          result.cells = await body.locator('td[title]').allTextContents()
        })
      }
      if (kindOf(path) === '.pptx') {
        const body = visiblePreview(page).locator('.document-preview__body--continuous')
        const count = Number(await body.getAttribute('data-document-pages'))
        for (let number = 1; number <= count; number++) await control('notes-' + number, async result => {
          const item = body.locator(`[data-document-page="${number}"]`)
          await guard.action(() => item.scrollIntoViewIfNeeded({ timeout: 3000 }))
          const dimensions = await pageGeometry(item)
          await guard.action(() => body.evaluate((element, top) => { element.scrollTop = top }, dimensions.top))
          await guard.read(() => twoFrames(page))
          const summary = visiblePreview(page).locator('summary')
          if (!await summary.count()) { result.status = 'absent'; result.reason = 'No notes control on this slide'; return }
          await guard.read(() => expect(summary).toHaveText(`备注 · 第 ${number} 页`))
          const details = visiblePreview(page).locator('details.document-preview__notes')
          const wasOpen = await details.evaluate(element => element.open)
          if (!wasOpen) await guard.action(() => summary.click({ timeout: 3000 }))
          try {
            const content = visiblePreview(page).locator('.document-preview__notes-content')
            await guard.read(() => expect(content).toBeVisible())
            await guard.read(() => expect(content).toHaveAttribute('data-presentation-notes', String(number)))
            result.notes = await content.innerText()
            result.expandedScreenshot = await capture(`${index}-notes-${number}-expanded`)
          } finally {
            if (!wasOpen && await details.evaluate(element => element.open)) await guard.action(() => summary.click({ timeout: 3000 }))
          }
        })
      }
      await control('select-and-quote', async result => {
        const composer = page.locator('#mode-work .input-composer__input[role="textbox"]:visible').first()
        assert.equal((await composer.innerText()).trim(), '', 'Refusing to overwrite user draft')
        await selectOfficeText(page, panel, path, guard, result)
        save() // Preserve pointer geometry and selection even when quoting fails.
        assert.ok(result.selection?.text?.trim(), 'Real pointer gesture did not produce a selection inside this preview')
        const button = panel.getByRole('button', { name: '引用选中内容', exact: true })
        await guard.read(() => expect(button).toBeVisible())
        const expected = `引用「${basename(path)}」文件预览中的选中内容（${identities.get(path).panelPath}）：\n${result.selection.text.trim().split('\n').map(line => '> ' + line).join('\n')}`
        let ownedDraft = null
        try {
          await guard.action(() => button.click({ timeout: 3000 }))
          ownedDraft = await composer.innerText(); result.draft = ownedDraft
          await guard.read(() => expect.poll(async () => (await composer.innerText()).replace(/\r/g, '').trim()).toBe(expected))
        } finally {
          if (ownedDraft !== null && await composer.innerText() === ownedDraft) await guard.action(() => composer.fill('', { timeout: 3000 }))
        }
      })
      if (kindOf(path) === '.md') for (const name of ['MD', '预览']) await control('mode-' + (name === 'MD' ? 'source' : 'preview'), async () => {
        const button = panel.getByRole('button', { name, exact: true })
        await guard.action(() => button.click({ timeout: 3000 }))
        await guard.read(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
        await waitReady(path)
      })
      await control('context-menu', async result => {
        await guard.action(() => panel.click({ button: 'right', position: { x: 5, y: 5 }, timeout: 3000 }))
        result.menu = await page.getByRole('menu').allTextContents()
        result.effect = result.menu.length ? 'menu-visible' : 'no-DOM-menu'
        result.openScreenshot = await capture(`${index}-context-menu-open`)
        await guard.action(() => page.keyboard.press('Escape'))
      })
      save()
    }
    await guard.check()
    report.auditCreatedTabs = [...ownedTabs]
    if (input.closeAuditTabs === true) {
      report.closedAuditTabs = []
      for (const id of ownedTabs) {
        assert.ok(!originalTabs.has(id), 'Refusing to close a pre-existing tab')
        const tab = page.locator(`#mode-work [id=${JSON.stringify(id)}]`)
        if (!await tab.count()) continue
        await guard.action(() => tab.locator('..').getByRole('button', { name: /^关闭文档 / }).click({ timeout: 3000 }))
        await guard.read(() => expect(tab).toHaveCount(0))
        report.closedAuditTabs.push(id)
      }
    }
    report.metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ type: item.type, memory: item.memory })))
    report.originalsUnchanged = originals.every(file => hash(file.path) === file.sha256)
    assert.ok(report.originalsUnchanged, 'Audit detected changed source documents')
    report.status = report.errors.length ? 'failed' : 'completed'
  } catch (error) {
    report.status = error.message.startsWith('AUDIT_CANCELLED') ? 'cancelled' : error.message.startsWith('AUDIT_MODE_CHANGED') ? 'interrupted' : 'failed'
    report.errors.push({ scope: 'audit', message: error.message })
    error.message += `; report: ${join(directory, 'report.json')}`
    throw error
  } finally {
    guard.dispose()
    report.finishedAt = new Date().toISOString()
    report.originalsUnchanged = originals.every(file => existsSync(file.path) && hash(file.path) === file.sha256)
    page.off('pageerror', onError)
    await page.evaluate(() => { window.__cooperativeOfficeObserver?.disconnect(); cancelAnimationFrame(window.__cooperativeOfficeMeasureFrame) }).catch(() => {})
    save()
  }
  return { report: join(directory, 'report.json'), samples: report.samples.length, pages: report.pages.length, controls: report.controls.length, errors: report.errors }
}

async function saveOfficeDownload({ page, app, guard, button, destination, expectedName }, result) {
  const key = createHash('sha256').update(destination).digest('hex')
  await app.evaluate(({ BrowserWindow }, args) => {
    const windows = BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === args.url)
    if (windows.length !== 1) throw new Error('Cannot bind download to a unique audited window')
    const webContents = windows[0].webContents, session = webContents.session
    const record = { state: 'waiting', destination: args.destination, listener: null, item: null, session }
    globalThis.__cooperativeOfficeDownloads ??= new Map()
    globalThis.__cooperativeOfficeDownloads.set(args.key, record)
    record.listener = (_event, item, source) => {
      if (source?.id !== webContents.id || !item.getURL().startsWith('blob:') || item.getFilename() !== args.expectedName) return
      session.removeListener('will-download', record.listener)
      record.item = item; record.state = 'progressing'; record.filename = item.getFilename(); record.url = item.getURL()
      item.setSavePath(args.destination)
      item.once('done', (_event, state) => { record.state = state; record.receivedBytes = item.getReceivedBytes(); record.savePath = item.getSavePath() })
    }
    session.on('will-download', record.listener)
  }, { key, url: page.url(), destination, expectedName })
  try {
    await guard.action(() => button.click({ timeout: 3000 }))
    await guard.read(() => expect.poll(async () => {
      result.download = await app.evaluate((_electron, key) => {
        const record = globalThis.__cooperativeOfficeDownloads.get(key)
        return { state: record.state, filename: record.filename, receivedBytes: record.receivedBytes, savePath: record.savePath }
      }, key)
      return result.download.state
    }, { timeout: 20000 }).toBe('completed'))
    assert.equal(result.download.savePath, destination, 'Download escaped isolated audit directory')
    assert.ok(existsSync(destination), 'Download completed without a saved file')
  } finally {
    await app.evaluate((_electron, key) => {
      const record = globalThis.__cooperativeOfficeDownloads?.get(key)
      if (!record) return
      record.session.removeListener('will-download', record.listener)
      if (record.state === 'progressing') record.item.cancel()
      globalThis.__cooperativeOfficeDownloads.delete(key)
    }, key).catch(() => {})
  }
}

// Range is used only to read glyph rectangles, never to manufacture a selection.
// Real mouse input selects the glyph even when a wide PPT text box is centered
// or right-aligned. Parent clipping is checked before choosing an iframe point.
function measureTextGlyph(root, clip) {
  const doc = root.ownerDocument, walker = doc.createTreeWalker(root, 4)
  for (let node, visited = 0; (node = walker.nextNode()) && visited++ < 20000;) {
    if (!node.parentElement || node.parentElement.closest('script,style,button,summary,th')) continue
    const style = doc.defaultView.getComputedStyle(node.parentElement)
    if (style.visibility === 'hidden' || style.display === 'none' || style.userSelect === 'none') continue
    const match = /[\p{L}\p{N}]/u.exec(node.textContent)
    if (!match) continue
    const range = doc.createRange()
    range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length)
    for (const box of range.getClientRects()) {
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      if (box.width <= 0 || box.height <= 0 || x <= clip.left || x >= clip.right || y <= clip.top || y >= clip.bottom) continue
      const hit = doc.elementFromPoint(x, y)
      if (!hit || !(hit === node.parentElement || hit.contains(node.parentElement) || node.parentElement.contains(hit))) continue
      return { x, y, glyph: match[0], nearbyText: node.textContent.slice(0, 240), element: node.parentElement.outerHTML.slice(0, 1200), rect: { x: box.x, y: box.y, width: box.width, height: box.height } }
    }
  }
  return null
}

async function selectOfficeText(page, panel, path, guard, result) {
  const body = panel.locator('.document-preview__body')
  if (await body.count()) await guard.action(() => body.evaluate(element => element.scrollTo({ top: 0, left: 0 })))
  await guard.read(() => twoFrames(page))
  let root = panel.locator('.work-artifact-preview'), offset = { x: 0, y: 0 }
  const viewport = await root.boundingBox()
  assert.ok(viewport, 'Preview has no visible bounds')
  if (['.docx', '.pptx'].includes(kindOf(path))) {
    const frame = panel.locator('iframe').first()
    await guard.read(() => expect(frame).toBeVisible())
    const box = await frame.boundingBox()
    assert.ok(box, 'Office iframe has no bounds')
    offset = { x: box.x, y: box.y }
    root = frame.contentFrame().locator('main.document-page')
  } else if (kindOf(path) === '.pdf') {
    root = panel.locator('.document-preview__pdf-text[data-text-status="ready"], .textLayer[data-text-status="ready"]').first()
    await guard.read(() => expect(root).toBeVisible({ timeout: 15000 }))
  } else if (kindOf(path) === '.xlsx') root = panel.locator('.document-preview__body--sheet')
  const clip = { left: viewport.x - offset.x, top: viewport.y - offset.y,
    right: viewport.x + viewport.width - offset.x, bottom: viewport.y + viewport.height - offset.y }
  result.pointer = await root.evaluate(measureTextGlyph, clip)
  assert.ok(result.pointer, 'No visible selectable glyph found in the actual preview')
  await guard.action(() => page.mouse.dblclick(result.pointer.x + offset.x, result.pointer.y + offset.y))
  await guard.read(() => twoFrames(page))
  result.selection = await root.evaluate(selectedWithin)
  result.pointer.documentOffset = offset
}

function selectedWithin(root) {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null
  return { text: selection.toString(), rootCharacters: root.textContent.length, rangeCount: selection.rangeCount }
}

async function previewGeometry(panel) {
  return panel.locator('.document-preview [data-document-page]').first().evaluate(element => {
    const frame = element.querySelector('iframe'), canvas = element.querySelector('canvas')
    const target = frame?.contentDocument?.querySelector('main.document-page') || canvas || element
    const box = target.getBoundingClientRect()
    return { width: box.width, height: box.height, zoom: target.style.zoom || null }
  })
}
