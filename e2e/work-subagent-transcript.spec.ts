// Pure contracts: safe child-history ownership, bounded archives, stale-source rejection and lossless long outputs.
import { expect, test } from '@playwright/test'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import type { SubagentRun } from '../src/shared/subagent'
import { loadWorkSubagentTranscript, SUBAGENT_TRANSCRIPT_PAGE_SIZE, SUBAGENT_TRANSCRIPT_WINDOW_BYTES, SUBAGENT_TRANSCRIPT_WINDOW_PAGES, workTranscriptText, WorkTranscriptSupersededError, type WorkTranscriptIdentity, type WorkTranscriptRequest } from '../src/renderer/src/contrib/work/work-subagent-transcript'

const identity: WorkTranscriptIdentity = { source: 3, parentSessionId: 'parent', childSessionId: 'child', runId: 'run-one' }
const run: SubagentRun = {
  schemaVersion: 1, runId: 'run-one', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
  parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'call', childSessionId: 'child',
  task: 'Review', description: 'Review', modelId: 'qwen3.8-flash', status: 'succeeded', lastSeq: 4, createdAt: 10, updatedAt: 20, usage: {}, toolCalls: []
}
const rows = (count: number): EngineHistoryRow[] => Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, role: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool', content: `Original record ${index}`, modelId: index % 2 ? 'qwen3.8-flash' : 'model-two' }))
const ok = (data: unknown): EngineRequestResult<unknown> => ({ ok: true, code: 200, message: 'ok', data })
function archive(data: EngineHistoryRow[], revision = 'r1', calls: EngineRequestInput[] = [], ownedRun = run): WorkTranscriptRequest {
  return async input => {
    calls.push(input)
    if (input.path.startsWith('/subagent/runs/')) return ok(ownedRun)
    const current = Number(input.query?.current), pageSize = Number(input.query?.pageSize)
    return { ...ok(data.slice((current - 1) * pageSize, current * pageSize)), pagination: { current, pageSize, total: data.length, totalPages: Math.ceil(data.length / pageSize) }, metadata: { archiveMessageCount: data.length, archiveRevision: revision, backend: 'jsonl', compressed: false } }
  }
}
function archiveResponse(data: EngineHistoryRow[], input: EngineRequestInput, revision: string): EngineRequestResult<unknown> {
  const current = Number(input.query?.current), pageSize = Number(input.query?.pageSize)
  return { ...ok(data.slice((current - 1) * pageSize, current * pageSize)), pagination: { current, pageSize, total: data.length, totalPages: Math.ceil(data.length / pageSize) }, metadata: { archiveMessageCount: data.length, archiveRevision: revision, backend: 'jsonl', compressed: false } }
}

test('loads the newest archive page first, then all original rows in order without snapshot truncation', async () => {
  const data = rows(127), calls: EngineRequestInput[] = []
  data[126].content = 'x'.repeat(12_200) + 'complete final output beyond 8k'
  let window = await loadWorkSubagentTranscript(identity, archive(data, 'r1', calls), () => true)
  expect(window.rows.map(row => row.id)).toEqual(data.slice(100).map(row => row.id))
  expect(calls.map(call => [call.path, call.query?.current, call.query?.pageSize])).toEqual([
    ['/subagent/runs/run-one', undefined, undefined], ['/conversation/archive', '1', '1'], ['/conversation/archive', '3', '50']
  ])
  window = await loadWorkSubagentTranscript(identity, archive(data, 'r1', calls), () => true, window, 'older')
  window = await loadWorkSubagentTranscript(identity, archive(data, 'r1', calls), () => true, window, 'older')
  expect(window.rows).toEqual(data)
  expect(window.rows.at(-1)?.content).toBe(data[126].content)
  expect(calls.filter(call => call.query).every(call => Number(call.query!.pageSize) <= SUBAGENT_TRANSCRIPT_PAGE_SIZE && call.query?.sessionId === 'child')).toBe(true)
})

test('verifies the authoritative parent and child before any history request', async () => {
  for (const ownedRun of [{ ...run, parentSessionId: 'other-parent' }, { ...run, childSessionId: 'other-child' }, { ...run, runId: 'another-run' }]) {
    const calls: EngineRequestInput[] = []
    await expect(loadWorkSubagentTranscript(identity, archive(rows(1), 'r1', calls, ownedRun), () => true)).rejects.toThrow('不属于当前任务')
    expect(calls.map(call => call.path)).toEqual(['/subagent/runs/run-one'])
  }
})

test('source or child switches discard a delayed archive response and stop further requests', async () => {
  const calls: EngineRequestInput[] = []
  let current = true
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const respond = archive(rows(60), 'r1', calls)
  const request: WorkTranscriptRequest = async input => {
    const result = await respond(input)
    if (input.path === '/conversation/archive') await delayed
    return result
  }
  const load = loadWorkSubagentTranscript(identity, request, () => current)
  await expect.poll(() => calls.length).toBe(2)
  current = false
  release()
  await expect(load).rejects.toBeInstanceOf(WorkTranscriptSupersededError)
  expect(calls).toHaveLength(2)
})

test('unsupported archive reads available history explicitly, while permission and server failures remain errors', async () => {
  const data = rows(3), calls: EngineRequestInput[] = []
  const fallback = archive(data, 'r1', calls)
  const result = await loadWorkSubagentTranscript(identity, async input => input.path === '/conversation/archive' ? { ok: false, code: 50101, message: 'Not supported', data: null } : fallback(input), () => true)
  expect(result.endpoint).toBe('/conversation/history')
  expect(result.rows).toEqual(data)
  expect(calls.filter(call => call.query).every(call => call.path === '/conversation/history')).toBe(true)
  for (const code of [40301, 50001]) {
    const failedCalls: EngineRequestInput[] = []
    const owned = archive(data, 'r1', failedCalls)
    await expect(loadWorkSubagentTranscript(identity, input => input.path === '/conversation/archive' ? Promise.resolve({ ok: false, code, message: 'read denied', data: null }) : owned(input), () => true)).rejects.toThrow('read denied')
    expect(failedCalls).toHaveLength(1)
  }
})

test('refreshing edited or appended records preserves the already selected earlier window and exact model IDs', async () => {
  const data = rows(151)
  let window = await loadWorkSubagentTranscript(identity, archive(data), () => true)
  window = await loadWorkSubagentTranscript(identity, archive(data), () => true, window, 'older')
  const revised = [...data.map(row => row.id === 'row-120' ? { ...row, content: 'corrected original output' } : row), ...rows(51).map((row, index) => ({ ...row, id: `new-${index}`, modelId: 'qwen3.8-flash' }))]
  window = await loadWorkSubagentTranscript({ ...identity, runId: 'run-two' }, archive(revised, 'r2', [], { ...run, runId: 'run-two' }), () => true, window)
  expect(window.firstPage).toBe(3)
  expect(window.rows[0].id).toBe('row-100')
  expect(window.rows.find(row => row.id === 'row-120')?.content).toBe('corrected original output')
  expect(window.rows.at(-1)).toMatchObject({ id: 'new-50', modelId: 'qwen3.8-flash' })
  expect(window.identity.runId).toBe('run-two')
  const calls: EngineRequestInput[] = []
  const stable = await loadWorkSubagentTranscript(window.identity, archive(revised, 'r2', calls, { ...run, runId: 'run-two' }), () => true, window)
  expect(stable.rows).toEqual(window.rows)
  expect(calls).toHaveLength(2)
})

test('old engine sources and different children never reuse a prior loaded window', async () => {
  const previous = await loadWorkSubagentTranscript(identity, archive(rows(151)), () => true)
  const expanded = await loadWorkSubagentTranscript(identity, archive(rows(151)), () => true, previous, 'older')
  for (const next of [{ ...identity, source: 4 }, { ...identity, childSessionId: 'new-child' }]) {
    const result = await loadWorkSubagentTranscript(next, archive(rows(101), 'r2', [], { ...run, childSessionId: next.childSessionId }), () => true, expanded)
    expect(result.rows.map(row => row.id)).toEqual(['row-100'])
  }
})

test('failed, incomplete, duplicate or revised pages never mutate previously read records', async () => {
  const data = rows(127), previous = await loadWorkSubagentTranscript(identity, archive(data), () => true)
  const preserved = JSON.stringify(previous)
  const respond = archive(data)
  for (const failure of ['error', 'partial', 'revision', 'duplicate']) {
    const request: WorkTranscriptRequest = async input => {
      const result = await respond(input)
      if (input.query?.pageSize !== '50') return result
      if (failure === 'error') return { ok: false, code: 50001, message: 'temporary failure', data: null }
      if (failure === 'partial') return { ...result, data: [] }
      if (failure === 'revision') return { ...result, metadata: { ...result.metadata, archiveRevision: 'changed-while-loading' } }
      return { ...result, data: data.slice(50, 100).map((row, index) => index === 0 ? { ...row, id: previous.rows[0].id } : row) }
    }
    await expect(loadWorkSubagentTranscript(identity, request, () => true, previous, 'older')).rejects.toThrow()
    expect(JSON.stringify(previous)).toBe(preserved)
  }
  const retried = await loadWorkSubagentTranscript(identity, respond, () => true, previous, 'older')
  expect(retried.rows.map(row => row.id)).toEqual(data.slice(50).map(row => row.id))
})

test('a running refresh keeps the newest coherent page when the archive revision advances mid-read', async () => {
  const data = rows(101), calls: EngineRequestInput[] = []
  let pageReads = 0
  const request: WorkTranscriptRequest = async input => {
    if (input.path.startsWith('/subagent/runs/')) return ok(run)
    const current = Number(input.query?.current), pageSize = Number(input.query?.pageSize)
    pageReads++
    const revision = pageReads === 2 ? 'r2' : 'r1'
    return { ...ok(data.slice((current - 1) * pageSize, current * pageSize)), pagination: { current, pageSize, total: data.length, totalPages: Math.ceil(data.length / pageSize) }, metadata: { archiveMessageCount: data.length, archiveRevision: revision, backend: 'jsonl', compressed: false } }
  }
  const loaded = await loadWorkSubagentTranscript(identity, input => { calls.push(input); return request(input) }, () => true)
  expect(loaded.rows).toEqual(data.slice(100))
  expect(loaded.rows.at(-1)?.id).toBe('row-100')
  expect(loaded.revision).toBe('r2')
  expect(calls.filter(call => call.query).map(call => call.query?.current)).toEqual(['1', '3'])
})

test('continuous appends crossing a fifty-record boundary load one coherent refreshed page without changing the prior window', async () => {
  const previous = await loadWorkSubagentTranscript(identity, archive(rows(49), 'prior-r0'), () => true)
  const preserved = JSON.stringify(previous), calls: EngineRequestInput[] = []
  let data = rows(49), reads = 0
  const request: WorkTranscriptRequest = async input => {
    calls.push(input)
    if (input.path.startsWith('/subagent/runs/')) return ok(run)
    data = rows(data.length + 1)
    return archiveResponse(data, input, `append-${++reads}`)
  }
  const loaded = await loadWorkSubagentTranscript(identity, request, () => true, previous)
  expect(calls.filter(call => call.query).map(call => [call.query?.current, call.query?.pageSize])).toEqual([['1', '1'], ['1', '50'], ['2', '50']])
  expect(loaded).toMatchObject({ firstPage: 2, lastPage: 2, total: 52, revision: 'append-3', backend: 'jsonl', compressed: false, windowed: true })
  expect(loaded.rows).toEqual(data.slice(50))
  expect(loaded.rows.map(row => row.id)).toEqual(['row-50', 'row-51'])
  expect(loaded.residentBytes).toBe(new TextEncoder().encode(JSON.stringify(loaded.rows)).byteLength)
  expect(JSON.stringify(previous)).toBe(preserved)
})

test('append faster than both tail retries returns the last authoritative page instead of chasing forever or mixing revisions', async () => {
  const calls: EngineRequestInput[] = [], replies: { data: EngineHistoryRow[]; revision: string }[] = []
  let data = rows(49)
  const request: WorkTranscriptRequest = async input => {
    calls.push(input)
    if (input.path.startsWith('/subagent/runs/')) return ok(run)
    data = rows(data.length + SUBAGENT_TRANSCRIPT_PAGE_SIZE + 1)
    const revision = `append-${replies.length + 1}`
    replies.push({ data, revision })
    return archiveResponse(data, input, revision)
  }
  const loaded = await loadWorkSubagentTranscript(identity, request, () => true)
  expect(calls.filter(call => call.query).map(call => [call.query?.current, call.query?.pageSize])).toEqual([['1', '1'], ['2', '50'], ['4', '50'], ['5', '50']])
  const authoritative = replies.at(-1)!
  expect(loaded).toMatchObject({ firstPage: 5, lastPage: 5, total: 253, revision: authoritative.revision, windowed: true })
  expect(loaded.rows).toEqual(authoritative.data.slice(200, 250))
  expect(loaded.rows.at(-1)?.id).toBe('row-249')
  expect(new Set(loaded.rows.map(row => row.id)).size).toBe(50)
  expect(loaded.lastPage).toBeLessThan(Math.ceil(loaded.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE))
  expect(loaded.residentBytes).toBe(new TextEncoder().encode(JSON.stringify(loaded.rows)).byteLength)
})

test('archive shrinkage that empties the selected tail page follows the new last page and preserves the prior records', async () => {
  const previous = await loadWorkSubagentTranscript(identity, archive(rows(127), 'prior-r0'), () => true)
  const preserved = JSON.stringify(previous), calls: EngineRequestInput[] = []
  let data = rows(127), reads = 0
  const request: WorkTranscriptRequest = async input => {
    calls.push(input)
    if (input.path.startsWith('/subagent/runs/')) return ok(run)
    if (++reads > 1) data = rows(51)
    return archiveResponse(data, input, reads === 1 ? 'header-r1' : 'shrunk-r2')
  }
  const loaded = await loadWorkSubagentTranscript(identity, request, () => true, previous)
  expect(calls.filter(call => call.query).map(call => call.query?.current)).toEqual(['1', '3', '2'])
  expect(loaded).toMatchObject({ firstPage: 2, lastPage: 2, total: 51, revision: 'shrunk-r2' })
  expect(loaded.rows).toEqual(data.slice(50))
  expect(loaded.rows.map(row => row.id)).toEqual(['row-50'])
  expect(JSON.stringify(previous)).toBe(preserved)
})

for (const changed of ['source', 'child'] as const) {
  test(`${changed} changes discard a delayed tail-chase response without requesting another page or altering the prior window`, async () => {
    const previous = await loadWorkSubagentTranscript(identity, archive(rows(49), 'prior-r0'), () => true)
    const preserved = JSON.stringify(previous), calls: EngineRequestInput[] = []
    let selected = { source: identity.source, childSessionId: identity.childSessionId }
    let data = rows(49), reads = 0
    let release!: () => void, entered!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    const chasing = new Promise<void>(resolve => { entered = resolve })
    const request: WorkTranscriptRequest = async input => {
      calls.push(input)
      if (input.path.startsWith('/subagent/runs/')) return ok(run)
      data = rows(data.length + 1)
      const response = archiveResponse(data, input, `append-${++reads}`)
      if (reads === 3) { entered(); await delayed }
      return response
    }
    const load = loadWorkSubagentTranscript(identity, request, () => selected.source === identity.source && selected.childSessionId === identity.childSessionId, previous)
    await chasing
    selected = changed === 'source' ? { ...selected, source: identity.source + 1 } : { ...selected, childSessionId: 'different-child' }
    release()
    await expect(load).rejects.toBeInstanceOf(WorkTranscriptSupersededError)
    expect(calls.filter(call => call.query).map(call => call.query?.current)).toEqual(['1', '1', '2'])
    expect(calls).toHaveLength(4)
    expect(JSON.stringify(previous)).toBe(preserved)
  })
}

test('a coherent fallback page over the UTF-8 byte budget reports the detail reader and keeps the prior window intact', async () => {
  const previous = await loadWorkSubagentTranscript(identity, archive(rows(2), 'prior-r0'), () => true)
  const preserved = JSON.stringify(previous), calls: EngineRequestInput[] = []
  const oversized = rows(50)
  oversized[49].content = '中'.repeat(Math.floor(SUBAGENT_TRANSCRIPT_WINDOW_BYTES / 3) + 1)
  expect(String(oversized[49].content).length).toBeLessThan(SUBAGENT_TRANSCRIPT_WINDOW_BYTES)
  expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(SUBAGENT_TRANSCRIPT_WINDOW_BYTES)
  let reads = 0
  const request: WorkTranscriptRequest = async input => {
    calls.push(input)
    if (input.path.startsWith('/subagent/runs/')) return ok(run)
    return ++reads === 1 ? archiveResponse(rows(51), input, 'header-r1') : archiveResponse(oversized, input, 'fallback-r2')
  }
  await expect(loadWorkSubagentTranscript(identity, request, () => true, previous)).rejects.toThrow('按段读取原始详情')
  expect(calls.filter(call => call.query).map(call => call.query?.current)).toEqual(['1', '1'])
  expect(JSON.stringify(previous)).toBe(preserved)
})

test('long text expands incrementally to its original tail and never splits a surrogate pair', () => {
  const original = 'a'.repeat(3999) + '🌱' + 'b'.repeat(10_000) + 'final evidence after 8k'
  let preview = workTranscriptText(original)
  expect(preview.text).toBe('a'.repeat(3999))
  expect(preview.remaining).toBe(original.length - 3999)
  while (preview.remaining) preview = workTranscriptText(original, preview.nextLimit)
  expect(preview.text).toBe(original)
  expect(preview.text.endsWith('final evidence after 8k')).toBe(true)
})

test('malformed remote display fields fail without exposing their payload or replacing read records', async () => {
  const data = rows(127), previous = await loadWorkSubagentTranscript(identity, archive(data), () => true)
  const preserved = JSON.stringify(previous)
  const malformed: unknown[] = [
    { id: 'private-payload', role: 'secret-invalid-role' },
    { id: 'private-payload', role: ['user'] },
    { id: 'private-payload', role: 'assistant', createdAt: 8.65e15 },
    { id: 'private-payload', role: 'assistant', createdAt: Number.NaN },
    { id: 'private-payload', role: 'assistant', modelId: { private: 'private-payload' } },
    { id: 'private-payload', role: 'assistant', toolCall: { name: { private: 'private-payload' } } },
    { id: 'private-payload', role: 'user', metadata: { attachments: 'private-payload' } },
    { id: 'private-payload', role: 'user', metadata: { attachments: [null] } },
    { id: 'private-payload', role: 'user', metadata: { attachments: [{ name: 123 }] } }
  ]
  for (const row of malformed) {
    const respond = archive(data, 'r2')
    const result = loadWorkSubagentTranscript(identity, async input => {
      const value = await respond(input)
      return input.query?.pageSize === '1' ? { ...value, data: [row] } : value
    }, () => true, previous)
    await expect(result).rejects.toThrow('子代理对话内容格式无效，请重试')
    await expect(result).rejects.not.toThrow('private-payload')
    expect(JSON.stringify(previous)).toBe(preserved)
  }
})

test('an empty child transcript has a complete zero-count page without inventing output', async () => {
  const empty = await loadWorkSubagentTranscript(identity, archive([]), () => true)
  expect(empty).toMatchObject({ rows: [], total: 0, firstPage: 1, lastPage: 1, endpoint: '/conversation/archive' })
})

test('thousands of original rows remain readable with at most three pages resident', async () => {
  const data = rows(2500), request = archive(data)
  let window = await loadWorkSubagentTranscript(identity, request, () => true)
  const seen = new Set(window.rows.map(row => row.id))
  while (window.firstPage > 1) {
    window = await loadWorkSubagentTranscript(identity, request, () => true, window, 'older')
    for (const row of window.rows) seen.add(row.id)
    expect(window.lastPage - window.firstPage + 1).toBeLessThanOrEqual(SUBAGENT_TRANSCRIPT_WINDOW_PAGES)
    expect(window.rows.length).toBeLessThanOrEqual(SUBAGENT_TRANSCRIPT_WINDOW_PAGES * SUBAGENT_TRANSCRIPT_PAGE_SIZE)
    expect(window.residentBytes).toBeLessThanOrEqual(SUBAGENT_TRANSCRIPT_WINDOW_BYTES)
    expect(window.rows).toEqual(data.slice((window.firstPage - 1) * SUBAGENT_TRANSCRIPT_PAGE_SIZE, window.lastPage * SUBAGENT_TRANSCRIPT_PAGE_SIZE))
  }
  expect(seen.size).toBe(2500)
  expect(window.windowed).toBe(true)
  const latest = await loadWorkSubagentTranscript(identity, request, () => true, window)
  expect(latest.lastPage).toBe(50)
  expect(latest.rows.at(-1)?.id).toBe('row-2499')
})

test('UTF-8 transcript budgets retain complete pages in the requested direction', async () => {
  const data = rows(200).map(row => ({ ...row, content: '中'.repeat(1500) }))
  let window = await loadWorkSubagentTranscript(identity, archive(data), () => true)
  window = await loadWorkSubagentTranscript(identity, archive(data), () => true, window, 'older')
  expect(window.firstPage).toBe(3)
  expect(window.lastPage).toBe(4)
  window = await loadWorkSubagentTranscript(identity, archive(data), () => true, window, 'older')
  expect(window.firstPage).toBe(2)
  expect(window.lastPage).toBe(3)
  expect(window.residentBytes).toBeLessThanOrEqual(SUBAGENT_TRANSCRIPT_WINDOW_BYTES)
  expect(window.rows).toEqual(data.slice(50, 150))
})

test('protocol two ownership reads request only a summary before archive pagination', async () => {
  const calls: EngineRequestInput[] = []
  await loadWorkSubagentTranscript({ ...identity, subagentProtocol: 2 }, archive(rows(2), 'r1', calls), () => true)
  expect(calls[0]).toEqual({ method: 'GET', path: '/subagent/runs/run-one', subagentProtocol: 2, query: { view: 'summary', parentSessionId: 'parent' } })
})

test('oversized transcript pages leave the prior window intact and report the detail-reader option', async () => {
  const previous = await loadWorkSubagentTranscript(identity, archive(rows(2)), () => true)
  const preserved = JSON.stringify(previous), data = rows(2)
  data[1].content = '中'.repeat(SUBAGENT_TRANSCRIPT_WINDOW_BYTES)
  await expect(loadWorkSubagentTranscript(identity, archive(data, 'r2'), () => true, previous)).rejects.toThrow('按段读取原始详情')
  expect(JSON.stringify(previous)).toBe(preserved)
})
