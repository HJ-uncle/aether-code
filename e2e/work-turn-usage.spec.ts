/** Work turn summaries preserve billed child deduplication and historical
 * model/timing provenance, independent of Electron or the current composer. */
import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRun } from '../src/shared/subagent'
import { summarizeTurnUsage } from '../src/renderer/src/contrib/chat/turn-usage'

const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'assistant', content: id, thinking: '', tools: [], items: [], status: 'done', createdAt: 1000, ...patch
})

test('Work turn totals count repeated child receipts once and show the actual response model', () => {
  const child: SubagentRun = {
    schemaVersion: 1, runId: 'child', tenantId: 'tenant', rootSessionId: 'root', parentSessionId: 'root',
    parentConversationId: 'turn', parentMessageId: 'answer', parentToolCallId: 'tool', childSessionId: 'child-session',
    task: 'review', description: 'review', modelId: 'child-model', status: 'succeeded', lastSeq: 2,
    createdAt: 1000, updatedAt: 4000, finishedAt: 4000, usage: { totalTokens: 50 }, toolCalls: []
  }
  const tools: ChatMessage['tools'] = [{ id: 'tool', name: 'subagent', args: '', result: '', state: 'done', subagent: child }]
  const total = summarizeTurnUsage([
    message('ask', { role: 'user', createdAt: 500 }),
    message('first', { usage: { promptTokens: 80, completionTokens: 20 }, startedAt: 1000, endedAt: 2000, modelId: 'model-a', tools }),
    message('last', { usage: { totalTokens: 30 }, startedAt: 2000, endedAt: 3000, modelId: 'model-b', tools })
  ])
  expect(total).toMatchObject({ tokens: 180, askedAt: 500, startedAt: 1000, endedAt: 4000, model: 'model-b', streaming: false })
  expect(total?.summary.filter(row => row.label === '子代理（已知用量）')).toEqual([
    expect.objectContaining({ tokens: 50 })
  ])
})

test('missing billing is not presented as zero and a lone archived timestamp does not invent elapsed time', () => {
  expect(summarizeTurnUsage([message('no-usage')])).toBeNull()
  const total = summarizeTurnUsage([message('archived', { usage: { totalTokens: 12 } })])
  expect(total).toMatchObject({ tokens: 12, askedAt: 1000, streaming: false })
  expect(total?.model).toBeUndefined()
  expect(total?.startedAt).toBeUndefined()
  expect(total?.endedAt).toBeUndefined()
})

test('waiting turns keep their known billing and live elapsed clock', () => {
  const total = summarizeTurnUsage([message('waiting', { status: 'waiting', usage: { totalTokens: 12 } })])
  expect(total).toMatchObject({ tokens: 12, startedAt: 1000, streaming: true })
  expect(total?.endedAt).toBeUndefined()
})
