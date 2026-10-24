/** Read-only, bounded evidence helpers. No network, credentials, prompts or tool bodies are retained. */
import { createHash } from 'node:crypto'
import { lstat, opendir, realpath, open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const text = value => typeof value === 'string' ? value.slice(0, 256) : null
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const array = value => Array.isArray(value) ? value : []
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'waiting'])
const runSummary = run => ({
  runId: text(run.runId), sessionId: text(run.sessionId), turnId: text(run.turnId),
  status: text(run.status), modelId: text(run.modelId), actualModelId: text(run.actualModelId),
  pendingCount: array(run.pending).filter(item => item.status === 'pending').length,
})

/** Accept response.data from /chat/snapshot. Tool IDs are scoped to a root run;
 * a matching durable history receipt is stronger evidence than a live frame. */
export function summarizeSnapshot(snapshot, { maxTools = 1024 } = {}) {
  if (!Number.isSafeInteger(maxTools) || maxTools < 1 || maxTools > 4096) throw new Error('Invalid evidence tool limit')
  const data = record(snapshot), projection = array(data.projection), history = array(data.history)
  const current = record(data.run ?? projection.find(frame => frame.run)?.run ?? array(data.runs).at(-1))
  const tools = new Map()
  let omittedTools = 0
  const apply = (value, source, isResult = false) => {
    const item = record(value), metadata = record(item.metadata)
    const id = text(item.toolCallId ?? item.id)
    if (!id) return
    const rootRunId = text(item.rootRunId ?? metadata.rootRunId)
    const key = JSON.stringify([rootRunId, id])
    if (!tools.has(key) && tools.size >= maxTools) { omittedTools++; return }
    const prior = tools.get(key) ?? { id, rootRunId, name: null, called: false, resultPresent: false,
      success: null, status: null, durationMs: null, errorCode: null, operationPerformed: null,
      outputTruncated: false, sources: [], durableReceipt: false }
    const status = item.status ?? metadata.status
    const success = item.success ?? metadata.success
    const operationPerformed = metadata.operationPerformed
    const name = text(item.toolName ?? item.name)
    const next = { ...prior, name: name ?? prior.name, sources: [...new Set([...prior.sources, source])] }
    // A streaming toolStart describes intent only, never successful execution.
    if (!isResult) next.called = true
    else {
      next.resultPresent = true
      if (source === 'history') next.durableReceipt = true
      if (typeof success === 'boolean') next.success = success
      if (terminal.has(status)) next.status = status
      next.durationMs = finite(item.durationMs ?? metadata.durationMs) ?? prior.durationMs
      next.errorCode = /^BROWSER_[A-Z_]+$/.test(metadata.code ?? '') ? metadata.code : prior.errorCode
      next.operationPerformed = typeof operationPerformed === 'boolean' || operationPerformed === 'unknown'
        ? operationPerformed : prior.operationPerformed
      next.outputTruncated = prior.outputTruncated || metadata.outputTruncated === true
    }
    tools.set(key, next)
  }
  for (const frame of projection) {
    for (const key of ['toolStart', 'toolCall']) if (frame[key]) apply(frame[key], 'projection')
    for (const key of ['toolEnd', 'toolResult']) if (frame[key]) apply(frame[key], 'projection', true)
  }
  for (const message of history) {
    if (message.toolCall) apply({ ...message.toolCall, toolCallId: message.toolCall.id, metadata: message.metadata }, 'history')
    if (message.role === 'tool') apply(message, 'history', true)
  }
  const rows = [...tools.values()]
  const browser = rows.filter(item => item.name?.startsWith('browser_'))
  const successful = item => item.resultPresent && item.success === true && item.status === 'succeeded'
  const userMessages = history.filter(message => message.role === 'user').slice(-64).map(message => {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null)
    return { id: text(message.id), rootRunId: text(record(message.metadata).rootRunId),
      createdAt: finite(message.createdAt), contentBytes: Buffer.byteLength(content),
      contentSha256: createHash('sha256').update(content).digest('hex') }
  })
  return {
    schemaVersion: 1, sessionId: text(data.sessionId), source: text(data.source),
    streamId: text(data.streamId), eventId: text(data.eventId), finished: data.finished === true,
    projectionTruncated: data.projectionTruncated === true, historyCompacted: data.historyCompacted === true,
    publicationRecoveryReason: text(record(data.publicationRecovery).reason),
    historyMessages: history.length, projectionFrames: projection.length, run: runSummary(current), userMessages,
    runs: array(data.runs).slice(-64).map(runSummary), tools: rows, omittedTools,
    browser: { attempted: browser.length, succeeded: browser.filter(successful).length,
      durableSucceeded: browser.filter(item => successful(item) && item.durableReceipt).length,
      failed: browser.filter(item => item.success === false).length,
      names: [...new Set(browser.map(item => item.name))], tools: browser },
  }
}

const within = (root, target) => {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}
const sensitive = name => /^(\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(name)
const excluded = new Set(['.git', 'node_modules', '.cache'])

/** Hash only an explicit generated workspace. No link traversal; finite work and
 * byte budgets make an incomplete scan explicit instead of freezing the runner. */
export async function manifestWorkspace(workspace, { maxEntries = 2000, maxFileBytes = 4 * 1024 * 1024,
  maxTotalBytes = 64 * 1024 * 1024, maxDurationMs = 10_000 } = {}) {
  for (const value of [maxEntries, maxFileBytes, maxTotalBytes, maxDurationMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid workspace manifest budget')
  }
  const requested = resolve(workspace)
  if ((await lstat(requested)).isSymbolicLink()) throw new Error('Workspace manifest refuses a symbolic root')
  const root = await realpath(requested), started = performance.now(), files = [], omitted = []
  let entries = 0, bytesHashed = 0, partial = false
  const budget = () => entries >= maxEntries || bytesHashed >= maxTotalBytes || performance.now() - started >= maxDurationMs
  const omit = (path, reason, incomplete = true) => { partial ||= incomplete; if (omitted.length < 64) omitted.push({ path, reason }) }
  const walk = async (directory, depth) => {
    if (depth > 24) { omit(relative(root, directory), 'depth-limit'); return }
    for await (const entry of await opendir(directory)) {
      const full = join(directory, entry.name), path = relative(root, full).split(sep).join('/')
      if (budget()) { omit(path, 'scan-budget'); break }
      entries++
      // Project-local engine state is intentionally outside the game artifact
      // contract; active task logs must not turn a stable game into a mutation.
      if (entry.name.toLowerCase() === '.ae') { omit(path, 'engine-runtime-data', false); continue }
      if (excluded.has(entry.name.toLowerCase()) || sensitive(entry.name)) { omit(path, 'excluded'); continue }
      try {
        const info = await lstat(full)
        if (info.isSymbolicLink()) { omit(path, 'symbolic-link'); continue }
        if (!within(root, await realpath(full))) { omit(path, 'outside-workspace'); continue }
        if (info.isDirectory()) { await walk(full, depth + 1); continue }
        if (!info.isFile()) { omit(path, 'special-file'); continue }
        if (info.size > maxFileBytes || bytesHashed + info.size > maxTotalBytes) { omit(path, 'byte-budget'); continue }
        const handle = await open(full, 'r')
        try {
          const before = await handle.stat(), hash = createHash('sha256')
          let size = 0, complete = true
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length; bytesHashed += chunk.length
            if (size > maxFileBytes || bytesHashed > maxTotalBytes || performance.now() - started >= maxDurationMs) {
              complete = false; omit(path, 'read-budget'); break
            }
            hash.update(chunk)
          }
          const after = await handle.stat()
          if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { omit(path, 'changed-during-read'); continue }
          if (!complete) continue
          files.push({ path, bytes: size, sha256: hash.digest('hex') })
        } finally { await handle.close() }
      } catch (error) { omit(path, `unreadable:${error?.code ?? 'ERROR'}`) }
    }
  }
  await walk(root, 0)
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { schemaVersion: 1, root, files, partial, omitted, entries, bytesHashed,
    durationMs: performance.now() - started,
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}
