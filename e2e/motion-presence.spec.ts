/** Pure animation lifecycle: cancellation, frame ordering and reduced motion.
 * No Electron or DOM; the production scheduler is exercised with a fake clock. */
import { expect, test } from '@playwright/test'
import { startMotionTransition, type MotionScheduler, type MotionState } from '../src/renderer/src/workbench/motion'

function clock() {
  let id = 0
  const frames = new Map<number, () => void>(), delays = new Map<number, { callback: () => void; milliseconds: number }>()
  const scheduler: MotionScheduler = {
    frame: callback => { frames.set(++id, callback); return id }, cancelFrame: key => { frames.delete(key) },
    delay: (callback, milliseconds) => { delays.set(++id, { callback, milliseconds }); return id }, cancelDelay: key => { delays.delete(key) }
  }
  return { scheduler, frames, delays, frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) } }
}

test('enter establishes its start style before the open frame', () => {
  const timer = clock(), states: MotionState[] = []
  const stop = startMotionTransition(true, false, timer.scheduler, state => states.push(state), () => { throw new Error('enter cannot exit') })
  expect(states).toEqual(['entering'])
  timer.frame(); expect(states).toEqual(['entering'])
  timer.frame(); expect(states).toEqual(['entering', 'open'])
  stop()
})

test('close retains content for 120ms, then exits exactly once', () => {
  const timer = clock(), states: MotionState[] = []
  let exits = 0
  startMotionTransition(false, false, timer.scheduler, state => states.push(state), () => { exits++ })
  expect(states).toEqual(['closing'])
  expect(exits).toBe(0)
  const pending = [...timer.delays.values()]
  expect(pending.map(item => item.milliseconds)).toEqual([120])
  pending[0].callback()
  expect(exits).toBe(1)
})

test('rapid reopening cancels an already queued exit and its stale callback', () => {
  const timer = clock(), states: MotionState[] = []
  let exits = 0
  const close = startMotionTransition(false, false, timer.scheduler, state => states.push(state), () => { exits++ })
  const stale = [...timer.delays.values()][0].callback
  close()
  const reopen = startMotionTransition(true, false, timer.scheduler, state => states.push(state), () => { exits++ })
  stale(); timer.frame(); timer.frame()
  expect(exits).toBe(0)
  expect(states).toEqual(['closing', 'entering', 'open'])
  expect(timer.delays.size).toBe(0)
  reopen()
})

test('closing during entry cannot receive a stale open frame', () => {
  const timer = clock(), states: MotionState[] = []
  const enter = startMotionTransition(true, false, timer.scheduler, state => states.push(state), () => {})
  timer.frame()
  const stale = [...timer.frames.values()][0]
  enter()
  startMotionTransition(false, false, timer.scheduler, state => states.push(state), () => {})
  stale()
  expect(states).toEqual(['entering', 'closing'])
})

test('reduced motion opens and dismisses without frames or timers', () => {
  const timer = clock(), states: MotionState[] = []
  let exits = 0
  startMotionTransition(true, true, timer.scheduler, state => states.push(state), () => { exits++ })
  startMotionTransition(false, true, timer.scheduler, state => states.push(state), () => { exits++ })
  expect(states).toEqual(['open', 'closing'])
  expect(exits).toBe(1)
  expect(timer.frames.size + timer.delays.size).toBe(0)
})

test('unmount cancels both pending entrance and exit work', () => {
  const timer = clock()
  const enter = startMotionTransition(true, false, timer.scheduler, () => {}, () => {})
  enter()
  const close = startMotionTransition(false, false, timer.scheduler, () => {}, () => { throw new Error('unmounted') })
  const stale = [...timer.delays.values()][0].callback
  close(); stale()
  expect(timer.frames.size + timer.delays.size).toBe(0)
})
