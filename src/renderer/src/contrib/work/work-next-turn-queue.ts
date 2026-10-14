import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkQueueAction, WorkQueueDraft, WorkQueueRead } from '@shared/work-next-turn-api'
import type { NextTurnQueueState } from '@shared/next-turn-queue'
import { assertQueueState } from '@shared/next-turn-queue-state'
import { assertEngineSource, getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import type { Mention } from '../chat/mention-context'
import { mentionToken } from '../chat/mention-context'

/** Authored chips retain exact offsets; a pasted @ label never creates a collaborator. */
export function queuedDraft(text: string, mentions: readonly Mention[], revision: number): WorkQueueDraft['draft'] {
  let cursor = 0
  const captured = mentions.map(mention => {
    const token = mentionToken(mention), offset = mention.textOffset
    const textOffset = offset === undefined ? text.indexOf(token, cursor) : offset
    if (textOffset < cursor || textOffset < 0 || text.slice(textOffset, textOffset + token.length) !== token) throw new Error('引用位置已变化，请重新选择该引用')
    cursor = textOffset + token.length
    return { ...mention, textOffset }
  })
  return { text, mentions: captured, revision }
}
export function useWorkNextTurnQueue(taskId: string | null, source: number, ready: boolean) {
  const [read, setRead] = useState<WorkQueueRead | null>(null), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false)
  const generation = useRef(0), currentScope = useRef({ taskId, source }), busy = useRef(false), revision = useRef(-1)
  currentScope.current = { taskId, source }
  const invoke = useCallback(async (action: WorkQueueAction): Promise<WorkQueueRead> => {
    if (!taskId) throw new Error('先开始一项任务，再排下一轮')
    assertEngineSource(source)
    const response = await window.aether.workQueue.invoke({ taskId, expectedEngine: getExpectedEngine(), action })
    assertEngineSource(source)
    // Build the Error in this realm so CAS/validation retry cleanup retains the exact code.
    if (!response.ok) throw Object.assign(new Error(response.message), { code: response.code })
    const result = response.value
    if (currentScope.current.taskId !== taskId || currentScope.current.source !== source) throw new Error('任务已切换，本次结果已保存在原任务中')
    assertQueueState(result.state, result.state.scope)
    if (result.state.scope.taskId !== taskId) throw new Error('队列回执属于另一个任务')
    if (result.state.revision >= revision.current) { revision.current = result.state.revision; setRead(result); setError(null) }
    return result
  }, [source, taskId])
  const refresh = useCallback(async () => { try { await invoke({ kind: 'read' }) } catch (cause) {
    if (currentScope.current.taskId === taskId && currentScope.current.source === source) setError(cause instanceof Error ? cause.message : '无法读取队列')
  } }, [invoke, source, taskId])
  useEffect(() => {
    generation.current++; revision.current = -1; setRead(null); setError(null); busy.current = false; setSaving(false)
    if (!ready || !taskId) return
    const epoch = generation.current
    void refresh()
    return window.aether.workQueue.onChanged(event => {
      if (epoch !== generation.current || event.scope.taskId !== taskId || source !== getEngineSource()) return
      const expected = getExpectedEngine(), endpoint = expected.mode === 'embedded' ? '' : expected.baseUrl.replace(/\/+$/, '')
      if (event.scope.source.mode !== expected.mode || event.scope.source.endpoint !== endpoint || event.scope.source.accountId !== (expected.accountId ?? null)) return
      void refresh()
    })
  }, [source, taskId, ready, refresh])
  const commit = useCallback(async (action: WorkQueueAction) => {
    if (busy.current) throw new Error('正在保存队列，请稍候')
    const epoch = generation.current
    busy.current = true; setSaving(true)
    try { return await invoke(action) } catch (cause) {
      if (epoch === generation.current) setError(cause instanceof Error ? cause.message : '队列保存失败，草稿已保留')
      throw cause
    } finally { if (epoch === generation.current) { busy.current = false; setSaving(false) } }
  }, [invoke])
  const attempt = useRef<{ taskId: string; source: number; id: string; operationId: string; expectedRevision: number; submission: WorkQueueDraft } | null>(null)
  const enqueue = async (submission: WorkQueueDraft) => {
    if (!taskId || !read) throw new Error(error || '队列尚未就绪，草稿已保留')
    const previous = attempt.current
    if (previous && previous.taskId === taskId && previous.source === source && JSON.stringify(previous.submission) !== JSON.stringify(submission))
      throw new Error('上次入队回执未确认，请先用原草稿重试核对，避免重复保存')
    const pending = previous && previous.taskId === taskId && previous.source === source ? previous : {
      taskId, source, id: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: read.state.revision, submission: structuredClone(submission)
    }
    attempt.current = pending
    try {
      const result = await commit({ kind: 'enqueue', expectedRevision: pending.expectedRevision, operationId: pending.operationId, id: pending.id, submission: pending.submission })
      if (attempt.current === pending) attempt.current = null
      return result
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'code' in cause && ['INVALID', 'CAS', 'CAPACITY', 'CONFLICT', 'SCOPE'].includes(String(cause.code))) {
        if (attempt.current === pending) attempt.current = null
        await refresh()
        // Refresh the CAS baseline without silently dismissing the failed draft's feedback.
        if (currentScope.current.taskId === taskId && currentScope.current.source === source)
          setError(cause instanceof Error ? cause.message : '队列保存失败，草稿已保留')
      }
      throw cause
    }
  }
  const mutate = (operation: Extract<WorkQueueAction, { kind: 'mutate' }>['operation']) => {
    if (!read) return Promise.reject(new Error('队列尚未就绪'))
    return commit({ kind: 'mutate', expectedRevision: read.state.revision, operationId: crypto.randomUUID(), operation })
  }
  const editDraft = (id: string, entryRevision: number, draft: WorkQueueDraft['draft']) => {
    if (!read) return Promise.reject(new Error('队列尚未就绪'))
    return commit({ kind: 'edit-draft', expectedRevision: read.state.revision, operationId: crypto.randomUUID(), id, entryRevision, draft })
  }
  return { state: read?.state ?? null, error: error ?? read?.dispatchError ?? null, saving, ready: Boolean(read), enqueue, mutate, editDraft,
    reconcile: (retryIfAbsent = false) => commit({ kind: 'reconcile', retryIfAbsent }), refresh,
    pendingCount: read?.state.entries.filter(entry => entry.phase === 'pending').length ?? 0 }
}
export type WorkNextTurnQueue = ReturnType<typeof useWorkNextTurnQueue>
export function visibleQueueEntries(state: NextTurnQueueState | null) { return state?.entries.filter(entry => entry.phase !== 'terminal') ?? [] }
