import type { RecoveryState } from '@renderer/core/engine/chat-recovery-loop'

export function sessionConnectionPresentation(options: {
  ready: boolean
  sessionId: string
  source: number
  connection: RecoveryState | null
  active: boolean
}): { label: string; busy: boolean; retry: boolean } | null {
  if (!options.ready) return { label: '引擎尚未就绪，可以先编辑草稿', busy: false, retry: false }
  const state = options.connection
  if (!state || state.scope?.source !== options.source || state.scope.sessionId !== options.sessionId) return null
  if (state.phase === 'blocked') return { label: '会话同步未完成，请检查连接后重试', busy: false, retry: true }
  if (state.phase !== 'connecting' && state.phase !== 'retrying') return null
  if (state.failures > 0) return {
    label: options.active ? '连接中断，正在恢复；任务状态待确认' : '正在重新连接并读取会话…',
    busy: true, retry: false
  }
  return { label: '正在读取会话…', busy: true, retry: false }
}
