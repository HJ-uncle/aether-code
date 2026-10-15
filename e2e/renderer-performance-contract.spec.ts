/** Current page-performance contract: real zero versus unavailable, bounded
 * aggregates, no buffered entries, and cleanup guarding late callbacks. */
import { expect, test } from '@playwright/test'
import { parseRendererHeap, RENDERER_PERFORMANCE_INTERVAL_MS, startRendererPerformanceProbe, type RendererPerformanceSnapshot } from '../src/renderer/src/contrib/work/renderer-performance'

test('page memory remains a labelled estimate and rejects malformed or impossible samples', () => {
  expect(parseRendererHeap(undefined)).toBeNull()
  expect(parseRendererHeap({ usedJSHeapSize: NaN, totalJSHeapSize: 20, jsHeapSizeLimit: 30 })).toBeNull()
  expect(parseRendererHeap({ usedJSHeapSize: 30, totalJSHeapSize: 20, jsHeapSizeLimit: 40 })).toBeNull()
  expect(parseRendererHeap({ usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0 })).toBeNull()
  expect(parseRendererHeap({ usedJSHeapSize: 0, totalJSHeapSize: 20, jsHeapSizeLimit: 30 })).toEqual({ usedBytes: 0, totalBytes: 20, limitBytes: 30 })
})

test('long tasks aggregate only this visible epoch and disposal releases everything', () => {
  let now = 100, disconnected = 0, cancelled = 0
  let consume!: (entries: ReadonlyArray<{ startTime: number; duration: number }>) => void
  let tick!: () => void
  const snapshots: RendererPerformanceSnapshot[] = []
  const stop = startRendererPerformanceProbe({
    now: () => now,
    readHeap: () => ({ usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 30 }),
    observe: callback => { consume = callback; return () => { disconnected += 1 } },
    schedule: (callback, interval) => { expect(interval).toBe(RENDERER_PERFORMANCE_INTERVAL_MS); tick = callback; return () => { cancelled += 1 } }
  }, snapshot => snapshots.push(snapshot))
  expect(snapshots[0].longTasks).toEqual({ available: true, count: 0, totalMs: 0, maxMs: 0 })
  consume([{ startTime: 99, duration: 500 }, { startTime: 100, duration: 49 }, { startTime: 101, duration: 60 }, { startTime: 170, duration: 90 }, { startTime: 200, duration: Infinity }])
  now = 2_100; tick()
  expect(snapshots.at(-1)).toMatchObject({ observedMs: 2_000, longTasks: { available: true, count: 2, totalMs: 150, maxMs: 90 } })
  stop()
  consume([{ startTime: 2200, duration: 100 }]); tick()
  expect(snapshots).toHaveLength(2)
  expect([disconnected, cancelled]).toEqual([1, 1])
})

test('unsupported or denied telemetry remains unavailable without inventing healthy zeroes', () => {
  let snapshot: RendererPerformanceSnapshot | undefined
  const stop = startRendererPerformanceProbe({ now: () => 0, readHeap: () => { throw new Error('denied') }, observe: () => null, schedule: () => () => {} }, next => { snapshot = next })
  expect(snapshot?.heap).toBeNull()
  expect(snapshot?.longTasks.available).toBe(false)
  stop()
})
