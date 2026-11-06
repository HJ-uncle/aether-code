import type { ChatSsePayload } from '@shared/ipc'
import type { RootRun } from '@shared/root-run'
import type { ChatMessage, TimelineItem } from './useChat'
import type { ChatRecoverySnapshot } from './chat-recovery'
import { extractText, normalizeTool, type EngineHistoryRow } from './chat-history'
import { reducePayload } from './chat-payload'
import { applyProjectedUserMessage, applyProjectedUsage, emptyRunAssistant, ownsRootMessage } from './chat-timeline'

type ToolOwner = { message: number; tool: number }
function reduceFrame(messages: ChatMessage[], payload: ChatSsePayload, run: RootRun, index: number,
  toolsById: Map<string, ToolOwner>, childrenById: Map<string, ToolOwner>): ChatMessage[] {
  const row = payload.userMessage as EngineHistoryRow | undefined
  if (row) return applyProjectedUserMessage(messages, row, run)
  let owner = messages.length - 1
  const raw = payload.toolStart ?? payload.toolCall ?? payload.toolArgs ?? payload.toolEnd ?? payload.toolResult
  const toolId = raw ? normalizeTool(raw).id : payload.fileChange?.toolCallId ?? payload.publishedChild?.identity.parentToolCallId
  const toolOwner = toolId ? toolsById.get(toolId) : undefined
  if (toolOwner) owner = toolOwner.message
  if (messages[owner]?.role !== 'assistant') return messages
  if (payload.publishedChild) {
    const ref = payload.publishedChild, id = ref.identity.parentToolCallId
    const existing = toolsById.get(id) ?? childrenById.get(ref.identity.runId)
    const assistant = messages[existing?.message ?? owner]
    // This private restoration draft is published once. Keep many child
    // references linear instead of copying every preceding tool card.
    const location = existing ?? { message: owner, tool: assistant.tools.length }
    if (!existing) {
      assistant.tools.push({ id, name: 'subagent', args: '', result: '', state: 'unknown', subagentRef: ref, startedAt: ref.identity.createdAt })
      assistant.items.push({ kind: 'tool', id })
    } else assistant.tools[existing.tool] = { ...assistant.tools[existing.tool], subagent: undefined, subagentRef: ref, state: 'unknown' }
    toolsById.set(id, location); childrenById.set(ref.identity.runId, location)
    return messages
  }
  const assistant = reducePayload(messages[owner], payload, { now: run.createdAt, fallbackId: `recovered:${run.runId}:${index}` })
  if (assistant.tools !== messages[owner].tools) assistant.tools.forEach((tool, toolIndex) => {
    const location = { message: owner, tool: toolIndex }
    toolsById.set(tool.id, location)
    if (tool.subagentRef) childrenById.set(tool.subagentRef.identity.runId, location)
  })
  return messages.map((message, position) => position === owner ? assistant : message)
}

const ownsRow = (row: EngineHistoryRow, run: RootRun): boolean => row.metadata?.rootRunId === run.runId ||
  row.metadata?.runId === run.runId || row.conversationId === run.turnId || row.metadata?.turnId === run.turnId ||
  row.id === run.userMessageId || row.id === run.assistantMessageId

/** Older streams did not publish steering boundaries. Only an exact persisted
 * prefix may be removed from their aggregate; timestamps never guess ordering. */
function splitLegacyProjection(history: EngineHistoryRow[], replayed: ChatMessage[], aggregate: ChatMessage, run: RootRun): ChatMessage[] {
  const rows = history.filter(row => !row.isSidechain && ownsRow(row, run))
  let lastUser = -1
  for (let index = rows.length - 1; index >= 0; index--) if (rows[index].role === 'user') { lastUser = index; break }
  const prefixRows = rows.slice(0, lastUser).filter(row => row.role === 'assistant')
  const prefixes = {
    content: prefixRows.map(row => extractText(row.content)).join(''),
    thinking: prefixRows.map(row => typeof row.reasoningContent === 'string' ? row.reasoningContent : '').join('')
  }
  const remaining = { content: prefixes.content.length, thinking: prefixes.thinking.length }
  const exact = { content: aggregate.content.startsWith(prefixes.content), thinking: aggregate.thinking.startsWith(prefixes.thinking) }
  const toolsBefore = new Set(prefixRows.flatMap(row => row.toolCall?.id ? [row.toolCall.id] : []))
  const lastUserId = rows[lastUser]?.id
  const lastUserIndex = replayed.findIndex(message => message.role === 'user' && message.id === lastUserId)
  const previousTail = replayed.slice(lastUserIndex + 1).find(message => message.role === 'assistant')
  const items: TimelineItem[] = []
  for (const item of aggregate.items) {
    if (item.kind === 'tool') { if (!toolsBefore.has(item.id)) items.push(item); continue }
    if (item.kind === 'interaction') { items.push(item); continue }
    if (!exact[item.kind]) continue
    const offset = Math.min(item.text.length, remaining[item.kind])
    remaining[item.kind] -= offset
    if (offset < item.text.length) items.push({ ...item, text: item.text.slice(offset) })
  }
  for (const item of previousTail?.items ?? []) {
    if ((item.kind === 'content' || item.kind === 'thinking') && !exact[item.kind]) items.push(item)
  }
  const tailTools = new Map((previousTail?.tools ?? []).map(tool => [tool.id, tool]))
  for (const tool of aggregate.tools) if (!toolsBefore.has(tool.id)) tailTools.set(tool.id, tool)
  for (const tool of tailTools.values()) if (!items.some(item => item.kind === 'tool' && item.id === tool.id)) items.push({ kind: 'tool', id: tool.id })
  const tail: ChatMessage = { ...aggregate,
    createdAt: previousTail?.createdAt ?? replayed[lastUserIndex]?.createdAt ?? run.createdAt,
    content: exact.content ? aggregate.content.slice(prefixes.content.length) : previousTail?.content ?? '',
    thinking: exact.thinking ? aggregate.thinking.slice(prefixes.thinking.length) : previousTail?.thinking ?? '',
    usage: previousTail?.usage, tools: [...tailTools.values()], items }
  const projectedTools = new Map(aggregate.tools.map(tool => [tool.id, tool]))
  const completed = replayed.slice(0, lastUserIndex + 1).map(message => message.role !== 'assistant' ? message : {
    ...message, tools: message.tools.map(tool => projectedTools.get(tool.id) ?? tool)
  })
  return [...completed, tail]
}

/** Replace one run's projection in place, retaining user/assistant boundaries. */
export function restoreProjectedTimeline(snapshot: ChatRecoverySnapshot, historyMessages: ChatMessage[], run: RootRun): ChatMessage[] {
  const owned = historyMessages.filter(message => ownsRootMessage(message, run))
  const original = owned.find(message => message.role === 'user' && message.id === run.userMessageId)
  let projected = [...(original ? [original] : []), emptyRunAssistant(run)]
  // When the original admission is not persisted yet, the first user frame
  // replaces the initial placeholder rather than following an empty bubble.
  const firstUser = snapshot.projection.find(payload => (payload.userMessage as EngineHistoryRow | undefined)?.id === run.userMessageId)?.userMessage as EngineHistoryRow | undefined
  if (!original && firstUser) projected = applyProjectedUserMessage([], firstUser, run)
  let usageMessage: ChatMessage | undefined
  const toolsById = new Map<string, ToolOwner>(), childrenById = new Map<string, ToolOwner>()
  for (const [index, payload] of snapshot.projection.entries()) {
    if (payload.usage) {
      usageMessage = reducePayload(usageMessage ?? emptyRunAssistant(run), payload)
      continue
    }
    projected = reduceFrame(projected, payload, run, snapshot.projectionIndices?.[index] ?? index, toolsById, childrenById)
  }
  const boundaries = new Set(projected.filter(message => message.role === 'user').map(message => message.id))
  const historyBoundaries = owned.filter(message => message.role === 'user' && message.id !== run.userMessageId)
  if (historyBoundaries.some(message => !boundaries.has(message.id))) {
    const assistants = projected.filter(message => message.role === 'assistant')
    const aggregate = { ...emptyRunAssistant(run), content: assistants.map(message => message.content).join(''),
      thinking: assistants.map(message => message.thinking).join(''), tools: assistants.flatMap(message => message.tools),
      items: assistants.flatMap(message => message.items) }
    projected = splitLegacyProjection(snapshot.history, owned, aggregate, run)
  } else {
    // The projection keeps one cumulative usage frame. Durable assistant rows
    // retain per-iteration billing and stable segment IDs before each boundary.
    const byUser = new Map<string, ChatMessage>()
    let precedingUser = run.userMessageId
    for (const message of owned) {
      if (message.role === 'user') precedingUser = message.id
      else byUser.set(precedingUser, message)
    }
    precedingUser = run.userMessageId
    projected = projected.map((message, index) => {
      if (message.role === 'user') { precedingUser = message.id; return message }
      const persisted = byUser.get(precedingUser)
      if (!persisted) return message
      const current = index === projected.length - 1
      return { ...message,
        id: current ? run.assistantMessageId : persisted.id === run.assistantMessageId ? message.id : persisted.id,
        createdAt: persisted.createdAt || message.createdAt,
        startedAt: persisted.startedAt || message.startedAt,
        modelId: persisted.modelId ?? message.modelId,
        usage: persisted.usage }
    })
  }
  if (usageMessage?.usage && typeof usageMessage.usage === 'object') {
    projected = applyProjectedUsage(projected, { ...usageMessage.usage,
      ...(usageMessage.contextModelId ? { contextModelId: usageMessage.contextModelId } : {}) }, run.runId)
  }
  if (snapshot.publishedUsage) projected = projected.map(message => message.role === 'assistant'
    ? { ...message, publishedChildFence: snapshot.publishedUsage!.fence } : message)
  const first = historyMessages.findIndex(message => ownsRootMessage(message, run))
  const retained = historyMessages.filter(message => !ownsRootMessage(message, run))
  const insertion = first < 0 ? retained.length : historyMessages.slice(0, first).filter(message => !ownsRootMessage(message, run)).length
  retained.splice(insertion, 0, ...projected)
  return retained
}
