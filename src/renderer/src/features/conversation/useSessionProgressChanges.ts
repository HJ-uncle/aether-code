import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { useApp } from '@renderer/core/app-context'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { getRevertReport, subscribeReverts } from '@renderer/core/engine/change-revert'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import { sessionProgressChanges, sessionProgressRetryDelay, type SessionProgressChange } from './progress-state'
import { sessionTurnProgressChanges, type SessionTurnProgressGroup } from './turn-progress'

export interface SessionProgressSyncState {
  syncError: boolean
  syncing: boolean
  retryDisabled: boolean
  retry: () => void
}

/** One ledger reader serves every visible turn; history length must not multiply polling. */
export function useSessionProgressChanges(sessionId: string, tools: ToolActivity[], workspacePath?: string | null, active = true, groups?: readonly SessionTurnProgressGroup[]): SessionProgressSyncState & { changes: SessionProgressChange[] } {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const { ready } = useApp()
  const visible = useWorkbenchVisible()
  const enabled = ready && Boolean(sessionId) && visible && active
  const key = `${source}:${sessionId}`
  const [snapshot, setSnapshot] = useState<{ key: string; rows: EngineFileChange[]; syncError: boolean; syncing: boolean }>(() => ({ key, rows: [], syncError: false, syncing: false }))
  const [retryRevision, setRetryRevision] = useState(0)
  const report = useSyncExternalStore(subscribeReverts, () => getRevertReport(sessionId))
  const streamed = useMemo(() => sessionProgressChanges(sessionId, tools, [], workspacePath), [sessionId, tools, workspacePath])
  // Text tokens and output chunks do not change the set of file receipts.
  const revision = JSON.stringify(streamed.flatMap(file => file.records.map(change => [change.id, change.status])))
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  // A restored or newly settled turn may have durable edits without tool
  // receipts. Refresh on its identity/status, never on individual text tokens.
  const scopeRevision = JSON.stringify(groups?.map(group => [group.id, group.messages.map(message =>
    [message.id, message.conversationId, message.runId, message.run?.turnId, message.run?.runId, message.status, message.run?.status])]))
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const expectedEngine = getExpectedEngine()
    const current = (): boolean => alive && source === getEngineSource()
    const refresh = async (): Promise<void> => {
      setSnapshot(previous => ({ key, rows: previous.key === key ? previous.rows : [], syncError: previous.key === key && previous.syncError, syncing: true }))
      try {
        const response = await requestOrThrow<EngineFileChange[]>({ method: 'GET', path: '/changes', query: { sessionId }, expectedEngine })
        if (!current()) return
        if (!Array.isArray(response)) throw new Error('文件成果记录格式无效')
        const rows = response.filter(change => change.sessionId === sessionId)
        setSnapshot({ key, rows, syncError: false, syncing: false })
        failures = 0
        // Confirmation can happen in the workspace while older turns stay visible.
        const scoped = groupsRef.current ? [...sessionTurnProgressChanges(sessionId, groupsRef.current,
          sessionProgressChanges(sessionId, [], rows, workspacePath), workspacePath).values()].flatMap(files => files.flatMap(file => file.records)) : rows
        if (scoped.some(change => change.status === 'pending')) timer = setTimeout(() => { void refresh() }, 4000)
      } catch {
        if (current()) {
          setSnapshot(previous => ({ key, rows: previous.key === key ? previous.rows : [], syncError: true, syncing: false }))
          timer = setTimeout(() => { void refresh() }, sessionProgressRetryDelay(++failures))
        }
      }
    }
    void refresh()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [enabled, sessionId, source, key, revision, scopeRevision, workspacePath, report, retryRevision])
  const changes = useMemo(() => sessionProgressChanges(sessionId, tools, snapshot.key === key ? snapshot.rows : [], workspacePath), [sessionId, tools, snapshot.key, snapshot.rows, key, workspacePath])
  return { changes, syncError: snapshot.key === key && snapshot.syncError, syncing: snapshot.key === key && snapshot.syncing,
    retryDisabled: !enabled || snapshot.key === key && snapshot.syncing, retry: () => setRetryRevision(value => value + 1) }
}
