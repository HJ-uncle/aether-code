import { useId, useLayoutEffect, useMemo, useState, type JSX } from 'react'
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
import './work-inline-activity.css'

/** Keep paged receipts and their original diagnostics beside the conversation. */
export function WorkInlineActivity({ tools: receipts, fileContext, onOpenFile, onOpenChange, revealTool, expanded = false, turnRunning, active = true }: {
  tools: ToolActivity[]; fileContext: ChatFileContext; onOpenFile?: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  revealTool?: { toolId: string; revision: number } | null
  expanded?: boolean
  turnRunning?: boolean
  active?: boolean
}): JSX.Element | null {
  const tools = useMemo(() => receipts.filter(isVisibleToolActivity), [receipts])
  const [manual, setManual] = useCollapseMemory(`work-process:${fileContext.sessionId}:${tools[0]?.id}`)
  const [selectedPage, setSelectedPage] = useState<number | null>(null)
  const detailId = useId()
  const summary = useMemo(() => workActivitySummary(tools, fileContext.workspaceRoot), [tools, fileContext.workspaceRoot])
  useLayoutEffect(() => {
    if (!revealTool) return
    const index = tools.findIndex(tool => tool.id === revealTool.toolId)
    if (index < 0) return
    setManual(true)
    setSelectedPage(Math.floor(index / WORK_INLINE_ACTIVITY_PAGE_SIZE))
  }, [revealTool, tools, setManual])
  const open = expanded || (manual ?? false)
  const presence = useMotionPresence(open)
  if (!summary) return null
  const { tool, state, label, target } = summary
  // Open at the live operation, then retain that page while the user reads it.
  const defaultIndex = state === 'running' || state === 'waiting' ? tools.indexOf(tool) : tools.length - 1
  const range = workPageRange(tools.length, selectedPage ?? Math.floor(defaultIndex / WORK_INLINE_ACTIVITY_PAGE_SIZE), WORK_INLINE_ACTIVITY_PAGE_SIZE)
  return (
    <section className={`work-inline-activity${expanded ? ' work-inline-activity--expanded' : ''}`} data-tool-count={tools.length}>
      {!expanded ? <button
        type="button"
        className={`work-process work-process--${state}`}
        title={`${label}${target ? ` · ${target}` : ''}，${open ? '收起' : '展开'}活动详情`}
        aria-label={`${label}${target ? ` · ${target}` : ''}，${open ? '收起' : '展开'}活动详情`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => {
          if (!open) setSelectedPage(range.page)
          setManual(!open)
        }}
      >
        {state === 'running' ? <Spinner size={14} /> : <Icon name={state === 'done' ? 'check' : state === 'error' || state === 'interrupted' ? 'warning' : 'circle-dot'} size={14} />}
        <span className="work-process__label">{label}</span>
        {target ? <span className="work-process__target">{target}</span> : null}
        <Icon name="chevron-right" size={12} className="work-inline-activity__chevron" />
      </button> : null}
      {presence.present ? <div className="ui-motion-collapse" {...presence.motionProps}><div className="ui-motion-collapse__content">
        <div id={detailId} className="process__body work-inline-activity__body" role="region" aria-label="活动详情">
          {tools.slice(range.start, range.end).map(item => (
            <div className="work-inline-activity__item" key={item.id}>
              <WorkToolActivity tool={item} fileContext={fileContext} onOpenFile={onOpenFile} onOpenChange={onOpenChange} turnRunning={turnRunning} active={active && open} />
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
