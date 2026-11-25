import { getEngineStorageKey, sessionStorageKey, subscribeEngineSource } from '@renderer/core/engine/source'
import type { ServiceItem, ServiceNotification } from './service-model'

export interface ActivityHistoryEntry {
  id: string
  kind: 'service' | 'notification'
  sessionId: string | null
  label: string
  detail: string
  status: string
  statusLabel: string
  tone: ServiceItem['tone']
  updatedAt: number
  readAt: number
}

const STORAGE_KEY = 'aether.activity-history.v1'
const HISTORY_LIMIT = 100
let storageSource = getEngineStorageKey()
let entries = load()
const listeners = new Set<() => void>()

function valid(value: unknown): value is ActivityHistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<ActivityHistoryEntry>
  return typeof item.id === 'string' && Boolean(item.id) && (item.kind === 'service' || item.kind === 'notification') &&
    (typeof item.sessionId === 'string' || item.sessionId === null) && typeof item.label === 'string' && typeof item.detail === 'string' &&
    typeof item.status === 'string' && typeof item.statusLabel === 'string' && ['quiet', 'active', 'warning', 'error'].includes(item.tone as string) &&
    Number.isFinite(item.updatedAt) && Number.isFinite(item.readAt)
}

function sameEntry(a: ActivityHistoryEntry, b: ActivityHistoryEntry): boolean {
  return a.id === b.id && a.kind === b.kind && a.sessionId === b.sessionId &&
    a.label === b.label && a.detail === b.detail && a.status === b.status &&
    a.statusLabel === b.statusLabel && a.tone === b.tone &&
    a.updatedAt === b.updatedAt && a.readAt === b.readAt
}

function merge(values: readonly ActivityHistoryEntry[]): ActivityHistoryEntry[] {
  const unique = new Map<string, ActivityHistoryEntry>()
  const previousById = new Map<string, ActivityHistoryEntry>()
  for (const entry of entries) previousById.set(entry.id, entry)
  for (const value of values) {
    if (!valid(value)) continue
    const label = value.label.slice(0, 512)
    const detail = value.detail.slice(0, 1024)
    const existing = unique.get(value.id)
    if (existing && existing.updatedAt > value.updatedAt) continue
    const candidate: ActivityHistoryEntry = label === value.label && detail === value.detail
      ? value
      : { ...value, label, detail }
    // Reuse the previous reference when nothing actually changed so the
    // caller's referential-equality bail-out in `remember` can fire. Without
    // this, every merge produces fresh objects and we notify subscribers on
    // every render even when the persisted history is identical.
    const prior = previousById.get(value.id)
    const nextEntry = prior && sameEntry(prior, candidate) ? prior : candidate
    unique.set(value.id, nextEntry)
  }
  return [...unique.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, HISTORY_LIMIT)
}

function load(): ActivityHistoryEntry[] {
  try {
    const raw = localStorage.getItem(sessionStorageKey(STORAGE_KEY, storageSource))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? merge(parsed as ActivityHistoryEntry[]) : []
  } catch { return [] }
}

function persist(): void {
  try { localStorage.setItem(sessionStorageKey(STORAGE_KEY, storageSource), JSON.stringify(entries)) } catch { /* 历史写入失败不影响活动操作。 */ }
}

function notify(): void { for (const listener of listeners) listener() }

export function getActivityHistory(): readonly ActivityHistoryEntry[] { return entries }
export function subscribeActivityHistory(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }

/**
 * Select persisted entries that are not already represented by the live
 * notification/service snapshot.  Keeping this merge in the history model
 * makes the restart/session-switch path deterministic and prevents a read
 * notification from disappearing just because its owning plugin is no longer
 * mounted.
 */
export function getPersistedHistoryEntries(entries: readonly ActivityHistoryEntry[], excludedIds: ReadonlySet<string>): ActivityHistoryEntry[] {
  return entries.filter(entry => !excludedIds.has(entry.id))
}

/** Convert a persisted summary back into the row shape used by ServiceTray. */
export function historyEntryToServiceItem(entry: ActivityHistoryEntry): ServiceItem {
  return {
    id: entry.id,
    kind: entry.kind === 'service' ? 'command' : 'plugin',
    label: entry.label,
    detail: entry.detail,
    status: entry.status,
    statusLabel: entry.statusLabel,
    active: false,
    attention: false,
    tone: entry.tone,
    updatedAt: entry.updatedAt,
    revision: 0
  }
}

function remember(entry: ActivityHistoryEntry): void {
  const previous = entries.find(value => value.id === entry.id)
  if (previous && previous.updatedAt === entry.updatedAt && previous.status === entry.status && previous.label === entry.label && previous.detail === entry.detail) return
  const next = merge([entry, ...entries])
  if (next.length === entries.length && next.every((value, index) => value === entries[index])) return
  entries = next
  persist()
  notify()
}

export function rememberServiceHistory(item: ServiceItem, sessionId: string | null): void {
  if (item.active || item.contribution?.notification) return
  remember({ id: item.id, kind: 'service', sessionId, label: item.label, detail: item.detail, status: item.status,
    statusLabel: item.statusLabel, tone: item.tone, updatedAt: item.updatedAt, readAt: Date.now() })
}

export function rememberNotificationHistory(item: ServiceItem, notification: ServiceNotification): void {
  if (!notification.read) return
  remember({ id: notification.serviceId, kind: 'notification', sessionId: item.contribution?.sessionId ?? null,
    label: notification.label, detail: notification.detail, status: notification.status, statusLabel: notification.statusLabel,
    tone: notification.tone, updatedAt: notification.updatedAt, readAt: Date.now() })
}

export function clearActivityHistory(): void {
  if (!entries.length) return
  entries = []
  persist()
  notify()
}

subscribeEngineSource(() => {
  const next = getEngineStorageKey()
  if (next === storageSource) return
  storageSource = next
  entries = load()
  notify()
})
