import type { ChatSsePayload } from '@shared/ipc'
import type { ChatMessage, TimelineItem } from './useChat'
import { finishTool, normalizeTool } from './chat-history'
import { mergePending, normalizePending } from './pending'
function newId(): string { return globalThis.crypto.randomUUID() }

function appendTimeline(items: TimelineItem[], kind: 'thinking' | 'content', text: string): void {
  const last = items[items.length - 1]
  if (last && last.kind === kind) {
    // 浅拷贝的数组与上一帧共享条目对象：合并时必须换出新对象，不能原地改
    items[items.length - 1] = { kind, text: last.text + text }
  } else {
    items.push({ kind, text })
  }
}

export function reducePayload(message: ChatMessage, payload: ChatSsePayload): ChatMessage {
  const payloadError = (payload as { error?: unknown }).error
  if (typeof payloadError === 'string' && payloadError) {
    return {
      ...message,
      status: 'error',
      error: payloadError,
      endedAt: message.endedAt ?? Date.now()
    }
  }

  if (typeof payload.content === 'string') {
    const items = [...message.items]
    appendTimeline(items, 'content', payload.content)
    return { ...message, content: message.content + payload.content, items }
  }

  if (typeof payload.thinking === 'string') {
    const items = [...message.items]
    appendTimeline(items, 'thinking', payload.thinking)
    return { ...message, thinking: message.thinking + payload.thinking, items }
  }

  if (payload.usage && typeof payload.usage === 'object') {
    // Live usage is cumulative. A model-only frame must neither clear counters nor charge them again.
    const previous = message.usage && typeof message.usage === 'object' ? message.usage : {}
    const next = payload.usage as Record<string, unknown>
    return { ...message, usage: { ...previous, ...next },
      modelId: typeof next.modelId === 'string' && next.modelId ? next.modelId : message.modelId }
  }

  // 交互帧优先于工具帧判断：授权场景会同时携带 toolStart/toolEnd，
  // 若先走工具分支就不会生成待应答项，UI 又会卡住
  const pending = normalizePending(payload)
  if (pending) {
    const merged = mergePending(message.pending, pending)
    const sameInteraction = message.pending?.toolCallId === merged.toolCallId
    const items = [...message.items]
    if (!sameInteraction) items.push({ kind: 'interaction' })
    return {
      ...message,
      pending: merged,
      items,
      // 换了新的交互时清掉上一次的应答回显
      answered: sameInteraction ? message.answered : undefined
    }
  }

  const toolFrame = pickToolFrame(payload)

  // 文件改动帧：把改动记录挂到对应的工具条目上（write_file/delete_file 的 diff 卡片）
  const fileChange = payload.fileChange
  if (fileChange?.toolCallId) {
    const tools = [...message.tools]
    const index = tools.findIndex((tool) => tool.id === fileChange.toolCallId)
    if (index >= 0) {
      tools[index] = { ...tools[index], change: fileChange }
      return { ...message, tools }
    }
  }

  if (toolFrame) {
    const [kind, raw] = toolFrame
    const normalized = normalizeTool(raw)
    const tools = [...message.tools]
    const index = normalized.id ? tools.findIndex((tool) => tool.id === normalized.id) : -1
    // ask_user 的呈现交给交互卡片，工具条目只做占位（保持 id 可被后续帧命中）
    const hidden = normalized.name === 'ask_user' ? { hidden: true } : {}

    if (kind === 'start') {
      const items = [...message.items]
      if (index >= 0) {
        tools[index] = { ...tools[index], ...normalized, state: 'running', ...hidden }
      } else {
        const id = normalized.id || newId()
        tools.push({
          id,
          name: normalized.name || '未命名工具',
          args: normalized.args || '',
          result: '',
          state: 'running',
          startedAt: Date.now(),
          ...hidden
        })
        items.push({ kind: 'tool', id })
      }
      return { ...message, tools, items }
    }

    // args 帧可能先于 start 帧到达（引擎侧顺序不保证），此时先占位。
    // 引擎的 __tool_args__ 携带的是流式**增量片段**，必须追加：覆盖会让参数
    // 只剩最后一个片段（曾出现参数只显示一个 "}" 的卡片）。
    // 完整参数随后会由 __tool_start__/__tool_call__ 整串覆盖，不会重复累积。
    if (kind === 'args') {
      if (index >= 0) {
        tools[index] = { ...tools[index], args: `${tools[index].args}${normalized.args ?? ''}` }
        return { ...message, tools }
      }
      // args 先于 start：此刻就是该工具真实开始的时间点，占位工具同步进时间线
      const id = normalized.id || newId()
      tools.push({
        id,
        name: normalized.name || '未命名工具',
        args: normalized.args || '',
        result: '',
        state: 'running',
        startedAt: Date.now(),
        ...hidden
      })
      return { ...message, tools, items: [...message.items, { kind: 'tool', id }] }
    }

    // end / result
    if (index >= 0) {
      tools[index] = finishTool(tools[index], raw)
      return { ...message, tools }
    }
    // 只有孤立的 end/result 帧：此刻才知道这个工具存在，补进时间线末尾
    const id = normalized.id || newId()
    tools.push(finishTool({
      id,
      name: normalized.name || '未命名工具',
      args: normalized.args || '',
      result: normalized.result || '',
      state: 'unknown'
    }, raw))
    return { ...message, tools, items: [...message.items, { kind: 'tool', id }] }
  }

  return message
}

function pickToolFrame(payload: ChatSsePayload): ['start' | 'args' | 'end', unknown] | null {
  if (payload.toolStart) return ['start', payload.toolStart]
  if (payload.toolCall) return ['start', payload.toolCall]
  if (payload.toolArgs) return ['args', payload.toolArgs]
  if (payload.toolEnd) return ['end', payload.toolEnd]
  if (payload.toolResult) return ['end', payload.toolResult]
  return null
}
