import { workTaskStatusFromRun, type WorkRunStatus } from './work-status-poller'
import type { WorkTaskStatus } from './work-state'

type CancelStatus = WorkRunStatus & { run?: { sessionId: string; runId: string; status: string } }

/** Capture the owned run before cancelling; an HTTP receipt alone is not a terminal state. */
export async function cancelWorkTask(options: {
  sessionId: string
  readStatus: () => Promise<CancelStatus>
  cancel: (body: { sessionId: string; runId: string }) => Promise<unknown>
  isCurrent: () => boolean
}): Promise<WorkTaskStatus> {
  const assertCurrent = (): void => {
    if (!options.isCurrent()) throw new Error('任务或引擎连接已变化，请在当前任务中重试')
  }
  const read = async (): Promise<CancelStatus> => {
    const status = await options.readStatus()
    assertCurrent()
    if (!status.run?.runId || status.run.sessionId !== options.sessionId ||
      !['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(status.run.status)) {
      throw new Error('尚未确认此任务的运行状态，请恢复连接后重试停止')
    }
    return status
  }
  assertCurrent()
  const before = await read()
  if (!['running', 'waiting'].includes(before.run!.status)) return workTaskStatusFromRun(before, 'interrupted')
  await options.cancel({ sessionId: options.sessionId, runId: before.run!.runId })
  assertCurrent()
  const after = await read()
  if (after.run!.runId === before.run!.runId && ['running', 'waiting'].includes(after.run!.status)) {
    throw new Error('任务尚未确认停止，可以稍后重试；当前运行状态已保留')
  }
  return workTaskStatusFromRun(after, 'interrupted')
}
