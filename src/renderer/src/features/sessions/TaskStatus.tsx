import type { JSX } from 'react'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import type { SessionTask, TaskStatus as Status } from './state'
import { sessionTaskWaitingStatus } from '../conversation/waiting-status'

const LABELS: Record<Status, string> = {
  draft: '草稿', running: '进行中', waiting: '待处理', done: '已完成',
  error: '执行失败', stopped: '已停止', interrupted: '连接中断'
}

export function TaskStatus({ task, ready }: { task: Pick<SessionTask, 'status' | 'activity'>; ready: boolean }): JSX.Element {
  const { status } = task
  const waiting = status === 'waiting' ? sessionTaskWaitingStatus(task) : undefined
  // A lost observer cannot assert whether the durable run has reached a terminal state.
  const disconnected = !ready && (status === 'running' || status === 'waiting')
  return (
    <span className={`work-status work-status--${disconnected ? 'interrupted' : status}`}
      title={disconnected ? '连接中断，等待恢复确认' : undefined}>
      {disconnected ? <Icon name="alert-circle" size={12} /> : status === 'running' ? (
        <Spinner size={12} />
      ) : (
        <Icon name={status === 'done' ? 'check' : status === 'error' || status === 'interrupted'
          ? 'alert-circle' : waiting?.icon ?? 'circle'} size={12} />
      )}
      {disconnected ? '连接中断' : waiting?.label ?? LABELS[status]}
    </span>
  )
}
