import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import {
  NextTurnQueueError,
  DEFAULT_NEXT_TURN_QUEUE_LIMITS,
  type NextTurnQueueEnvelope,
  type NextTurnQueueScope,
  type QueueCommitResult
} from '../src/shared/next-turn-queue'
import {
  applyNextTurnQueueMutation,
  assertQueueEnvelope,
  assertQueueJsonValue,
  queueMentionToken,
  emptyNextTurnQueue,
  queueScopeIdentity
} from '../src/shared/next-turn-queue-state'
import { NextTurnQueueStore } from '../src/main/next-turn-queue-store'
import {
  mentionToken,
  buildMentionMessage,
  userMessageDraft,
  type Mention
} from '../src/renderer/src/contrib/chat/mention-context'
import {
  NextTurnQueueMutationService,
  type QueueOwnerCapability
} from '../src/main/next-turn-queue-service'

/** WQ0–WQ1 only: real files, two actual Node owners, kill/ACK-loss, recovery, validation and lifecycle fences. */
let fixture: string
const children: ChildProcess[] = []
const closed = new WeakMap<ChildProcess, Promise<void>>()
const scope: NextTurnQueueScope = {
  source: { mode: 'embedded', endpoint: '', accountId: 'account-one' },
  tenantId: 'tenant-one',
  namespace: { id: 'synthetic-db', generation: 'one' },
  owner: 'work',
  taskId: 'work-a'
}
const envelope = (text = 'one', owner = scope): NextTurnQueueEnvelope => ({
  draft: { text, revision: 1, mentions: [] },
  model: { kind: 'explicit', modelId: 'synthetic-model' },
  workspace: {
    kind: owner.source.mode === 'remote' ? 'remote-session' : 'local-scratch',
    identity: 'owned-workspace'
  },
  agent: { primaryAgentId: null, collaborators: [] },
  resources: {
    skills: { kind: 'inherit' },
    mcpServers: { kind: 'none' },
    knowledgeBases: { kind: 'override', ids: ['kb-one'] }
  },
  thinking: { kind: 'off' },
  memory: { kind: 'override', scope: 'off', version: 'memory-v1' },
  security: { policy: 'engine-session', observedVersion: 'safety-v1' },
  attachments: []
})
function service(store: NextTurnQueueStore, owner = scope) {
  return new NextTurnQueueMutationService(store, {
    capture: async (taskId) => ({ scope: { ...owner, taskId }, generation: 'trusted-owner' }),
    assertCurrent: () => {}
  })
}
async function create(initial = 'one') {
  const store = new NextTurnQueueStore(fixture),
    owner = service(store),
    capability = await owner.bind(scope.taskId)
  const first = await owner.mutate(capability, 0, 'operation-first', {
    kind: 'enqueue',
    id: 'entry-one',
    envelope: envelope(initial),
    at: 1
  })
  return { store, owner, capability, first }
}
interface WorkerMessage {
  type: string
  ok?: boolean
  result?: QueueCommitResult
  error?: { code: string; message: string; evidencePath?: string }
  stage?: string
  ready?: string
  committed?: string
  serviceClosed?: boolean
  diagnostics?: {
    bindings: number
    mutationBuckets: number
    ownedOperations: number
    pendingMutationBytes: number
    closing: boolean
  }
}
function worker(config: Record<string, unknown>) {
  const process = fork(join(__dirname, 'fixtures/next-turn-queue-worker.cjs'), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  children.push(process)
  const out: WorkerMessage[] = [],
    waiters: Array<{
      type: string
      resolve: (message: WorkerMessage) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }> = []
  let stderr = ''
  process.stderr?.on('data', (data) => {
    stderr += String(data)
  })
  const completion = new Promise<void>((resolveClose, rejectClose) => {
    process.once('error', rejectClose)
    process.once('close', () => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Worker closed before ' + waiter.type + ': ' + stderr))
      }
      waiters.length = 0
      resolveClose()
    })
  })
  closed.set(process, completion)
  process.on('message', (value: WorkerMessage) => {
    const index = waiters.findIndex((item) => item.type === value.type)
    if (index < 0) out.push(value)
    else {
      const waiter = waiters.splice(index, 1)[0]
      clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
  })
  const wait = (type: string): Promise<WorkerMessage> => {
    const index = out.findIndex((value) => value.type === type)
    if (index >= 0) return Promise.resolve(out.splice(index, 1)[0])
    return new Promise((resolveMessage, reject) => {
      const waiter = {
        type,
        resolve: resolveMessage,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('Worker signal timeout ' + type + ': ' + stderr))
        }, 15000)
      }
      waiters.push(waiter)
    })
  }
  process.send({ type: 'start', root: fixture, scope, ...config })
  return { process, wait, completion, release: () => process.send({ type: 'release' }) }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const object = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
      .join(',') +
    '}'
  )
}
test.beforeEach(async () => {
  const root = resolve('.e2e-tmp')
  await fs.mkdir(root, { recursive: true })
  fixture = await fs.mkdtemp(join(root, 'next-turn-foundation-'))
})
test.afterEach(async () => {
  const joined: {
    pid: number | undefined
    exitCode: number | null
    signal: NodeJS.Signals | null
    closeJoined: true
  }[] = []
  for (const process of children.splice(0)) {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
    await closed.get(process)
    joined.push({
      pid: process.pid,
      exitCode: process.exitCode,
      signal: process.signalCode,
      closeJoined: true
    })
  }
  const owned = await fs.realpath(fixture),
    root = resolve('.e2e-tmp'),
    relation = relative(root, owned)
  if (!relation || relation.startsWith('..' + sep) || relation === '..' || resolve(owned) === root)
    throw new Error('Refusing non-owned cleanup')
  await fs.rm(owned, { recursive: true, force: true })
  await expect(fs.stat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  test.info().annotations.push({
    type: 'owned-close-and-cleanup',
    description: JSON.stringify({
      fixture: owned,
      verifiedWithinRoot: root,
      processes: joined,
      removed: true
    })
  })
})

test('scope identity isolates same task across account/namespace/source and keeps independent disk entries', async () => {
  const store = new NextTurnQueueStore(fixture)
  const variants = [
    scope,
    { ...scope, taskId: 'work-b' },
    { ...scope, source: { ...scope.source, accountId: 'account-two' } },
    { ...scope, namespace: { ...scope.namespace, generation: 'two' } },
    {
      ...scope,
      source: {
        mode: 'remote' as const,
        endpoint: 'https://queue.example.test',
        accountId: 'account-one'
      }
    }
  ]
  expect(new Set(variants.map(queueScopeIdentity)).size).toBe(5)
  for (const [index, target] of variants.entries()) {
    const owner = service(store, target),
      cap = await owner.bind(target.taskId)
    await owner.mutate(cap, 0, 'scope-' + index, {
      kind: 'enqueue',
      id: 'same-entry-id',
      envelope: envelope('scope-' + index, target),
      at: 1
    })
    await owner.close()
  }
  for (const [index, target] of variants.entries())
    expect((await store.read(target)).state.entries[0].envelope.draft.text).toBe('scope-' + index)
  expect((await fs.readdir(fixture)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(5)
})

test('authoritative binding rejects copied/foreign/released capabilities and scope changes before commit', async () => {
  const { store, owner, capability } = await create(),
    other = service(store)
  await expect(other.read(capability)).rejects.toMatchObject({ code: 'AUTHORITY' })
  await expect(owner.read({ ...capability } as QueueOwnerCapability)).rejects.toMatchObject({
    code: 'AUTHORITY'
  })
  owner.release(capability)
  await expect(owner.read(capability)).rejects.toMatchObject({ code: 'AUTHORITY' })
  await owner.close()
  await other.close()
  let current = true,
    reached!: () => void,
    release!: () => void
  const barrier = new Promise<void>((resolve) => {
      reached = resolve
    }),
    held = new Promise<void>((resolve) => {
      release = resolve
    })
  const heldStore = new NextTurnQueueStore(fixture, {
    testHook: async (context) => {
      if (context.phase === 'after-ready-rename') {
        reached()
        await held
      }
    }
  })
  const guarded = new NextTurnQueueMutationService(heldStore, {
      capture: async () => ({ scope, generation: 'epoch-one' }),
      assertCurrent: () => {
        if (!current) throw new NextTurnQueueError('AUTHORITY', 'Source changed')
      }
    }),
    cap = await guarded.bind(scope.taskId)
  const mutation = guarded.mutate(cap, 1, 'late-source', {
    kind: 'enqueue',
    id: 'entry-two',
    envelope: envelope('late'),
    at: 2
  })
  const settled = mutation.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  await barrier
  current = false
  release()
  expect(await settled).toMatchObject({ error: { code: 'AUTHORITY' } })
  expect((await store.read(scope)).state.entries.map((entry) => entry.id)).toEqual(['entry-one'])
  expect(await store.findReceipt(scope, 'late-source')).toBeNull()
  await guarded.close()
})

test('resource/default selectors and exact authored mentions survive real restart without volatile upload tokens', async () => {
  const { store, owner, capability } = await create()
  const next = envelope('@agent-design make it')
  next.draft.mentions = [
    { source: 'agent', displayText: 'Designer', textOffset: 0, path: 'agent-design' }
  ]
  next.agent.collaborators = [{ agentId: 'agent-design' }]
  next.model = { kind: 'engine-default', observedModelId: 'observed-model' }
  next.attachments = [
    {
      kind: 'local-scratch',
      scope,
      path: '.ae/attachments/file.txt',
      name: 'file.txt',
      mime: 'text/plain',
      bytes: 3,
      receiptId: 'attachment-stable-receipt',
      sha256: 'a'.repeat(64)
    }
  ]
  await owner.mutate(capability, 1, 'edit-selectors', {
    kind: 'edit',
    id: 'entry-one',
    entryRevision: 1,
    envelope: next,
    at: 2
  })
  await owner.close()
  const recovered = (await new NextTurnQueueStore(fixture).read(scope)).state.entries[0]
  expect(recovered.envelope).toEqual(next)
  const raw = await fs.readFile(join(store.bucketPath(scope), 'r0000000002.json'), 'utf8')
  expect(raw).not.toContain('remoteUploadId')
  expect(raw).not.toContain('apiKey')
  const poisoned = {
    ...next,
    attachments: [{ ...next.attachments[0], remoteUploadId: 'volatile' }]
  }
  expect(() => assertQueueEnvelope(poisoned, scope)).toThrow(/unsupported field/)
  const forged = {
    ...next,
    attachments: [{ ...next.attachments[0], scope: { ...scope, taskId: 'work-b' } }]
  }
  expect(() => assertQueueEnvelope(forged, scope)).toThrow(/another task/)
  const emptyOverride = {
    ...next,
    resources: { ...next.resources, skills: { kind: 'override', ids: [] } }
  }
  expect(() => assertQueueEnvelope(emptyOverride, scope)).toThrow(/use none/)
})

test('edit/removal/reorder use IDs and revisions, cancel/draft callers keep immutable originals', async () => {
  const { store, owner, capability } = await create()
  const before = envelope('caller draft'),
    copy = structuredClone(before)
  await owner.mutate(capability, 1, 'enqueue-two', {
    kind: 'enqueue',
    id: 'entry-two',
    envelope: before,
    at: 2
  })
  before.draft.text = 'typed after ACK'
  await owner.mutate(capability, 2, 'reorder', {
    kind: 'move',
    id: 'entry-two',
    beforeId: 'entry-one'
  })
  const current = (await store.read(scope)).state
  expect(current.entries.map((item) => item.id)).toEqual(['entry-two', 'entry-one'])
  expect(current.entries[0].envelope).toEqual(copy)
  await expect(
    owner.mutate(capability, 2, 'stale-editor', {
      kind: 'edit',
      id: 'entry-one',
      entryRevision: 1,
      envelope: envelope('stale'),
      at: 3
    })
  ).rejects.toMatchObject({ code: 'CAS' })
  await owner.mutate(capability, 3, 'edit', {
    kind: 'edit',
    id: 'entry-one',
    entryRevision: 1,
    envelope: envelope('edited'),
    at: 3
  })
  await expect(
    owner.mutate(capability, 4, 'stale-remove', {
      kind: 'remove',
      id: 'entry-one',
      entryRevision: 1,
      at: 4
    })
  ).rejects.toMatchObject({ code: 'CAS' })
  await owner.mutate(capability, 4, 'remove', {
    kind: 'remove',
    id: 'entry-one',
    entryRevision: 2,
    at: 4
  })
  await expect(
    owner.mutate(capability, 5, 'resurrect', {
      kind: 'enqueue',
      id: 'entry-one',
      envelope: envelope('bad'),
      at: 5
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  expect((await store.read(scope)).state.entries.map((item) => item.id)).toEqual(['entry-two'])
  await owner.close()
})

test('two actual Node instances race the same revision and exactly one disk commit succeeds', async () => {
  const { store, owner } = await create()
  await owner.close()
  const config = (id: string) => ({
    expectedRevision: 1,
    operationId: 'race-' + id,
    holdAt: 'after-ready-rename',
    operation: { kind: 'enqueue', id, envelope: envelope(id), at: 2 }
  })
  const left = worker(config('left')),
    right = worker(config('right'))
  await Promise.all([left.wait('barrier'), right.wait('barrier')])
  left.release()
  right.release()
  const results = await Promise.all([left.wait('result'), right.wait('result')])
  await Promise.all([left.completion, right.completion])
  for (const result of results) {
    expect(result.serviceClosed).toBe(true)
    expect(result.diagnostics).toEqual({
      bindings: 0,
      mutationBuckets: 0,
      ownedOperations: 0,
      pendingMutationBytes: 0,
      closing: true
    })
  }
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: 'CAS' }) })
  ])
  const current = (await store.read(scope)).state
  expect(current.revision).toBe(2)
  expect(current.entries).toHaveLength(2)
  expect(current.entries[1].id).toBe(
    results.find((result) => result.ok)!.result!.state.entries[1].id
  )
  const receipts = await Promise.all(
    ['race-left', 'race-right'].map((id) => store.findReceipt(scope, id))
  )
  expect(receipts.filter(Boolean)).toHaveLength(1)
})

test('same local operation key returns its accurate commit receipt and changed bytes conflict', async () => {
  const { store, owner, capability, first } = await create()
  const repeated = await owner.mutate(capability, 0, 'operation-first', {
    kind: 'enqueue',
    id: 'entry-one',
    envelope: envelope(),
    at: 1
  })
  expect(repeated.replayed).toBe(true)
  expect(repeated.receipt).toEqual(first.receipt)
  expect(repeated.durabilityWarnings.filter((item) => item.startsWith('directory-sync-'))).toEqual(
    first.durabilityWarnings.filter((item) => item.startsWith('directory-sync-'))
  )
  test.info().annotations.push({
    type: 'directory-sync-observed',
    description: JSON.stringify({
      first: first.durabilityWarnings,
      replayed: repeated.durabilityWarnings
    })
  })
  await expect(
    owner.mutate(capability, 0, 'operation-first', {
      kind: 'enqueue',
      id: 'different',
      envelope: envelope(),
      at: 1
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  expect((await store.read(scope)).state.revision).toBe(1)
  await owner.close()
})

for (const phase of ['after-ready-rename', 'after-publish'] as const)
  test(
    'real kill/restart at ' + phase + ' preserves commit boundary and exact operation receipt',
    async () => {
      const { owner } = await create()
      await owner.close()
      const child = worker({
        expectedRevision: 1,
        operationId: 'killed-operation',
        holdAt: phase,
        operation: { kind: 'enqueue', id: 'entry-two', envelope: envelope('after kill'), at: 2 }
      })
      const reached = await child.wait('barrier')
      expect(
        await fs.stat(phase === 'after-publish' ? reached.committed! : reached.ready!)
      ).toMatchObject({ size: expect.any(Number) })
      child.process.kill('SIGKILL')
      await child.completion
      const restarted = new NextTurnQueueStore(fixture),
        current = await restarted.read(scope),
        commit = await restarted.findReceipt(scope, 'killed-operation')
      expect(current.state.revision).toBe(phase === 'after-publish' ? 2 : 1)
      expect(Boolean(commit)).toBe(phase === 'after-publish')
      expect(current.auxiliaryFiles.some((name) => name.startsWith('ready-'))).toBe(true)
      const newOwner = service(restarted),
        cap = await newOwner.bind(scope.taskId)
      const result = await newOwner.mutate(cap, 1, 'killed-operation', {
        kind: 'enqueue',
        id: 'entry-two',
        envelope: envelope('after kill'),
        at: 2
      })
      expect(result.state.entries.filter((item) => item.id === 'entry-two')).toHaveLength(1)
      expect(result.replayed).toBe(phase === 'after-publish')
      await newOwner.close()
    }
  )

test('a compatible persisted dispatching snapshot recovers to unknown and cannot be edited/cleared/resumed', async () => {
  const { store, owner } = await create()
  await owner.close()
  const file = join(store.bucketPath(scope), 'r0000000001.json'),
    record = JSON.parse(await fs.readFile(file, 'utf8'))
  record.state.entries[0] = {
    ...record.state.entries[0],
    phase: 'dispatching',
    frozen: {
      requestKey: 'future-admission',
      bodyDigest: 'b'.repeat(64),
      entryRevision: 1,
      anchor: null
    }
  }
  const { snapshotDigest: discarded, ...unsigned } = record
  void discarded
  record.snapshotDigest = createHash('sha256').update(canonical(unsigned)).digest('hex')
  await fs.writeFile(file, canonical(record))
  const restarted = service(new NextTurnQueueStore(fixture)),
    cap = await restarted.bind(scope.taskId),
    recovered = await restarted.recover(cap, 10)
  expect(recovered.state.entries[0].phase).toBe('admission-unknown')
  expect(recovered.state.paused).toBe(true)
  await expect(
    restarted.mutate(cap, 2, 'edit-unknown', {
      kind: 'edit',
      id: 'entry-one',
      entryRevision: 1,
      envelope: envelope('overwrite'),
      at: 11
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  await restarted.mutate(cap, 2, 'clear-pending', { kind: 'clear-pending', at: 11 })
  expect((await store.read(scope)).state.entries).toHaveLength(1)
  await expect(
    restarted.mutate(cap, 3, 'resume-unknown', { kind: 'resume' })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  await restarted.close()
})

for (const fault of ['write-path-is-directory', 'close-before-fsync', 'rename-target-is-directory'])
  test('actual ' + fault + ' refuses success and retains disk/evidence', async () => {
    const { store, owner } = await create()
    await owner.close()
    const child = worker({
      expectedRevision: 1,
      operationId: 'failed-' + fault,
      fault,
      operation: { kind: 'enqueue', id: 'entry-two', envelope: envelope('must not commit'), at: 2 }
    })
    const result = await child.wait('result')
    await child.completion
    expect(result.ok).toBe(false)
    expect(result.error!.code).toBe('IO')
    expect(result.serviceClosed).toBe(true)
    expect(result.diagnostics).toEqual({
      bindings: 0,
      mutationBuckets: 0,
      ownedOperations: 0,
      pendingMutationBytes: 0,
      closing: true
    })
    expect(result.error!.evidencePath).toBeTruthy()
    const evidence = JSON.parse(await fs.readFile(result.error!.evidencePath!, 'utf8'))
    expect(evidence.phase).toBe(
      fault === 'write-path-is-directory'
        ? 'write'
        : fault === 'close-before-fsync'
          ? 'file-fsync'
          : 'ready-rename'
    )
    await expect(fs.stat(join(store.bucketPath(scope), 'r0000000002.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    const preserved = JSON.parse(
      await fs.readFile(join(store.bucketPath(scope), 'r0000000001.json'), 'utf8')
    )
    expect(preserved.state.entries.map((item: { id: string }) => item.id)).toEqual(['entry-one'])
    if (fault === 'close-before-fsync')
      expect(await store.findReceipt(scope, 'failed-' + fault)).toBeNull()
    else await expect(store.read(scope)).rejects.toMatchObject({ code: 'CORRUPT' })
  })

test('malformed/checksum-changed/missing journal fails visibly and never becomes empty', async () => {
  const { store, owner } = await create()
  await owner.close()
  const file = join(store.bucketPath(scope), 'r0000000001.json'),
    original = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, '{broken')
  await expect(store.read(scope)).rejects.toMatchObject({
    code: 'CORRUPT',
    evidencePath: expect.any(String)
  })
  expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  const changed = JSON.parse(original)
  changed.state.entries[0].envelope.draft.text = 'tampered'
  await fs.writeFile(file, JSON.stringify(changed))
  await expect(store.read(scope)).rejects.toMatchObject({ code: 'CORRUPT' })
  await fs.writeFile(file, original)
  await fs.rename(file, join(store.bucketPath(scope), 'renamed-committed.json'))
  await expect(store.read(scope)).rejects.toMatchObject({ code: 'CORRUPT' })
})

test('capacity uses UTF-8/state/journal budgets and refuses overflow without deleting existing entries', async () => {
  const small = {
    ...DEFAULT_NEXT_TURN_QUEUE_LIMITS,
    maxEntries: 1,
    maxTextBytes: 9,
    maxRevisions: 3,
    maxJournalBytes: 128000
  }
  const store = new NextTurnQueueStore(fixture, { limits: small }),
    owner = service(store),
    cap = await owner.bind(scope.taskId)
  await owner.mutate(cap, 0, 'small-first', {
    kind: 'enqueue',
    id: 'entry-one',
    envelope: envelope('一二三'),
    at: 1
  })
  await expect(
    owner.mutate(cap, 1, 'overflow-text', {
      kind: 'edit',
      id: 'entry-one',
      entryRevision: 1,
      envelope: envelope('一二三四'),
      at: 2
    })
  ).rejects.toMatchObject({ code: 'CAPACITY' })
  await expect(
    owner.mutate(cap, 1, 'overflow-entry', {
      kind: 'enqueue',
      id: 'entry-two',
      envelope: envelope('two'),
      at: 2
    })
  ).rejects.toMatchObject({ code: 'CAPACITY' })
  await owner.mutate(cap, 1, 'small-pause', { kind: 'pause', reason: 'user' })
  await expect(owner.mutate(cap, 2, 'overflow-journal', { kind: 'resume' })).rejects.toMatchObject({
    code: 'CAPACITY'
  })
  expect((await store.read(scope)).state.entries[0].envelope.draft.text).toBe('一二三')
  await owner.close()
  const state = emptyNextTurnQueue(scope)
  expect(() =>
    applyNextTurnQueueMutation(
      state,
      0,
      { kind: 'enqueue', id: 'big', envelope: envelope('x'.repeat(100)), at: 1 },
      { ...DEFAULT_NEXT_TURN_QUEUE_LIMITS, maxStateBytes: 100 }
    )
  ).toThrow(/UTF-8 byte budget/)
})

test('close joins held disk mutation, fences late publication, and rejects queued work without leaking buckets', async () => {
  let reached!: () => void, release!: () => void
  const barrier = new Promise<void>((resolve) => {
      reached = resolve
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
  const store = new NextTurnQueueStore(fixture, {
      testHook: async (context) => {
        if (context.phase === 'after-ready-rename') {
          reached()
          await hold
        }
      }
    }),
    owner = service(store),
    cap = await owner.bind(scope.taskId)
  const first = owner
    .mutate(cap, 0, 'held', { kind: 'enqueue', id: 'entry-one', envelope: envelope(), at: 1 })
    .then(
      (result) => ({ result }),
      (error) => ({ error })
    )
  const queued = owner.mutate(cap, 1, 'queued', { kind: 'pause', reason: 'later' }).then(
    (result) => ({ result }),
    (error) => ({ error })
  )
  await barrier
  let closeFinished = false
  const closing = owner.close().then(() => {
    closeFinished = true
  })
  await new Promise<void>((done) => setImmediate(done))
  expect(closeFinished).toBe(false)
  release()
  expect(await first).toMatchObject({ error: { code: 'AUTHORITY' } })
  expect(await queued).toMatchObject({ error: { code: 'AUTHORITY' } })
  await closing
  expect(owner.diagnostics()).toEqual({
    bindings: 0,
    mutationBuckets: 0,
    ownedOperations: 0,
    pendingMutationBytes: 0,
    closing: true
  })
  expect((await store.read(scope)).state.revision).toBe(0)
  expect(await store.findReceipt(scope, 'held')).toBeNull()
})

test('missing bootstrap mutations cannot silently reconstruct an existing bucket, including only auxiliary evidence', async () => {
  const { store, owner } = await create()
  await owner.close()
  const bucket = store.bucketPath(scope)
  await fs.unlink(join(bucket, 'r0000000000.json'))
  await expect(
    store.mutate(
      scope,
      0,
      'must-not-rebuild',
      { kind: 'enqueue', id: 'replacement', envelope: envelope('bad'), at: 2 },
      () => {}
    )
  ).rejects.toMatchObject({ code: 'CORRUPT', evidencePath: expect.any(String) })
  await expect(fs.stat(join(bucket, 'r0000000000.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await fs.unlink(join(bucket, 'r0000000001.json'))
  const names = await fs.readdir(bucket)
  expect(names.some((name) => name.startsWith('error-'))).toBe(true)
  await expect(
    store.mutate(
      scope,
      0,
      'auxiliary-only',
      { kind: 'enqueue', id: 'replacement', envelope: envelope('bad'), at: 3 },
      () => {}
    )
  ).rejects.toMatchObject({ code: 'CORRUPT' })
  await expect(fs.stat(join(bucket, 'r0000000000.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('two real first owners initialize one journal without overwrite or empty reconstruction', async () => {
  const config = (id: string) => ({
    expectedRevision: 0,
    operationId: 'initial-' + id,
    operation: { kind: 'enqueue', id, envelope: envelope(id), at: 1 }
  })
  const left = worker(config('left')),
    right = worker(config('right'))
  const results = await Promise.all([left.wait('result'), right.wait('result')])
  await Promise.all([left.completion, right.completion])
  for (const result of results) {
    expect(result.serviceClosed).toBe(true)
    expect(result.diagnostics).toEqual({
      bindings: 0,
      mutationBuckets: 0,
      ownedOperations: 0,
      pendingMutationBytes: 0,
      closing: true
    })
  }
  expect(results.filter((item) => item.ok)).toHaveLength(1)
  expect(results.filter((item) => !item.ok)).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: 'CAS' }) })
  ])
  const state = (await new NextTurnQueueStore(fixture).read(scope)).state
  expect(state.revision).toBe(1)
  expect(state.entries).toHaveLength(1)
})

test('unacknowledged initialization marker blocks mutation without assuming a crashed creator is dead', async () => {
  const store = new NextTurnQueueStore(fixture),
    bucket = store.bucketPath(scope)
  await fs.mkdir(bucket)
  const marker = join(bucket, 'initializing-00000000-0000-0000-0000-000000000000.json')
  await fs.writeFile(marker, '{"synthetic":"retained"}')
  await expect(
    store.mutate(
      scope,
      0,
      'blocked-initialization',
      { kind: 'enqueue', id: 'new', envelope: envelope(), at: 1 },
      () => {}
    )
  ).rejects.toMatchObject({ code: 'CAS' })
  expect(await fs.readFile(marker, 'utf8')).toBe('{"synthetic":"retained"}')
  await expect(store.read(scope)).rejects.toMatchObject({ code: 'CORRUPT' })
  await expect(fs.stat(join(bucket, 'r0000000000.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('observed auxiliary count and byte budgets stop new staging without deleting evidence or commitments', async () => {
  const { store, owner } = await create()
  await owner.close()
  const bucket = store.bucketPath(scope),
    ready = join(bucket, 'ready-00000000-0000-0000-0000-000000000000.json')
  await fs.writeFile(ready, 'x'.repeat(4096))
  const bounded = new NextTurnQueueStore(fixture, {
    limits: { ...DEFAULT_NEXT_TURN_QUEUE_LIMITS, maxAuxiliaryFiles: 1, maxAuxiliaryBytes: 8192 }
  })
  await expect(
    bounded.mutate(scope, 1, 'over-aux-count', { kind: 'pause', reason: 'later' }, () => {})
  ).rejects.toMatchObject({ code: 'CAPACITY' })
  const bytesBounded = new NextTurnQueueStore(fixture, {
    limits: { ...DEFAULT_NEXT_TURN_QUEUE_LIMITS, maxAuxiliaryBytes: 4096 }
  })
  await expect(
    bytesBounded.mutate(scope, 1, 'over-aux-bytes', { kind: 'pause', reason: 'later' }, () => {})
  ).rejects.toMatchObject({ code: 'CAPACITY' })
  expect(await fs.readFile(ready, 'utf8')).toBe('x'.repeat(4096))
  expect((await store.read(scope)).state.revision).toBe(1)
  expect((await fs.readdir(bucket)).filter((name) => name.startsWith('ready-'))).toEqual([
    ready.slice(bucket.length + 1)
  ])
})

test('corrupt receipt lookup retains an error record and never claims unknown operations are absent', async () => {
  const { store, owner } = await create()
  await owner.close()
  const file = join(store.bucketPath(scope), 'r0000000001.json')
  await fs.writeFile(file, '{broken')
  await expect(store.findReceipt(scope, 'operation-first')).rejects.toMatchObject({
    code: 'CORRUPT',
    evidencePath: expect.any(String)
  })
  expect(await fs.readFile(file, 'utf8')).toBe('{broken')
})

test('non-JSON values fail before cloning/hashing and caller changes before the first await do not alter a submitted envelope', async () => {
  const { store, owner, capability } = await create()
  const draft = envelope('captured now'),
    operation = { kind: 'enqueue' as const, id: 'entry-two', envelope: draft, at: 2 }
  const pending = owner.mutate(capability, 1, 'immutable-now', operation)
  draft.draft.text = 'changed immediately'
  await pending
  expect((await store.read(scope)).state.entries[1].envelope.draft.text).toBe('captured now')
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const value of [
    cyclic,
    new Map(),
    { bad: BigInt(1) },
    { bad: Infinity },
    {
      get bad() {
        throw new Error('getter must not execute')
      }
    }
  ]) {
    await expect(
      owner.mutate(
        capability,
        2,
        'invalid-json',
        value as unknown as Parameters<typeof owner.mutate>[3]
      )
    ).rejects.toMatchObject({ code: 'INVALID' })
  }
  expect((await store.read(scope)).state.revision).toBe(2)
  await owner.close()
})

test('close joins in-flight authority capture and file reads, is idempotent, and fences their results', async () => {
  let reached!: () => void, release!: () => void
  const barrier = new Promise<void>((done) => {
      reached = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  const store = new NextTurnQueueStore(fixture),
    owner = new NextTurnQueueMutationService(store, {
      capture: async () => {
        reached()
        await held
        return { scope, generation: 'delayed' }
      },
      assertCurrent: () => {}
    })
  const binding = owner.bind(scope.taskId).then(
    (result) => ({ result }),
    (error) => ({ error })
  )
  await barrier
  let finished = false
  const closing = owner.close().then(() => {
    finished = true
  })
  expect(owner.close()).toBe(owner.close())
  await new Promise<void>((done) => setImmediate(done))
  expect(finished).toBe(false)
  release()
  expect(await binding).toMatchObject({ error: { code: 'AUTHORITY' } })
  await closing
  expect(owner.diagnostics()).toEqual({
    bindings: 0,
    mutationBuckets: 0,
    ownedOperations: 0,
    pendingMutationBytes: 0,
    closing: true
  })
  const created = await create(),
    originalRead = created.store.read.bind(created.store)
  let readReached!: () => void, readRelease!: () => void
  const readBarrier = new Promise<void>((done) => {
      readReached = done
    }),
    readHeld = new Promise<void>((done) => {
      readRelease = done
    })
  created.store.read = async (target) => {
    const result = await originalRead(target)
    readReached()
    await readHeld
    return result
  }
  const reading = created.owner.read(created.capability).then(
    (result) => ({ result }),
    (error) => ({ error })
  )
  await readBarrier
  finished = false
  const readClosing = created.owner.close().then(() => {
    finished = true
  })
  await new Promise<void>((done) => setImmediate(done))
  expect(finished).toBe(false)
  readRelease()
  expect(await reading).toMatchObject({ error: { code: 'AUTHORITY' } })
  await readClosing
  expect(created.owner.diagnostics()).toEqual({
    bindings: 0,
    mutationBuckets: 0,
    ownedOperations: 0,
    pendingMutationBytes: 0,
    closing: true
  })
})

test('one main owner serializes same-bucket mutations and returns a CAS failure to a stale queued draft', async () => {
  const created = await create()
  await created.owner.close()
  let reached!: () => void, release!: () => void
  const barrier = new Promise<void>((done) => {
      reached = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  let active = 0,
    maximum = 0
  const store = new NextTurnQueueStore(fixture, {
    testHook: async (context) => {
      if (context.phase === 'after-ready-rename') {
        active++
        maximum = Math.max(maximum, active)
        reached()
        await held
        active--
      }
    }
  })
  const owner = service(store),
    cap = await owner.bind(scope.taskId)
  const first = owner.mutate(cap, 1, 'fifo-first', {
    kind: 'enqueue',
    id: 'entry-two',
    envelope: envelope('first queued'),
    at: 2
  })
  const second = owner
    .mutate(cap, 1, 'fifo-stale', {
      kind: 'enqueue',
      id: 'entry-three',
      envelope: envelope('second queued'),
      at: 3
    })
    .then(
      (result) => ({ result }),
      (error) => ({ error })
    )
  await barrier
  await new Promise<void>((done) => setImmediate(done))
  expect(maximum).toBe(1)
  release()
  expect((await first).state.revision).toBe(2)
  expect(await second).toMatchObject({ error: { code: 'CAS' } })
  expect((await store.read(scope)).state.entries.map((item) => item.id)).toEqual([
    'entry-one',
    'entry-two'
  ])
  await owner.close()
  expect(owner.diagnostics().mutationBuckets).toBe(0)
})

test('capability count budget is bounded, release makes capacity reusable, and close clears owned identities', async () => {
  const store = new NextTurnQueueStore(fixture),
    owner = new NextTurnQueueMutationService(
      store,
      {
        capture: async (taskId) => ({ scope: { ...scope, taskId }, generation: 'one' }),
        assertCurrent: () => {}
      },
      1
    )
  const first = await owner.bind('work-a')
  await expect(owner.bind('work-b')).rejects.toMatchObject({ code: 'CAPACITY' })
  expect(owner.diagnostics().bindings).toBe(1)
  owner.release(first)
  const next = await owner.bind('work-b')
  expect((await owner.read(next)).state.scope.taskId).toBe('work-b')
  await owner.close()
  expect(owner.diagnostics()).toEqual({
    bindings: 0,
    mutationBuckets: 0,
    ownedOperations: 0,
    pendingMutationBytes: 0,
    closing: true
  })
})

test('actual composer serializer file/code/Agent/terminal tokens retain exact offsets through durable restart', async () => {
  const mentions: Mention[] = [
    {
      source: 'file',
      displayText: 'long-file.ts',
      path: 'src/features/really-long-folder/long-file.ts'
    },
    {
      source: 'code',
      displayText: '选中的代码',
      path: 'src/features/code.ts',
      startLine: 12,
      endLine: 18,
      startColumn: 2,
      endColumn: 9,
      content: 'const sample = 42'
    },
    { source: 'agent', displayText: '审查 Agent', path: 'agent-review' },
    { source: 'terminal', displayText: '终端输出', content: 'synthetic stdout' }
  ]
  let authored = '检查 '
  for (const mention of mentions) {
    mention.textOffset = authored.length
    expect(queueMentionToken(mention)).toBe(mentionToken(mention))
    authored += mentionToken(mention) + '； '
  }
  const serialized = buildMentionMessage(authored.trimEnd(), mentions, { includeAgentRefs: true }),
    draft = userMessageDraft(serialized)
  const next = envelope(draft.text)
  next.draft.mentions = draft.mentions.map((mention) => {
    if (mention.textOffset === undefined) throw new Error('Real serializer lost offset')
    return { ...mention, textOffset: mention.textOffset }
  })
  expect(next.draft.mentions.map((mention) => mention.source)).toEqual([
    'file',
    'code',
    'agent',
    'terminal'
  ])
  next.agent.collaborators = [{ agentId: 'agent-review' }]
  for (const mention of next.draft.mentions)
    expect(
      draft.text.slice(mention.textOffset, mention.textOffset + mentionToken(mention).length)
    ).toBe(mentionToken(mention))
  const store = new NextTurnQueueStore(fixture),
    owner = service(store),
    cap = await owner.bind(scope.taskId)
  await owner.mutate(cap, 0, 'actual-mentions', {
    kind: 'enqueue',
    id: 'references',
    envelope: next,
    at: 1
  })
  await owner.close()
  expect(
    (await new NextTurnQueueStore(fixture).read(scope)).state.entries[0].envelope.draft
  ).toEqual(next.draft)
  const wrongLabel = structuredClone(next)
  wrongLabel.draft.text = wrongLabel.draft.text.replace(
    '@src/features/really-long-folder/long-file.ts',
    '@long-file.ts'
  )
  expect(() => assertQueueEnvelope(wrongLabel, scope)).toThrow(/Mention position/)
  test.info().annotations.push({
    type: 'actual-composer-fixture',
    description: JSON.stringify({ authored, serialized, recovered: draft })
  })
})

test('aggregate JSON bytes reject repeated strings before full hashing or snapshot serialization', () => {
  const value = { items: Array(32).fill('x'.repeat(128)) }
  expect(() => assertQueueJsonValue(value, 1024)).toThrow(/JSON UTF-8 byte budget/)
})

test('held owned operations and queued draft bytes have independent bounded capacity and release after join', async () => {
  const created = await create()
  await created.owner.close()
  let reached!: () => void, release!: () => void
  const barrier = new Promise<void>((done) => {
      reached = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  const store = new NextTurnQueueStore(fixture, {
    testHook: async (context) => {
      if (context.phase === 'after-ready-rename') {
        reached()
        await held
      }
    }
  })
  const operation = {
      kind: 'enqueue' as const,
      id: 'entry-two',
      envelope: envelope('queued draft'),
      at: 2
    },
    bytes = Buffer.byteLength(JSON.stringify(operation), 'utf8')
  const owner = new NextTurnQueueMutationService(
      store,
      { capture: async () => ({ scope, generation: 'one' }), assertCurrent: () => {} },
      200,
      { maxOwnedOperations: 128, maxPendingMutationBytes: bytes * 2 - 1 }
    ),
    cap = await owner.bind(scope.taskId)
  const first = owner.mutate(cap, 1, 'bounded-first', operation)
  await barrier
  expect(owner.diagnostics().pendingMutationBytes).toBe(bytes)
  const rejected = owner.mutate(cap, 2, 'bounded-second', { ...operation, id: 'entry-six' }).then(
    (result) => ({ result }),
    (error) => ({ error })
  )
  const observedBytes = owner.diagnostics().pendingMutationBytes
  release()
  await first
  expect(await rejected).toMatchObject({ error: { code: 'CAPACITY' } })
  expect(observedBytes).toBe(bytes)
  expect(owner.diagnostics().pendingMutationBytes).toBe(0)
  await owner.close()
  const originalRead = store.read.bind(store)
  let readReached!: () => void, readRelease!: () => void
  const readBarrier = new Promise<void>((done) => {
      readReached = done
    }),
    readHeld = new Promise<void>((done) => {
      readRelease = done
    })
  store.read = async (target) => {
    const result = await originalRead(target)
    readReached()
    await readHeld
    return result
  }
  const limited = new NextTurnQueueMutationService(
      store,
      { capture: async () => ({ scope, generation: 'two' }), assertCurrent: () => {} },
      200,
      { maxOwnedOperations: 1, maxPendingMutationBytes: 4096 }
    ),
    readCap = await limited.bind(scope.taskId)
  const reading = limited.read(readCap)
  await readBarrier
  await expect(limited.findReceipt(readCap, 'bounded-first')).rejects.toMatchObject({
    code: 'CAPACITY'
  })
  readRelease()
  await reading
  await limited.close()
  expect(limited.diagnostics()).toEqual({
    bindings: 0,
    mutationBuckets: 0,
    ownedOperations: 0,
    pendingMutationBytes: 0,
    closing: true
  })
})
