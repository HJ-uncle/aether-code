/** Pure presentation-generation contract; background tab/session state is independent. */
import { expect, test } from '@playwright/test'
import { BrowserSurfaceOwnership } from '../src/main/browser/surface-ownership'

test('desktop startup and renderer reload require a fresh presentation owner', () => {
  const gate = new BrowserSurfaceOwnership()
  expect(gate.accepts()).toBe(true) // Standalone native host, without desktop IPC.
  gate.reset()
  expect(gate.accepts()).toBe(false)
  expect(gate.accepts({ mode: 'code', generation: 0 })).toBe(false)
  expect(gate.activate({ mode: 'work', generation: 1 })).toBe(true)
  expect(gate.accepts({ mode: 'work', generation: 1 })).toBe(true)
  gate.reset()
  expect(gate.accepts({ mode: 'work', generation: 1 })).toBe(false)
  expect(gate.activate({ mode: 'code', generation: 1 })).toBe(true)
})

test('mode switches reject stale shows and stale hides including a same-mode round trip', () => {
  const gate = new BrowserSurfaceOwnership()
  const code = { mode: 'code' as const, generation: 1 }, work = { mode: 'work' as const, generation: 2 }, returned = { mode: 'code' as const, generation: 3 }
  gate.activate(code)
  expect(gate.activate(work)).toBe(true)
  expect(gate.accepts(code)).toBe(false)
  expect(gate.accepts(work)).toBe(true)
  expect(gate.activate(returned)).toBe(true)
  expect(gate.accepts(code)).toBe(false)
  expect(gate.accepts(work)).toBe(false)
  expect(gate.accepts(returned)).toBe(true)
  expect(gate.activate(code)).toBe(false)
  expect(gate.activate({ mode: 'work', generation: 3 })).toBe(false)
  expect(gate.activate(returned)).toBe(false) // Repeated initialization must not hide a current page.
  expect(gate.accepts(returned)).toBe(true)
})

test('invalid generations cannot acquire presentation and mutation cannot change an admitted owner', () => {
  const gate = new BrowserSurfaceOwnership()
  const owner = { mode: 'code' as const, generation: 5 }
  gate.activate(owner); owner.generation = 99
  expect(gate.accepts({ mode: 'code', generation: 5 })).toBe(true)
  for (const generation of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => gate.activate({ mode: 'code', generation })).toThrow('代次无效')
  }
})
