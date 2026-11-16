import type { SessionPresentationSegment } from './message-timeline'

export type ProcessItem = Extract<SessionPresentationSegment, { kind: 'process' }>['segments'][number]
export type ProcessSection = {
  kind: 'section'
  key: string
  segments: ProcessItem[]
  toolCount: number
  thinkingCount: number
}

/** Prose and user follow-ups are reading boundaries, not part of a tool summary.
 * Stable source keys keep a growing run from resetting a reader's disclosure. */
export function sessionProcessSections(items: readonly ProcessItem[]): Array<ProcessSection | Extract<ProcessItem, { kind: 'content' | 'followup' }>> {
  const result: ReturnType<typeof sessionProcessSections> = []
  let section: ProcessSection | undefined
  for (const item of items) {
    if (item.kind === 'content' || item.kind === 'followup') {
      section = undefined
      result.push(item)
      continue
    }
    if (!section) {
      section = { kind: 'section', key: item.key, segments: [], toolCount: 0, thinkingCount: 0 }
      result.push(section)
    }
    section.segments.push(item)
    if (item.kind === 'thinking') section.thinkingCount += Number(Boolean(item.text.trim()))
    else section.toolCount += item.kind === 'tool' ? 1 : item.tools.length
  }
  return result
}
