// Pure scheduling contracts: bounded requests, fairness, stale-scope gates and failure isolation.
import { expect, test } from '@playwright/test'
import type { SubagentRun } from '../src/shared/subagent'
import { executeSubagentRefreshBatch, subagentRefreshBatch } from '../src/renderer/src/core/engine/subagent-refresh'

// Scheduling reads identity/status only; complete protocol views are validated by the store.
const records = (count: number): SubagentRun[] => Array.from({ length: count }, (_, index) => ({
  runId: `child-${index}`, status: 'running'
} as SubagentRun))

test('later-page active child is visited with a maximum of eight reads per cycle', () => {
  const runs = records(96), seen = new Set<string>()
  let after: string | undefined
  for (let cycle = 0; cycle < 15; cycle++) {
    const batch = subagentRefreshBatch(runs, 'child-90', after)
    expect(batch.ids[0]).toBe('child-90')
    expect(batch.ids.length).toBeLessThanOrEqual(8)
    batch.ids.forEach(id => seen.add(id))
    after = batch.afterRunId
  }
  expect(seen.size).toBe(96)
})

test('bounded queue can move beyond its first 256 active identities', () => {
  const runs = records(600), seen = new Set<string>()
  let after: string | undefined
  for (let cycle = 0; cycle < 75; cycle++) {
    const batch = subagentRefreshBatch(runs, undefined, after)
    expect(batch.partial).toBe(true)
    batch.ids.forEach(id => seen.add(id))
    after = batch.afterRunId
  }
  expect(seen.size).toBe(600)
})

test('terminal selected record has priority without taking other terminal records into the queue', () => {
  const runs = records(12)
  runs[0] = { ...runs[0], status: 'succeeded' }
  runs[1] = { ...runs[1], status: 'cancelled' }
  const batch = subagentRefreshBatch(runs, 'child-0', 'removed')
  expect(batch.ids).toEqual(['child-0', 'child-2', 'child-3', 'child-4', 'child-5', 'child-6', 'child-7', 'child-8'])
})

test('a directory read can reserve one of the eight requests and oversized identities are partial', () => {
  const runs = records(12)
  expect(subagentRefreshBatch(runs, 'child-10', undefined, 7).ids).toHaveLength(7)
  runs[0] = { ...runs[0], runId: '多'.repeat(100000) }
  const batch = subagentRefreshBatch(runs, runs[0].runId, undefined)
  expect(batch.partial).toBe(true)
  expect(batch.ids).not.toContain(runs[0].runId)
  expect(batch.ids).toContain('child-1')
  expect(subagentRefreshBatch(records(96), undefined, undefined, Number.NaN).ids).toHaveLength(8)
})

test('two workers finish other reads after one fails and report the failure', async () => {
  let active = 0, maximum = 0
  const finished: string[] = []
  const failure = new Error('read failed')
  const operation = executeSubagentRefreshBatch(['a', 'b', 'c', 'd'], async id => {
    active++; maximum = Math.max(maximum, active)
    await new Promise<void>(resolve => setTimeout(resolve, 1))
    active--; finished.push(id)
    if (id === 'a') throw failure
  }, () => true)
  await expect(operation).rejects.toBe(failure)
  expect(maximum).toBe(2)
  expect(finished.sort()).toEqual(['a', 'b', 'c', 'd'])
})

test('a changed source permits in-flight reads to settle but starts no more reads', async () => {
  let current = true
  const started: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const operation = executeSubagentRefreshBatch(['a', 'b', 'c', 'd'], async id => {
    started.push(id); await gate
  }, () => current)
  expect(started).toEqual(['a', 'b'])
  current = false; release(); await operation
  expect(started).toEqual(['a', 'b'])
})
