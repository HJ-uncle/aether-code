import { getEngineStorageKey, sessionStorageKey } from '../../core/engine/source'

const THINKING_MODES_KEY = 'aether:sessionThinkingModes'
const MAX_SLOTS = 100

export type SessionThinkingMode = 'off' | 'low' | 'high' | 'max'

function isThinkingMode(value: unknown): value is SessionThinkingMode {
  return value === 'off' || value === 'low' || value === 'high' || value === 'max'
}

function trimTable(table: Record<string, SessionThinkingMode>): void {
  const keys = Object.keys(table)
  while (keys.length > MAX_SLOTS) delete table[keys.shift() as string]
}

function readTable(source: string): Record<string, SessionThinkingMode> {
  const table = Object.create(null) as Record<string, SessionThinkingMode>
  try {
    const raw = localStorage.getItem(sessionStorageKey(THINKING_MODES_KEY, source))
    if (!raw) return table
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return table
    for (const [sessionId, mode] of Object.entries(parsed)) {
      if (isThinkingMode(mode)) table[sessionId] = mode
    }
    trimTable(table)
  } catch {
    // An unavailable preference store must not block the user's next message.
  }
  return table
}

/** Only an explicit local choice can be restored; server thinking settings are not exposed. */
export function loadSessionThinkingMode(
  sessionId: string,
  source = getEngineStorageKey()
): SessionThinkingMode | null {
  return readTable(source)[sessionId] ?? null
}

export function saveSessionThinkingMode(
  sessionId: string,
  mode: SessionThinkingMode,
  source = getEngineStorageKey()
): void {
  if (!sessionId || !isThinkingMode(mode)) return
  const table = readTable(source)
  delete table[sessionId]
  table[sessionId] = mode
  trimTable(table)
  try {
    localStorage.setItem(sessionStorageKey(THINKING_MODES_KEY, source), JSON.stringify(table))
  } catch {
    // Preserve the in-memory user choice even when storage is denied or full.
  }
}
