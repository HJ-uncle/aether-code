/** Bounded child result integrity, replay, export coverage and admission semantics. No user data or model. */
import { expect, test } from '@playwright/test'
import type { SubagentRunV1 } from '../src/shared/subagent'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { boundSubagentView, exportSubagentDetails, mergeSubagentRun, normalizeSubagentDeltaEvent, normalizeSubagentRun, reduceSubagentDelta,
  toSubagentView, toolStatusLabel } from '../src/renderer/src/core/engine/subagent-state'
import { parseSubagentResultPage, subagentResultPresentation } from '../src/renderer/src/core/engine/subagent-result'
import { serializeMessages } from '../src/renderer/src/features/conversation/shared/message-export'

const hash = 'a'.repeat(64), ref = `subagent-result:v1:${hash}`
function run(patch: Partial<SubagentRunV1> = {}): SubagentRunV1 {
  return { schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'turn', parentMessageId: 'answer', parentToolCallId: 'dispatch', childSessionId: 'child',
    task: '核对接口', description: '调研', modelId: 'fixture', status: 'succeeded', lastSeq: 2, createdAt: 1, updatedAt: 2,
    resultSummary: '正文', usage: { totalTokens: 7 }, toolCalls: [], ...patch }
}
function tool(subagent?: SubagentRunV1): ToolActivity {
  return { id: 'dispatch', name: 'subagent', args: '{}', result: '', state: 'done', subagent }
}

test('4 KiB local bounding keeps a separate integrity flag and stable content reference', () => {
  const view = toSubagentView(run({ resultSummary: '记忆🧠'.repeat(900), resultRef: ref, resultHash: hash,
    resultBytes: 9000, resultTruncated: false, resultKind: 'final' }))
  const bounded = boundSubagentView(view)
  expect(new TextEncoder().encode(bounded.resultSummary).byteLength).toBeLessThanOrEqual(4096)
  expect(bounded.resultSummary).not.toContain('�')
  expect(bounded).toMatchObject({ resultRef: ref, resultHash: hash, resultBytes: 9000, resultTruncated: true, resultKind: 'final' })
  expect(subagentResultPresentation(bounded)).toMatchObject({ referenced: true, truncated: true, complete: false, label: '结果预览' })
  expect(normalizeSubagentRun(bounded)).toMatchObject({ resultRef: ref, resultTruncated: true })
})

test('complete final and complete partial output differ from old unverified summaries', () => {
  const fields = { resultRef: ref, resultHash: hash, resultBytes: 6, resultTruncated: false }
  expect(subagentResultPresentation(run({ ...fields, resultKind: 'final' }))).toMatchObject({ complete: true, label: '返回结果', notice: '' })
  expect(subagentResultPresentation(run({ ...fields, resultKind: 'partial' }))).toMatchObject({ complete: true, partial: true, label: '部分结果' })
  expect(subagentResultPresentation(run())).toMatchObject({ complete: false, referenced: false, notice: '此记录未保存结果完整性信息。' })
  expect(subagentResultPresentation(run({ ...fields, resultBytes: 5 }))).toMatchObject({ complete: false, referenced: false })
})

test('snapshot/delta metadata survives replay and incomplete same-watermark observations', () => {
  const before = toSubagentView(run({ status: 'running', resultSummary: undefined, lastSeq: 1 }))
  const identity = { tenantId: before.tenantId, rootSessionId: before.rootSessionId, parentSessionId: before.parentSessionId,
    parentConversationId: before.parentConversationId, parentMessageId: before.parentMessageId, parentToolCallId: before.parentToolCallId, childSessionId: before.childSessionId }
  const event = normalizeSubagentDeltaEvent({ schemaVersion: 2, kind: 'finished', runId: before.runId, seq: 2, baseSeq: 1, identity,
    headerPatch: { status: 'succeeded', updatedAt: 2, resultSummary: '正文', resultRef: ref, resultHash: hash,
      resultBytes: 6, resultTruncated: false, resultKind: 'final' } })!
  expect(event).toBeDefined()
  const reduced = reduceSubagentDelta(before, event)
  expect(reduced.reason ?? reduced.status).toBe('applied')
  const next = reduced.run!
  expect(next).toMatchObject({ resultRef: ref, resultHash: hash, resultBytes: 6, resultTruncated: false })
  const observation = { ...next, resultRef: undefined, resultHash: undefined, resultBytes: undefined, resultTruncated: undefined, resultKind: undefined }
  expect(mergeSubagentRun(next, observation)).toMatchObject({ resultRef: ref, resultBytes: 6, resultKind: 'final' })
  expect(normalizeSubagentDeltaEvent({ ...event, headerPatch: { resultBytes: -1 } })).toBeUndefined()
  expect(normalizeSubagentRun(run({ resultHash: 'malformed' }))).toBeUndefined()
})

test('export reports real counts, loaded sample, watermark, omitted tool details and result reference', () => {
  const view = toSubagentView(run({ resultRef: ref, resultHash: hash, resultBytes: 30000, resultTruncated: true, resultKind: 'final',
    toolCalls: [{ id: 'graph', name: 'codegraph', args: { action: 'search', path: '.', query: 'main' }, status: 'failed', output: '64 MiB read limit' }] }))
  const partial = { ...view, toolCount: 91, toolCalls: view.toolCalls.map(call => ({ ...call, detailTruncated: true })),
    coverage: { ...view.coverage, toolCount: 91, hasMore: true, completeness: 'partial' as const } }
  const exported = exportSubagentDetails({ ...tool(), subagent: partial })
  expect(exported).toContain('工具调用 91；已加载 1；记录水位 #2；完整性 partial')
  expect(exported).toContain('不能据此判定其余工具未执行')
  expect(exported).toContain('详情不完整')
  expect(exported).toContain('"action":"search"')
  expect(exported).toContain('64 MiB read limit')
  expect(exported).toContain(ref)
  expect(exported).toContain('结果完整性：当前仅显示结果预览')
})

test('accepting followup, observing waits and completing children have distinct labels', () => {
  expect(toolStatusLabel({ ...tool(), name: 'subagent_followup' })).toBe('已接纳')
  expect(toolStatusLabel({ ...tool(), name: 'subagent_wait' })).toBe('已读取')
  expect(toolStatusLabel(tool(run({ toolCalls: [{ id: 'graph', name: 'codegraph', args: {}, status: 'failed' }] })))).toBe('已完成')
  expect(toolStatusLabel({ ...tool(), name: 'subagent_followup', state: 'error' })).toBe('失败')
  expect(toolStatusLabel({ ...tool(), name: 'codegraph' })).toBe('成功')
})

test('ordinary successful codegraph exports keep the operation as well as the path', () => {
  const exported = serializeMessages([{ id: 'msg', role: 'assistant', content: '', thinking: '', items: [], status: 'done', createdAt: 1,
    tools: [{ ...tool(), name: 'codegraph', args: JSON.stringify({ action: 'status', path: '.' }) }] }])
  expect(exported).toContain('status · .（成功）')
})

test('page parser preserves exact UTF-8 ranges, empty results and final versus partial output', () => {
  const expected = { runId: 'child-run', resultRef: ref, resultHash: hash, offset: 0, limitBytes: 8, totalBytes: 10, kind: 'partial' as const }
  const page = { ...expected, encoding: 'utf8', resultKind: 'partial', text: '记忆', hasMore: true, nextOffset: 6 }
  expect(parseSubagentResultPage(page, expected).nextOffset).toBe(6)
  expect(parseSubagentResultPage({ ...page, offset: 6, text: '🧠', hasMore: false, nextOffset: undefined }, { ...expected, offset: 6 })).toMatchObject({ text: '🧠' })
  expect(parseSubagentResultPage({ ...page, resultKind: 'final', text: '', totalBytes: 0, hasMore: false, nextOffset: undefined }, { ...expected, totalBytes: 0, kind: 'final' }).text).toBe('')
})

test('page parser rejects wrong identity, changing hashes/totals, oversized and stalled cursors', () => {
  const expected = { runId: 'child-run', resultRef: ref, resultHash: hash, offset: 0, limitBytes: 6, totalBytes: 10 }
  const page = { ...expected, encoding: 'utf8', resultKind: 'final', text: '记忆', hasMore: true, nextOffset: 6 }
  for (const patch of [{ runId: 'foreign' }, { resultHash: 'b'.repeat(64) }, { resultRef: 'other' }, { totalBytes: 9 }, { offset: 1 },
    { text: '记忆🧠' }, { text: '', nextOffset: 0 }, { nextOffset: 5 }, { nextOffset: 10 }, { hasMore: false }, { resultKind: 'unknown' }])
    expect(() => parseSubagentResultPage({ ...page, ...patch }, expected), JSON.stringify(patch)).toThrow('分页协议无效')
})
