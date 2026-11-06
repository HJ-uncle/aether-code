import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import type { EngineFileChange } from '@shared/ipc'
import { mergeFileChanges } from '@renderer/core/engine/tool-file-changes'
import { toolPresentation } from '../chat/tool-presentation'

export type WorkToolKind = 'subagent' | 'command' | 'file-change' | 'visual' | 'compact'

/** Supplements can finish a transcript segment while its root is still active.
 * UI visibility and a later task must never change this turn's preview policy. */
export function workMessageRunning(message: Pick<ChatMessage, 'run' | 'status'>): boolean {
  return message.run ? message.run.status === 'running' || message.run.status === 'waiting'
    : message.status === 'streaming' || message.status === 'waiting'
}

/** A tool can return both changed files and an image; neither receipt replaces the other. */
export function workToolHasImages(tool: ToolActivity): boolean {
  const result = toolPresentation(tool)
  return result.images.length > 0 || Boolean(result.browserSnapshots?.some(snapshot => snapshot.screenshot || snapshot.interaction?.screenshot))
}

/** Image receipts retain their preview renderer inside the process disclosure;
 * only ongoing collaboration and persistent commands need standalone cards. */
export function workToolKind(tool: ToolActivity): WorkToolKind {
  if (tool.name === 'subagent' || tool.subagent || tool.subagentRef) return 'subagent'
  if (tool.commandJob) return 'command'
  if (tool.change || tool.changes?.length) return 'file-change'
  if (workToolHasImages(tool)) return 'visual'
  return 'compact'
}

export function isWorkStandaloneTool(tool: ToolActivity): boolean {
  const kind = workToolKind(tool)
  return kind === 'subagent' || kind === 'command'
}

/** Legacy receipts inherit the tool's session; explicit foreign owners never open here. */
export function workToolChanges(tool: Pick<ToolActivity, 'change' | 'changes'>, sessionId: string): EngineFileChange[] {
  if (!sessionId) return []
  return mergeFileChanges([...(tool.change ? [tool.change] : []), ...(tool.changes ?? [])]
    .filter(change => !change.sessionId || change.sessionId === sessionId))
}

/** Keep exact wire text separate from readable previews, including invalid/partial JSON. */
export function workToolTechnicalFields(tool: Pick<ToolActivity, 'args' | 'result' | 'error'>): Array<{ key: string; label: string; raw: string }> {
  return [
    { key: 'args', label: '原始输入', raw: tool.args },
    { key: 'result', label: '原始输出', raw: tool.result },
    ...typeof tool.error === 'string' ? [{ key: 'error', label: '原始错误', raw: tool.error }] : []
  ]
}
