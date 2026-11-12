import type { JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { ComposerOptions } from '@renderer/features/conversation/shared/ComposerOptions'
import type { SessionThinkingMode } from '@renderer/features/conversation/shared/session-thinking-store'

/** 会话输入区共享偏好入口；低频设置逐步展开。 */
export function ComposerPreferences({
  sessionId,
  modelId,
  thinkingMode,
  workspacePath,
  home = false,
  onThinkingChange
}: {
  sessionId: string | null
  modelId: string
  thinkingMode: SessionThinkingMode
  workspacePath?: string
  home?: boolean
  onThinkingChange: (mode: SessionThinkingMode) => void
}): JSX.Element | null {
  const { settings, engine } = useApp()
  // New remote tasks inherit this default at creation. Existing tasks with no
  // explicit directory must keep their own session workspace instead.
  const indexPath = workspacePath || (home && engine.snapshot.mode === 'remote' ? settings.remoteWorkspaceRoot.trim() || undefined : undefined)
  // Security preferences always belong to a concrete session.
  if (!sessionId) return null
  return (
    <ComposerOptions sessionId={sessionId} workspacePath={indexPath} modelId={modelId} thinkingMode={thinkingMode} onThinkingChange={onThinkingChange} />
  )
}
