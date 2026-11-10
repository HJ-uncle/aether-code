import type { JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import type { ChatFileContext } from '../chat/chat-link'
import { WorkInlineActivity } from './WorkInlineActivity'
import { WorkSubagentCompactContext } from './WorkSubagentCard'
import './work-collaboration-summary.css'

/** The owning process already supplies disclosure. Completed collaboration
 * shares its ordinary receipt rows without adding another section to open. */
export function WorkCollaborationSummary({ tools, fileContext, revealTool, active, readOnly = false }: {
  tools: ToolActivity[]
  fileContext: ChatFileContext
  revealTool: { toolId: string; revision: number } | null
  active: boolean
  readOnly?: boolean
}): JSX.Element {
  return <section className="work-collaboration-summary" aria-label="协作" data-collaboration-count={tools.length}>
    <WorkSubagentCompactContext.Provider value={true}>
      <WorkInlineActivity tools={tools} fileContext={fileContext} revealTool={revealTool} expanded active={active} readOnly={readOnly} />
    </WorkSubagentCompactContext.Provider>
  </section>
}
