import { useState } from 'react'
import { retainPreviewEntries, sameRetainedPreviews, type PreviewRetentionEntry } from './preview-retention'

/** Scope changes drop the old surfaces before painting the new workspace. */
export function useRetainedPreviews<T extends PreviewRetentionEntry>(
  available: readonly T[], selected: string | null, scope: string
): T[] {
  const [history, setHistory] = useState<{ scope: string; entries: PreviewRetentionEntry[] }>({ scope, entries: [] })
  const entries = retainPreviewEntries(available, selected, history.scope === scope ? history.entries : [])
  if (history.scope !== scope || !sameRetainedPreviews(entries, history.entries)) setHistory({ scope, entries })
  return entries
}
