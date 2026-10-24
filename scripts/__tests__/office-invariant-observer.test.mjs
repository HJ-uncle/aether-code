/** Fixture-only observer tests; never connects to a real runner or company. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createOfficeInvariantObserver, startOfficeInvariantObserver, queryOfficeInvariantObserver } from '../office-invariant-observer.mjs'

const fixtures = resolve('.e2e-tmp'), digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function poll(check) {
  const end = Date.now() + 3000
  while (!check()) { if (Date.now() > end) assert.fail('Fixture observation did not settle'); await delay(10) }
}
async function fixture(run, { realWatch = false, extra = {}, factory } = {}) {
  await mkdir(fixtures, { recursive: true }); const base = await mkdtemp(resolve(fixtures, 'invariant-observer-'))
  const company = resolve(base, 'company'), evidence = resolve(base, 'evidence'), callbacks = new Map(), handles = []
  await mkdir(resolve(company, 'published'), { recursive: true }); await mkdir(resolve(company, 'inputs'))
  await mkdir(resolve(company, 'pmo', 'private'), { recursive: true }); await mkdir(evidence)
  const contents = { 'published/old.json': '{"old":true}\n', 'inputs/input.csv': 'a,b\n1,2\n', 'pmo/private/old.txt': 'old private bytes' }
  for (const [name, bytes] of Object.entries(contents)) await writeFile(resolve(company, name), bytes)
  const baselinePath = resolve(evidence, 'preserved.json')
  await writeFile(baselinePath, JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), files: Object.entries(contents).map(([workspaceRelativePath, bytes]) => ({
    workspaceRelativePath, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) })) }))
  const fakeWatch = (path, options, callback) => {
    assert.equal(options.recursive, true); assert.equal(options.persistent, false)
    const handle = new EventEmitter(); handle.closed = false; handle.close = () => { handle.closed = true }
    callbacks.set(path, callback); handles.push(handle); return handle
  }
  const observer = createOfficeInvariantObserver({ companyRoot: company, evidenceRoot: evidence, preservationPath: baselinePath,
    rootRunId: 'fixture-root', runStartedAt: '2020-01-01T00:00:00.000Z', debounceMs: 10, maxDurationMs: 10000, ...extra },
  realWatch ? undefined : { watchFactory: factory ?? fakeWatch })
  const emit = (prefix, event, name) => callbacks.get(resolve(company, prefix))(event, name)
  try { await observer.ready; await run({ base, company, evidence, baselinePath, observer, emit, handles, callbacks }) }
  finally {
    observer.stop(); await observer.completion
    const actual = await realpath(base), parent = await realpath(fixtures), rel = relative(parent, actual)
    assert.ok(!isAbsolute(rel) && !rel.startsWith('..') && /^invariant-observer-[^\\/]+$/.test(rel))
    await rm(actual, { recursive: true, force: true })
  }
}

test('starts only two watches and checks every preserved byte at stop', () => fixture(async f => {
  assert.equal(f.observer.query().phase, 'watching'); assert.equal(f.callbacks.size, 2)
  assert.equal(f.observer.query().initialAudit.matched, 3)
  const ack = f.observer.stop(); assert.equal(ack.phase, 'stopping'); assert.equal(ack.watchers, 0)
  const result = await f.observer.completion
  assert.equal(result.status, 'no-change-observed'); assert.equal(result.finalAudit.matched, 3)
  assert.ok(result.watchEnabledAt > result.captureAfterRunStartedAt)
  assert.ok(f.handles.every(handle => handle.closed)); assert.equal(f.observer.query().timers, 0)
  const saved = JSON.parse(await readFile(resolve(result.output, 'result.json'), 'utf8'))
  assert.equal(saved.status, result.status); assert.equal(saved.baseline.files, 3)
}))
test('event rewrite records actual SHA, timestamp and unchanged baseline identity', () => fixture(async f => {
  await writeFile(resolve(f.company, 'published/old.json'), 'changed')
  f.emit('published', 'change', 'old.json')
  await poll(() => f.observer.query().counters.liveHashes > 0)
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.status, 'violation-observed'); assert.equal(result.finalAudit.changed, 1)
  const changed = result.records.find(item => item.phase === 'live' && item.path === 'published/old.json')
  assert.equal(changed.classification, 'rewritten'); assert.equal(changed.actual.sha256, digest('changed'))
  assert.ok(Number.isFinite(changed.actual.mtimeMs)); assert.notEqual(changed.expected.sha256, changed.actual.sha256)
}))
test('new published files are forbidden while private staging is permitted', () => fixture(async f => {
  await writeFile(resolve(f.company, 'pmo/private/new-staging.txt'), 'allowed')
  await writeFile(resolve(f.company, 'published/new.json'), '{}')
  f.emit('published', 'rename', 'new.json')
  await poll(() => f.observer.query().counters.liveHashes > 0)
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.status, 'violation-observed')
  assert.equal(result.records.find(item => item.path === 'published/new.json').classification, 'added')
  assert.equal(result.finalTreeChanges.find(item => item.path === 'published/new.json').actual.sha256, digest('{}'))
  assert.equal(result.records.some(item => item.path?.includes('new-staging')), false)
}))
test('input deletions are recorded without writing a replacement', () => fixture(async f => {
  await unlink(resolve(f.company, 'inputs/input.csv')); f.emit('inputs', 'rename', 'input.csv')
  await poll(() => f.observer.query().counters.liveHashes > 0)
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.finalAudit.missing, 1); assert.equal(result.status, 'violation-observed')
  assert.equal(result.records.find(item => item.phase === 'live').classification, 'deleted')
}))
test('stop audit catches lost watch events including protected private history', () => fixture(async f => {
  await writeFile(resolve(f.company, 'pmo/private/old.txt'), 'silent corruption')
  await writeFile(resolve(f.company, 'published/unseen.json'), 'no notification')
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.counters.rawEvents, 0); assert.equal(result.finalAudit.changed, 1)
  assert.equal(result.finalTreeChanges.some(item => item.path === 'published/unseen.json'), true)
  assert.equal(result.status, 'violation-observed')
}))
test('coalesces bursts and bounds pending paths/details without claiming complete coverage', () => fixture(async f => {
  for (let i = 0; i < 1000; i++) f.emit('published', 'change', 'old.json')
  f.emit('published', 'change', 'not-admitted-1'); f.emit('published', 'change', 'not-admitted-2')
  assert.equal(f.observer.query().pendingPaths, 1)
  await poll(() => f.observer.query().counters.liveHashes > 0)
  f.emit('published', 'change', 'old.json'); await poll(() => f.observer.query().counters.liveHashes > 1)
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.records.length, 1); assert.ok(result.counters.recordsDropped > 0)
  assert.equal(result.counters.pendingDropped, 2); assert.equal(result.counters.coalescedEvents, 999)
  assert.equal(result.status, 'incomplete')
}, { extra: { limits: { pendingPaths: 1, records: 1 } } }))
test('null and escaping filenames cannot cause arbitrary reads or full rescans', () => fixture(async f => {
  f.emit('published', 'change', null); f.emit('published', 'rename', '../pmo/private/old.txt')
  await delay(30); assert.equal(f.observer.query().counters.liveHashes, 0)
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.status, 'incomplete'); assert.equal(result.counters.invalidEvents, 2)
}))
test('watcher errors release both handles and finalize a truthful incomplete result', () => fixture(async f => {
  f.handles[0].emit('error', new Error('fixture watch overflow'))
  const result = await f.observer.completion
  assert.equal(result.status, 'incomplete'); assert.equal(result.stopReason, 'watcher-error')
  assert.equal(f.observer.query().watchers, 0); assert.equal(f.observer.query().timers, 0)
}))
test('automatic lifetime closes handles without blocking the controller', () => fixture(async f => {
  await delay(120)
  const result = await f.observer.completion
  assert.equal(result.stopReason, 'automatic-deadline'); assert.equal(result.phase, 'stopped')
  assert.equal(f.observer.query().watchers, 0); assert.equal(f.observer.query().timers, 0)
}, { extra: { maxDurationMs: 80 } }))
test('baseline rewrites are detected at stop', () => fixture(async f => {
  await writeFile(f.baselinePath, '{"replaced":true}')
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.status, 'incomplete'); assert.ok(result.errors.some(item => item.label === 'baseline-revalidation'))
}))
test('watch setup failure never leaves a live partial watcher', () => fixture(async f => {
  assert.equal((await f.observer.completion).status, 'incomplete')
  assert.equal(f.observer.query().watchers, 0); assert.equal(f.observer.query().timers, 0)
}, { factory: () => { throw new Error('fixture recursive watch unavailable') } }))
test('actual recursive fs.watch on temporary fixture detects a changed file', () => fixture(async f => {
  assert.equal(f.observer.query().phase, 'watching')
  await writeFile(resolve(f.company, 'published/old.json'), 'real watch mutation')
  await poll(() => f.observer.query().counters.rawEvents > 0 && f.observer.query().counters.liveHashes > 0)
  f.observer.stop(); const result = await f.observer.completion
  assert.equal(result.status, 'violation-observed'); assert.equal(result.finalAudit.changed, 1)
}, { realWatch: true }))
test('owned-runner adapter refuses missing admission or wrong root without starting', () => {
  const c = { app: {}, page: {}, state: { runRoot: fixtures, evidenceRoot: fixtures, roles: {} } }
  assert.throws(() => startOfficeInvariantObserver(c, { expectedRoot: fixtures, rootRunId: 'unadmitted' }), /actual admission/)
  assert.throws(() => startOfficeInvariantObserver(c, { expectedRoot: resolve(fixtures, 'other'), rootRunId: 'x' }), /differs/)
  assert.deepEqual(queryOfficeInvariantObserver(c), { started: false })
})
