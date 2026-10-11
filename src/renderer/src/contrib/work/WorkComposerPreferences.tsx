import type { JSX } from 'react'
import { SecurityModePicker } from '@renderer/contrib/security/SecurityModePicker'
import { useAppMode } from '@renderer/core/platform/app-mode'

/**
 * Work 输入区的轻量权限入口。
 *
 * Work 的安全选择与 Code 一样按「引擎端点 + 会话」保存；这里把入口放在
 * 输入区附近，用户第一次发送前就能看到并选择，而不必先找到设置页面。
 */
export function WorkComposerPreferences({
  sessionId,
  onManage
}: {
  sessionId: string | null
  onManage: () => void
}): JSX.Element | null {
  const mode = useAppMode()
  // Code and Work stay mounted for instant switching, but the security store
  // is session-scoped. Only the visible mode may refresh its session or the two
  // hidden composers would continuously overwrite each other's snapshot.
  if (!sessionId || mode !== 'work') return null
  return <SecurityModePicker sessionId={sessionId} onManage={onManage} />
}

