/** Delayed monitor reads must stay single-flight across hide/show, account
 * switches and unmount, without waiting for the next 30-second refresh. */
import { expect, test } from '@playwright/test'
import { createMonitorReadFlight } from '../src/renderer/src/contrib/work/monitor-read-flight'

test('a delayed old read wakes the new visible owner immediately without overlap', () => {
  const flight = createMonitorReadFlight()
  const first = flight.bind(() => { throw new Error('disposed owner woke') })
  const completeOld = first.acquire()!
  first.dispose()
  let resumed = 0, completeNew: (() => void) | null = null
  const next = flight.bind(() => { resumed++; completeNew = next.acquire() })
  expect(next.acquire()).toBeNull()
  completeOld()
  expect(resumed).toBe(1)
  expect(completeNew).not.toBeNull()
  expect(next.acquire()).toBeNull()
  completeOld()
  expect(resumed).toBe(1)
  completeNew!()
  expect(next.acquire()).not.toBeNull()
  next.dispose()
})

test('unmount prevents a late read from starting any further request', () => {
  const flight = createMonitorReadFlight()
  let wakes = 0
  const owner = flight.bind(() => { wakes++ })
  const complete = owner.acquire()!
  owner.dispose()
  complete()
  expect(wakes).toBe(0)
  expect(owner.acquire()).toBeNull()
})

test('old cleanup cannot remove a replacement account owner', () => {
  const flight = createMonitorReadFlight()
  const old = flight.bind(() => {})
  let wakes = 0
  const current = flight.bind(() => { wakes++ })
  old.dispose()
  expect(old.acquire()).toBeNull()
  const complete = current.acquire()
  expect(complete).not.toBeNull()
  complete!()
  expect(wakes).toBe(0)
  expect(current.acquire()).not.toBeNull()
  current.dispose()
})
