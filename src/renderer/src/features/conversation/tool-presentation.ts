import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import type { EngineFileChange } from '@shared/ipc'
import { mergeFileChanges } from '@renderer/core/engine/tool-file-changes'
import { toolPresentation } from './shared/tool-presentation'

export type SessionToolKind = 'subagent' | 'command' | 'file-change' | 'visual' | 'compact'

/** Supplements can finish a transcript segment while its root is still active.
 * UI visibility and a later task must never change this turn's preview policy. */
export function sessionMessageRunning(message: Pick<ChatMessage, 'run' | 'status'>): boolean {
  return message.run ? message.run.status === 'running' || message.run.status === 'waiting'
    : message.status === 'streaming' || message.status === 'waiting'
}

/** A tool can return both changed files and an image; neither receipt replaces the other. */
export function sessionToolHasImages(tool: ToolActivity): boolean {
  const result = toolPresentation(tool)
  return result.images.length > 0 || Boolean(result.browserSnapshots?.some(snapshot => snapshot.screenshot || snapshot.interaction?.screenshot))
}

/** Image receipts retain their preview renderer inside the process disclosure;
 * only ongoing collaboration and persistent commands need standalone cards. */
export function sessionToolKind(tool: ToolActivity): SessionToolKind {
  // A live supplement receipt confirms queued input; only a real invocation
  // supplies the child identity and result needed for a separate agent card.
  if (['subagent', 'subagent_start'].includes(tool.name) || tool.subagent || tool.subagentRef) return 'subagent'
  if (tool.commandJob) return 'command'
  if (tool.change || tool.changes?.length) return 'file-change'
  if (sessionToolHasImages(tool)) return 'visual'
  return 'compact'
}

export function isSessionStandaloneTool(tool: ToolActivity, turnRunning = true): boolean {
  const kind = sessionToolKind(tool)
  // Once the owning turn settles, command outcomes are process evidence.
  // Keeping them standalone bypasses the user's collapsed process disclosure.
  return kind === 'subagent' || kind === 'command' && turnRunning
}

/** Parent aggregation is valid only when the receipt names this child as its producer. */
export function sessionToolChanges(tool: Pick<ToolActivity, 'change' | 'changes'>, sessionId: string, receiptParentSessionId?: string): EngineFileChange[] {
  if (!sessionId) return []
  return mergeFileChanges([...(tool.change ? [tool.change] : []), ...(tool.changes ?? [])]
    .filter(change => !change.sessionId || change.sessionId === sessionId ||
      Boolean(receiptParentSessionId && change.sessionId === receiptParentSessionId && change.producerChildSessionId === sessionId)))
}

/** Keep exact wire text separate from readable previews, including invalid/partial JSON. */
export function sessionToolTechnicalFields(tool: Pick<ToolActivity, 'args' | 'result' | 'error'>): Array<{ key: string; label: string; raw: string }> {
  return [
    { key: 'args', label: '原始输入', raw: tool.args },
    { key: 'result', label: '原始输出', raw: tool.result },
    ...typeof tool.error === 'string' ? [{ key: 'error', label: '原始错误', raw: tool.error }] : []
  ]
}
