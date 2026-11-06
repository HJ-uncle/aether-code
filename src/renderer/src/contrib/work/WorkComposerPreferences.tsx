import type { JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { ComposerOptions } from '@renderer/contrib/chat/ComposerOptions'
import type { SessionThinkingMode } from '@renderer/contrib/chat/session-thinking-store'

/**
 * Work 输入区的轻量偏好入口。
 *
 * 复用两种模式同一偏好组件；当前访问权限始终可见，低频偏好逐步展开。
 */
export function WorkComposerPreferences({
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
  const mode = useAppMode()
  const { settings, engine } = useApp()
  // New remote tasks inherit this default at creation. Existing tasks with no
  // explicit directory must keep their own session workspace instead.
  const indexPath = workspacePath || (home && engine.snapshot.mode === 'remote' ? settings.remoteWorkspaceRoot.trim() || undefined : undefined)
  // Code and Work stay mounted for instant switching, but the security store
  // is session-scoped. Only the visible mode may refresh its session or the two
  // hidden composers would continuously overwrite each other's snapshot.
  if (!sessionId || mode !== 'work') return null
  return (
    <ComposerOptions owner="work" sessionId={sessionId} workspacePath={indexPath} modelId={modelId} thinkingMode={thinkingMode} onThinkingChange={onThinkingChange} />
  )
}
