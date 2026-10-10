/** Pure compaction transport validation and versioned ownership; no Electron. */
import { expect, test } from '@playwright/test'
import { normalizeRootRunCompaction, type RootRun } from '../src/shared/root-run'
import { normalizeRootRun, mergeRootRun, applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
const root: RootRun = { schemaVersion: 1, runId: 'compact-run', sessionId: 'compact-session', turnId: 'compact-turn', userMessageId: 'user', assistantMessageId: 'assistant', version: 1, seq: 1, status: 'running', modelId: 'db-model', createdAt: 1, updatedAt: 2, pending: [] }

test('压缩状态只接收明确phase和时间，数值与错误按实际值保留', () => {
  for (const raw of [null, [], {}, { phase: 'compacting', startedAt: 1 }, { phase: 'running', startedAt: '1' }, { phase: 'running', startedAt: NaN }, { phase: 'running', startedAt: -1 }]) expect(normalizeRootRunCompaction(raw)).toBeUndefined()
  expect(normalizeRootRunCompaction({ phase: 'running', startedAt: 0, beforeTokens: 0, afterTokens: Infinity, finishedAt: -1, error: 8 })).toEqual({ phase: 'running', startedAt: 0, beforeTokens: 0 })
  expect(normalizeRootRunCompaction({ phase: 'failed', startedAt: 100, finishedAt: 200, beforeTokens: 128000, afterTokens: 0, error: 'provider unavailable' })).toEqual({ phase: 'failed', startedAt: 100, finishedAt: 200, beforeTokens: 128000, afterTokens: 0, error: 'provider unavailable' })
})

test('自动压缩SSE状态按root版本归属，不让旧running覆盖完成', () => {
  const running = normalizeRootRun({ ...root, compaction: { phase: 'running', startedAt: 10, beforeTokens: 24000 } })!
  const finished = normalizeRootRun({ ...root, version: 2, compaction: { phase: 'succeeded', startedAt: 10, finishedAt: 20, beforeTokens: 24000, afterTokens: 8000 } })!
  expect(mergeRootRun(finished, running)).toBe(finished)
  expect(mergeRootRun(running, finished).compaction).toEqual(finished.compaction)
  expect(normalizeRootRun({ ...root, compaction: { phase: 'running', startedAt: 'invalid' } })?.compaction).toBeUndefined()
})

test('只更新所属消息的自动压缩状态，保留已确认输入统计', () => {
  const owned: ChatMessage = { id: 'assistant', role: 'assistant', conversationId: root.turnId, content: 'continue', thinking: '', tools: [], items: [], status: 'streaming', createdAt: 1, usage: { currentPromptTokens: 24000, contextWindow: 100000, promptTokens: 24000, completionTokens: 1, totalTokens: 24001 } }
  const other: ChatMessage = { ...owned, id: 'other', conversationId: 'other-turn' }
  const updated = applyRootRun([other, owned], { ...root, compaction: { phase: 'succeeded', startedAt: 10, finishedAt: 20, beforeTokens: 24000, afterTokens: 8000 } })
  expect(updated[0]).toBe(other); expect(updated[1].run?.compaction?.afterTokens).toBe(8000)
  expect(updated[1].usage).toEqual(owned.usage)
})
