import type { JSX } from 'react'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { ComposerOptions } from '@renderer/contrib/chat/ComposerOptions'
import type { SessionThinkingMode } from '@renderer/contrib/chat/session-thinking-store'

/**
 * Work 输入区的轻量偏好入口。
 *
 * 长期记忆 / 思考档位 / 安全模式统一收进 ⚙ 弹层（ComposerOptions），
 * 工具条上不再单独放安全模式入口，避免与弹层里的设置重复。
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
