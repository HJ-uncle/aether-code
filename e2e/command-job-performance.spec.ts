/** Pure bounded command-log cache, status notifications and stale-response fences. */
import { expect, test } from '@playwright/test'
import type { CommandJobOutput, CommandJobSnapshot } from '../src/shared/command-job'
import type { EngineRequestInput } from '../src/shared/ipc'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import { activateCommandSession, deactivateCommandSession, getCommandJobs, getCommandOutputCacheUsage, ingestCommandJob, isCommandJobDeleted,
  refreshCommandJobs, refreshCommandOutput, retainCommandOutput, subscribeCommandJobs, subscribeCommandOutput } from '../src/renderer/src/core/engine/command-job-store'
import { emptyCommandOutput, mergeCommandOutput } from '../src/renderer/src/core/engine/command-job-state'

const job = (id: string, version = 1): CommandJobSnapshot => ({ schemaVersion: 1, jobId: id, sessionId: 'session', ownerSessionId: 'session',
  version, status: 'running', command: 'node', args: ['serve.js'], cwd: '/fixture', background: true, createdAt: 1, updatedAt: version,
  exitCode: null, signal: null, cursor: 2000, earliestCursor: 0 })
function page(snapshot: CommandJobSnapshot, seq: number, text = 'output\n'): CommandJobOutput {
  return { job: snapshot, entries: [{ seq, stream: 'stdout', text }], nextCursor: seq, nextOffset: 0, earliestCursor: 0, truncated: false, hasMore: false }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let originalWindow: PropertyDescriptor | undefined, read: (input: EngineRequestInput) => Promise<unknown>
test.beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  publishEngineSource({ mode: 'remote', baseUrl: 'http://command-cache.fixture', instanceId: test.info().title, phase: 'ready' })
  read = async input => { throw new Error(`Unexpected ${input.path}`) }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => ({ ok: true, code: 200, data: await read(input) })
  } } } })
  activateCommandSession('session', 'work')
})
test.afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'idle' })
})

test('starts at a bounded tail and reads one subsequent page without waking status consumers', async () => {
  ingestCommandJob(job('active'))
  const requests: EngineRequestInput[] = []
  let statuses = 0, ownOutput = 0, foreignOutput = 0
  const unsubscribe = [subscribeCommandJobs(() => statuses++), subscribeCommandOutput('session', 'active', () => ownOutput++),
    subscribeCommandOutput('session', 'other', () => foreignOutput++)]
  read = async input => {
    requests.push(input)
    return { ...page(job('active', requests.length + 1), 1000 + requests.length), tail: requests.length === 1, hasMore: true }
  }
  try {
    const first = await refreshCommandOutput('session', 'active')
    expect(requests).toHaveLength(1)
    expect(requests[0].query).toEqual({ sessionId: 'session', tail: true, maxBytes: 65536 })
    expect(first.output.tail).toBe(true); expect(first.output.truncated).toBe(false)
    await refreshCommandOutput('session', 'active')
    expect(requests).toHaveLength(2)
    expect(requests[1].query).toEqual({ sessionId: 'session', cursor: 1001, cursorOffset: 0, maxBytes: 65536 })
    expect(statuses).toBe(0); expect(ownOutput).toBe(2); expect(foreignOutput).toBe(0)
    ingestCommandJob({ ...job('active', 10), status: 'succeeded', exitCode: 0 })
    expect(statuses).toBe(1)
  } finally { unsubscribe.forEach(off => off()) }
})

test('keeps at most four 256 KiB log buffers while preserving job statuses', async () => {
  const requests: EngineRequestInput[] = []
  read = async input => {
    requests.push(input)
    const id = input.path.split('/').at(-2)!, cursor = Number(input.query?.cursor ?? 0)
    return { ...page(job(id), cursor + 1, 'x'.repeat(65536)), tail: input.query?.tail === true }
  }
  for (let index = 0; index < 5; index++) {
    const id = `job-${index}`; ingestCommandJob(job(id))
    for (let count = 0; count < 5; count++) await refreshCommandOutput('session', id)
    expect(getCommandOutputCacheUsage().jobs).toBeLessThanOrEqual(4)
    expect(getCommandOutputCacheUsage().bytes).toBeLessThanOrEqual(1024 * 1024)
  }
  expect(getCommandOutputCacheUsage()).toEqual({ jobs: 4, bytes: 1024 * 1024 })
  expect(getCommandJobs('session')).toHaveLength(5)
  await refreshCommandOutput('session', 'job-0')
  expect(requests.at(-1)?.query?.tail).toBe(true)
})

test('closing the last reader clears its log and fences a late response without detaching chat status', async () => {
  ingestCommandJob(job('owned'))
  const release = retainCommandOutput('session', 'owned')
  read = async () => ({ ...page(job('owned'), 1), tail: true })
  await refreshCommandOutput('session', 'owned')
  const delayed = deferred<unknown>()
  read = () => delayed.promise
  const pending = refreshCommandOutput('session', 'owned').then(() => 'unexpected', error => String(error))
  release()
  expect(getCommandOutputCacheUsage()).toEqual({ jobs: 0, bytes: 0 })
  expect(getCommandJobs('session')).toHaveLength(1)
  delayed.resolve(page(job('owned', 2), 2, 'LATE'))
  expect(await pending).toContain('视图已关闭')
  expect(getCommandOutputCacheUsage()).toEqual({ jobs: 0, bytes: 0 })
})

test('reopening the same log cannot reuse a dropped request or let its finally clear the new request', async () => {
  ingestCommandJob(job('reopened'))
  const close = retainCommandOutput('session', 'reopened')
  const oldRead = deferred<unknown>(), newRead = deferred<unknown>()
  let calls = 0
  read = () => ++calls === 1 ? oldRead.promise : newRead.promise
  const old = refreshCommandOutput('session', 'reopened').then(() => 'unexpected', error => String(error))
  close()
  const closeNew = retainCommandOutput('session', 'reopened')
  const current = refreshCommandOutput('session', 'reopened')
  oldRead.resolve(page(job('reopened', 2), 1, 'OLD'))
  expect(await old).toContain('视图已关闭')
  close() // A stale or repeated cleanup cannot release the new reader.
  const coalesced = refreshCommandOutput('session', 'reopened')
  newRead.resolve(page(job('reopened', 3), 2, 'CURRENT'))
  expect((await current).output.entries.map(entry => entry.text)).toEqual(['CURRENT'])
  expect(await coalesced).toBe(await current)
  expect(calls).toBe(2)
  expect(getCommandOutputCacheUsage().jobs).toBe(1)
  closeNew()
  expect(getCommandOutputCacheUsage().jobs).toBe(0)
})

test('revisiting a released session fences prior reads and reader cleanup without losing deletion tombstones', async () => {
  ingestCommandJob(job('gone'))
  read = async () => ({ jobs: [] })
  await refreshCommandJobs('session')
  expect(isCommandJobDeleted('session', 'gone')).toBe(true)
  ingestCommandJob(job('old'))
  const closeOld = retainCommandOutput('session', 'old')
  const oldList = deferred<unknown>()
  read = () => oldList.promise
  const pending = refreshCommandJobs('session', { force: true })
  deactivateCommandSession('work')
  activateCommandSession('session', 'work')
  expect(ingestCommandJob(job('gone'))).toBeUndefined()
  ingestCommandJob(job('old', 3))
  const closeCurrent = retainCommandOutput('session', 'old')
  read = async () => page(job('old', 3), 3, 'REVISITED')
  await refreshCommandOutput('session', 'old')
  closeOld()
  oldList.resolve({ jobs: [] }); await pending
  expect(getCommandJobs('session').map(item => item.jobId)).toEqual(['old'])
  expect(getCommandOutputCacheUsage().jobs).toBe(1)
  closeCurrent(); deactivateCommandSession('work')
  expect(getCommandOutputCacheUsage()).toEqual({ jobs: 0, bytes: 0 })
})

test('coalesces list requests and a short TTL, then reconciles confirmed absent jobs once', async () => {
  ingestCommandJob(job('gone')); ingestCommandJob(job('kept'))
  let calls = 0, changes = 0
  const off = subscribeCommandJobs(() => changes++)
  const delayed = deferred<unknown>()
  read = async () => { calls++; return delayed.promise }
  try {
    const first = refreshCommandJobs('session'), second = refreshCommandJobs('session')
    delayed.resolve({ jobs: [job('kept')] }); await Promise.all([first, second])
    await refreshCommandJobs('session')
    expect(calls).toBe(1); expect(changes).toBe(1)
    expect(isCommandJobDeleted('session', 'gone')).toBe(true)
    expect(getCommandJobs('session').map(value => value.jobId)).toEqual(['kept'])
    await refreshCommandJobs('session', { force: true }); expect(calls).toBe(2)
  } finally { off() }
})

test('an older empty list cannot remove a job advanced by the stream during that read', async () => {
  ingestCommandJob(job('advanced'))
  const delayed = deferred<unknown>(); read = () => delayed.promise
  const pending = refreshCommandJobs('session')
  ingestCommandJob(job('advanced', 2))
  delayed.resolve({ jobs: [] }); await pending
  expect(getCommandJobs('session').map(value => value.jobId)).toEqual(['advanced'])
  expect(isCommandJobDeleted('session', 'advanced')).toBe(false)
})

test('partial UTF-8 entries resume without duplication and a single huge entry still respects the cache budget', () => {
  const first = mergeCommandOutput(emptyCommandOutput, { ...page(job('partial'), 1, '😀中'), nextCursor: 0, nextOffset: 7, hasMore: true })
  const next = mergeCommandOutput(first, { ...page(job('partial'), 1, '文\0done'), nextCursor: 1, nextOffset: 0 })
  expect(next.entries).toEqual([{ seq: 1, stream: 'stdout', text: '😀中文\0done' }])
  expect(next.cursorOffset).toBe(0)
  expect(mergeCommandOutput(first, { ...page(job('partial'), 1, '😀中'), nextCursor: 0, nextOffset: 7, hasMore: true })).toBe(first)
  const huge = mergeCommandOutput(emptyCommandOutput, page(job('huge'), 1, '😀'.repeat(100000)))
  expect(huge.bytes).toBeLessThanOrEqual(256 * 1024)
  expect(huge.tail).toBe(true); expect(huge.truncated).toBe(false)
  expect(huge.entries[0].text).not.toContain('�')
})
