import type { JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import type { ChatFileContext } from '../conversation/shared/chat-link'
import { InlineActivity } from '../conversation/InlineActivity'
import { SessionSubagentCompactContext } from './SubagentCard'
import './collaboration-summary.css'

/** The owning process already supplies disclosure. Completed collaboration
 * shares its ordinary receipt rows without adding another section to open. */
export function CollaborationSummary({ tools, fileContext, revealTool, defaultToolId, turnRunning, active, readOnly = false }: {
  tools: ToolActivity[]
  fileContext: ChatFileContext
  revealTool: { toolId: string; revision: number } | null
  defaultToolId?: string
  turnRunning?: boolean
  active: boolean
  readOnly?: boolean
}): JSX.Element {
  return <section className="work-collaboration-summary" aria-label="协作" data-collaboration-count={tools.length}>
    <SessionSubagentCompactContext.Provider value={true}>
      <InlineActivity tools={tools} fileContext={fileContext} revealTool={revealTool} defaultToolId={defaultToolId}
        expanded turnRunning={turnRunning} active={active} readOnly={readOnly} />
    </SessionSubagentCompactContext.Provider>
  </section>
}
