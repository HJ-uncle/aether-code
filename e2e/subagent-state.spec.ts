/** Pure regression tests: live/replay ownership, honest outcomes, late events and child usage accounting. */
import { expect, test } from '@playwright/test'
import type { SubagentRun } from '../src/shared/subagent'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import {
  applyToolResult,
  finishTool,
  replayMessages
} from '../src/renderer/src/core/engine/chat-history'
import {
  attachSubagentRuns,
  exportSubagentDetails,
  isSubagentActive,
  mergeSubagentRun,
  normalizeSubagentEvent,
  normalizeSubagentRun,
  toolResultState,
  toolStatusLabel
} from '../src/renderer/src/core/engine/subagent-state'
import { groupIntoTurns, sumUsage } from '../src/renderer/src/contrib/chat/usage'

function run(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    tenantId: 'default',
    rootSessionId: 'parent-session',
    parentSessionId: 'parent-session',
    parentConversationId: 'turn-1',
    parentMessageId: 'assistant-1',
    parentToolCallId: 'dispatch-1',
    childSessionId: 'child-1',
    task: 'Read project information',
    description: '调研项目',
    modelId: 'fake-model',
    status: 'running',
    createdAt: 1000,
    updatedAt: 1100,
    startedAt: 1000,
    lastSeq: 1,
    usage: {},
    toolCalls: [],
    ...patch
  }
}

function tool(patch: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'dispatch-1',
    name: 'subagent',
    args: '{"task":"调研"}',
    result: '',
    state: 'running',
    ...patch
  }
}

function message(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '父代理的回答',
    thinking: '',
    tools: [tool()],
    items: [{ kind: 'tool', id: 'dispatch-1' }],
    status: 'done',
    createdAt: 1000,
    conversationId: 'turn-1',
    ...patch
  }
}

test('subagent 协议拒绝错版、损坏身份和 seq 不一致的事件', () => {
  const snapshot = run()
  expect(normalizeSubagentRun({ ...snapshot, schemaVersion: 2 })).toBeUndefined()
  expect(normalizeSubagentRun({ ...snapshot, parentToolCallId: '' })).toBeUndefined()
  expect(
    normalizeSubagentEvent({ schemaVersion: 1, kind: 'started', runId: 'other', seq: 1, snapshot })
  ).toBeUndefined()
  expect(
    normalizeSubagentEvent({
      schemaVersion: 1,
      kind: 'started',
      runId: snapshot.runId,
      seq: 2,
      snapshot
    })
  ).toBeUndefined()
  expect(
    normalizeSubagentEvent({
      schemaVersion: 1,
      kind: 'started',
      runId: snapshot.runId,
      seq: 1,
      snapshot
    })?.snapshot.runId
  ).toBe('run-1')
})

test('首次 LLM 400 零工具失败在 live、replay 和导出里有相同原因', () => {
  const failed = run({
    status: 'failed',
    lastSeq: 2,
    finishedAt: 1300,
    error: { code: 'LLM_HTTP_400', message: '400 Request body format invalid', retryable: false }
  })
  const live = attachSubagentRuns([message()], [failed])
  const history = replayMessages([
    {
      id: 'assistant-1',
      role: 'assistant',
      toolCall: { id: 'dispatch-1', name: 'subagent', args: { task: '调研' } }
    },
    {
      role: 'tool',
      toolCallId: 'dispatch-1',
      content: '',
      metadata: { success: false, subagent: failed }
    }
  ])
  for (const item of [live[0].tools[0], history[0].tools[0]]) {
    expect(item.state).toBe('error')
    expect(item.subagent?.toolCalls).toEqual([])
    expect(toolStatusLabel(item)).toBe('失败')
    expect(exportSubagentDetails(item)).toContain('失败原因：400 Request body format invalid')
    expect(exportSubagentDetails(item)).not.toContain('（成功）')
  }
})

test('历史无结构化证据的子任务保持 unknown，普通旧工具兼容成功', () => {
  const replayed = replayMessages([
    { role: 'assistant', toolCall: { id: 'child', name: 'subagent' } },
    { role: 'tool', toolCallId: 'child', content: '✅ 执行完成，但旧文本中也可能带错误' },
    { role: 'assistant', toolCall: { id: 'read', name: 'read_file' } },
    { role: 'tool', toolCallId: 'read', content: 'file contents' }
  ])
  expect(replayed[0].tools.map((item) => item.state)).toEqual(['unknown', 'done'])
  expect(toolStatusLabel(replayed[0].tools[0])).toBe('状态未知')
})

test('实时和历史的一般工具显式失败不再被 end 染成成功', () => {
  expect(
    finishTool(tool({ name: 'read_file' }), { success: false, error: 'Permission denied' }).state
  ).toBe('error')
  expect(
    toolResultState({ metadata: { success: false, error: { message: 'No access' } } }, 'read_file')
  ).toBe('error')
  const replayed = replayMessages([
    { role: 'assistant', toolCall: { id: 'read', name: 'read_file' } },
    {
      role: 'tool',
      toolCallId: 'read',
      content: '',
      metadata: { success: false, error: 'Permission denied' }
    }
  ])
  expect(replayed[0].tools[0]).toMatchObject({ state: 'error', error: 'Permission denied' })
})

test('重复和旧 seq 不覆盖终态，较新进度只补齐统计和输出', () => {
  const ended = run({
    status: 'cancelled',
    lastSeq: 8,
    finishedAt: 2000,
    externalEffectStatus: 'unknown',
    usage: { totalTokens: 120 },
    toolCalls: [
      { id: 'read', name: 'read_file', args: {}, status: 'succeeded', output: 'persisted output' }
    ]
  })
  expect(mergeSubagentRun(ended, run({ lastSeq: 7 }))).toBe(ended)
  expect(mergeSubagentRun(ended, run({ lastSeq: 8 }))).toBe(ended)
  const next = mergeSubagentRun(
    ended,
    run({
      lastSeq: 9,
      usage: { totalTokens: 150 },
      toolCalls: [{ id: 'read', name: 'read_file', args: {}, status: 'running' }]
    })
  )
  expect(next.status).toBe('cancelled')
  expect(next.finishedAt).toBe(2000)
  expect(next.externalEffectStatus).toBe('unknown')
  expect(next.usage.totalTokens).toBe(150)
  expect(next.toolCalls[0]).toMatchObject({ status: 'succeeded', output: 'persisted output' })
})

test('取消后的外部结果未知保留于协议与导出，不能表示已经回滚', () => {
  const cancelled = run({ status: 'cancelled', externalEffectStatus: 'unknown' })
  const normalized = normalizeSubagentRun(cancelled)
  expect(normalized?.externalEffectStatus).toBe('unknown')
  expect(exportSubagentDetails(tool({ subagent: normalized }))).toContain(
    '已停止本地执行；外部操作结果可能未知'
  )
})

test('取消中任务不能被 running 复活，失败与兄弟运行状态独立', () => {
  const cancelling = run({ status: 'cancelling', lastSeq: 3 })
  expect(mergeSubagentRun(cancelling, run({ lastSeq: 4 })).status).toBe('cancelling')
  const sibling = run({ runId: 'run-2', parentToolCallId: 'dispatch-2', childSessionId: 'child-2' })
  const messages = attachSubagentRuns(
    [message({ tools: [tool(), tool({ id: 'dispatch-2' })] })],
    [cancelling, sibling]
  )
  const updated = attachSubagentRuns(messages, [run({ status: 'cancelled', lastSeq: 4 })])
  expect(updated[0].tools[0].state).toBe('cancelled')
  expect(updated[0].tools[1].subagent?.status).toBe('running')
  expect(isSubagentActive(updated[0].tools[1].subagent!.status)).toBe(true)
})

test('不同 run 或被改写归属的 snapshot 不能覆盖已有任务', () => {
  const previous = run()
  expect(mergeSubagentRun(previous, run({ runId: 'another-run', lastSeq: 2 }))).toBe(previous)
  expect(mergeSubagentRun(previous, run({ parentSessionId: 'another-session', lastSeq: 2 }))).toBe(
    previous
  )
  expect(mergeSubagentRun(previous, run({ parentToolCallId: 'another-tool', lastSeq: 2 }))).toBe(
    previous
  )
})

test('父回合结束且新轮已开始，迟到任务事件仍归原工具且不新建气泡', () => {
  const old = message()
  const fresh = message({
    id: 'assistant-2',
    conversationId: 'turn-2',
    status: 'streaming',
    tools: [],
    items: [],
    createdAt: 3000
  })
  const result = attachSubagentRuns(
    [old, fresh],
    [run({ status: 'succeeded', lastSeq: 2, resultSummary: '子代理结果' })]
  )
  expect(result).toHaveLength(2)
  expect(result[0].tools[0].result).toBe('子代理结果')
  expect(result[0].content).toBe('父代理的回答')
  expect(result[1]).toBe(fresh)
  expect(result[1].tools).toEqual([])
})

test('迟到 tool result 按调用 ID 回填旧消息，不依赖最后一个 streaming 消息', () => {
  const old = message({ tools: [tool({ id: 'read-1', name: 'read_file' })] })
  const fresh = message({ id: 'assistant-2', status: 'streaming', tools: [], items: [] })
  const result = applyToolResult([old, fresh], {
    id: 'read-1',
    success: false,
    error: 'Lost file',
    output: 'details'
  })
  expect(result[0].tools[0]).toMatchObject({
    state: 'error',
    error: 'Lost file',
    result: 'details'
  })
  expect(result[1]).toBe(fresh)
})

test('父工具旧 end 帧不能抹掉权威 child failed 状态', () => {
  const failed = run({
    status: 'failed',
    lastSeq: 3,
    error: { code: 'ERR', message: 'LLM failed', retryable: false }
  })
  const result = finishTool(tool({ state: 'error', subagent: failed }), {
    id: 'dispatch-1',
    success: true,
    output: '旧帧'
  })
  expect(result.state).toBe('error')
  expect(result.error).toBe('LLM failed')
  expect(result.subagent).toBe(failed)
})

test('恢复已持久化派发但缺父投影时，使用稳定身份并按轮次顺序放回', () => {
  const firstUser = message({ id: 'user-1', role: 'user', tools: [], items: [], createdAt: 900 })
  const nextUser = message({ id: 'user-2', role: 'user', tools: [], items: [], createdAt: 3000 })
  const restored = attachSubagentRuns([firstUser, nextUser], [run({ status: 'interrupted' })], true)
  expect(restored.map((item) => item.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
  expect(restored[1].tools[0].subagent?.status).toBe('interrupted')
  expect(attachSubagentRuns(restored, [run({ status: 'interrupted' })], true)).toHaveLength(3)
})

test('没有匹配 owner 的实时旧事件不制造新气泡', () => {
  const unrelated = [message({ id: 'other', conversationId: 'other', tools: [], items: [] })]
  expect(attachSubagentRuns(unrelated, [run()])).toBe(unrelated)
})

test('主历史跳过 sidechain 消息，内部工具只存在子 snapshot', () => {
  const snapshot = run({
    status: 'succeeded',
    toolCalls: [
      {
        id: 'read',
        name: 'read_file',
        args: { path: 'README.md' },
        status: 'succeeded',
        output: 'project overview'
      }
    ]
  })
  const rows = replayMessages([
    { role: 'user', content: '调研' },
    { role: 'assistant', toolCall: { id: 'dispatch-1', name: 'subagent' } },
    { role: 'assistant', content: '子代理内部正文', isSidechain: true },
    { role: 'tool', toolCallId: 'dispatch-1', content: '子摘要', metadata: { subagent: snapshot } }
  ])
  expect(rows).toHaveLength(2)
  expect(rows[1].content).toBe('')
  expect(rows[1].tools).toHaveLength(1)
  expect(rows[1].tools[0].subagent?.toolCalls[0].output).toBe('project overview')
  expect(exportSubagentDetails(rows[1].tools[0])).toContain('结果：project overview')
  expect(exportSubagentDetails(rows[1].tools[0])).toContain('读取文件（成功）')
  expect(exportSubagentDetails(rows[1].tools[0])).toContain('README.md')
})

test('父自身与 child 用量分开，重复 snapshot 不双算且未知不是零', () => {
  const known = run({ usage: { totalTokens: 50, inputTokens: 40, outputTokens: 10 }, lastSeq: 2 })
  const unknown = run({ runId: 'unknown', parentToolCallId: 'unknown', usage: { unknown: true } })
  const messages = [
    message({
      usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
      tools: [
        tool({ subagent: known }),
        tool({ id: 'duplicate', subagent: known }),
        tool({ id: 'unknown', subagent: unknown })
      ]
    })
  ]
  const total = sumUsage(messages)
  expect(total).toMatchObject({
    total: 150,
    parentTotal: 100,
    subagentTotal: 50,
    unknownSubagents: 1
  })
  expect(total.summary.find((row) => row.unknown)?.label).toContain('1 个')
  expect(groupIntoTurns(messages)[0].tokens).toBe(150)
})
