import type { JSX } from 'react'
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
  onThinkingChange
}: {
  sessionId: string | null
  modelId: string
  thinkingMode: SessionThinkingMode
  onThinkingChange: (mode: SessionThinkingMode) => void
}): JSX.Element | null {
  const mode = useAppMode()
  // Code and Work stay mounted for instant switching, but the security store
  // is session-scoped. Only the visible mode may refresh its session or the two
  // hidden composers would continuously overwrite each other's snapshot.
  if (!sessionId || mode !== 'work') return null
  return (
    <ComposerOptions owner="work" sessionId={sessionId} modelId={modelId} thinkingMode={thinkingMode} onThinkingChange={onThinkingChange} />
  )
}
