import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { commandInvocation } from '@renderer/core/engine/tool-feedback'
import { commandJobInvocation } from '@renderer/core/engine/command-job-state'
import { splitAssistantReasoning } from '@renderer/core/engine/assistant-reasoning'
import { isWorkStandaloneTool, workToolKind } from './work-tool-presentation'
import { toolPresentation } from '../chat/tool-presentation'
import { batchFileSummary } from '../chat/tool-file-args'
import { subagentWaitSummary } from '../chat/subagent-wait-summary'

export type WorkMessageSegment =
  | { kind: 'followup'; key: string; message: ChatMessage }
  | { kind: 'content'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tools'; key: string; tools: ToolActivity[] }

type WorkCardSegment =
  | { kind: 'tool'; key: string; tool: ToolActivity }
  | { kind: 'collaboration'; key: string; tools: ToolActivity[] }

export type WorkPresentationSegment =
  | { kind: 'process'; key: string; segments: Array<WorkMessageSegment | WorkCardSegment> }
  | WorkCardSegment
  | { kind: 'content'; key: string; text: string }
  | { kind: 'answer'; key: string; text: string }

export type WorkCollaborationMembership = ReadonlyMap<string, string>

/** A child transcript is a reading surface: all prose stays in chronological
 * order, while tool output and reasoning mount only after disclosure. */
export function workTranscriptPresentation(segments: readonly WorkMessageSegment[]): WorkPresentationSegment[] {
  const result: WorkPresentationSegment[] = []
  for (const segment of segments) {
    if (segment.kind === 'content') {
      if (segment.text.trim()) result.push({ kind: 'answer', key: segment.key, text: segment.text })
    } else {
      if (segment.kind === 'thinking' && !segment.text.trim()) continue
      const previous = result.at(-1)
      if (previous?.kind === 'process') previous.segments.push(segment)
      else result.push({ kind: 'process', key: segment.key, segments: [segment] })
    }
  }
  return result
}

/** Freeze only the disclosure boundaries the user has started reading; receipt
 * objects and statuses still come from the latest message on every render. */
export function captureWorkCollaborationMembership(presentation: readonly WorkPresentationSegment[]): WorkCollaborationMembership {
  const membership = new Map<string, string>()
  for (const segment of presentation) {
    const items = segment.kind === 'process' ? segment.segments : [segment]
    for (const item of items) if (item.kind === 'collaboration') {
      for (const tool of item.tools) membership.set(tool.id, item.key)
    }
  }
  return membership
}

/** A tool-assisted turn is one chronological process, including its prose.
 * Only a published result or the legacy tail is presented as the answer;
 * ordinary text-only replies stay readable while they stream. */
export function workMessagePresentation(segments: WorkMessageSegment[], membership?: WorkCollaborationMembership,
  finalAnswer?: { text: string } | false, turnRunning = true): WorkPresentationSegment[] {
  // Filter after stream chunks have joined; trimming individual chunks would
  // remove the real separator in responses such as "hello" + " " + "world".
  segments = segments.filter(segment => segment.kind !== 'content' && segment.kind !== 'thinking' || segment.text.trim())
  const published = finalAnswer ? splitAssistantReasoning(finalAnswer.text) : undefined
  if (published) finalAnswer = { text: published.content }
  const lastContent = segments.findLast(segment => segment.kind === 'content')
  // Legacy completed turns may end in prose. A progress sentence followed by
  // another tool is never an answer, even when the transport has stopped.
  const final = finalAnswer === undefined && lastContent &&
    !segments.slice(segments.indexOf(lastContent) + 1).some(segment => segment.kind === 'tools') ? lastContent : undefined
  const processProse = Boolean(finalAnswer) || segments.some(segment =>
    segment.kind === 'tools' && segment.tools.length > 0 || segment.kind === 'followup')
  const result: WorkPresentationSegment[] = []
  const appendProcess = (segment: WorkMessageSegment): void => {
    const previous = result.at(-1)
    if (previous?.kind === 'process') previous.segments.push(segment)
    else result.push({ kind: 'process', key: segment.key, segments: [segment] })
  }
  for (const segment of segments) {
    if (finalAnswer && segment === lastContent && segment.kind === 'content' && finalAnswer.text && segment.text.endsWith(finalAnswer.text)) {
      const preceding = segment.text.slice(0, -finalAnswer.text.length).trimEnd()
      if (preceding) appendProcess({ ...segment, text: preceding })
    } else if (segment.kind === 'content' && segment === final) {
      result.push({ kind: 'answer', key: segment.key, text: segment.text })
    } else if (segment.kind === 'content') {
      if (processProse) appendProcess(segment)
      else result.push(segment)
    } else if (segment.kind === 'tools') {
      for (const tool of segment.tools) {
        if (isWorkStandaloneTool(tool, turnRunning)) result.push({ kind: 'tool', key: `tool:${tool.id}`, tool })
        else {
          const previous = result.at(-1)
          const last = previous?.kind === 'process' ? previous.segments.at(-1) : null
          if (last?.kind === 'tools') last.tools.push(tool)
          else appendProcess({ kind: 'tools', key: `tool:${tool.id}`, tools: [tool] })
        }
      }
    } else appendProcess(segment)
  }
  if (published?.thinking && !segments.some(segment => segment.kind === 'thinking' && segment.text.includes(published.thinking))) {
    appendProcess({ kind: 'thinking', key: 'final-result-thinking', text: published.thinking })
  }
  if (finalAnswer && finalAnswer.text) result.push({ kind: 'answer', key: 'final-result', text: finalAnswer.text })
  // Completed collaboration is reference material. Keep its original position,
  // but don't let a long batch displace the answer or still-active work.
  const compact: WorkPresentationSegment[] = []
  for (let index = 0; index < result.length; index++) {
    const item = result[index]
    if (item.kind !== 'tool' || item.tool.subagent?.status !== 'succeeded' || membership && !membership.has(item.tool.id)) {
      compact.push(item)
      continue
    }
    const completed = [item.tool]
    const group = membership?.get(item.tool.id)
    while (index + 1 < result.length) {
      const next = result[index + 1]
      if (next.kind !== 'tool' || next.tool.subagent?.status !== 'succeeded' || membership && membership.get(next.tool.id) !== group) break
      completed.push(next.tool)
      index++
    }
    compact.push(completed.length > 1 ? { kind: 'collaboration', key: item.key, tools: completed } : item)
  }
  // Collaboration is part of the work that produced the answer. Retain its
  // disclosure boundaries, but let the owning process hide every child card.
  const scoped: WorkPresentationSegment[] = []
  for (const item of compact) {
    const process = item.kind === 'process' ? item.segments
      : item.kind === 'collaboration' || item.kind === 'tool' && workToolKind(item.tool) === 'subagent' ? [item] : undefined
    if (!process) { scoped.push(item); continue }
    const previous = scoped.at(-1)
    if (previous?.kind === 'process') previous.segments.push(...process)
    else scoped.push({ kind: 'process', key: item.key, segments: [...process] })
  }
  return scoped
}

/** Preserve the engine's chronology; grouped receipts must never move ahead of earlier prose. */
export function workMessageTimeline(message: ChatMessage): WorkMessageSegment[] {
  if (message.role === 'user') return message.content ? [{ kind: 'content', key: 'content', text: message.content }] : []
  const segments: WorkMessageSegment[] = []
  const tools = new Map(message.tools.filter(isVisibleToolActivity).map(tool => [tool.id, tool]))
  const seen = new Set<string>()
  const appendTool = (tool: ToolActivity): void => {
    if (seen.has(tool.id)) return
    seen.add(tool.id)
    const last = segments.at(-1)
    if (last?.kind === 'tools') last.tools.push(tool)
    else segments.push({ kind: 'tools', key: `tool:${tool.id}`, tools: [tool] })
  }
  for (const [index, item] of (message.items ?? []).entries()) {
    if ((item.kind === 'content' || item.kind === 'thinking') && item.text) {
      const last = segments.at(-1)
      if (last?.kind === item.kind) last.text += item.text
      else segments.push({ kind: item.kind, key: `${item.kind}:${index}`, text: item.text })
    } else if (item.kind === 'tool') {
      const tool = tools.get(item.id)
      if (tool) appendTool(tool)
    }
  }
  if (!segments.some(segment => segment.kind === 'thinking') && message.thinking?.trim()) {
    segments.unshift({ kind: 'thinking', key: 'thinking', text: message.thinking })
  }
  // Older persisted messages may have no timeline. Retain their receipts and
  // final content, without repeating the aggregate text on current messages.
  for (const tool of tools.values()) appendTool(tool)
  if (!segments.some(segment => segment.kind === 'content') && message.content) {
    segments.push({ kind: 'content', key: 'content', text: message.content })
  }
  return segments.flatMap(segment => {
    if (segment.kind !== 'content') return segment.kind === 'thinking' && !segment.text.trim() ? [] : [segment]
    const parsed = splitAssistantReasoning(segment.text, message.status === 'streaming')
    const normalized: WorkMessageSegment[] = []
    if (parsed.thinking) normalized.push({ kind: 'thinking', key: `${segment.key}:thinking`, text: parsed.thinking })
    if (parsed.content.trim()) normalized.push({ ...segment, text: parsed.content })
    return normalized
  })
}

function browserPageTarget(value: string): string {
  try {
    const url = new URL(value)
    // Capability origins and encoded local paths are internal routing,
    // not useful names for an office-facing browser operation.
    if (url.protocol === 'file:' || url.protocol === 'aether-local:') {
      const name = url.pathname.split('/').filter(Boolean).at(-1)
      return name ? decodeURIComponent(name) : '本地页面'
    }
    return url.hostname || '浏览器页面'
  } catch { return '浏览器页面' }
}

/** Shorten only paths owned by this project. Keep external paths and ambiguous
 * dot segments intact so a receipt never suggests it operated inside the project. */
function projectPathTarget(value: string, workspacePath?: string | null): string {
  if (!workspacePath?.trim() || /^[a-z]:(?![\\/])/i.test(value)) return value
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = normalize(workspacePath.trim())
  const target = normalize(value)
  if (!root && target.startsWith('//')) return value
  const windows = /^[a-z]:/i.test(root) || root.startsWith('//')
  const key = (path: string): string => windows ? path.toLowerCase() : path
  const name = /^[a-z]:$/i.test(root) ? `${root}/` : root.split('/').at(-1) || '/'
  if (target === '.') return name
  if ([root, target].some(path => path.split('/').some(part => part === '.' || part === '..'))) return value
  if (key(target) === key(root)) return name
  if (key(target).startsWith(`${key(root)}/`)) return target.slice(root.length + 1)
  return value
}

/** Show recognizable work targets without flashing partial JSON during argument streaming. */
export function workToolTarget(tool: ToolActivity, workspacePath?: string | null, full = false): string {
  if (tool.name === 'subagent_wait') return subagentWaitSummary(tool.args)
  // The executable alone is often only cmd.exe or PowerShell. The invocation
  // keeps its separate argv so readers can identify what actually ran.
  const invocation = tool.commandJob ? commandJobInvocation(tool.commandJob)
    : ['execute_cmd', 'run_command', 'execute_command'].includes(tool.name) ? commandInvocation(tool.args) : undefined
  if (invocation) {
    if (full) return invocation
    const target = invocation.replace(/\s+/g, ' ').trim()
    return target.length > 180 ? `${target.slice(0, 177)}…` : target
  }
  if (tool.name.startsWith('browser_')) {
    const snapshot = toolPresentation(tool).browserSnapshots?.[0]
    const title = snapshot?.title.trim()
    if (full && snapshot) return [title, snapshot.url].filter(Boolean).join('\n')
    if (title && title !== snapshot?.url && !/^(?:[a-z][a-z\d+.-]*:\/\/|file:|aether-local:)/i.test(title)) {
      return title.length > 80 ? `${title.slice(0, 77)}…` : title
    }
    if (snapshot?.url) return browserPageTarget(snapshot.url)
  }
  try {
    const args: unknown = JSON.parse(tool.args)
    if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
    const fields = args as Record<string, unknown>
    if (Object.hasOwn(fields, 'files')) {
      const summary = batchFileSummary(fields)
      return full && summary && Array.isArray(fields.files)
        ? fields.files.map(file => (file as { path: string }).path).join('\n') : summary ?? ''
    }
    for (const field of ['path', 'filePath', 'file_path', 'file', 'command', 'pattern', 'query', 'url', 'description', 'task', 'title', 'skill', 'name']) {
      const value = fields[field]
      if (typeof value !== 'string' || !value.trim()) continue
      if (full) return value.trim()
      const pathField = ['path', 'filePath', 'file_path', 'file'].includes(field)
      const target = pathField ? projectPathTarget(value.trim(), workspacePath) : value.trim().replace(/\s+/g, ' ')
      if (tool.name.startsWith('browser_') && field === 'url') {
        return browserPageTarget(target)
      }
      return target.length > 180 ? `${target.slice(0, 177)}…` : target
    }
  } catch { /* Argument chunks are incomplete until the engine finishes emitting JSON. */ }
  return ''
}
