/** Pure production recovery tests: retries, single flight, cancellation, ABA isolation and owned stop. No Electron/model. */
import { expect, test } from '@playwright/test'
import { createRecoveryLoop, createRecoverySingleFlight, durableCancelBody, recoverSnapshot,
  recoveryDelay, recoveryFailure, reducedEventCursor, sameRecoveryScope, snapshotRecoveryOutcome,
  type RecoveryLease, type RecoveryOutcome, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'

const scope: RecoveryScope = { source: 1, sessionId: 'A', viewEpoch: 1 }
const live = { source: 'live' as const, finished: false, eventId: 'stream:10', run: { status: 'running' } }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function drainMicrotasks(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve() }
function scheduler() {
  let id = 0
  const pending = new Map<number, { callback: () => void; delay: number }>()
  return {
    pending,
    schedule(callback: () => void, delay: number) { const key = ++id; pending.set(key, { callback, delay }); return key },
    unschedule(timer: unknown) { pending.delete(timer as number) },
    next() {
      const entry = pending.entries().next().value
      if (!entry) throw new Error('Expected a retry timer')
      pending.delete(entry[0]); entry[1].callback()
    }
  }
}
function setup(attempt: (lease: RecoveryLease) => Promise<RecoveryOutcome>) {
  const clock = scheduler()
  let current = scope
  const loop = createRecoveryLoop({ attempt, random: () => 0.5, schedule: clock.schedule, unschedule: clock.unschedule,
    isScopeCurrent: candidate => sameRecoveryScope(candidate, current) })
  return { loop, clock, view(next: RecoveryScope) { current = next } }
}

test('前五次快照失败，第六次成功；首次历史 gate 等待恢复而不永久放弃', async () => {
  let calls = 0, attached = 0, completed = false
  const { loop, clock } = setup(lease => recoverSnapshot(lease, async () => ++calls <= 5
    ? { kind: 'retry' } : { kind: 'restored', snapshot: live }, () => { attached++ }))
  const result = loop.resume(scope)
  void result.then(() => { completed = true })
  await drainMicrotasks()
  for (let failure = 1; failure <= 5; failure++) {
    expect(calls).toBe(failure)
    expect(completed).toBe(false)
    expect(clock.pending.size).toBe(1)
    expect(loop.state().failures).toBe(failure)
    clock.next(); await drainMicrotasks()
  }
  expect(await result).toBe(true)
  expect(calls).toBe(6); expect(attached).toBe(1); expect(clock.pending.size).toBe(0)
})

test('并发 resume 共用同一个完成 Promise 和一次恢复请求', async () => {
  const response = deferred<RecoveryOutcome>(); let calls = 0
  const { loop, clock } = setup(async () => { calls++; return response.promise })
  const first = loop.resume(scope), second = loop.resume({ ...scope }), third = loop.resume(scope)
  expect(second).toBe(first); expect(third).toBe(first)
  await drainMicrotasks(); expect(calls).toBe(1); expect(clock.pending.size).toBe(0)
  response.resolve('attached'); await drainMicrotasks()
  expect(await first).toBe(true)
})

test('恢复请求进行中反复断线只排下一次唯一计时器', async () => {
  const response = deferred<RecoveryOutcome>(); let calls = 0
  const { loop, clock } = setup(async () => { calls++; return calls === 1 ? response.promise : 'attached' })
  const result = loop.resume(scope); await drainMicrotasks()
  for (let i = 0; i < 20; i++) loop.retry(scope)
  expect(calls).toBe(1); expect(clock.pending.size).toBe(0)
  response.resolve('attached'); await drainMicrotasks()
  expect(clock.pending.size).toBe(1)
  clock.next(); await drainMicrotasks(); expect(await result).toBe(true); expect(calls).toBe(2)
})

test('快照 IPC reject 和建流同步 reject 都继续重试', async () => {
  let reads = 0, attaches = 0
  const { loop, clock } = setup(lease => recoverSnapshot(lease, async () => {
    if (++reads === 1) throw new Error('snapshot IPC rejected')
    return { kind: 'restored', snapshot: live }
  }, () => { if (++attaches === 1) throw new Error('stream IPC rejected') }))
  const result = loop.resume(scope); await drainMicrotasks()
  expect(clock.pending.size).toBe(1); clock.next(); await drainMicrotasks()
  expect(clock.pending.size).toBe(1); clock.next(); await drainMicrotasks()
  expect(await result).toBe(true); expect(reads).toBe(3); expect(attaches).toBe(2)
})

test('已挂接流再次异步拒绝后仍走退避，建立订阅不清失败次数', async () => {
  let lease: RecoveryLease | undefined; let calls = 0
  const { loop, clock } = setup(async current => { lease = current; calls++; return 'attached' })
  expect(await loop.resume(scope)).toBe(true)
  await drainMicrotasks()
  expect(lease?.isCurrent()).toBe(true)
  loop.retry(scope); const result = loop.resume(scope)
  expect(clock.pending.size).toBe(1); expect(calls).toBe(1)
  clock.next(); await drainMicrotasks(); expect(await result).toBe(true)
  loop.retry(scope); expect(loop.state().failures).toBe(2)
  loop.cancel()
})

test('取消撤掉退避计时器并结束等待完成的调用者', async () => {
  let calls = 0
  const { loop, clock } = setup(async () => { calls++; return 'retry' })
  const result = loop.resume(scope); await drainMicrotasks()
  expect(clock.pending.size).toBe(1)
  loop.cancel(); expect(await result).toBe(false); expect(clock.pending.size).toBe(0)
  await drainMicrotasks(); expect(calls).toBe(1)
})

test('取消进行中的请求后迟到快照不能挂接或重建计时器', async () => {
  const response = deferred<{ kind: 'restored'; snapshot: typeof live }>(); let attached = 0; let signal: AbortSignal | undefined
  const { loop, clock } = setup(lease => { signal = lease.signal; return recoverSnapshot(lease, () => response.promise, () => { attached++ }) })
  const result = loop.resume(scope); await drainMicrotasks(); loop.cancel()
  expect(signal?.aborted).toBe(true); expect(await result).toBe(false)
  response.resolve({ kind: 'restored', snapshot: live }); await drainMicrotasks()
  expect(attached).toBe(0); expect(clock.pending.size).toBe(0)
})

test('同源同 session 切走切回的 ABA 旧响应不能提交', async () => {
  const old = deferred<{ kind: 'restored'; snapshot: typeof live }>()
  const middle = deferred<{ kind: 'restored'; snapshot: typeof live }>()
  const accepted: number[] = []
  const { loop, view, clock } = setup(lease => recoverSnapshot(lease, async () => lease.scope.viewEpoch === 1
    ? old.promise : lease.scope.viewEpoch === 2 ? middle.promise : { kind: 'restored', snapshot: live },
  (_snapshot, current) => { accepted.push(current.scope.viewEpoch) }))
  const first = loop.resume(scope); await drainMicrotasks()
  const other = { ...scope, sessionId: 'B', viewEpoch: 2 }; view(other)
  const second = loop.resume(other); await drainMicrotasks()
  const back = { ...scope, viewEpoch: 3 }; view(back)
  const third = loop.resume(back); await drainMicrotasks()
  old.resolve({ kind: 'restored', snapshot: live }); middle.resolve({ kind: 'restored', snapshot: live }); await drainMicrotasks()
  expect(await first).toBe(false); expect(await second).toBe(false); expect(await third).toBe(true)
  expect(accepted).toEqual([3]); expect(clock.pending.size).toBe(0)
})

test('引擎来源变化隔离同名 session 和迟到请求', async () => {
  const old = deferred<RecoveryOutcome>(); let calls = 0
  const { loop, view, clock } = setup(async () => ++calls === 1 ? old.promise : 'idle')
  const first = loop.resume(scope); await drainMicrotasks()
  const remote = { ...scope, source: 2 }; view(remote)
  expect(await loop.resume(remote)).toBe(false)
  old.resolve('retry'); await drainMicrotasks()
  expect(await first).toBe(false); expect(loop.state().scope?.source).toBe(2); expect(clock.pending.size).toBe(0)
})

test('卸载 dispose 后旧回调和新 resume 都不能继续', async () => {
  let calls = 0
  const { loop, clock } = setup(async () => { calls++; return 'retry' })
  const first = loop.resume(scope); await drainMicrotasks(); loop.dispose()
  expect(await first).toBe(false); expect(await loop.resume(scope)).toBe(false)
  loop.retry(scope); expect(clock.pending.size).toBe(0); expect(calls).toBe(1); expect(loop.state().phase).toBe('disposed')
})

test('退避有 jitter 和频率上限，没有总次数上限', async () => {
  expect(recoveryDelay(1, 0)).toBe(400); expect(recoveryDelay(1, 1)).toBe(600)
  expect(recoveryDelay(2, 0.5)).toBe(1000); expect(recoveryDelay(1, Number.NaN)).toBe(500)
  expect(recoveryDelay(Number.MAX_SAFE_INTEGER, 1)).toBe(30_000)
  let calls = 0
  const { loop, clock } = setup(async () => ++calls < 150 ? 'retry' : 'attached')
  const result = loop.resume(scope); await drainMicrotasks()
  for (let i = 0; i < 149; i++) {
    expect(clock.pending.size).toBe(1)
    expect([...clock.pending.values()][0].delay).toBeLessThanOrEqual(30_000)
    clock.next(); await drainMicrotasks()
  }
  expect(await result).toBe(true); expect(calls).toBe(150); expect(clock.pending.size).toBe(0)
})

test('只有接受到活动才能重置退避，建立订阅本身不重置', async () => {
  const { loop, clock } = setup(async () => 'attached')
  await loop.resume(scope); await drainMicrotasks()
  loop.retry(scope); clock.next(); await drainMicrotasks()
  expect(loop.state().failures).toBe(1)
  loop.progress({ ...scope, viewEpoch: 0 }); expect(loop.state().failures).toBe(1)
  loop.progress(scope); expect(loop.state().failures).toBe(0)
  loop.retry(scope); expect([...clock.pending.values()][0].delay).toBe(500); loop.cancel()
})

for (const status of ['waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']) {
  test(`持久 ${status} 状态只回放，不重投任务或重复订阅`, async () => {
    let attached = 0, reads = 0
    const { loop, clock } = setup(lease => recoverSnapshot(lease, async () => {
      reads++; return { kind: 'restored', snapshot: { ...live, run: { status } } }
    }, () => { attached++ }))
    expect(await loop.resume(scope)).toBe(false); await drainMicrotasks()
    expect(attached).toBe(0); expect(reads).toBe(1); expect(clock.pending.size).toBe(0)
  })
}

test('running 快照缺 cursor 或无 live bus 时重试，空历史正常结束', () => {
  expect(snapshotRecoveryOutcome({ ...live, eventId: null })).toBe('retry')
  expect(snapshotRecoveryOutcome({ ...live, source: 'persisted', finished: true })).toBe('retry')
  expect(snapshotRecoveryOutcome({ source: 'persisted', finished: true, eventId: null })).toBe('idle')
})

test('认证失败进入可操作 blocked，不盲重试；明确新尝试可恢复', async () => {
  let calls = 0
  const { loop, clock } = setup(async () => ++calls === 1 ? recoveryFailure(40100, '请重新登录') : 'idle')
  expect(await loop.resume(scope)).toBe(false); await drainMicrotasks()
  expect(loop.state().phase).toBe('blocked'); expect(loop.state().reason).toBe('请重新登录'); expect(clock.pending.size).toBe(0)
  loop.retry(scope); expect(await loop.resume(scope)).toBe(false); expect(calls).toBe(1)
  loop.cancel(); expect(await loop.resume(scope)).toBe(false); expect(calls).toBe(2)
  expect(recoveryFailure(500, 'temporary')).toBe('retry')
})

test('断线没有 streamId 仍生成精确 session+run 取消目标，拒绝跨会话或终态', () => {
  expect(durableCancelBody('A', { sessionId: 'A', runId: 'owned', status: 'running' })).toEqual({ sessionId: 'A', runId: 'owned' })
  expect(durableCancelBody('A', { sessionId: 'A', runId: 'owned', status: 'waiting' })).toEqual({ sessionId: 'A', runId: 'owned' })
  expect(durableCancelBody('A', { sessionId: 'B', runId: 'foreign', status: 'running' })).toBeNull()
  expect(durableCancelBody('A', { sessionId: 'A', runId: 'done', status: 'succeeded' })).toBeNull()
  expect(durableCancelBody('A', undefined)).toBeNull()
})

test('历史恢复的同 scope 多入口共享快照请求，旧 flight 不清新 flight', async () => {
  const reads = createRecoverySingleFlight<number>(), old = deferred<number>(), newer = deferred<number>(); let calls = 0
  const first = reads.read(scope, () => { calls++; return old.promise })
  expect(reads.read({ ...scope }, async () => 9)).toBe(first)
  await drainMicrotasks(); expect(calls).toBe(1)
  reads.clear()
  const nextScope = { ...scope, viewEpoch: 3 }
  const next = reads.read(nextScope, () => { calls++; return newer.promise })
  old.resolve(1); await drainMicrotasks()
  expect(reads.read(nextScope, async () => 99)).toBe(next); expect(calls).toBe(2)
  newer.resolve(2); expect(await first).toBe(1); expect(await next).toBe(2)
})

test('首轮完成后 immediately resume 不会遗留未完成 Promise', async () => {
  const { loop } = setup(async () => 'idle')
  await loop.resume(scope)
  const second = loop.resume(scope)
  await drainMicrotasks(); expect(await second).toBe(false)
})

test('子代理 delta gap/invalid 不提前提交 SSE cursor；接受与已验证重复才提交', () => {
  expect(reducedEventCursor('bus:1', 'bus:2', 'gap')).toBe('bus:1')
  expect(reducedEventCursor('bus:1', 'bus:2', 'invalid')).toBe('bus:1')
  expect(reducedEventCursor('bus:1', 'bus:2', 'applied')).toBe('bus:2')
  expect(reducedEventCursor('bus:1', 'bus:2', 'verified-duplicate')).toBe('bus:2')
  expect(reducedEventCursor('bus:1', undefined, 'applied')).toBe('bus:1')
})
