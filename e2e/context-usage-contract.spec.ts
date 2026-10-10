/** Context occupancy is the latest invocation snapshot; cumulative billing, cache split and recovery stay separate. No Electron. */
import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { groupIntoTurns, latestContextUsage, sumUsage } from '../src/renderer/src/contrib/chat/usage'
import { createSessionUsageAnchor, sessionUsageTotal } from '../src/renderer/src/contrib/chat/session-usage'

const modelId = 'actual-context-model'
const window = 100_000
const baseRun: RootRun = {
  schemaVersion: 1, runId: 'context-run', sessionId: 'context-session', turnId: 'context-turn',
  userMessageId: 'context-user', assistantMessageId: 'context-assistant', seq: 1, version: 1,
  status: 'running', modelId: 'requested-model', actualModelId: modelId,
  createdAt: 1, updatedAt: 2, pending: []
}

function assistant(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: baseRun.assistantMessageId, role: 'assistant', content: '', thinking: '', tools: [], items: [],
    status: 'streaming', createdAt: 1, modelId, runId: baseRun.runId, conversationId: baseRun.turnId,
    ...patch
  }
}

function historyRow(id: string, usage: Record<string, number>, patch: Partial<EngineHistoryRow> = {}): EngineHistoryRow {
  return {
    id, role: 'assistant', content: id, conversationId: baseRun.turnId, modelId,
    metadata: { runId: baseRun.runId, turnId: baseRun.turnId }, usage, ...patch
  }
}

function snapshot(patch: Partial<ChatRecoverySnapshot> = {}): ChatRecoverySnapshot {
  return {
    schemaVersion: 1, source: 'live', sessionId: baseRun.sessionId, eventId: 'context-stream:10',
    finished: false, run: baseRun, runs: [baseRun], projection: [], history: [], todos: [], changes: [],
    ...patch
  }
}

const invocationUsage = [
  { promptTokens: 12_000, completionTokens: 200, currentPromptTokens: 12_000 },
  { promptTokens: 22_000, completionTokens: 200, currentPromptTokens: 22_000 },
  { promptTokens: 10_000, completionTokens: 200, currentPromptTokens: 10_000 }
]

test('live occupancy falls from 12K to 22K to 10K while cumulative billing keeps growing', () => {
  let message = assistant()
  let input = 0
  let output = 0
  const observed: number[] = []
  const billed: number[] = []
  for (const usage of invocationUsage) {
    input += usage.promptTokens
    output += usage.completionTokens
    const frame = { usage: { modelId, currentPromptTokens: usage.currentPromptTokens, contextWindow: window,
      promptTokens: input, completionTokens: output, totalTokens: input + output } }
    message = reducePayload(message, frame)
    observed.push(latestContextUsage([message])!.used)
    billed.push(sumUsage([message]).total)
    // Repeated cumulative frames are replacements, not additional physical calls.
    message = reducePayload(message, frame)
    expect(sumUsage([message]).total).toBe(input + output)
  }
  expect(observed).toEqual([12_000, 22_000, 10_000])
  expect(billed).toEqual([12_200, 34_400, 44_600])
  expect(latestContextUsage([message])).toEqual({ used: 10_000, contextWindow: window, modelId })
})

test('history merges per-invocation charges and retains the final smaller occupancy', () => {
  const messages = replayMessages(invocationUsage.map((usage, index) => historyRow('iteration-' + index,
    { ...usage, contextWindow: window, totalTokens: usage.promptTokens + usage.completionTokens })))
  expect(messages).toHaveLength(1)
  expect(messages[0].usage).toMatchObject({ promptTokens: 44_000, completionTokens: 600, totalTokens: 44_600 })
  expect(latestContextUsage(messages)).toEqual({ used: 10_000, contextWindow: window, modelId })
  expect(sumUsage(messages).total).toBe(44_600)
})

test('an explicit context snapshot wins over a different persisted prompt charge', () => {
  const rows = [
    historyRow('earlier', { promptTokens: 12_000, currentPromptTokens: 12_000, contextWindow: window }),
    historyRow('latest', { promptTokens: 2_500, currentPromptTokens: 10_000, contextWindow: window })
  ]
  const messages = replayMessages(rows)
  expect(messages[0].usage).toMatchObject({ promptTokens: 14_500, currentPromptTokens: 10_000 })
  expect(latestContextUsage(messages)).toEqual({ used: 10_000, contextWindow: window, modelId })
})

test('explicit zero occupancy survives live updates and never falls back to billing totals', () => {
  const previous = assistant({ usage: { promptTokens: 34_000, currentPromptTokens: 22_000, contextWindow: window } })
  const message = reducePayload(previous, { usage: { promptTokens: 44_000, currentPromptTokens: 0, contextWindow: window } })
  expect(latestContextUsage([message])).toEqual({ used: 0, contextWindow: window, modelId })
  expect(sumUsage([message]).input).toBe(44_000)
})

test('explicit zero in the latest history row is authoritative over its positive prompt charge', () => {
  const messages = replayMessages([
    historyRow('earlier', { promptTokens: 12_000, currentPromptTokens: 12_000, contextWindow: window }),
    historyRow('latest', { promptTokens: 2_500, currentPromptTokens: 0, contextWindow: window })
  ])
  expect(messages[0].usage).toMatchObject({ promptTokens: 14_500, currentPromptTokens: 0 })
  expect(latestContextUsage(messages)).toEqual({ used: 0, contextWindow: window, modelId })
})

test('legacy history without currentPromptTokens uses the last invocation input instead of the sum', () => {
  const messages = replayMessages([
    historyRow('legacy-first', { promptTokens: 12_000, completionTokens: 100, contextWindow: window }),
    historyRow('legacy-last', { promptTokens: 10_000, completionTokens: 100, contextWindow: window })
  ])
  expect(latestContextUsage(messages)).toEqual({ used: 10_000, contextWindow: window, modelId })
  expect(sumUsage(messages).input).toBe(22_000)
})

test('legacy standalone usage can fall back to promptTokens, including an observed zero', () => {
  for (const promptTokens of [10_000, 0]) {
    expect(latestContextUsage([assistant({ usage: { promptTokens, contextWindow: window } })]))
      .toEqual({ used: promptTokens, contextWindow: window, modelId })
  }
})

test('turn-scoped cumulative billing without an input snapshot preserves the earlier known context sample', () => {
  const earlier = assistant({ id: 'earlier', modelId: 'earlier-input-model',
    usage: { currentPromptTokens: 12_000, contextWindow: 64_000 } })
  const cumulative = assistant({ id: 'latest', modelId: 'latest-reported-model',
    usage: { usageScope: 'turn', promptTokens: 44_000, completionTokens: 600, totalTokens: 44_600, contextWindow: window } })
  expect(latestContextUsage([earlier, cumulative])).toEqual({ used: 12_000, contextWindow: 64_000, modelId: 'earlier-input-model' })
  expect(sumUsage([cumulative]).total).toBe(44_600)
})

test('turn-scoped billing alone leaves occupancy unknown instead of displaying cumulative spend as input size', () => {
  const cumulative = assistant({ usage: { usageScope: 'turn', promptTokens: 44_000,
    completionTokens: 600, totalTokens: 44_600, contextWindow: window } })
  expect(latestContextUsage([cumulative])).toBeNull()
  const observedZero = assistant({ usage: { usageScope: 'turn', promptTokens: 44_000,
    currentPromptTokens: 0, contextWindow: window } })
  expect(latestContextUsage([observedZero])).toEqual({ used: 0, contextWindow: window, modelId })
})

test('latest context input cannot borrow a window or model from an older message', () => {
  const older = assistant({ id: 'older', modelId: 'older-model', usage: { currentPromptTokens: 12_000, contextWindow: 64_000 } })
  const latest = assistant({ id: 'latest', modelId: 'latest-model', usage: { currentPromptTokens: 10_000, promptTokens: 44_000 } })
  expect(latestContextUsage([older, latest])).toEqual({ used: 10_000, modelId: 'latest-model' })
})

test('a new live input snapshot without a window cannot retain the previous invocation window', () => {
  const previous = assistant({ usage: { currentPromptTokens: 22_000, promptTokens: 34_000, contextWindow: 64_000 } })
  const message = reducePayload(previous, { usage: { modelId: 'new-window-unknown-model',
    currentPromptTokens: 10_000, promptTokens: 44_000 } })
  expect(latestContextUsage([message])).toEqual({ used: 10_000, modelId: 'new-window-unknown-model' })
  expect(sumUsage([message]).input).toBe(44_000)
})

test('a new history input row without a window cannot retain the earlier row window', () => {
  const messages = replayMessages([
    historyRow('earlier', { promptTokens: 22_000, currentPromptTokens: 22_000, contextWindow: 64_000 }),
    historyRow('latest', { promptTokens: 10_000, currentPromptTokens: 10_000 }, { modelId: 'new-window-unknown-model' })
  ])
  expect(latestContextUsage(messages)).toEqual({ used: 10_000, modelId: 'new-window-unknown-model' })
  expect(sumUsage(messages).input).toBe(32_000)
})

test('a legacy live prompt snapshot replaces old explicit occupancy instead of retaining stale input', () => {
  const previous = assistant({ usage: { currentPromptTokens: 22_000, promptTokens: 34_000, contextWindow: 64_000 } })
  const message = reducePayload(previous, { usage: { modelId: 'legacy-model', promptTokens: 10_000 } })
  expect(latestContextUsage([message])).toEqual({ used: 10_000, modelId: 'legacy-model' })
})

test('model-only live usage frames retain observed occupancy and counters without charging them twice', () => {
  const previous = assistant({ usage: { currentPromptTokens: 10_000, promptTokens: 44_000,
    completionTokens: 600, totalTokens: 44_600, contextWindow: window } })
  const message = reducePayload(previous, { usage: { modelId: 'reported-actual-model' } })
  expect(message.modelId).toBe('reported-actual-model')
  expect(latestContextUsage([message])).toEqual({ used: 10_000, contextWindow: window, modelId })
  expect(sumUsage([message]).total).toBe(44_600)
})

test('model-only updates keep an unknown-window input owned by its original model until a real input arrives', () => {
  const previous = assistant({ usage: { currentPromptTokens: 10_000, promptTokens: 44_000 } })
  const reported = reducePayload(previous, { usage: { modelId: 'newly-reported-model' } })
  expect(reported.modelId).toBe('newly-reported-model')
  expect(latestContextUsage([reported])).toEqual({ used: 10_000, modelId })
  const invoked = reducePayload(reported, { usage: { modelId: 'newly-reported-model', currentPromptTokens: 8_000,
    promptTokens: 52_000, contextWindow: 64_000 } })
  expect(latestContextUsage([invoked])).toEqual({ used: 8_000, contextWindow: 64_000, modelId: 'newly-reported-model' })
})

test('an input model stored separately takes precedence over a later reported model', () => {
  const message = assistant({ contextModelId: 'last-input-model', modelId: 'later-reported-model',
    usage: { currentPromptTokens: 10_000, promptTokens: 44_000 } })
  expect(latestContextUsage([message])).toEqual({ used: 10_000, modelId: 'last-input-model' })
})

test('a later model-only history row cannot relabel the preceding input snapshot', () => {
  const messages = replayMessages([
    historyRow('input', { promptTokens: 10_000, currentPromptTokens: 10_000 }),
    historyRow('model-only', {}, { modelId: 'later-reported-model' })
  ])
  expect(messages).toHaveLength(1)
  expect(messages[0].modelId).toBe('later-reported-model')
  expect(latestContextUsage(messages)).toEqual({ used: 10_000, modelId })
})

test('merged projection recovery preserves the input model when a later frame reports another model', () => {
  for (const contextWindow of [window, undefined]) {
    const reportedModel = 'later-reported-model'
    const projectedRun = { ...baseRun, actualModelId: reportedModel }
    const messages = restoreChatSnapshot(snapshot({ run: projectedRun, runs: [projectedRun], projection: [
      { content: 'Answer still in progress' },
      { usage: { modelId: reportedModel, contextModelId: modelId, currentPromptTokens: 10_000,
        promptTokens: 44_000, completionTokens: 600, totalTokens: 44_600,
        ...(contextWindow === undefined ? {} : { contextWindow }) } }
    ] })).messages
    expect(messages).toHaveLength(1)
    expect(messages[0].modelId).toBe(reportedModel)
    expect(latestContextUsage(messages)).toEqual({ used: 10_000, modelId,
      ...(contextWindow === undefined ? {} : { contextWindow }) })
    expect(sumUsage(messages).total).toBe(44_600)
    const invoked = reducePayload(messages[0], { usage: { modelId: reportedModel, contextModelId: reportedModel,
      currentPromptTokens: 8_000, promptTokens: 52_000, contextWindow: 64_000 } })
    expect(latestContextUsage([invoked])).toEqual({ used: 8_000, contextWindow: 64_000, modelId: reportedModel })
  }
})

test('a window-only newer message is not paired with input from another invocation', () => {
  const older = assistant({ id: 'older', modelId: 'older-model', usage: { currentPromptTokens: 12_000, contextWindow: 64_000 } })
  const incomplete = assistant({ id: 'latest', modelId: 'newer-model', usage: { contextWindow: window, totalTokens: 44_000 } })
  expect(latestContextUsage([older, incomplete])).toEqual({ used: 12_000, contextWindow: 64_000, modelId: 'older-model' })
})

test('user rows and invalid numeric samples do not masquerade as current model input', () => {
  const older = assistant({ usage: { currentPromptTokens: 12_000, contextWindow: window } })
  const invalid = assistant({ id: 'invalid', usage: { currentPromptTokens: -1, promptTokens: 44_000, contextWindow: 64_000 } })
  const user = assistant({ id: 'user', role: 'user', usage: { currentPromptTokens: 99_000, contextWindow: 128_000 } })
  expect(latestContextUsage([older, invalid, user])).toEqual({ used: 12_000, contextWindow: window, modelId })
  expect(latestContextUsage([user, assistant({ usage: { currentPromptTokens: Number.NaN } })])).toBeNull()
  expect(latestContextUsage([])).toBeNull()
})

test('live projection recovery replaces persisted partial usage and keeps final occupancy separate from billing', () => {
  const projection = invocationUsage.map((usage, index) => ({ usage: {
    modelId, currentPromptTokens: usage.currentPromptTokens, contextWindow: window,
    promptTokens: invocationUsage.slice(0, index + 1).reduce((sum, item) => sum + item.promptTokens, 0),
    completionTokens: (index + 1) * 200,
    totalTokens: invocationUsage.slice(0, index + 1).reduce((sum, item) => sum + item.promptTokens, 0) + (index + 1) * 200
  } }))
  const recovered = restoreChatSnapshot(snapshot({
    history: [
      { id: baseRun.userMessageId, role: 'user', content: 'continue after compaction', conversationId: baseRun.turnId },
      historyRow(baseRun.assistantMessageId, { promptTokens: 90_000, currentPromptTokens: 90_000, contextWindow: window })
    ],
    projection: [{ content: 'Recovered answer' }, ...projection]
  })).messages
  expect(recovered).toHaveLength(2)
  expect(recovered[1]).toMatchObject({ content: 'Recovered answer', runId: baseRun.runId, status: 'streaming' })
  expect(latestContextUsage(recovered)).toEqual({ used: 10_000, contextWindow: window, modelId })
  expect(sumUsage(recovered).total).toBe(44_600)
})

test('live and persisted recovery return the same occupancy despite different usage storage semantics', () => {
  const completed = { ...baseRun, status: 'succeeded' as const, version: 2, finishedAt: 3 }
  const live = restoreChatSnapshot(snapshot({ finished: true, run: completed, runs: [completed], projection: [
    { content: 'Completed answer' },
    { usage: { modelId, promptTokens: 44_000, completionTokens: 600, totalTokens: 44_600,
      currentPromptTokens: 10_000, contextWindow: window } }
  ] })).messages
  const persisted = restoreChatSnapshot(snapshot({ source: 'persisted', eventId: null, finished: true,
    run: completed, runs: [completed], history: invocationUsage.map((usage, index) => historyRow('saved-' + index,
      { ...usage, contextWindow: window, totalTokens: usage.promptTokens + usage.completionTokens })) })).messages
  expect(latestContextUsage(live)).toEqual({ used: 10_000, contextWindow: window, modelId })
  expect(latestContextUsage(persisted)).toEqual(latestContextUsage(live))
  expect(sumUsage(persisted).total).toBe(sumUsage(live).total)
})

test('raw dispatch and provisional provider snapshots preserve request estimates without billing until settlement', () => {
  let message = assistant({ usage: { usageScope: 'turn', promptTokens: 139_000,
    completionTokens: 400, totalTokens: 139_400, currentPromptTokens: 14_600, contextWindow: window } })
  const anchor = createSessionUsageAnchor([message], { promptTokens: 139_000, completionTokens: 400, totalTokens: 139_400 })
  expect(anchor).not.toBeNull()
  message = reducePayload(message, { usage: { modelId, currentPromptTokens: 42_900,
    contextWindow: window, contextUsageEstimated: true } })
  expect(message.contextUsageEstimated).toBe(true)
  expect(latestContextUsage([message])).toEqual({ used: 42_900, contextWindow: window, modelId, estimated: true, requestInputTokenEstimate: 42_900 })
  expect(sumUsage([message])).toMatchObject({ input: 139_000, output: 400, total: 139_400 })
  expect(sessionUsageTotal([message], anchor)).toMatchObject({ input: 139_000, output: 400, total: 139_400 })
  message = reducePayload(message, { usage: { modelId, currentPromptTokens: 39_000,
    contextWindow: window, contextUsageEstimated: false } })
  expect(message.contextUsageEstimated).toBe(false)
  expect(latestContextUsage([message])).toEqual({ used: 39_000, contextWindow: window, modelId, estimated: false, provisional: true, requestInputTokenEstimate: 42_900 })
  expect(sumUsage([message])).toMatchObject({ input: 139_000, output: 400, total: 139_400 })
  expect(sessionUsageTotal([message], anchor)).toMatchObject({ input: 139_000, output: 400, total: 139_400 })
  message = reducePayload(message, { usage: { usageScope: 'turn', modelId,
    promptTokens: 178_000, completionTokens: 900, totalTokens: 178_900,
    currentPromptTokens: 39_000, contextWindow: window, contextUsageEstimated: false } })
  expect(latestContextUsage([message])).toEqual({ used: 39_000, contextWindow: window, modelId, estimated: false })
  expect(sumUsage([message])).toMatchObject({ input: 178_000, output: 900, total: 178_900 })
  expect(sessionUsageTotal([message], anchor)).toMatchObject({ input: 178_000, output: 900, total: 178_900 })
})

test('a first estimated dispatch snapshot has no input or output charges', () => {
  const message = reducePayload(assistant(), { usage: { modelId, currentPromptTokens: 42_900,
    contextWindow: window, contextUsageEstimated: true } })
  expect(latestContextUsage([message])).toEqual({ used: 42_900, contextWindow: window, modelId, estimated: true, requestInputTokenEstimate: 42_900 })
  expect(sumUsage([message])).toMatchObject({ input: 0, output: 0, total: 0 })
  expect(sessionUsageTotal([message])).toMatchObject({ input: 0, output: 0, total: 0 })
})

test('model-only live frames preserve the estimate source with its input model and window', () => {
  for (const estimated of [true, false]) {
    const previous = reducePayload(assistant(), { usage: { modelId, currentPromptTokens: 42_900,
      contextWindow: window, contextUsageEstimated: estimated } })
    const reported = reducePayload(previous, { usage: { modelId: 'later-reported-model' } })
    expect(reported.modelId).toBe('later-reported-model')
    expect(reported.contextUsageEstimated).toBe(estimated)
    expect(latestContextUsage([reported])).toEqual({ used: 42_900, contextWindow: window, modelId, estimated, ...(estimated ? { requestInputTokenEstimate: 42_900 } : { provisional: true }) })
    expect(sumUsage([reported]).total).toBe(0)
  }
})

test('new explicit or legacy input without a source flag clears the preceding estimate source', () => {
  const previous = reducePayload(assistant(), { usage: { modelId, currentPromptTokens: 42_900,
    contextWindow: window, contextUsageEstimated: true } })
  for (const input of [{ currentPromptTokens: 39_000 }, { promptTokens: 39_000 }]) {
    const invoked = reducePayload(previous, { usage: { modelId: 'new-input-model', ...input } })
    expect(invoked.contextUsageEstimated).toBeUndefined()
    expect(latestContextUsage([invoked])).toEqual({ used: 39_000, modelId: 'new-input-model' })
  }
})

test('history metadata estimate source is paired to each input and a later model-only row cannot relabel it', () => {
  const estimated = historyRow('estimated-input', { promptTokens: 42_900, currentPromptTokens: 42_900, contextWindow: window },
    { metadata: { contextUsageEstimated: true } })
  expect(latestContextUsage(replayMessages([estimated])))
    .toEqual({ used: 42_900, contextWindow: window, modelId, estimated: true })
  const observed = historyRow('observed-input', { promptTokens: 39_000, currentPromptTokens: 39_000, contextWindow: 64_000 },
    { modelId: 'observed-input-model', metadata: { contextUsageEstimated: false } })
  const modelOnly = historyRow('later-model-only', {}, { modelId: 'later-reported-model', metadata: { contextUsageEstimated: true } })
  const messages = replayMessages([estimated, observed, modelOnly])
  expect(messages).toHaveLength(1)
  expect(messages[0].modelId).toBe('later-reported-model')
  expect(messages[0].contextUsageEstimated).toBe(false)
  expect(latestContextUsage(messages)).toEqual({ used: 39_000, contextWindow: 64_000, modelId: 'observed-input-model', estimated: false })
  expect(sumUsage(messages).input).toBe(81_900)
})

test('history new input without estimate metadata clears the earlier source including legacy prompt fallback', () => {
  const estimated = historyRow('estimated-input', { promptTokens: 42_900, currentPromptTokens: 42_900, contextWindow: window },
    { metadata: { contextUsageEstimated: true } })
  for (const input of [{ currentPromptTokens: 39_000, promptTokens: 39_000 }, { promptTokens: 39_000 }]) {
    const messages = replayMessages([estimated, historyRow('legacy-input', input, { modelId: 'legacy-input-model' })])
    expect(messages[0].contextUsageEstimated).toBeUndefined()
    expect(latestContextUsage(messages)).toEqual({ used: 39_000, modelId: 'legacy-input-model' })
    expect(sumUsage(messages).input).toBe(81_900)
  }
})

test('provider explicit zero preserves raw provisional live input and confirmed persisted zero', () => {
  const previous = reducePayload(assistant({ usage: { promptTokens: 139_000, totalTokens: 139_000 } }),
    { usage: { modelId, currentPromptTokens: 42_900, contextWindow: window, contextUsageEstimated: true } })
  const live = reducePayload(previous, { usage: { modelId, currentPromptTokens: 0,
    contextWindow: window, contextUsageEstimated: false } })
  expect(live.contextUsageEstimated).toBe(false)
  expect(latestContextUsage([live])).toEqual({ used: 0, contextWindow: window, modelId, estimated: false, provisional: true, requestInputTokenEstimate: 42_900 })
  expect(sumUsage([live]).input).toBe(139_000)
  const persisted = replayMessages([
    historyRow('estimated-input', { promptTokens: 42_900, currentPromptTokens: 42_900, contextWindow: window },
      { metadata: { contextUsageEstimated: true } }),
    historyRow('zero-input', { promptTokens: 0, currentPromptTokens: 0, contextWindow: window },
      { metadata: { contextUsageEstimated: false } })
  ])
  expect(persisted[0].contextUsageEstimated).toBe(false)
  expect(latestContextUsage(persisted)).toEqual({ used: 0, contextWindow: window, modelId, estimated: false })
  expect(sumUsage(persisted).input).toBe(42_900)
})

test('projection recovery retains dispatch estimate source and paired input identity through later model-only reports', () => {
  const reportedModel = 'later-reported-model'
  const projectedRun = { ...baseRun, actualModelId: reportedModel }
  const restored = restoreChatSnapshot(snapshot({ run: projectedRun, runs: [projectedRun], projection: [
    { usage: { modelId, currentPromptTokens: 42_900, contextWindow: window, contextUsageEstimated: true } },
    { usage: { modelId: reportedModel } }
  ] })).messages
  expect(restored).toHaveLength(1)
  expect(restored[0].modelId).toBe(reportedModel)
  expect(restored[0].contextUsageEstimated).toBe(true)
  expect(latestContextUsage(restored)).toEqual({ used: 42_900, contextWindow: window, modelId, estimated: true, requestInputTokenEstimate: 42_900 })
  expect(sumUsage(restored).total).toBe(0)
})

test('live provider correction and persisted metadata recover the same observed context source', () => {
  const completed = { ...baseRun, status: 'succeeded' as const, version: 2, finishedAt: 3 }
  const usage = { promptTokens: 39_000, completionTokens: 500, totalTokens: 39_500,
    currentPromptTokens: 39_000, contextWindow: window }
  const live = restoreChatSnapshot(snapshot({ finished: true, run: completed, runs: [completed], projection: [
    { usage: { modelId, currentPromptTokens: 42_900, contextWindow: window, contextUsageEstimated: true } },
    { usage: { modelId, currentPromptTokens: 39_000, contextWindow: window, contextUsageEstimated: false } },
    { usage: { ...usage, modelId, contextUsageEstimated: false } }
  ] })).messages
  const persisted = restoreChatSnapshot(snapshot({ source: 'persisted', eventId: null, finished: true,
    run: completed, runs: [completed], history: [historyRow('observed-input', usage, { metadata: { contextUsageEstimated: false } })]
  })).messages
  expect(latestContextUsage(live)).toEqual({ used: 39_000, contextWindow: window, modelId, estimated: false })
  expect(latestContextUsage(persisted)).toEqual(latestContextUsage(live))
  expect(sumUsage(live).total).toBe(39_500)
  expect(sumUsage(persisted).total).toBe(39_500)
})

test('observed 14577 to 14589 to 14605 context remains distinct while real cumulative charges grow to 242434', () => {
  const actualModel = 'deepseek-v4.1-flash'
  const samples = [
    { input: 14_577, billed: 139_352 },
    { input: 14_589, billed: 198_324 },
    { input: 14_605, billed: 242_434 }
  ]
  let message = assistant({ modelId: actualModel })
  const observed: number[] = []
  const history: EngineHistoryRow[] = []
  let previousBilling = 0
  for (const [index, sample] of samples.entries()) {
    message = reducePayload(message, { usage: { usageScope: 'turn', modelId: actualModel,
      currentPromptTokens: sample.input, contextWindow: 1_000_000,
      contextUsageEstimated: false, totalTokens: sample.billed } })
    const context = latestContextUsage([message])
    expect(context).toEqual({ used: sample.input, contextWindow: 1_000_000, modelId: actualModel, estimated: false })
    expect(message.contextUsageEstimated).toBe(false)
    expect(sumUsage([message]).total).toBe(sample.billed)
    observed.push(context!.used)
    history.push(historyRow('real-sample-' + index, { currentPromptTokens: sample.input,
      contextWindow: 1_000_000, totalTokens: sample.billed - previousBilling },
    { modelId: actualModel, metadata: { contextUsageEstimated: false } }))
    const replayed = replayMessages(history)
    expect(latestContextUsage(replayed)).toEqual(context)
    expect(sumUsage(replayed).total).toBe(sample.billed)
    previousBilling = sample.billed
  }
  expect(observed).toEqual([14_577, 14_589, 14_605])
})

test('cached input is nested under the full prompt total while billing and context retain provider input', () => {
  const message = assistant({ usage: { promptTokens: 3200, cacheHitTokens: 2800, cacheMissTokens: 400,
    completionTokens: 400, totalTokens: 3600, currentPromptTokens: 3200 } })
  const total = sumUsage([message])
  expect(total).toMatchObject({ input: 3200, output: 400, parentTotal: 3600, total: 3600 })
  expect(total.summary.filter(row => !row.child).map(row => [row.label, row.tokens, row.group]))
    .toEqual([['累计输入 Prompt', 3200, 'input'], ['输出 Completion', 400, 'output']])
  expect(total.summary.find(row => row.label === '缓存未命中')).toMatchObject({ tokens: 400, group: 'input', child: true })
  expect(total.summary.find(row => row.label === '缓存命中')).toMatchObject({ tokens: 2800, group: 'cache', child: true })
  expect(latestContextUsage([message])?.used).toBe(3200)
  expect(groupIntoTurns([message])[0]).toMatchObject({ tokens: 3600, summary: total.summary })
  const anchored = sessionUsageTotal([message], createSessionUsageAnchor([message],
    { promptTokens: 3200, cacheHitTokens: 2800, cacheMissTokens: 400, completionTokens: 400, totalTokens: 3600 }))
  expect(anchored).toMatchObject({ input: 3200, output: 400, total: 3600, summary: total.summary })
})

test('a fully cached request keeps an explicit zero uncached-input row without adding cache to the bill', () => {
  const total = sumUsage([assistant({ usage: { promptTokens: 100, cacheHitTokens: 100,
    completionTokens: 20, totalTokens: 120 } })])
  expect(total).toMatchObject({ input: 100, output: 20, parentTotal: 120, total: 120 })
  expect(total.summary.filter(row => !row.child).map(row => [row.label, row.tokens]))
    .toEqual([['累计输入 Prompt', 100], ['输出 Completion', 20]])
  expect(total.summary.find(row => row.label === '缓存命中')).toMatchObject({ tokens: 100, child: true, group: 'cache' })
  expect(total.summary.some(row => row.label === '缓存未命中')).toBe(false)
})

test('cache reported above the input is capped for display with the original provider amount preserved in its title', () => {
  const message = assistant({ usage: { promptTokens: 100, cacheHitTokens: 250, completionTokens: 2, totalTokens: 102 } })
  const total = sumUsage([message])
  expect(total).toMatchObject({ input: 100, output: 2, parentTotal: 102, total: 102 })
  expect(total.summary.find(row => row.label === '累计输入 Prompt')?.tokens).toBe(100)
  expect(total.summary.find(row => row.label === '缓存命中')).toMatchObject({ tokens: 100,
    title: '供应商报告缓存命中 250 tokens，超过输入总量；按输入上限展示。' })
  expect(message.usage).toMatchObject({ cacheHitTokens: 250 })
})

test('missing input keeps observed cache usage without inventing an uncached input amount or cache miss', () => {
  const total = sumUsage([assistant({ usage: { cacheHitTokens: 90, completionTokens: 20, totalTokens: 110 } })])
  expect(total).toMatchObject({ input: 0, output: 20, parentTotal: 110, total: 110 })
  expect(total.summary.find(row => row.label === '缓存命中')).toMatchObject({ tokens: 90,
    title: '输入总量未报告，无法确认缓存占比。' })
  expect(total.summary.some(row => row.label === '累计输入 Prompt')).toBe(false)
  expect(total.summary.some(row => row.label === '缓存未命中')).toBe(false)
})

test('an inconsistent provider total remains authoritative and missing totals fall back to full input plus output', () => {
  for (const usage of [
    { promptTokens: 100, cacheHitTokens: 80, completionTokens: 10, totalTokens: 65 },
    { promptTokens: 100, cacheHitTokens: 80, completionTokens: 10 }
  ]) {
    const total = sumUsage([assistant({ usage })])
    expect(total.input).toBe(100)
    expect(total.output).toBe(10)
    expect(total.total).toBe(usage.totalTokens ?? 110)
    expect(total.summary.filter(row => !row.child).map(row => [row.label, row.tokens]))
      .toEqual([['累计输入 Prompt', 100], ['输出 Completion', 10]])
  }
})

test('cache splitting preserves deduplicated child billing and omits a redundant complete parent subtotal', () => {
  const child: SubagentRun = {
    schemaVersion: 1, runId: 'cache-child', tenantId: 'tenant', rootSessionId: 'session', parentSessionId: 'session',
    parentConversationId: 'turn', parentMessageId: baseRun.assistantMessageId, parentToolCallId: 'dispatch-child',
    childSessionId: 'child-session', task: 'review', description: 'review', modelId, status: 'succeeded',
    lastSeq: 2, createdAt: 1, updatedAt: 2, usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, cacheReadTokens: 30 },
    toolCalls: []
  }
  const message = assistant({ usage: { promptTokens: 100, cacheHitTokens: 75, completionTokens: 10, totalTokens: 110 },
    tools: ['dispatch-child', 'duplicate-child'].map(id => ({ id, name: 'subagent', args: '', result: '', state: 'done', subagent: child })) })
  const total = sumUsage([message])
  expect(total).toMatchObject({ input: 100, output: 10, parentTotal: 110, subagentTotal: 50, total: 160 })
  expect(total.summary.some(row => row.label === '主代理自身')).toBe(false)
  expect(total.summary.filter(row => !row.child).map(row => [row.label, row.tokens]))
    .toEqual([['累计输入 Prompt', 100], ['输出 Completion', 10], ['子代理（已知用量）', 50]])
  expect(groupIntoTurns([message])[0].tokens).toBe(160)
  const unmatched = sumUsage([assistant({ ...message, usage: { promptTokens: 100, cacheHitTokens: 75,
    completionTokens: 10, totalTokens: 115 } })])
  expect(unmatched.total).toBe(165)
  expect(unmatched.summary.find(row => row.label === '主代理自身')).toMatchObject({ tokens: 115, subtotal: true })
})

test('cache from calls without a reported input stays visible alongside input from complete calls', () => {
  const messages = [
    assistant({ id: 'complete-cache-call', usage: { promptTokens: 100, cacheHitTokens: 50, completionTokens: 10, totalTokens: 110 } }),
    assistant({ id: 'partial-cache-call', usage: { cacheHitTokens: 90, completionTokens: 20, totalTokens: 110 } })
  ]
  const total = sumUsage(messages)
  expect(total).toMatchObject({ input: 100, output: 30, total: 220 })
  expect(total.summary.filter(row => !row.child).map(row => [row.label, row.tokens]))
    .toEqual([['累计输入 Prompt', 100], ['输出 Completion', 30]])
  const cache = total.summary.find(row => row.label === '缓存命中')
  expect(cache?.title).toContain('部分调用未报告输入总量')
  expect(cache?.title).not.toContain('超过输入总量')
})

test('session authority with an unreported input preserves cache through increments and refreshed anchors without synthesizing zero input', () => {
  const initial = assistant({ usage: { cacheHitTokens: 90, completionTokens: 20, totalTokens: 110 } })
  const authority = { cacheHitTokens: 90, completionTokens: 20, totalTokens: 110 }
  const anchor = createSessionUsageAnchor([initial], authority)
  expect(anchor?.parent).toEqual(authority)
  const anchored = sessionUsageTotal([initial], anchor)
  expect(anchored).toMatchObject({ input: 0, output: 20, total: 110 })
  expect(anchored.summary.find(row => row.label === '缓存命中')).toMatchObject({ tokens: 90 })
  expect(anchored.summary.some(row => row.label === '累计输入 Prompt')).toBe(false)
  const increment = { cacheHitTokens: 100, completionTokens: 25, totalTokens: 125 }
  const live = reducePayload(initial, { usage: increment })
  const current = sessionUsageTotal([live], anchor)
  expect(current).toMatchObject({ input: 0, output: 25, total: 125 })
  expect(current.summary.find(row => row.label === '缓存命中')).toMatchObject({ tokens: 100 })
  expect(current.summary.some(row => row.label === '累计输入 Prompt')).toBe(false)
  const refreshed = createSessionUsageAnchor([live], increment)
  expect(refreshed?.parent).toEqual(increment)
  expect(sessionUsageTotal([live], refreshed)).toEqual(current)
  expect(authority).toEqual({ cacheHitTokens: 90, completionTokens: 20, totalTokens: 110 })
  expect(anchor?.parent).toEqual(authority)
})

test('explicit zero input remains distinct from an unreported input and caps a contradictory cache count to zero', () => {
  const total = sumUsage([assistant({ usage: { promptTokens: 0, cacheHitTokens: 90, completionTokens: 20, totalTokens: 20 } })])
  expect(total).toMatchObject({ input: 0, output: 20, total: 20 })
  expect(total.summary.filter(row => !row.child).map(row => [row.label, row.tokens]))
    .toEqual([['累计输入 Prompt', 0], ['输出 Completion', 20]])
  expect(total.summary.find(row => row.label === '缓存命中')?.title).toBe('供应商报告缓存命中 90 tokens，超过输入总量；按输入上限展示。')
})

test('a missing input field keeps the parent subtotal even when aggregate prompt plus completion coincidentally equals provider total', () => {
  const child: SubagentRun = {
    schemaVersion: 1, runId: 'subtotal-child', tenantId: 'tenant', rootSessionId: 'session', parentSessionId: 'session',
    parentConversationId: 'turn', parentMessageId: baseRun.assistantMessageId, parentToolCallId: 'dispatch-subtotal',
    childSessionId: 'child-subtotal', task: 'review', description: 'review', modelId, status: 'succeeded',
    lastSeq: 1, createdAt: 1, updatedAt: 2, usage: { totalTokens: 50 }, toolCalls: []
  }
  const messages = [
    assistant({ id: 'subtotal-complete', usage: { promptTokens: 100, cacheHitTokens: 50, completionTokens: 10, totalTokens: 90 } }),
    assistant({ id: 'subtotal-partial', usage: { cacheHitTokens: 20, completionTokens: 10, totalTokens: 30 },
      tools: [{ id: 'dispatch-subtotal', name: 'subagent', args: '', result: '', state: 'done', subagent: child }] })
  ]
  const total = sumUsage(messages)
  expect(total).toMatchObject({ parentTotal: 120, subagentTotal: 50, total: 170 })
  expect(total.summary.find(row => row.label === '主代理自身')).toMatchObject({ tokens: 120, subtotal: true })
})
