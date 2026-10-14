/** Production discovery store + synthetic IPC; no listener, Electron, credentials or models. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import type { SubagentDiscoveryPage, SubagentDiscoveryRef, SubagentRunView } from '../src/shared/subagent'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import { captureSubagentConnection, cancelSubagentRun, getSubagentCapabilities, listSubagentDiscovery } from '../src/renderer/src/core/engine/client'
import { captureSubagentRunScope, forgetSubagentSession, getSubagentDiscovery, getSubagentDiscoveryStats, getSubagentRuns, ingestSubagentRun,
  refreshSubagentRuns, refreshSubagentRun, requestSubagentCancellation, restartSubagentDirectory, getSubagentDirectory } from '../src/renderer/src/core/engine/subagent-store'
import { subscribeSubagentDeletions } from '../src/renderer/src/core/engine/subagent-store'

const capabilities = { schemaVersion: 2, eventVersions: [2], views: ['summary'], toolPagination: true,
  eventPagination: true, detailChunks: true, exactWatermarks: true, activeDiscovery: true, lifecycleChanges: true, discoveryProtocol: 1 }
const success = (data: unknown) => ({ ok: true, code: 200, message: 'ok', data })
function run(index: number, status: SubagentRunView['status'] = 'running', lastSeq = 100): SubagentRunView {
  return { schemaVersion: 2, view: 'summary', runId: `run-${index}`, tenantId: 'tenant', parentSessionId: 'parent',
    rootSessionId: 'root', parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: `dispatch-${index}`,
    childSessionId: `child-${index}`, modelId: 'model', createdAt: 1000, updatedAt: 1000 + lastSeq,
    task: `Real synthetic task ${index}`, description: 'Actual summary', status, lastSeq, usage: { totalTokens: 42 },
    toolCalls: [], toolCount: 0, activeToolCount: 0, coverage: { asOfSeq: lastSeq, toolCount: 0, activeToolCount: 0,
      includedToolCount: 0, includedActiveToolCount: 0, ids: [], hasMore: false, truncated: false, completeness: 'complete' } }
}
function ref(index: number, status: SubagentDiscoveryRef['status'] = 'running', revision = index, runSeq = 100): SubagentDiscoveryRef {
  const full = run(index, status, runSeq)
  return { runId: full.runId, tenantId: full.tenantId, parentSessionId: full.parentSessionId, rootSessionId: full.rootSessionId,
    parentConversationId: full.parentConversationId, parentMessageId: full.parentMessageId, parentToolCallId: full.parentToolCallId,
    childSessionId: full.childSessionId, modelId: full.modelId, createdAt: full.createdAt, status, revision,
    createdRevision: index, runSeq, deleted: false }
}
function page(mode: 'active' | 'changes', items: SubagentDiscoveryRef[], options: Partial<SubagentDiscoveryPage> = {}): SubagentDiscoveryPage {
  return { protocolVersion: 1, source: 'durable-lifecycle', generation: 'G1', scope: { tenantId: 'tenant', parentSessionId: 'parent' },
    mode, asOfRevision: 129, floorRevision: 0, activeCount: 1, items, includedCount: items.length, scannedCount: items.length,
    hasMore: false, nextCursor: null, membershipCompleteness: 'complete', ...(mode === 'changes' ? { nextRevision: 129 } : {}), ...options }
}
let previousWindow: PropertyDescriptor | undefined
let previousNow: () => number
let sourceId = 0, clock = 100000
let calls: EngineRequestInput[] = []
let inFlight = 0, maximum = 0
function source(): void { publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: `discovery-${++sourceId}` }) }
function bridge(read: (input: EngineRequestInput) => Promise<unknown>, capabilityRead?: () => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      calls.push(input); inFlight++; maximum = Math.max(maximum, inFlight)
      try { return input.path === '/subagent/capabilities' ? capabilityRead ? await capabilityRead() : success(capabilities) : success(await read(input)) }
      finally { inFlight-- }
    }
  } } } })
}
test.beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); previousNow = Date.now
  clock = 100000; Date.now = () => clock; calls = []; inFlight = 0; maximum = 0; source()
})
test.afterEach(() => {
  Date.now = previousNow
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('A01: zero-known active discovers run75 directly and only its real scoped summary becomes a view', async () => {
  bridge(async input => {
    if (input.path === '/subagent/discovery') return page(input.query?.mode as 'active' | 'changes', input.query?.mode === 'active' ? [ref(75)] : [])
    expect(input.path).toBe('/subagent/runs/run-75')
    expect(input.query).toMatchObject({ parentSessionId: 'parent', rootSessionId: 'root', parentConversationId: 'turn', view: 'summary' })
    return run(75)
  })
  expect(getSubagentRuns('parent')).toEqual([])
  await refreshSubagentRuns('parent')
  expect(getSubagentRuns('parent')).toHaveLength(1)
  expect(getSubagentRuns('parent')[0]).toMatchObject({ runId: 'run-75', status: 'running', task: 'Real synthetic task 75', usage: { totalTokens: 42 } })
  expect(calls.every(input => input.method === 'GET')).toBe(true)
  expect(calls.some(input => input.path === '/subagent/runs')).toBe(false)
  expect(calls.length).toBeLessThanOrEqual(8)
  expect(calls.filter(input => input.path === '/subagent/capabilities')).toHaveLength(1)
})

test('A02/A09: 129 active cursor progresses while selected, known and pending reads share a real eight budget', async () => {
  const activeCursors: Array<string | undefined> = []
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'changes') return page('changes', [], { activeCount: 129 })
      const cursor = input.query?.cursor as string | undefined
      activeCursors.push(cursor)
      const first = cursor === 'p2' ? 65 : cursor === 'p3' ? 129 : 1
      const count = first === 129 ? 1 : 64
      return page('active', Array.from({ length: count }, (_, i) => ref(first + i)), { activeCount: 129,
        ...(first < 129 ? { hasMore: true, nextCursor: first === 1 ? 'p2' : 'p3', membershipCompleteness: 'partial' } : {}) })
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1))
    return run(Number(input.path.split('run-')[1]))
  })
  ingestSubagentRun(run(150))
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = calls.length
    await Promise.all([refreshSubagentRuns('parent'), refreshSubagentRuns('parent', { selectedRunId: 'run-150' })])
    const wire = calls.slice(before)
    expect(wire.length).toBeLessThanOrEqual(8)
    expect(wire.some(input => input.path === '/subagent/runs/run-150')).toBe(true)
    expect(wire.some(input => input.path === '/subagent/discovery')).toBe(true)
    expect(wire.some(input => /^\/subagent\/runs\/run-\d+$/.test(input.path) && input.path !== '/subagent/runs/run-150')).toBe(true)
    clock += 5000
  }
  expect(activeCursors).toEqual([undefined, 'p2', 'p3'])
  expect(getSubagentDiscovery('parent').state).toMatchObject({ activeCount: 129, residentPartial: true, baseline: { complete: true } })
  expect(maximum).toBeLessThanOrEqual(2)
  expect(inFlight).toBe(0)
})

test('A04: a run created and completed between polls is hydrated from changes, without another task submission', async () => {
  let polling = 0
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'active') return page('active', [], { activeCount: 0 })
      polling++
      return polling === 1 ? page('changes', [], { activeCount: 0 }) : page('changes',
        [ref(130, 'queued', 130, 1), ref(130, 'running', 131, 2), ref(130, 'succeeded', 132, 3)],
        { asOfRevision: 132, nextRevision: 132, activeCount: 0 })
    }
    return run(130, 'succeeded', 3)
  })
  await refreshSubagentRuns('parent'); clock += 5000; await refreshSubagentRuns('parent')
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-130')).toMatchObject({ status: 'succeeded', lastSeq: 3, usage: { totalTokens: 42 } })
  expect(calls.every(input => input.method === 'GET')).toBe(true)
})

test('A03: changes hydrate a terminal child before its held old W tail and preserve another run of the same child', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let changed = false, changesRead = 0
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'active') {
        if (input.query.cursor) { await held; return page('active', [ref(75)]) }
        return page('active', [ref(1)], { hasMore: true, nextCursor: 'held-old-tail', membershipCompleteness: 'partial' })
      }
      changesRead++
      if (changesRead === 1) return page('changes', [])
      changed = true
      return page('changes', [ref(75, 'cancelled', 130, 102), { ...ref(76, 'running', 131), createdRevision: 131, childSessionId: 'child-75' }],
        { asOfRevision: 131, nextRevision: 131, activeCount: 2 })
    }
    const index = Number(input.path.split('run-')[1])
    return index === 75 && changed ? run(75, 'cancelled', 102) : index === 76 ? { ...run(76), childSessionId: 'child-75' } : run(index)
  })
  await refreshSubagentRuns('parent'); clock += 5000
  const second = refreshSubagentRuns('parent')
  await expect.poll(() => getSubagentRuns('parent').find(item => item.runId === 'run-75')?.status).toBe('cancelled')
  release(); await second
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-75')).toMatchObject({ status: 'cancelled', lastSeq: 102 })
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-76')).toMatchObject({ status: 'running', childSessionId: 'child-75' })
  expect(getSubagentDiscovery('parent').state?.activeCount).toBe(2)
  expect(calls.every(input => input.method === 'GET')).toBe(true)
  expect(maximum).toBeLessThanOrEqual(2)
})

test('an explicit stop targets its frozen run rather than the resumed run of the same child', async () => {
  const old = run(75), resumed = { ...run(76), childSessionId: 'child-75' }
  ingestSubagentRun(old); ingestSubagentRun(resumed)
  const exact = captureSubagentRunScope(old)
  bridge(async input => {
    expect(input).toMatchObject({ method: 'POST', path: '/subagent/runs/run-75/cancel',
      query: { parentSessionId: 'parent', rootSessionId: 'root', parentConversationId: 'turn', view: 'summary' } })
    return run(75, 'cancelling', 101)
  })
  await requestSubagentCancellation('run-75', exact)
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-75')?.status).toBe('cancelling')
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-76')?.status).toBe('running')
  expect(calls.filter(input => input.method === 'POST')).toHaveLength(1)
})

test('A05: active absence and failed accurate GET retain the real view with stale health', async () => {
  ingestSubagentRun(run(75))
  bridge(async input => {
    if (input.path === '/subagent/discovery') return page(input.query?.mode as 'active' | 'changes', [], { activeCount: 0 })
    if (input.path === '/subagent/runs') return { schemaVersion: 2, runs: [], revision: 'empty', hasMore: false, listComplete: true }
    throw new Error('Synthetic summary stalled')
  })
  await expect(refreshSubagentRuns('parent')).rejects.toThrow('summary stalled')
  expect(getSubagentDiscovery('parent')).toMatchObject({ stale: true, loading: false, error: 'Synthetic summary stalled' })
  await restartSubagentDirectory('parent')
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-75')).toMatchObject({ status: 'running', lastSeq: 100 })
  expect(calls.every(input => input.method === 'GET')).toBe(true)
})

test('A06: a failed later baseline retains its cursor and retries the exact page next cycle', async () => {
  let failed = false
  const cursors: Array<string | undefined> = []
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'changes') return page('changes', [])
      const cursor = input.query?.cursor as string | undefined; cursors.push(cursor)
      if (cursor && !failed) { failed = true; throw new Error('Synthetic page fault') }
      return cursor ? page('active', [ref(75)]) : page('active', [ref(1)],
        { hasMore: true, nextCursor: 'tail', membershipCompleteness: 'partial' })
    }
    return run(Number(input.path.split('run-')[1]))
  })
  await refreshSubagentRuns('parent'); clock += 5000
  await expect(refreshSubagentRuns('parent')).rejects.toThrow('page fault')
  expect(getSubagentDiscovery('parent').state?.baseline?.cursor).toBe('tail')
  clock += 5000; await refreshSubagentRuns('parent')
  expect(cursors).toEqual([undefined, 'tail', 'tail'])
  expect(getSubagentRuns('parent').some(item => item.runId === 'run-75')).toBe(true)
})

test('A07: a stale source capability response cannot send cancellation to the new engine', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  bridge(async () => { throw new Error('No mutation allowed') }, async () => { await held; return success(capabilities) })
  const connection = captureSubagentConnection()
  const cancel = cancelSubagentRun('run-75', { parentSessionId: 'parent', connection })
  await expect.poll(() => calls.length).toBe(1)
  source(); release()
  await expect(cancel).rejects.toThrow('连接已变化')
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe('GET')
})

test('A07: forgetting a parent during capability await rejects the frozen cancel before POST', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const full = run(75); ingestSubagentRun(full)
  const scope = captureSubagentRunScope(full)
  bridge(async () => { throw new Error('No mutation allowed') }, async () => { await held; return success(capabilities) })
  const cancel = requestSubagentCancellation('run-75', scope)
  await expect.poll(() => calls.length).toBe(1)
  forgetSubagentSession('parent'); release()
  await expect(cancel).rejects.toThrow('归属已变化')
  expect(calls).toHaveLength(1)
})

test('A07: an old baseline released last cannot clear the new source cycle or create an old run', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const oldInstance = captureSubagentConnection().expectedEngine?.instanceId
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.expectedEngine?.instanceId === oldInstance) { await held; return page('active', [ref(75)]) }
      return page(input.query?.mode as 'active' | 'changes', input.query?.mode === 'active' ? [ref(76)] : [], { generation: 'G2' })
    }
    return run(76)
  })
  const old = refreshSubagentRuns('parent')
  await expect.poll(() => calls.some(input => input.path === '/subagent/discovery')).toBe(true)
  source()
  await refreshSubagentRuns('parent')
  release()
  await old
  expect(calls.filter(input => input.expectedEngine?.instanceId === oldInstance).map(input => input.path))
    .toEqual(['/subagent/capabilities', '/subagent/discovery'])
  expect(getSubagentRuns('parent').map(item => item.runId)).toEqual(['run-76'])
  expect(getSubagentDiscovery('parent')).toMatchObject({ loading: false, state: { generation: 'G2' } })
  expect(maximum).toBeLessThanOrEqual(2)
})

test('cold capability auth failures are not retried seven times or interpreted as an empty complete discovery', async () => {
  bridge(async () => { throw new Error('No run read allowed') }, async () => ({ ok: false, code: 401, data: null, message: 'Synthetic sign in required' }))
  await expect(refreshSubagentRuns('parent')).rejects.toThrow('sign in required')
  expect(calls).toHaveLength(1)
  expect(getSubagentDiscovery('parent')).toMatchObject({ stale: true, loading: false })
  expect(getSubagentDiscovery('parent').state).toBeUndefined()
})

test('a run without a verified parent cannot trigger an unscoped exact read or cancellation', async () => {
  bridge(async () => { throw new Error('No wire read allowed') })
  await expect(refreshSubagentRun('unknown')).rejects.toThrow('准确会话归属')
  await expect(requestSubagentCancellation('unknown')).rejects.toThrow('准确会话归属')
  expect(calls).toEqual([])
})

test('declared unsupported discovery leaves the existing v2 directory available', async () => {
  bridge(async () => ({ schemaVersion: 2, runs: [], revision: 'none', hasMore: false, listComplete: true }),
    async () => success({ ...capabilities, activeDiscovery: false, lifecycleChanges: false }))
  expect(await getSubagentCapabilities()).toEqual({ protocol: 2, discovery: false })
  await refreshSubagentRuns('parent')
  expect(getSubagentDiscovery('parent').supported).toBe(false)
  expect(calls.some(input => input.path === '/subagent/runs')).toBe(true)
  expect(calls.some(input => input.path === '/subagent/discovery')).toBe(false)
})

test('a server cannot exceed this discovery request limit through included or filtered scanned rows', async () => {
  bridge(async input => input.query?.mode === 'active' ? page('active', [ref(1), ref(2), ref(3)], { activeCount: 3 })
    : page('changes', [], { scannedCount: 3 }))
  await expect(listSubagentDiscovery({ parentSessionId: 'parent' }, { mode: 'active', limit: 2 })).rejects.toThrow('超过请求分页预算')
  await expect(listSubagentDiscovery({ parentSessionId: 'parent' }, { mode: 'changes', afterRevision: 129, limit: 2 })).rejects.toThrow('超过请求分页预算')
  expect(calls.filter(input => input.path === '/subagent/discovery')).toHaveLength(2)
  expect(getSubagentRuns('parent')).toEqual([])
  const before = calls.length
  await expect(listSubagentDiscovery({ parentSessionId: 'parent' }, { mode: 'active', limit: 201 })).rejects.toThrow('分页预算无效')
  expect(calls.length).toBe(before)
})

test('A08: an oversized or invalid discovery failure is not recursively retried as empty complete', async () => {
  ingestSubagentRun(run(75))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      calls.push(input)
      if (input.path === '/subagent/capabilities') return success(capabilities)
      if (input.path === '/subagent/discovery') return { ok: false, code: 409, message: 'Synthetic oversized identity',
        data: { discoveryRequired: true, reason: 'oversized_identity' } }
      return success(run(75))
    }
  } } } })
  await expect(refreshSubagentRuns('parent')).rejects.toThrow('oversized identity')
  expect(calls.filter(input => input.path === '/subagent/discovery')).toHaveLength(1)
  expect(getSubagentDiscovery('parent')).toMatchObject({ stale: true, loading: false })
  expect(getSubagentDiscovery('parent').state?.baseline).toBeUndefined()
  expect(getSubagentRuns('parent')[0].status).toBe('running')
})

test('A07: server generation recovery quarantines an old identity until the reused ID has a new scoped summary', async () => {
  let serverGeneration = 'G1', announceRecovery = false
  const replacement = { ...run(75, 'running', 1), childSessionId: 'new-child', parentConversationId: 'new-turn',
    parentToolCallId: 'new-dispatch', task: 'Verified new generation task' }
  const replacementRef = { ...ref(75, 'running', 1, 1), createdRevision: 1, childSessionId: replacement.childSessionId,
    parentConversationId: replacement.parentConversationId, parentToolCallId: replacement.parentToolCallId }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      calls.push(input)
      if (input.path === '/subagent/capabilities') return success(capabilities)
      if (input.path === '/subagent/discovery') {
        if (announceRecovery) {
          announceRecovery = false
          return { ok: false, code: 409, message: 'Synthetic generation changed', data: { discoveryRequired: true, reason: 'generation_changed' } }
        }
        return success(serverGeneration === 'G1'
          ? page(input.query?.mode as 'active' | 'changes', input.query?.mode === 'active' ? [ref(75)] : [])
          : page(input.query?.mode as 'active' | 'changes', input.query?.mode === 'active' ? [replacementRef] : [],
            { generation: 'G2', asOfRevision: 1, ...(input.query?.mode === 'changes' ? { nextRevision: 1 } : {}) }))
      }
      expect(input.method).toBe('GET')
      return success(serverGeneration === 'G1' ? run(75) : replacement)
    }
  } } } })
  await refreshSubagentRuns('parent')
  const old = getSubagentRuns('parent')[0], frozen = captureSubagentRunScope(old)
  expect(frozen.serverGeneration).toBe('G1')
  serverGeneration = 'G2'; announceRecovery = true; clock += 5000
  await expect(refreshSubagentRuns('parent')).rejects.toThrow('generation changed')
  expect(getSubagentDiscovery('parent').state?.recoveryRequired).toBe(true)
  // The same bounded cycle may already receive G2's first page after the
  // recovery error; either fence rejects the old button before a POST.
  await expect(requestSubagentCancellation('run-75', frozen)).rejects.toThrow(/尚未恢复|归属已变化/)
  for (let cycle = 0; cycle < 3; cycle++) {
    clock += 5000
    await refreshSubagentRuns('parent').catch(() => {})
  }
  expect(getSubagentDiscovery('parent').state).toMatchObject({ generation: 'G2', recoveryRequired: false })
  expect(getSubagentRuns('parent')[0]).toMatchObject({ runId: 'run-75', lastSeq: 1, childSessionId: 'new-child',
    parentConversationId: 'new-turn', parentToolCallId: 'new-dispatch', task: 'Verified new generation task' })
  await expect(refreshSubagentRun('run-75', frozen)).rejects.toThrow('归属已变化')
  await expect(requestSubagentCancellation('run-75', frozen)).rejects.toThrow('归属已变化')
  expect(calls.some(input => input.method === 'POST')).toBe(false)
  expect(calls.some(input => input.path === '/subagent/runs/run-75' && input.query?.parentConversationId === 'new-turn')).toBe(true)
})

test('a held ordinary directory cannot recreate a run after discovery proves its deletion', async () => {
  let changesRead = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  bridge(async input => {
    if (input.path === '/subagent/runs') {
      await held
      return { schemaVersion: 2, runs: [run(75)], revision: 'old-head', hasMore: false, listComplete: true }
    }
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'active') return page('active', [ref(75)])
      return ++changesRead === 1 ? page('changes', []) : page('changes', [{ ...ref(75, 'running', 130), deleted: true }],
        { asOfRevision: 130, nextRevision: 130, activeCount: 0 })
    }
    return run(75)
  })
  await refreshSubagentRuns('parent')
  const directory = restartSubagentDirectory('parent')
  await expect.poll(() => calls.some(input => input.path === '/subagent/runs')).toBe(true)
  clock += 5000
  await refreshSubagentRuns('parent').catch(() => {})
  expect(getSubagentRuns('parent')).toEqual([])
  release()
  await expect(directory).rejects.toThrow('生命周期已更新')
  expect(getSubagentRuns('parent')).toEqual([])
  expect(getSubagentDirectory('parent').error).toContain('生命周期已更新')
  expect(calls.some(input => input.method === 'POST')).toBe(false)
})

test('accepted deletion publishes exact disposition after cache retirement and before bounded fence acknowledgement', async () => {
  let changesRead = 0
  const observed: SubagentDiscoveryRef[][] = []
  const off = subscribeSubagentDeletions(observation => {
    expect(observation.parentSessionId).toBe('parent')
    expect(getSubagentRuns('parent')).toEqual([])
    expect(getSubagentDiscovery('parent').state?.refs.get('run-75')?.ref.deleted).toBe(true)
    observed.push([...observation.refs])
  })
  bridge(async input => {
    if (input.path !== '/subagent/discovery') return run(75)
    if (input.query?.mode === 'active') return page('active', [ref(75)])
    return ++changesRead === 1 ? page('changes', []) : page('changes', [{ ...ref(75, 'running', 130), deleted: true }],
      { asOfRevision: 130, nextRevision: 130, activeCount: 0 })
  })
  try {
    await refreshSubagentRuns('parent')
    expect(observed).toEqual([])
    clock += 5000
    await refreshSubagentRuns('parent')
    expect(observed).toEqual([[{ ...ref(75, 'running', 130), deleted: true }]])
    expect(getSubagentRuns('parent')).toEqual([])
    expect(getSubagentDiscovery('parent').state?.refs.has('run-75')).toBe(false)
  } finally { off() }
})

test('A08/A09: failed hydrates backpressure the exact cursor while later pending identities still get turns', async () => {
  const activeCursors: Array<string | undefined> = [], attempted = new Set<number>()
  let permitHydrate = false
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'changes') return page('changes', [], { asOfRevision: 1000, nextRevision: 1000, activeCount: 1000 })
      const cursor = input.query?.cursor as string | undefined
      activeCursors.push(cursor)
      const first = cursor ? Number(cursor) : 1
      return page('active', Array.from({ length: 64 }, (_, offset) => ref(first + offset)),
        { asOfRevision: 1000, activeCount: 1000, hasMore: true, nextCursor: String(first + 64), membershipCompleteness: 'partial' })
    }
    const index = Number(input.path.split('run-')[1]); attempted.add(index)
    if (!permitHydrate) throw new Error('Synthetic accurate hydrate failure')
    return run(index)
  })
  for (let cycle = 0; cycle < 5; cycle++) {
    const before = calls.length
    await expect(refreshSubagentRuns('parent')).rejects.toThrow()
    expect(calls.length - before).toBeLessThanOrEqual(8)
    clock += 5000
  }
  const paused = getSubagentDiscovery('parent').state!
  expect(paused.refs.size).toBe(192)
  expect(paused.baseline?.cursor).toBe('193')
  expect(paused.refs.has('run-1')).toBe(true)
  expect(paused.refs.has('run-192')).toBe(true)
  expect(paused.refs.has('run-193')).toBe(false)
  expect(activeCursors).toEqual([undefined, '65', '129', '193', '193'])
  expect(Math.max(...attempted)).toBeGreaterThan(6)
  permitHydrate = true
  // One pending hydrate is mandatory even as the newly known active queue
  // grows. A 64-ref page therefore needs at most 64 successful turns plus the
  // next retry; this does not assume every spare job is assigned to hydration.
  for (let cycle = 0; cycle < 65 && getSubagentDiscovery('parent').state?.baseline?.cursor === '193'; cycle++) {
    const before = calls.length
    await refreshSubagentRuns('parent').catch(() => {})
    expect(calls.length - before).toBeLessThanOrEqual(8)
    expect(getSubagentDiscovery('parent').state?.refs.size).toBeLessThanOrEqual(192)
    clock += 5000
  }
  expect(getSubagentDiscovery('parent').state?.baseline?.cursor).not.toBe('193')
  expect(getSubagentRuns('parent').length).toBeGreaterThan(0)
  expect(calls.some(input => input.method === 'POST')).toBe(false)
})

test('A09: selected keeps advancing alongside round-robin known children and a newly discovered identity', async () => {
  let seq = 100
  const summaries = new Set<string>()
  for (let i = 1; i <= 600; i++) ingestSubagentRun(run(i))
  bridge(async input => {
    if (input.path === '/subagent/discovery') {
      if (input.query?.mode === 'active') return page('active', [ref(1001)], { asOfRevision: 1001, activeCount: 601 })
      return page('changes', [], { asOfRevision: 1001, nextRevision: 1001, activeCount: 601 })
    }
    summaries.add(input.path)
    return run(Number(input.path.split('run-')[1]), 'running', seq)
  })
  for (let cycle = 0; cycle < 15; cycle++) {
    seq++
    const before = calls.length
    await refreshSubagentRuns('parent', { selectedRunId: 'run-600' })
    const wire = calls.slice(before)
    expect(wire.length).toBeLessThanOrEqual(8)
    expect(wire.some(input => input.path === '/subagent/discovery')).toBe(true)
    expect(wire.some(input => input.path === '/subagent/runs/run-600')).toBe(true)
    clock += 5000
  }
  expect(summaries.has('/subagent/runs/run-1001')).toBe(true)
  expect(summaries.has('/subagent/runs/run-20')).toBe(true)
  expect(getSubagentRuns('parent').find(item => item.runId === 'run-600')?.lastSeq).toBe(seq)
  expect(maximum).toBeLessThanOrEqual(2)
})

test('discovery parent storage stays bounded and an evicted scope returns to partial discovery', async () => {
  bridge(async input => {
    expect(input.path).toBe('/subagent/discovery')
    const parentSessionId = String(input.query?.parentSessionId)
    return { ...page(input.query?.mode as 'active' | 'changes', [], { activeCount: 0 }), scope: { tenantId: 'tenant', parentSessionId } }
  })
  for (let i = 0; i < 40; i++) await refreshSubagentRuns(`parent-${i}`)
  const stats = getSubagentDiscoveryStats()
  expect(stats.parentCount).toBeLessThanOrEqual(32)
  expect(stats.residentBytes).toBeLessThanOrEqual(1024 * 1024)
  expect(getSubagentDiscovery('parent-0').state).toBeUndefined()
  await refreshSubagentRuns('parent-0')
  expect(getSubagentDiscovery('parent-0').state?.residentPartial).toBe(true)
})
