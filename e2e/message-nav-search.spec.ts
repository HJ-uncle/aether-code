/** Pure navigation search: preserve ordered-prefix selection while bounding
 * geometry reads for large transcripts; no Electron or engine is launched. */
import { expect, test } from '@playwright/test'
import { resolveActiveNavId, resolveOrderedNavIndex } from '../src/renderer/src/features/conversation/shared/message-nav'

test('ordered search preserves the linear prefix rule at boundaries and equal tops', () => {
  const anchors = [-18.5, 0, 0, 35.25, 190, 190, 740].map((top, index) => ({ id: `turn-${index}`, top }))
  for (const probe of [-100, -18.5, -18.49, -.01, 0, .01, 35.249, 35.25, 189.99, 190, 740, 10000]) {
    const index = resolveOrderedNavIndex(anchors.length, probe, index => anchors[index].top)
    expect(anchors[index]?.id ?? null, `probe ${probe}`).toBe(resolveActiveNavId(anchors, probe))
  }
  expect(resolveOrderedNavIndex(0, 0, () => { throw new Error('Empty lists must not read geometry') })).toBe(-1)
})

test('1000 ordered turns use at most ten lazy geometry reads for any active turn', () => {
  const anchors = Array.from({ length: 1000 }, (_, index) => ({ id: `turn-${index}`, top: index * 31.5 }))
  for (const probe of [-1, ...anchors.flatMap(anchor => [anchor.top, anchor.top + 15.75]), 100000]) {
    const reads: number[] = []
    const index = resolveOrderedNavIndex(anchors.length, probe, index => { reads.push(index); return anchors[index].top })
    expect(anchors[index]?.id ?? null).toBe(resolveActiveNavId(anchors, probe))
    expect(reads.length, `geometry reads for ${probe}`).toBeLessThanOrEqual(10)
    expect(new Set(reads).size).toBe(reads.length)
  }
})

test('a fresh search follows disclosure height changes and does not reuse stale offsets', () => {
  const tops = [0, 90, 180, 270]
  expect(resolveOrderedNavIndex(tops.length, 200, index => tops[index])).toBe(2)
  // Opening the first turn pushes every later anchor below the reading probe.
  for (let index = 1; index < tops.length; index++) tops[index] += 350
  expect(resolveOrderedNavIndex(tops.length, 200, index => tops[index])).toBe(0)
  expect(resolveOrderedNavIndex(tops.length, 800, index => tops[index])).toBe(3)
})
