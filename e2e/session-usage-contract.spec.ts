/** Session authority survives compaction while later live billing adds only its observed delta. No Electron. */
import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRun, SubagentUsage } from '../src/shared/subagent'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { createSessionUsageAnchor, sessionUsageTotal } from '../src/renderer/src/contrib/chat/session-usage'
import { sumUsage } from '../src/renderer/src/contrib/chat/usage'

function message(id: string, usage?: Record<string, number>, children: SubagentRun[] = []): ChatMessage {
  return {
    id, role: 'assistant', content: id, thinking: '', items: [], status: 'done', createdAt: 1,
    usage, tools: children.map((run, index) => ({ id: id + '-child-' + index, name: 'subagent', args: '',
      result: '', state: 'done', subagent: run }))
  }
}

function user(id: string): ChatMessage {
  return { ...message(id), role: 'user' }
}

function child(runId: string, usage: SubagentUsage, patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    schemaVersion: 1, runId, tenantId: 'tenant', rootSessionId: 'session', parentSessionId: 'session',
    parentConversationId: 'turn', parentMessageId: 'assistant', parentToolCallId: runId + '-tool',
    childSessionId: 'child-' + runId, task: 'review', description: 'review', modelId: 'model',
    status: 'running', lastSeq: 1, createdAt: 1, updatedAt: 2, usage, toolCalls: [], ...patch
  }
}

test('old engines without session authority retain the existing parent and deduplicated child totals', () => {
  const run = child('known', { totalTokens: 40 })
  const messages = [user('request'), message('first', { promptTokens: 10, completionTokens: 2 }, [run]),
    message('second', { promptTokens: 20, completionTokens: 3 }, [run])]
  expect(createSessionUsageAnchor(messages)).toBeNull()
  expect(sessionUsageTotal(messages)).toEqual({ ...sumUsage(messages), rounds: 1 })
  expect(sessionUsageTotal(messages, null).total).toBe(75)
})

test('a compact snapshot with only a recent tail still displays complete parent and child billing', () => {
  const messages = [message('retained-tail', { promptTokens: 10, completionTokens: 2, totalTokens: 12 })]
  const anchor = createSessionUsageAnchor(messages,
    { promptTokens: 900, completionTokens: 100, totalTokens: 1000, systemPromptTokens: 600, toolResultsTokens: 200 },
    { totalTokens: 500, count: 5, unknown: 2, finishedAt: 250 })
  const total = sessionUsageTotal(messages, anchor)
  expect(total).toMatchObject({ total: 1500, parentTotal: 1000, subagentTotal: 500,
    unknownSubagents: 2, input: 900, output: 100, endedAt: 250 })
  expect(total.summary).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: '系统提示词', tokens: 600 }),
    expect.objectContaining({ label: '工具结果', tokens: 200 }),
    expect.objectContaining({ label: '子代理（已知用量）', tokens: 500 }),
    expect.objectContaining({ label: '子代理用量缺失（2 个）', unknown: true })
  ]))
})

test('repeated cumulative live frames replace their previous amount instead of recharging the anchor', () => {
  const initial = message('active-turn', { promptTokens: 10, completionTokens: 2, totalTokens: 12 })
  const anchor = createSessionUsageAnchor([initial], { promptTokens: 900, completionTokens: 100, totalTokens: 1000 })
  const payload = { usage: { promptTokens: 15, completionTokens: 3, totalTokens: 18,
    currentPromptTokens: 7, contextWindow: 100_000, modelId: 'model-A' } }
  const live = reducePayload(initial, payload)
  expect(sessionUsageTotal([live], anchor)).toMatchObject({ total: 1006, parentTotal: 1006, input: 905, output: 101 })
  const duplicate = reducePayload(live, payload)
  const renamed = reducePayload(duplicate, { usage: { modelId: 'model-B' } })
  expect(sessionUsageTotal([duplicate], anchor)).toEqual(sessionUsageTotal([live], anchor))
  expect(sessionUsageTotal([renamed], anchor)).toEqual(sessionUsageTotal([live], anchor))
})

test('later turns and increased breakdown counters add only usage observed after the snapshot', () => {
  const initial = message('active-turn', { promptTokens: 10, completionTokens: 2, totalTokens: 12,
    systemPromptTokens: 5, toolResultsTokens: 2, reasoningTokens: 1 })
  const anchor = createSessionUsageAnchor([initial], { promptTokens: 900, completionTokens: 100, totalTokens: 1000,
    systemPromptTokens: 600, toolResultsTokens: 200, reasoningTokens: 20 })
  const live = reducePayload(initial, { usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25,
    systemPromptTokens: 8, toolResultsTokens: 4, reasoningTokens: 2 } })
  const newTurn = message('next-turn', { promptTokens: 20, completionTokens: 4, totalTokens: 24 })
  const total = sessionUsageTotal([live, newTurn], anchor)
  expect(total).toMatchObject({ total: 1037, input: 930, output: 107 })
  expect(total.summary).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: '系统提示词', tokens: 603 }),
    expect.objectContaining({ label: '工具结果', tokens: 202 }),
    expect.objectContaining({ label: '其中推理', tokens: 21 })
  ]))
})

test('reanchoring expanded archive pages changes the visible transcript without adding the same calls again', () => {
  const authority = { promptTokens: 900, completionTokens: 100, totalTokens: 1000 }
  const tail = [message('tail', { promptTokens: 90, completionTokens: 10, totalTokens: 100 })]
  expect(sessionUsageTotal(tail, createSessionUsageAnchor(tail, authority)).total).toBe(1000)
  const partialArchive = [message('older-page', { promptTokens: 450, completionTokens: 50, totalTokens: 500 }), ...tail]
  expect(sessionUsageTotal(partialArchive, createSessionUsageAnchor(partialArchive, authority)).total).toBe(1000)
  const completeArchive = [message('oldest-page', { promptTokens: 360, completionTokens: 40, totalTokens: 400 }), ...partialArchive]
  expect(sumUsage(completeArchive).total).toBe(1000)
  expect(sessionUsageTotal(completeArchive, createSessionUsageAnchor(completeArchive, authority)).total).toBe(1000)
})

test('a fresh lower authority after server-side deletion can decrease parent and child totals', () => {
  const before = [message('retained', { totalTokens: 100 }, [child('visible-child', { totalTokens: 40 })])]
  const beforeAnchor = createSessionUsageAnchor(before, { totalTokens: 1000 }, { totalTokens: 500, count: 5, unknown: 2 })
  expect(sessionUsageTotal(before, beforeAnchor).total).toBe(1500)
  const after = [message('surviving', { totalTokens: 50 })]
  const afterAnchor = createSessionUsageAnchor(after, { totalTokens: 500 }, { totalTokens: 100, count: 1, unknown: 0 })
  expect(sessionUsageTotal(after, afterAnchor)).toMatchObject({ total: 600, parentTotal: 500, subagentTotal: 100, unknownSubagents: 0 })
  const cleared = createSessionUsageAnchor([], { totalTokens: 0 }, { totalTokens: 0, count: 0, unknown: 0 })
  expect(sessionUsageTotal([], cleared)).toMatchObject({ total: 0, parentTotal: 0, subagentTotal: 0 })
})

test('unknown children retain observed lower bounds and become known without losing hidden child billing', () => {
  const lowerBound = child('visible', { totalTokens: 40, unknown: true })
  const initial = [message('parent', { totalTokens: 12 }, [lowerBound])]
  const anchor = createSessionUsageAnchor(initial, { totalTokens: 1000 }, { totalTokens: 100, count: 2, unknown: 2 })
  const growing = [message('parent', { totalTokens: 12 }, [child('visible', { totalTokens: 70, unknown: true }, { lastSeq: 2 })])]
  expect(sessionUsageTotal(growing, anchor)).toMatchObject({ total: 1130, subagentTotal: 130, unknownSubagents: 2 })
  const known = child('visible', { totalTokens: 80, unknown: false }, { lastSeq: 3, finishedAt: 300, status: 'succeeded' })
  const resolved = [message('parent', { totalTokens: 12 }, [known])]
  expect(sessionUsageTotal(resolved, anchor)).toMatchObject({ total: 1140, subagentTotal: 140, unknownSubagents: 1, endedAt: 300 })
  const additional = child('new', { totalTokens: 20, unknown: true })
  const later = [message('parent', { totalTokens: 12 }, [known, additional]),
    message('replayed-older-run', undefined, [child('visible', { totalTokens: 5, unknown: true })])]
  const total = sessionUsageTotal(later, anchor)
  expect(total).toMatchObject({ total: 1160, subagentTotal: 160, unknownSubagents: 2 })
  expect(total.summary).toContainEqual({ label: '子代理用量缺失（2 个）', group: 'output', tokens: 0, unknown: true })
})

test('a new child with entirely unknown usage increments the unknown count without inventing additional spend', () => {
  const initial = [message('parent', { totalTokens: 12 })]
  const anchor = createSessionUsageAnchor(initial, { totalTokens: 1000 }, { totalTokens: 100, count: 2, unknown: 1 })
  const later = [message('parent', { totalTokens: 12 }, [child('no-usage', { unknown: true })])]
  expect(sessionUsageTotal(later, anchor)).toMatchObject({ total: 1100, subagentTotal: 100, unknownSubagents: 2 })
})

test('parent-only and child-only authority preserve the unprovided side through normal visible accounting', () => {
  const messages = [message('parent', { promptTokens: 10, completionTokens: 2 }, [child('child', { totalTokens: 40 })])]
  expect(sessionUsageTotal(messages, createSessionUsageAnchor(messages, { totalTokens: 1000 })))
    .toMatchObject({ total: 1040, parentTotal: 1000, subagentTotal: 40 })
  expect(sessionUsageTotal(messages, createSessionUsageAnchor(messages, undefined, { totalTokens: 500, count: 5, unknown: 2 })))
    .toMatchObject({ total: 512, parentTotal: 12, subagentTotal: 500, unknownSubagents: 2 })
})

test('missing totalTokens uses per-message and authoritative input plus output without summing context occupancy', () => {
  const initial = [message('parent', { promptTokens: 10, completionTokens: 2, currentPromptTokens: 99_000, contextWindow: 100_000 })]
  const anchor = createSessionUsageAnchor(initial, { promptTokens: 100, completionTokens: 50 })
  expect(sessionUsageTotal(initial, anchor)).toMatchObject({ total: 150, input: 100, output: 50 })
  const later = [message('parent', { promptTokens: 15, completionTokens: 3, currentPromptTokens: 10_000, contextWindow: 100_000 })]
  expect(sessionUsageTotal(later, anchor)).toMatchObject({ total: 156, input: 105, output: 51 })
  expect(createSessionUsageAnchor(initial, { currentPromptTokens: 99_000, contextWindow: 100_000 })).toBeNull()
})

test('the anchor copies snapshot authority and billing so later input object mutation cannot move its baseline', () => {
  const parent = { totalTokens: 1000 }
  const children = { totalTokens: 100, count: 2, unknown: 1 }
  const usage = { totalTokens: 12 }
  const initial = [message('parent', usage)]
  const anchor = createSessionUsageAnchor(initial, parent, children)
  parent.totalTokens = 0
  children.totalTokens = 0
  children.unknown = 0
  usage.totalTokens = 20
  expect(sessionUsageTotal(initial, anchor)).toMatchObject({ total: 1108, parentTotal: 1008, subagentTotal: 100, unknownSubagents: 1 })
})

test('source or session changes use a fresh hook-owned anchor and cannot retain the previous authority', () => {
  const sameVisibleIds = [message('same-assistant-id', { totalTokens: 12 })]
  const sourceA = createSessionUsageAnchor(sameVisibleIds, { totalTokens: 1000 }, { totalTokens: 500, count: 5, unknown: 2 })
  const sourceB = createSessionUsageAnchor(sameVisibleIds, { totalTokens: 20 }, { totalTokens: 3, count: 1, unknown: 0 })
  expect(sessionUsageTotal(sameVisibleIds, sourceA).total).toBe(1500)
  expect(sessionUsageTotal(sameVisibleIds, sourceB).total).toBe(23)
  expect(sessionUsageTotal(sameVisibleIds, createSessionUsageAnchor(sameVisibleIds))).toEqual({ ...sumUsage(sameVisibleIds), rounds: 0 })
})

test('active child stores ahead of the paired watermark retain growth and unknown resolution, including a newly observed run', () => {
  const atCursor = child('active', { totalTokens: 40, unknown: true }, { lastSeq: 1 })
  const hidden = child('archived', { totalTokens: 60 }, { lastSeq: 2 })
  const latest = child('active', { totalTokens: 80, unknown: false }, { lastSeq: 3 })
  const newRun = child('new', { totalTokens: 20, unknown: true }, { lastSeq: 1 })
  const storeMessages = [user('current-request'), message('parent', { totalTokens: 12 }, [latest, newRun])]
  const anchor = createSessionUsageAnchor(storeMessages, { totalTokens: 1000 },
    { totalTokens: 100, count: 2, unknown: 1 }, [atCursor, hidden])
  expect(sessionUsageTotal(storeMessages, anchor)).toMatchObject({ total: 1160, parentTotal: 1000,
    subagentTotal: 160, unknownSubagents: 1, rounds: 1 })
  const replayed = [...storeMessages, message('duplicate-old-run', undefined, [atCursor])]
  expect(sessionUsageTotal(replayed, anchor)).toEqual(sessionUsageTotal(storeMessages, anchor))
})

test('historical authority already includes its latest run so raw older archive data cannot charge that growth twice', () => {
  const staleHistory = child('historical', { totalTokens: 40, unknown: true }, { lastSeq: 1 })
  const authorityRun = child('historical', { totalTokens: 80, unknown: false }, { lastSeq: 3 })
  const hidden = child('hidden', { totalTokens: 60 }, { lastSeq: 2 })
  const raw = [message('parent', { totalTokens: 12 }, [staleHistory])]
  const anchor = createSessionUsageAnchor(raw, { totalTokens: 1000 },
    { totalTokens: 140, count: 2, unknown: 0 }, [authorityRun, hidden, staleHistory])
  expect(sessionUsageTotal(raw, anchor)).toMatchObject({ total: 1140, subagentTotal: 140, unknownSubagents: 0 })
  const overlay = [message('parent', { totalTokens: 12 }, [authorityRun])]
  expect(sessionUsageTotal(overlay, anchor)).toMatchObject({ total: 1140, subagentTotal: 140, unknownSubagents: 0 })
  const grew = [message('parent', { totalTokens: 12 }, [child('historical', { totalTokens: 90 }, { lastSeq: 4 })])]
  expect(sessionUsageTotal(grew, anchor)).toMatchObject({ total: 1150, subagentTotal: 150, unknownSubagents: 0 })
})

test('an explicitly empty paired run list records children arriving after the zero watermark', () => {
  const messages = [message('parent', { totalTokens: 12 }, [child('after-cursor', { totalTokens: 20, unknown: true })])]
  const anchor = createSessionUsageAnchor(messages, { totalTokens: 1000 },
    { totalTokens: 0, count: 0, unknown: 0 }, [])
  expect(sessionUsageTotal(messages, anchor)).toMatchObject({ total: 1020, subagentTotal: 20, unknownSubagents: 1 })
  expect(sessionUsageTotal(messages, anchor).summary).toContainEqual({ label: '子代理用量缺失（1 个）',
    group: 'output', tokens: 0, unknown: true })
})

test('paired child baselines copy scalar usage and remain stable when the supplied run objects change', () => {
  const supplied = child('copied', { totalTokens: 40, unknown: true })
  const messages = [message('parent', { totalTokens: 12 }, [supplied])]
  const anchor = createSessionUsageAnchor(messages, { totalTokens: 1000 },
    { totalTokens: 40, count: 1, unknown: 1 }, [supplied])
  supplied.usage.totalTokens = 80
  supplied.usage.unknown = false
  supplied.lastSeq = 2
  expect(sessionUsageTotal(messages, anchor)).toMatchObject({ total: 1080, subagentTotal: 80, unknownSubagents: 0 })
})

test('loaded rounds count user turns rather than assistant segments or restored orphan child parents', () => {
  const messages = [message('restored-child-parent'), user('first-request'), message('first-segment', { totalTokens: 10 }),
    message('second-segment', { totalTokens: 20 }), user('second-request'), message('second-answer', { totalTokens: 30 })]
  expect(sumUsage(messages).rounds).toBe(3)
  expect(sessionUsageTotal(messages)).toMatchObject({ total: 60, rounds: 2 })
  const authority = { totalTokens: 1000 }
  expect(sessionUsageTotal(messages, createSessionUsageAnchor(messages, authority))).toMatchObject({ total: 1000, rounds: 2 })
  const expanded = [user('older-request'), message('older-answer', { totalTokens: 100 }), ...messages]
  expect(sessionUsageTotal(expanded, createSessionUsageAnchor(expanded, authority))).toMatchObject({ total: 1000, rounds: 3 })
  expect(sessionUsageTotal([]).rounds).toBe(0)
})
