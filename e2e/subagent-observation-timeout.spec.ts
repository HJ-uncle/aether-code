/** Pure bridge contract: bounded observations abort their actual transport, never a detached race. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import { managementRequestSignal, managementRequestTimeout } from '../src/main/engine/request-timeout'

test('only discovery and exact summary GETs receive the child observation deadline', () => {
  for (const path of ['/subagent/discovery', '/api/v1/subagent/discovery', '/subagent/discovery?mode=active']) {
    expect(managementRequestTimeout({ method: 'GET', path })).toBe(5000)
    expect(managementRequestTimeout({ method: 'GET', path, timeoutMs: 0 })).toBe(5000)
  }
  for (const path of ['/subagent/runs/run-75', '/api/v1/subagent/runs/run%2F75'])
    expect(managementRequestTimeout({ method: 'GET', path, query: { view: 'summary' } })).toBe(5000)
  const excluded: EngineRequestInput[] = [
    { method: 'POST', path: '/subagent/discovery' },
    { method: 'POST', path: '/subagent/runs/run-75/cancel', query: { view: 'summary' } },
    { method: 'DELETE', path: '/subagent/runs/run-75', query: { view: 'summary' } },
    { method: 'GET', path: '/subagent/runs', query: { view: 'summary' } },
    { method: 'GET', path: '/subagent/runs/run-75' },
    { method: 'GET', path: '/subagent/runs/run-75', query: { view: 'legacy' } },
    { method: 'GET', path: '/subagent/runs/run-75?view=summary' },
    { method: 'GET', path: '/subagent/runs/run-75/tools', query: { view: 'summary' } },
    { method: 'GET', path: '/subagent/runs/run-75/events', query: { view: 'summary' } },
    { method: 'GET', path: '/subagent/runs/run-75/tools/tool-1', query: { view: 'summary' } },
    { method: 'GET', path: '/subagent/capabilities' },
    { method: 'GET', path: '/subagent/discovery/other' }
  ]
  for (const input of excluded) expect(managementRequestTimeout({ ...input, timeoutMs: 0 })).toBe(120000)
})

test('source teardown reaches each observation signal without cancelling an unrelated connection', () => {
  for (const input of [{ method: 'GET' as const, path: '/subagent/discovery' },
    { method: 'GET' as const, path: '/subagent/runs/run-75', query: { view: 'summary' } }]) {
    const source = new AbortController()
    const other = new AbortController()
    const signal = managementRequestSignal(input, source.signal)
    const reason = new Error('Synthetic source replaced')
    source.abort(reason)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
    expect(other.signal.aborted).toBe(false)
  }
})

test('a stalled transport stays in flight until the native observation signal aborts', async () => {
  const connection = new AbortController()
  const signal = managementRequestSignal({ method: 'GET', path: '/subagent/discovery' }, connection.signal)
  let inFlight = 1
  let settled = false
  const transport = new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }).finally(() => { settled = true; inFlight-- })
  const rejection = expect(transport).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(settled).toBe(false)
  expect(inFlight).toBe(1)
  await rejection
  expect(signal.aborted).toBe(true)
  expect(settled).toBe(true)
  expect(inFlight).toBe(0)
})
