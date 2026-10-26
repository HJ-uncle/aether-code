import type { WorkTask } from './work-state'

/** Return live Work tasks in the order a run switcher should present them. */
export function getRunningWorkTasks(tasks: readonly WorkTask[]): WorkTask[] {
  return tasks
    .filter((task) => !task.archived && (task.status === 'running' || task.status === 'waiting'))
    .sort((left, right) => {
      const statusOrder = (status: WorkTask['status']): number => (status === 'running' ? 0 : 1)
      // Do not sort by updatedAt: status polling and streamed progress update
      // that field, which would make the visible list jump on every heartbeat.
      const leftStart = left.runStartedAt ?? left.createdAt
      const rightStart = right.runStartedAt ?? right.createdAt
      return (
        statusOrder(left.status) - statusOrder(right.status) ||
        leftStart - rightStart || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )
    })
}
