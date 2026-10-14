import type { EngineRequestInput, EngineRequestResult } from '@shared/ipc'
import {
  appendControllerPending, CONTROLLER_OUTBOX_KEY, CONTROLLER_HISTORY_KEY, controllerConnectionIdentity, controllerStorageIdentity,
  parseControllerCapability, parseControllerContext, parseControllerOutbox, parseControllerPending, parseControllerReceipt, parseControllerHistory,
  mergeControllerSaved, sameControllerPending, isControllerDraft,
  record, utf8Bytes, validateControllerMessage, validateControllerTarget,
  type ControllerPending, type ControllerReceipt, type ControllerTarget, type ControllerSavedRecord
} from './collaboration-contract'

export type ControllerOutcome = { outcome: 'accepted'; receipt: ControllerReceipt; localRecordRetained?: boolean }
  | { outcome: 'unknown'; message: string } | { outcome: 'not_found' }
export interface ControllerConnection {
  source: number; expectedEngine: NonNullable<EngineRequestInput['expectedEngine']>; toolProfile: 'code' | 'general'
}
export interface ControllerEnvironment {
  request: (input: EngineRequestInput) => Promise<EngineRequestResult<unknown>>
  storage: Pick<Storage, 'getItem' | 'setItem'>
  lock: <T>(action: () => T | Promise<T>) => Promise<T>
  current: (connection: ControllerConnection) => void
  notify: () => void
  uuid: () => string
  now: () => number
}
/** Shared by Work and Code. The UI supplies its own selection gate in addition
 * to the connection gate, so a late context read can never dispatch elsewhere. */
export class CollaborationController {
  constructor(private readonly env: ControllerEnvironment) {}
  records(): ControllerPending[] { return parseControllerOutbox(this.env.storage.getItem(CONTROLLER_OUTBOX_KEY)) }
  history(): ControllerSavedRecord[] { return parseControllerHistory(this.env.storage.getItem(CONTROLLER_HISTORY_KEY)) }
  drafts(): ControllerSavedRecord[] { return this.history().filter(isControllerDraft) }
  private async updateHistory(change: (records: ControllerSavedRecord[]) => ControllerSavedRecord[]): Promise<void> {
    await this.env.lock(() => {
      const serialized = JSON.stringify(change(this.history()))
      parseControllerHistory(serialized)
      this.env.storage.setItem(CONTROLLER_HISTORY_KEY, serialized)
      if (this.env.storage.getItem(CONTROLLER_HISTORY_KEY) !== serialized) throw new Error('无法保存补充要求的结果；原发送记录仍保留')
    })
    this.env.notify()
  }
  private async update(change: (records: ControllerPending[]) => ControllerPending[]): Promise<void> {
    await this.env.lock(() => {
      const next = change(this.records())
      const serialized = JSON.stringify(next)
      parseControllerOutbox(serialized)
      this.env.storage.setItem(CONTROLLER_OUTBOX_KEY, serialized)
      // A failed or non-durable write must prevent the first POST.
      if (this.env.storage.getItem(CONTROLLER_OUTBOX_KEY) !== serialized) throw new Error('无法保存发送记录，补充要求尚未发送')
    })
    this.env.notify()
  }
  private async forget(pending: ControllerPending, current: () => void): Promise<void> {
    await this.update(records => { current(); return records.filter(item => item.requestKey !== pending.requestKey) })
  }
  private async acknowledge(pending: ControllerPending, receipt: ControllerReceipt, current: () => void): Promise<{ receipt: ControllerReceipt; cleaned: boolean }> {
    // An already verified server receipt remains accepted if local cleanup
    // fails. Reporting an ordinary send error here could invite a new key.
    current()
    try {
      // Save every acknowledged key before removing the ambiguous record.
      // A crash between these writes leaves two recoverable records, not zero.
      await this.updateHistory(records => {
        current()
        const saved: ControllerSavedRecord = { ...pending, kind: 'accepted', receipt }, existing = records.find(item => item.requestKey === pending.requestKey)
        const merged = existing ? mergeControllerSaved(existing, saved) : saved
        if (merged.kind !== 'accepted') throw new Error('原排队回执与已保存结果不一致')
        receipt = merged.receipt
        return existing ? records.map(item => item.requestKey === pending.requestKey ? merged : item) : [...records, saved]
      })
      await this.forget(pending, current); return { receipt, cleaned: true }
    }
    catch { current(); return { receipt, cleaned: false } }
  }
  private async receipt(value: unknown, pending: ControllerPending): Promise<ControllerReceipt> {
    const receipt = parseControllerReceipt(value, pending)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.message))
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== receipt.payloadHash) throw new Error('排队回执的正文校验不符；已保留原要求，请核对结果')
    return receipt
  }
  async supported(connection: ControllerConnection): Promise<boolean> {
    this.env.current(connection)
    const response = await this.env.request({ method: 'GET', path: '/collaboration/capabilities',
      expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
    this.env.current(connection)
    if (!response.ok) {
      if ([404, 501].includes(response.code)) return false
      throw new Error(response.message || '暂时无法核对协作能力')
    }
    return parseControllerCapability(response.data)
  }
  private async context(connection: ControllerConnection, target: ControllerTarget, selected: () => void): Promise<ReturnType<typeof parseControllerContext>> {
    validateControllerTarget(target)
    this.env.current(connection); selected()
    const response = await this.env.request({ method: 'GET', path: `/collaboration/roots/${encodeURIComponent(target.rootRunId)}/controller-context`,
      query: { rootSessionId: target.rootSessionId, recipientParticipantId: `child:${target.childSessionId}` },
      expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
    this.env.current(connection); selected()
    if (!response.ok) throw new Error(response.message || '无法获取当前子代理的协作上下文')
    return parseControllerContext(response.data, target)
  }
  private async prepare(connection: ControllerConnection, target: ControllerTarget, message: string, selected: () => void): Promise<ControllerPending> {
    validateControllerMessage(message)
    if (!connection.expectedEngine.instanceId) throw new Error('引擎实例尚未确认，请等待连接完成')
    if (!await this.supported(connection)) throw new Error('当前引擎尚未启用运行中补充要求')
    selected()
    const context = await this.context(connection, target, selected)
    const pending: ControllerPending = {
      version: 1, expectedEngine: { ...connection.expectedEngine }, storageIdentity: controllerStorageIdentity(connection.expectedEngine),
      ...context.scope, childSessionId: target.childSessionId, recipientParticipantId: context.recipient.participantId,
      recipientInvocationRunId: context.recipient.invocationRunId, requestKey: this.env.uuid(), message,
      payloadBytes: utf8Bytes(message), createdAt: this.env.now()
    }
    parseControllerPending(pending)
    await this.update(records => {
      this.env.current(connection); selected()
      if (records.some(item => item.storageIdentity === pending.storageIdentity && item.rootSessionId === pending.rootSessionId
        && item.childSessionId === pending.childSessionId)) throw new Error('此代理还有一条结果待核对的补充要求，请先核对原请求')
      return appendControllerPending(records, pending)
    })
    Object.freeze(pending.expectedEngine)
    return Object.freeze(pending)
  }
  private sameOwner(connection: ControllerConnection, pending: ControllerPending): void {
    this.env.current(connection)
    if (controllerStorageIdentity(connection.expectedEngine) !== pending.storageIdentity) throw new Error('此记录属于其他引擎或账号，不能在当前连接核对')
  }
  async submit(connection: ControllerConnection, target: ControllerTarget, message: string, selected: () => void): Promise<ControllerOutcome> {
    const pending = await this.prepare(connection, target, message, selected)
    return this.post(connection, pending, selected)
  }
  private async post(connection: ControllerConnection, pending: ControllerPending, selected: () => void): Promise<ControllerOutcome> {
    // Only a fully persisted exact payload can be dispatched. Retrying this
    // method directly is private to the UI's new-send path; recovery uses retry.
    parseControllerPending(pending)
    this.sameOwner(connection, pending); selected()
    if (controllerConnectionIdentity(connection.expectedEngine) !== controllerConnectionIdentity(pending.expectedEngine))
      throw new Error('引擎实例已变化，原请求只能核对，不能重新发送')
    const original = this.records().find(item => item.requestKey === pending.requestKey)
    if (!original || JSON.stringify(original) !== JSON.stringify(pending)) throw new Error('未找到完整的原发送记录，补充要求尚未发送')
    let response: EngineRequestResult<unknown>
    try {
      response = await this.env.request({ method: 'POST', path: `/collaboration/roots/${encodeURIComponent(pending.rootRunId)}/messages`,
        query: { rootAttemptId: pending.rootAttemptId, rootSessionId: pending.rootSessionId },
        body: { recipientParticipantId: pending.recipientParticipantId, recipientInvocationRunId: pending.recipientInvocationRunId,
          message: pending.message, requestKey: pending.requestKey }, expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
    } catch {
      this.env.current(connection); selected()
      return { outcome: 'unknown', message: '连接中断，发送结果待核对；原要求已保存' }
    }
    // Late responses never clear a record or draft in a different account or selection.
    this.env.current(connection); selected()
    if (response.ok && record(response.data) && response.data.outcome === 'accepted') {
      const receipt = await this.receipt(response.data.receipt, pending)
      const saved = await this.acknowledge(pending, receipt, () => { this.env.current(connection); selected() })
      return { outcome: 'accepted', receipt: saved.receipt, ...(!saved.cleaned ? { localRecordRetained: true } : {}) }
    }
    if (!response.ok && [400, 403, 404, 409, 413, 429].includes(response.code) && response.data === null) {
      // An explicit refusal is a local known result, never a forged receipt.
      // If its journal write fails, leave the immutable outbox for recovery.
      await this.updateHistory(records => {
        this.env.current(connection); selected()
        if (records.some(item => item.requestKey === pending.requestKey)) throw new Error('此请求已有结果记录，请保留原文核对')
        return [...records, { ...pending, kind: 'refused', rejection: { code: response.code, message: (response.message || '补充要求未被接受').slice(0, 1024), recordedAt: this.env.now() } }]
      })
      await this.forget(pending, () => { this.env.current(connection); selected() })
      throw new Error(response.message || '补充要求未被接受，原文已保留')
    }
    return { outcome: 'unknown', message: '未收到有效排队回执；请先核对原请求，避免重复发送' }
  }
  async reconcile(connection: ControllerConnection, pending: ControllerPending, selected: () => void): Promise<ControllerOutcome> {
    parseControllerPending(pending)
    this.sameOwner(connection, pending); selected()
    const response = await this.env.request({ method: 'GET', path: `/collaboration/roots/${encodeURIComponent(pending.rootRunId)}/controller-receipts/${encodeURIComponent(pending.requestKey)}`,
      query: { rootAttemptId: pending.rootAttemptId, rootSessionId: pending.rootSessionId },
      expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
    this.env.current(connection); selected()
    if (response.ok && record(response.data) && response.data.outcome === 'accepted') {
      const receipt = await this.receipt(response.data.receipt, pending)
      const saved = await this.acknowledge(pending, receipt, () => { this.env.current(connection); selected() })
      return { outcome: 'accepted', receipt: saved.receipt, ...(!saved.cleaned ? { localRecordRetained: true } : {}) }
    }
    if (!response.ok && response.code === 404 && record(response.data) && response.data.outcome === 'not_found'
      && response.data.requestKey === pending.requestKey) return { outcome: 'not_found' }
    throw new Error(response.message || '暂时无法核对原请求；原要求仍已保存')
  }
  async retry(connection: ControllerConnection, pending: ControllerPending, selected: () => void): Promise<ControllerOutcome> {
    if (this.history().some(item => item.requestKey === pending.requestKey && item.kind === 'refused')) throw new Error('原请求已被明确拒绝，请保留原文并清理待核对的本地跟踪后再决定发送')
    if (controllerConnectionIdentity(connection.expectedEngine) !== controllerConnectionIdentity(pending.expectedEngine))
      throw new Error('引擎实例已变化，原请求只能核对，不能重新发送')
    const receipt = await this.reconcile(connection, pending, selected)
    if (receipt.outcome !== 'not_found') return receipt
    if (!await this.supported(connection)) throw new Error('当前引擎尚未启用运行中补充要求，原要求已保留')
    const context = await this.context(connection, { rootRunId: pending.rootRunId, rootSessionId: pending.rootSessionId,
      childSessionId: pending.childSessionId, invocationRunId: pending.recipientInvocationRunId }, selected)
    if (context.scope.rootAttemptId !== pending.rootAttemptId) throw new Error('主任务已切换工作轮次，不能重发原要求；请保留记录核对')
    return this.post(connection, pending, selected)
  }
  async inspectHistory(connection: ControllerConnection, saved: ControllerSavedRecord, selected: () => void): Promise<ControllerSavedRecord> {
    parseControllerHistory(JSON.stringify([saved]))
    this.sameOwner(connection, saved); selected()
    if (saved.kind !== 'accepted') throw new Error('未被接纳的请求没有排队回执；原文已保存在本地')
    const response = await this.env.request({ method: 'GET', path: `/collaboration/roots/${encodeURIComponent(saved.rootRunId)}/controller-receipts/${encodeURIComponent(saved.requestKey)}`,
      query: { rootAttemptId: saved.rootAttemptId, rootSessionId: saved.rootSessionId }, expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
    this.sameOwner(connection, saved); selected()
    if (!response.ok || !record(response.data) || response.data.outcome !== 'accepted') throw new Error(response.message || '暂时无法查询原回执；已保存的原记录不会改变')
    const receipt = await this.receipt(response.data.receipt, saved)
    let result: ControllerSavedRecord = { ...saved, kind: 'accepted', receipt }
    await this.updateHistory(records => {
      this.sameOwner(connection, saved); selected()
      const existing = records.find(item => item.requestKey === saved.requestKey)
      if (!existing) throw new Error('此本地记录已移除，查询结果不会重新创建它')
      result = mergeControllerSaved(existing, result)
      return records.map(item => item.requestKey === saved.requestKey ? result : item)
    })
    return result
  }
  async removeHistory(connection: ControllerConnection, saved: ControllerSavedRecord, selected: () => void): Promise<void> {
    parseControllerHistory(JSON.stringify([saved]))
    this.sameOwner(connection, saved); selected()
    await this.updateHistory(records => {
      this.sameOwner(connection, saved); selected()
      if (this.records().some(item => item.requestKey === saved.requestKey)) throw new Error('此请求还有待核对的本地跟踪，请先核对原请求')
      const existing = records.find(item => item.requestKey === saved.requestKey)
      if (existing && (!sameControllerPending(existing, saved) || JSON.stringify(existing) !== JSON.stringify(saved))) throw new Error('此记录已更新，请重新确认后移除')
      // Removing the newest record must not unexpectedly refill the editor
      // with an older requirement. The older texts remain discoverable here.
      const sameScope = (item: ControllerSavedRecord): boolean => item.storageIdentity === saved.storageIdentity && item.rootSessionId === saved.rootSessionId
        && item.childSessionId === saved.childSessionId && item.rootRunId === saved.rootRunId && item.recipientInvocationRunId === saved.recipientInvocationRunId
      const newest = [...records].reverse().find(sameScope)
      return records.filter(item => item.requestKey !== saved.requestKey).map(item => newest?.requestKey === saved.requestKey && sameScope(item) ? { ...item, draftDismissed: true } : item)
    })
  }
  async discardDraft(connection: ControllerConnection, draft: ControllerSavedRecord, selected: () => void): Promise<void> {
    if (!isControllerDraft(draft)) throw new Error('此记录尚未结束，请先查询原回执')
    this.sameOwner(connection, draft); selected()
    await this.updateHistory(records => {
      this.sameOwner(connection, draft); selected()
      const existing = records.find(item => item.requestKey === draft.requestKey)
      if (!existing || JSON.stringify(existing) !== JSON.stringify(draft)) throw new Error('此记录已更新，请重新确认后清除草稿')
      return records.map(item => item.requestKey === draft.requestKey ? { ...item, draftDismissed: true } : item)
    })
  }
  async forgetTracking(connection: ControllerConnection, pending: ControllerPending, selected: () => void): Promise<void> {
    parseControllerPending(pending)
    this.sameOwner(connection, pending); selected()
    await this.update(records => {
      this.sameOwner(connection, pending); selected()
      const original = records.find(item => item.requestKey === pending.requestKey)
      if (original && JSON.stringify(original) !== JSON.stringify(pending)) throw new Error('原发送记录已变化，请重新确认')
      return records.filter(item => item.requestKey !== pending.requestKey)
    })
  }
}
