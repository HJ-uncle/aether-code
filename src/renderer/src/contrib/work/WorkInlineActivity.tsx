import { memo, useId, useMemo, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { CompactToolRow } from '../chat/CompactToolRow'
import { CommandJobCard } from '../chat/CommandJobCard'
import { FileChangeCard } from '../chat/FileChangeCard'
import { SubagentCard } from '../chat/SubagentCard'
import { useCollapseMemory } from '../chat/useCollapseMemory'
import type { ChatFileContext } from '../chat/chat-link'
import { workToolTarget } from './work-message-timeline'
import { workPageRange } from './work-view-performance'
import { WORK_INLINE_ACTIVITY_PAGE_SIZE, workActivityState, workActivitySummary } from './work-inline-activity-state'
import './work-inline-activity.css'

const ActivityTool = memo(function ActivityTool({ tool, fileContext, onOpenFile }: {
  tool: ToolActivity; fileContext: ChatFileContext; onOpenFile?: (path: string) => void
}): JSX.Element {
  const state = workActivityState(tool)
  if (tool.name === 'subagent') return <SubagentCard tool={tool} sessionId={fileContext.sessionId} defaultOpen={false} />
  if (tool.name === 'execute_cmd' && tool.commandJob) return <CommandJobCard job={tool.commandJob} sessionId={fileContext.sessionId} />
  if (['write_file', 'edit_file', 'delete_file'].includes(tool.name) && tool.change) return <FileChangeCard change={tool.change} state={state} fileContext={fileContext} onOpenFile={onOpenFile} />
  return <CompactToolRow tool={tool} state={state} summary={workToolTarget(tool, fileContext.workspaceRoot)}
    memoryKey={`work-tool:${fileContext.sessionId}:${tool.id}`} fileContext={fileContext} defaultOpen={false} />
})

/** Receipts stay beside their prose; complete diagnostics remain in the activity overview. */
export function WorkInlineActivity({ tools, fileContext, onOpenActivity, onOpenFile }: {
  tools: ToolActivity[]; fileContext: ChatFileContext; onOpenActivity?: (toolId: string) => void; onOpenFile?: (path: string) => void
}): JSX.Element | null {
  const [manual, setManual] = useCollapseMemory(`work-process:${fileContext.sessionId}:${tools[0]?.id}`)
  const [selectedPage, setSelectedPage] = useState<number | null>(null)
  const detailId = useId()
  const summary = useMemo(() => workActivitySummary(tools, fileContext.workspaceRoot), [tools, fileContext.workspaceRoot])
  if (!summary) return null
  const open = manual ?? false
  const { tool, state, label, target } = summary
  // Open at the live operation, then retain that page while the user reads it.
  const defaultIndex = state === 'running' || state === 'waiting' ? tools.indexOf(tool) : tools.length - 1
  const range = workPageRange(tools.length, selectedPage ?? Math.floor(defaultIndex / WORK_INLINE_ACTIVITY_PAGE_SIZE), WORK_INLINE_ACTIVITY_PAGE_SIZE)
  return (
    <section className="work-inline-activity" data-tool-count={tools.length}>
      <button
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
      </button>
      {open ? (
        <div id={detailId} className="process__body work-inline-activity__body" role="region" aria-label="活动详情">
          {tools.slice(range.start, range.end).map(item => (
            <div className="work-inline-activity__item" key={item.id}>
              <ActivityTool tool={item} fileContext={fileContext} onOpenFile={onOpenFile} />
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
          {onOpenActivity ? <footer className="work-inline-activity__footer">
            <button type="button" onClick={() => onOpenActivity(tool.id)}>在侧栏查看详情<Icon name="chevron-right" size={12} /></button>
          </footer> : null}
        </div>
      ) : null}
    </section>
  )
}
