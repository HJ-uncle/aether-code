/** Bounded, incremental, read-only extraction of actual engine JSONL receipts.
 * Shell/skill/browser filesystem side effects deliberately remain unknown.
 * Tool arguments are data: this program never executes generated content.
 */
import assert from 'node:assert/strict'
import { open, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { resolve, isAbsolute, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (root, target) => { const r = relative(resolve(root), resolve(target)); return r === '' || !r.startsWith('..\\') && !r.startsWith('../') && r !== '..' && !isAbsolute(r) }
const digest = value => typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value) ? value.replace(/^sha256:/i, '').toLowerCase() : undefined
const has = (object, key) => Object.hasOwn(object ?? {}, key)
const defaults = { maxBytesPerSource: 4 * 1024 * 1024, maxBytesTotal: 24 * 1024 * 1024, maxLineBytes: 1024 * 1024, maxLinesPerSource: 10000, maxRecords: 6000, maxValueBytes: 64 * 1024 }

function bounded(value, cap) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const bytes = Buffer.byteLength(text)
  return bytes <= cap ? { value, bytes, sha256: sha(text), truncated: false }
    : { preview: Buffer.from(text).subarray(0, cap).toString('utf8'), bytes, sha256: sha(text), truncated: true }
}

/** Never derives paths by parsing arbitrary command text. Result metadata is
 * the authoritative path; argument paths are useful for failed attempts only.
 * Relative paths without a canonical receipt remain unknown: working directory
 * changes and multi-workspace resolution cannot be reconstructed from prompts.
 */
export function classifyOfficeCall(record) {
  const call = record.call, result = record.result
  if (!call || !result) return { status: 'unknown', reason: 'Unpaired tool call/result' }
  if (record.conflicts?.length) return { status: 'unknown', reason: 'Conflicting duplicate or identity evidence' }
  const args = call.args?.value ?? call.pathArgs ?? {}, meta = result.metadata ?? {}, name = call.name
  let operation
  if (name === 'read_file' || name === 'list_files') operation = 'read'
  else if (name === 'write_file') operation = meta.change?.isNew === true || meta.change?.oldHash === 'missing' ? 'create' : meta.change?.isNew === false ? 'update' : 'write'
  else if (name === 'edit_file') operation = 'update'
  else if (name === 'delete_file') operation = 'delete'
  else if (name === 'create_dir') operation = 'mkdir'
  else if (name === 'office_document') operation = ({ inspect: 'read', create: 'create', edit: 'update', append_sheets: 'update' })[args.operation]
  else if (name === 'plan_update' || name === 'plan_read') return { status: 'non-business-control', reason: 'Internal plan state; excluded from business file audit' }
  else return { status: 'unknown', reason: ['execute_cmd', 'run_skill_script'].includes(name) ? 'Arbitrary code side effects are unknown, including when a command failed' : 'Tool is outside the determinable built-in file/office allowlist' }
  if (!operation) return { status: 'unknown', reason: 'Unrecognized office operation' }
  const rawPath = meta.path ?? meta.change?.path ?? args.path
  if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) return { status: 'unknown', reason: 'No canonical absolute target in receipt or request' }
  if (meta.path && meta.change?.path && canonical(meta.path) !== canonical(meta.change.path)) return { status: 'unknown', reason: 'Receipt paths conflict' }
  if (meta.change?.sessionId && meta.change.sessionId !== record.sessionId || meta.change?.runId && meta.change.runId !== record.runId) return { status: 'unknown', reason: 'Change receipt identity conflicts with actor/run' }
  const outcome = meta.status === 'succeeded' && meta.success === true ? 'succeeded'
    : meta.status === 'denied' ? 'denied'
    : meta.success === false && ['failed', 'cancelled', 'interrupted'].includes(meta.status) ? 'failed' : undefined
  if (!outcome) return { status: 'unknown', reason: 'Result has no unambiguous terminal outcome' }
  const at = result.createdAt
  if (!Number.isFinite(at)) return { status: 'unknown', reason: 'Result timestamp missing' }
  const event = { roleId: record.roleId, sessionId: record.sessionId, runId: record.runId, toolCallId: record.toolCallId,
    toolName: name, operation, path: resolve(rawPath), outcome, at, source: result.source,
    pathAuthority: meta.path || meta.change?.path ? 'tool-receipt' : 'absolute-request',
    ...(typeof meta.fileMutationApplied === 'boolean' ? { mutated: meta.fileMutationApplied } : {}),
    ...(meta.noChange === true ? { mutated: false } : {}),
    ...(digest(meta.change?.oldHash ?? meta.oldHash) ? { beforeSha256: digest(meta.change?.oldHash ?? meta.oldHash) } : {}),
    ...(operation === 'read' && digest(meta.expectedHash) ? { readSha256: digest(meta.expectedHash) } : {}),
    ...(operation !== 'read' && digest(meta.change?.newHash ?? meta.newHash ?? meta.expectedHash) ? { afterSha256: digest(meta.change?.newHash ?? meta.newHash ?? meta.expectedHash) } : {}) }
  if (operation === 'read') event.mutated = false
  if (name === 'list_files') { event.listing = true; event.recursive = args.recursive === true }
  if (meta.change?.path && operation !== 'read') event.mutated ??= true
  return { status: 'attributed', event }
}

function receipt(row, source, locator, limits) {
  const payload = row.payload
  if (row.sessionId !== source.sessionId) return { issue: 'Mismatched session identity' }
  // Physical history controls compact the model view, but do not undo a
  // tool's already performed side effects. Original append rows stay evidence.
  if (['summary', 'update', 'tombstone', 'usage'].includes(row.type)) return {}
  if (!payload) return { issue: 'Unrecognized payload' }
  const call = payload.toolCall
  if (row.type !== 'tool' && !call) return {}
  if (call && payload.toolCallId && payload.toolCallId !== call.id) return { issue: 'Call identity differs between envelope and payload' }
  const toolCallId = call?.id ?? payload.toolCallId, runId = payload.metadata?.rootRunId
  if (!toolCallId || !runId) return { issue: 'Tool entry lacks toolCallId/rootRunId' }
  if (!source.runIds.includes(runId)) return { issue: 'Tool run was not registered in independent campaign state: ' + runId }
  const key = [source.roleId, row.sessionId, runId, toolCallId].join('|')
  const value = { roleId: source.roleId, sessionId: row.sessionId, runId, toolCallId }
  const location = { ...locator, uuid: row.uuid, dbSeq: row.dbSeq, timestamp: row.timestamp }
  if (call) value.call = { name: call.name, args: bounded(call.args, limits.maxValueBytes),
    pathArgs: { ...(has(call.args, 'path') ? { path: call.args.path } : {}), ...(has(call.args, 'operation') ? { operation: call.args.operation } : {}), ...(has(call.args, 'recursive') ? { recursive: call.args.recursive } : {}) },
    source: location, createdAt: payload.createdAt ?? Date.parse(row.timestamp), modelId: payload.modelId }
  else {
    const meta = payload.metadata ?? {}, change = meta.change
    // Old/new content may contain whole business documents. Keep original result
    // plus its hash/locator, and copy only mutation fields used for attribution.
    const metadata = Object.fromEntries(['status', 'success', 'error', 'code', 'path', 'expectedHash', 'oldHash', 'newHash', 'fileMutationApplied', 'noChange', 'outputTruncated', 'rootRunId', 'turnId', 'durationMs'].filter(k => has(meta, k)).map(k => [k, meta[k]]))
    if (change) metadata.change = Object.fromEntries(['id', 'sessionId', 'runId', 'path', 'kind', 'oldHash', 'newHash', 'isNew', 'toolCallId'].filter(k => has(change, k)).map(k => [k, change[k]]))
    value.result = { name: payload.toolName, content: bounded(payload.content, limits.maxValueBytes), metadata,
      source: location, createdAt: payload.createdAt ?? Date.parse(row.timestamp) }
  }
  return { key, value }
}

async function anchor(handle, offset) {
  const size = Math.min(offset, 256), bytes = Buffer.alloc(size)
  await handle.read(bytes, 0, size, offset - size)
  return sha(bytes)
}

/** A cursor always lands on an LF boundary. Partial final lines are reread at
 * most up to the line limit. Oversized lines are discarded incrementally and
 * permanently mark coverage incomplete; memory never scales with log size.
 */
export async function extractOfficeToolEvidence(config, prior = {}) {
  const limits = { ...defaults, ...config.limits }
  for (const [key, value] of Object.entries(limits)) assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 64 * 1024 * 1024, 'Invalid bounded limit: ' + key)
  assert.ok(Array.isArray(config.sources) && config.sources.length > 0 && config.sources.length <= 32)
  const state = structuredClone({ schemaVersion: 1, cursors: prior.cursors ?? {}, records: prior.records ?? {}, gaps: prior.gaps ?? [] })
  assert.ok(Object.keys(state.records).length <= limits.maxRecords, 'Prior evidence exceeds record limit')
  let recordCount = Object.keys(state.records).length
  const reports = []; let totalBytes = 0
  for (const source of config.sources) {
    assert.ok(source.roleId && source.sessionId && Array.isArray(source.runIds) && source.path)
    const path = resolve(source.path), identityKey = canonical(path)
    let handle
    const report = { roleId: source.roleId, path, bytesRead: 0, linesRead: 0 }
    try {
      handle = await open(path, 'r'); const file = await handle.stat()
      const identity = [file.dev, file.ino, file.birthtimeMs].join(':')
      let cursor = state.cursors[identityKey] ?? { offset: 0, line: 0, identity }
      if (cursor.identity !== identity || file.size < cursor.offset || cursor.anchor && cursor.anchor !== await anchor(handle, cursor.offset)) {
        state.gaps.push({ path, reason: 'Source rotated, truncated or changed at cursor; restarted bounded scan', at: new Date().toISOString() })
        cursor = { offset: 0, line: 0, identity }
      }
      const start = cursor.offset, budget = Math.min(limits.maxBytesPerSource, limits.maxBytesTotal - totalBytes, file.size - start)
      const bytes = Buffer.alloc(Math.max(0, budget)); const { bytesRead } = await handle.read(bytes, 0, bytes.length, start)
      totalBytes += bytesRead; report.bytesRead = bytesRead; report.observedSize = file.size; report.startOffset = start
      let position = 0
      while (position < bytesRead && report.linesRead < limits.maxLinesPerSource) {
        const lf = bytes.indexOf(10, position)
        if (lf < 0) {
          if (bytesRead - position > limits.maxLineBytes || cursor.discarding) {
            if (!cursor.discarding) state.gaps.push({ path, offset: start + position, reason: 'Oversized JSONL line skipped' })
            cursor.discarding = true; position = bytesRead
          }
          break
        }
        const end = lf + 1, length = end - position, locator = { path, offset: start + position, bytes: length, line: cursor.line + 1 }
        if (cursor.discarding || length > limits.maxLineBytes) {
          if (!cursor.discarding) state.gaps.push({ ...locator, reason: 'Oversized JSONL line skipped' })
          cursor.discarding = false
        } else {
          try {
            const row = JSON.parse(bytes.subarray(position, lf).toString('utf8')), parsed = receipt(row, source, locator, limits)
            if (parsed.issue) state.gaps.push({ ...locator, reason: parsed.issue })
            if (parsed.key) {
              const previous = state.records[parsed.key]
              if (!previous && recordCount >= limits.maxRecords) { report.recordLimitReached = true; break }
              if (!previous) recordCount++
              const current = previous ?? parsed.value
              for (const kind of ['call', 'result']) if (parsed.value[kind]) {
                if (previous?.[kind]) {
                  const old = previous[kind], fresh = parsed.value[kind]
                  const oldHash = kind === 'call' ? old.args.sha256 : old.content.sha256
                  const newHash = kind === 'call' ? fresh.args.sha256 : fresh.content.sha256
                  if (oldHash !== newHash || old.name !== fresh.name || kind === 'result' && JSON.stringify(old.metadata) !== JSON.stringify(fresh.metadata)) (current.conflicts ??= []).push({ kind, source: fresh.source, reason: 'Conflicting duplicate receipt' })
                } else current[kind] = parsed.value[kind]
              }
              if (current.call && current.result && current.call.name !== current.result.name) (current.conflicts ??= []).push({ reason: 'Call/result tool names differ' })
              state.records[parsed.key] = current
            }
          } catch (error) { state.gaps.push({ ...locator, reason: 'Invalid JSONL: ' + error.message }) }
        }
        position = end; cursor.line++; report.linesRead++
      }
      cursor.offset = start + position; cursor.anchor = await anchor(handle, cursor.offset)
      state.cursors[identityKey] = cursor
      report.endOffset = cursor.offset; report.caughtUp = cursor.offset === file.size && !cursor.discarding
    } catch (error) { report.error = error.message }
    finally { await handle?.close() }
    reports.push(report)
  }
  const records = Object.values(state.records), events = [], unknown = []
  for (const record of records) {
    const classification = classifyOfficeCall(record)
    if (classification.status === 'attributed') events.push(classification.event)
    else if (classification.status === 'unknown') unknown.push({ roleId: record.roleId, sessionId: record.sessionId, runId: record.runId, toolCallId: record.toolCallId, name: record.call?.name ?? record.result?.name, reason: classification.reason })
  }
  const logComplete = reports.every(item => item.caughtUp) && state.gaps.length === 0
  const report = { schemaVersion: 1, source: 'independent-bounded-engine-jsonl-extractor', generatedAt: new Date().toISOString(),
    complete: false, coverageScope: 'Logged built-in file/office target operations only; does not certify internal staging, indirect asset reads, arbitrary code or process side effects',
    logCoverage: { complete: logComplete, sources: reports, gaps: state.gaps, totalBytesRead: totalBytes },
    limits, events, unknown, records, summary: { records: records.length, attributedEvents: events.length, unknown: unknown.length,
      pending: records.filter(r => !r.call || !r.result).length, successfulMutations: events.filter(e => e.operation !== 'read' && e.outcome === 'succeeded' && e.mutated !== false).length },
    limitations: ['No shell text is interpreted as filesystem evidence.', 'Recorded result content may already be truncated by the engine; outputTruncated is preserved.',
      'Large argument/result values retain bounded previews, full-value hashes and exact source byte locators.', 'JSONL is engine evidence, not an OS filesystem monitor; final file checks remain separate.'] }
  return { state, report }
}

async function readBoundedJson(path, cap = 64 * 1024 * 1024) {
  assert.ok((await stat(path)).size <= cap, 'JSON input exceeds limit')
  return JSON.parse(await readFile(path, 'utf8'))
}
async function cli() {
  const options = {}, args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) { assert.ok(args[i].startsWith('--') && args[i + 1]); options[args[i].slice(2)] = args[i + 1] }
  assert.ok(options.config && options.output && options.cursor, 'Use --config input.json --output evidence.json --cursor collector-state.json')
  const config = await readBoundedJson(resolve(options.config))
  let prior = {}; try { prior = await readBoundedJson(resolve(options.cursor)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const paths = [resolve(options.output), resolve(options.cursor)]
  for (const path of paths) {
    assert.ok(!(config.protectedRoots ?? []).some(root => inside(root, path)), 'Evidence output must be outside business roots')
    assert.ok(!config.sources.some(source => canonical(source.path) === canonical(path)), 'Cannot overwrite source logs')
  }
  assert.notEqual(canonical(paths[0]), canonical(paths[1]), 'Output and cursor must be distinct')
  const { state, report } = await extractOfficeToolEvidence(config, prior)
  for (const [index, value] of [report, state].entries()) {
    const text = JSON.stringify(value, null, 2); assert.ok(Buffer.byteLength(text) <= 64 * 1024 * 1024, 'Evidence state reached its bounded storage limit')
    await mkdir(dirname(paths[index]), { recursive: true }); await writeFile(paths[index], text)
  }
  console.log(JSON.stringify({ output: paths[0], ...report.summary, logCoverageComplete: report.logCoverage.complete, bytesRead: report.logCoverage.totalBytesRead, complete: report.complete }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(error); process.exitCode = 1 })
