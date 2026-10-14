export const WORK_SUBAGENT_SESSION_CACHE_COUNT = 4

interface CacheWithDrafts {
  drafts: Map<string, string>
  errors: Map<string, string>
  detailTop: Map<string, number>
  views: Map<string, 'rounds' | 'transcript'>
  transcripts: Map<string, unknown>
}

/** User input is not disposable history: only empty draft scopes may be evicted. */
export function trimWorkSubagentSessionCaches<T extends CacheWithDrafts>(memories: Map<string, T>): void {
  const older = [...memories.keys()].slice(0, -WORK_SUBAGENT_SESSION_CACHE_COUNT)
  for (const scope of older) {
    const memory = memories.get(scope)!
    memory.transcripts.clear()
    memory.detailTop.clear()
    memory.views.clear()
    memory.errors.clear()
    for (const [key, draft] of memory.drafts) if (!draft) memory.drafts.delete(key)
    if (!memory.drafts.size) memories.delete(scope)
  }
}
