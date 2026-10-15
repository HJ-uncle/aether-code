/** Engine runtime wire validation and opt-in single-flight sampling; no Electron required. */
import { expect, test } from '@playwright/test'
import { createEngineRuntimeSampler, parseEngineRuntimeDiagnostics, type EngineRuntimeDiagnostics, type EngineRuntimeState } from '../src/renderer/src/contrib/work/engine-runtime'
import { remoteRequestError } from '../src/main/engine/protocol'
import { managementRequestTimeout } from '../src/main/engine/request-timeout'

export function runtimeFixture(patch: Partial<EngineRuntimeDiagnostics> = {}): EngineRuntimeDiagnostics {
  return { schemaVersion: 1, instanceId: 'p1-runtime-instance', pid: 1234, sampledAt: 1700000000000, uptimeMs: 10000,
    collection: { minIntervalMs: 5000, idleTimeoutMs: 15000, delayResolutionMs: 20 },
    memory: { rssBytes: 128 * 1024 ** 2, heapUsedBytes: 32 * 1024 ** 2, heapTotalBytes: 64 * 1024 ** 2, heapLimitBytes: 2048 * 1024 ** 2, externalBytes: 8 * 1024 ** 2, arrayBuffersBytes: 4 * 1024 ** 2 },
    eventLoop: { state: 'available', intervalMs: 5000, utilization: 0.125, delay: { meanMs: 21, p95Ms: 24, maxMs: 40 } }, ...patch }
}
const target = { instanceId: 'p1-runtime-instance', pid: 1234 }
const ok = (data: unknown) => ({ ok: true, code: 200, message: 'OK', data })
const turn = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test('runtime reads only the exact authorized GET route and has a bounded transport deadline', () => {
  expect(remoteRequestError('remote', 'GET', '/performance/runtime')).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/performance/runtime')).not.toBeNull()
  expect(remoteRequestError('remote', 'GET', '/performance/stats')).not.toBeNull()
  expect(managementRequestTimeout({ method: 'GET', path: '/performance/runtime' })).toBe(5000)
})
test('parser reconstructs the real engine schema and keeps a true zero utilization', () => {
  const data = runtimeFixture({ eventLoop: { ...runtimeFixture().eventLoop, utilization: 0 } })
  const parsed = parseEngineRuntimeDiagnostics({ ...data, secret: 'not-a-metric' }, target)
  expect(parsed).toEqual(data)
  expect(parsed).not.toBe(data)
  expect(parsed.eventLoop.utilization).toBe(0)
  expect(parsed).not.toHaveProperty('secret')
})
test('instance and PID mismatches cannot be relabelled as the current engine', () => {
  expect(() => parseEngineRuntimeDiagnostics(runtimeFixture(), { ...target, instanceId: 'other' })).toThrow()
  expect(() => parseEngineRuntimeDiagnostics(runtimeFixture(), { ...target, pid: 9999 })).toThrow()
  expect(() => parseEngineRuntimeDiagnostics(runtimeFixture(), { instanceId: null, pid: null })).toThrow()
})
test('warming remains null instead of fabricating an event-loop measurement', () => {
  const parsed = parseEngineRuntimeDiagnostics(runtimeFixture({ eventLoop: { state: 'warming', intervalMs: null, utilization: null, delay: null } }), target)
  expect(parsed.eventLoop).toEqual({ state: 'warming', intervalMs: null, utilization: null, delay: null })
  expect(() => parseEngineRuntimeDiagnostics(runtimeFixture({ eventLoop: { state: 'available', intervalMs: 5000, utilization: null, delay: null } }), target)).toThrow()
})
test('numeric strings, non-finite values and impossible heap/delay data are rejected', () => {
  const values: unknown[] = [null, [], { ...runtimeFixture(), schemaVersion: 2 }, { ...runtimeFixture(), pid: '1234' },
    runtimeFixture({ memory: { ...runtimeFixture().memory, heapUsedBytes: -1 } }),
    runtimeFixture({ memory: { ...runtimeFixture().memory, heapUsedBytes: Infinity } }),
    runtimeFixture({ memory: { ...runtimeFixture().memory, heapTotalBytes: 1 } }),
    runtimeFixture({ eventLoop: { ...runtimeFixture().eventLoop, utilization: 1.1 } }),
    runtimeFixture({ eventLoop: { ...runtimeFixture().eventLoop, delay: { meanMs: 30, p95Ms: 40, maxMs: 20 } } })]
  for (const value of values) expect(() => parseEngineRuntimeDiagnostics(value, target)).toThrow('未提供可验证')
})
test('sampler starts on demand, serializes reads and discards a hidden completion', async () => {
  const states: EngineRuntimeState[] = [], scheduled: Array<{ callback: () => void; delay: number }> = []
  let reads = 0, complete!: (value: ReturnType<typeof ok>) => void
  const sampler = createEngineRuntimeSampler({ target, current: () => true, publish: state => states.push(state),
    read: () => { reads++; return new Promise(done => { complete = done }) },
    schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer }, cancel: () => {} })
  expect(reads).toBe(0)
  sampler.setActive(true); sampler.setActive(false); sampler.setActive(true)
  expect(reads).toBe(1)
  complete(ok(runtimeFixture())); await turn()
  expect(states.some(state => state.phase === 'sample')).toBe(false)
  expect(scheduled.at(-1)?.delay).toBe(0)
  scheduled.at(-1)!.callback(); expect(reads).toBe(2)
  sampler.dispose(); complete(ok(runtimeFixture())); await turn()
  expect(states.some(state => state.phase === 'sample')).toBe(false)
})
test('404 capability absence stops automatic and collapse/reopen retries', async () => {
  let reads = 0, timers = 0
  const states: EngineRuntimeState[] = []
  const sampler = createEngineRuntimeSampler({ target, current: () => true, publish: state => states.push(state),
    read: async () => { reads++; return { ok: false, code: 404, message: 'missing', data: null } }, schedule: () => { timers++; return 1 }, cancel: () => {} })
  sampler.setActive(true); await turn(); sampler.setActive(false); sampler.setActive(true); await turn()
  expect(reads).toBe(1); expect(timers).toBe(0)
  expect(states.at(-1)).toMatchObject({ phase: 'unsupported', sample: null, message: '此引擎未提供运行时指标接口。' })
  sampler.retry(); await turn(); expect(reads).toBe(2); sampler.dispose()
})
test('remote PID is pinned after the first sample; an identity switch rejects late reads', async () => {
  let current = true, reads = 0, callback: (() => void) | undefined
  const states: EngineRuntimeState[] = []
  const sampler = createEngineRuntimeSampler({ target: { ...target, pid: null }, current: () => current, publish: state => states.push(state),
    read: async () => ok(runtimeFixture({ pid: ++reads === 1 ? 1234 : 4321, sampledAt: 1700000000000 + reads })),
    schedule: (next, delay) => { expect(delay).toBe(5000); callback = next; return 1 }, cancel: () => {} })
  sampler.setActive(true); await turn(); expect(states.at(-1)?.sample?.pid).toBe(1234)
  callback!(); await turn(); expect(states.at(-1)).toMatchObject({ phase: 'error', sample: null })
  current = false; const count = states.length; callback!(); await turn(); expect(states).toHaveLength(count)
  sampler.dispose()
})
