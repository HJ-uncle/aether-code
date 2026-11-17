import { subscribeEngineSource } from '../engine/source'

export interface GitActivitySnapshot {
  sessionId: string
  label: string
  detail: string
  /** Compact status summary shown beside the Git activity row. */
  statusLabel?: string
  updatedAt: number
}

const activities = new Map<string, GitActivitySnapshot>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function publishGitActivity(sessionId: string, activity: Omit<GitActivitySnapshot, 'sessionId'> | null): void {
  if (!activity) {
    if (!activities.delete(sessionId)) return
  } else {
    const next = { ...activity, sessionId }
    const previous = activities.get(sessionId)
    if (previous && previous.label === next.label && previous.detail === next.detail && previous.statusLabel === next.statusLabel && previous.updatedAt === next.updatedAt) return
    activities.set(sessionId, next)
  }
  notify()
}

export function getGitActivity(sessionId: string | null): GitActivitySnapshot | null {
  return sessionId ? activities.get(sessionId) ?? null : null
}

export function subscribeGitActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

subscribeEngineSource(() => {
  if (!activities.size) return
  activities.clear()
  notify()
})
