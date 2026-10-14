import type { EngineRequestInput } from '@shared/ipc'
import type { SubagentDiscoveryPage, SubagentDiscoveryRef } from '@shared/subagent'

export const DISCOVERY_MAX_BYTES = 256 * 1024
export const DISCOVERY_MAX_REFS = 192
const active = (status: string): boolean => ['queued', 'running', 'cancelling'].includes(status)
const statuses = ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted']
const identityKeys = ['tenantId', 'runId', 'parentSessionId', 'rootSessionId', 'parentConversationId',
  'parentMessageId', 'parentToolCallId', 'childSessionId', 'modelId', 'createdAt', 'agentId', 'agentName'] as const
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Reject control data atomically; exact identifiers are never previewed or shortened. */
export function parseSubagentDiscoveryPage(raw: unknown): SubagentDiscoveryPage {
  if (!object(raw) || raw.protocolVersion !== 1 || raw.source !== 'durable-lifecycle' ||
    typeof raw.generation !== 'string' || !raw.generation || !object(raw.scope) ||
    !['active', 'changes'].includes(String(raw.mode)) || !Array.isArray(raw.items) ||
    !['asOfRevision', 'floorRevision', 'activeCount', 'includedCount', 'scannedCount'].every(key => integer(raw[key])) ||
    (raw.floorRevision as number) > (raw.asOfRevision as number) || raw.includedCount !== raw.items.length ||
    (raw.scannedCount as number) < raw.items.length || (raw.scannedCount as number) > 200 ||
    raw.mode === 'active' && (raw.scannedCount !== raw.items.length || (raw.activeCount as number) < raw.items.length) ||
    raw.hasMore === true && raw.scannedCount === 0 ||
    typeof raw.hasMore !== 'boolean' || raw.membershipCompleteness !== (raw.hasMore ? 'partial' : 'complete') ||
    (raw.hasMore ? typeof raw.nextCursor !== 'string' || !raw.nextCursor : raw.nextCursor !== null) ||
    (raw.mode === 'changes' ? !integer(raw.nextRevision) || (raw.nextRevision as number) > (raw.asOfRevision as number)
      : raw.nextRevision !== undefined)) throw new Error('子代理发现页协议无效')
  const scope = raw.scope
  if (!['tenantId', 'parentSessionId'].every(key => typeof scope[key] === 'string' && !!scope[key]) ||
    ['rootSessionId', 'parentConversationId'].some(key => scope[key] !== undefined && (typeof scope[key] !== 'string' || !scope[key])))
    throw new Error('子代理发现归属无效')
  const items: SubagentDiscoveryRef[] = []
  let previous = -1
  for (const value of raw.items) {
    if (!object(value) || !['revision', 'createdRevision', 'runSeq'].every(key => integer(value[key])) ||
      !statuses.includes(String(value.status)) || typeof value.deleted !== 'boolean' ||
      identityKeys.filter(key => !['createdAt', 'agentId', 'agentName'].includes(key)).some(key =>
        typeof value[key] !== 'string' || !value[key]) ||
      !integer(value.createdAt) || ['agentId', 'agentName'].some(key => value[key] !== undefined && typeof value[key] !== 'string') ||
      (value.revision as number) > (raw.asOfRevision as number) || (value.createdRevision as number) > (value.revision as number) ||
      value.tenantId !== scope.tenantId || value.parentSessionId !== scope.parentSessionId ||
      scope.rootSessionId !== undefined && value.rootSessionId !== scope.rootSessionId ||
      scope.parentConversationId !== undefined && value.parentConversationId !== scope.parentConversationId ||
      raw.mode === 'active' && (value.deleted || !active(String(value.status)))) throw new Error('子代理发现身份或版本无效')
    // The existing exact-summary reducer cannot hydrate these identities. A
    // visible admission error is safer than advancing past an unusable run.
    if ((value.runId as string).length > 1024 || identityKeys.some(key =>
      typeof value[key] === 'string' && (value[key] as string).length > 4096)) throw new Error('子代理发现身份超出摘要支持范围')
    const key = raw.mode === 'active' ? value.createdRevision as number : value.revision as number
    if (key <= previous) throw new Error('子代理发现页未严格推进')
    previous = key
    const picked = Object.fromEntries([...identityKeys, 'revision', 'createdRevision', 'runSeq', 'status', 'deleted']
      .filter(key => value[key] !== undefined).map(key => [key, value[key]]))
    items.push(picked as unknown as SubagentDiscoveryRef)
  }
  const page = { ...raw, scope: { tenantId: scope.tenantId, parentSessionId: scope.parentSessionId,
    ...(scope.rootSessionId !== undefined ? { rootSessionId: scope.rootSessionId } : {}),
    ...(scope.parentConversationId !== undefined ? { parentConversationId: scope.parentConversationId } : {}) }, items } as unknown as SubagentDiscoveryPage
  if (bytes({ code: 200, message: '操作成功', data: raw, timestamp: Number.MAX_SAFE_INTEGER }) > DISCOVERY_MAX_BYTES)
    throw new Error('子代理发现页超出响应预算')
  return page
}

export interface SubagentDiscoveryClientScope {
  source: number
  expectedEngine: EngineRequestInput['expectedEngine']
  parentSessionId: string
  rootSessionId?: string
  parentConversationId?: string
  localEpoch: number
}
interface DiscoveryLane {
  upper: number
  cursor?: string
  key: number
  after?: number
  complete: boolean
  cursors: string[]
  activeCount: number
}
export interface SubagentDiscoveryState {
  scope: SubagentDiscoveryClientScope
  epoch: number
  generation?: string
  tenantId?: string
  baseline?: DiscoveryLane
  changes?: DiscoveryLane
  refs: Map<string, { ref: SubagentDiscoveryRef; hydrated: boolean }>
  activeCount?: number
  countRevision?: number
  latestRevision: number
  lastSuccessAt?: number
  baselineAt?: number
  residentPartial: boolean
  stale: boolean
  recoveryRequired?: boolean
  error?: string
  nextMode: 'active' | 'changes'
}
export interface SubagentDiscoveryRead {
  scope: SubagentDiscoveryClientScope
  epoch: number
  generation?: string
  mode: 'active' | 'changes'
  cursor?: string
  afterRevision?: number
}
export function createSubagentDiscovery(scope: SubagentDiscoveryClientScope): SubagentDiscoveryState {
  const state: SubagentDiscoveryState = { scope, epoch: 0, refs: new Map(), latestRevision: 0, residentPartial: true, stale: false, nextMode: 'active' }
  if (subagentDiscoveryBytes(state) > DISCOVERY_MAX_BYTES) throw new Error('子代理发现归属超出预算')
  return state
}
export function subagentDiscoveryBytes(state: SubagentDiscoveryState): number {
  return bytes({ ...state, refs: [...state.refs] })
}
function sameScope(a: SubagentDiscoveryClientScope, b: SubagentDiscoveryClientScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
export function subagentDiscoveryRead(state: SubagentDiscoveryState, mode = state.nextMode): SubagentDiscoveryRead {
  const selected = mode === 'changes' && state.baseline ? 'changes' : 'active'
  const lane = selected === 'active' ? state.baseline : state.changes
  return { scope: state.scope, epoch: state.epoch, generation: state.generation, mode: selected,
    ...(lane?.cursor ? { cursor: lane.cursor } : {}),
    ...(selected === 'changes' ? { afterRevision: lane?.cursor ? lane.after : lane?.key ?? state.baseline!.upper } : {}) }
}
export function restartSubagentDiscovery(state: SubagentDiscoveryState, reason: string): SubagentDiscoveryState {
  // Invalidate every old W operation before releasing a terminal/tombstone fence.
  return { ...state, epoch: state.epoch + 1, baseline: undefined, changes: undefined,
    baselineAt: undefined,
    refs: new Map([...state.refs].filter(([, entry]) => !entry.hydrated)), residentPartial: true,
    nextMode: 'active', stale: true, recoveryRequired: true, error: reason }
}
export function acknowledgeSubagentDiscoveryRef(state: SubagentDiscoveryState, runId: string, revision: number): SubagentDiscoveryState {
  const entry = state.refs.get(runId)
  if (!entry || entry.ref.revision !== revision || entry.hydrated) return state
  const refs = new Map(state.refs)
  const fence = state.baseline && !state.baseline.complete && entry.ref.revision > state.baseline.upper
  if (fence) refs.set(runId, { ...entry, hydrated: true })
  else refs.delete(runId)
  return { ...state, refs }
}
export function sameSubagentDiscoveryIdentity(a: SubagentDiscoveryRef, b: SubagentDiscoveryRef): boolean {
  return identityKeys.every(key => a[key] === b[key])
}
export type SubagentDiscoveryReduceResult = { status: 'applied' | 'rejected' | 'recovery'; state: SubagentDiscoveryState; reason?: string }

/** Fixed lifecycle boundaries and request identity are independent of the resident card cache. */
export function reduceSubagentDiscovery(state: SubagentDiscoveryState, input: SubagentDiscoveryRead,
  raw: unknown, now: number): SubagentDiscoveryReduceResult {
  const reject = (reason: string): SubagentDiscoveryReduceResult => ({ status: 'rejected', state, reason })
  if (!sameScope(state.scope, input.scope) || state.epoch !== input.epoch || state.generation !== input.generation)
    return reject('stale-operation')
  let page: SubagentDiscoveryPage
  try { page = parseSubagentDiscoveryPage(raw) } catch (cause) { return reject(cause instanceof Error ? cause.message : String(cause)) }
  if (page.mode !== input.mode || page.scope.parentSessionId !== state.scope.parentSessionId ||
    page.scope.rootSessionId !== state.scope.rootSessionId || page.scope.parentConversationId !== state.scope.parentConversationId ||
    state.tenantId !== undefined && page.scope.tenantId !== state.tenantId) return reject('scope-mismatch')
  if (state.generation && page.generation !== state.generation) return {
    status: 'recovery', state: { ...restartSubagentDiscovery(state, '子代理历史已变化，正在重新发现'),
      generation: page.generation, tenantId: page.scope.tenantId, refs: new Map(), latestRevision: 0,
      activeCount: undefined, countRevision: undefined }, reason: 'generation-changed'
  }
  const lane = input.mode === 'active' ? state.baseline : state.changes
  if (input.cursor !== lane?.cursor || input.cursor && (lane?.upper !== page.asOfRevision || input.cursor === page.nextCursor || lane?.cursors.includes(page.nextCursor ?? '')))
    return reject('cursor-mismatch')
  const priorKey = input.mode === 'active' ? lane?.key ?? 0 : input.cursor ? lane?.key ?? 0 : input.afterRevision ?? 0
  if (input.mode === 'changes' && (page.asOfRevision < (input.afterRevision ?? 0) ||
    (input.afterRevision ?? 0) < page.floorRevision ||
    page.nextRevision! < priorKey || page.hasMore && page.nextRevision! <= priorKey ||
    (page.items.at(-1)?.revision ?? priorKey) > page.nextRevision! ||
    !page.hasMore && page.nextRevision !== page.asOfRevision)) return reject('revision-mismatch')
  if (page.items.some(ref => (input.mode === 'active' ? ref.createdRevision : ref.revision) <= priorKey)) return reject('page-not-advancing')
  if (input.cursor && lane && lane.activeCount !== page.activeCount) return reject('count-mismatch')
  const refs = new Map(state.refs)
  for (const ref of page.items) {
    const old = refs.get(ref.runId)
    if (old && (!sameSubagentDiscoveryIdentity(old.ref, ref) || old.ref.createdRevision !== ref.createdRevision ||
      ref.runSeq === old.ref.runSeq && (ref.status !== old.ref.status || ref.revision === old.ref.revision && ref.deleted !== old.ref.deleted)))
      return reject('identity-or-version-conflict')
    if (old && ref.revision > old.ref.revision && ref.runSeq >= old.ref.runSeq && !active(old.ref.status) && active(ref.status))
      return reject('terminal-revival')
    if (old && (old.ref.revision > ref.revision || old.ref.runSeq > ref.runSeq ||
      old.ref.deleted || !active(old.ref.status) && active(ref.status))) continue
    refs.set(ref.runId, { ref, hydrated: old?.hydrated === true && old.ref.revision === ref.revision })
  }
  const nextLane: DiscoveryLane = { upper: page.asOfRevision, activeCount: page.activeCount, key: input.mode === 'active'
    ? page.items.at(-1)?.createdRevision ?? priorKey : page.nextRevision!,
    ...(input.mode === 'changes' ? { after: input.cursor ? lane?.after : input.afterRevision } : {}),
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}), complete: !page.hasMore,
    cursors: page.nextCursor ? [...(lane?.cursors ?? []), page.nextCursor].slice(-3) : [] }
  if (input.mode === 'active' && nextLane.complete) for (const [id, entry] of refs) if (entry.hydrated) refs.delete(id)
  const next: SubagentDiscoveryState = { ...state, generation: page.generation, tenantId: page.scope.tenantId, refs,
    ...(input.mode === 'active' && !input.cursor ? { baselineAt: now } : {}),
    ...(input.mode === 'active' ? { baseline: nextLane } : { changes: nextLane }),
    ...(state.countRevision === undefined || page.asOfRevision >= state.countRevision
      ? { activeCount: page.activeCount, countRevision: page.asOfRevision } : {}),
    latestRevision: Math.max(state.latestRevision, page.asOfRevision), lastSuccessAt: now,
    residentPartial: true, stale: false, recoveryRequired: false, error: undefined,
    nextMode: input.mode === 'active' ? 'changes' : state.baseline?.complete ? 'changes' : 'active' }
  if (refs.size > DISCOVERY_MAX_REFS || subagentDiscoveryBytes(next) > DISCOVERY_MAX_BYTES) {
    if ([...state.refs.values()].some(entry => entry.hydrated)) return {
      status: 'recovery', state: restartSubagentDiscovery(state, '发现引用达到预算，重新同步活跃任务'), reason: 'fence-budget'
    }
    return reject('发现引用达到预算，请先同步待加载任务')
  }
  return { status: 'applied', state: next }
}
