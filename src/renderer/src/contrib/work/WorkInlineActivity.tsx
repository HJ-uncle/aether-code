import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { useMotionPresence } from '@renderer/workbench/MotionPresence'
import { useCollapseMemory } from '../chat/useCollapseMemory'
import type { ChatFileContext } from '../chat/chat-link'
import { workPageRange } from './work-view-performance'
import { WORK_INLINE_ACTIVITY_PAGE_SIZE, workActivitySummary } from './work-inline-activity-state'
import { WorkToolActivity } from './WorkToolActivity'
import { workToolTarget } from './work-message-timeline'
import { workActivityGroups } from './work-activity-groups'
import { getEngineSource } from '@renderer/core/engine/source'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { quietToolIcon } from '../chat/quiet-tool-icon'
import './work-inline-activity.css'

/** Keep paged receipts and their original diagnostics beside the conversation. */
export function WorkInlineActivity({ tools: receipts, fileContext, onOpenFile, onOpenChange, revealTool, expanded = false, contained = false, turnRunning, active = true, readOnly = false }: {
  tools: ToolActivity[]; fileContext: ChatFileContext; onOpenFile?: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  revealTool?: { toolId: string; revision: number } | null
  expanded?: boolean
  contained?: boolean
  turnRunning?: boolean
  active?: boolean
  readOnly?: boolean
}): JSX.Element | null {
  const tools = useMemo(() => receipts.filter(isVisibleToolActivity), [receipts])
  const [manual, setManual] = useCollapseMemory(`work-process:${fileContext.sessionId}:${tools[0]?.id}`)
  const [selectedPage, setSelectedPage] = useState<number | null>(null)
  const activity = useRef<HTMLElement>(null)
  const detailId = useId()
  const pageSize = contained ? 100 : WORK_INLINE_ACTIVITY_PAGE_SIZE
  const summary = useMemo(() => workActivitySummary(tools, fileContext.workspaceRoot), [tools, fileContext.workspaceRoot])
  useLayoutEffect(() => {
    if (!contained) return
    const viewport = activity.current?.closest('.work-message__process-viewport')
    const latest = (): void => setSelectedPage(Math.max(0, Math.ceil(tools.length / pageSize) - 1))
    viewport?.addEventListener('work-process-latest', latest)
    return () => viewport?.removeEventListener('work-process-latest', latest)
  }, [contained, tools.length, pageSize])
  useLayoutEffect(() => {
    if (!revealTool) return
    const index = tools.findIndex(tool => tool.id === revealTool.toolId)
    if (index < 0) return
    setManual(true)
    setSelectedPage(Math.floor(index / pageSize))
  }, [revealTool, tools, setManual, pageSize])
  const open = expanded || (manual ?? false)
  const presence = useMotionPresence(open)
  if (!summary) return null
  const { tool, state, label, target } = summary
  const fullTarget = workToolTarget(tool, undefined, true)
  // Open at the live operation, then retain that page while the user reads it.
  const defaultIndex = state === 'running' || state === 'waiting' ? tools.indexOf(tool) : tools.length - 1
  const range = workPageRange(tools.length, selectedPage ?? Math.floor(defaultIndex / pageSize), pageSize)
  const visible = tools.slice(range.start, range.end)
  const groups = contained && !turnRunning ? workActivityGroups(visible) : visible.map(tool => [tool])
  const renderTool = (item: ToolActivity): ReactNode => <WorkToolActivity key={item.id} tool={item} fileContext={fileContext}
    onOpenFile={onOpenFile} onOpenChange={onOpenChange} turnRunning={turnRunning} active={active && open} readOnly={readOnly}
    revealRevision={revealTool?.toolId === item.id ? revealTool.revision : undefined} />
  return (
    <section ref={activity} className={`work-inline-activity${expanded ? ' work-inline-activity--expanded' : ''}`} data-tool-count={tools.length}>
      {!expanded ? <button
        type="button"
        className={`work-process work-process--${state}`}
        title={`${label}${fullTarget ? ` · ${fullTarget}` : ''}，${open ? '收起' : '展开'}活动详情`}
        aria-label={`${label}${target ? ` · ${target}` : ''}，${open ? '收起' : '展开'}活动详情`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => {
          if (!open) setSelectedPage(range.page)
          setManual(!open)
        }}
      >
        {state === 'running' ? <Spinner size={14} /> : <Icon name={state === 'done' ? 'check' : state === 'error' || state === 'interrupted' ? 'alert-circle' : 'circle-dot'} size={14} />}
        <span className="work-process__label">{label}</span>
        {target ? <span className="work-process__target">{target}</span> : null}
        <Icon name="chevron-right" size={12} className="work-inline-activity__chevron" />
      </button> : null}
      {presence.present ? <div className="ui-motion-collapse" {...presence.motionProps}><div className="ui-motion-collapse__content">
        <div id={detailId} className="process__body work-inline-activity__body" role="region" aria-label="活动详情">
          {groups.map(group => (
            <div className="work-inline-activity__item" key={group[0].id}>
              {group.length > 1 ? <WorkActivityGroup tools={group} fileContext={fileContext} revealTool={revealTool}>
                {group.map(renderTool)}
              </WorkActivityGroup> : renderTool(group[0])}
            </div>
          ))}
          {range.pages > 1 ? (
            <nav className="work-inline-activity__pages" aria-label="活动分页">
              <button type="button" disabled={range.page === 0} onClick={() => setSelectedPage(range.page - 1)}>上一页</button>
              <span>{range.start + 1}–{range.end} / {tools.length}</span>
              <button type="button" disabled={range.page === range.pages - 1} onClick={() => setSelectedPage(range.page + 1)}>下一页</button>
              {range.page !== range.pages - 1 ? <button type="button" onClick={() => setSelectedPage(range.pages - 1)}>最新活动</button> : null}
            </nav>
          ) : null}
        </div>
      </div></div> : null}
    </section>
  )
}

function WorkActivityGroup({ tools, fileContext, revealTool, children }: {
  tools: ToolActivity[]; fileContext: ChatFileContext; children: ReactNode
  revealTool?: { toolId: string; revision: number } | null
}): JSX.Element {
  const first = tools[0], id = useId()
  const [memory, setOpen] = useCollapseMemory(`work-activity-group:${getEngineSource()}:${fileContext.sessionId}:${first.id}:settled`)
  const open = memory ?? false
  const consumed = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (!revealTool || consumed.current === revealTool.revision || !tools.some(tool => tool.id === revealTool.toolId)) return
    consumed.current = revealTool.revision
    setOpen(true)
  }, [revealTool, tools, setOpen])
  const label = toolDisplayName(first.name)
  const target = workToolTarget(first, fileContext.workspaceRoot)
  const presence = useMotionPresence(open)
  return <div className="work-activity-group" data-operation-count={tools.length}>
    <button type="button" className="work-activity-group__toggle" aria-expanded={open} aria-controls={id}
      aria-label={`${open ? '收起' : '展开'} ${label} · ${target} · ${tools.length} 次`}
      onClick={() => setOpen(!open)}>
      <Icon name={quietToolIcon(first.name)} size={14} />
      <span className="work-activity-group__label">{label}</span>
      <span className="work-activity-group__target" title={workToolTarget(first, undefined, true)}>{target}</span>
      <span className="work-activity-group__count">{tools.length} 次</span>
      <Icon name="chevron-right" size={12} className="work-activity-group__chevron" />
    </button>
    {presence.present ? <div className="ui-motion-collapse" {...presence.motionProps}><div className="ui-motion-collapse__content">
      <div id={id} className="work-activity-group__body">{children}</div>
    </div></div> : null}
  </div>
}
