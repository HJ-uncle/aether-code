export interface PreviewRetentionEntry {
  id: string
  size?: number
  /** Reference or revision that changes whenever the loaded content changes. */
  version?: unknown
}

export const PREVIEW_RETENTION_LIMITS = Object.freeze({
  entries: 6,
  inputBytes: 64 * 1024 * 1024,
  unknownBytes: 32 * 1024 * 1024
})

/** Bound live renderers as well as input bytes. Decoded pages have their own
 * budgets; a compressed-file budget alone cannot bound iframe/canvas memory.
 * Only already visited, unchanged entries survive a background update. */
export function retainPreviewEntries<T extends PreviewRetentionEntry>(
  available: readonly T[],
  selected: string | null,
  previous: readonly PreviewRetentionEntry[]
): T[] {
  const byId = new Map(available.map(entry => [entry.id, entry]))
  const current = selected ? byId.get(selected) : undefined
  const candidates = current ? [current] : []
  for (const old of previous) {
    const entry = byId.get(old.id)
    if (entry && entry.id !== current?.id && entry.version === old.version) candidates.push(entry)
  }
  const retained: T[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const entry of candidates) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const size = Number.isSafeInteger(entry.size) && entry.size! >= 0
      ? entry.size! : PREVIEW_RETENTION_LIMITS.unknownBytes
    // The visible file still needs a renderer even when it exceeds the cache
    // budget. Its own preview limit handles the user-facing unsupported state.
    if (entry !== current && bytes + size > PREVIEW_RETENTION_LIMITS.inputBytes) continue
    retained.push(entry)
    bytes += size
    if (retained.length >= PREVIEW_RETENTION_LIMITS.entries) break
  }
  return retained
}

export function sameRetainedPreviews(a: readonly PreviewRetentionEntry[], b: readonly PreviewRetentionEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]
    return entry.id === other.id && entry.size === other.size && entry.version === other.version
  })
}
