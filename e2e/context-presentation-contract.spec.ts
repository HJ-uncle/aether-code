/** Confirmed model inputs and pending estimates remain separate; window changes cannot expand effective limits. */
import { expect, test } from '@playwright/test'
import { contextPresentation, contextPresentationLimit } from '../src/renderer/src/contrib/chat/context-presentation'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { sumUsage } from '../src/renderer/src/contrib/chat/usage'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { EngineModel } from '../src/renderer/src/core/engine/models'

const modelId = 'deepseek-v4.1-flash'
const initial = (): ChatMessage => ({ id: 'a', role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'streaming', createdAt: 1, modelId })
const model = (window: number): EngineModel => ({ id: 'm', tenantId: 'default', modelId, provider: 'deepseek', baseUrl: 'https://fixture.invalid', apiKey: '', isEnabled: true,
  createdAt: 1, updatedAt: 2, capabilities: { contextWindow: window }, resolvedCapabilities: { contextWindow: window } })
const finalFrame = (used: number, total = used) => ({ usage: { usageScope: 'turn', currentPromptTokens: used, contextWindow: 128000, modelId,
  contextUsageEstimated: false, contextUsageProvisional: false, promptTokens: total, completionTokens: 0, totalTokens: total } })

test('pending estimate and provisional gateway input cannot replace the confirmed main metric or charge usage', () => {
  let message = reducePayload(initial(), finalFrame(55327, 164025))
  message = reducePayload(message, { usage: { currentPromptTokens: 64673, contextWindow: 128000, modelId, contextUsageEstimated: true, requestInputTokenEstimate: 64673 } })
  expect(contextPresentation([message])).toEqual({ primary: { used: 55327, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 64673 })
  const billing = message.usage
  message = reducePayload(message, { usage: { currentPromptTokens: 19848, contextWindow: 128000, modelId, contextUsageEstimated: false,
    contextUsageProvisional: true, requestInputTokenEstimate: 64673 } })
  expect(contextPresentation([message]).primary?.used).toBe(55327)
  expect(contextPresentation([message]).requestEstimate).toBe(64673)
  expect(message.usage).toMatchObject({ promptTokens: 164025, totalTokens: 164025 })
  expect(billing).toMatchObject({ totalTokens: 164025 })
  message = reducePayload(message, finalFrame(56306, 221626))
  expect(contextPresentation([message]).primary?.used).toBe(56306)
  expect(contextPresentation([message]).requestEstimate).toBeUndefined()
})

test('the first request retains its estimate until the gateway confirms completion', () => {
  let message = reducePayload(initial(), { usage: { currentPromptTokens: 64673, contextWindow: 128000, modelId, contextUsageEstimated: true } })
  message = reducePayload(message, { usage: { currentPromptTokens: 19848, contextWindow: 128000, modelId, contextUsageEstimated: false, contextUsageProvisional: true } })
  expect(contextPresentation([message]).primary).toMatchObject({ used: 64673, estimated: true })
  message = reducePayload(message, finalFrame(57672))
  expect(contextPresentation([message]).primary).toMatchObject({ used: 57672, estimated: false })
})

test('older engine context-only reports stay provisional until its actual cumulative billing frame', () => {
  let message = reducePayload(initial(), { usage: { currentPromptTokens: 55327, contextWindow: 128000, modelId, contextUsageEstimated: false, totalTokens: 164025 } })
  message = reducePayload(message, { usage: { currentPromptTokens: 64673, contextWindow: 128000, modelId, contextUsageEstimated: true } })
  message = reducePayload(message, { usage: { currentPromptTokens: 19848, contextWindow: 128000, modelId, contextUsageEstimated: false } })
  expect(contextPresentation([message]).primary?.used).toBe(55327)
  expect(contextPresentation([message]).requestEstimate).toBe(64673)
  message = reducePayload(message, { usage: { currentPromptTokens: 56306, contextWindow: 128000, modelId, contextUsageEstimated: false, totalTokens: 221626 } })
  expect(contextPresentation([message]).primary?.used).toBe(56306)
})

test('explicit confirmed zero and a genuine smaller context remain authoritative', () => {
  let message = reducePayload(initial(), finalFrame(55327))
  message = reducePayload(message, finalFrame(0, 55327))
  expect(contextPresentation([message]).primary?.used).toBe(0)
  message = reducePayload(message, finalFrame(10000, 65327))
  expect(contextPresentation([message]).primary?.used).toBe(10000)
})

test('estimates from another model cannot borrow an earlier confirmed input', () => {
  let message = reducePayload(initial(), finalFrame(55327))
  message = reducePayload(message, { usage: { currentPromptTokens: 20000, contextWindow: 64000, modelId: 'another-model', contextUsageEstimated: true } })
  expect(contextPresentation([message]).primary).toMatchObject({ used: 20000, contextWindow: 64000, modelId: 'another-model', estimated: true })
})

test('a projected snapshot recovers both confirmed usage and pending estimate without prior client memory', () => {
  const message = reducePayload(initial(), { usage: { modelId, currentPromptTokens: 19848, contextWindow: 128000, contextUsageEstimated: false,
    contextUsageProvisional: true, requestInputTokenEstimate: 64673, confirmedContext: { used: 55327, contextWindow: 128000, modelId } } })
  expect(contextPresentation([message])).toEqual({ primary: { used: 55327, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 64673 })
})

test('history keeps a preceding confirmed call while a later interrupted call retains its provisional count', () => {
  const messages = replayMessages([
    { id: 'confirmed', role: 'assistant', conversationId: 'turn', modelId, content: '', metadata: { contextUsageEstimated: false },
      usage: { promptTokens: 55327, currentPromptTokens: 55327, contextWindow: 128000 } },
    { id: 'partial', role: 'assistant', conversationId: 'turn', modelId, content: 'partial',
      metadata: { contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: 64673 },
      usage: { promptTokens: 19848, currentPromptTokens: 19848, contextWindow: 128000 } },
  ])
  expect(contextPresentation(messages).primary?.used).toBe(55327)
  expect(contextPresentation(messages).requestEstimate).toBe(64673)
  expect(messages[0].usage).toMatchObject({ promptTokens: 75175, currentPromptTokens: 19848 })
})

test('a current model configuration lowers the old 1M window without borrowing another composer model', () => {
  const sample = { used: 19037, modelId, contextWindow: 1000000 }
  expect(contextPresentationLimit(sample, [model(128000)], 'other', 128000)).toBe(128000)
  expect(contextPresentationLimit(sample, [model(256000)], 'other', 128000)).toBe(256000)
  expect(contextPresentationLimit(sample, [model(1000000)], 'other', 128000)).toBe(1000000)
  expect(contextPresentationLimit({ ...sample, contextWindow: 64000 }, [model(128000)], modelId, 128000)).toBe(64000)
  expect(contextPresentationLimit({ ...sample, modelId: 'removed-model' }, [model(128000)], modelId, 128000)).toBe(1000000)
})

test('a single persisted estimated row restores its supplied confirmation without previous client state', () => {
  const messages = replayMessages([{ id: 'single-estimate', role: 'assistant', modelId, conversationId: 'single-turn',
    usage: { currentPromptTokens: 70001, contextWindow: 128000, contextUsageEstimated: true,
      requestInputTokenEstimate: 70001, confirmedContext: { used: 56306, contextWindow: 128000, modelId },
      promptTokens: 1000, completionTokens: 5, totalTokens: 1005 } }])
  expect(contextPresentation(messages)).toEqual({ primary: { used: 56306, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 70001 })
  expect(sumUsage(messages).total).toBe(1005)
  expect(sumUsage(messages).input).toBe(1000)
})

test('a single persisted provisional row restores usage phase flags and confirmedContext', () => {
  const messages = replayMessages([{ id: 'single-provisional', role: 'assistant', modelId,
    usage: { currentPromptTokens: 19848, contextWindow: 128000, contextUsageEstimated: false,
      contextUsageProvisional: true, requestInputTokenEstimate: 64673,
      confirmedContext: { used: 55327, contextWindow: 128000, modelId },
      promptTokens: 19848, completionTokens: 10, totalTokens: 19858 } }])
  expect(contextPresentation(messages)).toEqual({ primary: { used: 55327, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 64673 })
  expect(messages[0].usage).toMatchObject({ currentPromptTokens: 19848, contextUsageEstimated: false, contextUsageProvisional: true })
  expect(sumUsage(messages).total).toBe(19858)
})

test('history metadata takes precedence over conflicting usage phase flags and accepts an explicit zero estimate', () => {
  const messages = replayMessages([{ id: 'metadata-first', role: 'assistant', modelId,
    metadata: { contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: 0 },
    usage: { currentPromptTokens: 19848, contextWindow: 128000, contextUsageEstimated: true,
      contextUsageProvisional: false, requestInputTokenEstimate: 64673,
      confirmedContext: { used: 55327, contextWindow: 128000, modelId }, promptTokens: 19848 } }])
  expect(contextPresentation(messages)).toEqual({ primary: { used: 55327, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 0 })
  expect(messages[0].usage).toMatchObject({ contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: 0 })
})

test('a final metadata confirmation overrides a stale supplied confirmed sample, including explicit zero input', () => {
  for (const used of [56306, 0]) {
    const messages = replayMessages([{ id: 'metadata-final', role: 'assistant', modelId,
      metadata: { contextUsageEstimated: false, contextUsageProvisional: false },
      usage: { currentPromptTokens: used, contextWindow: 128000, contextUsageEstimated: true,
        contextUsageProvisional: true, requestInputTokenEstimate: 64673,
        confirmedContext: { used: 55327, contextWindow: 128000, modelId }, promptTokens: used } }])
    expect(contextPresentation(messages).primary).toMatchObject({ used, estimated: false, provisional: false })
    expect(contextPresentation(messages).requestEstimate).toBeUndefined()
    expect(messages[0].usage).toMatchObject({ confirmedContext: { used, contextWindow: 128000, modelId } })
  }
})

test('persisted input ownership precedes a later reported model and never borrows another model confirmation', () => {
  const messages = replayMessages([{ id: 'foreign-confirmation', role: 'assistant', modelId,
    usage: { currentPromptTokens: 20000, contextWindow: 64000, contextModelId: 'another-model',
      contextUsageEstimated: true, requestInputTokenEstimate: 20000,
      confirmedContext: { used: 55327, contextWindow: 128000, modelId } } }])
  expect(messages[0].modelId).toBe(modelId)
  expect(messages[0].contextModelId).toBe('another-model')
  expect(contextPresentation(messages).primary).toMatchObject({ used: 20000, contextWindow: 64000, modelId: 'another-model', estimated: true })
  expect(contextPresentation(messages).requestEstimate).toBeUndefined()
})

test('later model-only and metadata-only historical rows cannot overwrite an existing input observation', () => {
  const messages = replayMessages([
    { id: 'pending', role: 'assistant', conversationId: 'turn', modelId,
      usage: { currentPromptTokens: 19848, contextWindow: 128000, contextUsageEstimated: false, contextUsageProvisional: true,
        requestInputTokenEstimate: 64673, confirmedContext: { used: 55327, contextWindow: 128000, modelId }, promptTokens: 19848 } },
    { id: 'model-only', role: 'assistant', conversationId: 'turn', modelId: 'later-reported-model',
      metadata: { contextUsageEstimated: true, contextUsageProvisional: false, requestInputTokenEstimate: 99999 },
      usage: { contextWindow: 64000, contextUsageEstimated: true, contextUsageProvisional: false, requestInputTokenEstimate: 99999,
        confirmedContext: { used: 1, contextWindow: 64000, modelId: 'later-reported-model' } } },
    { id: 'metadata-only', role: 'assistant', conversationId: 'turn',
      metadata: { contextUsageEstimated: true, contextUsageProvisional: false, requestInputTokenEstimate: 99999 } },
  ])
  expect(messages).toHaveLength(1)
  expect(messages[0].modelId).toBe('later-reported-model')
  expect(messages[0].contextModelId).toBe(modelId)
  expect(contextPresentation(messages)).toEqual({ primary: { used: 55327, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 64673 })
  expect(sumUsage(messages).input).toBe(19848)
})

test('a new historical estimate without an explicit estimate field cannot retain an earlier request estimate', () => {
  const messages = replayMessages([
    { id: 'confirmed', role: 'assistant', conversationId: 'turn', modelId, metadata: { contextUsageEstimated: false, contextUsageProvisional: false },
      usage: { currentPromptTokens: 55327, contextWindow: 128000, promptTokens: 55327 } },
    { id: 'estimate-one', role: 'assistant', conversationId: 'turn', modelId, metadata: { contextUsageEstimated: true, requestInputTokenEstimate: 64673 },
      usage: { currentPromptTokens: 64673, contextWindow: 128000 } },
    { id: 'estimate-two', role: 'assistant', conversationId: 'turn', modelId, metadata: { contextUsageEstimated: true },
      usage: { currentPromptTokens: 70001, contextWindow: 128000 } },
  ])
  expect(contextPresentation(messages)).toEqual({ primary: { used: 55327, contextWindow: 128000, modelId, estimated: false }, requestEstimate: 70001 })
  expect(sumUsage(messages).input).toBe(55327)
})

test('invalid supplied confirmation and invalid estimate do not become confirmed context or billable usage', () => {
  const messages = replayMessages([{ id: 'invalid-fields', role: 'assistant', modelId,
    usage: { currentPromptTokens: 70001, contextWindow: 128000, contextUsageEstimated: true,
      requestInputTokenEstimate: Infinity, confirmedContext: { used: -1, contextWindow: 128000, modelId } } }])
  expect(contextPresentation(messages).primary).toMatchObject({ used: 70001, estimated: true })
  expect(contextPresentation(messages).requestEstimate).toBeUndefined()
  expect(sumUsage(messages).total).toBe(0)
})
