/** Pure cache tests: full child transcripts use a shared byte budget without
 * losing selected content, scroll positions, disclosures, or unsent drafts. */
import { expect, test } from '@playwright/test'
import { trimWorkSubagentSessionCaches, trimWorkSubagentTranscriptWindows, WORK_SUBAGENT_TRANSCRIPT_CACHE_BYTES } from '../src/renderer/src/contrib/work/work-subagent-memory'

function transcript(bytes?: number) {
  return { window: { residentBytes: bytes }, scrollTop: 321, expanded: new Map([['reply', 2]]), opened: new Set(['instruction']) }
}

function session(transcripts = new Map<string, ReturnType<typeof transcript>>()) {
  return { transcripts, drafts: new Map<string, string>(), errors: new Map<string, string>(), detailTop: new Map<string, number>(),
    views: new Map<string, 'rounds' | 'transcript'>(), attachments: new Map<string, Set<string>>() }
}

test('inactive archives share one byte budget and preserve reading state when evicted', () => {
  const oldest = transcript(6), recent = transcript(4), newest = transcript(5), active = transcript(100)
  const memories = new Map([
    ['old-session', session(new Map([['oldest', oldest], ['recent', recent]]))],
    ['current-session', session(new Map([['newest', newest], ['active', active]]))]
  ])
  trimWorkSubagentTranscriptWindows(memories, active, 9)
  expect(oldest.window).toBeUndefined()
  expect(recent.window).toEqual({ residentBytes: 4 })
  expect(newest.window).toEqual({ residentBytes: 5 })
  expect(active.window).toEqual({ residentBytes: 100 })
  expect(oldest.scrollTop).toBe(321)
  expect([...oldest.expanded]).toEqual([['reply', 2]])
  expect([...oldest.opened]).toEqual(['instruction'])
  expect(memories.get('old-session')?.transcripts.get('oldest')).toBe(oldest)
})

test('default budget frees an oversized inactive archive but never caps the selected archive', () => {
  const oldest = transcript(WORK_SUBAGENT_TRANSCRIPT_CACHE_BYTES + 1), active = transcript(WORK_SUBAGENT_TRANSCRIPT_CACHE_BYTES * 4)
  const memories = new Map([['session', session(new Map([['oldest', oldest], ['active', active]]))]])
  trimWorkSubagentTranscriptWindows(memories, active)
  expect(oldest.window).toBeUndefined()
  expect(active.window.residentBytes).toBe(WORK_SUBAGENT_TRANSCRIPT_CACHE_BYTES * 4)
})

test('unmeasured archives release only inactive payloads without enumerating their content', () => {
  const unknown = transcript(), invalid = transcript(Number.NaN), active = transcript()
  Object.defineProperty(unknown.window, 'rows', { get() { throw new Error('Archive should not be scanned') } })
  const memories = new Map([['session', session(new Map([['unknown', unknown], ['invalid', invalid], ['active', active]]))]])
  trimWorkSubagentTranscriptWindows(memories, active)
  expect(unknown.window).toBeUndefined()
  expect(invalid.window).toBeUndefined()
  expect(active.window).toEqual({ residentBytes: undefined })
})

test('legacy identity aliases are counted once and repeated trimming is stable', () => {
  const shared = transcript(8), newest = transcript(1)
  const memories = new Map([['session', session(new Map([['old-alias', shared], ['new-alias', shared], ['newest', newest]]))]])
  trimWorkSubagentTranscriptWindows(memories, undefined, 9)
  trimWorkSubagentTranscriptWindows(memories, undefined, 9)
  expect(shared.window).toEqual({ residentBytes: 8 })
  expect(newest.window).toEqual({ residentBytes: 1 })
})

test('old session archives can be removed while draft and attachment scopes survive', () => {
  const draft = session(new Map([['child', transcript(1)]]))
  draft.drafts.set('child', 'Continue reviewing')
  const attached = session(new Map([['child', transcript(1)]]))
  attached.attachments.set('child', new Set(['notes.txt']))
  const memories = new Map([['draft', draft], ['attached', attached], ['empty', session()],
    ...Array.from({ length: 4 }, (_, index) => [`recent-${index}`, session()] as const)])
  trimWorkSubagentSessionCaches(memories)
  expect(memories.has('empty')).toBe(false)
  expect(draft.transcripts.size).toBe(0)
  expect(draft.drafts.get('child')).toBe('Continue reviewing')
  expect(attached.transcripts.size).toBe(0)
  expect([...attached.attachments.get('child')!]).toEqual(['notes.txt'])
  expect([...memories.keys()]).toEqual(['draft', 'attached', 'recent-0', 'recent-1', 'recent-2', 'recent-3'])
})
