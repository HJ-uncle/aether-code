import type { StreamRecoveryReason } from '@shared/stream-event'
import type { RecoveryState } from './chat-recovery-loop'

export interface StreamRecoveryNotice { reason: StreamRecoveryReason; restored: boolean }

/** A restored snapshot and a reattached live connection are different observations. */
export function streamRecoveryNoticeText(notice: StreamRecoveryNotice | null, state: Pick<RecoveryState, 'phase' | 'failures'>): string | null {
  if (!notice) return null
  if (state.phase === 'blocked') return '实时更新同步未完成，请检查连接或登录状态后重新加载。'
  if (state.phase === 'retrying' && state.failures > 0) return notice.restored
    ? '会话快照已恢复，实时连接中断，正在重试。'
    : '暂时无法读取恢复快照，正在重试。'
  if (notice.restored) return state.phase === 'connecting'
    ? '会话快照已恢复，正在重新连接实时更新。'
    : '实时更新已从引擎快照恢复。'
  const cause = notice.reason === 'child-gap' ? '实时协作事件存在缺口'
    : notice.reason === 'invalid-event' ? '实时更新包含无法解析的事件'
      : notice.reason === 'stream-changed' ? '实时更新的运行身份发生变化'
        : notice.reason === 'invalid-cursor' ? '实时更新的恢复游标无效'
          : '实时更新发生缺口'
  return `${cause}，正在从引擎快照重新同步。`
}
