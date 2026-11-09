import type { SubagentResultPage, SubagentRun } from '@shared/subagent'

const encoder = new TextEncoder()
const hashPattern = /^[a-f0-9]{64}$/

/** Integrity is independent of tool coverage and survives every preview limit. */
export function subagentResultPresentation(run: SubagentRun, text = run.resultSummary ?? run.partialOutput ?? '') {
  const bytes = encoder.encode(text).byteLength
  const referenced = typeof run.resultHash === 'string' && hashPattern.test(run.resultHash)
    && run.resultRef === `subagent-result:v1:${run.resultHash}`
    && Number.isSafeInteger(run.resultBytes) && run.resultBytes! >= bytes
  const truncated = run.resultTruncated === true || (referenced && run.resultBytes! > bytes)
  const partial = run.resultKind === 'partial' || (!run.resultSummary && Boolean(run.partialOutput))
  const complete = referenced && run.resultTruncated === false && !truncated
  return { bytes, referenced, truncated, partial, complete,
    label: partial ? '部分结果' : truncated ? '结果预览' : '返回结果',
    notice: truncated ? referenced ? '当前仅显示结果预览，完整内容已单独保存。' : '当前仅显示结果预览，此记录未提供完整结果引用。'
      : !complete && text ? '此记录未保存结果完整性信息。' : '' }
}

/** Reject changed identity, malformed byte cursors and unbounded server pages. */
export function parseSubagentResultPage(value: unknown, expected: {
  runId: string; offset: number; limitBytes: number; resultRef: string; resultHash: string; totalBytes: number; kind?: 'final' | 'partial'
}): SubagentResultPage {
  const page = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const bytes = typeof page?.text === 'string' ? encoder.encode(page.text).byteLength : 0
  if (!page || page.runId !== expected.runId || page.resultRef !== expected.resultRef
    || page.resultHash !== expected.resultHash || !hashPattern.test(expected.resultHash)
    || expected.resultRef !== `subagent-result:v1:${expected.resultHash}`
    || !['final', 'partial'].includes(String(page.resultKind)) || (expected.kind !== undefined && page.resultKind !== expected.kind)
    || page.encoding !== 'utf8' || typeof page.text !== 'string' || page.offset !== expected.offset
    || !Number.isSafeInteger(page.totalBytes) || page.totalBytes !== expected.totalBytes || expected.offset > expected.totalBytes
    || bytes > expected.limitBytes || expected.offset + bytes > expected.totalBytes || typeof page.hasMore !== 'boolean'
    || (page.hasMore && (bytes === 0 || page.nextOffset !== expected.offset + bytes || page.nextOffset === page.totalBytes))
    || (!page.hasMore && (expected.offset + bytes !== expected.totalBytes || page.nextOffset !== undefined))) {
    throw new Error('子代理结果分页协议无效，未使用不完整或不属于此任务的内容')
  }
  return page as unknown as SubagentResultPage
}
