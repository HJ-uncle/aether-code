import type { AppSettings, EngineSnapshot } from '@shared/ipc'
import { getEngineSource, getEngineStorageKey, getExpectedEngine, isEngineReady, isRemoteEngine, subscribeEngineSource } from '../engine/source'

interface Selection { source: string; sessionId: string; workspaceRoot: string }
let selection: Selection | null = null
const listeners = new Set<() => void>()

/** Published only after AppProvider has selected the session for this endpoint. */
export function publishWorkspaceSelection(settings: AppSettings, source: string): void {
  const next = { source, sessionId: settings.lastSessionId.trim(), workspaceRoot: settings.remoteWorkspaceRoot.trim() }
  if (JSON.stringify(selection) === JSON.stringify(next)) return
  selection = next
  for (const listener of listeners) listener()
}

export function workspaceConnectionKey(): string {
  if (!isRemoteEngine()) return 'embedded'
  const source = getEngineStorageKey()
  if (!isEngineReady() || !source || selection?.source !== source || !selection.sessionId) return 'remote:unavailable'
  return JSON.stringify([source, selection.sessionId, selection.workspaceRoot])
}

export interface WorkspaceTarget {
  key: string
  generation: number
  expectedEngine: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
  sessionId: string
  workspaceRoot: string
}

export function captureWorkspaceTarget(): WorkspaceTarget {
  const key = workspaceConnectionKey()
  if (key === 'remote:unavailable') throw new Error('远端连接或会话尚未就绪')
  return {
    key, generation: getEngineSource(), expectedEngine: getExpectedEngine(),
    sessionId: isRemoteEngine() ? selection!.sessionId : '',
    workspaceRoot: isRemoteEngine() ? selection!.workspaceRoot : ''
  }
}

export function assertWorkspaceTarget(target: WorkspaceTarget): void {
  if (target.key !== workspaceConnectionKey() || target.generation !== getEngineSource()) {
    throw new Error('工作区连接或会话已经切换，已取消旧文件操作')
  }
}

export function onWorkspaceConnectionChanged(listener: () => void): () => void {
  listeners.add(listener)
  const dispose = subscribeEngineSource(listener)
  return () => { listeners.delete(listener); dispose() }
}
