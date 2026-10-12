import type { WorkTaskStatus } from './work-state'

export interface WorkStatusTask { id: string; status: WorkTaskStatus; updatedAt: number }
export interface WorkRunStatus { run?: { status?: string }; finished?: boolean; running?: boolean }
export function workTaskStatusFromRun(run: WorkRunStatus, fallback: WorkTaskStatus): WorkTaskStatus {
  switch (run.run?.status) {
    case 'running': return 'running'
    case 'waiting': return 'waiting'
    case 'cancelled': return 'stopped'
    case 'interrupted': return 'interrupted'
    case 'failed': return 'error'
    case 'succeeded': return 'done'
    default: return fallback
  }
}

/** Status requests are advisory. A navigation, SSE frame or user action wins over an older response. */
export async function pollWorkTaskStatuses(options: {
  tasks: () => WorkStatusTask[]
  revision: (id: string) => number
  shouldPoll: (task: WorkStatusTask) => boolean
  isCurrent: () => boolean
  request: (id: string) => Promise<WorkRunStatus>
  apply: (id: string, status: WorkTaskStatus) => void
  concurrency?: number
}): Promise<void> {
  const candidates = options.tasks().filter(task => ['running', 'waiting'].includes(task.status) && options.shouldPoll(task))
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (options.isCurrent() && cursor < candidates.length) {
      const captured = candidates[cursor++]
      if (!options.shouldPoll(captured)) continue
      const revision = options.revision(captured.id)
      try {
        const response = await options.request(captured.id)
        if (!options.isCurrent() || revision !== options.revision(captured.id)) continue
        const latest = options.tasks().find(task => task.id === captured.id)
        if (!latest || latest.status !== captured.status || latest.updatedAt !== captured.updatedAt || !options.shouldPoll(latest)) continue
        const status = workTaskStatusFromRun(response, latest.status)
        if (status !== latest.status) options.apply(latest.id, status)
      } catch {
        // A failed background probe must not fabricate a terminal state.
      }
    }
  }
  const concurrency = Math.max(1, Math.min(2, Math.floor(options.concurrency ?? 2)))
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
}
