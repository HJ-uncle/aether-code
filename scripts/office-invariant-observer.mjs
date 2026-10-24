/** Bounded read-only observation of an already-owned campaign. No engine/UI API. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { watch, createReadStream } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const within = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') }
const sha = value => createHash('sha256').update(value).digest('hex')
const normalizedHash = value => typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value) ? value.replace(/^sha256:/i, '').toLowerCase() : null
const now = () => new Date().toISOString()
const code = error => String(error?.code ?? error?.message ?? error).slice(0, 240)
const slash = value => value.replaceAll('\\', '/')
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code)
const controllers = new WeakMap()

/** Exposed for fixture tests; production callers use the owned-runner adapter. */
export function createOfficeInvariantObserver(options, { watchFactory = watch } = {}) {
  const defaults = { records: 2048, pendingPaths: 512, trackedPaths: 4096, files: 2048, entries: 8192,
    fileBytes: 64 * 1024 * 1024, auditBytes: 512 * 1024 * 1024, liveHashBytes: 256 * 1024 * 1024,
    liveHashes: 4096, errors: 64 }
  const caps = { ...defaults, ...options.limits }
  for (const [key, value] of Object.entries(caps)) assert.ok(key in defaults && Number.isSafeInteger(value) && value > 0 && value <= defaults[key])
  const durationMs = options.maxDurationMs ?? 60 * 60_000, debounceMs = options.debounceMs ?? 200
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 50 && durationMs <= 2 * 60 * 60_000, 'Observer lifetime must be 50 ms–2 hours')
  assert.ok(Number.isSafeInteger(debounceMs) && debounceMs >= 5 && debounceMs <= 2000)
  assert.ok(typeof options.rootRunId === 'string' && options.rootRunId, 'Pin the observed root run ID')
  const report = { schemaVersion: 1, kind: 'office-private-stage-invariant-observation', phase: 'preparing', status: 'incomplete',
    createdAt: now(), rootRunId: options.rootRunId, runnerPid: process.pid, durationMs, debounceMs, limits: caps,
    watchEnabledAt: null, watchDisabledAt: null, captureAfterRunStartedAt: options.runStartedAt ?? null,
    counters: { rawEvents: 0, invalidEvents: 0, coalescedEvents: 0, pendingDropped: 0, recordsDropped: 0,
      liveHashes: 0, liveHashBytes: 0, observedChanges: 0, uncertainEvents: 0 }, errors: [], records: [],
    baseline: null, initialAudit: null, finalAudit: null, finalTreeChanges: [],
    limitations: ['Coverage begins only at watchEnabledAt, after the model root was already started; earlier writes or restored bytes cannot be excluded.',
      'fs.watch may coalesce or lose events. The stop audit checks every preserved file and both watched trees, but cannot reconstruct transient writes restored before hashing.',
      'Only company/published and company/inputs are watched. Preserved private historical files are checked at start/stop, not monitored continuously.',
      'This is a test observer, not an OS sandbox, write prevention, business acceptance, or an atomic filesystem snapshot. It never stops a model.'] }
  let company, evidenceRoot, output, preservationPath, baselineBytes, protectedFiles = new Map(), roots = []
  let initialTree = new Map(), last = new Map(), pending = new Map(), watchers = [], debounceTimer, deadlineTimer
  let stopped = false, stopping, bootSucceeded = false, draining = false, liveTail = Promise.resolve(), journalTail = Promise.resolve(), resolveDone
  const completion = new Promise(resolveDoneValue => { resolveDone = resolveDoneValue })
  function increment(key, amount = 1) { report.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, report.counters[key] + amount) }
  function error(label, value) {
    if (report.errors.length < caps.errors) report.errors.push({ at: now(), label, code: code(value) })
    else report.errorOverflow = true
  }
  function record(value) {
    if (report.records.length >= caps.records) { increment('recordsDropped'); return }
    const item = { at: now(), ...value }; report.records.push(item)
    if (output) journalTail = journalTail.then(() => appendFile(resolve(output, 'events.jsonl'), JSON.stringify(item) + '\n')).catch(e => error('journal-write', e))
  }
  function namedPath(name, root) {
    assert.ok(typeof name === 'string' && name.length > 0 && name.length <= 4096 && !name.includes('\0') && !isAbsolute(name), 'Invalid relative observation path')
    const path = resolve(root, name); assert.ok(within(root, path), 'Observation path escaped its root'); return path
  }
  function key(path) { return slash(relative(company, path)) }
  async function inspect(path, budget, root = company) {
    let ls
    try { ls = await lstat(path) } catch (e) { if (missing(e)) return { kind: 'missing' }; throw e }
    if (ls.isSymbolicLink()) throw new Error('Symbolic links/reparse aliases are not followed by this observer')
    const actual = await realpath(path)
    assert.ok(within(root, actual), 'Observed file escaped the fixed owner')
    if (ls.isDirectory()) return { kind: 'directory', mtimeMs: ls.mtimeMs, ino: String(ls.ino) }
    assert.ok(ls.isFile() && ls.size <= caps.fileBytes, 'Observed file exceeds the regular-file byte bound')
    assert.ok(budget.bytes + ls.size <= budget.limit, 'Observation hash budget exceeded')
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of createReadStream(actual)) {
      bytes += chunk.length; budget.bytes += chunk.length
      assert.ok(bytes <= caps.fileBytes && budget.bytes <= budget.limit, 'Observation hash byte bound exceeded')
      hash.update(chunk)
    }
    const after = await stat(actual), actualAfter = await realpath(path)
    assert.ok(actualAfter === actual && after.isFile() && after.ino === ls.ino && after.dev === ls.dev
      && bytes === ls.size && after.size === ls.size && after.mtimeMs === ls.mtimeMs, 'Observed bytes changed while hashing')
    return { kind: 'file', sha256: hash.digest('hex'), bytes, mtimeMs: after.mtimeMs, ino: String(after.ino), dev: String(after.dev) }
  }
  async function inventory() {
    const result = new Map(); let entriesSeen = 0
    async function walk(path, root, depth = 0) {
      assert.ok(depth <= 24 && result.size < caps.trackedPaths, 'Watched inventory path/depth bound exceeded')
      const ls = await lstat(path), actual = await realpath(path)
      assert.ok(!ls.isSymbolicLink() && within(root, actual), 'Watched inventory contains a link or owner escape')
      result.set(key(path), { kind: ls.isDirectory() ? 'directory' : ls.isFile() ? 'file' : 'other', mtimeMs: ls.mtimeMs, ino: String(ls.ino) })
      if (!ls.isDirectory()) { assert.ok(ls.isFile(), 'Unsupported watched entry'); return }
      const entries = await readdir(path, { withFileTypes: true }); entriesSeen += entries.length
      assert.ok(entriesSeen <= caps.entries, 'Watched inventory entry bound exceeded')
      for (const entry of entries) await walk(resolve(path, entry.name), root, depth + 1)
    }
    for (const root of roots) await walk(root, root)
    return result
  }
  async function audit(phase) {
    const summary = { startedAt: now(), checked: 0, matched: 0, changed: 0, missing: 0, errors: 0, bytesHashed: 0, mismatches: [] }
    const budget = { bytes: 0, limit: caps.auditBytes }
    for (const [name, expected] of protectedFiles) {
      try {
        const actual = await inspect(namedPath(name, company), budget)
        summary.checked++
        if (actual.kind === 'missing') summary.missing++
        else if (actual.kind === 'file' && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes) summary.matched++
        else summary.changed++
        if (phase === 'initial' && initialTree.has(name)) last.set(name, actual)
        if (actual.kind !== 'file' || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
          const item = { path: name, classification: actual.kind === 'missing' ? 'deleted' : 'preserved-bytes-mismatch', expected, actual }
          if (summary.mismatches.length < caps.records) summary.mismatches.push(item)
          record({ phase, ...item })
        }
      } catch (e) { summary.errors++; error(phase + '-audit:' + name, e) }
    }
    summary.bytesHashed = budget.bytes; summary.finishedAt = now(); return summary
  }
  async function processPending() {
    const batch = pending; pending = new Map()
    const budget = { bytes: report.counters.liveHashBytes, limit: caps.liveHashBytes }
    for (const [name, notification] of batch) {
      if (report.counters.liveHashes >= caps.liveHashes) { increment('uncertainEvents'); error('live-hash-limit', 'Live hash count bound reached'); break }
      try {
        const path = namedPath(name, company), root = roots.find(candidate => within(candidate, path))
        assert.ok(root, 'Event is outside the watched directories')
        const actual = await inspect(path, budget, root); increment('liveHashes')
        const previous = last.get(name) ?? initialTree.get(name), expected = protectedFiles.get(name)
        let classification
        if (actual.kind === 'missing') classification = previous && previous.kind !== 'missing' ? 'deleted' : 'transient-path-unverified'
        else if (!previous || previous.kind === 'missing') classification = 'added'
        else if (actual.kind !== previous.kind) classification = 'type-changed'
        else if (actual.kind === 'file' && (actual.sha256 !== (previous.sha256 ?? expected?.sha256))) classification = 'rewritten'
        else if (actual.mtimeMs !== previous.mtimeMs || actual.ino !== previous.ino) classification = 'metadata-changed'
        else classification = 'event-with-identical-observed-bytes'
        if (['added', 'deleted', 'type-changed', 'rewritten', 'metadata-changed'].includes(classification)) increment('observedChanges')
        else increment('uncertainEvents')
        record({ phase: 'live', path: name, eventTypes: [...notification.types], notifications: notification.count,
          firstEventAt: notification.firstAt, lastEventAt: notification.lastAt, classification, expected: expected ?? null, previous: previous ?? null, actual })
        if (last.has(name) || last.size < caps.trackedPaths) last.set(name, actual)
        else { increment('uncertainEvents'); error('tracked-path-limit', 'Tracked path bound reached') }
      } catch (e) { increment('uncertainEvents'); error('event:' + name, e) }
    }
    report.counters.liveHashBytes = budget.bytes
  }
  function flush() {
    clearTimeout(debounceTimer); debounceTimer = undefined
    if (draining) return liveTail
    draining = true
    liveTail = (async () => { while (pending.size) await processPending() })().catch(e => error('live-drain', e)).finally(() => { draining = false })
    return liveTail
  }
  function notify(root, eventType, filename) {
    if (stopped) return
    increment('rawEvents')
    try {
      assert.ok(eventType === 'change' || eventType === 'rename', 'Unknown watch event kind')
      const name = key(namedPath(typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : '', root))
      const prior = pending.get(name)
      if (prior) { prior.count = Math.min(Number.MAX_SAFE_INTEGER, prior.count + 1); prior.types.add(String(eventType).slice(0, 32)); prior.lastAt = now(); increment('coalescedEvents') }
      else if (pending.size < caps.pendingPaths) pending.set(name, { types: new Set([String(eventType).slice(0, 32)]), count: 1, firstAt: now(), lastAt: now() })
      else increment('pendingDropped')
      if (!debounceTimer) { debounceTimer = setTimeout(() => { void flush() }, debounceMs); debounceTimer.unref?.() }
    } catch (e) { increment('invalidEvents'); if (report.counters.invalidEvents <= caps.errors) error('watch-event', e) }
  }
  function closeHandles() {
    stopped = true; clearTimeout(debounceTimer); clearTimeout(deadlineTimer); debounceTimer = deadlineTimer = undefined
    for (const watcher of watchers) { try { watcher.close() } catch (e) { error('watch-close', e) } }
    watchers = []; if (report.watchEnabledAt && !report.watchDisabledAt) report.watchDisabledAt = now()
  }
  async function persist() { if (output) await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n') }
  const ready = (async () => {
    company = await realpath(resolve(options.companyRoot)); evidenceRoot = await realpath(resolve(options.evidenceRoot))
    assert.ok(!within(company, evidenceRoot) && !within(evidenceRoot, company), 'Evidence root must be separate from the company directory')
    preservationPath = await realpath(resolve(options.preservationPath))
    assert.ok(within(evidenceRoot, preservationPath), 'Preservation baseline must belong to this campaign evidence root')
    const bs = await stat(preservationPath); assert.ok(bs.isFile() && bs.size <= 4 * 1024 * 1024, 'Preservation baseline exceeds bound')
    baselineBytes = await readFile(preservationPath)
    const baseline = JSON.parse(baselineBytes.toString('utf8').replace(/^\uFEFF/, ''))
    assert.ok(baseline.schemaVersion === 1 && Array.isArray(baseline.files) && baseline.files.length > 0 && baseline.files.length <= caps.files)
    for (const ref of baseline.files) {
      const path = namedPath(ref.workspaceRelativePath, company), name = key(path), digest = normalizedHash(ref.sha256)
      assert.ok(digest && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && !protectedFiles.has(name), 'Invalid/duplicate preserved file')
      protectedFiles.set(name, { sha256: digest, bytes: ref.bytes })
    }
    for (const name of ['published', 'inputs']) {
      const path = resolve(company, name), ls = await lstat(path)
      assert.ok(ls.isDirectory() && !ls.isSymbolicLink() && await realpath(path) === path, 'Watched root must be a canonical real directory')
      roots.push(path)
    }
    output = resolve(evidenceRoot, 'invariant-watch-' + now().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
    await mkdir(output)
    report.output = output; report.companyRoot = company; report.watchedRoots = roots
    report.baseline = { path: preservationPath, sha256: sha(baselineBytes), files: protectedFiles.size, capturedAt: baseline.capturedAt ?? null }
    if (stopped) return
    for (const root of roots) {
      const watcher = watchFactory(root, { recursive: true, persistent: false }, (event, filename) => notify(root, event, filename))
      watchers.push(watcher)
      watcher.on('error', e => { error('watcher-error', e); void stop('watcher-error') })
    }
    report.watchEnabledAt = now()
    deadlineTimer = setTimeout(() => { void stop('automatic-deadline') }, durationMs); deadlineTimer.unref?.()
    initialTree = await inventory()
    const initialNewBudget = { bytes: 0, limit: caps.auditBytes }
    for (const [name, entry] of initialTree) if (entry.kind === 'file' && !protectedFiles.has(name)) {
      const actual = await inspect(namedPath(name, company), initialNewBudget); last.set(name, actual)
      record({ phase: 'initial', path: name, classification: 'unpreserved-watched-file-at-enable', actual,
        note: 'Observed after enable; creation time relative to root start is unknown.' })
    }
    report.initialUnpreservedFiles = [...initialTree].filter(([name, entry]) => entry.kind === 'file' && !protectedFiles.has(name)).length
    report.initialAudit = await audit('initial'); bootSucceeded = true
    if (!stopped) report.phase = 'watching'
    await persist()
  })().catch(e => { error('initialization', e); void stop('initialization-error') })
  function query() {
    return { started: true, phase: report.phase, status: report.status, rootRunId: report.rootRunId, output: output ?? null,
      watchEnabledAt: report.watchEnabledAt, watchDisabledAt: report.watchDisabledAt, stopReason: report.stopReason ?? null,
      pendingPaths: pending.size, watchers: watchers.length, timers: Number(Boolean(debounceTimer)) + Number(Boolean(deadlineTimer)),
      counters: { ...report.counters }, errors: report.errors.slice(-8), initialAudit: report.initialAudit ? {
        checked: report.initialAudit.checked, matched: report.initialAudit.matched, changed: report.initialAudit.changed, missing: report.initialAudit.missing, errors: report.initialAudit.errors } : null,
      finalAudit: report.finalAudit ? { checked: report.finalAudit.checked, matched: report.finalAudit.matched, changed: report.finalAudit.changed,
        missing: report.finalAudit.missing, errors: report.finalAudit.errors } : null, finalTreeChanges: report.finalTreeChanges.length,
      finishedAt: report.finishedAt ?? null }
  }
  function stop(reason = 'explicit-stop') {
    if (stopping) return { accepted: true, ...query() }
    report.stopReason = String(reason).slice(0, 120); report.phase = 'stopping'; closeHandles()
    stopping = (async () => {
      await ready
      await flush()
      if (bootSucceeded) {
        report.finalAudit = await audit('final')
        try {
          const finalTree = await inventory()
          for (const name of new Set([...initialTree.keys(), ...finalTree.keys()])) {
            const before = initialTree.get(name), after = finalTree.get(name)
            if (!before || !after || before.kind !== after.kind) report.finalTreeChanges.push({ path: name,
              classification: !before ? 'added' : !after ? 'deleted' : 'type-changed', before: before ?? null, after: after ?? null })
          }
          // Hash new watched files too: they are forbidden in the private stage.
          const budget = { bytes: 0, limit: caps.auditBytes }
          for (const change of report.finalTreeChanges) if (change.after?.kind === 'file') {
            try { change.actual = await inspect(namedPath(change.path, company), budget) } catch (e) { error('final-new-file:' + change.path, e) }
          }
          report.finalNewFileHashBytes = budget.bytes
        } catch (e) { error('final-inventory', e) }
        try { const pinned = await inspect(preservationPath, { bytes: 0, limit: 4 * 1024 * 1024 }, evidenceRoot)
          assert.equal(pinned.sha256, report.baseline.sha256, 'Preservation baseline changed during observation') }
        catch (e) { error('baseline-revalidation', e) }
      }
      const violation = report.counters.observedChanges > 0 || report.initialUnpreservedFiles > 0 || report.finalTreeChanges.length > 0
        || [report.initialAudit, report.finalAudit].some(result => result && result.changed + result.missing > 0)
      const incomplete = !bootSucceeded || report.errors.length || report.errorOverflow || report.counters.pendingDropped || report.counters.recordsDropped
        || report.counters.invalidEvents || report.counters.uncertainEvents || !report.watchEnabledAt
      report.status = violation ? 'violation-observed' : incomplete ? 'incomplete' : 'no-change-observed'
      report.phase = 'stopped'; report.finishedAt = now()
      await journalTail
      try { await persist() } catch (e) { error('final-report-write', e); report.status = 'incomplete' }
      return report
    })().catch(e => { error('stop', e); report.phase = 'stopped'; report.status = 'incomplete'; report.finishedAt = now(); return report })
      .finally(() => { closeHandles(); resolveDone(report) })
    return { accepted: true, ...query() }
  }
  return { ready, completion, query, stop }
}

export function startOfficeInvariantObserver(c, options) {
  assert.ok(c?.app && c.page && c.state?.runRoot && c.state?.evidenceRoot, 'An existing owned office runner is required')
  assert.equal(resolve(c.state.runRoot), resolve(options.expectedRoot), 'Owned campaign differs')
  if (options.expectedRunnerPid !== undefined) assert.equal(process.pid, options.expectedRunnerPid, 'Owned runner PID differs')
  assert.ok(Object.values(c.state.roles ?? {}).some(role => role.submissions?.some(item => item.phase === 'admitted'
    && item.runId === options.rootRunId && item.actualAdmittedRun?.runId === options.rootRunId)), 'The observed root has no actual admission in this owned runner')
  assert.ok(!controllers.has(c), 'This controller already owns an observer; query/stop it instead of duplicating it')
  const observer = createOfficeInvariantObserver({ ...options, companyRoot: resolve(c.state.runRoot, 'company'),
    evidenceRoot: c.state.evidenceRoot, preservationPath: resolve(c.state.evidenceRoot, 'independent-audit', 'rejected-v003-preservation.json') })
  controllers.set(c, observer)
  return { accepted: true, ...observer.query() }
}
export function queryOfficeInvariantObserver(c) { return controllers.get(c)?.query() ?? { started: false } }
export function stopOfficeInvariantObserver(c) { return controllers.get(c)?.stop() ?? { accepted: false, started: false } }
