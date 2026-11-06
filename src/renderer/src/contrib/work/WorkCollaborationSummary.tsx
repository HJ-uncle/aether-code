import { useId, useLayoutEffect, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource } from '@renderer/core/engine/source'
import { Icon } from '@renderer/workbench/icons'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import { useCollapseMemory } from '../chat/useCollapseMemory'
import type { ChatFileContext } from '../chat/chat-link'
import { WorkInlineActivity } from './WorkInlineActivity'
import './work-collaboration-summary.css'

/** Only consecutive, confirmed successes arrive here; attention states stay
 * visible in the timeline. Closed groups don't mount the run subscribers. */
export function WorkCollaborationSummary({ tools, fileContext, revealTool, active }: {
  tools: ToolActivity[]
  fileContext: ChatFileContext
  revealTool: { toolId: string; revision: number } | null
  active: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useCollapseMemory(`work-collaboration:${getEngineSource()}:${fileContext.sessionId}:${tools[0].id}`)
  const id = `work-collaboration-${useId().replace(/:/g, '')}`
  useLayoutEffect(() => {
    if (revealTool && tools.some(tool => tool.id === revealTool.toolId)) setExpanded(true)
  }, [revealTool, tools, setExpanded])
  return <section className="work-collaboration-summary" aria-label="已完成的协作" data-collaboration-count={tools.length}>
    <button className="work-collaboration-summary__toggle" type="button" aria-expanded={Boolean(expanded)} aria-controls={id}
      onClick={() => setExpanded(!expanded)}>
      <Icon name="check" size={14} />
      <span>已完成 {tools.length} 次协作</span>
      <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
    </button>
    <MotionPresence id={id} className="work-collaboration-summary__records" show={Boolean(expanded)}>
      <WorkInlineActivity tools={tools} fileContext={fileContext} revealTool={revealTool} expanded active={active && Boolean(expanded)} />
    </MotionPresence>
  </section>
}
