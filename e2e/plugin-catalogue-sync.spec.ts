/** Pure catalogue stream lifecycle checks. The bridge, clock and window are
 * isolated in memory; no Electron, HTTP server, plugin code or profile is used. */
import { expect, test } from '@playwright/test'
import type { StreamEvent, StreamStartInput, StreamStartResult } from '../src/shared/ipc'
import { parsePluginCatalogueChange, startPluginCatalogueSync } from '../src/renderer/src/core/engine/plugin-catalogue-sync'
import { subscribeResourceCatalogueChanges, type ResourceCatalogueChange } from '../src/renderer/src/core/engine/resource-catalogue'
import { getExpectedEngine, isEngineReady, publishEngineSource, subscribeEngineSource } from '../src/renderer/src/core/engine/source'

const change = (action = 'update', id = 'report-helper') => ({ pluginCatalogueChange: { kind: 'plugin', action, id } })
const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function fixture() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')!
  const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')!
  const previousSource = { ...getExpectedEngine(), phase: isEngineReady() ? 'ready' as const : 'idle' as const }
  const listeners = new Set<(event: StreamEvent) => void>()
  const starts: Array<{ input: StreamStartInput; resolve(value: StreamStartResult): void }> = []
  const aborted: string[] = [], changes: ResourceCatalogueChange[] = []
  const timers = new Map<number, { delay: number; run(): void }>()
  let nextTimer = 0
  const window = Object.assign(new EventTarget(), { aether: { engine: {
    stream: {
      start: (input: StreamStartInput): Promise<StreamStartResult> => new Promise(resolve => starts.push({ input, resolve })),
      abort: async (id: string) => { aborted.push(id); return { ok: true } }
    },
    onStreamEvent: (listener: (event: StreamEvent) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  } } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (run: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { delay, run }); return id } })
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id) } })
  const source = (instanceId: string, ready = true): void => publishEngineSource({ mode: 'remote', baseUrl: `https://${instanceId}.test`, instanceId, phase: ready ? 'ready' : 'idle', accountId: 'fixture-account' })
  source('catalogue-a')
  let resourcesOff = subscribeResourceCatalogueChanges(['plugin'], value => changes.push(value))
  const sourceOff = subscribeEngineSource(() => { resourcesOff(); resourcesOff = subscribeResourceCatalogueChanges(['plugin'], value => changes.push(value)) })
  const stops: Array<() => void> = []
  const emit = (event: StreamEvent): void => { for (const listener of [...listeners]) listener(event) }
  return {
    starts, aborted, changes, timers, listeners, source,
    start: () => { const stop = startPluginCatalogueSync(); stops.push(stop); return stop },
    pagehide: () => window.dispatchEvent(new Event('pagehide')),
    emit,
    payload: (streamId: string, payload: unknown = change()) => emit({ streamId, type: 'payload', payload } as StreamEvent),
    runTimer: (): number => {
      const entry = timers.entries().next().value as [number, { delay: number; run(): void }] | undefined
      if (!entry) throw new Error('Expected a scheduled catalogue reconnect')
      timers.delete(entry[0]); entry[1].run(); return entry[1].delay
    },
    close: () => {
      for (const stop of stops) stop()
      sourceOff(); resourcesOff(); publishEngineSource(previousSource)
      Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout)
      Object.defineProperty(globalThis, 'clearTimeout', originalClearTimeout)
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

test('catalogue protocol accepts only declared update and full-refresh envelopes', () => {
  expect(parsePluginCatalogueChange(change())).toEqual({ kind: 'plugin', action: 'update', id: 'report-helper' })
  expect(parsePluginCatalogueChange(change('refresh', '*'))).toEqual({ kind: 'plugin', action: 'refresh', id: '*' })
  for (const payload of [null, 'publish report-helper', {}, { content: 'pluginCatalogueChange' },
    { pluginCatalogueChange: { kind: 'skill', action: 'update', id: 'helper' } },
    change('refresh', 'helper'), change('delete', 'helper'), change('update', '*'), change('update', '../helper'), change('update', '')]) {
    expect(parsePluginCatalogueChange(payload), JSON.stringify(payload)).toBeNull()
  }
})

test('only the owned catalogue stream can invalidate plugins; ordinary chat and malformed frames stay silent', () => {
  const h = fixture()
  try {
    h.start()
    expect(h.starts).toHaveLength(1)
    const { input } = h.starts[0]
    expect(input).toMatchObject({ method: 'GET', path: '/plugins/runtime/changes', body: null, toolProfile: 'general', expectedEngine: { instanceId: 'catalogue-a' } })
    h.payload('ordinary-chat', change('refresh', '*'))
    h.payload(input.streamId, { content: 'plugin_publish completed' })
    h.payload(input.streamId, change('update', '../outside'))
    expect(h.changes).toEqual([])
    h.payload(input.streamId)
    expect(h.changes.map(({ kind, action, id }) => ({ kind, action, id }))).toEqual([{ kind: 'plugin', action: 'update', id: 'report-helper' }])
    expect(h.timers.size).toBe(0)
  } finally { h.close() }
})

test('source changes abort the old stream; late frames and late start rejection cannot affect its replacement', async () => {
  const h = fixture()
  try {
    h.start(); const old = h.starts[0]
    h.source('catalogue-b')
    expect(h.aborted).toEqual([old.input.streamId])
    expect(h.starts).toHaveLength(2)
    const next = h.starts[1]
    expect(next.input.expectedEngine?.instanceId).toBe('catalogue-b')
    h.payload(old.input.streamId, change('refresh', '*'))
    old.resolve({ ok: false, rejection: { status: 503, message: 'Late old failure' } }); await tick()
    expect(h.changes).toEqual([])
    expect(h.timers.size).toBe(0)
    h.payload(next.input.streamId, change('refresh', '*'))
    expect(h.changes.map(value => value.action)).toEqual(['refresh'])
  } finally { h.close() }
})

test('disconnect reconnects once and the new initial refresh repairs mutations missed while offline', async () => {
  const h = fixture()
  try {
    h.start(); const first = h.starts[0]
    h.payload(first.input.streamId, change('refresh', '*'))
    h.emit({ streamId: first.input.streamId, type: 'error', message: 'Disconnected' })
    h.emit({ streamId: first.input.streamId, type: 'done' })
    first.resolve({ ok: true }); await tick()
    expect(h.timers.size).toBe(1)
    expect(h.runTimer()).toBe(1000)
    expect(h.starts).toHaveLength(2)
    h.payload(first.input.streamId, change('update', 'missed-plugin'))
    h.payload(h.starts[1].input.streamId, change('refresh', '*'))
    expect(h.changes.map(({ action, id }) => ({ action, id }))).toEqual([{ action: 'refresh', id: '*' }, { action: 'refresh', id: '*' }])
    expect(h.timers.size).toBe(0)
  } finally { h.close() }
})

test('transport retry backs off to 30 seconds and a valid frame resets it', () => {
  const h = fixture()
  try {
    h.start()
    const delays: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      h.emit({ streamId: h.starts.at(-1)!.input.streamId, type: 'error', status: 503, message: 'Unavailable' })
      expect(h.timers.size).toBe(1); delays.push(h.runTimer())
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    const current = h.starts.at(-1)!.input.streamId
    h.payload(current, change('refresh', '*'))
    h.emit({ streamId: current, type: 'done' })
    expect(h.runTimer()).toBe(1000)
  } finally { h.close() }
})

test('readiness loss clears reconnect work and readiness recovery opens exactly one fresh subscription', () => {
  const h = fixture()
  try {
    h.start(); const first = h.starts[0].input.streamId
    h.emit({ streamId: first, type: 'error', message: 'Connection lost' })
    expect(h.timers.size).toBe(1)
    h.source('catalogue-a', false)
    expect(h.timers.size).toBe(0)
    expect(h.starts).toHaveLength(1)
    h.payload(first, change('refresh', '*'))
    expect(h.changes).toEqual([])
    h.source('catalogue-a')
    expect(h.starts).toHaveLength(2)
    expect(h.starts[1].input.streamId).not.toBe(first)
  } finally { h.close() }
})

test('dispose aborts an active pending stream and removes all reconnect/event subscriptions', async () => {
  const h = fixture()
  try {
    const stop = h.start(), active = h.starts[0]
    stop(); stop()
    expect(h.aborted).toEqual([active.input.streamId])
    expect(h.listeners.size).toBe(0)
    h.payload(active.input.streamId, change('refresh', '*'))
    active.resolve({ ok: false, rejection: { status: 503, message: 'Late result' } }); await tick()
    h.source('catalogue-b')
    expect(h.starts).toHaveLength(1)
    expect(h.changes).toEqual([])
    expect(h.timers.size).toBe(0)
  } finally { h.close() }
})

test('dispose also cancels a scheduled reconnect without opening another stream', () => {
  const h = fixture()
  try {
    const stop = h.start()
    h.emit({ streamId: h.starts[0].input.streamId, type: 'done' })
    expect(h.timers.size).toBe(1)
    stop()
    expect(h.timers.size).toBe(0)
    expect(h.listeners.size).toBe(0)
    expect(h.starts).toHaveLength(1)
  } finally { h.close() }
})

test('document pagehide aborts its stream and ignores late frames and responses before a fresh document subscribes', async () => {
  const h = fixture()
  try {
    const stop = h.start(), previous = h.starts[0]
    h.pagehide()
    expect(h.aborted).toEqual([previous.input.streamId])
    expect(h.listeners.size).toBe(0)
    h.payload(previous.input.streamId, change('refresh', '*'))
    previous.resolve({ ok: false, rejection: { status: 503, message: 'Unloaded document' } }); await tick()
    h.source('catalogue-b')
    expect(h.starts).toHaveLength(1)
    expect(h.changes).toEqual([])
    expect(h.timers.size).toBe(0)
    h.start(); const next = h.starts[1]
    stop()
    expect(h.aborted).toEqual([previous.input.streamId])
    h.payload(next.input.streamId, change('refresh', '*'))
    expect(h.changes.map(value => value.action)).toEqual(['refresh'])
    h.pagehide()
    expect(h.aborted).toEqual([previous.input.streamId, next.input.streamId])
    expect(h.listeners.size).toBe(0)
  } finally { h.close() }
})

test('document pagehide cancels a pending reconnect even when React has not disposed the host', () => {
  const h = fixture()
  try {
    h.start()
    h.emit({ streamId: h.starts[0].input.streamId, type: 'done' })
    expect(h.timers.size).toBe(1)
    h.pagehide()
    expect(h.timers.size).toBe(0)
    expect(h.listeners.size).toBe(0)
    h.source('catalogue-b')
    expect(h.starts).toHaveLength(1)
  } finally { h.close() }
})

for (const status of [200, 401, 403, 404, 405]) test(`unsupported or unauthorized SSE status ${status} does not schedule probes`, () => {
  const h = fixture()
  try {
    h.start()
    h.emit({ streamId: h.starts[0].input.streamId, type: 'error', status, message: 'Unsupported or unauthorized' })
    expect(h.timers.size).toBe(0)
    expect(h.aborted).toEqual([h.starts[0].input.streamId])
    expect(h.starts).toHaveLength(1)
  } finally { h.close() }
})

for (const rejection of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 405 }, { code: 40100 }]) test(`start rejection ${JSON.stringify(rejection)} does not schedule probes without an error frame`, async () => {
  const h = fixture()
  try {
    h.start()
    h.starts[0].resolve({ ok: false, rejection: { ...rejection, message: 'Unsupported or unauthorized' } }); await tick()
    expect(h.timers.size).toBe(0)
    expect(h.aborted).toEqual([h.starts[0].input.streamId])
    expect(h.starts).toHaveLength(1)
  } finally { h.close() }
})
