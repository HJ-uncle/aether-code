// Pure contracts: safe child-history ownership, bounded archives, stale-source rejection and lossless long outputs.
import { expect, test } from '@playwright/test'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import type { SubagentRun } from '../src/shared/subagent'
import { loadWorkSubagentTranscript, SUBAGENT_TRANSCRIPT_PAGE_SIZE, workTranscriptText, WorkTranscriptSupersededError, type WorkTranscriptIdentity, type WorkTranscriptRequest } from '../src/renderer/src/contrib/work/work-subagent-transcript'

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
