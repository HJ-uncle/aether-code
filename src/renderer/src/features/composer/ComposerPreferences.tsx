import type { JSX } from 'react'
import { ComposerOptions } from '@renderer/features/conversation/shared/ComposerOptions'
import type { SessionThinkingMode } from '@renderer/features/conversation/shared/session-thinking-store'

/** 会话输入区共享偏好入口；低频设置逐步展开。 */
export function ComposerPreferences({
  sessionId,
  modelId,
  thinkingMode,
  workspacePath,
  onThinkingChange
}: {
  sessionId: string | null
  modelId: string
  thinkingMode: SessionThinkingMode
  workspacePath?: string
  onThinkingChange: (mode: SessionThinkingMode) => void
}): JSX.Element | null {
  // Security preferences always belong to a concrete session.
  if (!sessionId) return null
  return (
    <ComposerOptions sessionId={sessionId} workspacePath={workspacePath} modelId={modelId} thinkingMode={thinkingMode} onThinkingChange={onThinkingChange} />
  )
}
