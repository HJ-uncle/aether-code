/** Pure directory regressions: scope/cursor atomicity, honest completeness and bounded identity windows. No Electron. */
import { expect, test } from '@playwright/test'
import type { SubagentRunsPage, SubagentRunView } from '../src/shared/subagent'
import {
  createSubagentDirectory,
  reduceSubagentDirectory,
  subagentDirectoryResidentBytes,
  SUBAGENT_DIRECTORY_MAX_BYTES,
  SUBAGENT_DIRECTORY_MAX_PAGES,
  SUBAGENT_DIRECTORY_MAX_REFERENCES,
  type SubagentDirectoryScope,
  type SubagentDirectoryState,
  type SubagentDirectoryUpdate
} from '../src/renderer/src/core/engine/subagent-directory'

const scope: SubagentDirectoryScope = {
  source: 2, generation: 3, parentSessionId: 'parent-1',
  expectedEngine: { mode: 'embedded', baseUrl: 'http://127.0.0.1:12541', instanceId: 'engine-1', accountId: 'account-1' }
}

test('未登录引擎的null身份遵循真实EngineSnapshot契约并可加载首页', () => {
  const anonymousScope: SubagentDirectoryScope = { ...scope, expectedEngine: {
    mode: 'remote', baseUrl: 'http://127.0.0.1:12541', instanceId: 'anonymous-engine', accountId: null
  } }
  const initial = createSubagentDirectory(anonymousScope)
  const result = reduceSubagentDirectory(initial, { ...request(page(['anonymous-run'])), scope: anonymousScope })
  expect(result.status, result.reason).toBe('applied')
  expect(result.state.ids).toEqual(['anonymous-run'])
})

test('null和undefined表示同一个未绑定连接身份；真实账号变化仍拒绝', () => {
  const nullableScope: SubagentDirectoryScope = { ...scope, expectedEngine: {
    mode: 'embedded', baseUrl: '', instanceId: null, accountId: null
  } }
  const absentScope: SubagentDirectoryScope = { ...nullableScope, expectedEngine: { mode: 'embedded', baseUrl: '' } }
  const initial = createSubagentDirectory(nullableScope)
  const result = reduceSubagentDirectory(initial, { ...request(page(['anonymous-run'])), scope: absentScope })
  expect(result.status, result.reason).toBe('applied')
  const differentAccount = reduceSubagentDirectory(result.state, { ...request(page(['account-run'])), scope: {
    ...absentScope, expectedEngine: { ...absentScope.expectedEngine, accountId: 'new-account' }
  } })
  expect(differentAccount.status).toBe('rejected')
  expect(differentAccount.state).toBe(result.state)
})

function run(id: string, patch: Partial<SubagentRunView> = {}): SubagentRunView {
  return {
    schemaVersion: 2, view: 'summary', runId: id, tenantId: 'tenant-1', rootSessionId: 'root-1', parentSessionId: scope.parentSessionId,
    parentConversationId: 'turn-1', parentMessageId: 'message-1', parentToolCallId: `dispatch-${id}`, childSessionId: `child-${id}`,
    task: 'Synthetic task', description: 'Test directory', modelId: 'synthetic', status: 'running', lastSeq: 1,
    createdAt: 1000, updatedAt: 2000, usage: {}, toolCalls: [], toolCount: 0, activeToolCount: 0,
    coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0,
      ids: [], hasMore: false, truncated: false, completeness: 'complete' }, ...patch
  }
}
function page(ids: string[], nextCursor?: string, patch: Partial<SubagentRunsPage> = {}): SubagentRunsPage {
  return { schemaVersion: 2, runs: ids.map(id => run(id)), revision: 'revision-1',
    hasMore: nextCursor !== undefined, listComplete: nextCursor === undefined, nextCursor, ...patch }
}
function request(value: SubagentRunsPage, patch: Partial<SubagentDirectoryUpdate> = {}): SubagentDirectoryUpdate {
  return { scope, page: value, updatedAt: 3000, ...patch }
}
function applied(state: SubagentDirectoryState, update: SubagentDirectoryUpdate): SubagentDirectoryState {
  const result = reduceSubagentDirectory(state, update)
  expect(result.status, result.reason).toBe('applied')
  return result.state
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
function rejected(state: SubagentDirectoryState, update: SubagentDirectoryUpdate, reason: string): void {
  const previous = JSON.stringify(state)
  frozen(state)
  const result = reduceSubagentDirectory(state, update)
  expect(result).toMatchObject({ status: 'rejected', reason })
  expect(result.state).toBe(state)
  expect(JSON.stringify(state)).toBe(previous)
}

test('empty directory is unknown/partial and scope is copied without borrowing mutable engine identity', () => {
  const mutable = { ...scope, expectedEngine: { ...scope.expectedEngine } }
  const state = createSubagentDirectory(mutable)
  mutable.expectedEngine.instanceId = 'changed'
  expect(state.scope.expectedEngine.instanceId).toBe('engine-1')
  expect(state).toMatchObject({ ids: [], pages: [], schemaVersion: 2, partial: true, listComplete: false, residentComplete: false,
    endReached: false, hasMore: false, updatedAt: 0 })
  expect(state.residentBytes).toBe(new TextEncoder().encode(JSON.stringify(state)).byteLength)
  expect('total' in state).toBe(false)
})

test('only an untrimmed complete first page proves the resident collection complete, including empty collection', () => {
  for (const ids of [[], ['run-1', 'run-2']]) {
    const state = applied(createSubagentDirectory(scope), request(page(ids)))
    expect(state.ids).toEqual(ids)
    expect(state).toMatchObject({ partial: false, listComplete: true, residentComplete: true, budgetTrimmed: false, endReached: true, hasMore: false })
    expect(state.nextCursor).toBeUndefined()
  }
})

test('129 rows follow opaque next cursors in 3 pages; the final later page remains partial', () => {
  let state = createSubagentDirectory(scope)
  const ids = Array.from({ length: 129 }, (_, i) => `run-${i + 1}`)
  state = applied(state, request(page(ids.slice(0, 64), 'opaque-cursor-1')))
  state = applied(state, request(page(ids.slice(64, 128), 'opaque-cursor-2'), { inputCursor: 'opaque-cursor-1' }))
  state = applied(state, request(page(ids.slice(128), undefined, { listComplete: false }), { inputCursor: 'opaque-cursor-2' }))
  expect(state.ids).toEqual(ids)
  expect(state.pages).toHaveLength(3)
  expect(state).toMatchObject({ endReached: true, hasMore: false, partial: true, listComplete: false, residentComplete: false })
  expect(state.recentCursors).toEqual(['opaque-cursor-1', 'opaque-cursor-2'])
})

test('same-revision first-page refresh retains later progress and applies higher observed reference seq', () => {
  let state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
  state = applied(state, request(page(['b'], 'c2'), { inputCursor: 'c1' }))
  const refresh = page(['a'], 'c1', { runs: [run('a', { lastSeq: 19 })] })
  state = applied(state, request(refresh, { updatedAt: 4000 }))
  expect(state.ids).toEqual(['a', 'b'])
  expect(state.nextCursor).toBe('c2')
  expect(state.pages[0].references[0].lastSeq).toBe(19)
  expect(state.recentCursors).toEqual(['c1'])
  state = applied(state, request(page(['c'], undefined, { listComplete: false }), { inputCursor: 'c2' }))
  state = applied(state, request(refresh))
  expect(state.endReached).toBe(true)
  expect(state.nextCursor).toBeUndefined()
  expect(state.updatedAt).toBe(4000)
})

test('a changed membership revision reopens only its cursor chain and retains bounded seen references', () => {
  let state = applied(createSubagentDirectory(scope), request(page(['a'], 'old-c1')))
  state = applied(state, request(page(['b'], 'old-c2'), { inputCursor: 'old-c1' }))
  state = applied(state, request(page(['new'], 'new-c1', { revision: 'revision-2' })))
  expect(state.ids).toEqual(['a', 'b', 'new'])
  expect(state.revision).toBe('revision-2')
  expect(state.nextCursor).toBe('new-c1')
  expect(state.recentCursors).toEqual([])
  expect(state.pages.slice(0, 2).every(item => item.seenOnly && item.inputCursor === undefined && item.nextCursor === undefined)).toBe(true)
  expect(state.partial).toBe(true)
  rejected(state, request(page(['later'], undefined, { revision: 'revision-1', listComplete: false }), { inputCursor: 'new-c1' }), 'revision-mismatch')
})

test('an explicit return to first page resets resident window and progress without inventing deletion outside the directory', () => {
  let state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
  state = applied(state, request(page(['b'], 'c2'), { inputCursor: 'c1' }))
  const before = state
  state = applied(frozen(state), request(page(['a'], 'c1'), { restart: true }))
  expect(state.ids).toEqual(['a'])
  expect(state.pages).toHaveLength(1)
  expect(state.nextCursor).toBe('c1')
  expect(state.recentCursors).toEqual([])
  expect(before.ids).toEqual(['a', 'b'])
  expect(state.partial).toBe(true)
})

test('duplicate page identity is rejected atomically even when the same seq would otherwise look idempotent', () => {
  const state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
  rejected(state, request(page(['b', 'b'], 'c2'), { inputCursor: 'c1' }), 'duplicate-run-id')
})

test('compatible overlap deduplicates references, preserves max seq, and stores no run payload', () => {
  let state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1', { runs: [run('a', { lastSeq: 10, partialOutput: 'never copy', resultSummary: 'never copy', task: 'never copy' })] })))
  state = applied(state, request(page(['a', 'b'], 'c2', { runs: [run('a', { lastSeq: 4 }), run('b')] }), { inputCursor: 'c1' }))
  expect(state.ids).toEqual(['a', 'b'])
  expect(state.pages.flatMap(item => item.references).filter(item => item.runId === 'a')).toEqual([{
    runId: 'a', childSessionId: 'child-a', parentConversationId: 'turn-1', parentMessageId: 'message-1', parentToolCallId: 'dispatch-a', lastSeq: 10
  }])
  expect(JSON.stringify(state)).not.toContain('never copy')
  expect(JSON.stringify(state)).not.toContain('toolCalls')
  expect(JSON.stringify(state)).not.toContain('status')
})

for (const key of ['source', 'generation', 'parentSessionId', 'baseUrl', 'instanceId', 'accountId', 'mode'] as const) {
  test(`foreign ${key} does not advance cursor or mutate any directory field`, () => {
    const state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
    const changed = { ...scope, expectedEngine: { ...scope.expectedEngine } }
    if (key === 'source' || key === 'generation') changed[key]++
    else if (key === 'parentSessionId') changed[key] = 'foreign-parent'
    else if (key === 'mode') changed.expectedEngine.mode = 'remote'
    else changed.expectedEngine[key] = 'foreign-engine'
    rejected(state, request(page(['b'], 'c2'), { scope: changed, inputCursor: 'c1' }), 'scope-mismatch')
  })
}

for (const key of ['tenantId', 'rootSessionId', 'parentSessionId', 'childSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId'] as const) {
  test(`foreign/conflicting run ${key} rejects the whole page before valid-prefix references commit`, () => {
    const state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
    const reason = key === 'parentSessionId' ? 'run-identity-mismatch' : key === 'tenantId' || key === 'rootSessionId' ? 'run-scope-mismatch' : 'run-identity-conflict'
    rejected(state, request(page(['valid', 'a'], 'c2', { runs: [run('valid'), run('a', { [key]: 'foreign' })] }), { inputCursor: 'c1' }), reason)
  })
}

test('known tenant/root anchor rejects even the first page and a mixed-scope page is not partially accepted', () => {
  const anchored = createSubagentDirectory(scope, 2, { tenantId: 'tenant-1', rootSessionId: 'root-1' })
  rejected(anchored, request(page(['a'], 'c1', { runs: [run('a', { tenantId: 'foreign' })] })), 'run-scope-mismatch')
  const empty = createSubagentDirectory(scope)
  rejected(empty, request(page(['a', 'b'], 'c1', { runs: [run('a'), run('b', { rootSessionId: 'foreign' })] })), 'run-scope-mismatch')
})

test('wrong/consumed cursor, changed later revision and a lying last page are atomically rejected', () => {
  const first = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
  rejected(first, request(page(['b'], 'c2'), { inputCursor: 'wrong' }), 'cursor-mismatch')
  rejected(first, request(page(['b'], 'c2', { revision: 'revision-2' }), { inputCursor: 'c1' }), 'revision-mismatch')
  rejected(first, request(page(['b']), { inputCursor: 'c1' }), 'later-page-cannot-be-complete')
  const second = applied(first, request(page(['b'], 'c2'), { inputCursor: 'c1' }))
  rejected(second, request(page(['b'], 'c2'), { inputCursor: 'c1' }), 'cursor-mismatch')
})

test('self cursor and repeats in the recent/retained three-page window are rejected without claiming arbitrary cycle detection', () => {
  let state = applied(createSubagentDirectory(scope), request(page(['a'], 'c1')))
  rejected(state, request(page(['b'], 'c1'), { inputCursor: 'c1' }), 'recent-cursor-repeat')
  state = applied(state, request(page(['b'], 'c2'), { inputCursor: 'c1' }))
  state = applied(state, request(page(['c'], 'c3'), { inputCursor: 'c2' }))
  rejected(state, request(page(['d'], 'c1'), { inputCursor: 'c3' }), 'recent-cursor-repeat')
})

test('120 sequential pages keep only 3 pages/192 references/3 recent cursors, with an honest partial end', () => {
  let state = applied(createSubagentDirectory(scope), request(page(Array.from({ length: 64 }, (_, i) => `p0-${i}`), 'cursor-1')))
  for (let index = 1; index < 120; index++) {
    state = applied(frozen(state), request(page(Array.from({ length: 64 }, (_, i) => `p${index}-${i}`), `cursor-${index + 1}`), { inputCursor: `cursor-${index}`, updatedAt: 3000 + index }))
    expect(state.pages.length).toBeLessThanOrEqual(SUBAGENT_DIRECTORY_MAX_PAGES)
    expect(state.ids.length).toBeLessThanOrEqual(SUBAGENT_DIRECTORY_MAX_REFERENCES)
    expect(state.recentCursors.length).toBeLessThanOrEqual(3)
    expect(state.residentBytes).toBeLessThanOrEqual(SUBAGENT_DIRECTORY_MAX_BYTES)
  }
  expect(state.ids).toHaveLength(192)
  expect(state.ids[0]).toBe('p117-0')
  expect(state.recentCursors).toEqual(['cursor-117', 'cursor-118', 'cursor-119'])
  expect(state.budgetTrimmed).toBe(true)
  state = applied(state, request(page(['final'], undefined, { listComplete: false }), { inputCursor: 'cursor-120' }))
  expect(state).toMatchObject({ endReached: true, partial: true, listComplete: false, residentComplete: false, budgetTrimmed: true })
})

test('a 200-row complete first page trims whole references rather than identities and cannot claim completeness', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `full-id-${i}`)
  const state = applied(createSubagentDirectory(scope), request(page(ids)))
  expect(state.ids).toEqual(ids.slice(8))
  expect(state).toMatchObject({ partial: true, listComplete: false, residentComplete: false, budgetTrimmed: true, endReached: true })
  expect(state.pages[0].references).toHaveLength(192)
})

test('UTF-8 bytes include all identity/scope/cursor strings, trim full references and match serialized ledger exactly', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `标识-${i}-${'界🙂'.repeat(1800)}`)
  const input = page(ids, 'cursor-' + '🙂'.repeat(1000))
  const state = applied(createSubagentDirectory(scope), request(input))
  expect(state.ids.length).toBeLessThan(ids.length)
  expect(state.ids.length).toBeGreaterThan(0)
  expect(state.ids.every(id => ids.includes(id))).toBe(true)
  expect(state).toMatchObject({ partial: true, budgetTrimmed: true, residentComplete: false })
  expect(state.residentBytes).toBe(subagentDirectoryResidentBytes(state))
  expect(state.residentBytes).toBe(new TextEncoder().encode(JSON.stringify(state)).byteLength)
  expect(state.residentBytes).toBeLessThanOrEqual(SUBAGENT_DIRECTORY_MAX_BYTES)
})

test('a single oversized identity is evicted whole while a cursor that cannot fit is rejected atomically', () => {
  const state = createSubagentDirectory(scope)
  const id = '完整身份-' + '界'.repeat(100_000)
  const next = applied(state, request(page([id], 'valid-cursor')))
  expect(next.ids).toEqual([])
  expect(next.nextCursor).toBe('valid-cursor')
  expect(next.budgetTrimmed).toBe(true)
  rejected(state, request(page(['a'], 'cursor-' + '界'.repeat(100_000))), 'directory-byte-budget-exceeded')
})

test('legacy arrays explicitly have no bounded pagination/completeness claim and are not retained', () => {
  const legacy = createSubagentDirectory(scope, 1)
  const value: SubagentRunsPage = { schemaVersion: 1, runs: [], hasMore: false, listComplete: true }
  const result = reduceSubagentDirectory(legacy, request(value))
  expect(result.status).toBe('legacy')
  expect(result.reason).toBe('legacy-pagination-unavailable')
  expect(result.state).toMatchObject({ schemaVersion: 1, ids: [], pages: [], partial: true, listComplete: false, residentComplete: false, endReached: true })
  rejected(legacy, request(value, { inputCursor: 'not-supported' }), 'legacy-pagination-unavailable')
  rejected(createSubagentDirectory(scope), request(value), 'invalid-page')
})

test('missing cursor, unsupported schema, mixed protocol rows, invalid seq/time and over-contract row count reject atomically', () => {
  const state = createSubagentDirectory(scope)
  rejected(state, request(page(['a'], undefined, { hasMore: true, listComplete: false })), 'missing-page-cursor')
  rejected(state, request({ ...page(['a']), schemaVersion: 3 } as unknown as SubagentRunsPage), 'invalid-page')
  rejected(state, request(page(['a'], 'c1', { runs: [run('a', { lastSeq: -1 })] })), 'run-identity-mismatch')
  rejected(state, request(page(['a']), { updatedAt: Number.NaN }), 'invalid-update')
  rejected(state, request(page(Array.from({ length: 201 }, (_, i) => `r-${i}`))), 'invalid-page')
  const mixed = { ...run('a'), schemaVersion: 1 as const }
  rejected(state, request(page(['a'], 'c1', { runs: [mixed] })), 'run-identity-mismatch')
})

test('successful reductions do not mutate frozen request pages or prior state, and oversized scope cannot create unbounded state', () => {
  const state = frozen(createSubagentDirectory(scope))
  const update = frozen(request(page(['a'], 'c1')))
  const before = JSON.stringify(update)
  const next = applied(state, update)
  expect(state.ids).toEqual([])
  expect(JSON.stringify(update)).toBe(before)
  expect(next.scope).toBe(state.scope)
  expect(() => createSubagentDirectory({ ...scope, parentSessionId: '界'.repeat(100_000) })).toThrow('exceeds byte budget')
})
