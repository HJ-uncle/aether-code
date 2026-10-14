// Production store with synthetic IPC: known later-page state, request budgets, scope and single flight.
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import type { SubagentRunView } from '../src/shared/subagent'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import {
  forgetSubagentSession, getSubagentDirectory, getSubagentRuns, ingestSubagentRun, loadMoreSubagentRuns,
  refreshKnownActiveSubagents, refreshSubagentRun, refreshSubagentRuns, restartSubagentDirectory
} from '../src/renderer/src/core/engine/subagent-store'

const capabilities = { schemaVersion: 2, eventVersions: [2], views: ['summary'],
  toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
const success = (data: unknown) => ({ ok: true, code: 200, data, message: 'ok' })
function run(index: number, terminal = false): SubagentRunView {
  const seq = terminal ? 101 : 100
  return {
    schemaVersion: 2, view: 'summary', runId: `run-${index}`, tenantId: 'test-tenant', rootSessionId: 'root',
    parentSessionId: 'parent', parentConversationId: 'turn', parentMessageId: 'message',
    parentToolCallId: `dispatch-${index}`, childSessionId: `context-${index}`, task: 'Synthetic task',
    description: 'Synthetic task', modelId: 'fixture', status: terminal ? 'succeeded' : 'running',
    lastSeq: seq, createdAt: 1000, updatedAt: 2000 + seq, ...(terminal ? { finishedAt: 2101 } : {}),
    usage: { totalTokens: 42 }, toolCalls: [], toolCount: 0, activeToolCount: 0,
    coverage: { asOfSeq: seq, toolCount: 0, includedToolCount: 0, activeToolCount: 0,
      includedActiveToolCount: 0, ids: [], hasMore: false, truncated: false, completeness: 'complete' }
  }
}

let previousWindow: PropertyDescriptor | undefined
let previousNow: () => number
let sourceId = 0
let clock = 100000
function source(): void {
  publishEngineSource({ mode: 'embedded', baseUrl: '', instanceId: `refresh-store-${++sourceId}`, phase: 'ready' })
}
function bridge(request: (input: EngineRequestInput) => Promise<unknown>, observe?: (input: EngineRequestInput) => void): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      observe?.(input)
      return input.path === '/subagent/capabilities' ? success(capabilities) : success(await request(input))
    }
  } } } })
}
test.beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  previousNow = Date.now
  clock = 100000
  Date.now = () => clock
  source()
})
test.afterEach(() => {
  Date.now = previousNow
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('a later-page selected child advances through its real scoped GET without another task POST', async () => {
  const calls: EngineRequestInput[] = []
  const wireCalls: EngineRequestInput[] = []
  let active = 0, maximum = 0
  bridge(async input => {
    calls.push(input)
    if (input.path === '/subagent/runs') return {
      schemaVersion: 2, runs: Array.from({ length: 64 }, (_, index) => run(index)),
      revision: 'fixed-members', hasMore: true, listComplete: false, nextCursor: 'second-page'
    }
    active++; maximum = Math.max(maximum, active)
    await new Promise<void>(resolve => setTimeout(resolve, 1))
    active--
    const index = Number(input.path.replace('/subagent/runs/run-', ''))
    expect(input.query).toMatchObject({ parentSessionId: 'parent', rootSessionId: 'root', view: 'summary' })
    return run(index, index === 90)
  }, input => wireCalls.push(input))
  for (let index = 0; index < 96; index++) ingestSubagentRun(run(index))
  await Promise.all([
    refreshSubagentRuns('parent', { selectedRunId: 'run-90' }),
    refreshSubagentRuns('parent', { selectedRunId: 'run-90' })
  ])
  expect(wireCalls).toHaveLength(8)
  expect(wireCalls.filter(input => input.path === '/subagent/capabilities')).toHaveLength(1)
  expect(calls).toHaveLength(7)
  expect(calls.filter(input => input.path === '/subagent/runs')).toHaveLength(1)
  expect(calls.every(input => input.method === 'GET')).toBe(true)
  expect(maximum).toBe(2)
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-90')).toMatchObject({ status: 'succeeded', lastSeq: 101 })
  expect(getSubagentRuns('parent')).toHaveLength(96)
  const seen = new Set(calls.filter(input => input.path !== '/subagent/runs').map(input => input.path))
  // Capability negotiation and the head leave six actual summary slots.
  for (let cycle = 0; cycle < Math.ceil(96 / 6); cycle++) {
    clock += 5000
    const before = calls.length
    await refreshSubagentRuns('parent')
    expect(calls.length - before).toBeLessThanOrEqual(8)
    calls.slice(before).filter(input => input.path !== '/subagent/runs').forEach(input => seen.add(input.path))
  }
  expect(seen.size).toBe(96)
})

test('a source change rejects late observations and prevents starting the rest of the batch', async () => {
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  bridge(async input => {
    calls.push(input.path); await gate
    return run(Number(input.path.replace('/subagent/runs/run-', '')), true)
  })
  for (let index = 0; index < 96; index++) ingestSubagentRun(run(index))
  const pending = refreshKnownActiveSubagents('parent', 'run-90')
  await expect.poll(() => calls.length).toBe(2)
  source(); release(); await pending
  expect(calls).toHaveLength(2)
  expect(getSubagentRuns('parent')).toEqual([])
})

test('explicit card refreshes share one in-flight request', async () => {
  let count = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  bridge(async () => { count++; await gate; return run(0, true) })
  ingestSubagentRun(run(0))
  const first = refreshSubagentRun('run-0'), second = refreshSubagentRun('run-0')
  await expect.poll(() => count).toBe(1)
  release(); await Promise.all([first, second])
  expect(count).toBe(1)
  expect(getSubagentRuns('parent')[0].status).toBe('succeeded')
})

test('real opaque paging is single flight, retries the failed cursor and keeps partial semantics at the end', async () => {
  const cursors: Array<string | undefined> = []
  let failSecond = false
  bridge(async input => {
    const cursor = input.query?.cursor as string | undefined
    cursors.push(cursor)
    if (cursor === 'second' && failSecond) throw new Error('page unavailable')
    const start = cursor === 'second' ? 64 : cursor === 'third' ? 128 : 0
    return { schemaVersion: 2, runs: Array.from({ length: Math.min(64, 129 - start) }, (_, index) => run(start + index)),
      revision: 'fixed-members', listComplete: false, hasMore: start < 128,
      ...(start < 128 ? { nextCursor: start === 0 ? 'second' : 'third' } : {}) }
  })
  await restartSubagentDirectory('parent')
  const first = getSubagentDirectory('parent').directory
  expect(first?.ids).toHaveLength(64)
  failSecond = true
  await expect(loadMoreSubagentRuns('parent')).rejects.toThrow('page unavailable')
  expect(getSubagentDirectory('parent')).toMatchObject({ directory: first, loading: false, loadingMore: false })
  expect(getSubagentDirectory('parent').directory).toBe(first)
  expect(getSubagentRuns('parent')).toHaveLength(64)
  failSecond = false
  await Promise.all([loadMoreSubagentRuns('parent'), loadMoreSubagentRuns('parent')])
  expect(getSubagentRuns('parent')).toHaveLength(128)
  await loadMoreSubagentRuns('parent')
  expect(getSubagentRuns('parent')).toHaveLength(129)
  expect(getSubagentDirectory('parent').directory).toMatchObject({ endReached: true, partial: true, listComplete: false })
  expect(cursors).toEqual([undefined, 'second', 'second', 'third'])
})

test('return to first page queues after an in-flight ordinary read and remains single flight', async () => {
  let requests = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  bridge(async input => {
    if (input.path === '/subagent/runs/run-0') return run(0)
    requests++
    if (requests === 1) await gate
    return { schemaVersion: 2, runs: [run(0)], revision: 'fixed', listComplete: false, hasMore: true, nextCursor: 'more' }
  })
  const ordinary = refreshSubagentRuns('parent')
  await expect.poll(() => requests).toBe(1)
  const one = restartSubagentDirectory('parent'), two = restartSubagentDirectory('parent')
  release(); await Promise.all([ordinary, one, two])
  // The background active GET is independent of the directory restart.
  expect(getSubagentDirectory('parent').directory?.pages).toHaveLength(1)
  expect(requests).toBe(2)
})

test('forgetting another session does not permanently invalidate this directory', async () => {
  bridge(async () => ({ schemaVersion: 2, runs: [run(0)], revision: 'fixed', listComplete: true, hasMore: false }))
  await restartSubagentDirectory('parent')
  forgetSubagentSession('unrelated')
  await restartSubagentDirectory('parent')
  expect(getSubagentDirectory('parent')).toMatchObject({ loading: false, directory: { residentComplete: true } })
  expect(getSubagentRuns('parent')).toHaveLength(1)
})

test('a conflict anywhere in a page rejects the valid prefix and leaves its cursor unchanged', async () => {
  let conflicting = false
  bridge(async () => ({ schemaVersion: 2,
    runs: conflicting ? [run(0, true), { ...run(1), usage: { totalTokens: 99 } }] : [run(0), run(1)],
    revision: 'fixed', hasMore: true, listComplete: false, nextCursor: 'more' }))
  await restartSubagentDirectory('parent')
  const previous = getSubagentDirectory('parent').directory
  conflicting = true
  await expect(restartSubagentDirectory('parent')).rejects.toThrow('状态或序列冲突')
  expect(getSubagentDirectory('parent').directory).toBe(previous)
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-0')?.status).toBe('running')
})

test('a failed directory read still observes known active children and a conflicting targeted view is reported', async () => {
  let conflict = false
  bridge(async input => {
    if (input.path === '/subagent/runs') throw new Error('directory unavailable')
    return conflict ? { ...run(0), usage: { totalTokens: 99 } } : run(0, true)
  })
  ingestSubagentRun(run(0))
  await expect(refreshSubagentRuns('parent')).rejects.toThrow('directory unavailable')
  expect(getSubagentRuns('parent')[0].status).toBe('succeeded')
  source(); ingestSubagentRun(run(0)); conflict = true
  await expect(refreshSubagentRun('run-0')).rejects.toThrow('状态或序列冲突')
  expect(getSubagentRuns('parent')[0].usage).toEqual({ totalTokens: 42 })
})
