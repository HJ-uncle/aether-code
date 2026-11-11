/** Real Electron CSS regression: semantic button colors survive pointer hover,
 * pressed and keyboard focus across themes; disabled buttons retain their base
 * colors and cannot activate. Includes the engine monitor's local accent button.
 * Samples use the shipped .btn CSS without color
 * overrides. The disposable profile disables engine startup and sends no data. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
let app: ElectronApplication | undefined, page: Page, fixture = ''
const errors: string[] = []
interface NativeWindowEvent {
  time: number; type: string; focused: boolean; visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}
interface RendererInputEvent {
  time: number; type: string; target: string; focused: boolean
  x?: number; y?: number; buttons?: number
}
interface RendererInputDiagnostics {
  events: RendererInputEvent[]
  lastPointer: { x: number; y: number; buttons: number } | null
}
type DiagnosticGlobal = typeof globalThis & { coloredButtonWindowEvents?: NativeWindowEvent[] }
type DiagnosticWindow = Window & { coloredButtonInput?: RendererInputDiagnostics }
const variants = [
  { id: 'neutral', classes: 'btn', kind: 'neutral' },
  { id: 'primary', classes: 'btn btn--primary', kind: 'primary' },
  { id: 'danger', classes: 'btn btn--danger', kind: 'danger' },
  { id: 'primary-danger', classes: 'btn btn--primary btn--danger', kind: 'danger' },
  { id: 'danger-primary', classes: 'btn btn--danger btn--primary', kind: 'danger' },
  { id: 'danger-ghost', classes: 'btn btn--danger-ghost', kind: 'ghost' },
  { id: 'engine-refresh', classes: 'btn btn--sm engine-resource__refresh', kind: 'refresh' },
] as const
type Kind = typeof variants[number]['kind']
type ButtonState = 'rest' | 'hover' | 'pressed'
function colorContract(kind: Kind, state: ButtonState): { background: string; color: string; border: string } {
  if (kind === 'primary') {
    const background = state === 'hover' ? '--accent-hover' : '--accent'
    return { background, color: '--accent-fg', border: background }
  }
  if (kind === 'danger') {
    const background = state === 'hover' ? '--danger-hover' : state === 'pressed' ? '--danger-active' : '--danger'
    return { background, color: '--danger-contrast', border: background }
  }
  if (kind === 'ghost') return { background: state === 'rest' ? 'transparent' : '--danger-soft', color: '--danger-fg', border: '--border-strong' }
  if (kind === 'refresh') return { background: '--accent-soft', color: '--accent', border: '--accent' }
  return { background: state === 'rest' ? 'transparent' : state === 'hover' ? '--bg-hover' : '--bg-active', color: '--fg-strong', border: '--border-strong' }
}
async function assertColors(button: Locator, kind: Kind, state: ButtonState): Promise<void> {
  const contract = colorContract(kind, state)
  await expect.poll(async () => {
    const sample = await button.evaluate((element, expected) => {
    const probe = document.createElement('span'); element.parentElement!.append(probe)
    const resolveColor = (value: string, property: 'backgroundColor' | 'color' | 'borderTopColor'): string => {
      if (value.startsWith('--') && !getComputedStyle(element).getPropertyValue(value).trim()) throw new Error(`Undefined semantic color ${value}`)
      probe.style[property] = value.startsWith('--') ? `var(${value})` : value
      return getComputedStyle(probe)[property]
    }
    const reference = { background: resolveColor(expected.background, 'backgroundColor'), color: resolveColor(expected.color, 'color'), border: resolveColor(expected.border, 'borderTopColor') }
    const computed = getComputedStyle(element)
    const actual = { background: computed.backgroundColor, color: computed.color, border: computed.borderTopColor }
    const interaction = { hover: element.matches(':hover'), active: element.matches(':active'), focusVisible: element.matches(':focus-visible'),
      focused: document.hasFocus(), disabled: element.matches(':disabled') }
    const box = element.getBoundingClientRect()
    const input = (window as DiagnosticWindow).coloredButtonInput
    const pointer = input?.lastPointer
    const hit = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null
    probe.remove()
    const mismatches = (['background', 'color', 'border'] as const).flatMap(property => actual[property] === reference[property]
      ? [] : [{ property, actual: actual[property], expected: reference[property], interaction }])
    return { id: element.id, mismatches, filter: computed.filter, interaction,
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height }, pointer,
      hit: hit instanceof HTMLElement ? { id: hit.id, tag: hit.tagName, classes: hit.className } : null,
      recentInput: input?.events.slice(-25) ?? [] }
    }, contract)
    const expectedActive = state === 'pressed', expectedHover = state !== 'rest'
    if (!sample.interaction.focused || !sample.interaction.disabled &&
      (sample.interaction.active !== expectedActive || sample.interaction.hover !== expectedHover)) {
      const windowEvents = await app!.evaluate(() => (globalThis as DiagnosticGlobal).coloredButtonWindowEvents ?? [])
      // Throw from the polling callback before its matcher: an input-state loss
      // must fail immediately, not wait for a lucky color or repeat the press.
      throw new Error(`Button input state lost during ${state}: ${JSON.stringify({ ...sample, windowEvents }, null, 2)}`)
    }
    return { mismatches: sample.mismatches, filter: sample.filter }
  }, { message: `${kind} ${state} retains semantic fill, text and border` }).toEqual({ mismatches: [], filter: 'none' })
}
async function snapshot(button: Locator): Promise<unknown> {
  return button.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor, opacity: style.opacity, filter: style.filter, transform: style.transform }
  })
}
async function captureState(name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'colored-buttons-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1',
    autoStartEngine: false, remoteWorkspaceRoot: '', lastFolder: '', appearance: 'light', accent: 'blue' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await page.addInitScript(() => {
    const diagnostics: RendererInputDiagnostics = { events: [], lastPointer: null }
    ;(window as DiagnosticWindow).coloredButtonInput = diagnostics
    const record = (event: Event): void => {
      const target = event.target instanceof HTMLElement ? event.target.id ? `#${event.target.id}` : event.target.tagName
        : event.target === window ? 'window' : event.target === document ? 'document' : 'other'
      const entry: RendererInputEvent = { time: Date.now(), type: event.type, target, focused: document.hasFocus() }
      if (event instanceof PointerEvent) {
        entry.x = event.clientX; entry.y = event.clientY; entry.buttons = event.buttons
        diagnostics.lastPointer = { x: event.clientX, y: event.clientY, buttons: event.buttons }
      }
      diagnostics.events.push(entry)
      if (diagnostics.events.length > 200) diagnostics.events.shift()
    }
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'pointerleave']) document.addEventListener(type, record, true)
    window.addEventListener('focus', record); window.addEventListener('blur', record)
    document.addEventListener('visibilitychange', record)
  })
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], events: NativeWindowEvent[] = []
    ;(globalThis as DiagnosticGlobal).coloredButtonWindowEvents = events
    for (const type of ['focus', 'blur', 'show', 'hide', 'move', 'resize'] as const) win.on(type, () => {
      events.push({ time: Date.now(), type, focused: win.isFocused(), visible: win.isVisible(), bounds: win.getBounds() })
      if (events.length > 200) events.shift()
    })
    win.setContentSize(1280, 900); win.show(); win.focus()
  })
  await expect(page.locator('.status-bar')).toBeVisible({ timeout: 45_000 })
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) {
    const input = await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState,
      diagnostics: (window as DiagnosticWindow).coloredButtonInput ?? null }))
    const windows = await app!.evaluate(() => (globalThis as DiagnosticGlobal).coloredButtonWindowEvents ?? [])
    await info.attach('button-input-events', { body: JSON.stringify({ input, windows }, null, 2), contentType: 'application/json' })
    await info.attach('button-colors', { body: JSON.stringify(await page.locator('[data-color-sample]').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element)
      return { id: element.id, classes: element.className, background: style.backgroundColor, color: style.color, border: style.borderTopColor, filter: style.filter,
        hover: element.matches(':hover'), active: element.matches(':active'), focusVisible: element.matches(':focus-visible') }
    })), null, 2), contentType: 'application/json' })
    const path = info.outputPath('colored-buttons.png'); await page.screenshot({ path }); await info.attach('colored-buttons', { path, contentType: 'image/png' })
  }
  expect(errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('colored-buttons-profile-')) throw new Error('Unsafe color fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const appearance of ['light', 'dark'] as const) for (const accent of ['blue', 'orange', 'custom'] as const) {
  test(`${appearance} / ${accent}：带色按钮 hover、pressed、键盘焦点及禁用保留语义`, async () => {
    await app!.evaluate(() => { const events = (globalThis as DiagnosticGlobal).coloredButtonWindowEvents; if (events) events.length = 0 })
    // Applying settings then reloading uses the app's actual custom-accent
    // contrast resolution and tokens, rather than duplicating its algorithm.
    await page.evaluate(async theme => {
      await window.aether.settings.update(theme)
    }, { appearance, accent, customAccentColor: '#d1a6ff' })
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
    await expect(page.locator('html')).toHaveAttribute('data-accent', accent)
    await expect(page.locator('.status-bar')).toBeVisible()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'Button test window owns keyboard and pointer focus after reload' }).toBe(true)
    await page.evaluate(rows => {
      const appRoot = document.getElementById('root'); if (appRoot) appRoot.inert = true
      const host = document.createElement('section'); host.id = 'colored-button-samples'
      host.setAttribute('aria-label', '公共按钮状态样本')
      Object.assign(host.style, { position: 'fixed', inset: '80px 80px auto', zIndex: '9999', display: 'grid', gap: '20px', padding: '24px', background: 'var(--bg-elevated)' })
      for (const row of rows) {
        const group = document.createElement('div'); Object.assign(group.style, { display: 'flex', gap: '16px', alignItems: 'center' })
        const before = document.createElement('button'); before.id = `${row.id}-before`; before.textContent = '焦点起点'
        const button = document.createElement('button'); button.id = row.id; button.className = row.classes; button.textContent = row.id
        button.type = 'button'; button.dataset.colorSample = ''; button.dataset.activations = '0'
        button.addEventListener('click', () => { button.dataset.activations = String(Number(button.dataset.activations) + 1) })
        const disabled = document.createElement('button'); disabled.id = `${row.id}-disabled`; disabled.className = row.classes
        disabled.type = 'button'; disabled.disabled = true; disabled.textContent = `${row.id} · 禁用`; disabled.dataset.colorSample = ''; disabled.dataset.activations = '0'
        disabled.addEventListener('click', () => { disabled.dataset.activations = String(Number(disabled.dataset.activations) + 1) })
        const after = document.createElement('button'); after.id = `${row.id}-after`; after.textContent = '焦点终点'
        group.append(before, button, disabled, after)
        if (row.kind === 'refresh') {
          // Keep the real ancestor chain: its local color selector must survive
          // the generic .btn hover/active rules, without fixture overrides.
          const resource = document.createElement('section'); resource.className = 'engine-resource'
          group.className = 'engine-resource__heading-actions'
          button.textContent = '↻'; button.setAttribute('aria-label', '刷新监控数据')
          disabled.textContent = '↻'; disabled.setAttribute('aria-label', '刷新监控数据（禁用）')
          resource.append(group); host.append(resource)
        } else host.append(group)
      }
      document.body.append(host)
    }, variants)
    for (const variant of variants) {
      const button = page.locator(`#${variant.id}`), disabled = page.locator(`#${variant.id}-disabled`)
      const capture = appearance === 'light' && accent === 'blue' && (variant.id === 'primary' || variant.id === 'danger')
      await page.mouse.move(10, 60); await assertColors(button, variant.kind, 'rest'); await assertColors(disabled, variant.kind, 'rest')
      await page.locator(`#${variant.id}-before`).focus(); await page.keyboard.press('Tab'); await expect(button).toBeFocused()
      expect(await button.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await assertColors(button, variant.kind, 'rest')
      await page.keyboard.press('Tab'); await expect(page.locator(`#${variant.id}-after`)).toBeFocused()
      await button.hover(); await assertColors(button, variant.kind, 'hover')
      if (capture) await captureState(`${variant.id}-hover`)
      await page.mouse.down()
      try {
        expect(await button.evaluate(element => element.matches(':active'))).toBe(true)
        await assertColors(button, variant.kind, 'pressed')
        if (capture) await captureState(`${variant.id}-pressed`)
      }
      finally { await page.mouse.up() }
      await expect.poll(() => button.evaluate(element => element.matches(':active')), { message: `${variant.id} releases its pressed state` }).toBe(false)
      // Test post-release hover as a separate input state instead of assuming
      // that releasing the pointer leaves it hovering in the Electron window.
      await button.hover()
      await expect.poll(() => button.evaluate(element => ({ hover: element.matches(':hover'), active: element.matches(':active') }))).toEqual({ hover: true, active: false })
      await assertColors(button, variant.kind, 'hover'); await expect(button).toHaveAttribute('data-activations', '1')
      const disabledBase = await snapshot(disabled)
      await disabled.hover(); await expect.poll(() => snapshot(disabled)).toEqual(disabledBase)
      await page.mouse.down()
      try { await expect.poll(() => snapshot(disabled)).toEqual(disabledBase) }
      finally { await page.mouse.up() }
      await expect(disabled).toHaveAttribute('data-activations', '0'); await assertColors(disabled, variant.kind, 'rest')
    }
  })
}
