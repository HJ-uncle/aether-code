/** Harness regressions only. Test doubles below are never real-model evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { consumeSse, createClient, scrub, endpointSummary, settledBatch } from './work-soak-transport.mjs'
import { main, parseOptions, makePlan, cleanupOwned, execute, unverifiedCronRuns, monitorWork, settleStressBatch, drainFailedSession } from './work-soak-runner.mjs'
import { prepareWorkload, reference, runNode, verifyWorkload, verifySharedPipeline } from './work-soak-workloads.mjs'
import { startProcessMonitor, validateProcessSample } from './work-soak-process.mjs'
import { chatWithDeniedPermissions } from './work-soak-recovery.mjs'

const fixtureRoot = path.resolve('.e2e-tmp', 'soak-harness')
fs.mkdirSync(fixtureRoot, { recursive: true })
function temp(t) {
  const root = fs.mkdtempSync(path.join(fixtureRoot, 'case-'))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${fixtureRoot}${path.sep}`))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}
const terminal = { runId: 'root-1', turnId: 'turn-1', status: 'succeeded', modelId: 'qwen3.8-flash', actualModelId: 'qwen3.8-flash' }
function body(text, chunkSize = 3) {
  const bytes = Buffer.from(text)
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize)); controller.close() } })
}

test('help is offline, import-safe and does not read token files', async () => {
  const original = globalThis.fetch
  const log = console.log
  let message = ''
  globalThis.fetch = () => { throw new Error('network forbidden') }
  console.log = value => { message += value }
  try { await main(['--help'], { AETHER_SOAK_TOKEN_FILE: 'Z:/missing-secret' }) } finally { globalThis.fetch = original; console.log = log }
  assert.match(message, /Default 1;/)
  assert.equal(parseOptions([], {}, fixtureRoot).durationHours, 1)
})

test('engine telemetry requires pinned process identity and preserves independent metrics', async t => {
  const root = temp(t)
  assert.throws(() => parseOptions(['--engine-pid', '42'], {}, root), /verified/)
  assert.throws(() => parseOptions(['--engine-pid', '42;exit', '--engine-start-ticks', '639273711688335120'], {}, root), /verified/)
  const identity = { pid: 42, creationTimeTicks: '639273711688335120' }
  let sampleCount = 0
  const monitor = await startProcessMonitor({ ...identity, runRoot: root, readSample: async () => ({ ...identity,
    workingSetBytes: ++sampleCount * 1024, privateMemoryBytes: 4096, cpuSeconds: sampleCount / 2, handleCount: 12 }) })
  const result = await monitor.stop()
  assert.equal(result.status, 'completed')
  assert.equal(result.samples, 2)
  assert.equal(result.peaks.workingSetBytes, 2048)
  assert.equal(result.cpuSecondsDelta, 0.5)
  assert.match(result.scope, /children and Electron excluded/)
  assert.equal(fs.existsSync(path.join(root, '.engine-monitor.lock')), false)
  await assert.rejects(startProcessMonitor({ ...identity, runRoot: root }), /preserve/)
})

test('engine telemetry refuses PID reuse without recording replacement process metrics', async t => {
  const root = temp(t)
  const identity = { pid: 42, creationTimeTicks: '639273711688335120' }
  const sample = { ...identity, workingSetBytes: 1024, privateMemoryBytes: 4096, cpuSeconds: 1, handleCount: 12 }
  assert.throws(() => validateProcessSample({ ...sample, handleCount: null }, identity), /Invalid engine metric/)
  let sampleCount = 0
  let errorCount = 0
  const monitor = await startProcessMonitor({ ...identity, runRoot: root, onError: () => { errorCount++ },
    readSample: async () => ++sampleCount === 1 ? sample : { ...sample, creationTimeTicks: '639273711688335121', workingSetBytes: 9999 } })
  await assert.rejects(monitor.stop(), /identity changed/)
  assert.equal(errorCount, 1)
  const result = JSON.parse(fs.readFileSync(path.join(root, 'engine-process-summary.json'), 'utf8'))
  assert.equal(result.status, 'failed')
  assert.equal(result.samples, 1)
  assert.equal(result.peaks.workingSetBytes, 1024)
  assert.equal(fs.existsSync(path.join(root, '.engine-monitor.lock')), false)
})

test('SSE survives fragmented UTF-8 and CRLF, and deduplicates dual tool envelopes', async () => {
  const frames = [
    { content: '中文' },
    { toolStart: { toolCallId: 't', name: 'read_file', args: { path: 'spec.json' } } },
    { toolCall: { toolCallId: 't', toolName: 'read_file', args: { path: 'spec.json' } } },
    { toolEnd: { toolCallId: 't', name: 'read_file', success: true } },
    { toolResult: { toolCallId: 't', toolName: 'read_file', success: true } },
    { run: terminal }
  ].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('')
  const result = await consumeSse(body(frames, 1))
  assert.equal(result.actualModel, 'qwen3.8-flash')
  assert.deepEqual(result.tools, [{ id: 't', name: 'read_file', path: 'spec.json', success: true }])
  assert.equal(result.bytes, Buffer.byteLength(frames))
})

test('SSE rejects missing terminal, explicit failure and oversized unterminated frame', async () => {
  await assert.rejects(consumeSse(body('data: {"content":"ok"}\n\n')), /without succeeded/)
  await assert.rejects(consumeSse(body(`data: ${JSON.stringify({ run: { ...terminal, status: 'failed' } })}\n\n`)), /failed/)
  await assert.rejects(consumeSse(body(`data: ${'x'.repeat(90)}`), { maxFrameBytes: 40 }), /frame limit/)
  await assert.rejects(consumeSse(body(`data: ${JSON.stringify({ run: { ...terminal, status: 'waiting', pending: [{ kind: 'ask', toolName: 'ask_user', question: 'fixture question' }] } })}\n\n`)), error => {
    assert.equal(error.evidence.actualModel, 'qwen3.8-flash')
    assert.equal(error.evidence.pending[0].toolName, 'ask_user')
    return true
  })
})

test('wrong actual model fails immediately without waiting for terminal', async () => {
  await assert.rejects(consumeSse(body(`data: ${JSON.stringify({ run: { ...terminal, status: 'running', actualModelId: 'deepseek-v4.1-flash' } })}\n\n`), { expectedModel: 'qwen3.8-flash' }), /Actual model mismatch before terminal/)
})

test('shared abort reason cannot cross-contaminate sibling SSE evidence', async () => {
  const reason = new Error('shared abort')
  const failingBody = id => {
    let reads = 0
    return new ReadableStream({ pull(controller) {
      if (!reads++) controller.enqueue(Buffer.from(`data: ${JSON.stringify({ run: { ...terminal, runId: id, status: 'running' } })}\n\n`))
      else controller.error(reason)
    } })
  }
  const results = await Promise.allSettled(['one', 'two'].map(id => consumeSse(failingBody(id))))
  assert.notEqual(results[0].reason, results[1].reason)
  assert.deepEqual(results.map(result => result.reason.evidence.runId), ['one', 'two'])
  assert.equal(reason.evidence, undefined)
})

test('transport does not send signal/timeout in chat JSON or JSON content-type on empty DELETE', async () => {
  const calls = []
  const client = createClient({ baseUrl: 'http://fixture.invalid', fetchImpl: async (_url, options) => {
    calls.push(options)
    return options.method === 'DELETE' ? new Response('{"code":200,"data":{}}') : new Response(body(`data: ${JSON.stringify({ run: terminal })}\n\n`))
  } })
  await client.chat('s', 'm', { model: 'qwen3.8-flash', signal: new AbortController().signal, timeoutMs: 1000 })
  await client.request('/resource', { method: 'DELETE' })
  assert.deepEqual(JSON.parse(calls[0].body), { sessionId: 's', message: 'm', model: 'qwen3.8-flash' })
  assert.equal(calls[1].headers['Content-Type'], undefined)
})

test('redaction handles primitive secret keys, strings and endpoint query credentials', () => {
  assert.deepEqual(scrub({ apiKey: 'abc', child: { password: 'def' }, message: 'value abc' }, ['abc']), { apiKey: '[REDACTED]', child: { password: '[REDACTED]' }, message: 'value [REDACTED]' })
  assert.equal(endpointSummary('https://user:pass@provider.invalid/v1?key=secret#secret'), 'https://provider.invalid/v1')
})

const discovery = { models: [
  { modelId: 'qwen3.8-flash', enabled: true, baseUrl: 'https://qwen.invalid/v1' },
  { modelId: 'deepseek-v4.1-flash', enabled: true, baseUrl: 'https://deepseek.invalid/v1' }
] }
test('plan requires distinct enabled models and rejects loopback provenance', () => {
  const config = parseOptions(['--execute'], {}, fixtureRoot)
  const plan = makePlan(config, discovery)
  assert.equal(plan.sessions.length, 10)
  assert.equal(plan.cron.length, 5)
  assert.equal(new Set(plan.sessions.filter(item => item.kind === 'shared').map(item => item.workspace)).size, 1)
  assert.throws(() => makePlan(config, { models: [discovery.models[0]] }), /distinct enabled/)
  assert.throws(() => makePlan(config, { models: discovery.models.map(model => ({ ...model, baseUrl: 'http://127.0.0.2:8080/v1' })) }), /missing\/local/)
  assert.throws(() => makePlan(config, { models: discovery.models.map(model => ({ ...model, enabled: false })) }), /Enabled qwen/)
})

test('Cron timeout is explicit, defaults to 600 seconds, and validates the persisted job range', () => {
  const defaults = parseOptions([], {}, fixtureRoot)
  assert.equal(defaults.cronTimeoutSeconds, 600)
  assert.ok(makePlan(defaults, discovery).cron.every(job => job.timeoutSeconds === 600))
  for (const value of ['0', '-1', '1.5', '86401', 'NaN']) assert.throws(() => parseOptions(['--cron-timeout-seconds', value], {}, fixtureRoot))
  assert.equal(parseOptions(['--cron-timeout-seconds', '1'], {}, fixtureRoot).cronTimeoutSeconds, 1)
  assert.equal(parseOptions(['--cron-timeout-seconds', '86400'], {}, fixtureRoot).cronTimeoutSeconds, 86400)
})

test('batch drains siblings on failure before caller cleanup can begin', async () => {
  const events = []
  await assert.rejects(settledBatch([0, 1], async item => {
    if (!item) { await delay(5); throw new Error('failed') }
    await delay(20); events.push('sibling-finished')
  }, () => events.push('abort-requested')), /failed/)
  events.push('cleanup')
  assert.deepEqual(events, ['abort-requested', 'sibling-finished', 'cleanup'])
})

test('Cron observation runs during a busy batch; observation failure drains the batch', async () => {
  const events = []
  await assert.rejects(monitorWork(async () => { await delay(35); events.push('work-drained') }, async () => {
    events.push('observed'); throw new Error('cron failed')
  }, { intervalMs: 5, abort: () => events.push('abort') }), /cron failed/)
  events.push('cleanup')
  assert.deepEqual(events, ['observed', 'abort', 'work-drained', 'cleanup'])
})

test('a sibling failure remains the run diagnosis after it aborts the Cron polling delay', async () => {
  const controller = new AbortController()
  let drained = false
  await assert.rejects(monitorWork(
    () => settledBatch([0, 1], async index => {
      if (!index) { await delay(5); throw new Error('original engineering failure') }
      await delay(25); drained = true
    }, error => controller.abort(error)),
    async () => {}, { signal: controller.signal, intervalMs: 1000, abort: error => controller.abort(error) }), /original engineering failure/)
  assert.equal(drained, true)
})

const recoveryRun = { ...terminal, sessionId: 'owned-session' }
const permission = { requestId: 'request-1', toolCallId: 'blocked-command', toolName: 'execute_cmd', kind: 'permission', status: 'pending',
  args: { command: 'node', args: ['-e', 'forbidden-inline'] } }
const recoveryEvidence = (status, pending, tools = []) => ({ sessionId: recoveryRun.sessionId, runId: recoveryRun.runId,
  turnId: recoveryRun.turnId, requestedModel: recoveryRun.modelId, actualModel: recoveryRun.actualModelId, terminal: status,
  bytes: 100, events: 3, tools, children: [], errors: [], pending })
const waitingFailure = evidence => Object.assign(new Error('waiting'), { waitingTerminal: true, evidence })

test('permission recovery sends only rejected, retains same turn evidence, and records durable rejection', async () => {
  let calls = 0
  let statusCalls = 0
  const events = []
  const answered = { ...permission, status: 'answered', output: 'rejected' }
  const before = recoveryEvidence('waiting', [permission], [{ id: 'list', name: 'list_files', success: true },
    { id: permission.toolCallId, name: 'execute_cmd', command: 'node', args: ['-e', 'forbidden-inline'] }])
  before.children = [{ runId: 'child', status: 'succeeded', childSessionId: 'same-child' }]
  const after = recoveryEvidence('succeeded', [answered], [{ id: permission.toolCallId, name: 'execute_cmd', success: false },
    { id: 'test', name: 'execute_cmd', command: 'node', args: ['--test', 'regression.test.mjs'], success: true }])
  let originalTimeout
  const client = {
    chat: async (sessionId, message, options) => {
      assert.equal(sessionId, recoveryRun.sessionId)
      if (!calls++) { originalTimeout = options.timeoutMs; throw waitingFailure(before) }
      assert.equal(message, '')
      assert.equal(options.model, undefined)
      assert.equal(options.expectedModel, recoveryRun.modelId)
      assert.ok(options.timeoutMs < originalTimeout)
      assert.deepEqual(options.toolResponse, { runId: recoveryRun.runId, requestId: permission.requestId,
        toolCallId: permission.toolCallId, name: 'execute_cmd', output: 'rejected' })
      return after
    },
    request: async () => {
      await delay(5)
      return { run: { ...recoveryRun, status: statusCalls++ ? 'succeeded' : 'waiting', pending: statusCalls === 1 ? [permission] : [answered] } }
    }
  }
  const result = await chatWithDeniedPermissions(client, recoveryRun.sessionId, 'original task', { model: recoveryRun.modelId }, { emit: event => events.push(event), timeoutMs: 5000 })
  assert.equal(result.runId, recoveryRun.runId)
  assert.equal(result.turnId, recoveryRun.turnId)
  assert.equal(result.bytes, 200)
  assert.equal(result.tools.find(tool => tool.id === 'list').success, true)
  assert.deepEqual(result.tools.find(tool => tool.id === permission.toolCallId).args, ['-e', 'forbidden-inline'])
  assert.equal(result.tools.find(tool => tool.id === permission.toolCallId).success, false)
  assert.equal(result.children[0].childSessionId, 'same-child')
  assert.deepEqual(events.map(event => event.type), ['permission-waiting', 'permission-denial-submitted', 'permission-denied', 'permission-recovered'])
  assert.equal(result.permissionRecovery.denied, 1)
})

test('permission recovery refuses stale state, non-command requests, conflicting identities and malformed streams', async () => {
  for (const patch of [
    { sessionId: 'other-session' }, { runId: 'other-run' }, { turnId: 'other-turn' }, { actualModelId: 'other-model' },
    { status: 'cancelled' }, { pending: [{ ...permission, kind: 'ask', toolName: 'ask_user' }] },
    { pending: [{ ...permission, toolName: 'write_file' }] }, { pending: [{ ...permission, requestId: 'stale' }] },
    { pending: [permission, { ...permission, requestId: 'parallel' }] }
  ]) {
    let calls = 0
    const client = { chat: async () => { calls++; throw waitingFailure(recoveryEvidence('waiting', [permission])) },
      request: async () => ({ run: { ...recoveryRun, status: 'waiting', pending: [permission], ...patch } }) }
    await assert.rejects(chatWithDeniedPermissions(client, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }))
    assert.equal(calls, 1)
  }
  let stateReads = 0
  const malformed = { chat: async () => { throw Object.assign(new Error('malformed SSE after waiting frame'), { evidence: recoveryEvidence('waiting', [permission]) }) }, request: async () => { stateReads++; return {} } }
  await assert.rejects(chatWithDeniedPermissions(malformed, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }), /malformed SSE/)
  assert.equal(stateReads, 0)
  const ask = { ...permission, kind: 'ask', toolName: 'ask_user', question: 'unnecessary question' }
  let askCalls = 0
  const asking = { chat: async () => { askCalls++; throw waitingFailure(recoveryEvidence('waiting', [ask])) },
    request: async () => ({ run: { ...recoveryRun, status: 'waiting', pending: [ask] } }) }
  await assert.rejects(chatWithDeniedPermissions(asking, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }), error => {
    assert.equal(error.taskFailure, true)
    assert.match(error.message, /no answer was invented/)
    return true
  })
  assert.equal(askCalls, 1)
})

test('permission recovery is bounded to two rejections and preserves a third unresolved wait as failure', async () => {
  let calls = 0
  const events = []
  let active
  let entries = []
  const client = {
    chat: async (_sessionId, _message, options) => {
      if (calls) assert.equal(options.toolResponse.output, 'rejected')
      calls++
      entries = entries.map(item => ({ ...item, status: 'answered', output: 'rejected' }))
      active = { ...permission, requestId: `r-${calls}`, toolCallId: `t-${calls}` }
      entries.push(active)
      throw waitingFailure(recoveryEvidence('waiting', entries, entries.filter(item => item.status === 'answered').map(item => ({ id: item.toolCallId, name: 'execute_cmd', success: false }))))
    },
    request: async () => ({ run: { ...recoveryRun, status: 'waiting', pending: entries } })
  }
  await assert.rejects(chatWithDeniedPermissions(client, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }, { emit: event => events.push(event) }), error => {
    assert.match(error.message, /exceeded 2 denials/)
    assert.equal(error.evidence.permissionRecovery.denied, 2)
    assert.equal(error.evidence.terminal, 'waiting')
    return true
  })
  assert.equal(calls, 3)
  assert.equal(events.filter(event => event.type === 'permission-waiting').length, 3)
  assert.equal(events.filter(event => event.type === 'permission-denied').length, 2)
  assert.equal(events.filter(event => event.type === 'permission-recovered').length, 0)
})

test('terminal task failures require complete stream and matching durable identities before isolation', async () => {
  for (const patch of [{ runId: null }, { turnId: null }, { actualModel: null }, { framingComplete: false }]) {
    let stateReads = 0
    const evidence = { ...recoveryEvidence('failed', []), framingComplete: true, ...patch }
    const client = { chat: async () => { throw Object.assign(new Error('model failed'), { evidence }) },
      request: async () => { stateReads++; return { run: { ...recoveryRun, runId: 'replacement-run', status: 'running' } } } }
    await assert.rejects(chatWithDeniedPermissions(client, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }), error => {
      assert.notEqual(error.taskFailure, true)
      assert.equal(error.evidence.runId, evidence.runId)
      return true
    })
    assert.equal(stateReads, 0)
  }
  for (const patch of [{ runId: 'replacement-run' }, { turnId: 'replacement-turn' }, { status: 'running' }, {}]) {
    let stateReads = 0
    const evidence = { ...recoveryEvidence('failed', []), framingComplete: true }
    const client = { chat: async () => { throw Object.assign(new Error('model failed'), { evidence }) },
      request: async () => { stateReads++; return { run: { ...recoveryRun, status: 'failed', ...patch } } } }
    await assert.rejects(chatWithDeniedPermissions(client, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }), error => {
      assert.equal(error.taskFailure, Object.keys(patch).length === 0)
      return true
    })
    assert.equal(stateReads, 1)
  }
})

test('resumed root identity changes and unacknowledged rejection cannot pass', async () => {
  for (const mode of ['run', 'model', 'approved', 'executed']) {
    let calls = 0
    let statusReads = 0
    const answered = { ...permission, status: 'answered', output: mode === 'approved' ? 'approved' : 'rejected' }
    const client = {
      chat: async () => {
        if (!calls++) throw waitingFailure(recoveryEvidence('waiting', [permission]))
        return { ...recoveryEvidence('succeeded', [answered], [{ id: permission.toolCallId, name: 'execute_cmd', success: mode === 'executed' }]),
          ...(mode === 'run' ? { runId: 'different' } : {}), ...(mode === 'model' ? { actualModel: 'different' } : {}) }
      },
      request: async () => ({ run: { ...recoveryRun, status: statusReads++ ? 'succeeded' : 'waiting', pending: statusReads === 1 ? [permission] : [answered] } })
    }
    await assert.rejects(chatWithDeniedPermissions(client, recoveryRun.sessionId, 'task', { model: recoveryRun.modelId }), /changed|not durably acknowledged/)
    assert.equal(calls, 2)
  }
})

test('cleanup attempts delete after disable failure and drains before deleting Agents', async () => {
  const calls = []
  let statusReads = 0
  const client = { request: async (route, options) => {
    calls.push(`${options?.method || 'GET'} ${route}`)
    if (route.endsWith('/disable')) throw new Error('disable failed')
    if (route.includes('/status')) return ++statusReads === 1 ? { running: true, run: { status: 'running' } } : { running: false, run: { status: 'cancelled' } }
    return {}
  } }
  const errors = await cleanupOwned(client, { cronIds: ['owned-job'], sessions: [{ sessionId: 'owned-session' }], cron: [], agentIds: ['owned-agent'] }, () => {})
  assert.equal(errors.length, 1)
  assert.ok(calls.indexOf('DELETE /api/v1/cron/owned-job') > 0)
  assert.equal(calls.at(-1), 'DELETE /api/v1/agents/owned-agent')
  assert.equal(statusReads, 2)
})

test('Cron stale snapshots never increment counts; missing intermediate evidence and waiting are red', () => {
  const observed = { verifiedRunIds: ['old'] }
  assert.deepEqual(unverifiedCronRuns([{ runId: 'old', status: 'succeeded' }], observed), [])
  assert.deepEqual(unverifiedCronRuns([{ runId: 'new', status: 'running' }], observed), [])
  assert.throws(() => unverifiedCronRuns([{ runId: 'new', status: 'running' }], observed, true), /running/)
  assert.throws(() => unverifiedCronRuns([{ runId: 'new', status: 'waiting' }], observed), /waiting/)
  assert.throws(() => unverifiedCronRuns([{ runId: 'a', status: 'succeeded' }, { runId: 'b', status: 'succeeded' }], observed), /intervening/)
  assert.deepEqual(unverifiedCronRuns([{ runId: 'failed-old', status: 'failed' }, { runId: 'next', status: 'succeeded' }], { verifiedRunIds: [], failedRunIds: ['failed-old'] }), [{ runId: 'next', status: 'succeeded' }])
})

test('stress batches isolate task errors while identity failures still abort and drain siblings', async () => {
  let aborts = 0
  let finished = 0
  const outcomes = await settleStressBatch([0, 1], async index => {
    if (!index) throw Object.assign(new Error('missing child evidence'), { taskFailure: true })
    await delay(10); finished++; return 'other task succeeded'
  }, () => { aborts++ })
  assert.equal(aborts, 0)
  assert.equal(finished, 1)
  assert.deepEqual(outcomes.map(item => item.status), ['rejected', 'fulfilled'])
  await assert.rejects(settleStressBatch([0, 1], async index => {
    if (!index) throw new Error('different run identity')
    await delay(10); finished++
  }, () => { aborts++ }), /different run identity/)
  assert.equal(aborts, 1)
  assert.equal(finished, 2)
})

test('failed-task cancellation pins the observed run and refuses replacement identities or stalled cancellation', async () => {
  let cancelled = false
  let body
  const client = { request: async (_route, options) => {
    if (options?.method === 'POST') { body = options.body; cancelled = true; return {} }
    return { running: !cancelled, run: { sessionId: 'owned', runId: 'r', status: cancelled ? 'cancelled' : 'waiting' } }
  } }
  assert.deepEqual(await drainFailedSession(client, 'owned', 'r'), { runId: 'r', status: 'cancelled' })
  assert.deepEqual(body, { sessionId: 'owned', runId: 'r' })
  let replacementReads = 0
  const replacement = { request: async () => { replacementReads++; return { running: true, run: { sessionId: 'owned', runId: 'replacement-run', status: 'running' } } } }
  for (const missing of [undefined, null, '', ' ']) await assert.rejects(drainFailedSession(replacement, 'owned', missing), /requires the observed run identity/)
  assert.equal(replacementReads, 0)
  await assert.rejects(drainFailedSession({ request: async () => ({ running: false }) }, 'owned', 'r'), /different session or run/)
  await assert.rejects(drainFailedSession({ request: async () => ({ running: true, run: { sessionId: 'owned', runId: 'replacement', status: 'running' } }) }, 'owned', 'r'), /different session or run/)
  await assert.rejects(drainFailedSession({ request: async () => ({ running: true, run: { sessionId: 'owned', runId: 'r', status: 'running' } }) }, 'owned', 'r', { timeoutMs: 10 }), /did not become terminal/)
})

async function implementFixture(item, workload) {
  const spec = JSON.parse(fs.readFileSync(path.join(item.workspace, workload.specName), 'utf8'))
  fs.writeFileSync(path.join(item.workspace, workload.moduleName), `export const revision=${workload.round}; export const policy=${JSON.stringify(spec.policy)}; const reference=${reference.toString()}; export const transform=rows=>reference(${item.index},rows,policy);`)
  fs.writeFileSync(path.join(item.workspace, workload.serviceName), `import {revision,transform} from './${workload.moduleName}'; export function run(rows){const result=transform(rows);return {round:revision,count:result.length,rows:result}}`)
  fs.writeFileSync(path.join(item.workspace, `${workload.task}-regression.test.mjs`), `import test from 'node:test'; import assert from 'node:assert/strict'; import {run} from './${workload.serviceName}'; test('empty input',()=>assert.deepEqual(run([]),{round:${workload.round},count:0,rows:[]}));`)
  await runNode(item.workspace, [workload.verifierName])
  return { ...terminal, terminal: terminal.status, actualModel: terminal.actualModelId,
    tools: [
      { name: 'list_files', success: true }, { name: 'read_file', path: workload.specName, success: true },
      { name: 'write_file', path: workload.moduleName, success: true }, { name: 'subagent', success: true },
      { name: 'execute_cmd', command: 'node', args: [workload.verifierName], success: true },
      { name: 'execute_cmd', command: 'node', args: ['--test', `${workload.task}-regression.test.mjs`], success: true }
    ], children: [{ runId: 'child-1', status: 'succeeded', childSessionId: 'child-session-1', resultNonces: [workload.nonce], readPaths: [workload.specName] }] }
}

test('engineering evidence validates all stages and shared integration; stale/tampered receipts fail', async t => {
  const root = temp(t)
  const items = Array.from({ length: 5 }, (_, index) => ({ index, workspace: root }))
  const workloads = items.map(item => prepareWorkload(item, 1, 'test-only'))
  const streams = []
  for (const [index, item] of items.entries()) {
    const workload = workloads[index]
    const stream = await implementFixture(item, workload); streams.push(stream)
    const result = await verifyWorkload(item, workload, stream, 'qwen3.8-flash')
    assert.equal(Object.keys(result.hashes).length, 3)
    assert.equal(result.verifier.exitCode, 0)
  }
  assert.equal((await verifySharedPipeline(items, workloads)).exitCode, 0)
  const continued = { ...workloads[0], priorChild: { runId: 'prior-child', childSessionId: 'child-session-1', nonce: 'old-nonce' } }
  await assert.rejects(verifyWorkload(items[0], continued, streams[0], 'qwen3.8-flash'), /required continuation/)
  const resumed = { ...streams[0], children: [{ ...streams[0].children[0], resumeFromRunId: 'prior-child', resultNonces: [...streams[0].children[0].resultNonces, 'old-nonce'] }] }
  assert.equal((await verifyWorkload(items[0], continued, resumed, 'qwen3.8-flash')).child.childSessionId, 'child-session-1')
  await assert.rejects(verifyWorkload(items[0], workloads[0], { ...streams[0], actualModel: null }, 'qwen3.8-flash'), /Actual model mismatch/)
  await assert.rejects(verifyWorkload(items[0], workloads[0], { ...streams[0], children: [] }, 'qwen3.8-flash'), /child Agent/)
  const receipt = path.join(root, workloads[0].receiptName)
  fs.writeFileSync(receipt, '{"nonce":"stale","round":1,"passed":true}')
  await assert.rejects(verifyWorkload(items[0], workloads[0], streams[0], 'qwen3.8-flash'), /fresh verifier receipt/)
  fs.appendFileSync(path.join(root, workloads[1].verifierName), '\n// tampered')
  await assert.rejects(verifyWorkload(items[1], workloads[1], streams[1], 'qwen3.8-flash'), /fixture modified/)
})

test('stress execution reaches its duration with task feedback and later Cron failures while retaining a red verdict', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--continue-on-task-error', '--run-root', root, '--run-id', 'fixture-stress',
    '--duration-hours', '0.003', '--interval-minutes', '0.0001', '--max-rounds', '2'], {}, fixtureRoot)
  const plan = makePlan(config, discovery)
  plan.cron = plan.cron.slice(0, 1)
  const states = new Map()
  const children = new Map()
  const chats = []
  const cronMessages = []
  let created = 0
  let cronReads = 0
  const cronRuns = []
  const client = {
    chat: async (sessionId, message, options) => {
      chats.push({ sessionId, message })
      const item = plan.sessions.find(item => item.sessionId === sessionId)
      const task = `task-${item.index + 1}`
      const spec = JSON.parse(fs.readFileSync(path.join(item.workspace, `${task}-spec.json`), 'utf8'))
      const workload = { ...spec, task, specName: `${task}-spec.json`, verifierName: `verify-${task}.mjs` }
      const stream = await implementFixture(item, workload)
      Object.assign(stream, { sessionId, runId: `${sessionId}-r${spec.round}`, turnId: `${sessionId}-t${spec.round}`,
        actualModel: options.model, requestedModel: options.model, events: 5, bytes: 50, errors: [], pending: [] })
      stream.tools.forEach((tool, index) => { tool.id = `${sessionId}-r${spec.round}-tool${index}` })
      if (item.kind === 'shared') stream.tools.push({ id: 'peer', name: 'read_file', path: `task-${(item.index + 1) % 5 + 1}-spec.json`, success: true })
      const previous = children.get(sessionId)
      stream.children = [{ ...stream.children[0], runId: `${sessionId}-child-${spec.round}`, modelId: options.model,
        childSessionId: `${sessionId}-child`, ...(previous ? { resumeFromRunId: previous.runId, resultNonces: [previous.nonce, spec.nonce] } : {}) }]
      states.set(sessionId, { running: false, run: { sessionId, runId: stream.runId, turnId: stream.turnId, status: 'succeeded', requestConfig: { thinkingMode: false } } })
      if (item === plan.sessions[0] && spec.round === 1) stream.tools = stream.tools.filter(tool => tool.name !== 'list_files')
      else children.set(sessionId, { runId: stream.children[0].runId, nonce: spec.nonce })
      return stream
    },
    request: async (route, options) => {
      if (route === '/api/v1/agents' && options?.method === 'POST') return { id: `agent-${++created}` }
      if (route === '/api/v1/cron' && options?.method === 'POST') return { ...options.body, id: 'owned-cron' }
      if (route === '/api/v1/cron/owned-cron' && options?.method === 'PUT') {
        cronMessages.push(options.body.message)
        return { timeoutSeconds: 600, thinkingMode: false }
      }
      if (route.includes('/chat/runs?')) {
        const item = plan.cron[0]
        if (++cronReads <= 2) {
          const run = { sessionId: item.sessionId, runId: `cron-failure-${cronReads}`, status: 'cancelled',
            requestConfig: { cronJobId: item.jobId, cronTimeoutSeconds: 600 } }
          cronRuns.push(run); states.set(item.sessionId, { running: false, run })
        }
        return { runs: cronRuns }
      }
      if (route.includes('/chat/status?')) return states.get(new URL(`http://fixture${route}`).searchParams.get('sessionId')) || { running: false }
      return {}
    }
  }
  await assert.rejects(execute(config, plan, discovery, client), /quality failures were recorded/)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.durationCompleted, true)
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.acceptance, 'not-passed')
  assert.equal(manifest.round, 2)
  assert.equal(manifest.metrics.turnsCompleted, 19)
  assert.equal(manifest.metrics.turnErrors, 1)
  assert.equal(manifest.metrics.turnsAborted, 0)
  assert.equal(manifest.metrics.cronErrors, 2)
  assert.equal(manifest.qualityFailures.length, 3)
  assert.equal(cronMessages.length, 2)
  assert.ok(cronMessages[1].includes('Cron ended cancelled (cron-failure-2)'))
  assert.deepEqual(manifest.cronEvidence[plan.cron[0].sessionId].failedRunIds, ['cron-failure-1', 'cron-failure-2'])
  const corrected = chats.filter(chat => chat.sessionId === plan.sessions[0].sessionId)
  assert.equal(corrected.length, 2)
  assert.match(corrected[1].message, /上一轮未通过的真实反馈：Missing successful list_files/)
  assert.deepEqual(manifest.cleanupErrors, [])
})

test('initialization failure cleans created resources and cannot report completed', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-initialization'], {}, fixtureRoot)
  const plan = makePlan(config, discovery)
  let agents = 0
  const deleted = []
  const client = { request: async (route, options) => {
    if (route === '/api/v1/agents' && options?.method === 'POST') { if (++agents === 2) throw new Error('create rejected'); return { id: 'owned-agent' } }
    if (options?.method === 'DELETE') deleted.push(route)
    return { running: false }
  } }
  await assert.rejects(execute(config, plan, discovery, client), /create rejected/)
  assert.deepEqual(deleted, ['/api/v1/agents/owned-agent'])
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.acceptance, 'not-passed')
  assert.equal(fs.existsSync(path.join(root, '.runner.lock')), false)
})

test('an old Cron API that drops thinkingMode is rejected and the accepted job is still cleaned', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-old-cron'], {}, fixtureRoot)
  let createdAgents = 0
  const deleted = []
  const client = { request: async (route, options) => {
    if (route === '/api/v1/agents' && options?.method === 'POST') return { id: `agent-${++createdAgents}` }
    if (route === '/api/v1/cron' && options?.method === 'POST') {
      assert.equal(options.body.thinkingMode, false)
      return { id: 'accepted-old-cron' }
    }
    if (options?.method === 'DELETE') deleted.push(route)
    return { running: false }
  } }
  await assert.rejects(execute(config, makePlan(config, discovery), discovery, client), /Cron API did not persist/)
  assert.ok(deleted.includes('/api/v1/cron/accepted-old-cron'))
  assert.equal(deleted.filter(route => route.startsWith('/api/v1/agents/')).length, 3)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).status, 'failed')
})

test('an old Cron API that drops the explicit timeout is rejected and its job is cleaned', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-cron-timeout'], {}, fixtureRoot)
  let created = 0
  const deleted = []
  const client = { request: async (route, options) => {
    if (route === '/api/v1/agents' && options?.method === 'POST') return { id: `agent-${++created}` }
    if (route === '/api/v1/cron' && options?.method === 'POST') {
      assert.equal(options.body.timeoutSeconds, 600)
      return { id: 'old-timeout-job', thinkingMode: false }
    }
    if (options?.method === 'DELETE') deleted.push(route)
    return { running: false }
  } }
  await assert.rejects(execute(config, makePlan(config, discovery), discovery, client), /explicit timeoutSeconds/)
  assert.ok(deleted.includes('/api/v1/cron/old-timeout-job'))
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'failed')
  assert.deepEqual(manifest.cleanupErrors, [])
})

test('signal during resource creation records accepted id then stops creating and cleans', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-signal'], {}, fixtureRoot)
  let creates = 0
  const deleted = []
  const client = { request: async (route, options) => {
    if (route === '/api/v1/agents' && options?.method === 'POST') {
      creates += 1
      process.emit('SIGTERM')
      return { id: 'accepted-before-signal' }
    }
    if (options?.method === 'DELETE') deleted.push(route)
    return { running: false }
  } }
  await assert.rejects(execute(config, makePlan(config, discovery), discovery, client), /SIGTERM/)
  assert.equal(creates, 1)
  assert.deepEqual(deleted, ['/api/v1/agents/accepted-before-signal'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).status, 'stopped')
})

test('a cleanup error cannot produce completed even after the acceptance path passes', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-cleanup', '--duration-hours', '0.00000001'], {}, fixtureRoot)
  // No workload in this lifecycle fixture: isolate the final verdict after the
  // normal deadline/acceptance path, without pretending to run model work.
  const plan = { ...makePlan(config, discovery), sessions: [], cron: [] }
  let created = 0
  const client = { request: async (route, options) => {
    if (route === '/api/v1/agents' && options?.method === 'POST') return { id: `owned-${++created}` }
    if (options?.method === 'DELETE') throw new Error('cleanup rejected')
    return {}
  } }
  await assert.rejects(execute(config, plan, discovery, client), /cleanup errors/)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.cleanupErrors.length, 3)
})

test('a separate failure that arrives after the idle deadline is preserved rather than accepted', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-deadline-error', '--duration-hours', '0.000003'], {}, fixtureRoot)
  const plan = { ...makePlan(config, discovery), sessions: [], cron: [] }
  const client = { request: async (route, options) => {
    if (route === '/api/v1/agents' && options?.method === 'POST') {
      await delay(40)
      throw new Error('Independent API configuration failure')
    }
    return {}
  } }
  await assert.rejects(execute(config, plan, discovery, client), /Independent API configuration failure/)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.stopReason, 'deadline')
  assert.equal(manifest.durationCompleted, true)
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.acceptance, 'not-passed')
  assert.equal(manifest.failure, 'Independent API configuration failure')
})

test('hard deadline aborts a non-finishing batch and records failure before cleanup', async t => {
  const root = temp(t)
  const config = parseOptions(['--execute', '--run-root', root, '--run-id', 'fixture-deadline', '--duration-hours', '0.00006'], {}, fixtureRoot)
  let created = 0
  let aborted = 0
  const client = {
    request: async (route, options) => {
      if (options?.method === 'POST' && ['/api/v1/agents', '/api/v1/cron'].includes(route)) return { id: `owned-${++created}`, thinkingMode: false, timeoutSeconds: options.body.timeoutSeconds }
      return { running: false, runs: [] }
    },
    chat: async (_session, _message, options) => new Promise((_resolve, reject) => {
      if (options.signal.aborted) { aborted += 1; reject(options.signal.reason); return }
      options.signal.addEventListener('abort', () => { aborted += 1; reject(options.signal.reason) }, { once: true })
    })
  }
  const started = Date.now()
  await assert.rejects(execute(config, makePlan(config, discovery), discovery, client), error => error.message === 'deadline' || error.cause?.message === 'deadline')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.stopReason, 'deadline')
  assert.equal(aborted, 10)
  assert.ok(Date.now() - started < 2500, 'deadline must not wait for chat request timeout')
  assert.ok(Date.parse(manifest.finishedAt) >= Date.parse(manifest.workloadFinishedAt))
})
