/** Pure presentation-generation contract; background tab/session state is independent. */
import { expect, test } from '@playwright/test'
import { BrowserPresentationRegistry, BrowserSurfaceOwnership } from '../src/main/browser/surface-ownership'

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

test('same-mode session and engine changes fence stale geometry and foreign pages', () => {
  const gate = new BrowserSurfaceOwnership()
  const first = { mode: 'work' as const, sessionId: 'first', engineId: 'engine-a', generation: 1 }
  const second = { ...first, sessionId: 'second', generation: 2 }
  gate.activate(first)
  expect(gate.canPresent(first)).toBe(true)
  expect(gate.canPresent({ ...first, mode: 'code' })).toBe(false)
  expect(gate.canPresent(undefined)).toBe(false)
  gate.activate(second)
  expect(gate.accepts(first)).toBe(false)
  expect(gate.accepts({ ...second, sessionId: 'first' })).toBe(false)
  expect(gate.accepts({ ...second, engineId: 'engine-b' })).toBe(false)
  expect(gate.canPresent(first)).toBe(false)
  expect(gate.canPresent(second)).toBe(true)
  const copy = gate.currentPresentation()!
  copy.sessionId = 'outside'
  expect(gate.currentPresentation()).toEqual({ mode: 'work', sessionId: 'second', engineId: 'engine-a' })
})

test('unbound offline pages are visible only in their exact null-session surface', () => {
  const gate = new BrowserSurfaceOwnership()
  gate.reset()
  gate.activate({ mode: 'code', sessionId: null, generation: 1 })
  expect(gate.canPresent({ mode: 'code', sessionId: null })).toBe(true)
  expect(gate.canPresent({ mode: 'work', sessionId: null })).toBe(false)
  expect(gate.canPresent({ mode: 'code', sessionId: 'first' })).toBe(false)
  expect(gate.canPresent({ mode: 'code', sessionId: null, engineId: 'other' })).toBe(false)
})

test('offline source switches fence display without creating an AI engine identity', () => {
  const gate = new BrowserSurfaceOwnership()
  const first = { mode: 'code' as const, sessionId: 'same', pendingSourceId: 'server-a/account-a', generation: 1 }
  const second = { ...first, pendingSourceId: 'server-b/account-a', generation: 2 }
  gate.activate(first)
  expect(gate.currentPresentation()).toEqual({ mode: 'code', sessionId: 'same', pendingSourceId: first.pendingSourceId })
  expect(gate.canPresent(first)).toBe(true)
  gate.activate(second)
  expect(gate.accepts(first)).toBe(false)
  expect(gate.canPresent(first)).toBe(false)
  expect(gate.canPresent(second)).toBe(true)
  expect(gate.canPresent({ ...second, pendingSourceId: 'server-b/account-b' })).toBe(false)
  expect(gate.currentPresentation()?.engineId).toBeUndefined()
  expect(() => gate.activate({ ...second, generation: 3, engineId: 'cannot-mix-authority' })).toThrow('展示归属无效')
})

test('context presentation registry keeps background context authority and display mode separate', () => {
  const registry = new BrowserPresentationRegistry(), context = { sessionId: 'work-task', engineId: 'engine-one' }
  expect(registry.get(context)).toBeUndefined()
  expect(registry.remember(context, 'work')).toEqual({ ...context, mode: 'work' })
  expect(context).toEqual({ sessionId: 'work-task', engineId: 'engine-one' })
  expect(registry.get({ ...context, sessionId: 'other' })).toBeUndefined()
  expect(registry.get({ ...context, engineId: 'engine-two' })).toBeUndefined()
  expect(() => registry.remember(context, 'code')).toThrow('不同的展示模式')
  const copy = registry.get(context)!
  copy.mode = 'code'
  expect(registry.get(context)?.mode).toBe('work')
  registry.clear()
  expect(registry.get(context)).toBeUndefined()
})
