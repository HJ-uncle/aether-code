/** Full child archives retain every row and large output in one owned snapshot; no Electron or network. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import type { SubagentRunV1 } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { loadFullSessionSubagentTranscript, SessionTranscriptSupersededError, type SessionTranscriptIdentity, type SessionTranscriptRequest } from '../src/renderer/src/features/collaboration/subagent-transcript'

const identity: SessionTranscriptIdentity = { source: 1, parentSessionId: 'parent', childSessionId: 'child', runId: 'child-run', subagentProtocol: 2 }
const run: SubagentRunV1 = { schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
  parentConversationId: 'parent-turn', parentMessageId: 'parent-message', parentToolCallId: 'dispatch-tool', childSessionId: 'child',
  task: '检查文件', description: '检查', modelId: 'model', status: 'succeeded', lastSeq: 3, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [] }
const success = (data: unknown, extra: Partial<EngineRequestResult<unknown>> = {}): EngineRequestResult<unknown> => ({ ok: true, code: 200, message: '', data, ...extra })
const row = (id = 'answer'): EngineHistoryRow => ({ id, role: 'assistant', content: '完整正文', createdAt: 1 })
const archive = (rows: unknown[], metadata: Record<string, unknown> = {}): EngineRequestResult<unknown> => success(rows, {
  metadata: { backend: 'jsonl', compressed: false, archiveMessageCount: rows.length, ...metadata }
})
function fixture(response: EngineRequestResult<unknown>, owner: unknown = run) {
  const calls: EngineRequestInput[] = []
  const request: SessionTranscriptRequest = async input => {
    calls.push(input)
    return input.path.startsWith('/subagent/runs/') ? success(owner) : response
  }
  return { calls, request }
}

test('full archive loads over 200 rows and over 512 KiB without truncating text or requesting pages', async () => {
  const rows: EngineHistoryRow[] = Array.from({ length: 251 }, (_, index) => row(`message-${index}`))
  rows[150] = { id: 'large-tool-output', role: 'tool', toolCallId: 'call', content: '原始输出😀'.repeat(100_000), createdAt: 2 }
  const original = structuredClone(rows)
  const { calls, request } = fixture(archive(rows, { compressed: true, archiveRevision: 'stable-revision' }))
  const result = await loadFullSessionSubagentTranscript(identity, request, () => true)
  expect(calls).toEqual([
    { method: 'GET', path: '/subagent/runs/child-run', subagentProtocol: 2, query: { view: 'summary', parentSessionId: 'parent' } },
    { method: 'GET', path: '/conversation/archive', query: { sessionId: 'child' } }
  ])
  expect(result).toMatchObject({ identity, endpoint: '/conversation/archive', firstPage: 1, lastPage: 6, total: 251,
    revision: 'stable-revision', backend: 'jsonl', compressed: true, windowed: false })
  expect(result.rows).toEqual(original)
  expect(rows).toEqual(original)
  expect(result.residentBytes).toBe(new TextEncoder().encode(JSON.stringify(rows)).byteLength)
  expect(result.residentBytes).toBeGreaterThan(512 * 1024)
})

test('the real unpaged JSONL contract needs neither pagination nor an archive revision', async () => {
  const { request } = fixture(archive([row()]))
  const result = await loadFullSessionSubagentTranscript(identity, request, () => true)
  expect(result.revision).toBeUndefined()
  expect(result.rows).toEqual([row()])
  expect(result.windowed).toBe(false)
  const empty = await loadFullSessionSubagentTranscript(identity, fixture(archive([])).request, () => true)
  expect(empty).toMatchObject({ rows: [], total: 0, firstPage: 1, lastPage: 1, windowed: false, residentBytes: 2 })
})

test('foreign or malformed run ownership is rejected before any history request', async () => {
  for (const owner of [{ ...run, parentSessionId: 'other' }, { ...run, childSessionId: 'other' }, { ...run, runId: 'other' },
    { ...run, childSessionId: '' }, { ...run, schemaVersion: 99 }, null]) {
    const { request, calls } = fixture(archive([row()]), owner)
    await expect(loadFullSessionSubagentTranscript(identity, request, () => true)).rejects.toThrow('子代理不属于当前任务')
    expect(calls).toHaveLength(1)
  }
})

test('identity is checked before reading, after ownership and after the complete archive response', async () => {
  const untouched = fixture(archive([row()]))
  await expect(loadFullSessionSubagentTranscript(identity, untouched.request, () => false)).rejects.toBeInstanceOf(SessionTranscriptSupersededError)
  expect(untouched.calls).toHaveLength(0)
  for (const retireAt of ['/subagent/runs/child-run', '/conversation/archive']) {
    let current = true
    const calls: string[] = []
    const request: SessionTranscriptRequest = async input => {
      calls.push(input.path)
      if (input.path === retireAt) current = false
      return input.path.startsWith('/subagent/runs/') ? success(run) : archive([row()])
    }
    await expect(loadFullSessionSubagentTranscript(identity, request, () => current)).rejects.toBeInstanceOf(SessionTranscriptSupersededError)
    expect(calls.at(-1)).toBe(retireAt)
  }
})

test('only unsupported archive responses fall back to complete retained history', async () => {
  for (const code of [404, 40401, 501, 50101]) {
    const calls: EngineRequestInput[] = []
    const request: SessionTranscriptRequest = async input => {
      calls.push(input)
      if (input.path.startsWith('/subagent/runs/')) return success(run)
      if (input.path === '/conversation/archive') return { ok: false, code, message: 'unsupported', data: null }
      return success([row()], { metadata: { sessionUsage: { totalTokens: 100 } } })
    }
    const result = await loadFullSessionSubagentTranscript(identity, request, () => true)
    expect(calls.map(call => call.path)).toEqual(['/subagent/runs/child-run', '/conversation/archive', '/conversation/history'])
    expect(calls[2].query).toEqual({ sessionId: 'child' })
    expect(result).toMatchObject({ endpoint: '/conversation/history', rows: [row()], total: 1, windowed: false })
    expect(result.backend).toBeUndefined()
  }
  const sqlite = await loadFullSessionSubagentTranscript(identity, fixture(success([row()], { metadata: { backend: 'sqlite', compressed: true, currentMessageCount: 1 } })).request, () => true)
  expect(sqlite).toMatchObject({ endpoint: '/conversation/archive', backend: 'sqlite', compressed: true })
})

test('authorization, transport and malformed archive failures are not hidden by fallback', async () => {
  for (const code of [401, 403, 409, 500, -1]) {
    const { calls, request } = fixture({ ok: false, code, message: `failure-${code}`, data: null })
    await expect(loadFullSessionSubagentTranscript(identity, request, () => true)).rejects.toThrow(`failure-${code}`)
    expect(calls.map(call => call.path)).toEqual(['/subagent/runs/child-run', '/conversation/archive'])
  }
  const { calls, request } = fixture(success({ rows: [row()] }))
  await expect(loadFullSessionSubagentTranscript(identity, request, () => true)).rejects.toThrow('读取子代理完整对话失败')
  expect(calls).toHaveLength(2)
})

test('invalid rows, duplicate IDs and inconsistent full-response metadata fail atomically', async () => {
  const malformed = [
    archive([row(), row()]), archive([{ ...row(), id: '' }]), archive([{ ...row(), role: 'unknown' }]),
    archive([{ ...row(), metadata: { attachments: [{ name: 123 }] } }]), archive([{ ...row(), createdAt: NaN }]),
    archive([{ ...row(), toolCall: { id: 123 } }]), archive([row()], { archiveMessageCount: 2 }),
    archive([row()], { archiveMessageCount: '1' }), archive([row()], { archiveRevision: '' }),
    archive([row()], { archiveRevision: 3 }), archive([row()], { backend: 5 }), archive([row()], { compressed: 'yes' })
  ]
  for (const response of malformed) {
    const { request, calls } = fixture(response)
    await expect(loadFullSessionSubagentTranscript(identity, request, () => true)).rejects.toThrow()
    expect(calls).toHaveLength(2)
  }
})

test('a server default page cannot masquerade as a complete snapshot', async () => {
  for (const pagination of [
    { current: 1, pageSize: 1, total: 20, totalPages: 20 },
    { current: 2, pageSize: 1, total: 1, totalPages: 1 },
    { current: 1, pageSize: 0, total: 1, totalPages: 1 },
    { current: 1, pageSize: 1, total: 1, totalPages: 2 }
  ]) {
    const response = success([row()], { pagination })
    await expect(loadFullSessionSubagentTranscript(identity, fixture(response).request, () => true)).rejects.toThrow('不完整的分页')
  }
  const complete = success([row()], { pagination: { current: 1, pageSize: 200, total: 1, totalPages: 1 } })
  expect((await loadFullSessionSubagentTranscript(identity, fixture(complete).request, () => true)).rows).toEqual([row()])
})

test('legacy protocol ownership requests remain compatible and encode the exact run identifier', async () => {
  const legacy = { ...identity, runId: 'child/run #1', subagentProtocol: 1 as const }
  const { calls, request } = fixture(archive([row()]), { ...run, runId: legacy.runId })
  await loadFullSessionSubagentTranscript(legacy, request, () => true)
  expect(calls[0]).toEqual({ method: 'GET', path: '/subagent/runs/child%2Frun%20%231' })
})
