import { useCallback, useMemo, useState, type SetStateAction } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import type { WorkspaceEntry, WorkspaceTab } from '../../app/navigation'

interface WorkspaceTabs {
  tab: WorkspaceTab
  entries: WorkspaceEntry[]
}

/** Keep lightweight navigation above the pane's animated mount boundary.
 * Preview components can still unmount and stop their background work. */
export function useWorkspaceTabs(source: number, sessionId: string | undefined, initialTab: WorkspaceTab) {
  const fallback = useMemo<WorkspaceTabs>(() => ({ tab: initialTab, entries: [] }), [initialTab])
  const [memory, setMemory] = useState(() => ({ source, sessions: new Map<string, WorkspaceTabs>() }))
  const state = (memory.source === source && sessionId ? memory.sessions.get(sessionId) : undefined) ?? fallback
  const update = useCallback((change: (previous: WorkspaceTabs) => WorkspaceTabs): void => {
    if (!sessionId || source !== getEngineSource()) return
    setMemory(previous => {
      const sameSource = previous.source === source
      const saved = sameSource ? previous.sessions.get(sessionId) : undefined
      const next = change(saved ?? fallback)
      if (next === saved) return previous
      const sessions = new Map(sameSource ? previous.sessions : [])
      sessions.delete(sessionId)
      sessions.set(sessionId, next)
      // Match the resource cache's bound; never retain document bytes here.
      while (sessions.size > 64) sessions.delete(sessions.keys().next().value!)
      return { source, sessions }
    })
  }, [source, sessionId, fallback])
  const setTab = useCallback((tab: WorkspaceTab): void => {
    update(previous => previous.tab === tab ? previous : { ...previous, tab })
  }, [update])
  const setEntries = useCallback((change: SetStateAction<WorkspaceEntry[]>): void => {
    update(previous => {
      const entries = typeof change === 'function' ? change(previous.entries) : change
      return entries === previous.entries ? previous : { ...previous, entries }
    })
  }, [update])
  return { ...state, setTab, setEntries }
}
