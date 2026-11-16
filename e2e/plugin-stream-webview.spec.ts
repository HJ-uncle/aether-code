/** Real sandboxed iframe bridge; the parent supplies explicit protocol fixtures, not a model. */
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { extensionWebviewDocument } from '../src/renderer/src/features/extensions/webview-document'

let browser: Browser
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' && existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'msedge' : undefined }) })
test.afterAll(async () => { await browser?.close() })

async function fixture(page: Page, mode = 'complete') {
  await page.setContent('<iframe title="stream fixture" sandbox="allow-scripts allow-forms"></iframe>')
  await page.evaluate(({ html, mode }) => {
    const frame = document.querySelector('iframe')!
    const messages: unknown[] = [], delivered: unknown[] = [], streams = new Map<string, { sequence: number; next(): void }>()
    Object.assign(window, { fixtureMessages: messages, fixtureDelivered: delivered })
    addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.data?.channel !== 'stream-fixture') return
      messages.push(event.data)
      if (event.data.event === 'stream-cancel') { streams.delete(event.data.id); return }
      if (event.data.event === 'stream-ack') { const stream = streams.get(event.data.id); if (stream?.sequence === event.data.sequence) stream.next(); return }
      if (event.data.method === 'capability.stream') {
        const id = event.data.id, text = mode === 'large' ? '中'.repeat(800_000) : 'first', count = mode === 'many' ? 70 : 1
        const result = { text, model: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1 } }
        const state = { sequence: 0, next: () => {
          if (mode === 'hold' && state.sequence) return
          const sequence = ++state.sequence
          if (sequence > count + 2) {
            streams.delete(id); frame.contentWindow!.postMessage({ aetherPlugin: 1, channel: 'stream-fixture', id, value: result }, '*'); return
          }
          const value = sequence === 1 ? { type: 'started', runId: 'run-1', childSessionId: 'child-1' }
            : sequence === count + 2 ? { type: 'complete', result } : { type: 'text-delta', text }
          delivered.push({ id, sequence }); frame.contentWindow!.postMessage({ aetherPlugin: 1, channel: 'stream-fixture', id, event: 'stream', sequence, value }, '*')
        } }
        streams.set(id, state); state.next()
      } else if (event.data.method === 'capability') {
        frame.contentWindow!.postMessage({ aetherPlugin: 1, channel: 'stream-fixture', id: event.data.id, value: { tools: [{ name: 'fixture' }] } }, '*')
      }
    })
    frame.srcdoc = html
  }, { html: extensionWebviewDocument('<main id="state"></main>', 'stream-fixture'), mode })
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#state')).toBeAttached()
  return frame
}

test('async onEvent callbacks stay ordered, ACK follows completion, and final Promise waits', async () => {
  const page = await browser.newPage()
  try {
    const frame = await fixture(page)
    await frame.locator('body').evaluate(() => {
      const sdk = (window as unknown as { $AE: { ai: { stream(args: unknown, options: { onEvent(event: { type: string }): Promise<void> }): Promise<unknown> } } }).$AE
      const order: string[] = []; Object.assign(window, { fixtureOrder: order })
      void sdk.ai.stream({ modelId: 'fixture', prompt: 'review' }, { onEvent: async event => {
        order.push(event.type + ':start')
        if (event.type === 'started') await new Promise<void>(resolve => { Object.assign(window, { releaseFixture: resolve }) })
        order.push(event.type + ':end')
      } }).then(() => { order.push('resolved'); document.getElementById('state')!.textContent = 'done' })
    })
    await expect.poll(() => frame.locator('body').evaluate(() => (window as unknown as { fixtureOrder: string[] }).fixtureOrder)).toEqual(['started:start'])
    expect(await page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ event?: string }> }).fixtureMessages.filter(item => item.event === 'stream-ack'))).toEqual([])
    await frame.locator('body').evaluate(() => (window as unknown as { releaseFixture(): void }).releaseFixture())
    await expect(frame.locator('#state')).toHaveText('done')
    expect(await frame.locator('body').evaluate(() => (window as unknown as { fixtureOrder: string[] }).fixtureOrder)).toEqual(['started:start', 'started:end', 'text-delta:start', 'text-delta:end', 'complete:start', 'complete:end', 'resolved'])
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ event?: string }> }).fixtureMessages.filter(item => item.event === 'stream-ack').length)).toBe(3)
    const tools = await frame.locator('body').evaluate(async () => (window as unknown as { $AE: { mcp: { tools(args: unknown): Promise<unknown> } } }).$AE.mcp.tools({ serverId: 'fixture-server' }))
    expect(tools).toEqual({ tools: [{ name: 'fixture' }] })
    const agentTools = await frame.locator('body').evaluate(async () => (window as unknown as { $AE: { agents: { tools(args: unknown): Promise<unknown> } } }).$AE.agents.tools({ agentId: 'fixture-agent' }))
    expect(agentTools).toEqual(tools)
    expect(await page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ params?: unknown }> }).fixtureMessages.at(-1)?.params)).toEqual({ capability: 'agents.read', method: 'tools', args: { agentId: 'fixture-agent' } })
  } finally { await page.close() }
})

test('async callback rejection rejects the stream and sends cancellation without an unhandled rejection', async () => {
  const page = await browser.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const frame = await fixture(page)
    await frame.locator('body').evaluate(() => {
      const sdk = (window as unknown as { $AE: { ai: { stream(args: unknown, options: { onEvent(): Promise<void> }): Promise<unknown> } } }).$AE
      void sdk.ai.stream({ modelId: 'fixture', prompt: 'review' }, { onEvent: async () => { await Promise.resolve(); throw new Error('consumer rejection') } })
        .catch(error => { document.getElementById('state')!.textContent = error.message })
    })
    await expect(frame.locator('#state')).toHaveText('consumer rejection')
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ event?: string }> }).fixtureMessages.filter(item => item.event === 'stream-cancel').length)).toBe(1)
    expect(errors).toEqual([])
  } finally { await page.close() }
})

test('AbortSignal stays inside the iframe and cancels the request by message ID', async () => {
  const page = await browser.newPage()
  try {
    const frame = await fixture(page, 'hold')
    await frame.locator('body').evaluate(() => {
      const controller = new AbortController()
      const sdk = (window as unknown as { $AE: { agents: { stream(args: unknown, options: { signal: AbortSignal; onEvent(): void }): Promise<unknown> } } }).$AE
      void sdk.agents.stream({ modelId: 'fixture', task: 'work', systemPrompt: 'custom' }, { signal: controller.signal, onEvent: () => controller.abort() })
        .catch(error => { document.getElementById('state')!.textContent = error.name })
    })
    await expect(frame.locator('#state')).toHaveText('AbortError')
    const calls = await page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ method?: string; event?: string; params?: unknown }> }).fixtureMessages)
    expect(calls.find(item => item.method === 'capability.stream')?.params).toEqual({ capability: 'agents.manage', method: 'stream', args: { modelId: 'fixture', task: 'work', systemPrompt: 'custom' } })
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ event?: string }> }).fixtureMessages.some(item => item.event === 'stream-cancel'))).toBe(true)
  } finally { await page.close() }
})

test('slow consumption pulls one event at a time and accepts more than the former event budget', async () => {
  const page = await browser.newPage()
  try {
    const frame = await fixture(page, 'many')
    await frame.locator('body').evaluate(() => {
      const sdk = (window as unknown as { $AE: { ai: { stream(args: unknown, options: { onEvent(event: { type: string }): Promise<void> }): Promise<unknown> } } }).$AE
      let count = 0
      void sdk.ai.stream({ modelId: 'fixture', prompt: 'review' }, { onEvent: async event => {
        if (event.type === 'started') await new Promise<void>(resolve => { Object.assign(window, { releaseFixture: resolve }); document.getElementById('state')!.textContent = 'waiting' })
        if (event.type === 'text-delta') count++
      } }).then(() => { document.getElementById('state')!.textContent = String(count) })
    })
    await expect(frame.locator('#state')).toHaveText('waiting')
    expect(await page.evaluate(() => (window as unknown as { fixtureDelivered: unknown[] }).fixtureDelivered.length)).toBe(1)
    await frame.locator('body').evaluate(() => (window as unknown as { releaseFixture(): void }).releaseFixture())
    await expect(frame.locator('#state')).toHaveText('70')
    expect(await page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ event?: string }> }).fixtureMessages.filter(item => item.event === 'stream-cancel'))).toEqual([])
  } finally { await page.close() }
})

test('a callback that never settles has no deadline and remains explicitly cancellable', async () => {
  const page = await browser.newPage()
  try {
    const frame = await fixture(page)
    await frame.locator('body').evaluate(() => {
      const schedule = window.setTimeout.bind(window), delays: number[] = [], controller = new AbortController()
      Object.assign(window, { fixtureDelays: delays, cancelFixture: () => controller.abort() })
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => { delays.push(delay ?? 0); return schedule(handler, delay, ...args) }) as typeof window.setTimeout
      const sdk = (window as unknown as { $AE: { ai: { stream(args: unknown, options: { signal: AbortSignal; onEvent(): Promise<void> }): Promise<unknown> } } }).$AE
      void sdk.ai.stream({ modelId: 'fixture', prompt: 'review' }, { signal: controller.signal, onEvent: () => { document.getElementById('state')!.textContent = 'waiting'; return new Promise<void>(() => {}) } })
        .catch(error => { document.getElementById('state')!.textContent = error.name })
    })
    await expect(frame.locator('#state')).toHaveText('waiting')
    expect(await frame.locator('body').evaluate(() => (window as unknown as { fixtureDelays: number[] }).fixtureDelays)).toEqual([])
    await frame.locator('body').evaluate(() => (window as unknown as { cancelFixture(): void }).cancelFixture())
    await expect(frame.locator('#state')).toHaveText('AbortError')
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureMessages: Array<{ event?: string }> }).fixtureMessages.filter(item => item.event === 'stream-cancel').length)).toBe(1)
  } finally { await page.close() }
})

test('large results and concurrent requests are not rejected by plugin-only budgets', async () => {
  const page = await browser.newPage()
  try {
    const frame = await fixture(page, 'large')
    const result = await frame.locator('body').evaluate(async () => {
      const sdk = (window as unknown as { $AE: { ai: { stream(args: unknown): Promise<{ text: string }> } } }).$AE
      return (await Promise.all(Array.from({ length: 10 }, () => sdk.ai.stream({ prompt: 'large' })))).map(item => item.text.length)
    })
    expect(result).toEqual(Array(10).fill(800_000))
  } finally { await page.close() }
})
