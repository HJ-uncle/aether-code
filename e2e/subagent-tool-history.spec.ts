// Pure contracts: fixed-watermark history, scope isolation, bounded windows and preserved user drafts.
import { expect, test } from '@playwright/test'
import type { SubagentToolsPage, SubagentToolSummary } from '../src/shared/subagent'
import { loadSubagentToolWindow, subagentDetailOffsetTrail, SubagentHistorySupersededError, SUBAGENT_DETAIL_OFFSET_COUNT, SUBAGENT_TOOL_PAGE_SIZE, SUBAGENT_TOOL_WINDOW_BYTES, SUBAGENT_TOOL_WINDOW_COUNT, type SubagentHistoryScope, type SubagentToolWindow } from '../src/renderer/src/contrib/chat/subagent-tool-history'
import { trimWorkSubagentSessionCaches } from '../src/renderer/src/contrib/work/work-subagent-memory'

const scope: SubagentHistoryScope = { source: 1, tenantId: 'tenant', runId: 'run', rootSessionId: 'root', parentSessionId: 'parent', parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'parent-tool', childSessionId: 'child', atSeq: 2000 }
function tools(count: number, content = ''): SubagentToolSummary[] {
  return Array.from({ length: count }, (_, index) => ({ id: `tool-${index + 1}`, name: 'read_file', status: 'succeeded', args: content || { path: `file-${index + 1}` }, revisionSeq: index + 1, ordinal: index + 1, detailRef: `run/tool-${index + 1}/${index + 1}`, detailTruncated: true }))
}
function archive(items: SubagentToolSummary[], calls: { atSeq: number; cursor?: string }[] = []) {
  return async (value: SubagentHistoryScope, cursor?: string): Promise<SubagentToolsPage> => {
    calls.push({ atSeq: value.atSeq, cursor })
    const offset = Number(cursor ?? 0), end = Math.min(items.length, offset + SUBAGENT_TOOL_PAGE_SIZE)
    return { schemaVersion: 2, runId: value.runId, asOfSeq: value.atSeq, items: items.slice(offset, end), totalCount: items.length, hasMore: end < items.length, ...(end < items.length ? { nextCursor: String(end) } : {}) }
  }
}

test('reads 1000 calls at one watermark while keeping only a bounded resident window', async () => {
  const data = tools(1000), calls: { atSeq: number; cursor?: string }[] = []
  const fetchPage = archive(data, calls)
  let window: SubagentToolWindow | undefined
  do {
    window = await loadSubagentToolWindow(scope, fetchPage, () => true, window)
    expect(window.items.length).toBeLessThanOrEqual(SUBAGENT_TOOL_WINDOW_COUNT)
    expect(window.residentBytes).toBeLessThanOrEqual(SUBAGENT_TOOL_WINDOW_BYTES)
    expect(window.droppedCount + window.items.length).toBe(window.loadedCount)
    expect(window.items.at(-1)?.ordinal).toBe(window.loadedCount)
  } while (window.hasMore)
  expect(window.loadedCount).toBe(1000)
  expect(window.totalCount).toBe(1000)
  expect(window.items.map(call => call.id)).toEqual(data.slice(-SUBAGENT_TOOL_WINDOW_COUNT).map(call => call.id))
  expect(calls).toHaveLength(20)
  expect(new Set(calls.map(call => call.atSeq))).toEqual(new Set([scope.atSeq]))
  expect(await loadSubagentToolWindow(scope, fetchPage, () => true, window)).toBe(window)
  expect(calls).toHaveLength(20)
})

test('the UTF-8 budget trims complete summaries without losing cursor progress', async () => {
  const data = tools(100, '中'.repeat(3000)), fetchPage = archive(data)
  let window = await loadSubagentToolWindow(scope, fetchPage, () => true)
  window = await loadSubagentToolWindow(scope, fetchPage, () => true, window)
  expect(window.loadedCount).toBe(100)
  expect(window.items.length).toBeLessThan(100)
  expect(window.residentBytes).toBe(new TextEncoder().encode(window.items.map(item => JSON.stringify(item)).join('')).byteLength)
  expect(window.residentBytes).toBeLessThanOrEqual(SUBAGENT_TOOL_WINDOW_BYTES)
  expect(window.items.at(-1)?.id).toBe('tool-100')
  expect(window.hasMore).toBe(false)
})

test('source, tenant, run and every ownership boundary isolate prior windows before making a request', async () => {
  const previous = await loadSubagentToolWindow(scope, archive(tools(100)), () => true)
  for (const key of Object.keys(scope) as (keyof SubagentHistoryScope)[]) {
    const next = { ...scope, [key]: typeof scope[key] === 'number' ? Number(scope[key]) + 1 : `${scope[key]}-other` }
    let requests = 0
    await expect(loadSubagentToolWindow(next, async () => { requests++; throw new Error('must not fetch') }, () => true, previous)).rejects.toBeInstanceOf(SubagentHistorySupersededError)
    expect(requests).toBe(0)
  }
})

test('a source switch discards a delayed response and preserves the previous window', async () => {
  const data = tools(100), fetchPage = archive(data), previous = await loadSubagentToolWindow(scope, fetchPage, () => true)
  const preserved = JSON.stringify(previous)
  let current = true, release!: (page: SubagentToolsPage) => void
  const response = new Promise<SubagentToolsPage>(resolve => { release = resolve })
  const pending = loadSubagentToolWindow(scope, () => response, () => current, previous)
  current = false
  release(await fetchPage(scope, previous.nextCursor))
  await expect(pending).rejects.toBeInstanceOf(SubagentHistorySupersededError)
  expect(JSON.stringify(previous)).toBe(preserved)
})

test('gaps, duplicate IDs, future revisions, moving watermarks and stalled cursors are visible errors', async () => {
  const data = tools(100), fetchPage = archive(data), previous = await loadSubagentToolWindow(scope, fetchPage, () => true)
  const preserved = JSON.stringify(previous), valid = await fetchPage(scope, previous.nextCursor)
  const invalid: SubagentToolsPage[] = [
    { ...valid, asOfSeq: scope.atSeq + 1 },
    { ...valid, runId: 'another-run' },
    { ...valid, totalCount: 101 },
    { ...valid, items: valid.items.map((call, index) => index ? call : { ...call, ordinal: 53 }) },
    { ...valid, items: valid.items.map((call, index) => index ? call : { ...call, id: previous.items[0].id }) },
    { ...valid, items: valid.items.map((call, index) => index ? call : { ...call, revisionSeq: scope.atSeq + 1 }) },
    { ...valid, hasMore: true, nextCursor: previous.nextCursor },
    { ...valid, items: valid.items.slice(0, 10) }
  ]
  for (const page of invalid) {
    await expect(loadSubagentToolWindow(scope, async () => page, () => true, previous)).rejects.toThrow('不一致')
    expect(JSON.stringify(previous)).toBe(preserved)
  }
  const retried = await loadSubagentToolWindow(scope, fetchPage, () => true, previous)
  expect(retried.loadedCount).toBe(100)
})

test('an oversized summary errors instead of claiming all records were loaded', async () => {
  await expect(loadSubagentToolWindow(scope, archive(tools(1, 'x'.repeat(SUBAGENT_TOOL_WINDOW_BYTES))), () => true)).rejects.toThrow('单条工具摘要过大')
})

test('detail navigation retains only bounded exact offsets and can return to the start', () => {
  const offsets = Array.from({ length: 500 }, (_, index) => index * 32767)
  let trail: number[] = []
  for (let index = 1; index < offsets.length; index++) trail = subagentDetailOffsetTrail(trail, offsets[index - 1], offsets[index])
  expect(trail).toEqual(offsets.slice(-SUBAGENT_DETAIL_OFFSET_COUNT - 1, -1))
  const previous = trail.at(-1)!
  trail = subagentDetailOffsetTrail(trail, offsets.at(-1)!, previous)
  expect(trail.at(-1)).toBe(offsets.at(-3))
  expect(subagentDetailOffsetTrail(trail, previous, 0)).toEqual([])
})

test('evicting old transcript caches preserves unsent input while empty old sessions are removed', () => {
  const memory = (draft = '') => ({ drafts: new Map([['child', draft]]), errors: new Map([['child', 'error']]), detailTop: new Map([['child', 120]]), views: new Map<string, 'rounds' | 'transcript'>([['child', 'transcript']]), transcripts: new Map<string, unknown>([['child', { rows: ['large payload'] }]]) })
  const draft = '检查 "first"\n然后继续', pinned = memory(draft)
  const memories = new Map([['1:old-draft', pinned], ['1:old-empty', memory()], ...Array.from({ length: 4 }, (_, index) => [`1:recent-${index}`, memory()] as const)])
  trimWorkSubagentSessionCaches(memories)
  expect(memories.has('1:old-empty')).toBe(false)
  expect(memories.get('1:old-draft')?.drafts.get('child')).toBe(draft)
  expect(pinned.transcripts.size).toBe(0)
  expect(pinned.detailTop.size).toBe(0)
  expect(pinned.views.size).toBe(0)
  expect([...memories.values()].filter(value => value.transcripts.size)).toHaveLength(4)
  pinned.drafts.clear()
  trimWorkSubagentSessionCaches(memories)
  expect(memories.has('1:old-draft')).toBe(false)
})
