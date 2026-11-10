/** Usage percentages: billing scope, missing counters, per-call cache caps and
 * authoritative session totals. Pure functions only; no Electron or engine. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRunV1 } from '../src/shared/subagent'
import { sumUsage, type UsageDetailRow, type UsageFrame, type UsageTotal } from '../src/renderer/src/contrib/chat/usage'
import { usagePercentage } from '../src/renderer/src/contrib/chat/usage-percentage'
import { createSessionUsageAnchor, sessionUsageTotal } from '../src/renderer/src/contrib/chat/session-usage'

function row(patch: Partial<UsageDetailRow> = {}): UsageDetailRow {
  return { label: '累计输入 Prompt', group: 'input', tokens: 100, ...patch }
}

function message(id: string, usage: UsageFrame, tools: ToolActivity[] = []): ChatMessage {
  return { id, role: 'assistant', content: '', thinking: '', tools, items: [], status: 'done', createdAt: 1, usage }
}

function detail(usage: UsageTotal, label: string): UsageDetailRow {
  const value = usage.summary.find(item => item.label === label)
  expect(value, `Missing billing row: ${label}`).toBeDefined()
  return value!
}

function percentage(usage: UsageTotal, label: string) {
  return usagePercentage(detail(usage, label), usage.total, usage.summary)
}

function child(id: string, usage: SubagentRunV1['usage']): ToolActivity {
  const subagent: SubagentRunV1 = {
    schemaVersion: 1, runId: id, tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'turn', parentMessageId: 'answer', parentToolCallId: id, childSessionId: `${id}-session`,
    task: '核对记录', description: '用量测试', modelId: 'fixture', status: 'succeeded', lastSeq: 2,
    createdAt: 1, updatedAt: 2, finishedAt: 2, usage, toolCalls: []
  }
  return { id, name: 'subagent', args: '{}', result: '', state: 'done', subagent }
}

test('top-level percentages use the displayed total and preserve small nonzero consumption', () => {
  const cases = [
    { tokens: 0, total: 1_000, value: '0%' },
    { tokens: 125, total: 1_000, value: '12.5%' },
    { tokens: 500, total: 1_000, value: '50%' },
    { tokens: 2, total: 3, value: '66.7%' },
    { tokens: 1, total: 1_000, value: '0.1%' },
    { tokens: 1, total: 10_000, value: '<0.1%' },
    { tokens: 1_000, total: 1_000, value: '100%' }
  ]
  for (const { tokens, total, value } of cases) {
    expect(usagePercentage(row({ tokens }), total, [])).toEqual({ value, basisLabel: '总用量', basisTokens: total })
  }
})

test('child percentage follows its explicit billing denominator rather than its label or overall total', () => {
  const cache = row({ label: '供应商复用输入', group: 'cache', child: true, tokens: 600,
    shareOf: { tokens: 1_000, label: '累计输入' } })
  const reasoning = row({ label: '模型内部计算', group: 'output', child: true, tokens: 75,
    shareOf: { tokens: 300, label: '累计输出' } })
  expect(usagePercentage(cache, 20_000, [cache, reasoning])).toEqual({ value: '60%', basisLabel: '累计输入', basisTokens: 1_000 })
  expect(usagePercentage(reasoning, 20_000, [cache, reasoning])).toEqual({ value: '25%', basisLabel: '累计输出', basisTokens: 300 })
})

test('legacy children without a verified denominator never fall back to the session total', () => {
  for (const group of ['input', 'cache', 'output'] as const) {
    const result = usagePercentage(row({ group, child: true, tokens: 40 }), 100, [])
    expect(result).toMatchObject({ value: '—', basisLabel: group === 'output' ? '累计输出' : '累计输入', basisTokens: null })
    expect(result.reason).toContain('缺少')
  }
  expect(usagePercentage(row({ shareOf: null }), 100, [])).toMatchObject({ value: '—', basisTokens: null })
})

test('reported zero denominators remain distinguishable from missing denominators', () => {
  const zero = usagePercentage(row({ tokens: 0, child: true, shareOf: { tokens: 0, label: '累计输入' } }), 200, [])
  const missing = usagePercentage(row({ tokens: 0, child: true, shareOf: null }), 200, [])
  expect(zero).toMatchObject({ value: '—', basisTokens: 0 })
  expect(zero.reason).toContain('为 0')
  expect(missing).toMatchObject({ value: '—', basisTokens: null })
  expect(missing.reason).toContain('缺少')
})

test('invalid counters and amounts above their scope produce an explanation instead of a misleading percentage', () => {
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(usagePercentage(row({ tokens: invalid }), 100, [])).toMatchObject({ value: '—', basisTokens: 100 })
    expect(usagePercentage(row(), invalid, [])).toMatchObject({ value: '—', basisTokens: null })
    expect(usagePercentage(row({ child: true, shareOf: { tokens: invalid, label: '累计输入' } }), 1_000, []))
      .toMatchObject({ value: '—', basisTokens: null })
  }
  const overflow = usagePercentage(row({ tokens: 101, child: true, shareOf: { tokens: 100, label: '累计输入' } }), 1_000, [])
  expect(overflow).toMatchObject({ value: '—', basisTokens: 100 })
  expect(overflow.reason).toContain('超过累计输入')
})

test('unknown usage is not shown as zero percent and marks peer totals as known-only', () => {
  const unknown = row({ label: '子代理用量缺失（1 个）', group: 'output', tokens: 0, unknown: true })
  const input = row({ tokens: 75 })
  expect(usagePercentage(unknown, 100, [input, unknown])).toMatchObject({ value: '未知', basisLabel: '已知总用量', basisTokens: 100 })
  expect(usagePercentage(input, 100, [input, unknown])).toEqual({ value: '75%', basisLabel: '已知总用量', basisTokens: 100 })
})

test('three completed rounds carry full input and output denominators into their breakdowns', () => {
  const usage = sumUsage([
    message('first', { promptTokens: 10_000, completionTokens: 500, totalTokens: 10_500, cacheHitTokens: 6_000, reasoningTokens: 100 }),
    message('second', { promptTokens: 6_000, completionTokens: 300, totalTokens: 6_300, cacheHitTokens: 3_600, reasoningTokens: 60 }),
    message('third', { promptTokens: 5_000, completionTokens: 200, totalTokens: 5_200, cacheHitTokens: 3_000, reasoningTokens: 40 })
  ])
  expect(usage).toMatchObject({ total: 22_000, input: 21_000, output: 1_000, rounds: 3 })
  expect(percentage(usage, '累计输入 Prompt')).toEqual({ value: '95.5%', basisLabel: '总用量', basisTokens: 22_000 })
  expect(percentage(usage, '输出 Completion')).toEqual({ value: '4.5%', basisLabel: '总用量', basisTokens: 22_000 })
  expect(detail(usage, '缓存命中')).toMatchObject({ tokens: 12_600, shareOf: { tokens: 21_000, label: '累计输入' } })
  expect(percentage(usage, '缓存命中')).toEqual({ value: '60%', basisLabel: '累计输入', basisTokens: 21_000 })
  expect(percentage(usage, '其中推理')).toEqual({ value: '20%', basisLabel: '累计输出', basisTokens: 1_000 })
})

test('cache overflow is capped per invocation without borrowing another invocation input allowance', () => {
  const usage = sumUsage([
    message('overflow', { promptTokens: 300, completionTokens: 20, cacheHitTokens: 500 }),
    message('normal', { promptTokens: 50, completionTokens: 30, cacheHitTokens: 10 })
  ])
  expect(usage).toMatchObject({ total: 400, input: 350, output: 50 })
  expect(detail(usage, '缓存命中').tokens).toBe(310)
  expect(percentage(usage, '缓存命中')).toEqual({ value: '88.6%', basisLabel: '累计输入', basisTokens: 350 })
  expect(detail(usage, '缓存命中').title).toContain('按各次输入上限展示')
})

test('one missing input counter disables input shares while complete output keeps its own denominator', () => {
  const usage = sumUsage([
    message('complete', { promptTokens: 100, completionTokens: 20, cacheHitTokens: 60, systemPromptTokens: 10, reasoningTokens: 10 }),
    message('missing-input', { totalTokens: 200, completionTokens: 30, cacheHitTokens: 40, systemPromptTokens: 20, reasoningTokens: 15 })
  ])
  expect(usage.total).toBe(320)
  for (const label of ['缓存命中', '系统提示词']) {
    expect(detail(usage, label).shareOf).toBeNull()
    expect(percentage(usage, label)).toMatchObject({ value: '—', basisLabel: '累计输入', basisTokens: null })
  }
  expect(detail(usage, '缓存命中').tokens).toBe(100)
  expect(percentage(usage, '其中推理')).toEqual({ value: '50%', basisLabel: '累计输出', basisTokens: 50 })
})

test('one missing output counter disables reasoning share without invalidating complete input', () => {
  const usage = sumUsage([
    message('complete', { promptTokens: 100, completionTokens: 20, cacheHitTokens: 60, reasoningTokens: 10 }),
    message('missing-output', { totalTokens: 200, promptTokens: 100, cacheHitTokens: 40, reasoningTokens: 15 })
  ])
  expect(percentage(usage, '缓存命中')).toEqual({ value: '50%', basisLabel: '累计输入', basisTokens: 200 })
  expect(detail(usage, '其中推理').shareOf).toBeNull()
  expect(percentage(usage, '其中推理')).toMatchObject({ value: '—', basisLabel: '累计输出', basisTokens: null })
})

test('negative counters in a contributing invocation cannot become valid through cumulative cancellation', () => {
  const usage = sumUsage([
    message('complete', { promptTokens: 100, completionTokens: 50, cacheHitTokens: 60, reasoningTokens: 10 }),
    message('invalid', { promptTokens: -10, completionTokens: -5, totalTokens: 20 })
  ])
  expect(usage).toMatchObject({ input: 90, output: 45, total: 170 })
  for (const label of ['缓存命中', '其中推理']) {
    expect(detail(usage, label).shareOf).toBeNull()
    expect(percentage(usage, label).value).toBe('—')
  }
})

test('known subagent lower bounds contribute to the total while missing usage stays explicit', () => {
  const usage = sumUsage([message('parent', { promptTokens: 800, completionTokens: 200, cacheHitTokens: 400 }, [
    child('known-child', { inputTokens: 400, outputTokens: 100 }),
    child('incomplete-child', { totalTokens: 250, unknown: true })
  ])])
  expect(usage).toMatchObject({ total: 1_750, parentTotal: 1_000, subagentTotal: 750, unknownSubagents: 1 })
  expect(percentage(usage, '累计输入 Prompt')).toEqual({ value: '45.7%', basisLabel: '已知总用量', basisTokens: 1_750 })
  expect(percentage(usage, '子代理（已知用量）')).toEqual({ value: '42.9%', basisLabel: '已知总用量', basisTokens: 1_750 })
  expect(percentage(usage, '子代理用量缺失（1 个）')).toMatchObject({ value: '未知', basisLabel: '已知总用量' })
  expect(percentage(usage, '缓存命中')).toEqual({ value: '50%', basisLabel: '累计输入', basisTokens: 800 })
})

test('authoritative totals can supply shares before history is loaded, but observed gaps remain unverified', () => {
  const authoritative = { promptTokens: 21_000, completionTokens: 1_000, totalTokens: 22_000, cacheHitTokens: 12_600 }
  const unloaded = sessionUsageTotal([], createSessionUsageAnchor([], authoritative))
  expect(percentage(unloaded, '缓存命中')).toEqual({ value: '60%', basisLabel: '累计输入', basisTokens: 21_000 })

  const incomplete = [message('old-call', { totalTokens: 200, completionTokens: 20, cacheHitTokens: 60 })]
  const anchor = createSessionUsageAnchor(incomplete, authoritative)
  const anchored = sessionUsageTotal(incomplete, anchor)
  expect(anchored.total).toBe(22_000)
  expect(percentage(anchored, '缓存命中')).toMatchObject({ value: '—', basisTokens: null })
  // A later complete visible window must not erase the anchor's observed gap.
  const later = sessionUsageTotal([message('new-call', { promptTokens: 100, completionTokens: 20, cacheHitTokens: 60 })], anchor)
  expect(later.total).toBe(22_000)
  expect(percentage(later, '缓存命中')).toMatchObject({ value: '—', basisTokens: null })
})
