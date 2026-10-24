/** An exact sealed publication prefix and a later durable outcome are separate
 * authorities. Covers all terminal outcomes without inventing missing text. */
import { expect, test } from '@playwright/test'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { snapshotRecoveryOutcome } from '../src/renderer/src/core/engine/chat-recovery-loop'
import { snapshotRecoveryNotice, streamRecoveryNoticeText } from '../src/renderer/src/core/engine/stream-recovery-notice'
import type { RootRun } from '../src/shared/root-run'

function snapshot(status: RootRun['status']): ChatRecoverySnapshot {
  const published: RootRun = { schemaVersion: 1, runId: 'sealed-root', turnId: 'sealed-turn', sessionId: 'sealed-session',
    userMessageId: 'sealed-user', assistantMessageId: 'sealed-assistant', seq: 1, version: 2,
    status: 'running', modelId: 'fixture', pending: [], workspacePaths: [], createdAt: 1, updatedAt: 2 }
  return { schemaVersion: 1, source: 'live', sessionId: published.sessionId, eventId: 'sealed-stream:7', finished: true,
    publicationRecovery: { reason: 'oversized_frame', lastConfirmedEventId: 'sealed-stream:7' },
    run: published, runs: [published], executionRun: { ...published, status, version: 3, updatedAt: 3 },
    history: [{ id: published.assistantMessageId, role: 'assistant', content: 'DURABLE_TEXT_OUTSIDE_PUBLISHED_PREFIX', conversationId: published.turnId }],
    projection: [{ run: published }, { content: 'CONFIRMED_PREFIX' }], todos: [], changes: [] }
}

for (const [status, messageStatus] of [['succeeded', 'done'], ['failed', 'error'], ['cancelled', 'aborted'], ['interrupted', 'interrupted']] as const) {
  test(`sealed observation recovers ${status}, preserves exact text and reports incomplete transcript`, () => {
    const state = snapshot(status), restored = restoreChatSnapshot(state)
    expect(snapshotRecoveryOutcome(state)).toBe('idle')
    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0]).toMatchObject({ status: messageStatus, content: 'CONFIRMED_PREFIX' })
    expect(JSON.stringify(restored)).not.toContain('DURABLE_TEXT_OUTSIDE_PUBLISHED_PREFIX')
    expect(streamRecoveryNoticeText(snapshotRecoveryNotice(state, null), { phase: 'idle', failures: 0 }))
      .toContain('任务已结束，但本轮实时记录不完整')
  })
}

test('closed observation cannot claim that a still-running durable task finished or fully recovered', () => {
  const state = snapshot('running')
  expect(snapshotRecoveryOutcome(state)).toBe('retry')
  expect(restoreChatSnapshot(state).messages[0].status).toBe('streaming')
  const notice = snapshotRecoveryNotice(state, null)
  expect(streamRecoveryNoticeText(notice, { phase: 'retrying', failures: 8 })).toContain('任务仍在执行')
  expect(streamRecoveryNoticeText(notice, { phase: 'blocked', failures: 8 })).toContain('检查连接或登录状态')
})
