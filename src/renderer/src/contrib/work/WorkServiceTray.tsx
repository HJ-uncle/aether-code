import { useMemo, type JSX } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import { commandJobActive, mergeCommandJob } from '@renderer/core/engine/command-job-state'
import { Icon } from '@renderer/workbench/icons'
import './work-service-tray.css'

interface WorkServiceTrayProps {
  sessionId: string
  jobs: CommandJobSnapshot[]
  active?: boolean
  placement?: 'heading' | 'rail'
  onOpenTerminal: () => void
}

export function partitionWorkServices(jobs: readonly CommandJobSnapshot[], sessionId: string): {
  running: CommandJobSnapshot[]
  history: CommandJobSnapshot[]
} {
  const byId = new Map<string, CommandJobSnapshot>()
  for (const job of jobs) {
    if (!job.background || job.sessionId !== sessionId) continue
    byId.set(job.jobId, mergeCommandJob(byId.get(job.jobId), job))
  }
  const services = [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  return { running: services.filter(commandJobActive), history: services.filter(job => !commandJobActive(job)) }
}

/** The run indicator opens the full terminal surface without covering the conversation. */
export function WorkServiceTray({ sessionId, jobs, active = true, placement = 'heading', onOpenTerminal }: WorkServiceTrayProps): JSX.Element {
  const { running } = useMemo(() => partitionWorkServices(jobs, sessionId), [jobs, sessionId])
  return <div className={`work-service-tray work-service-tray--${placement}`}>
    <button type="button" className="work-service-tray__button" disabled={!active}
      aria-label={running.length ? `查看后台运行，${running.length} 个运行中` : '查看后台运行'}
      title="在终端中查看后台运行" onClick={onOpenTerminal}>
      <Icon name="terminal" size={15} />
      <span className="work-service-tray__label">运行</span>
      {running.length ? <b aria-label={`${running.length} 个运行中的服务`}>{running.length}</b> : null}
    </button>
  </div>
}
