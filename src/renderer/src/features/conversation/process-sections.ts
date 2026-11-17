import type { SessionPresentationSegment } from './message-timeline'
import { sessionToolChanges, sessionToolKind } from './tool-presentation'

export type ProcessItem = Extract<SessionPresentationSegment, { kind: 'process' }>['segments'][number]
export type ProcessSection = {
  kind: 'section'
  key: string
  segments: ProcessItem[]
  toolCount: number
  activityCount: number
  fileChangeCount: number
  thinkingCount: number
}

/** Prose and user follow-ups are reading boundaries, not part of a tool summary.
 * Stable source keys keep a growing run from resetting a reader's disclosure. */
export function sessionProcessSections(items: readonly ProcessItem[], sessionId = '', receiptParentSessionId?: string): Array<ProcessSection | Extract<ProcessItem, { kind: 'content' | 'followup' }>> {
  const result: ReturnType<typeof sessionProcessSections> = []
  let section: ProcessSection | undefined
  for (const item of items) {
    if (item.kind === 'content' || item.kind === 'followup') {
      section = undefined
      result.push(item)
      continue
    }
    if (!section) {
      section = { kind: 'section', key: item.key, segments: [], toolCount: 0, activityCount: 0, fileChangeCount: 0, thinkingCount: 0 }
      result.push(section)
    }
    section.segments.push(item)
    if (item.kind === 'thinking') section.thinkingCount += Number(Boolean(item.text.trim()))
    else {
      const tools = item.kind === 'tool' ? [item.tool] : item.tools
      section.toolCount += tools.length
      for (const tool of tools) {
        // A single command can emit hundreds of file rows. Disclosure follows
        // the visible receipts, without inflating the actual invocation count.
        const changes = (tool.change || tool.changes?.length) &&
          (tool.metadata?.archiveOutputOnly === true || sessionToolKind(tool) === 'file-change')
          ? sessionToolChanges(tool, sessionId, receiptParentSessionId).length : 0
        section.fileChangeCount += changes
        section.activityCount += Math.max(1, changes)
      }
    }
  }
  return result
}
