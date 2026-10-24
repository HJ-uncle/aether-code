import { useSyncExternalStore } from 'react'
import { assertSessionFileTarget, type SessionFileTarget } from '@renderer/core/workspace/fs-client'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { engineConnectionKey, getExpectedEngine } from '@renderer/core/engine/source'
import type { BrowserTabState } from '@shared/browser'

export interface WorkFileResource {
  id: string
  path: string
  name: string
  /** Session target for engine-backed files; null for a user-opened local file. */
  target: SessionFileTarget | null
  /** Browser-owned handle for a file dropped from the desktop. The bytes are
   * read only when that tab becomes visible, so opening several files does not
   * duplicate their contents in the resource store. */
  externalFile?: File
  /** Absolute path selected from an artifact or native file chooser. It is
   * read through the read-only main-process preview bridge; never a write
   * target for the engine session. */
  externalPath?: string
}
interface ResourceState {
  files: readonly WorkFileResource[]
  selected: string | null
  reveal: number
}
const EMPTY: ResourceState = Object.freeze({ files: [], selected: null, reveal: 0 })
const sessions = new Map<string, ResourceState>()
const listeners = new Set<() => void>()
let revision = 0
const keyFor = (sessionId: string): string => `${getEngineSource()}:${sessionId}`
const notify = (): void => { for (const listener of listeners) listener() }

// Only lightweight tab descriptors survive selection changes; decoded document
// bytes and renderer workers belong to the one visible preview component.
subscribeEngineSource(() => { sessions.clear(); notify() })
export function getWorkResources(sessionId: string): ResourceState {
  return sessions.get(keyFor(sessionId)) ?? EMPTY
}
export function subscribeWorkResources(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useWorkResources(sessionId: string): ResourceState {
  return useSyncExternalStore(subscribeWorkResources, () => getWorkResources(sessionId))
}
export function resolvedWorkResourceId(resources: ResourceState, webIds: readonly string[], activeWebId: string | null): string | null {
  if (resources.files.some(file => file.id === resources.selected) || webIds.some(id => `web:${id}` === resources.selected)) return resources.selected
  if (activeWebId && webIds.includes(activeWebId)) return `web:${activeWebId}`
  return resources.files[0]?.id ?? (webIds[0] ? `web:${webIds[0]}` : null)
}
export function workResourceBrowserTabs(tabs: readonly BrowserTabState[], sessionId: string): BrowserTabState[] {
  const engineId = engineConnectionKey({ ...getExpectedEngine(), phase: 'ready' })
  return tabs.filter(tab => tab.context?.sessionId === sessionId && tab.context.engineId === engineId)
}
function update(sessionId: string, next: ResourceState): void {
  const key = keyFor(sessionId)
  sessions.delete(key)
  sessions.set(key, next)
  while (sessions.size > 64) sessions.delete(sessions.keys().next().value!)
  notify()
}
export function openWorkFileResource(path: string, target: SessionFileTarget): void {
  assertSessionFileTarget(target)
  const previous = getWorkResources(target.sessionId)
  const normalized = path.replace(/\\/g, '/')
  const id = `file:${/^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized}`
  const existing = previous.files.find(file => file.id === id)
  if (!existing && previous.files.length >= 32) throw new Error('此会话已打开 32 个文件，请先关闭不需要的标签。')
  const file = { id, path, name: normalized.split('/').pop() || path, target }
  update(target.sessionId, { files: existing ? previous.files.map(item => item.id === id ? file : item) : [...previous.files, file], selected: id, reveal: ++revision })
}

/**
 * Add a file supplied by the user through the native file picker or a desktop
 * drag. It intentionally carries no workspace target: this is a read-only
 * viewer resource and must not make an untrusted path part of an engine task.
 */
export function openExternalWorkFileResource(file: File, sessionId: string): void {
  const name = file.name || '未命名文件'
  const id = `external:${name.toLowerCase()}:${file.size}:${file.lastModified}`
  const previous = getWorkResources(sessionId)
  const existing = previous.files.find(item => item.id === id)
  if (!existing && previous.files.length >= 32) throw new Error('此会话已打开 32 个文件，请先关闭不需要的标签。')
  const resource: WorkFileResource = { id, path: name, name, target: null, externalFile: file }
  update(sessionId, { files: existing ? previous.files.map(item => item.id === id ? resource : item) : [...previous.files, resource], selected: id, reveal: ++revision })
}

export function openExternalWorkPathResource(path: string, sessionId: string): void {
  const normalized = path.replace(/\\/g, '/')
  const id = `external-path:${/^(?:[A-Za-z]:|\\\\)/.test(normalized) ? normalized.toLowerCase() : normalized}`
  const previous = getWorkResources(sessionId)
  const existing = previous.files.find(item => item.id === id)
  if (!existing && previous.files.length >= 32) throw new Error('此会话已打开 32 个文件，请先关闭不需要的标签。')
  const resource: WorkFileResource = {
    id, path, name: normalized.split('/').pop() || path, target: null, externalPath: path
  }
  update(sessionId, { files: existing ? previous.files.map(item => item.id === id ? resource : item) : [...previous.files, resource], selected: id, reveal: ++revision })
}
export function selectWorkResource(sessionId: string, id: string): void {
  const previous = getWorkResources(sessionId)
  update(sessionId, { ...previous, selected: id, reveal: ++revision })
}
export function closeWorkResource(sessionId: string, id: string): void {
  const previous = getWorkResources(sessionId)
  const index = previous.files.findIndex(file => file.id === id)
  const files = previous.files.filter(file => file.id !== id)
  update(sessionId, { ...previous, files,
    selected: previous.selected === id ? files[Math.min(Math.max(index, 0), files.length - 1)]?.id ?? null : previous.selected })
}
