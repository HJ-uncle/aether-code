import { useSyncExternalStore } from 'react'
import { getEngineSource, getExpectedEngine, subscribeEngineSource } from './source'
import type { SubagentRun, SubagentRunsPage, SubagentDiscoveryRef } from '@shared/subagent'
import { cancelSubagentRun, getSubagentRun, listSubagentRuns, captureSubagentConnection,
  assertSubagentConnection, getSubagentCapabilities, listSubagentDiscovery, SubagentDiscoveryError,
  type SubagentConnection } from './client'
import { executeSubagentRefreshBatch, subagentRefreshBatch, executeSubagentObservationCycle } from './subagent-refresh'
import { createSubagentDiscovery, reduceSubagentDiscovery, subagentDiscoveryRead, subagentDiscoveryBytes,
  restartSubagentDiscovery, acknowledgeSubagentDiscoveryRef, sameSubagentDiscoveryIdentity,
  type SubagentDiscoveryState } from './subagent-discovery'
import { createSubagentDirectory, reduceSubagentDirectory, subagentDirectoryResidentBytes, type SubagentDirectoryState } from './subagent-directory'
import { utf8BytePreview } from './utf8-preview'
import {
  isSubagentActive,
  boundSubagentView,
  normalizeSubagentRun,
  reduceSubagentEvent,
  reduceSubagentRun,
  subagentResidentBytes,
  toSubagentView,
  SUBAGENT_CACHE_MAX_BYTES,
  type SubagentReduceResult
} from './subagent-state'

const runs = new Map<string, SubagentRun>()
const listeners = new Set<() => void>()
interface SubagentDeletionObservation {
  source: number
  parentSessionId: string
  refs: readonly SubagentDiscoveryRef[]
}
const deletionListeners = new Set<(observation: SubagentDeletionObservation) => void>()
const requests = new Map<string, { kind: 'head' | 'more'; restart: boolean; promise: Promise<void> }>()
export interface SubagentDirectorySnapshot {
  directory?: SubagentDirectoryState
  loading: boolean
  loadingMore: boolean
  error?: string
}
const directories = new Map<string, SubagentDirectorySnapshot>()
const MAX_DIRECTORY_BYTES = 1024 * 1024
const runRequests = new Map<string, Promise<void>>()
const activeRequests = new Map<string, Promise<void>>()
const activeRefresh = new Map<string, { afterRunId?: string; nextAt: number }>()
export interface SubagentDiscoverySnapshot {
  state?: SubagentDiscoveryState
  supported?: boolean
  loading: boolean
  stale: boolean
  error?: string
}
const discovery = new Map<string, SubagentDiscoverySnapshot>()
const cycles = new Map<string, { promise: Promise<void>; selectedRunId?: string }>()
const cycleNextAt = new Map<string, number>()
const pendingAnchors = new Map<string, string>()
const runGenerations = new Map<string, string | undefined>()
let discoveryVersion = 0
const discoveryVersions = new Map<string, number>()
const access = new Map<string, number>()
const residentSizes = new Map<string, number>()
let residentBytes = 0
let cacheClock = 0
let cacheGeneration = 0
let evictedRunCount = 0
let notificationDepth = 0
let notificationPending = false

export type SubagentIngestResult = SubagentReduceResult

function notify(): void {
  if (notificationDepth) { notificationPending = true; return }
  for (const listener of listeners) listener()
}

function publishDirectory(parentSessionId: string, value: SubagentDirectorySnapshot): void {
  directories.delete(parentSessionId)
  directories.set(parentSessionId, value)
  let bytes = [...directories.values()].reduce((sum, entry) => sum + (entry.directory?.residentBytes ?? 0) + 4096, 0)
  while (directories.size > 32 || bytes > MAX_DIRECTORY_BYTES) {
    const id = directories.keys().next().value!
    bytes -= (directories.get(id)?.directory?.residentBytes ?? 0) + 4096
    directories.delete(id)
  }
  notify()
}

export function getSubagentDirectory(parentSessionId: string | null): SubagentDirectorySnapshot {
  return parentSessionId ? directories.get(parentSessionId) ?? { loading: false, loadingMore: false }
    : { loading: false, loadingMore: false }
}

function cacheRun(run: SubagentRun): void {
  const bytes = subagentResidentBytes(run)
  residentBytes += bytes - (residentSizes.get(run.runId) ?? 0)
  residentSizes.set(run.runId, bytes)
  runs.set(run.runId, run)
}

function removeCachedRun(id: string): void {
  residentBytes -= residentSizes.get(id) ?? 0
  residentSizes.delete(id)
  runs.delete(id)
  access.delete(id)
  runGenerations.delete(id)
}

/** Detail LRU is a resident-memory policy, never a stop policy for durable tasks. */
export function enforceSubagentCacheBudget(): void {
  if (residentBytes <= SUBAGENT_CACHE_MAX_BYTES) return
  const oldest = [...runs.values()].sort(
    (a, b) => (access.get(a.runId) ?? 0) - (access.get(b.runId) ?? 0)
  )
  for (const run of oldest.filter((run) => !isSubagentActive(run.status))) {
    if (residentBytes <= SUBAGENT_CACHE_MAX_BYTES) break
    if (!run.toolCalls.length) continue
    const trimmed = boundSubagentView(toSubagentView(run), 16 * 1024, 0)
    cacheRun(trimmed)
  }
  for (const run of oldest.filter((run) => isSubagentActive(run.status))) {
    if (residentBytes <= SUBAGENT_CACHE_MAX_BYTES) break
    // Keep latest activity and absolute active counts even when older resident samples must page out.
    if (run.toolCalls.length) cacheRun(boundSubagentView(toSubagentView(run), 32 * 1024, 0))
  }
  // Unbounded child creation cannot retain every header in a fixed-size cache; pages remain durable.
  for (const run of oldest.sort(
    (a, b) => Number(isSubagentActive(a.status)) - Number(isSubagentActive(b.status))
  )) {
    if (residentBytes <= SUBAGENT_CACHE_MAX_BYTES) break
    const current = runs.get(run.runId)
    if (!current) continue
    removeCachedRun(run.runId)
    evictedRunCount++
  }
}

export function getSubagentCacheStats(): {
  residentBytes: number
  residentRuns: number
  evictedRunCount: number
} {
  return { residentBytes, residentRuns: runs.size, evictedRunCount }
}

function commit(result: SubagentIngestResult): SubagentIngestResult {
  if ((result.status === 'applied' || result.status === 'verified-duplicate') && result.run) {
    if (result.status === 'verified-duplicate' && runs.get(result.run.runId) === result.run) {
      access.set(result.run.runId, ++cacheClock)
      return result
    }
    const next = toSubagentView(result.run)
    const previous = runs.get(next.runId)
    cacheRun(next)
    access.set(next.runId, ++cacheClock)
    enforceSubagentCacheBudget()
    if (next !== previous) notify()
    return { ...result, run: runs.get(next.runId) ?? next }
  }
  return result
}

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function subscribeSubagentDeletions(listener: (observation: SubagentDeletionObservation) => void): () => void {
  deletionListeners.add(listener)
  return () => { deletionListeners.delete(listener) }
}

export function ingestSubagentRun(raw: unknown): SubagentRun | undefined {
  const result = ingestSubagentRunResult(raw)
  return result.status === 'applied' || result.status === 'verified-duplicate'
    ? result.run
    : undefined
}

export function ingestSubagentRunResult(raw: unknown): SubagentIngestResult {
  const id =
    raw && typeof raw === 'object' && 'runId' in raw && typeof raw.runId === 'string'
      ? raw.runId
      : undefined
  return commit(reduceSubagentRun(id ? runs.get(id) : undefined, raw))
}

export function ingestSubagentEvent(raw: unknown): SubagentRun | undefined {
  const result = ingestSubagentEventResult(raw)
  return result.status === 'applied' || result.status === 'verified-duplicate'
    ? result.run
    : undefined
}

export function ingestSubagentEventResult(raw: unknown): SubagentIngestResult {
  const id =
    raw && typeof raw === 'object' && 'runId' in raw && typeof raw.runId === 'string'
      ? raw.runId
      : undefined
  return commit(reduceSubagentEvent(id ? runs.get(id) : undefined, raw))
}

export function getSubagentRuns(parentSessionId: string | null): SubagentRun[] {
  return parentSessionId
    ? [...runs.values()].filter((run) => run.parentSessionId === parentSessionId)
    : []
}

export function getSubagentDiscovery(parentSessionId: string | null): SubagentDiscoverySnapshot {
  return parentSessionId ? discovery.get(parentSessionId) ?? { loading: false, stale: false }
    : { loading: false, stale: false }
}
export function getSubagentDiscoveryStats(): { parentCount: number; residentBytes: number; pendingRefs: number } {
  return { parentCount: discovery.size, residentBytes: [...discovery.values()].reduce((sum, entry) =>
    sum + (entry.state ? subagentDiscoveryBytes(entry.state) : 0) + 4096, 0),
    pendingRefs: [...discovery.values()].reduce((sum, entry) => sum + (entry.state?.refs.size ?? 0), 0) }
}
function publishDiscovery(parentSessionId: string, snapshot: SubagentDiscoverySnapshot): void {
  const before = discovery.get(parentSessionId)?.state
  discovery.delete(parentSessionId)
  discovery.set(parentSessionId, snapshot)
  const after = snapshot.state
  if (after && (!before || before.generation !== after.generation || before.epoch !== after.epoch ||
    before.baseline?.key !== after.baseline?.key || before.changes?.key !== after.changes?.key))
    discoveryVersions.set(parentSessionId, ++discoveryVersion)
  let bytes = [...discovery.values()].reduce((sum, item) => sum + (item.state ? subagentDiscoveryBytes(item.state) : 0) + 4096, 0)
  while (discovery.size > 32 || bytes > 1024 * 1024) {
    const id = discovery.keys().next().value!
    if (id === parentSessionId && discovery.size === 1) break
    bytes -= (discovery.get(id)?.state ? subagentDiscoveryBytes(discovery.get(id)!.state!) : 0) + 4096
    discovery.delete(id)
    discoveryVersions.delete(id)
    cycleNextAt.delete(id)
    pendingAnchors.delete(id)
  }
  notify()
}
export interface SubagentRunObservationScope {
  connection: SubagentConnection
  localEpoch: number
  serverGeneration?: string
  identity: Pick<SubagentRun, 'runId' | 'tenantId' | 'parentSessionId' | 'rootSessionId' | 'parentConversationId' | 'parentToolCallId' | 'childSessionId'>
}
export function captureSubagentRunScope(run: SubagentRun | SubagentDiscoveryRef, source = getEngineSource()): SubagentRunObservationScope {
  return { connection: { ...captureSubagentConnection(), source }, localEpoch: cacheGeneration,
    serverGeneration: 'revision' in run ? discovery.get(run.parentSessionId)?.state?.generation
      : runGenerations.get(run.runId) ?? discovery.get(run.parentSessionId)?.state?.generation,
    identity: { runId: run.runId, tenantId: run.tenantId, parentSessionId: run.parentSessionId,
      rootSessionId: run.rootSessionId, parentConversationId: run.parentConversationId,
      parentToolCallId: run.parentToolCallId, childSessionId: run.childSessionId } }
}
function assertRunScope(scope: SubagentRunObservationScope, reading = false): void {
  assertSubagentConnection(scope.connection)
  const state = discovery.get(scope.identity.parentSessionId)?.state
  if (scope.localEpoch !== cacheGeneration || scope.serverGeneration !== undefined && state?.generation !== scope.serverGeneration)
    throw new Error('子代理归属已变化，请刷新后重试')
  if (!reading && state?.recoveryRequired) throw new Error('子代理归属尚未恢复，请刷新后再停止该运行')
  const current = runs.get(scope.identity.runId)
  if (!reading && !current) throw new Error('子代理缺少当前准确摘要，请刷新后再停止该运行')
  const quarantined = reading && runGenerations.has(scope.identity.runId) && runGenerations.get(scope.identity.runId) !== state?.generation
  if (current && !quarantined && Object.entries(scope.identity).some(([key, value]) => current[key as keyof SubagentRun] !== value))
    throw new Error('子代理运行身份已变化，请刷新后重试')
  if (state?.refs.get(scope.identity.runId)?.ref.deleted) throw new Error('该子代理运行已删除')
}
function matchesRef(run: SubagentRun, ref: SubagentDiscoveryRef): boolean {
  return sameSubagentDiscoveryIdentity({ ...ref, ...run }, ref) && run.lastSeq >= ref.runSeq &&
    (run.lastSeq !== ref.runSeq || run.status === ref.status)
}

const noSubscription = (): (() => void) => () => {}
export function useSubagentRun(runId: string | undefined, enabled = true): SubagentRun | undefined {
  return useSyncExternalStore(enabled ? subscribeSubagents : noSubscription, () => (runId ? runs.get(runId) : undefined))
}

export function forgetSubagentSession(parentSessionId: string): void {
  cacheGeneration++
  requests.delete(parentSessionId)
  directories.delete(parentSessionId)
  activeRequests.delete(parentSessionId)
  activeRefresh.delete(parentSessionId)
  discovery.delete(parentSessionId)
  discoveryVersions.delete(parentSessionId)
  cycles.delete(parentSessionId)
  cycleNextAt.delete(parentSessionId)
  pendingAnchors.delete(parentSessionId)
  for (const [id, run] of runs) if (run.parentSessionId === parentSessionId) removeCachedRun(id)
  for (const listener of listeners) listener()
}

async function readSubagentDirectory(parentSessionId: string, kind: 'head' | 'more', restart = false): Promise<void> {
  const source = getEngineSource()
  const generation = cacheGeneration
  const lifecycleVersion = discoveryVersions.get(parentSessionId)
  const pending = requests.get(parentSessionId)
  if (pending) {
    if (restart && !pending.restart) {
      await pending.promise.catch(() => {})
      if (source === getEngineSource() && generation === cacheGeneration) return readSubagentDirectory(parentSessionId, 'head', true)
      return
    }
    if (kind === 'more' && pending.kind === 'head') {
      await pending.promise
      if (source === getEngineSource() && generation === cacheGeneration) return readSubagentDirectory(parentSessionId, kind)
      return
    }
    return pending.promise
  }
  const previous = getSubagentDirectory(parentSessionId)
  const inputCursor = kind === 'more' ? previous.directory?.nextCursor : undefined
  if (kind === 'more' && !inputCursor) return
  const before = new Map(getSubagentRuns(parentSessionId).map((run) => [run.runId, run]))
  const request = (async () => {
    const result = await listSubagentRuns(parentSessionId, inputCursor ? { cursor: inputCursor } : {})
    if (source !== getEngineSource() || generation !== cacheGeneration) return
    if (lifecycleVersion !== discoveryVersions.get(parentSessionId))
      throw new Error('子代理生命周期已更新，请重试目录页')
    const page = result as SubagentRunsPage
    const incoming = page.runs.map(normalizeSubagentRun)
    const anchor = before.values().next().value
    if (
      incoming.some(
        (run) =>
          !run ||
          run.parentSessionId !== parentSessionId ||
          (anchor &&
            (run.tenantId !== anchor.tenantId || run.rootSessionId !== anchor.rootSessionId))
      )
    )
      throw new Error('子代理列表协议或会话归属不一致')
    const currentIds = new Set(incoming.map((run) => run!.runId))
    if (currentIds.size !== incoming.length) throw new Error('子代理列表包含重复身份')
    const scope = { source, generation, parentSessionId, expectedEngine: getExpectedEngine() }
    let directory = previous.directory ?? createSubagentDirectory(scope, page.schemaVersion, anchor ? {
      tenantId: anchor.tenantId, rootSessionId: anchor.rootSessionId
    } : undefined)
    // Forget invalidates outstanding reads globally, but unrelated retained
    // directories still belong to this same connection and parent session.
    if (directory.scope.source === source && directory.scope.generation !== generation) {
      directory = { ...directory, scope, residentBytes: 0 }
      directory.residentBytes = subagentDirectoryResidentBytes(directory)
    }
    const reduced = reduceSubagentDirectory(directory, { scope, inputCursor, page, updatedAt: Date.now(), restart })
    if (reduced.status === 'rejected') throw new Error(`子代理目录更新失败：${reduced.reason}`)
    // Reject the entire response before committing either the cursor or views.
    const updates = incoming.map(run => reduceSubagentRun(runs.get(run!.runId), run))
    if (updates.some(update => update.status === 'invalid' || update.status === 'gap'))
      throw new Error('子代理列表状态或序列冲突，请更新列表后重试')
    let removed = false
    notificationDepth++
    try {
      for (const [id, snapshot] of before) {
        // Authoritative list deletion must not erase a snapshot that arrived while the request was in flight.
        if (!inputCursor && page.listComplete && !page.hasMore && !currentIds.has(id) && runs.get(id) === snapshot &&
          !isSubagentActive(snapshot.status) && !discovery.get(parentSessionId)?.state?.refs.has(id)) {
          removeCachedRun(id)
          removed = true
        }
      }
      for (const update of updates) commit(update)
      publishDirectory(parentSessionId, { directory: reduced.state, loading: false, loadingMore: false })
      if (removed) notify()
    } finally {
      notificationDepth--
      if (!notificationDepth && notificationPending) { notificationPending = false; notify() }
    }
  })()
  const operation = { kind, restart, promise: request }
  requests.set(parentSessionId, operation)
  publishDirectory(parentSessionId, { ...previous, loading: true, loadingMore: kind === 'more', error: undefined })
  try {
    await request
  } catch (cause) {
    if (source === getEngineSource() && generation === cacheGeneration)
      publishDirectory(parentSessionId, { ...previous, loading: false, loadingMore: false,
        error: utf8BytePreview(cause instanceof Error ? cause.message : String(cause), 2048) })
    throw cause
  } finally {
    if (requests.get(parentSessionId) === operation) {
      requests.delete(parentSessionId)
      const entry = directories.get(parentSessionId)
      if (source === getEngineSource() && entry?.loading)
        publishDirectory(parentSessionId, { ...entry, loading: false, loadingMore: false })
    }
  }
}

export async function loadMoreSubagentRuns(parentSessionId: string): Promise<void> {
  await readSubagentDirectory(parentSessionId, 'more')
}

export async function restartSubagentDirectory(parentSessionId: string): Promise<void> {
  await readSubagentDirectory(parentSessionId, 'head', true)
}

export async function refreshSubagentRuns(parentSessionId: string, options: { selectedRunId?: string; force?: boolean } = {}): Promise<void> {
  const pending = cycles.get(parentSessionId)
  if (pending) {
    if (options.selectedRunId) pending.selectedRunId = options.selectedRunId
    return pending.promise
  }
  if (!options.force && Date.now() < (cycleNextAt.get(parentSessionId) ?? 0)) return
  if (cycles.size >= 32) throw new Error('子代理观察会话达到预算，请稍后重试')
  const source = getEngineSource()
  const generation = cacheGeneration
  const connection = captureSubagentConnection()
  const current = (): boolean => source === getEngineSource() && generation === cacheGeneration
  const operation: { promise: Promise<void>; selectedRunId?: string } = { promise: Promise.resolve(), selectedRunId: options.selectedRunId }
  cycleNextAt.delete(parentSessionId)
  cycleNextAt.set(parentSessionId, Date.now() + 5000)
  while (cycleNextAt.size > 32) cycleNextAt.delete(cycleNextAt.keys().next().value!)
  const work = (async (): Promise<void> => {
    // Always reserve one slot for negotiation, even when the source cache is
    // warm. A cold capability GET is an actual request in the eight budget.
    const capabilities = await getSubagentCapabilities(connection)
    if (!current()) return
    if (!capabilities.discovery) {
      publishDiscovery(parentSessionId, { supported: false, loading: false, stale: false })
      let failure: unknown, failed = false
      try { await readSubagentDirectory(parentSessionId, 'head') }
      catch (cause) { failed = true; failure = cause }
      if (!current()) return
      const batch = subagentRefreshBatch(getSubagentRuns(parentSessionId), options.selectedRunId,
        activeRefresh.get(parentSessionId)?.afterRunId, 6)
      activeRefresh.set(parentSessionId, { afterRunId: batch.afterRunId, nextAt: Date.now() + 4500 })
      try { await executeSubagentRefreshBatch(batch.ids, id => refreshSubagentRun(id), current) }
      catch (cause) { if (!failed) { failed = true; failure = cause } }
      if (failed) throw failure
      return
    }
    const previous = getSubagentDiscovery(parentSessionId)
    let state = previous.state ?? createSubagentDiscovery({ source, expectedEngine: connection.expectedEngine,
      localEpoch: generation, parentSessionId })
    if (state.scope.localEpoch !== generation) state = { ...state, epoch: state.epoch + 1,
      scope: { ...state.scope, localEpoch: generation } }
    if (state.baseline?.complete && Date.now() - (state.baselineAt ?? 0) > 60000)
      state = restartSubagentDiscovery(state, '正在重新核对活跃任务')
    publishDiscovery(parentSessionId, { state, supported: true, loading: true, stale: state.stale, error: state.error })
    const previousAnchor = activeRefresh.get(parentSessionId)?.afterRunId
    const known = subagentRefreshBatch(getSubagentRuns(parentSessionId), undefined, previousAnchor, 7).ids
    let lastKnown = previousAnchor
    try { await executeSubagentObservationCycle({ current,
      candidates: () => {
        const latest = discovery.get(parentSessionId)?.state
        const pending = latest ? [...latest.refs].filter(([, entry]) => !entry.hydrated && !entry.ref.deleted).map(([id]) => id) : []
        const anchor = pending.indexOf(pendingAnchors.get(parentSessionId) ?? '')
        const pendingIds = [...pending.slice(anchor + 1), ...pending.slice(0, anchor + 1)]
        return { selectedRunId: operation.selectedRunId, knownIds: known, pendingIds,
          modes: latest ? latest.baseline ? [latest.nextMode, latest.nextMode === 'active' ? 'changes' : 'active'].filter(mode =>
            mode !== 'active' || !latest.baseline?.complete) as Array<'active' | 'changes'> : ['active'] : [] }
      },
      read: async job => {
        if (job.kind === 'summary') {
          if (known.includes(job.runId)) lastKnown = job.runId
          if (discovery.get(parentSessionId)?.state?.refs.has(job.runId)) {
            pendingAnchors.delete(parentSessionId)
            pendingAnchors.set(parentSessionId, job.runId)
            while (pendingAnchors.size > 32) pendingAnchors.delete(pendingAnchors.keys().next().value!)
          }
          await refreshSubagentRun(job.runId)
          return
        }
        const entry = discovery.get(parentSessionId)
        const before = entry?.state
        if (!before) return
        const input = subagentDiscoveryRead(before, job.mode)
        try {
          const page = await listSubagentDiscovery({ parentSessionId }, { mode: input.mode, cursor: input.cursor,
            afterRevision: input.afterRevision, limit: 64 }, connection)
          if (!current()) return
          const latest = discovery.get(parentSessionId)?.state
          if (!latest) return
          const result = reduceSubagentDiscovery(latest, input, page, Date.now())
          if (result.status === 'rejected') {
            if (result.reason === 'stale-operation') return
            throw new Error(result.reason ?? '子代理发现状态冲突')
          }
          publishDiscovery(parentSessionId, { state: result.state, supported: true, loading: true,
            stale: result.state.stale, error: result.state.error })
          const deleted = [...result.state.refs.values()].filter(entry => entry.ref.deleted).map(entry => entry.ref)
          for (const ref of deleted) removeCachedRun(ref.runId)
          if (deleted.length) {
            // Only a validated, source-fenced lifecycle page can retire a
            // message projection. Cache eviction and list absence cannot.
            const observation = { source, parentSessionId, refs: deleted }
            for (const listener of deletionListeners) listener(observation)
          }
          for (const ref of result.state.refs.values()) {
            if (ref.ref.deleted) {
              const latestState = discovery.get(parentSessionId)?.state
              if (latestState) publishDiscovery(parentSessionId, { ...discovery.get(parentSessionId)!,
                state: acknowledgeSubagentDiscoveryRef(latestState, ref.ref.runId, ref.ref.revision) })
            }
          }
        } catch (cause) {
          if (!current()) return
          const latest = discovery.get(parentSessionId)?.state
          if (cause instanceof SubagentDiscoveryError && cause.discoveryRequired && latest &&
            ['generation_changed', 'retention_gap'].includes(cause.reason ?? ''))
            publishDiscovery(parentSessionId, { state: restartSubagentDiscovery(latest, cause.message), supported: true,
              loading: true, stale: true, error: cause.message })
          throw cause
        }
      }
    }) } finally {
      if (current()) {
        activeRefresh.set(parentSessionId, { afterRunId: lastKnown, nextAt: Date.now() + 4500 })
        while (activeRefresh.size > 32) activeRefresh.delete(activeRefresh.keys().next().value!)
      }
    }
  })()
  operation.promise = work
  cycles.set(parentSessionId, operation)
  try { await work }
  catch (cause) {
    if (current() && cycles.get(parentSessionId) === operation) {
      const entry = getSubagentDiscovery(parentSessionId)
      const error = utf8BytePreview(cause instanceof Error ? cause.message : String(cause), 2048)
      publishDiscovery(parentSessionId, { ...entry, loading: false, stale: true, error,
        ...(entry.state ? { state: { ...entry.state, stale: true, error } } : {}) })
    }
    throw cause
  } finally {
    if (cycles.get(parentSessionId) === operation) {
      cycles.delete(parentSessionId)
      if (current()) publishDiscovery(parentSessionId, { ...getSubagentDiscovery(parentSessionId), loading: false })
    }
  }
}

export async function refreshKnownActiveSubagents(parentSessionId: string, selectedRunId?: string): Promise<void> {
  const pending = activeRequests.get(parentSessionId)
  if (pending) return pending
  const previous = activeRefresh.get(parentSessionId)
  if (previous && Date.now() < previous.nextAt) return
  const source = getEngineSource()
  const generation = cacheGeneration
  const batch = subagentRefreshBatch(getSubagentRuns(parentSessionId), selectedRunId, previous?.afterRunId, 7)
  activeRefresh.delete(parentSessionId)
  activeRefresh.set(parentSessionId, { afterRunId: batch.afterRunId, nextAt: Date.now() + 4500 })
  while (activeRefresh.size > 32) activeRefresh.delete(activeRefresh.keys().next().value!)
  const request = executeSubagentRefreshBatch(batch.ids, refreshSubagentRun,
    () => source === getEngineSource() && generation === cacheGeneration)
  activeRequests.set(parentSessionId, request)
  try { await request }
  finally { if (activeRequests.get(parentSessionId) === request) activeRequests.delete(parentSessionId) }
}

export async function refreshSubagentRun(runId: string, expectedScope?: SubagentRunObservationScope): Promise<void> {
  const cached = runs.get(runId)
  const found = [...discovery.values()].find(entry => entry.state?.refs.has(runId))
  const discoveredRef = found?.state?.refs.get(runId)?.ref
  const parentState = cached ? discovery.get(cached.parentSessionId)?.state : found?.state
  const quarantined = cached && runGenerations.has(runId) && runGenerations.get(runId) !== parentState?.generation
  const hint = quarantined ? discoveredRef : cached ?? discoveredRef
  if (!hint && !expectedScope) throw new Error('子代理缺少准确会话归属，请刷新列表后重试')
  const scope = expectedScope ?? captureSubagentRunScope(hint!)
  if (scope.identity.runId !== runId) throw new Error('子代理运行身份不一致')
  assertRunScope(scope, true)
  const requestKey = JSON.stringify([scope.connection.source, scope.localEpoch, scope.identity, scope.serverGeneration])
  const pending = runRequests.get(requestKey)
  if (pending) return pending
  const source = getEngineSource()
  const generation = cacheGeneration
  const discoveryAtStart = discovery.get(scope.identity.parentSessionId)?.state
  const versionAtStart = discoveryVersions.get(scope.identity.parentSessionId)
  const request = (async (): Promise<void> => {
    const run = await getSubagentRun(runId, { parentSessionId: scope.identity.parentSessionId,
      rootSessionId: scope.identity.rootSessionId, parentConversationId: scope.identity.parentConversationId,
      connection: scope.connection, verify: () => assertRunScope(scope, true) })
    if (source === getEngineSource() && generation === cacheGeneration) {
      assertRunScope(scope, true)
      const latest = discovery.get(scope.identity.parentSessionId)?.state
      const ref = latest?.refs.get(runId)?.ref
      if (Object.entries(scope.identity).some(([key, value]) => run[key as keyof SubagentRun] !== value) ||
        ref && !matchesRef(run, ref)) throw new Error('子代理准确摘要与发现身份或状态不一致')
      // A fence can leave resident memory only after its W epoch expires. An
      // earlier in-flight read without a retained fence must be retried, not
      // allowed to recreate an evicted/deleted old view.
      if (discoveryAtStart && latest && (discoveryAtStart.epoch !== latest.epoch ||
        !ref && versionAtStart !== discoveryVersions.get(scope.identity.parentSessionId))) return
      if (runGenerations.has(runId) && latest?.generation !== runGenerations.get(runId)) removeCachedRun(runId)
      const result = ingestSubagentRunResult(run)
      if (result.status === 'invalid' || result.status === 'gap')
        throw new Error('子代理状态或序列冲突，请更新列表后重试')
      if (runs.has(runId)) runGenerations.set(runId, latest?.generation)
      if (ref && latest) publishDiscovery(scope.identity.parentSessionId, { ...getSubagentDiscovery(scope.identity.parentSessionId),
        state: acknowledgeSubagentDiscoveryRef(latest, runId, ref.revision) })
    }
  })()
  runRequests.set(requestKey, request)
  try { await request }
  finally { if (runRequests.get(requestKey) === request) runRequests.delete(requestKey) }
}

export async function requestSubagentCancellation(runId: string, expectedScope?: SubagentRunObservationScope): Promise<void> {
  const cached = runs.get(runId)
  if (!cached) throw new Error('子代理缺少准确会话归属，请刷新列表后重试')
  const scope = expectedScope ?? captureSubagentRunScope(cached!)
  if (scope.identity.runId !== runId) throw new Error('子代理运行身份不一致')
  assertRunScope(scope)
  const source = getEngineSource()
  const generation = cacheGeneration
  const run = await cancelSubagentRun(runId, { parentSessionId: scope.identity.parentSessionId,
    rootSessionId: scope.identity.rootSessionId, parentConversationId: scope.identity.parentConversationId,
    connection: scope.connection, verify: () => assertRunScope(scope) })
  if (source === getEngineSource() && generation === cacheGeneration) {
    assertRunScope(scope)
    if (Object.entries(scope.identity).some(([key, value]) => run[key as keyof SubagentRun] !== value))
      throw new Error('子代理取消确认归属不一致')
    ingestSubagentRun(run)
  }
}

/** A detached parent SSE must not freeze a child card; reconcile only sessions with active runs. */
export function hasActiveSubagents(parentSessionId: string | null): boolean {
  return getSubagentRuns(parentSessionId).some((run) => isSubagentActive(run.status))
}

subscribeEngineSource(() => {
  cacheGeneration++
  runs.clear()
  access.clear()
  residentSizes.clear()
  residentBytes = 0
  evictedRunCount = 0
  requests.clear()
  directories.clear()
  runRequests.clear()
  activeRequests.clear()
  activeRefresh.clear()
  discovery.clear()
  discoveryVersions.clear()
  cycles.clear()
  cycleNextAt.clear()
  pendingAnchors.clear()
  runGenerations.clear()
  for (const listener of listeners) listener()
})
