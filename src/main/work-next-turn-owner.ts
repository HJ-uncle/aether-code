import type { EngineSnapshot } from '../shared/ipc'
import { WORK_QUEUE_IPC, type WorkQueueRequest, type WorkQueueInvokeResult } from '../shared/work-next-turn-api'
import { NextTurnQueueError, type NextTurnQueueScope } from '../shared/next-turn-queue'
import { assertQueueJsonValue, sameQueueScope } from '../shared/next-turn-queue-state'
import type { NextTurnQueueRepository } from './next-turn-queue-repository'
import { NextTurnQueueMutationService } from './next-turn-queue-service'
import { NextTurnDispatcher, type QueueDispatchGateway } from './next-turn-dispatcher'
import { engineTargetError } from './engine/protocol'

export interface WorkQueueOwnerEvent { sender: { isDestroyed(): boolean } }
export interface WorkQueueOwnerPorts {
  engine: { snapshot(): EngineSnapshot; signal(): AbortSignal; subscribe(listener: () => void): () => void }
  ipc: {
    handle(channel: string, listener: (event: WorkQueueOwnerEvent, input: WorkQueueRequest) => Promise<WorkQueueInvokeResult>): void
    removeHandler(channel: string): void
  }
  store: NextTurnQueueRepository
  gateway: QueueDispatchGateway
  changed?: (scope: NextTurnQueueScope, revision: number) => void
  clock?: { now(): number; schedule(callback: () => void, delay: number): unknown; cancel(handle: unknown): void }
  report?: (message: string) => void
}
interface RestoreItem {
  scope: NextTurnQueueScope
  status: 'pending' | 'restoring' | 'bound' | 'blocked'
  attempts: number
  nextAt: number
  error?: string
}
interface RestoreEpoch {
  key: string
  snapshot: EngineSnapshot
  signal: AbortSignal
  enumerated: boolean
  attempts: number
  nextAt: number
  error?: string
  items: RestoreItem[]
  cursor: number
}
const retryDelay = (attempts: number): number => Math.min(30000, 2000 * 2 ** Math.min(4, attempts - 1))
const epochKey = (snapshot: EngineSnapshot): string => JSON.stringify([snapshot.mode, snapshot.baseUrl, snapshot.instanceId, snapshot.accountId ?? null])
const sourceMatches = (scope: NextTurnQueueScope, snapshot: EngineSnapshot): boolean => {
  const endpoint = snapshot.mode === 'embedded' ? '' : new URL(snapshot.baseUrl).href.replace(/\/+$/, '')
  return scope.source.mode === snapshot.mode && scope.source.endpoint === endpoint && scope.source.accountId === (snapshot.accountId ?? null)
}

/** Electron and restart contracts run this same owned IPC controller with different external ports. */
export function createWorkNextTurnOwner(ports: WorkQueueOwnerPorts) {
  const service = new NextTurnQueueMutationService(ports.store, ports.gateway)
  const dispatcher = new NextTurnDispatcher(service, ports.gateway, ports.changed)
  const clock = ports.clock ?? { now: () => Date.now(), schedule: (callback: () => void, delay: number) => setTimeout(callback, delay),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  const report = (message: string): void => { try { (ports.report ?? console.error)(message) } catch { /* Observers cannot own queue progress. */ } }
  const messageOf = (error: unknown): string => error instanceof Error ? error.message.slice(0, 1024) : 'Queue restoration failed'
  let closing = false, epoch: RestoreEpoch | undefined, enumeration: Promise<void> | undefined, timer: unknown, closePromise: Promise<void> | undefined
  const requests = new Set<Promise<unknown>>(), restores = new Set<Promise<void>>()
  const current = (candidate: RestoreEpoch): boolean => !closing && epoch === candidate && !candidate.signal.aborted
    && candidate.signal === ports.engine.signal() && ports.engine.snapshot().phase === 'ready' && epochKey(ports.engine.snapshot()) === candidate.key
  const blocked = (item: RestoreItem, error: string): void => {
    item.status = 'blocked'; item.error = error
    report('[next-turn] retained queue obstacle (' + item.scope.taskId + '): ' + error)
  }
  const restoreItem = async (candidate: RestoreEpoch, item: RestoreItem): Promise<void> => {
    try {
      const lease = await ports.gateway.capture(item.scope.taskId)
      if (!current(candidate)) return
      ports.gateway.assertCurrent(lease)
      if (!sameQueueScope(item.scope, lease.scope)) {
        blocked(item, '引擎数据库或任务所属空间已变化；旧队列保留且不会自动投递')
        return
      }
      // Bind recaptures authority. The expected scope fences namespace changes between these two awaits.
      await dispatcher.bind(item.scope.taskId, item.scope)
      if (!current(candidate)) return
      item.status = 'bound'; delete item.error
      dispatcher.wakeAll()
    } catch (error) {
      if (!current(candidate)) return
      item.status = 'pending'; item.attempts = Math.min(10, item.attempts + 1)
      item.nextAt = clock.now() + retryDelay(item.attempts); item.error = messageOf(error)
      report('[next-turn] task restoration deferred (' + item.scope.taskId + '): ' + item.error)
    }
  }
  const restore = (): void => {
    if (closing) return
    const snapshot = ports.engine.snapshot(), signal = ports.engine.signal()
    if (snapshot.phase !== 'ready' || !snapshot.instanceId || signal.aborted) { epoch = undefined; return }
    if (!epoch || epoch.key !== epochKey(snapshot) || epoch.signal !== signal) epoch = {
      key: epochKey(snapshot), snapshot: structuredClone(snapshot), signal, enumerated: false, attempts: 0, nextAt: 0, items: [], cursor: 0
    }
    const candidate = epoch
    if (!candidate.enumerated) {
      if (enumeration || clock.now() < candidate.nextAt) return
      enumeration = (async () => {
        try {
          const scopes = await ports.store.listScopes()
          if (!current(candidate)) return
          candidate.items = scopes.map(scope => ({ scope: structuredClone(scope), status: 'pending', attempts: 0, nextAt: 0 }))
          for (const item of candidate.items) if (!sourceMatches(item.scope, candidate.snapshot)) blocked(item, '此队列属于另一个引擎或账号，未自动投递')
          candidate.enumerated = true; delete candidate.error
        } catch (error) {
          if (!current(candidate)) return
          candidate.attempts = Math.min(10, candidate.attempts + 1); candidate.nextAt = clock.now() + retryDelay(candidate.attempts)
          candidate.error = messageOf(error); report('[next-turn] durable restoration deferred: ' + candidate.error)
        }
      })().finally(() => { enumeration = undefined; restore() })
      return
    }
    // Fair cursor and two owned slots keep a failing/slow task from monopolising restart recovery.
    let scanned = 0
    while (current(candidate) && candidate.items.length && scanned < candidate.items.length && restores.size < 2) {
      const item = candidate.items[candidate.cursor % candidate.items.length]
      candidate.cursor = (candidate.cursor + 1) % candidate.items.length; scanned++
      if (item.status !== 'pending' || clock.now() < item.nextAt) continue
      item.status = 'restoring'
      const operation = restoreItem(candidate, item)
      restores.add(operation)
      operation.finally(() => { restores.delete(operation); restore() }).catch(() => {})
    }
  }
  const invoke = async (event: WorkQueueOwnerEvent, input: WorkQueueRequest) => {
    if (closing || event.sender.isDestroyed()) throw new NextTurnQueueError('AUTHORITY', 'Queue owner is unavailable')
    assertQueueJsonValue(input)
    if (!input || typeof input.taskId !== 'string' || !input.taskId || !input.expectedEngine
      || !['embedded', 'remote'].includes(input.expectedEngine.mode) || typeof input.expectedEngine.baseUrl !== 'string'
      || typeof input.expectedEngine.instanceId !== 'string' || !input.expectedEngine.instanceId) throw new NextTurnQueueError('AUTHORITY', '必须提供当前引擎与任务身份')
    const unsupported = engineTargetError(ports.engine.snapshot(), input.expectedEngine)
    if (unsupported) throw new NextTurnQueueError('AUTHORITY', unsupported)
    const action = input.action
    if (!action || typeof action !== 'object') throw new NextTurnQueueError('INVALID', 'Queue action is missing')
    switch (action.kind) {
      case 'read': {
        const value = await dispatcher.read(input.taskId)
        const candidate = epoch
        const obstacle = candidate?.items.find(item => item.scope.taskId === input.taskId && item.status === 'blocked' && sourceMatches(item.scope, candidate.snapshot))
        return obstacle?.error ? { ...value, dispatchError: obstacle.error } : value
      }
      case 'enqueue': return dispatcher.enqueue(input.taskId, action.expectedRevision, action.operationId, action.id, action.submission)
      case 'edit-draft': return dispatcher.editDraft(input.taskId, action.expectedRevision, action.operationId, action.id, action.entryRevision, action.draft)
      case 'mutate':
        if (!action.operation || !['remove', 'move', 'clear-pending', 'pause', 'resume'].includes(action.operation.kind)) throw new NextTurnQueueError('AUTHORITY', 'Only pending queue controls are allowed')
        return dispatcher.mutate(input.taskId, action.expectedRevision, action.operationId, action)
      case 'reconcile': return dispatcher.reconcile(input.taskId, action.retryIfAbsent === true)
      default: throw new NextTurnQueueError('INVALID', 'Unknown queue action')
    }
  }
  ports.ipc.handle(WORK_QUEUE_IPC.invoke, (event, input) => {
    if (closing || requests.size >= 128) return Promise.resolve({ ok: false, code: 'CAPACITY', message: 'Queue owner is closing or busy' })
    const operation = invoke(event, input).then(value => ({ ok: true as const, value }), error => ({ ok: false as const,
      code: error instanceof NextTurnQueueError ? error.code : 'UNKNOWN', message: error instanceof Error ? error.message : 'Queue operation failed' }))
    requests.add(operation); operation.finally(() => requests.delete(operation)).catch(() => {})
    return operation
  })
  const unsubscribe = ports.engine.subscribe(() => { ports.store.onEngineChanged?.(); restore() })
  const tick = (): void => { if (closing) return; restore(); dispatcher.wakeAll(); timer = clock.schedule(tick, 2000) }
  tick()
  return {
    dispatcher,
    diagnostics: () => ({ closing, requests: requests.size, restores: restores.size, enumerating: !!enumeration,
      restoration: epoch ? { epoch: epoch.key, enumerated: epoch.enumerated, attempts: epoch.attempts, nextAt: epoch.nextAt, error: epoch.error,
        items: epoch.items.map(item => ({ scope: item.scope, status: item.status, attempts: item.attempts, nextAt: item.nextAt, error: item.error })) } : undefined }),
    close: (): Promise<void> => {
      if (closePromise) return closePromise
      closing = true; clock.cancel(timer); unsubscribe(); ports.ipc.removeHandler(WORK_QUEUE_IPC.invoke)
      const dispatcherClosing = dispatcher.close()
      closePromise = (async () => { await enumeration; await Promise.allSettled([...restores]); await Promise.allSettled([...requests]); await dispatcherClosing; await ports.store.close?.() })()
      return closePromise
    }
  }
}
