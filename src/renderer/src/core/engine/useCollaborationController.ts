import { useEffect, useMemo, useRef, useState } from 'react'
import { captureControllerConnection, createCollaborationController, subscribeControllerOutbox, type ControllerOutcome } from './collaboration-controller'
import type { CollaborationController } from './collaboration-controller-core'
import { controllerConnectionIdentity, controllerStorageIdentity, controllerSavedStatus, isControllerDraft, type ControllerTarget, type ControllerSavedRecord } from './collaboration-contract'
import { getEngineSource } from './source'
import { controllerDeliveryRecords, startControllerDeliveryRefresh } from './controller-delivery-refresh'

interface ControllerView { identity: string; capability?: boolean; busy?: boolean; notFound?: string; notice?: string; error?: string; receiptError?: string }
interface Input {
  kind?: 'root' | 'child'
  sessionId: string | null; rootRunId?: string; childSessionId?: string; invocationRunId?: string
  source: number; active: boolean; ready: boolean; toolProfile: 'code' | 'general'; refreshKey?: number
  /** A recovered terminal receipt must not discard its frozen text on restart. */
  onUnacceptedDraft?: (message: string) => void
}

/** Transport state is scoped separately from editable drafts. A response from
 * a previous selection may keep its durable record, but cannot replace this UI. */
export function useCollaborationController(input: Input): {
  pending: ReturnType<CollaborationController['records']>[number] | undefined
  restoredDraft: ReturnType<CollaborationController['drafts']>[number] | undefined
  history: ControllerSavedRecord[]
  capability: boolean | undefined; busy: boolean; error: string; notice: string; canRetry: boolean
  send: (message: string) => Promise<boolean>; reconcile: () => Promise<boolean>; retry: () => Promise<boolean>; discardDraft: () => Promise<boolean>; forgetTracking: () => Promise<boolean>
  queryHistory: (record: ControllerSavedRecord) => Promise<boolean>; removeHistory: (record: ControllerSavedRecord) => Promise<boolean>
} {
  const controller = useMemo(() => createCollaborationController(), [])
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<ControllerView>({ identity: '' })
  const mounted = useRef(true)
  const submitting = useRef<string | null>(null)
  const connection = captureControllerConnection(input.toolProfile)
  const selectionKey = JSON.stringify([input.kind ?? 'child', input.source, input.sessionId, input.rootRunId, input.childSessionId, input.invocationRunId, input.active])
  const selection = useRef({ key: selectionKey, generation: 0 })
  if (selection.current.key !== selectionKey) selection.current = { key: selectionKey, generation: selection.current.generation + 1 }
  const identity = `${selectionKey}:${selection.current.generation}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => subscribeControllerOutbox(() => setRevision(value => value + 1)), [])
  const stored = useMemo(() => {
    try { return { records: controller.records(), history: controller.history(), error: '' } }
    catch (cause) { return { records: [], history: [], error: cause instanceof Error ? cause.message : String(cause) } }
  }, [controller, revision, identity])
  const pending = stored.records.find(item => item.storageIdentity === controllerStorageIdentity(connection.expectedEngine)
    && item.rootSessionId === input.sessionId && (item.targetKind ?? 'child') === (input.kind ?? 'child') && item.childSessionId === input.childSessionId)
  const history = stored.history.filter(item => item.storageIdentity === controllerStorageIdentity(connection.expectedEngine)
    && item.rootSessionId === input.sessionId && (item.targetKind ?? 'child') === (input.kind ?? 'child') && item.childSessionId === input.childSessionId).reverse()
  const latestExact = history.find(item => item.rootRunId === input.rootRunId && (input.kind === 'root' || item.recipientInvocationRunId === input.invocationRunId))
  const restoredDraft = latestExact && isControllerDraft(latestExact) ? latestExact : undefined
  const visible = view.identity === identity ? view : { identity }
  const current = (): boolean => mounted.current && currentIdentity.current === identity && input.source === getEngineSource()
  const assertCurrent = (): void => { if (!current()) throw new Error('当前会话或工作轮次已变化；原要求已保留，请回到原会话核对') }
  useEffect(() => {
    if (!input.active || !input.ready || !input.rootRunId || (input.kind !== 'root' && (!input.childSessionId || !input.invocationRunId))) return
    let alive = true
    void controller.supported(connection, input.kind ?? 'child').then(capability => {
      if (alive && current()) setView(previous => ({ ...(previous.identity === identity ? previous : {}), identity, capability }))
    }, cause => {
      if (alive && current()) setView({ identity, error: cause instanceof Error ? cause.message : String(cause) })
    })
    return () => { alive = false }
  }, [controller, identity, input.ready, input.refreshKey])
  useEffect(() => {
    if (!input.ready || !input.sessionId) return
    const records = () => controllerDeliveryRecords(controller.history(), {
      storageIdentity: controllerStorageIdentity(connection.expectedEngine), rootSessionId: input.sessionId!,
      kind: input.kind ?? 'child', childSessionId: input.childSessionId
    })
    const currentRoot = (item: ControllerSavedRecord) => item.rootRunId === input.rootRunId
      && (input.kind === 'root' || item.recipientInvocationRunId === input.invocationRunId)
    return startControllerDeliveryRefresh({
      records, current, busy: () => submitting.current === identity,
      inspect: (record, selected) => controller.inspectHistory(connection, record, selected),
      onResult: record => {
        const latest = records().filter(currentRoot).at(-1)
        setView(previous => previous.identity !== identity ? previous : { ...previous, receiptError: undefined,
          ...(latest?.requestKey === record.requestKey && record.kind === 'accepted' && (record.receipt.state !== 'queued' || record.receipt.delivery?.state !== 'pending') && submitting.current !== identity
            ? { notice: controllerSavedStatus(record) + (record.receipt.delivery?.state === 'integrated' ? '；不代表已执行完成' : '') } : {}) })
      },
      onError: () => setView(previous => previous.identity !== identity ? previous : { ...previous, receiptError: '暂未更新投递状态；原接纳记录已保留，可查询原回执。' })
    })
  }, [controller, identity, input.ready])
  const apply = (result: ControllerOutcome, originalMessage?: string): boolean => {
    assertCurrent()
    if (result.outcome === 'accepted') {
      const accepted = result.receipt.state === 'queued' && result.receipt.delivery?.state !== 'suppressed'
      if (!accepted && originalMessage) input.onUnacceptedDraft?.(originalMessage)
      const notice = result.receipt.delivery?.state === 'integrated' ? '已加入上下文；不代表已执行完成'
        : result.receipt.delivery?.state === 'suppressed' ? result.receipt.delivery.integratedAt !== undefined ? '已从上下文移除；原文已保留' : '未读取，原文保留'
        : result.receipt.state === 'queued' ? `${input.kind === 'root' ? '已接纳，将在下一次模型调用前读取' : '补充要求已排队；可查看此代理的后续进展'}${result.localRecordRetained ? '；本地记录尚未清除，可再次核对' : ''}` : result.receipt.state === 'interrupted'
        ? result.receipt.reason === 'target_invocation_finished_before_consumption'
          ? '此代理本轮已结束，补充要求未读取；原文已保留'
          : '原要求已中断，未确认执行；原文已保留' : '原要求未被接受；原文已保留，请检查后再发送'
      setView(previous => ({ ...previous, identity, busy: false, notFound: undefined, notice, error: undefined }))
      return accepted
    }
    if (result.outcome === 'not_found') setView(previous => ({ ...previous, identity, busy: false, notFound: pending?.requestKey,
      notice: '尚未找到排队记录；已保留原要求。可再次核对，或在原实例和原工作轮次中重试原请求。', error: undefined }))
    else setView(previous => ({ ...previous, identity, busy: false, notice: result.message, notFound: undefined, error: undefined }))
    return false
  }
  const perform = async (action: () => Promise<ControllerOutcome>, originalMessage?: string): Promise<boolean> => {
    if (submitting.current === identity || !input.ready) return false
    submitting.current = identity
    setView(previous => ({ ...(previous.identity === identity ? previous : {}), identity, busy: true, notice: undefined, error: undefined }))
    try { return apply(await action(), originalMessage) }
    catch (cause) {
      if (current()) setView(previous => ({ ...previous, identity, busy: false, error: cause instanceof Error ? cause.message : String(cause) }))
      return false
    } finally {
      if (submitting.current === identity) submitting.current = null
      if (current()) setView(previous => ({ ...previous, identity, busy: false }))
    }
  }
  const sameInstance = pending && controllerConnectionIdentity(connection.expectedEngine) === controllerConnectionIdentity(pending.expectedEngine)
  const sameInvocation = pending?.rootRunId === input.rootRunId && (input.kind === 'root' || pending?.recipientInvocationRunId === input.invocationRunId)
  return {
    pending, restoredDraft, history, capability: visible.capability, busy: Boolean(visible.busy), error: stored.error || visible.error || visible.receiptError || '',
    notice: visible.notice || (pending ? sameInstance ? '上次补充要求的结果待核对，原文已保存' : '引擎实例已变化；原要求已保存，只能核对，不能重发' : restoredDraft ? '上次补充要求已结束，已恢复原文草稿；不会自动重发' : ''),
    canRetry: Boolean(pending && visible.notFound === pending.requestKey && sameInstance && sameInvocation && input.active && !history.some(item => item.requestKey === pending.requestKey && item.kind === 'refused')),
    send: message => perform(async () => {
      assertCurrent()
      if (!input.active || !input.rootRunId || !input.sessionId || (input.kind !== 'root' && (!input.childSessionId || !input.invocationRunId)) || pending || stored.error)
        throw new Error('当前代理暂时不能接收补充要求，请先核对已有记录')
      const target: ControllerTarget = input.kind === 'root' ? { kind: 'root', rootRunId: input.rootRunId, rootSessionId: input.sessionId }
        : { rootRunId: input.rootRunId, rootSessionId: input.sessionId, childSessionId: input.childSessionId!, invocationRunId: input.invocationRunId! }
      return controller.submit(connection, target, message, assertCurrent)
    }, message),
    reconcile: () => perform(async () => {
      assertCurrent()
      if (!pending) throw new Error('没有待核对的原请求')
      return controller.reconcile(connection, pending, assertCurrent)
    }, pending?.message),
    retry: () => perform(async () => {
      assertCurrent()
      if (!pending || visible.notFound !== pending.requestKey || !sameInstance || !sameInvocation || !input.active)
        throw new Error('请先核对原请求，且仅能在原工作轮次和原引擎实例中重试')
      return controller.retry(connection, pending, assertCurrent)
    }, pending?.message),
    queryHistory: async record => {
      if (submitting.current === identity || !input.ready) return false
      submitting.current = identity
      setView(previous => ({ ...(previous.identity === identity ? previous : {}), identity, busy: true, error: undefined }))
      try {
        assertCurrent()
        const result = await controller.inspectHistory(connection, record, assertCurrent)
        assertCurrent()
        setView(previous => ({ ...previous, identity, notice: controllerSavedStatus(result), error: undefined }))
        return true
      } catch (cause) { if (current()) setView(previous => ({ ...previous, identity, error: cause instanceof Error ? cause.message : String(cause) })); return false }
      finally { if (submitting.current === identity) submitting.current = null; if (current()) setView(previous => ({ ...previous, busy: false })) }
    },
    removeHistory: async record => {
      if (submitting.current === identity || !input.ready) return false
      submitting.current = identity
      setView(previous => ({ ...(previous.identity === identity ? previous : {}), identity, busy: true, error: undefined }))
      try {
        assertCurrent(); await controller.removeHistory(connection, record, assertCurrent); assertCurrent()
        setView(previous => ({ ...previous, identity, notice: '已移除此本地记录；原请求未取消，也没有重发', error: undefined })); return true
      } catch (cause) { if (current()) setView(previous => ({ ...previous, identity, error: cause instanceof Error ? cause.message : String(cause) })); return false }
      finally { if (submitting.current === identity) submitting.current = null; if (current()) setView(previous => ({ ...previous, busy: false })) }
    },
    discardDraft: async () => {
      if (!restoredDraft || pending || submitting.current === identity || !input.ready) return false
      submitting.current = identity
      setView(previous => ({ ...(previous.identity === identity ? previous : {}), identity, busy: true }))
      try { assertCurrent(); await controller.discardDraft(connection, restoredDraft, assertCurrent); assertCurrent(); setView({ identity, capability: visible.capability, notice: '已清除这条已结束的补充草稿' }); return true }
      catch (cause) { if (current()) setView(previous => ({ ...previous, identity, error: cause instanceof Error ? cause.message : String(cause) })); return false }
      finally { if (submitting.current === identity) submitting.current = null; if (current()) setView(previous => ({ ...previous, busy: false })) }
    },
    forgetTracking: async () => {
      if (!pending || submitting.current === identity || !input.ready) return false
      submitting.current = identity
      setView(previous => ({ ...(previous.identity === identity ? previous : {}), identity, busy: true }))
      try {
        assertCurrent(); input.onUnacceptedDraft?.(pending.message)
        await controller.forgetTracking(connection, pending, assertCurrent); assertCurrent()
        setView({ identity, capability: visible.capability, notice: '仅移除了本地跟踪；原请求未被取消，也没有重发' }); return true
      } catch (cause) { if (current()) setView(previous => ({ ...previous, identity, error: cause instanceof Error ? cause.message : String(cause) })); return false }
      finally { if (submitting.current === identity) submitting.current = null; if (current()) setView(previous => ({ ...previous, busy: false })) }
    }
  }
}
