import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { IconName } from '@renderer/ui/icons'
import { activateCommandSession, cancelCommandJob, deactivateCommandSession, getCommandJobs, ingestCommandJob, isCommandJobDeleted, refreshCommandJobs, subscribeCommandJobs } from '@renderer/core/engine/command-job-store'
import { commandJobDisplayLabel, commandJobInvocation } from '@renderer/core/engine/command-job-state'
import { subscribeSubagents, getSubagentRuns } from '@renderer/core/engine/subagent-store'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { getGitActivity, subscribeGitActivity } from '@renderer/core/git/git-activity'
import { sessionSubagentGroups, sessionSubagentStats, formatSessionSubagentDuration } from '../collaboration/subagents'
import { useExtensionServices } from '../extensions'
import { buildServiceItems, getHistoryServiceItems, getSessionServiceItems, type ServiceItem } from './service-model'
import { getActivityHistory, rememberServiceHistory, subscribeActivityHistory } from './activity-history'
import { useServiceTrayContext } from './tray-context'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'

export type WorkspaceActivityKind = 'subagent' | 'terminal' | 'git' | 'service'

/** One compact row in the workspace activity card. */
export interface WorkspaceActivityItem {
  id: string
  kind: WorkspaceActivityKind
  label: string
  detail: string
  statusLabel: string
  icon: IconName
  updatedAt: number
  tone?: ServiceItem['tone']
  open?: () => void | Promise<void>
  stop?: () => void | Promise<void>
  copyText?: string
}

/**
 * The workspace entry owns session tracking even while its popover and terminal
 * are closed. Removing a duplicate button must not remove lifecycle updates.
 */
export function useWorkspaceActivity(sessionId: string | null): {
  activities: readonly WorkspaceActivityItem[]
  history: readonly WorkspaceActivityItem[]
} {
  const { ready } = useApp()
  const visible = useWorkbenchVisible()
  const tray = useServiceTrayContext()
  const owner = `workspace-activity:${useId()}`
  const contributions = useExtensionServices({ sessionId })
  const persisted = useSyncExternalStore(subscribeActivityHistory, getActivityHistory)
  const [, redraw] = useState(0)

  useEffect(() => subscribeCommandJobs(() => redraw(value => value + 1)), [])
  useEffect(() => subscribeSubagents(() => redraw(value => value + 1)), [])
  useEffect(() => subscribeGitActivity(() => redraw(value => value + 1)), [])

  const jobs = [...tray.jobs, ...getCommandJobs(sessionId)]
    .filter(job => job.sessionId === sessionId && !isCommandJobDeleted(job.sessionId, job.jobId))
  const sessionItems = getSessionServiceItems(buildServiceItems(jobs, sessionId ?? '', contributions), sessionId)
    .filter(item => !item.contribution?.notification)
  const serviceItems = sessionItems.filter(item => item.active)
  const liveHistory = getHistoryServiceItems(sessionItems)
  const runningCommands = serviceItems.some(item => item.kind === 'command')

  useLayoutEffect(() => {
    if (!sessionId) return
    activateCommandSession(sessionId, owner)
    return () => deactivateCommandSession(owner)
  }, [sessionId, owner])
  useEffect(() => {
    for (const job of tray.jobs) if (job.sessionId === sessionId && job.background) ingestCommandJob(job)
  }, [sessionId, tray.jobs])
  useEffect(() => {
    for (const item of liveHistory) rememberServiceHistory(item, sessionId)
  }, [sessionId, liveHistory])
  useEffect(() => {
    if (!sessionId || !ready || !visible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try { await refreshCommandJobs(sessionId) } catch { /* A temporary disconnect must not erase the last known state. */ }
      if (!disposed && runningCommands) timer = setTimeout(() => { void refresh() }, 2000)
    }
    void refresh()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [sessionId, ready, visible, runningCommands])

  if (!sessionId) return { activities: [], history: [] }

  const liveIds = new Set(sessionItems.map(item => item.id))
  const history: WorkspaceActivityItem[] = [
    ...liveHistory.map(item => serviceItemToActivity(item, tray)),
    ...persisted.filter(entry => entry.kind === 'service' && entry.sessionId === sessionId && !liveIds.has(entry.id)
      && !(entry.id.startsWith('command:') && isCommandJobDeleted(sessionId, entry.id.slice('command:'.length))))
      .map(entry => ({ id: entry.id, kind: entry.id.startsWith('command:') ? 'terminal' as const : 'service' as const,
        label: entry.label, detail: entry.detail, statusLabel: entry.statusLabel, updatedAt: entry.updatedAt,
        tone: entry.tone, icon: entry.id.startsWith('command:') ? 'terminal' as const : 'plug' as const }))
  ].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  const items: WorkspaceActivityItem[] = serviceItems.map(item => serviceItemToActivity(item, tray))

  for (const group of sessionSubagentGroups(sessionId, tray.tools, getSubagentRuns(sessionId)).filter(group => group.active)) {
    const stats = sessionSubagentStats(group)
    items.push({
      id: `subagent:${group.key}`,
      kind: 'subagent',
      label: group.label,
      detail: stats.latestTool ? `正在${toolDisplayName(stats.latestTool.name)}` : '正在执行任务',
      statusLabel: formatSessionSubagentDuration(stats.durationMs) ?? '进行中',
      icon: 'account-outline',
      updatedAt: stats.updatedAt ?? stats.startedAt ?? Date.now(),
      open: tray.onOpenSubagents
    })
  }

  const git = getGitActivity(sessionId)
  if (git) items.push({
    id: `git:${sessionId}`,
    kind: 'git',
    label: git.label,
    detail: git.detail,
    statusLabel: git.statusLabel ?? '进行中',
    icon: 'git',
    updatedAt: git.updatedAt,
    open: tray.onOpenGit
  })

  return { activities: items.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)), history }
}

function serviceItemToActivity(item: ServiceItem, tray: ReturnType<typeof useServiceTrayContext>): WorkspaceActivityItem {
  if (item.kind === 'command' && item.job) {
    return {
      id: item.id,
      kind: 'terminal',
      label: item.label,
      detail: item.detail,
      statusLabel: commandJobDisplayLabel(item.job),
      icon: 'terminal',
      updatedAt: item.updatedAt,
      tone: item.tone,
      open: item.job ? () => tray.onOpenTerminal?.(item.job?.jobId) : undefined,
      stop: item.job.status === 'running' ? () => cancelCommandJob(item.job!.sessionId, item.job!.jobId).then(() => undefined) : undefined,
      copyText: commandJobInvocation(item.job)
    }
  }
  return {
    id: item.id,
    kind: 'service',
    label: item.label,
    detail: item.detail,
    statusLabel: item.statusLabel,
    icon: item.icon ?? 'plug',
    updatedAt: item.updatedAt,
    tone: item.tone,
    open: item.contribution?.open,
    stop: item.contribution?.stop
  }
}

