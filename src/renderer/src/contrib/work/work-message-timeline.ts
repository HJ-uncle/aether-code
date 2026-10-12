import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'

export type WorkMessageSegment =
  | { kind: 'content'; key: string; text: string }
  | { kind: 'tools'; key: string; tools: ToolActivity[] }

/** Preserve the engine's chronology; grouped receipts must never move ahead of earlier prose. */
export function workMessageTimeline(message: ChatMessage): WorkMessageSegment[] {
  if (message.role === 'user') return message.content ? [{ kind: 'content', key: 'content', text: message.content }] : []
  const segments: WorkMessageSegment[] = []
  const tools = new Map(message.tools.filter(tool => !tool.hidden).map(tool => [tool.id, tool]))
  const seen = new Set<string>()
  const appendTool = (tool: ToolActivity): void => {
    if (seen.has(tool.id)) return
    seen.add(tool.id)
    const last = segments.at(-1)
    if (last?.kind === 'tools') last.tools.push(tool)
    else segments.push({ kind: 'tools', key: `tool:${tool.id}`, tools: [tool] })
  }
  for (const [index, item] of (message.items ?? []).entries()) {
    if (item.kind === 'content' && item.text) {
      const last = segments.at(-1)
      if (last?.kind === 'content') last.text += item.text
      else segments.push({ kind: 'content', key: `content:${index}`, text: item.text })
    } else if (item.kind === 'tool') {
      const tool = tools.get(item.id)
      if (tool) appendTool(tool)
    }
  }
  // Older persisted messages may have no timeline. Retain their receipts and
  // final content, without repeating the aggregate text on current messages.
  for (const tool of tools.values()) appendTool(tool)
  if (!segments.some(segment => segment.kind === 'content') && message.content) {
    segments.push({ kind: 'content', key: 'content', text: message.content })
  }
  return segments
}

/** Show recognizable work targets without flashing partial JSON during argument streaming. */
export function workToolTarget(tool: ToolActivity, workspacePath?: string | null): string {
  try {
    const args: unknown = JSON.parse(tool.args)
    if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
    const fields = args as Record<string, unknown>
    for (const field of ['path', 'filePath', 'file_path', 'file', 'command', 'pattern', 'query', 'url', 'description', 'task', 'title', 'skill', 'name']) {
      const value = fields[field]
      if (typeof value !== 'string' || !value.trim()) continue
      let target = value.trim().replace(/\s+/g, ' ')
      const root = workspacePath?.replace(/\\/g, '/').replace(/\/$/, '')
      const normalized = target.replace(/\\/g, '/')
      if (root && normalized.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)) target = normalized.slice(root.length + 1)
      return target.length > 180 ? `${target.slice(0, 177)}…` : target
    }
  } catch { /* Argument chunks are incomplete until the engine finishes emitting JSON. */ }
  return ''
}
