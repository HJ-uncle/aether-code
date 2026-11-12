import { buildMentionMessage, parseMentionContent, type Mention } from '../conversation/shared/mention-context'

/** Titles use authored chip labels; opaque instance selectors belong only to transport. */
export function sessionTaskTitle(text: string, mentions: readonly Mention[] = []): string {
  const { body, refs } = parseMentionContent(buildMentionMessage(text, mentions, { includeAgentRefs: true }))
  let display = '', cursor = 0
  for (const ref of refs) { display += body.slice(cursor, ref.s) + '@' + ref.d; cursor = ref.e }
  display += body.slice(cursor)
  return display.trim().replace(/\s+/g, ' ').slice(0, 52) || '新任务'
}
