/** Main-process pull gate: no profiles or network, only actual cancellation and ACK behavior. */
import { expect, test } from '@playwright/test'
import { StreamAcknowledgement } from '../src/main/engine/stream-acknowledgement'
import { managementRequestTimeout, managementRequestSignal } from '../src/main/engine/request-timeout'

test('stream waits for the exact consumer ACK before delivering the next payload', async () => {
  const gate = new StreamAcknowledgement(), controller = new AbortController(), delivered: string[] = []
  let completed = false
  const delivery = (async () => {
    await gate.deliver(id => { delivered.push(id) }, controller.signal)
    await gate.deliver(id => { delivered.push(id) }, controller.signal)
    completed = true
  })()
  expect(delivered).toHaveLength(1); expect(completed).toBe(false)
  expect(gate.acknowledge('foreign-event')).toBe(false)
  expect(gate.acknowledge(delivered[0])).toBe(true)
  await expect.poll(() => delivered.length).toBe(2)
  expect(gate.acknowledge(delivered[0])).toBe(false)
  expect(completed).toBe(false)
  expect(gate.acknowledge(delivered[1])).toBe(true)
  await delivery; expect(completed).toBe(true)
})

test('cancellation releases a stalled ACK wait and cannot acknowledge a replacement stream', async () => {
  const gate = new StreamAcknowledgement(), controller = new AbortController()
  let pending = ''
  const delivery = gate.deliver(id => { pending = id }, controller.signal)
  const rejected = expect(delivery).rejects.toThrow('closed')
  controller.abort(new Error('closed')); await rejected
  expect(gate.acknowledge(pending)).toBe(false)
  const next = new StreamAcknowledgement(), fresh = new AbortController()
  let current = ''
  const replacement = next.deliver(id => { current = id }, fresh.signal)
  expect(next.acknowledge(pending)).toBe(false)
  expect(next.acknowledge(current)).toBe(true); await replacement
})

test('synchronous delivery failure cleans the outstanding ACK', async () => {
  const gate = new StreamAcknowledgement(), signal = new AbortController().signal
  await expect(gate.deliver(() => { throw new Error('window closed') }, signal)).rejects.toThrow('window closed')
  await gate.deliver(id => { expect(gate.acknowledge(id)).toBe(true) }, signal)
})

test('plugin task requests have no management deadline and still follow connection cancellation', () => {
  for (const path of ['/plugins/helper/capabilities/invoke', '/plugins/dev/source/invoke', '/plugins/runtime/apps/helper/invoke', '/plugins/helper/test']) {
    const input = { method: 'POST' as const, path }
    expect(managementRequestTimeout(input)).toBeNull()
    const controller = new AbortController(), signal = managementRequestSignal(input, controller.signal)
    expect(signal.aborted).toBe(false); controller.abort(); expect(signal.aborted).toBe(true)
  }
  expect(managementRequestTimeout({ method: 'GET', path: '/chat/status' })).toBe(5000)
})
