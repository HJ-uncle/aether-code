/** Pure window input contracts: root fairness, bounded admission, exact cancellation and truthful drain joins. No Electron/browser ACK simulation. */
import { getEventListeners } from 'node:events'
import { expect, test } from '@playwright/test'
import {
  BrowserInputQueueError,
  OwnedBrowserInputQueue
} from '../src/main/browser/owned-input-queue'
import type { BrowserInputLease, BrowserInputOwner } from '../src/main/browser/owned-input-queue'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function owner(
  rootSessionId: string,
  requestId: string,
  runId = 'run-1',
  engineId = 'engine-1'
): BrowserInputOwner {
  return { engineId, rootSessionId, runId, requestId }
}

function outcome<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
}

async function failure<T>(
  result: Promise<{ value: T } | { error: unknown }>,
  code: BrowserInputQueueError['code'],
  performed: false | 'unknown'
): Promise<BrowserInputQueueError> {
  const value = await result
  if (!('error' in value) || !(value.error instanceof BrowserInputQueueError))
    throw new Error('Expected a browser input queue failure')
  expect(value.error.code).toBe(code)
  expect(value.error.operationPerformed).toBe(performed)
  return value.error
}

test('queue limits must be positive safe integers', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new OwnedBrowserInputQueue({ maxQueued: value })).toThrow(RangeError)
    expect(() => new OwnedBrowserInputQueue({ maxQueuedPerRoot: value })).toThrow(RangeError)
  }
})

test('invalid task identity cannot reserve a native input slot', async () => {
  const queue = new OwnedBrowserInputQueue()
  let calls = 0
  for (const field of ['engineId', 'rootSessionId', 'runId', 'requestId'] as const) {
    await failure(
      outcome(
        queue.run({ owner: { ...owner('A', 'one'), [field]: ' ' } }, () => {
          calls += 1
        })
      ),
      'invalid-owner',
      false
    )
  }
  expect(calls).toBe(0)
  expect(queue.getSnapshot()).toEqual({ disposed: false, queuedCount: 0, active: null, roots: [] })
})

test('roots take round robin turns while preserving every root FIFO', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const order: string[] = []
  const first = queue.run({ owner: owner('A', 'A1') }, async () => {
    order.push('A1')
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const pending = [
    owner('A', 'A2'),
    owner('A', 'A3'),
    owner('B', 'B1'),
    owner('B', 'B2'),
    owner('C', 'C1'),
    owner('C', 'C2')
  ].map((identity) =>
    queue.run({ owner: identity }, () => {
      order.push(identity.requestId)
    })
  )
  release.resolve()
  await Promise.all([first, ...pending])
  await queue.whenIdle()
  expect(order).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3'])
  expect(queue.getSnapshot().roots).toEqual([])
})

test('A arriving first during active A cannot jump ahead of a later root B', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const order: string[] = []
  const first = queue.run({ owner: owner('A', 'first') }, async () => {
    order.push('first')
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const second = queue.run({ owner: owner('A', 'second') }, () => {
    order.push('second')
  })
  const other = queue.run({ owner: owner('B', 'other') }, () => {
    order.push('other')
  })
  release.resolve()
  await Promise.all([first, second, other])
  expect(order).toEqual(['first', 'other', 'second'])
  await queue.whenIdle()
})

test('cancelling a queued request never calls it and frees its admission slot', async () => {
  const queue = new OwnedBrowserInputQueue({ maxQueued: 1, maxQueuedPerRoot: 1 })
  const entered = deferred()
  const release = deferred()
  const active = queue.run({ owner: owner('A', 'active') }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  let calls = 0
  const identity = owner('B', 'queued')
  const waiting = outcome(
    queue.run({ owner: identity }, () => {
      calls += 1
    })
  )
  expect(queue.cancelRequest(identity)).toBe(true)
  expect(queue.cancelRequest(identity)).toBe(false)
  await failure(waiting, 'cancelled', false)
  const replacement = queue.run({ owner: owner('B', 'replacement') }, () => 'replacement')
  release.resolve()
  expect(await replacement).toBe('replacement')
  await active
  await queue.whenIdle()
  expect(calls).toBe(0)
})

test('a pre-aborted request never consumes the active or waiting slots', async () => {
  const queue = new OwnedBrowserInputQueue()
  const controller = new AbortController()
  const reason = new Error('upstream stopped')
  controller.abort(reason)
  let calls = 0
  const error = await failure(
    outcome(
      queue.run({ owner: owner('A', 'cancelled'), signal: controller.signal }, () => {
        calls += 1
      })
    ),
    'cancelled',
    false
  )
  expect(error.cause).toBe(reason)
  expect(calls).toBe(0)
  expect(queue.getSnapshot().active).toBeNull()
  expect(queue.getSnapshot().queuedCount).toBe(0)
})

test('cancellation before callback invocation truthfully reports no input', async () => {
  const queue = new OwnedBrowserInputQueue()
  const identity = owner('A', 'not-started')
  let calls = 0
  const result = outcome(
    queue.run({ owner: identity }, () => {
      calls += 1
    })
  )
  expect(queue.cancelRequest(identity)).toBe(true)
  await failure(result, 'cancelled', false)
  await queue.whenIdle()
  expect(calls).toBe(0)
})

test('active cancellation before dispatch settles the caller but holds the window until join', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred<BrowserInputLease>()
  const release = deferred()
  const identity = owner('A', 'pre-input')
  const active = outcome(
    queue.run({ owner: identity }, async (lease) => {
      entered.resolve(lease)
      await release.promise
      return 'late success'
    })
  )
  const lease = await entered.promise
  let otherCalls = 0
  const other = queue.run({ owner: owner('B', 'input') }, () => {
    otherCalls += 1
    return 'B'
  })
  expect(queue.cancelRun(identity, 'stop A')).toBe(1)
  await failure(active, 'cancelled', false)
  expect(lease.signal.aborted).toBe(true)
  expect(() => lease.markInputDispatched()).toThrow(BrowserInputQueueError)
  expect(queue.getSnapshot().active).toEqual({
    owner: identity,
    inputDispatched: false,
    draining: true
  })
  let idle = false
  const joined = queue.whenIdle().then(() => {
    idle = true
  })
  await Promise.resolve()
  expect(otherCalls).toBe(0)
  expect(idle).toBe(false)
  release.resolve()
  expect(await other).toBe('B')
  await joined
  expect(otherCalls).toBe(1)
  expect(queue.getSnapshot().active).toBeNull()
})

test('active cancellation after input dispatch remains unknown and is never replayed', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const identity = owner('A', 'dispatched')
  let dispatches = 0
  const result = outcome(
    queue.run({ owner: identity }, async (lease) => {
      lease.markInputDispatched()
      dispatches += 1
      entered.resolve()
      await release.promise
      return 'late ACK'
    })
  )
  await entered.promise
  expect(queue.cancelRequest(identity)).toBe(true)
  await failure(result, 'cancelled', 'unknown')
  await failure(
    outcome(
      queue.run({ owner: identity }, () => {
        dispatches += 1
      })
    ),
    'duplicate',
    false
  )
  expect(queue.getSnapshot().active?.draining).toBe(true)
  release.resolve()
  await queue.whenIdle()
  expect(dispatches).toBe(1)
  expect(queue.cancelRequest(identity)).toBe(false)
})

test('exact run cancellation preserves newer run, other root and other engine inputs', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const identity = owner('A', 'active', 'R1')
  const active = outcome(
    queue.run({ owner: identity }, async (lease) => {
      lease.markInputDispatched()
      entered.resolve()
      await release.promise
    })
  )
  await entered.promise
  let oldCalls = 0
  const old = outcome(
    queue.run({ owner: owner('A', 'waiting', 'R1') }, () => {
      oldCalls += 1
    })
  )
  const preserved = [
    owner('A', 'newer', 'R2'),
    owner('B', 'other-root', 'R1'),
    owner('A', 'other-engine', 'R1', 'engine-2')
  ].map((identity) => queue.run({ owner: identity }, () => identity.requestId))
  expect(
    queue.cancelRun({
      engineId: identity.engineId,
      rootSessionId: identity.rootSessionId,
      runId: identity.runId
    })
  ).toBe(2)
  expect(queue.cancelRun(identity)).toBe(0)
  await failure(active, 'cancelled', 'unknown')
  await failure(old, 'cancelled', false)
  release.resolve()
  expect(await Promise.all(preserved)).toEqual(['newer', 'other-root', 'other-engine'])
  await queue.whenIdle()
  expect(oldCalls).toBe(0)
})

test('cancelRequest matches the full engine root run request tuple', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const active = queue.run({ owner: owner('A', 'active') }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const identity = owner('B', 'same-request')
  const waiting = outcome(queue.run({ owner: identity }, () => 'cancelled'))
  const newer = queue.run({ owner: { ...identity, runId: 'R2' } }, () => 'newer')
  for (const field of ['engineId', 'rootSessionId', 'runId', 'requestId'] as const)
    expect(queue.cancelRequest({ ...identity, [field]: 'foreign' })).toBe(false)
  expect(queue.cancelRequest(identity)).toBe(true)
  await failure(waiting, 'cancelled', false)
  release.resolve()
  expect(await newer).toBe('newer')
  await active
  await queue.whenIdle()
})

test('owner and signal are captured so caller mutation cannot retarget an admitted input', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const active = queue.run({ owner: owner('A', 'active') }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const controller = new AbortController()
  const input = { owner: owner('B', 'waiting'), signal: controller.signal }
  const original = { ...input.owner }
  const waiting = outcome(queue.run(input, () => 'must not execute'))
  input.owner.runId = 'rewritten'
  input.owner.engineId = 'foreign'
  input.signal = new AbortController().signal
  controller.abort('original signal')
  const error = await failure(waiting, 'cancelled', false)
  expect(error.owner).toEqual(original)
  expect(Object.isFrozen(error.owner)).toBe(true)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  release.resolve()
  await active
  await queue.whenIdle()
})

test('distinct tuple identities cannot collide through separators', async () => {
  const queue = new OwnedBrowserInputQueue()
  const identities = [
    owner('A|B', 'request', 'run', 'engine'),
    owner('B', 'request', 'run', 'engine|A')
  ]
  expect(
    await Promise.all(
      identities.map((identity) => queue.run({ owner: identity }, (lease) => lease.owner))
    )
  ).toEqual(identities)
  await queue.whenIdle()
})

test('total and per-root caps reject excess work without evicting active inputs', async () => {
  const queue = new OwnedBrowserInputQueue({ maxQueued: 2, maxQueuedPerRoot: 1 })
  const entered = deferred()
  const release = deferred()
  const identity = owner('A', 'active')
  const active = queue.run({ owner: identity }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const sameRoot = queue.run({ owner: owner('A', 'one') }, () => 'A')
  await failure(
    outcome(queue.run({ owner: owner('A', 'over-root-cap') }, () => 'bad')),
    'capacity',
    false
  )
  const otherRoot = queue.run({ owner: owner('B', 'one') }, () => 'B')
  await failure(
    outcome(queue.run({ owner: owner('C', 'over-total-cap') }, () => 'bad')),
    'capacity',
    false
  )
  expect(queue.getSnapshot().active?.owner).toEqual(identity)
  expect(queue.getSnapshot().queuedCount).toBe(2)
  release.resolve()
  expect(await Promise.all([sameRoot, otherRoot])).toEqual(['A', 'B'])
  await active
  await queue.whenIdle()
  expect(await queue.run({ owner: owner('C', 'after-drain') }, () => 'C')).toBe('C')
  await queue.whenIdle()
})

test('duplicate live requests are refused but the identity may be used after confirmed join', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const identity = owner('A', 'same')
  const active = queue.run({ owner: identity }, async () => {
    entered.resolve()
    await release.promise
    return 'first'
  })
  await entered.promise
  await failure(outcome(queue.run({ owner: identity }, () => 'duplicate')), 'duplicate', false)
  const waitingOwner = owner('B', 'waiting')
  const waiting = queue.run({ owner: waitingOwner }, () => 'waiting')
  await failure(outcome(queue.run({ owner: waitingOwner }, () => 'duplicate')), 'duplicate', false)
  release.resolve()
  expect(await active).toBe('first')
  expect(await waiting).toBe('waiting')
  await queue.whenIdle()
  expect(await queue.run({ owner: identity }, () => 'explicit new invocation')).toBe(
    'explicit new invocation'
  )
  await queue.whenIdle()
})

test('callback failures retain the original error and release the window for later work', async () => {
  const queue = new OwnedBrowserInputQueue()
  const sync = new Error('synchronous callback failure')
  const asyncError = new Error('asynchronous callback failure')
  const syncResult = outcome(
    queue.run({ owner: owner('A', 'sync') }, () => {
      throw sync
    })
  )
  const asyncResult = outcome(
    queue.run({ owner: owner('B', 'async') }, async () => {
      throw asyncError
    })
  )
  const success = queue.run({ owner: owner('C', 'success') }, () => 'recovered')
  expect(await syncResult).toEqual({ error: sync })
  expect(await asyncResult).toEqual({ error: asyncError })
  expect(await success).toBe('recovered')
  await queue.whenIdle()
})

test('successful completion acknowledges join before immediate identity reuse', async () => {
  const queue = new OwnedBrowserInputQueue()
  const identity = owner('A', 'finished')
  expect(await queue.run({ owner: identity }, () => 'first')).toBe('first')
  expect(queue.getSnapshot().active).toBeNull()
  expect(await queue.run({ owner: identity }, () => 'second')).toBe('second')
  expect(queue.getSnapshot().active).toBeNull()
})

test('dispose cancels waiting inputs and rejects new admission while joining active dispatch', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const active = outcome(
    queue.run({ owner: owner('A', 'active') }, async (lease) => {
      lease.markInputDispatched()
      entered.resolve()
      await release.promise
    })
  )
  await entered.promise
  let queuedCalls = 0
  const waiting = outcome(
    queue.run({ owner: owner('B', 'waiting') }, () => {
      queuedCalls += 1
    })
  )
  queue.dispose('window closed')
  queue.dispose('second close')
  await failure(active, 'disposed', 'unknown')
  await failure(waiting, 'disposed', false)
  await failure(outcome(queue.run({ owner: owner('C', 'new') }, () => 'bad')), 'disposed', false)
  expect(queue.getSnapshot().queuedCount).toBe(0)
  expect(queue.getSnapshot().active?.draining).toBe(true)
  let idle = false
  const joined = queue.whenIdle().then(() => {
    idle = true
  })
  await Promise.resolve()
  expect(idle).toBe(false)
  release.resolve()
  await joined
  expect(queuedCalls).toBe(0)
  expect(queue.getSnapshot()).toEqual({ disposed: true, queuedCount: 0, active: null, roots: [] })
})

test('whenIdle acknowledges all waiting and active callbacks and all subscribers', async () => {
  const queue = new OwnedBrowserInputQueue()
  await queue.whenIdle()
  const entered = deferred()
  const release = deferred()
  const active = queue.run({ owner: owner('A', 'active') }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const queued = queue.run({ owner: owner('B', 'queued') }, () => 'B')
  let subscribers = 0
  const acknowledgements = [queue.whenIdle(), queue.whenIdle()].map((result) =>
    result.then(() => {
      subscribers += 1
    })
  )
  await Promise.resolve()
  expect(subscribers).toBe(0)
  release.resolve()
  await Promise.all([active, queued, ...acknowledgements])
  expect(subscribers).toBe(2)
  expect(queue.getSnapshot().active).toBeNull()
})

test('parent abort listeners are removed after success, callback failure and cancellation', async () => {
  const queue = new OwnedBrowserInputQueue()
  for (const mode of ['success', 'failure', 'cancel'] as const) {
    const controller = new AbortController()
    const entered = deferred()
    const release = deferred()
    const result = outcome(
      queue.run({ owner: owner('A', mode), signal: controller.signal }, async () => {
        entered.resolve()
        await release.promise
        if (mode === 'failure') throw new Error('failure')
      })
    )
    await entered.promise
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    if (mode === 'cancel') controller.abort('stop')
    release.resolve()
    await result
    await queue.whenIdle()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  }
})

test('a retained lease cannot mark a new dispatch after its callback joined', async () => {
  const queue = new OwnedBrowserInputQueue()
  let retained: BrowserInputLease | undefined
  await queue.run({ owner: owner('A', 'done') }, (lease) => {
    retained = lease
  })
  await queue.whenIdle()
  expect(retained).toBeDefined()
  expect(() => retained!.markInputDispatched()).toThrow('浏览器输入租约已结束')
  expect(Reflect.set(retained!.owner, 'runId', 'foreign')).toBe(false)
})

test('snapshot arrays and fields cannot rewrite queue ownership or scheduling', async () => {
  const queue = new OwnedBrowserInputQueue()
  const entered = deferred()
  const release = deferred()
  const identity = owner('A', 'active')
  const active = queue.run({ owner: identity }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const queued = queue.run({ owner: owner('B', 'queued') }, () => 'B')
  const snapshot = queue.getSnapshot()
  snapshot.roots[0].queued.splice(0)
  snapshot.roots.splice(0)
  snapshot.active!.draining = true
  expect(queue.getSnapshot().active).toEqual({
    owner: identity,
    inputDispatched: false,
    draining: false
  })
  expect(queue.getSnapshot().roots[0].queued).toEqual([owner('B', 'queued')])
  release.resolve()
  expect(await queued).toBe('B')
  await active
  await queue.whenIdle()
})

test('long observation outside the input queue does not block another root input', async () => {
  const queue = new OwnedBrowserInputQueue()
  const observation = deferred()
  let observed = false
  const read = observation.promise.then(() => {
    observed = true
  })
  const input = queue.run({ owner: owner('B', 'input') }, (lease) => {
    lease.markInputDispatched()
    return 'B input'
  })
  expect(await input).toBe('B input')
  await queue.whenIdle()
  expect(observed).toBe(false)
  observation.resolve()
  await read
})
