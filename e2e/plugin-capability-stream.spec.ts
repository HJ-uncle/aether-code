/** IPC stream lifecycle tests; fixtures never access profiles, credentials or a running engine. */
import { expect, test } from '@playwright/test'
import type { StreamEvent, StreamStartInput } from '../src/shared/ipc'
import { respondPluginAgent, streamPluginCapability, type PluginCapabilityStreamEvent } from '../src/renderer/src/core/engine/plugins'
import { getExpectedEngine, isEngineReady, publishEngineSource } from '../src/renderer/src/core/engine/source'

const input = { pluginId: 'stream-fixture', revision: 3, sessionId: 'bound-session', capability: 'ai.run', method: 'stream', args: { modelId: 'model-config', prompt: 'test' } }
function fixture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previous = { ...getExpectedEngine(), phase: isEngineReady() ? 'ready' as const : 'idle' as const }
  const listeners = new Set<(event: StreamEvent) => void>(), starts: StreamStartInput[] = [], aborted: string[] = []
  let startError = false, sequence = 0
  const acknowledgements: string[] = [], waiting = new Map<string, () => void>()
  const window = Object.assign(new EventTarget(), { aether: { engine: {
    stream: { start: (value: StreamStartInput) => { starts.push(value); if (startError) throw new Error('IPC unavailable'); return Promise.resolve({ ok: true }) }, abort: async (id: string) => { aborted.push(id); for (const done of waiting.values()) done(); waiting.clear(); return { ok: true } }, ack: async (_id: string, ackId: string) => { acknowledgements.push(ackId); waiting.get(ackId)?.(); waiting.delete(ackId); return { ok: true } } },
    onStreamEvent: (listener: (event: StreamEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  } } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  const source = (instanceId: string) => publishEngineSource({ mode: 'remote', baseUrl: 'https://fixture.test', instanceId, phase: 'ready' })
  source('stream-a')
  const emit = (event: StreamEvent) => { for (const listener of [...listeners]) listener(event) }
  return { starts, aborted, acknowledgements, listeners, source, window,
    startError: () => { startError = true },
    payload: (value: unknown, streamId = starts.at(-1)?.streamId ?? '') => {
      const ackId = String(++sequence)
      const consumed = listeners.size && streamId === starts.at(-1)?.streamId ? new Promise<void>(done => waiting.set(ackId, done)) : Promise.resolve()
      emit({ streamId, ackId, type: 'payload', payload: value } as StreamEvent); return consumed
    },
    done: () => emit({ streamId: starts.at(-1)!.streamId, type: 'done' }),
    close: () => { window.dispatchEvent(new Event('pagehide')); publishEngineSource(previous); if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') }
  }
}

test('streams real event order through pinned IPC and resolves only the complete result', async () => {
  const h = fixture(), events: PluginCapabilityStreamEvent[] = []
  try {
    const promise = streamPluginCapability(input, { onEvent: event => { events.push(event) } })
    expect(h.starts[0]).toMatchObject({ method: 'POST', flowControl: 'ack', path: '/plugins/stream-fixture/capabilities/stream', expectedEngine: { instanceId: 'stream-a' } })
    expect(h.starts[0].body).toEqual({ capability: 'ai.run', method: 'stream', args: input.args, sessionId: 'bound-session', expectedRevision: 3 })
    await h.payload({ type: 'text-delta', text: 'foreign' }, 'another-stream')
    await h.payload({ type: 'started', model: 'provider-model' }); await h.payload({ type: 'text-delta', text: 'first' })
    expect(events.map(event => event.type)).toEqual(['started', 'text-delta'])
    const result = { text: 'first and last', model: 'provider-model', usage: { inputTokens: 2, outputTokens: 3 } }
    await h.payload({ type: 'complete', result }); expect(await promise).toEqual(result)
    expect(h.listeners.size).toBe(0); expect(h.aborted).toEqual([])
    await h.payload({ type: 'text-delta', text: 'late' }); expect(events).toHaveLength(3)
  } finally { h.close() }
})

test('EOF without a completion frame rejects instead of treating partial text as success', async () => {
  const h = fixture()
  try {
    const promise = streamPluginCapability(input); const rejected = expect(promise).rejects.toThrow('未收到完整结果')
    await h.payload({ type: 'text-delta', text: 'partial' }); h.done(); await rejected
    expect(h.listeners.size).toBe(0); expect(h.aborted).toEqual([h.starts[0].streamId])
  } finally { h.close() }
})

test('caller abort and engine changes stop owned streams and remove listeners', async () => {
  const h = fixture()
  try {
    const controller = new AbortController(), first = streamPluginCapability(input, { signal: controller.signal })
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await cancelled
    expect(h.listeners.size).toBe(0)
    const second = streamPluginCapability(input), changed = expect(second).rejects.toThrow('引擎连接已变化')
    h.source('stream-b'); await changed
    expect(h.aborted).toEqual(h.starts.map(value => value.streamId)); expect(h.listeners.size).toBe(0)
    await expect(streamPluginCapability(input, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.starts).toHaveLength(2)
  } finally { h.close() }
})

test('development calls pin source hash, retain custom Agent arguments and stream safe tool events', async () => {
  const h = fixture(), events: PluginCapabilityStreamEvent[] = []
  try {
    const args = { modelId: 'configuration', task: 'review', systemPrompt: 'review carefully', skills: ['skill-a'], tools: ['read_file'], disabledTools: ['execute_cmd'], customTools: [{ name: 'own_tool', tool: 'local_tool' }] }
    const promise = streamPluginCapability({ ...input, capability: 'agents.manage', devSessionId: 'dev-stream', hash: 'sha256:fixture', args }, { onEvent: event => { events.push(event) } })
    expect(h.starts[0]).toMatchObject({ path: '/plugins/dev/dev-stream/capabilities/stream', body: { expectedRevision: 3, hash: 'sha256:fixture', capability: 'agents.manage', args } })
    await h.payload({ type: 'started', runId: 'run-a', childSessionId: 'child-a' }); await h.payload({ type: 'tool-start', toolName: 'read', toolCallId: 'call-a', arguments: { secret: 'not-forwarded' } })
    await h.payload({ type: 'tool-end', toolName: 'read', toolCallId: 'call-a', success: true, durationMs: 12, output: 'not-forwarded' })
    const result = { runId: 'run-a', status: 'succeeded', result: 'done' }; await h.payload({ type: 'complete', result })
    expect(await promise).toEqual(result); expect(events[1]).toEqual({ type: 'tool-start', toolName: 'read', toolCallId: 'call-a' })
    expect(events[0]).toEqual({ type: 'started', runId: 'run-a', childSessionId: 'child-a' })
    expect(events[2]).toEqual({ type: 'tool-end', toolName: 'read', toolCallId: 'call-a', success: true, durationMs: 12 })
  } finally { h.close() }
})

test('invalid events, provider errors and failing consumers stop the stream without dangling subscriptions', async () => {
  const h = fixture()
  try {
    for (const payload of [{ type: 'unknown' }, { type: 'error', error: { code: 'PLUGIN_PERMISSION', message: 'permission revoked' } }]) {
      const promise = streamPluginCapability(input), rejected = expect(promise).rejects.toThrow()
      await h.payload(payload); await rejected; expect(h.listeners.size).toBe(0)
    }
    const promise = streamPluginCapability(input, { onEvent: () => { throw new Error('consumer failed') } })
    const rejected = expect(promise).rejects.toThrow('consumer failed'); await h.payload({ type: 'started' }); await rejected
    expect(h.listeners.size).toBe(0)
    h.startError(); await expect(streamPluginCapability(input)).rejects.toThrow('IPC unavailable'); expect(h.listeners.size).toBe(0)
  } finally { h.close() }
})


test('large payloads and a slow async consumer apply ACK backpressure without size or callback deadlines', async () => {
  const h = fixture(), text = '中'.repeat(800_000)
  let release!: () => void
  try {
    const promise = streamPluginCapability(input, { onEvent: async event => {
      if (event.type === 'text-delta') { expect(event.text).toBe(text); await new Promise<void>(done => { release = done }) }
    } })
    const consumed = h.payload({ type: 'text-delta', text })
    expect(h.acknowledgements).toEqual([])
    release(); await consumed
    expect(h.acknowledgements).toHaveLength(1)
    await h.payload({ type: 'complete', result: { text } }); expect(await promise).toEqual({ text })
    expect(h.aborted).toEqual([])
  } finally { h.close() }
})

test('pending events preserve user-facing identity without exposing sealed execution actions', async () => {
  const h = fixture(), events: PluginCapabilityStreamEvent[] = []
  try {
    const promise = streamPluginCapability({ ...input, capability: 'agents.manage' }, { onEvent: event => { events.push(event) } })
    await h.payload({ type: 'pending', runId: 'outer-run', childSessionId: 'child-session', pending: {
      requestId: 'request-a', toolCallId: 'call-a', toolName: 'execute_cmd', kind: 'permission', question: 'Confirm',
      args: { command: 'node', args: ['--version'] }, pendingAction: { secret: 'sealed' }, metadata: { secret: 'private' }
    } })
    expect(events[0]).toEqual({ type: 'pending', runId: 'outer-run', childSessionId: 'child-session', pending: {
      requestId: 'request-a', toolCallId: 'call-a', toolName: 'execute_cmd', kind: 'permission', question: 'Confirm', status: 'pending', args: { command: 'node', args: ['--version'] }
    } })
    await h.payload({ type: 'complete', result: { status: 'blocked' } }); expect(await promise).toEqual({ status: 'blocked' })
  } finally { h.close() }
})

test('trusted host resume pins the installed or development identity and sends only the human answer', async () => {
  const h = fixture()
  try {
    for (const dev of [false, true]) {
      const promise = respondPluginAgent({ pluginId: 'stream-fixture', revision: 3, sessionId: 'bound-session', runId: 'outer-run', requestId: 'request-a', toolCallId: 'call-a', output: 'approved', ...(dev ? { devSessionId: 'dev-session', hash: 'sha256:fixture' } : {}) }, {})
      expect(h.starts.at(-1)).toMatchObject({ method: 'POST', flowControl: 'ack', path: dev ? '/plugins/dev/dev-session/agents/outer-run/respond' : '/plugins/stream-fixture/agents/outer-run/respond', body: {
        ...(dev ? { revision: 3, hash: 'sha256:fixture' } : { expectedRevision: 3 }), sessionId: 'bound-session', requestId: 'request-a', toolCallId: 'call-a', output: 'approved'
      } })
      await h.payload({ type: 'complete', result: { status: 'succeeded' } }); await promise
    }
  } finally { h.close() }
})
