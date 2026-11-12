export const SESSION_SUBAGENT_SESSION_CACHE_COUNT = 4
export const SESSION_SUBAGENT_TRANSCRIPT_CACHE_BYTES = 16 * 1024 * 1024

interface TranscriptWindowMemory {
  window?: { residentBytes?: number }
}

/** Keep reading choices after evicting a full archive. Both maps are ordered
 * oldest first by the panel; the selected transcript is never size-limited. */
export function trimSessionSubagentTranscriptWindows<T extends { transcripts: ReadonlyMap<string, TranscriptWindowMemory> }>(
  memories: ReadonlyMap<string, T>,
  active?: TranscriptWindowMemory,
  budgetBytes = SESSION_SUBAGENT_TRANSCRIPT_CACHE_BYTES
): void {
  const retained: Array<{ memory: TranscriptWindowMemory; bytes: number }> = []
  const seen = new Set<TranscriptWindowMemory>()
  let bytes = 0
  for (const session of memories.values()) for (const memory of session.transcripts.values()) {
    if (memory === active || !memory.window || seen.has(memory)) continue
    seen.add(memory)
    const size = memory.window.residentBytes
    // The loader measures once. Unknown legacy windows are disposable; avoid
    // serializing an entire archive during every streaming panel render.
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
      delete memory.window
      continue
    }
    bytes += size
    retained.push({ memory, bytes: size })
  }
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : SESSION_SUBAGENT_TRANSCRIPT_CACHE_BYTES
  for (const entry of retained) {
    if (bytes <= budget) break
    delete entry.memory.window
    bytes -= entry.bytes
  }
}

interface CacheWithDrafts {
  drafts: Map<string, string>
  errors: Map<string, string>
  detailTop: Map<string, number>
  views: Map<string, 'rounds' | 'transcript'>
  transcripts: Map<string, unknown>
  attachments?: Map<string, Set<string>>
}

/** User input is not disposable history: only empty draft scopes may be evicted. */
export function trimSessionSubagentSessionCaches<T extends CacheWithDrafts>(memories: Map<string, T>): void {
  const older = [...memories.keys()].slice(0, -SESSION_SUBAGENT_SESSION_CACHE_COUNT)
  for (const scope of older) {
    const memory = memories.get(scope)!
    memory.transcripts.clear()
    memory.detailTop.clear()
    memory.views.clear()
    memory.errors.clear()
    for (const [key, draft] of memory.drafts) if (!draft) memory.drafts.delete(key)
    if (!memory.drafts.size && ![...(memory.attachments?.values() ?? [])].some(files => files.size)) memories.delete(scope)
  }
}
