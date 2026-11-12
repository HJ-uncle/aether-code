import type { SessionTask } from '../sessions/state'

/** A completion is new execution, not a rename, draft save, or newer snapshot
 * of the same result. Legacy completed tasks start read until another run ends. */
export function trackSessionTaskCompletion(previous: SessionTask | undefined, next: SessionTask): SessionTask {
  if (previous === next) return next
  const newRun = next.activity?.status === 'succeeded' && previous?.activity &&
    next.activity.runId !== previous.activity.runId && next.activity.seq > previous.activity.seq
  const newlyCompleted = next.status === 'done' && (!previous || previous.status !== 'done' || newRun)
  const unread = next.status === 'done' && Boolean(newlyCompleted || next.completionUnread)
  if (Boolean(next.completionUnread) === unread) return next
  return { ...next, completionUnread: unread || undefined }
}
