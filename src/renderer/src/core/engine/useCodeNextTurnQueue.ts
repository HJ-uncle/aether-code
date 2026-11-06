import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeQueueAction, CodeQueueDraft } from '@shared/code-next-turn-api'
import type { NextTurnQueueEntry, NextTurnQueueState, QueueCommitResult } from '@shared/next-turn-queue'
import { assertQueueState, sameQueueScope } from '@shared/next-turn-queue-state'
import type { WorkQueueRead } from '@shared/work-next-turn-api'
import { assertEngineSource, getEngineSource, getExpectedEngine } from './source'
import { editCodeQueueDraft, visibleCodeQueueEntry } from './code-queue-entry'
import type { ChatAttachment } from './useChat'
import { acknowledgeCodeQueueIntent, consumeCodeQueueEnqueueReceipt, isQueueCommand, readCodeQueueIntents, rejectCodeQueueIntent, rebaseCodeQueueEnqueueIntent, sameCodeQueueIntent, saveCodeQueueIntent, type CodeQueueIntent } from './code-queue-intent'

const message = (cause: unknown): string => {
  if (cause instanceof Error && /[\u4e00-\u9fff]/.test(cause.message)) return cause.message
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
  return ({ CAS: '队列已变化，本次操作未保存。原稿已保留，请核对后重试。', INVALID: '队列内容或配置无效，本次未保存。请检查后重试。',
    CAPACITY: '队列正在处理其他内容，请稍后重试。原稿已保留。', CONFLICT: '消息状态或配置已变化，请核对后重试。原稿已保留。',
    SCOPE: '队列所属会话、账号或工作区已变化，原操作已保留。', AUTHORITY: '引擎连接或任务身份已变化，请恢复原连接后核对。',
    CORRUPT: '队列恢复记录损坏，原记录已保留，未继续发送。', IO: '队列保存结果尚未确认，原操作已保留，请核对后重试。' } as Record<string, string>)[code]
    ?? '队列操作未完成，原操作与草稿已保留，请核对后重试。'
}

/** The renderer observes and edits the main-owned queue; it never dispatches its entries. */
export function useCodeNextTurnQueue(taskId: string | null, source: number, ready: boolean) {
  const owner = useMemo(() => ({ taskId, source }), [taskId, source, ready])
  type ScopedRead = { owner: typeof owner; generation: number; result: WorkQueueRead }
  const [read, setRead] = useState<ScopedRead | null>(null), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false)
  const current = useRef(owner), activeOwner = useRef<typeof owner | null>(null), state = useRef<ScopedRead | null>(null), generation = useRef(0), busy = useRef(false)
  current.current = owner
  const same = useCallback(() => current.current === owner && source === getEngineSource(), [owner, source])
  // Owner identity also distinguishes A → B → A before any passive reset.
  const scoped = useCallback((value: ScopedRead | null): WorkQueueRead | null => same() && value?.owner === owner
    && value.generation === generation.current ? value.result : null, [owner, same])
  const invoke = useCallback(async (action: CodeQueueAction): Promise<WorkQueueRead | QueueCommitResult> => {
    if (!taskId) throw new Error('请先选择一个会话')
    if (!same()) throw new Error('会话已切换，请在当前会话重试')
    const epoch = generation.current
    assertEngineSource(source)
    const response = await window.aether.codeQueue.invoke({ taskId, expectedEngine: getExpectedEngine(), action })
    assertEngineSource(source)
    if (epoch !== generation.current || !same()) throw new Error('会话已切换，结果已保存在原会话中')
    if (!response.ok) throw Object.assign(new Error(message(Object.assign(new Error(response.message), { code: response.code }))), { code: response.code })
    const result = response.value
    assertQueueState(result.state, result.state.scope)
    if (result.state.scope.owner !== 'code' || result.state.scope.taskId !== taskId) throw new Error('队列回执不属于当前 Code 会话')
    if (!same()) throw new Error('会话已切换，结果已保存在原会话中')
    const expected = getExpectedEngine(), scope = result.state.scope
    if (scope.source.mode !== expected.mode || scope.source.accountId !== (expected.accountId ?? null)
      || scope.source.endpoint !== (expected.mode === 'embedded' ? '' : expected.baseUrl.replace(/\/+$/, ''))) throw new Error('队列来源已变化')
    const previous = scoped(state.current)
    if (previous && !sameQueueScope(previous.state.scope, scope)) {
      state.current = null; setRead(null)
      throw new Error('会话的存储身份已变化，原队列已保留，请重新同步')
    }
    if (!previous || result.state.revision >= previous.state.revision) {
      const next = { owner, generation: epoch, result }
      state.current = next; setRead(next); setError(null)
    }
    return result
  }, [taskId, source, owner, same, scoped])
  const deliver = useCallback(async (intent: CodeQueueIntent) => {
    let pending = intent
    for (let rebases = 0; ; rebases++) {
      try {
        const result = await invoke(pending.action)
        acknowledgeCodeQueueIntent(localStorage, pending, result)
        return result
      } catch (cause) {
        rejectCodeQueueIntent(localStorage, pending, cause)
        // CAS proves this append did not commit. No other error, edit or reorder
        // may change its original revision; unknown ACKs require exact replay.
        if (pending.action.kind !== 'enqueue' || !cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'CAS') throw cause
        if (rebases >= 2) throw Object.assign(new Error('队列已更新，原稿已保留，请重试'), { code: 'CAS' })
        const latest = await invoke({ kind: 'read' })
        if (!sameQueueScope(pending.scope, latest.state.scope)) throw new Error('队列所属会话已变化，原稿已保留')
        pending = rebaseCodeQueueEnqueueIntent(localStorage, pending, latest.state.revision)
      }
    }
  }, [invoke])
  const refresh = useCallback(async () => {
    const epoch = generation.current
    let recovering = false
    try {
      let result = await invoke({ kind: 'read' })
      if (busy.current) return result
      const intents = readCodeQueueIntents(localStorage, result.state.scope).filter(intent => intent.status === 'pending')
      if (!intents.length) return result
      recovering = true; busy.current = true; setSaving(true)
      // These are already-authorized commands, frozen before their first IPC.
      // Restoration replays the original operation identity, never rebuilt UI options.
      for (const intent of intents) result = await deliver(intent)
      return result
    } catch (cause) { if (epoch === generation.current && same()) setError(message(cause)); return null }
    finally { if (recovering && epoch === generation.current) { busy.current = false; setSaving(false) } }
  }, [invoke, deliver, same])
  useEffect(() => {
    const epoch = ++generation.current
    activeOwner.current = owner
    state.current = null; setRead(null); setError(null); busy.current = false; setSaving(false)
    if (!ready || !taskId) return () => { generation.current++; activeOwner.current = null }
    void refresh()
    const off = window.aether.codeQueue.onChanged(event => {
      if (generation.current !== epoch || !same() || event.scope.owner !== 'code' || event.scope.taskId !== taskId) return
      const expected = getExpectedEngine()
      if (event.scope.source.mode !== expected.mode || event.scope.source.accountId !== (expected.accountId ?? null)
        || event.scope.source.endpoint !== (expected.mode === 'embedded' ? '' : expected.baseUrl.replace(/\/+$/, ''))) return
      void refresh()
    })
    return () => { generation.current++; activeOwner.current = null; off() }
  }, [taskId, source, ready, owner, refresh, same])
  const commit = useCallback(async (action: CodeQueueAction) => {
    if (!same()) throw new Error('会话已切换，请在当前会话重试')
    if (busy.current) throw new Error('正在保存队列，请稍候')
    const epoch = generation.current
    busy.current = true; setSaving(true)
    try {
      const currentState = scoped(state.current)?.state ?? (await invoke({ kind: 'read' })).state
      for (const prior of readCodeQueueIntents(localStorage, currentState.scope).filter(intent => intent.status === 'pending')) {
        let delivered: WorkQueueRead | QueueCommitResult
        try { delivered = await deliver(prior) }
        catch (cause) {
          if (rejectCodeQueueIntent(localStorage, prior, cause)) continue
          throw cause
        }
        if (isQueueCommand(action)) {
          if (sameCodeQueueIntent(prior.action, action)) {
            if (action.kind === 'enqueue') consumeCodeQueueEnqueueReceipt(localStorage, currentState.scope, action.submission)
            return delivered
          }
          throw new Error('上一项操作已核对并保存。当前草稿已保留，请再次执行本次操作。')
        }
      }
      if (!isQueueCommand(action)) return await invoke(action)
      const intent = saveCodeQueueIntent(localStorage, currentState.scope, action)
      return await deliver(intent)
    } catch (cause) {
      if (epoch === generation.current) { try { await invoke({ kind: 'read' }) } catch { /* Keep the original mutation failure. */ }; if (same()) setError(message(cause)) }
      throw Object.assign(new Error(message(cause)), cause && typeof cause === 'object' && 'code' in cause ? { code: cause.code } : {})
    } finally { if (epoch === generation.current) { busy.current = false; setSaving(false) } }
  }, [invoke, deliver, same, scoped])
  const snapshot = (): NextTurnQueueState => {
    const value = scoped(state.current)
    if (!value) throw new Error('队列正在恢复，草稿已保留')
    return value.state
  }
  const pending = (id: string): NextTurnQueueEntry => {
    const entry = snapshot().entries.find(row => row.id === id)
    if (!entry || entry.phase !== 'pending') throw new Error('消息状态已变化，只有待发消息可以编辑')
    return entry
  }
  const enqueue = async (submission: CodeQueueDraft) => {
    if (consumeCodeQueueEnqueueReceipt(localStorage, snapshot().scope, submission)) return state.current!.result
    return commit({ kind: 'enqueue', id: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: snapshot().revision, submission: structuredClone(submission) })
  }
  const mutate = (operation: Extract<CodeQueueAction, { kind: 'mutate' }>['operation']) => commit({ kind: 'mutate', expectedRevision: snapshot().revision, operationId: crypto.randomUUID(), operation })
  const edit = (id: string, text: string, attachments: ChatAttachment[]) => {
    const entry = pending(id)
    return commit({ kind: 'replace-submission', expectedRevision: snapshot().revision, operationId: crypto.randomUUID(), id,
      entryRevision: entry.revision, submission: editCodeQueueDraft(entry, text, attachments) })
  }
  const move = (fromIndex: number, toIndex: number) => {
    const entries = snapshot().entries.filter(entry => entry.phase === 'pending'), entry = entries[fromIndex]
    if (!entry || !entries[toIndex] || fromIndex === toIndex) return Promise.resolve()
    const remaining = entries.filter(row => row.id !== entry.id)
    return mutate({ kind: 'move', id: entry.id, beforeId: remaining[toIndex]?.id ?? null }).then(() => {})
  }
  const retarget = (model: string, sessionId: string) => {
    if (taskId !== sessionId) return Promise.reject(new Error('会话已变化，未修改其他会话的待发模型'))
    const value = snapshot(), entries = value.entries.filter(entry => entry.phase === 'pending').map(entry => ({ id: entry.id, entryRevision: entry.revision }))
    if (!entries.length) return Promise.resolve()
    return commit({ kind: 'retarget-model', expectedRevision: value.revision, operationId: crypto.randomUUID(), entries,
      model: { kind: 'explicit', modelId: model } }).then(() => {})
  }
  const merge = (submission?: CodeQueueDraft) => {
    const value = snapshot(), entries = value.entries.filter(entry => entry.phase === 'pending').map(entry => ({ id: entry.id, entryRevision: entry.revision }))
    if (!submission && entries.length < 2) return Promise.resolve()
    return commit({ kind: 'merge-pending', expectedRevision: value.revision, operationId: crypto.randomUUID(), entries, id: crypto.randomUUID(), ...(submission ? { submission } : {}) }).then(() => {})
  }
  const scopedRead = scoped(read), ownsFeedback = activeOwner.current === owner
  const entries = scopedRead?.state.entries.filter(entry => entry.phase !== 'terminal') ?? []
  return { state: scopedRead?.state ?? null, queue: entries.map(visibleCodeQueueEntry), ready: Boolean(scopedRead), saving: ownsFeedback && saving,
    error: (ownsFeedback ? error : null) ?? scopedRead?.dispatchError ?? null, paused: scopedRead?.state.paused ?? false,
    unknown: entries.some(entry => entry.phase === 'admission-unknown' || entry.phase === 'dispatching'),
    enqueue, edit, move, retarget, merge, refresh,
    consumeConfirmedEnqueue: (submission: CodeQueueDraft) => consumeCodeQueueEnqueueReceipt(localStorage, snapshot().scope, submission),
    remove: (id: string) => mutate({ kind: 'remove', id, entryRevision: pending(id).revision, at: Date.now() }).then(() => {}),
    clear: () => mutate({ kind: 'clear-pending', at: Date.now() }).then(() => {}),
    pause: () => mutate({ kind: 'pause', reason: '已暂停待发消息' }).then(() => {}),
    resume: () => mutate({ kind: 'resume' }).then(() => {}),
    reconcile: (retryIfAbsent = false) => commit({ kind: 'reconcile', retryIfAbsent }).then(() => {}) }
}
