/**
 * Shared rules for the completion marker shown by the Work navigation and the
 * native application icon. Keeping the formatting here prevents the renderer
 * and main process from drifting when the count grows beyond a single digit.
 */
export const TASKBAR_BADGE_MAX_COUNT = 99
export type TaskbarBadgeAppearance = 'dark' | 'light'

export function normalizeTaskbarBadgeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), TASKBAR_BADGE_MAX_COUNT)
}

export function taskbarBadgeText(value: number): string {
  const count = normalizeTaskbarBadgeCount(value)
  return count === TASKBAR_BADGE_MAX_COUNT ? '99+' : String(count)
}

/** Completed sessions use the same unread marker in Work and the native app icon. */
export function unreadCompletedTaskCount(tasks: ReadonlyArray<{
  status: string
  completionUnread?: boolean
  archived?: boolean
}>): number {
  return tasks.reduce((count, task) => count + (!task.archived && task.status === 'done' && task.completionUnread === true ? 1 : 0), 0)
}

