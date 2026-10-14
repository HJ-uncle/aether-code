/** Actual replay inputs stay bounded while immutable child snapshots share storage. */
import { test, expect } from '@playwright/test'
import { createPublishedHydrationBuffer } from '../src/renderer/src/core/engine/published-hydration-buffer'

test('each throttled frame owns one slot, so one unflushed batch cannot retain unlimited callbacks', () => {
  let stops = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ } })
  for (let frame = 0; frame < 1024; frame++) buffer.record(value => value + 'x')
  const queued = buffer.rebase('archived')
  expect(buffer.valid()).toBe(true)
  buffer.record(value => value + 'excess')
  expect(stops).toBe(1)
  expect(queued('live')).toBe('live')
  buffer.record(value => value + 'still live')
  expect(stops).toBe(1)
})

test('shared immutable child graphs are counted once without serializing the full transcript per frame', () => {
  let stops = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ }, maxBytes: 32768 })
  const child = { runId: 'child', partialOutput: 'x'.repeat(4096), toolCalls: [] }
  for (let frame = 0; frame < 1000; frame++) buffer.account(child)
  expect(stops).toBe(0)
  expect(buffer.valid()).toBe(true)
})

test('new inventory arrays consume reference storage even when every child object is shared', () => {
  let stops = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ }, maxBytes: 32768 })
  const children = Array.from({ length: 64 }, (_, index) => ({ runId: String(index) }))
  for (let frame = 0; frame < 1000; frame++) buffer.account([...children])
  expect(stops).toBe(1)
  expect(buffer.valid()).toBe(false)
})

test('a tiny raw delta cannot hide its much larger resulting immutable child snapshot', () => {
  let stops = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ }, maxBytes: 16384 })
  buffer.account({ type: 'text', delta: 'x' })
  buffer.account({ runId: 'child', partialOutput: 'x'.repeat(16384) })
  expect(stops).toBe(1)
  expect(buffer.valid()).toBe(false)
})

for (const text of ['a'.repeat(256), '汉'.repeat(256), '😀'.repeat(256), '\ud800'.repeat(256), '\u0000'.repeat(256)]) {
  test(`retained input never undercounts JSON UTF-8 for ${JSON.stringify(text.slice(0, 2))}`, () => {
    let stops = 0
    const bytes = new TextEncoder().encode(JSON.stringify(text)).byteLength
    const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ }, maxBytes: bytes - 1 })
    buffer.account(text)
    expect(stops).toBe(1)
  })
}

test('the accounting path does not invoke JSON serialization or accessors from retained input', () => {
  let stops = 0, reads = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ } })
  const stringify = JSON.stringify
  try {
    JSON.stringify = () => { throw Error('accounting attempted a full JSON serialization') }
    buffer.account({ content: 'large'.repeat(10000), nested: { okay: true } })
  } finally { JSON.stringify = stringify }
  expect(buffer.valid()).toBe(true)
  buffer.account(Object.defineProperty({}, 'content', { enumerable: true, get: () => { reads++; return 'hidden' } }))
  expect(reads).toBe(0)
  expect(stops).toBe(1)
})

test('cycles and shared references finish in finite work and still count each new reference array', () => {
  let stops = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ }, maxBytes: 8192 })
  const value: { self?: object } = {}
  value.self = value
  buffer.account(value)
  expect(buffer.valid()).toBe(true)
  for (let count = 0; count < 100; count++) buffer.account([value])
  expect(stops).toBe(1)
})
