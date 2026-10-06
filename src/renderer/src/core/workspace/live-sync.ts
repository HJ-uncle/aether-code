/**
 * Keep the remote Explorer cache in step with the engine-owned workspace.
 *
 * The engine emits file-change/tool frames for writes performed by an agent,
 * but edits made by a terminal or another client have no such frame.  A small
 * coalescing queue handles event bursts while a low-frequency poll supplies
 * the eventual-consistency fallback.  Only the root and already-loaded,
 * expanded directories are queried; this preserves lazy-tree behaviour for
 * large repositories.
 */
import { onStreamEvent } from '../engine/client'
import { getEngineSource, isRemoteEngine, subscribeEngineSource } from '../engine/source'
import { getLayout, onLayoutChanged } from '../platform/layout-state'
import { onWorkspaceConnectionChanged, workspaceConnectionKey } from './connection'
import { paths } from './fs-client'
import {
  getWorkspaceState,
  refreshDirectory
} from './workspace-store'

const POLL_MIN_MS = 2_500
// A remote workspace can still be changed by a terminal or another client,
// so polling remains as a fallback. Backing off when snapshots are unchanged
// keeps an idle IDE from issuing a request every few seconds forever.
const POLL_MAX_MS = 8_000
const EVENT_DEBOUNCE_MS = 80

let wired = false
let disposeSource: (() => void) | null = null
let disposeConnection: (() => void) | null = null
let disposeStream: (() => void) | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let eventTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let queued = false
let pollDelayMs = POLL_MIN_MS
let disposeVisibility: (() => void) | null = null
let disposeLayout: (() => void) | null = null

function clearPoll(): void {
  if (pollTimer !== null) clearTimeout(pollTimer)
  pollTimer = null
}

function clearEventTimer(): void {
  if (eventTimer !== null) clearTimeout(eventTimer)
  eventTimer = null
}

function remoteDirectories(): string[] {
  if (!isRemoteEngine()) return []
  const current = getWorkspaceState()
  if (!current.root) return []
  const result = new Set<string>([current.root])
  // Expanded-but-not-yet-loaded directories are deliberately omitted: the
  // normal expand path owns their first request and will load them once.
  for (const dir of current.expanded) {
    if (!current.children.has(dir)) continue
    // A collapsed ancestor makes a descendant invisible even though its
    // expansion bit is retained for when the parent is opened again.
    let parent = paths.dirname(dir)
    let visible = true
    while (parent && parent !== current.root) {
      if (!current.expanded.has(parent)) { visible = false; break }
      const nextParent = paths.dirname(parent)
      // Root paths (`/` and `C:/`) are their own parent. Stop there instead
      // of spinning forever when the mounted workspace root is nested below it.
      if (nextParent === parent) break
      parent = nextParent
    }
    if (visible) result.add(dir)
  }
  return [...result]
}

function sameTarget(key: string, generation: number): boolean {
  return isRemoteEngine() &&
    workspaceConnectionKey() === key &&
    getEngineSource() === generation
}

function pollingAllowed(): boolean {
  const documentVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
  const layout = getLayout()
  return documentVisible && layout.sidebarVisible && layout.activeView === 'explorer'
}

function signature(entries: readonly { name: string; path: string; isDirectory: boolean; size: number; mtimeMs: number }[] | undefined): string {
  if (!entries) return ''
  return entries.map((entry) => [entry.name, entry.path, entry.isDirectory ? 'd' : 'f', entry.size, entry.mtimeMs].join('\u001f')).join('\u001e')
}

function carriesFileChange(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'change' in value && (value as { change?: unknown }).change)
}

async function refreshNow(): Promise<boolean> {
  if (inFlight) {
    queued = true
    await inFlight
    return false
  }
  const key = workspaceConnectionKey()
  const generation = getEngineSource()
  const directories = remoteDirectories()
  if (!sameTarget(key, generation) || directories.length === 0 || !pollingAllowed()) return false

  let changed = false
  const run = (async (): Promise<void> => {
    try {
      // Serial requests avoid overloading a remote engine when a large tree is
      // expanded.  loadChildren performs a second identity check before it
      // writes each response into the store.
      for (const dir of directories) {
        if (!sameTarget(key, generation)) break
        const current = getWorkspaceState()
        if (dir !== current.root && (!current.expanded.has(dir) || !current.children.has(dir))) continue
        const before = signature(current.children.get(dir))
        const entries = await refreshDirectory(dir, { background: true })
        if (before !== signature(entries ?? getWorkspaceState().children.get(dir))) changed = true
      }
    } finally {
      inFlight = null
      if (queued) {
        queued = false
        void refreshNow()
      }
    }
  })()
  inFlight = run
  await run
  return changed
}

function scheduleEventRefresh(): void {
  if (!isRemoteEngine()) return
  if (eventTimer !== null) return
  eventTimer = setTimeout(() => {
    eventTimer = null
    void refreshNow().then((changed) => {
      if (changed) pollDelayMs = POLL_MIN_MS
      schedulePoll()
    })
  }, EVENT_DEBOUNCE_MS)
}

function schedulePoll(delay = pollDelayMs): void {
  clearPoll()
  if (!isRemoteEngine() || !pollingAllowed()) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    void refreshNow().then((changed) => {
      pollDelayMs = changed ? POLL_MIN_MS : Math.min(POLL_MAX_MS, pollDelayMs * 2)
      schedulePoll()
    })
  }, delay)
}

function configurePolling(): void {
  clearPoll()
  clearEventTimer()
  queued = false
  pollDelayMs = POLL_MIN_MS
  if (!isRemoteEngine() || !pollingAllowed()) return
  schedulePoll()
}

/** Install the remote tree synchronizer once per renderer lifetime. */
export function wireWorkspaceLiveSync(): () => void {
  if (wired) return () => {}
  wired = true
  disposeStream = onStreamEvent((event) => {
    if (event.type !== 'payload') return
    const payload = event.payload
    // A tool may write more than one file.  Coalesce all related frames into
    // one pass over the currently visible directories.
    if (payload.fileChange || carriesFileChange(payload.toolResult) || carriesFileChange(payload.toolEnd)) scheduleEventRefresh()
  })
  disposeSource = subscribeEngineSource(configurePolling)
  disposeConnection = onWorkspaceConnectionChanged(() => {
    configurePolling()
    if (isRemoteEngine()) scheduleEventRefresh()
  })
  disposeLayout = onLayoutChanged(() => {
    if (isRemoteEngine() && pollingAllowed()) {
      pollDelayMs = POLL_MIN_MS
      schedulePoll(0)
    } else {
      clearPoll()
      clearEventTimer()
    }
  })
  if (typeof document !== 'undefined') {
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden' && isRemoteEngine() && pollingAllowed()) {
        pollDelayMs = POLL_MIN_MS
        schedulePoll(0)
      } else if (document.visibilityState === 'hidden') {
        clearPoll()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    disposeVisibility = () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  configurePolling()
  return () => {
    if (!wired) return
    wired = false
    disposeStream?.()
    disposeSource?.()
    disposeConnection?.()
    disposeLayout?.()
    disposeVisibility?.()
    disposeStream = null
    disposeSource = null
    disposeConnection = null
    disposeLayout = null
    clearPoll()
    clearEventTimer()
    queued = false
    pollDelayMs = POLL_MIN_MS
  }
}

