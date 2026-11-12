import type { SessionTask } from '../sessions/state'

/** Waiting alone does not say what the user needs to do. All task surfaces
 * must use the same pending facts instead of guessing from the broad status. */
export function sessionWaitingStatus(pendingAsk = 0, pendingPermission = 0) {
  if (pendingPermission > 0) return {
    kind: 'permission' as const,
    label: pendingAsk > 0 ? '待授权与补充' : '待授权',
    icon: 'shield' as const
  }
  return { kind: 'question' as const, label: pendingAsk > 0 ? '等你补充' : '待处理', icon: 'chat' as const }
}

export function sessionTaskWaitingStatus(task: Pick<SessionTask, 'status' | 'activity'>) {
  const activity = task.status === 'waiting' && task.activity?.status === 'waiting' ? task.activity : undefined
  return sessionWaitingStatus(activity?.pendingAsk, activity?.pendingPermission)
}
