import { getEngineStorageKey, sessionStorageKey } from '../../core/engine/source'

const SELECTIONS_KEY = 'aether:sessionModelSelections'
const MAX_SLOTS = 100

export interface SessionModelSelection {
  modelId: string
  /** Keep an unsent choice until another client starts a different model. */
  anchorRunId?: string
}

export interface SessionComposerModelInput {
  configuredModelId?: string
  runId?: string
  selection?: SessionModelSelection | null
  defaultModelId: string
}

function isSelection(value: unknown): value is SessionModelSelection {
  return Boolean(value && typeof value === 'object' &&
    'modelId' in value && typeof value.modelId === 'string' && value.modelId.trim() &&
    (!('anchorRunId' in value) || value.anchorRunId === undefined ||
      (typeof value.anchorRunId === 'string' && value.anchorRunId.trim())))
}

function storedSelection(selection: SessionModelSelection): SessionModelSelection {
  return {
    modelId: selection.modelId,
    ...(selection.anchorRunId ? { anchorRunId: selection.anchorRunId } : {})
  }
}

function trimTable(table: Record<string, SessionModelSelection>): void {
  const keys = Object.keys(table)
  while (keys.length > MAX_SLOTS) delete table[keys.shift() as string]
}

function readTable(source: string): Record<string, SessionModelSelection> {
  const table = Object.create(null) as Record<string, SessionModelSelection>
  try {
    const raw = localStorage.getItem(sessionStorageKey(SELECTIONS_KEY, source))
    if (!raw) return table
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return table
    for (const [sessionId, selection] of Object.entries(parsed)) {
      if (isSelection(selection)) table[sessionId] = storedSelection(selection)
    }
    trimTable(table)
  } catch {
    // Corrupt or unavailable storage must not block composing a message.
  }
  return table
}

export function loadSessionModelSelection(
  sessionId: string,
  source = getEngineStorageKey()
): SessionModelSelection | null {
  return readTable(source)[sessionId] ?? null
}

export function saveSessionModelSelection(
  sessionId: string,
  selection: SessionModelSelection | null,
  source = getEngineStorageKey()
): void {
  if (!sessionId || (selection !== null && !isSelection(selection))) return
  const table = readTable(source)
  delete table[sessionId]
  if (selection) table[sessionId] = storedSelection(selection)
  trimTable(table)
  try {
    localStorage.setItem(sessionStorageKey(SELECTIONS_KEY, source), JSON.stringify(table))
  } catch {
    // The in-memory user choice remains usable when persistence fails.
  }
}

/** Message usage models can be fallbacks; only the requested run model belongs here. */
export function resolveSessionComposerModel({
  configuredModelId,
  runId,
  selection,
  defaultModelId
}: SessionComposerModelInput): string {
  if (selection?.modelId &&
    (selection.anchorRunId === runId || selection.modelId === configuredModelId)) {
    return selection.modelId
  }
  // An existing run with an unknown requested model must not silently change it.
  const requestedModelId = configuredModelId === '当前配置 of AI' ? undefined : configuredModelId
  return requestedModelId || (runId ? '' : defaultModelId)
}
