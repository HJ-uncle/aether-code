import type { EngineRequestInput, EngineRequestResult } from '@shared/ipc'
import { checkCursorPage, type CheckedCursorPage } from './history-page'
import { parseControllerContext, parseControllerReceiptEvidence, record, validateControllerTarget,
  type ControllerScope, type ControllerTarget, type ControllerReceipt } from './collaboration-contract'

export const COLLABORATION_RECEIPT_PAGE_SIZE = 24
export interface CollaborationInspectionCapabilities {
  protocolVersion: 1
  durableQueueReceipts: boolean
  receiptPagination: boolean
  runtimeCommunication: boolean
  mailboxConsumer: boolean
  userControllerMutation: boolean
}
export interface CollaborationInspection {
  target: ControllerTarget
  capabilities: CollaborationInspectionCapabilities
  scope: ControllerScope
  page: CheckedCursorPage<ControllerReceipt>
  pageNumber: number
}
export type CollaborationInspectionRequest = (input: EngineRequestInput) => Promise<EngineRequestResult<unknown>>

export function parseCollaborationInspectionCapabilities(raw: unknown): CollaborationInspectionCapabilities {
  const keys = ['durableQueueReceipts', 'receiptPagination', 'runtimeCommunication', 'mailboxConsumer', 'userControllerMutation'] as const
  if (!record(raw) || raw.protocolVersion !== 1 || keys.some(key => typeof raw[key] !== 'boolean')) throw new Error('引擎尚未提供完整的协作观测能力信息')
  return { protocolVersion: 1, durableQueueReceipts: raw.durableQueueReceipts as boolean, receiptPagination: raw.receiptPagination as boolean,
    runtimeCommunication: raw.runtimeCommunication as boolean, mailboxConsumer: raw.mailboxConsumer as boolean, userControllerMutation: raw.userControllerMutation as boolean }
}

export function parseCollaborationReceiptPage(raw: unknown, scope: ControllerScope, recipientParticipantId: string, previous?: CollaborationInspection['page']): CheckedCursorPage<ControllerReceipt> {
  return checkCursorPage(raw, { label: '协作回执', limit: COLLABORATION_RECEIPT_PAGE_SIZE,
    ...(previous ? { cursor: previous.nextCursor, revision: previous.revision, after: previous.entries.at(-1)?.acceptedSeq ?? 0 } : {}),
    parse: item => {
      const receipt = parseControllerReceiptEvidence(item)
      if (receipt.rootRunId !== scope.rootRunId || receipt.rootAttemptId !== scope.rootAttemptId || receipt.recipientParticipantId !== recipientParticipantId)
        throw new Error('协作回执不属于当前任务与代理，已拒绝显示')
      return receipt
    }, key: item => item.messageId, sequence: item => item.acceptedSeq })
}

/** An explicit read pins the attempt once. Later pages retain its immutable prefix. */
export async function loadCollaborationInspection(target: ControllerTarget, request: CollaborationInspectionRequest,
  verify: () => void, previous?: CollaborationInspection): Promise<CollaborationInspection> {
  validateControllerTarget(target)
  const checkedRequest = async (input: EngineRequestInput): Promise<EngineRequestResult<unknown>> => {
    verify(); const response = await request(input); verify(); return response
  }
  if (previous && ((['rootRunId', 'rootSessionId', 'childSessionId', 'invocationRunId'] as const).some(key => previous.target[key] !== target[key])
    || !previous.page.hasMore || !previous.page.nextCursor)) throw new Error('协作回执页已切换，请从第一页重新读取')
  let capabilities = previous?.capabilities, scope = previous?.scope
  if (!capabilities || !scope) {
    const response = await checkedRequest({ method: 'GET', path: '/collaboration/capabilities' })
    if (!response.ok) throw new Error([404, 40401, 501, 50101].includes(response.code) ? '当前引擎尚未提供协作回执观测' : '暂时无法读取协作能力，请稍后重试')
    capabilities = parseCollaborationInspectionCapabilities(response.data)
    if (!capabilities.durableQueueReceipts || !capabilities.receiptPagination) throw new Error('当前引擎尚未启用持久协作回执分页')
    const context = await checkedRequest({ method: 'GET', path: `/collaboration/roots/${encodeURIComponent(target.rootRunId)}/controller-context`,
      query: { rootSessionId: target.rootSessionId, recipientParticipantId: `child:${target.childSessionId}` } })
    if (!context.ok) throw new Error(context.code === 409 || context.code === 40901
      ? '当前工作轮次已结束，无法建立新的实时观测；已保存的原回执仍可核对' : '无法确认当前任务的协作身份，请刷新代理状态后重试')
    scope = parseControllerContext(context.data, target).scope
  }
  const response = await checkedRequest({ method: 'GET',
    path: `/collaboration/roots/${encodeURIComponent(scope.rootRunId)}/participants/${encodeURIComponent(`child:${target.childSessionId}`)}/receipts`,
    query: { rootAttemptId: scope.rootAttemptId, rootSessionId: scope.rootSessionId, limit: COLLABORATION_RECEIPT_PAGE_SIZE,
      ...(previous?.page.nextCursor ? { cursor: previous.page.nextCursor } : {}) } })
  if (!response.ok) throw new Error('协作回执读取失败，请保留当前记录后重试')
  const page = parseCollaborationReceiptPage(response.data, scope, `child:${target.childSessionId}`, previous?.page)
  return { target: { ...target }, capabilities, scope, page, pageNumber: (previous?.pageNumber ?? 0) + 1 }
}

export function collaborationReceiptState(receipt: ControllerReceipt): string {
  if (receipt.state === 'queued') return '已持久接纳 · 未提供消费确认'
  if (receipt.state === 'interrupted') return '已中断 · 未确认执行'
  return '已拒绝'
}
