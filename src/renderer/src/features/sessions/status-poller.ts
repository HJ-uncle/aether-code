import { normalizeRootRunActivity, type RootRunStatus } from '@shared/root-run'
import type { SessionTaskActivity, TaskStatus } from './state'

export interface SessionStatusTask {
  id: string; status: TaskStatus; updatedAt: number; activity?: SessionTaskActivity
  archived?: boolean; pinned?: boolean; runStartedAt?: number
}
export interface SessionRunStatus {
  run?: { schemaVersion?: number; sessionId?: string; runId?: string; seq?: number; version?: number; status?: string
    updatedAt?: number; startedAt?: number; createdAt?: number; pending?: unknown; activity?: unknown }
  finished?: boolean; running?: boolean
}
const rootStatuses: readonly RootRunStatus[] = ['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']
const active = (status: TaskStatus | RootRunStatus): boolean => status === 'running' || status === 'waiting'
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Strip persisted/transport data to bounded scalar state, never question text. */
export function normalizeSessionTaskActivity(value: unknown): SessionTaskActivity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as SessionTaskActivity
  if (typeof item.runId !== 'string' || !item.runId.trim() || !count(item.seq) || !count(item.version) || item.version < 1 ||
    !rootStatuses.includes(item.status) || !timestamp(item.updatedAt) || !count(item.pendingAsk) || !count(item.pendingPermission)) return undefined
  return { runId: item.runId, seq: item.seq, version: item.version, status: item.status, updatedAt: item.updatedAt,
    pendingAsk: item.status === 'waiting' ? item.pendingAsk : 0, pendingPermission: item.status === 'waiting' ? item.pendingPermission : 0,
    execution: item.status === 'running' ? normalizeRootRunActivity(item.execution) : undefined }
}

export function sessionTaskActivityFromRun(response: SessionRunStatus, sessionId: string): SessionTaskActivity | undefined {
  const run = response.run
  if (!run || run.schemaVersion !== 1 || run.sessionId !== sessionId || !Array.isArray(run.pending)) return undefined
  let pendingAsk = 0, pendingPermission = 0
  for (const item of run.pending) {
    if (!item || typeof item !== 'object' || (item.kind !== 'ask' && item.kind !== 'permission') ||
      (item.status !== 'pending' && item.status !== 'answered')) return undefined
    if (item.status === 'pending') { if (item.kind === 'ask') pendingAsk++; else pendingPermission++ }
  }
  return normalizeSessionTaskActivity({ ...run, pendingAsk, pendingPermission, execution: run.activity })
}

export function sameSessionTaskActivity(left: SessionTaskActivity | undefined, right: SessionTaskActivity | undefined): boolean {
  return left === right || Boolean(left && right && left.runId === right.runId && left.seq === right.seq && left.version === right.version &&
    left.status === right.status && left.updatedAt === right.updatedAt && left.pendingAsk === right.pendingAsk && left.pendingPermission === right.pendingPermission &&
    JSON.stringify(left.execution) === JSON.stringify(right.execution))
}

/** Session sequence orders roots; version orders observations of one root. */
export function acceptSessionTaskActivity(previous: SessionTaskActivity | undefined, next: SessionTaskActivity): boolean {
  if (!previous) return true
  if (previous.runId !== next.runId) return next.seq > previous.seq
  if (next.seq !== previous.seq || next.version < previous.version) return false
  if (!active(previous.status) && active(next.status)) return false
  // Version is the execution watermark even if the server wall clock moves
  // backwards. Equal versions may only fill waiting metadata for that state.
  return next.version > previous.version || next.status === previous.status && next.updatedAt === previous.updatedAt
}

export interface SessionTaskAdmission { previousRunId?: string; previousRunSeq?: number; admitted: boolean }
export function sessionTaskRunAdmitted(activity: SessionTaskActivity, admission: SessionTaskAdmission): boolean {
  return admission.admitted || activity.runId !== admission.previousRunId &&
    (admission.previousRunSeq === undefined || activity.seq > admission.previousRunSeq)
}

export function sessionTaskRunPatch(task: SessionStatusTask, response: SessionRunStatus, now: number, admission?: SessionTaskAdmission):
  { status: TaskStatus; activity: SessionTaskActivity; updatedAt: number; runStartedAt: number | undefined } | undefined {
  const activity = sessionTaskActivityFromRun(response, task.id)
  if (!activity || admission && !sessionTaskRunAdmitted(activity, admission) || !acceptSessionTaskActivity(task.activity, activity)) return undefined
  const status = sessionTaskStatusFromRun(response, task.status)
  if (sameSessionTaskActivity(task.activity, activity) && status === task.status) return undefined
  const run = response.run!
  const startedAt = timestamp(run.startedAt) ? run.startedAt : timestamp(run.createdAt) ? run.createdAt : now
  return { status, activity, updatedAt: Math.max(task.updatedAt, activity.updatedAt),
    runStartedAt: active(status) ? task.activity?.runId === activity.runId ? task.runStartedAt ?? startedAt : startedAt : undefined }
}

/** Discovery is separate from live polling: at most two idle rows per pass,
 * with a per-row cooldown and rotation so old tasks cannot starve. */
export function createSessionStatusDiscovery(): {
  take(tasks: readonly SessionStatusTask[], shouldPoll: (task: SessionStatusTask) => boolean, now: number): SessionStatusTask[]
  record(id: string, now: number): void
} {
  const checked = new Map<string, number>()
  return {
    record: (id, now) => { checked.set(id, now) },
    take(tasks, shouldPoll, now) {
      const ids = new Set(tasks.map(task => task.id))
      for (const id of checked.keys()) if (!ids.has(id)) checked.delete(id)
      const ordered = tasks.filter(task => !task.archived).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (b.runStartedAt ?? b.updatedAt) - (a.runStartedAt ?? a.updatedAt))
      const priority = new Set(ordered.slice(0, 6).map(task => task.id))
      return ordered.filter(task => !active(task.status) && shouldPoll(task) &&
        (!checked.has(task.id) || now - checked.get(task.id)! >= 15000))
        .sort((a, b) => (checked.get(a.id) ?? -Infinity) - (checked.get(b.id) ?? -Infinity) ||
          Number(priority.has(b.id)) - Number(priority.has(a.id)))
        .slice(0, 2)
    }
  }
}
export function sessionTaskStatusFromRun(run: SessionRunStatus, fallback: TaskStatus): TaskStatus {
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
export async function pollSessionTaskStatuses(options: {
  tasks: () => SessionStatusTask[]
  revision: (id: string) => number
  shouldPoll: (task: SessionStatusTask) => boolean
  isCurrent: () => boolean
  request: (id: string) => Promise<SessionRunStatus>
  apply: (id: string, status: TaskStatus, activity: SessionTaskActivity, response: SessionRunStatus) => void
  concurrency?: number
  discovery?: ReturnType<typeof createSessionStatusDiscovery>
  now?: () => number
}): Promise<void> {
  const now = options.now ?? Date.now
  const tasks = options.tasks()
  const candidates = [...tasks.filter(task => active(task.status) && options.shouldPoll(task)),
    ...(options.discovery?.take(tasks, options.shouldPoll, now()) ?? [])]
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (options.isCurrent() && cursor < candidates.length) {
      const captured = candidates[cursor++]
      if (!options.shouldPoll(captured)) continue
      const revision = options.revision(captured.id)
      try {
        options.discovery?.record(captured.id, now())
        const response = await options.request(captured.id)
        if (!options.isCurrent() || revision !== options.revision(captured.id)) continue
        const latest = options.tasks().find(task => task.id === captured.id)
        if (!latest || latest.status !== captured.status || latest.updatedAt !== captured.updatedAt || !options.shouldPoll(latest)) continue
        if (!sameSessionTaskActivity(latest.activity, captured.activity)) continue
        const patch = sessionTaskRunPatch(latest, response, now())
        if (patch) options.apply(latest.id, patch.status, patch.activity, response)
      } catch {
        // A failed background probe must not fabricate a terminal state.
      }
    }
  }
  const concurrency = Math.max(1, Math.min(2, Math.floor(options.concurrency ?? 2)))
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
}
