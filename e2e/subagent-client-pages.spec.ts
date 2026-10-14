// Pure production-client contracts with a fake IPC bridge; no Electron or model starts.
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import {
  cancelSubagentRun, getSubagentRun, getSubagentToolDetail, getSubagentProtocol, listSubagentEvents,
  listSubagentRuns, listSubagentToolCalls, parseSubagentRunsPage, SubagentCapabilityError
} from '../src/renderer/src/core/engine/client'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'

let result: unknown
let calls: EngineRequestInput[]
let previousWindow: PropertyDescriptor | undefined
let capabilitiesResult: { ok: boolean; code: number; data: unknown; message: string }
let fixtureSource = 0

test.beforeEach(() => {
  calls = []
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: `pure-subagent-${++fixtureSource}` })
  capabilitiesResult = { ok: true, code: 200, data: { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
    toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }, message: 'ok' }
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      if (input.path === '/subagent/capabilities') return capabilitiesResult
      calls.push(input)
      return { ok: true, code: 200, data: result, message: 'ok' }
    }
  } } } })
})

test.afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const summary = { schemaVersion: 2, view: 'summary', runId: 'child', parentSessionId: 'parent', rootSessionId: 'parent', lastSeq: 8 }

test('summary negotiation preserves a partial collection instead of inventing completeness', async () => {
  result = { schemaVersion: 2, runs: [summary], hasMore: true, listComplete: false, nextCursor: 'opaque', revision: 'fixed' }
  const first = await listSubagentRuns('parent', { limit: 1 })
  expect(first).toEqual(result)
  expect(first.listComplete).toBe(false)
  expect(calls[0]).toMatchObject({ method: 'GET', path: '/subagent/runs', query: { parentSessionId: 'parent', view: 'summary', limit: 1 } })
  result = { schemaVersion: 2, runs: [], hasMore: false, listComplete: false, revision: 'fixed' }
  expect((await listSubagentRuns('parent', { cursor: first.nextCursor })).listComplete).toBe(false)
  expect(calls[1].query?.cursor).toBe('opaque')
})

test('only an actual legacy v1 array receives a complete-array marker', () => {
  const legacy = [{ schemaVersion: 1, runId: 'legacy' }]
  expect(parseSubagentRunsPage(legacy)).toEqual({ schemaVersion: 1, runs: legacy, listComplete: true, hasMore: false })
  expect(() => parseSubagentRunsPage([summary])).toThrow('旧版子代理列表协议无效')
  expect(() => parseSubagentRunsPage({ schemaVersion: 3, runs: [], listComplete: true, hasMore: false })).toThrow('子代理分页协议无效')
  expect(() => parseSubagentRunsPage({ schemaVersion: 2, runs: [], listComplete: true, hasMore: true, nextCursor: 'x', revision: 'r' })).toThrow('子代理分页协议无效')
})

test('run reads and cancellation negotiate summaries and bind the parent context', async () => {
  result = summary
  await getSubagentRun('child', { parentSessionId: 'parent', atSeq: 8 })
  await cancelSubagentRun('child', { parentSessionId: 'parent' })
  expect(calls[0].query).toEqual({ view: 'summary', parentSessionId: 'parent', atSeq: 8 })
  expect(calls[1]).toMatchObject({ method: 'POST', path: '/subagent/runs/child/cancel', query: { view: 'summary', parentSessionId: 'parent' } })
  result = { ...summary, lastSeq: 9 }
  await expect(getSubagentRun('child', { atSeq: 8 })).rejects.toThrow('子代理摘要协议无效')
  await expect(getSubagentRun('child', { parentSessionId: 'other' })).rejects.toThrow('子代理摘要协议无效')
})

test('tool pages reject a future watermark and maintain opaque cursor binding', async () => {
  result = { schemaVersion: 2, runId: 'child', asOfSeq: 8, items: [{ id: 'tool' }], totalCount: 2, hasMore: true, nextCursor: 'tool-cursor' }
  expect((await listSubagentToolCalls('child', { atSeq: 8, cursor: 'previous', limit: 1 })).totalCount).toBe(2)
  expect(calls[0]).toMatchObject({ path: '/subagent/runs/child/tools', query: { atSeq: 8, cursor: 'previous', limit: 1 } })
  result = { schemaVersion: 2, runId: 'child', asOfSeq: 9, items: [], totalCount: 0, hasMore: false }
  await expect(listSubagentToolCalls('child', { atSeq: 8 })).rejects.toThrow('子代理工具分页协议无效')
})

test('explicit detail chunks do not load or silently assemble the full tool', async () => {
  result = { schemaVersion: 2, runId: 'child', asOfSeq: 8, tool: { id: 'tool/id' }, detail: {
    encoding: 'json-utf8', text: '文字', offset: 0, nextOffset: 6, totalBytes: 30, hasMore: true
  } }
  const page = await getSubagentToolDetail('child', 'tool/id', { atSeq: 8, limitBytes: 16 })
  expect(page.detail).toMatchObject({ text: '文字', hasMore: true, nextOffset: 6 })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ path: '/subagent/runs/child/tools/tool%2Fid', query: { atSeq: 8, limitBytes: 16 } })
  await expect(getSubagentToolDetail('child', 'tool/id', { atSeq: 8, offset: 6 })).rejects.toThrow('子代理工具详情分页协议无效')
})

test('delta replay preserves checkpoint-required rather than treating a gap as no events', async () => {
  result = { schemaVersion: 2, runId: 'child', events: [], nextSeq: 8, hasMore: false, checkpointRequired: true }
  expect((await listSubagentEvents('child', { afterSeq: 8, limit: 32 })).checkpointRequired).toBe(true)
  expect(calls[0].query).toEqual({ format: 'delta', afterSeq: 8, limit: 32 })
  result = { schemaVersion: 2, runId: 'child', events: [{ schemaVersion: 3, runId: 'child' }], nextSeq: 9, hasMore: false, checkpointRequired: false }
  await expect(listSubagentEvents('child', { afterSeq: 8 })).rejects.toThrow('子代理增量分页协议无效')
})

test('only a capability 404 or explicit unsupported error permits legacy fallback', async () => {
  capabilitiesResult = { ok: false, code: 404, data: null, message: 'Not found' }
  result = [{ schemaVersion: 1, runId: 'legacy' }]
  expect(await getSubagentProtocol()).toBe(1)
  expect(await listSubagentRuns('parent')).toMatchObject({ schemaVersion: 1, listComplete: true, hasMore: false })
  expect(calls[0].query).toEqual({ parentSessionId: 'parent', view: 'legacy' })
  await expect(listSubagentToolCalls('legacy', { atSeq: 1 })).rejects.toThrow('当前引擎不支持子代理分页协议')
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: `pure-subagent-${++fixtureSource}` })
  capabilitiesResult = { ok: false, code: 401, data: null, message: 'sign in again' }
  await expect(listSubagentRuns('parent')).rejects.toThrow('sign in again')
  await expect(getSubagentProtocol()).rejects.toMatchObject({ name: 'SubagentCapabilityError', code: 401, status: 401 })
  expect(calls).toHaveLength(1)
  capabilitiesResult = { ok: false, code: -1, data: null, message: 'offline' }
  await expect(listSubagentRuns('parent')).rejects.toThrow('offline')
  await expect(getSubagentProtocol()).rejects.toMatchObject({ name: 'SubagentCapabilityError', code: -1, status: -1 })
  expect(calls).toHaveLength(1)
})

test('authentication business codes retain their HTTP status for the recovery state machine', () => {
  expect(new SubagentCapabilityError('forbidden', 40300)).toMatchObject({ code: 40300, status: 403 })
})

test('a negotiated v2 server cannot silently return a complete v1 collection', async () => {
  result = [{ schemaVersion: 1, runId: 'legacy' }]
  await expect(listSubagentRuns('parent')).rejects.toThrow('子代理响应与协商协议不一致')
  result = { schemaVersion: 1, runId: 'child' }
  await expect(getSubagentRun('child')).rejects.toThrow('子代理摘要协议无效')
})
