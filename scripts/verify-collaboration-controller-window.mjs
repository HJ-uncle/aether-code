import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Production BrowserWindow/preload/IPC/React, with an authenticated synthetic
// controller gateway only. This is not the real engine's joint acceptance.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2] ? path.resolve(process.argv[2]) : repo
fs.mkdirSync(path.join(repo, '.e2e-tmp'), { recursive: true })
const qa = fs.mkdtempSync(path.join(repo, '.e2e-tmp/collaboration-controller-window-'))
const tests = path.join(qa, 'tests'), profile = path.join(qa, 'profile')
fs.mkdirSync(path.join(tests, 'e2e/helpers'), { recursive: true }); fs.mkdirSync(profile)
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tests, 'node_modules'), 'junction')
fs.symlinkSync(path.join(source, 'src'), path.join(tests, 'src'), 'junction')
fs.copyFileSync(path.join(source, 'e2e/helpers/electron-health.ts'), path.join(tests, 'e2e/helpers/electron-health.ts'))
fs.copyFileSync(path.join(repo, 'e2e/probes/collaboration-controller-window.case.ts'), path.join(tests, 'e2e/controller.spec.ts'))
const fingerprint = directory => {
  const files = []
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push([path.relative(directory, file).replaceAll('\\', '/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]) } }
  walk(directory); return { count: files.length, digest: crypto.createHash('sha256').update(JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex') }
}
const before = fingerprint(path.join(source, 'out')), sourceBefore = fingerprint(path.join(source, 'src'))
const token = 'owned-controller-fixture-token', model = 'owned-no-provider-model'
const requests = [], posts = [], continuations = [], receipts = new Map(), streams = new Set(), held = new Map()
let instanceId = path.basename(qa), mode = 'accepted', capability = true, childTerminal = false, rootTerminal = false, holdContext = false, modern = false, wrongInvocation = false
const rootFor = sessionId => ({ schemaVersion: 1, runId: 'root-' + sessionId, attemptId: 'attempt-' + sessionId, sessionId,
  turnId: 'turn-' + sessionId, userMessageId: 'user-' + sessionId, assistantMessageId: 'assistant-' + sessionId,
  version: 1, seq: 1, status: rootTerminal ? 'succeeded' : 'running', workspacePaths: [], modelId: model, createdAt: 1, updatedAt: 2, pending: [], requestConfig: { thinkingMode: false, memoryScope: 'off' } })
const childFor = (sessionId, index) => ({ schemaVersion: 1, runId: `child-run-${sessionId}-${index}`, tenantId: 'owned-fixture', rootSessionId: sessionId,
  parentSessionId: sessionId, parentConversationId: 'turn-' + sessionId, parentMessageId: 'assistant-' + sessionId, parentToolCallId: 'dispatch-' + index,
  childSessionId: `child-context-${sessionId}-${index}`, agentName: `协作工程师 ${index}`, task: '合成项目独立模块实现', description: `协作工程师 ${index}`,
  modelId: model, status: childTerminal ? 'succeeded' : 'running', lastSeq: childTerminal ? 2 : 1, createdAt: index, updatedAt: childTerminal ? 4 : 2,
  usage: {}, toolCalls: [], continuation: { readOnly: false }, partialOutput: '合成上下文持续保留' })
const identityFor = (sessionId, index) => Object.fromEntries(['tenantId', 'runId', 'rootSessionId', 'parentSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'modelId', 'createdAt', 'agentName'].map(key => [key, childFor(sessionId, index)[key]]))
const modernChild = (sessionId, index, seq = 9) => ({ ...childFor(sessionId, index), schemaVersion: 2, view: 'summary', lastSeq: seq,
  usage: { totalTokens: 20 }, toolCount: 0, activeToolCount: 0, toolCalls: [], coverage: { asOfSeq: seq, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0, ids: [], hasMore: false, truncated: false, completeness: 'complete' },
  partialOutput: seq === 4 ? '已发布固定正文 #4' : '当前可变正文 #9' })
const fenceFor = sessionId => ({ tenantId: 'owned-fixture', parentSessionId: sessionId, rootSessionId: sessionId, parentTurnId: 'turn-' + sessionId, rootRunId: 'root-' + sessionId,
  attemptId: 'attempt-' + sessionId, streamId: 'stream-' + sessionId, generation: 'owned-modern-generation', eventSequence: 7, revision: 4, usageRevision: 6 })
const recoveryFor = sessionId => ({ protocolVersion: 1, source: 'live-published', snapshotId: 'lease-' + sessionId, fence: fenceFor(sessionId), totalPublishedCount: 2, includedCount: 2, residentComplete: true, hasMore: false, nextCursor: null,
  refs: [1, 2].map(index => ({ identity: identityFor(sessionId, index), atSeq: 9, firstOrdinal: index })), usage: { source: 'authoritative-scalar', revision: 'owned-fixed-usage', totalTokens: 40, count: 2, unknown: 0 } })
const send = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: status === 200 ? 200 : status * 100 + 1, message: status === 200 ? 'OK' : 'Owned fixture rejected', data })) }
const readBody = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), route = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : {}
    const sessionId = url.searchParams.get('sessionId') ?? url.searchParams.get('rootSessionId') ?? url.searchParams.get('parentSessionId') ?? body.sessionId ?? ''
    requests.push({ method: req.method, path: route, query: Object.fromEntries(url.searchParams), profile: req.headers['x-aether-tool-profile'] })
    if ((route.startsWith('/api/') || route.startsWith('/qa/')) && req.headers['x-aether-instance-token'] !== token) return send(res, null, 401)
    if (route === '/health') return send(res, { status: 'ok' })
    if (route === '/meta') return send(res, { version: '2.0.0', buildId: 'sha256:' + 'f'.repeat(64), protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId })
    if (route === '/qa/audit') return send(res, { requests, posts, continuations, held: [...held.keys()], receipts: [...receipts] })
    if (route === '/qa/control') {
      if (body.mode) mode = body.mode
      if (typeof body.capability === 'boolean') capability = body.capability
      if (typeof body.childTerminal === 'boolean') childTerminal = body.childTerminal
      if (typeof body.rootTerminal === 'boolean') rootTerminal = body.rootTerminal
      if (typeof body.modern === 'boolean') modern = body.modern
      if (typeof body.wrongInvocation === 'boolean') wrongInvocation = body.wrongInvocation
      if (body.holdContext === true) holdContext = true
      if (body.release) { for (const release of held.values()) release(); held.clear() }
      if (body.instanceId) instanceId = body.instanceId
      if (body.acceptKey && posts.find(item => item.body.requestKey === body.acceptKey)) {
        const post = posts.find(item => item.body.requestKey === body.acceptKey), text = post.body.message
        receipts.set(body.acceptKey, { messageId: 'message-' + body.acceptKey, rootRunId: post.rootRunId, rootAttemptId: post.query.rootAttemptId,
          senderParticipantId: 'root', senderInvocationRunId: post.rootRunId, recipientParticipantId: post.body.recipientParticipantId,
          requestKey: body.acceptKey, payloadHash: crypto.createHash('sha256').update(text).digest('hex'), payloadBytes: Buffer.byteLength(text), acceptedSeq: 3, acceptedAt: 4,
          state: body.receiptState ?? 'queued', ...(body.receiptState === 'interrupted' ? { reason: 'target_invocation_finished_before_consumption' } : {}) })
      }
      return send(res, { ok: true })
    }
    if (route === '/api/v1/models') return send(res, [{ id: model, modelId: model, provider: 'openai', displayName: 'Owned no-provider fixture', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }])
    if (route === '/api/v1/subagent/capabilities') return modern ? send(res, { schemaVersion: 2, eventVersions: [2], views: ['summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true,
      boundedSnapshotChildren: 1, publishedChildRecovery: 1, authoritativeChildUsage: 1 }) : send(res, null, 404)
    if (route === '/api/v1/subagent/runs') return send(res, modern ? { schemaVersion: 2, runs: [modernChild(sessionId, 1), modernChild(sessionId, 2)], revision: 'owned-fixed', listComplete: true, hasMore: false } : [childFor(sessionId, 1), childFor(sessionId, 2)])
    const childRoute = route.match(/^\/api\/v1\/subagent\/runs\/child-run-(.+)-([12])$/)
    if (childRoute) { const owner = sessionId || childRoute[1], index = Number(childRoute[2]); return send(res, modern ? modernChild(owner, index, Number(url.searchParams.get('atSeq') ?? 9)) : childFor(owner, index)) }
    if (route === '/api/v1/chat/snapshot/projection') return send(res, { protocolVersion: 1, snapshotId: 'lease-' + sessionId, fence: fenceFor(sessionId), totalCount: 2, originalProjectionCount: 3, hasMore: false, nextCursor: null,
      entries: [1, 2].map(index => ({ projectionIndex: index, field: 'subagentEvent', runId: `child-run-${sessionId}-${index}`, atSeq: 9, sourceAtSeq: 4 })) })
    if (route.startsWith('/api/v1/chat/snapshot/children/')) return send(res, { snapshotId: 'lease-' + sessionId, fence: fenceFor(sessionId), item: { identity: identityFor(sessionId, Number(route.at(-1))), atSeq: 9 } })
    if (route === '/api/v1/collaboration/capabilities') return send(res, { userControllerMutation: capability })
    const controller = route.match(/^\/api\/v1\/collaboration\/roots\/([^/]+)\/(controller-context|controller-receipts\/[^/]+|messages)$/)
    if (controller) {
      const rootRunId = decodeURIComponent(controller[1])
      if (controller[2] === 'controller-context') {
        if (holdContext) { holdContext = false; await new Promise(resolve => held.set(rootRunId, resolve)) }
        const childSessionId = (url.searchParams.get('recipientParticipantId') ?? '').slice('child:'.length)
        const index = Number(childSessionId.at(-1)), child = childFor(sessionId, index)
        return send(res, { outcome: 'ready', scope: { rootRunId, rootAttemptId: 'attempt-' + sessionId, rootSessionId: sessionId },
          participants: { entries: [], revision: 4, hasMore: true, nextCursor: 'later-page' },
          recipient: { participantId: 'child:' + childSessionId, kind: 'child', sessionId: childSessionId, invocationRunId: wrongInvocation ? child.runId + '-different-invocation' : child.runId, admittedSeq: 1, admittedAt: 1 } })
      }
      if (controller[2].startsWith('controller-receipts/')) {
        const requestKey = decodeURIComponent(controller[2].slice('controller-receipts/'.length)), receipt = receipts.get(requestKey)
        return send(res, receipt ? { outcome: 'accepted', receipt } : { outcome: 'not_found', requestKey }, receipt ? 200 : 404)
      }
      posts.push({ rootRunId, query: Object.fromEntries(url.searchParams), body })
      if (mode === 'reject') return send(res, null, 409)
      if (mode === 'unknown') return send(res, { outcome: 'unknown', requestKey: body.requestKey }, 503)
      const receipt = { messageId: 'message-' + body.requestKey, rootRunId, rootAttemptId: url.searchParams.get('rootAttemptId'), senderParticipantId: 'root', senderInvocationRunId: rootRunId,
        recipientParticipantId: body.recipientParticipantId, requestKey: body.requestKey, payloadHash: crypto.createHash('sha256').update(body.message).digest('hex'),
        payloadBytes: Buffer.byteLength(body.message), acceptedSeq: 3, acceptedAt: 4, state: 'queued' }
      receipts.set(body.requestKey, receipt)
      return send(res, { outcome: 'accepted', receipt: mode === 'malformed' ? { ...receipt, payloadHash: '0'.repeat(64) } : receipt })
    }
    if (route === '/api/v1/chat/admission/context') { const root = rootFor(sessionId); return send(res, { protocolVersion: 1, tenantId: 'owned-tenant', sessionId,
      namespace: { id: 'owned-controller-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root,
      predecessor: { runId: root.runId, attemptId: root.attemptId, version: root.version } }) }
    if (route === '/api/v1/chat/snapshot') { const run = rootFor(sessionId); return send(res, { schemaVersion: 1, sessionId, source: 'live', eventId: run.runId + ':1', finished: rootTerminal,
      ...(modern ? { eventId: 'stream-' + sessionId + ':7', projection: [{ content: '合成现代恢复前缀' }], projectionIndices: [0], subagentRecovery: recoveryFor(sessionId),
        subagentProjectionArchive: { protocolVersion: 1, snapshotId: 'lease-' + sessionId, totalCount: 2, originalProjectionCount: 3, endpoint: '/chat/snapshot/projection' } }
        : { projection: [1, 2].map(index => ({ toolStart: { id: 'dispatch-' + index, name: 'subagent', args: { task: '合成项目独立模块实现' } } })) }),
      history: [{ id: run.userMessageId, role: 'user', content: '合成协作任务', conversationId: run.turnId, createdAt: 1 }], run, runs: [run], todos: [], changes: [], commandJobs: [] }) }
    if (route === '/api/v1/chat/status') return send(res, { running: !rootTerminal, run: rootFor(sessionId) })
    if (route === '/api/v1/chat/runs') return send(res, { runs: [rootFor(sessionId)] })
    if (route === '/api/v1/chat/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': owned\n\n'); streams.add(res); const timer = setInterval(() => res.write(': keepalive\n\n'), 10000); res.on('close', () => { clearInterval(timer); streams.delete(res) }); return }
    if (route === '/api/v1/chat' && req.method === 'POST') { continuations.push(body); return send(res, null, 409) }
    if (route === '/api/v1/security/mode') return send(res, { mode: 'safe', sessionId })
    if (route === '/api/v1/memory/settings') return send(res, { memoryScope: 'off', effectiveScope: 'off', enabled: false, sessionId })
    if (route === '/api/v1/workspace/directory') return send(res, { root: '', entries: [] })
    return send(res, [])
  } catch (error) { console.error('FIXTURE', error); send(res, null, 500) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: base, autoStartEngine: true, lastSessionId: '', lastModelId: model, thinkingMode: 'off', appearance: 'dark', graphicsMode: 'software', lastFolder: '' }))
fs.writeFileSync(path.join(tests, 'playwright.config.ts'), `import {defineConfig} from '@playwright/test'\nexport default defineConfig({testDir:'./e2e',testMatch:'controller.spec.ts',workers:1,fullyParallel:false,retries:0,timeout:240000,expect:{timeout:20000},reporter:[['list'],['json',{outputFile:${JSON.stringify(path.join(qa, 'report.json'))}}]],outputDir:${JSON.stringify(path.join(qa, 'artifacts'))},use:{trace:'retain-on-failure'}})\n`)
fs.writeFileSync(path.join(tests, 'tsconfig.live.json'), JSON.stringify({ extends: path.join(source, 'tsconfig.web.json'), include: ['e2e/**/*.ts', path.join(source, 'src/preload/index.d.ts')], compilerOptions: { strict: true, noEmit: true, composite: false, noUnusedLocals: false, noUnusedParameters: false, types: ['node', 'electron-vite/node'] } }, null, 2))
const env = { ...process.env, AETHER_E2E_APP_ENTRY: path.join(source, 'out/main/index.js'), AETHER_QA_CONTROLLER_ORIGIN: base, AETHER_QA_CONTROLLER_TOKEN: token, AETHER_QA_CONTROLLER_PROFILE: profile, AETHER_QA_CONTROLLER_MODEL: model }
for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN'].includes(key.toUpperCase())) delete env[key]
const stdout = fs.createWriteStream(path.join(qa, 'stdout.log')), stderr = fs.createWriteStream(path.join(qa, 'stderr.log'))
async function run(args) { const child = spawn(process.execPath, args, { cwd: tests, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stderr, { end: false }); return new Promise(resolve => { child.once('error', error => resolve({ error: error.message })); child.once('close', (code, signal) => resolve({ code, signal })) }) }
let exit, typecheckExit
try { typecheckExit = await run([path.join(repo, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', path.join(tests, 'tsconfig.live.json')]); exit = typecheckExit.code === 0 ? await run([path.join(repo, 'node_modules/@playwright/test/cli.js'), 'test', '--workers=1']) : typecheckExit }
finally { for (const release of held.values()) release(); for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve)); await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]) }
const after = fingerprint(path.join(source, 'out')), sourceAfter = fingerprint(path.join(source, 'src'))
const stable = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter)
const result = { qa, source, exit, typecheckExit, before, after, sourceBefore, sourceAfter, stable, passed: exit?.code === 0 && typecheckExit?.code === 0 && stable, models: 0, requests, posts,
  scope: 'Real production BrowserWindow/preload/IPC/React; authenticated synthetic controller gateway only. Not real-engine joint acceptance, no model or soak.' }
fs.writeFileSync(path.join(qa, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ qa, passed: result.passed, exit, typecheckExit, stable, posts: posts.length })); if (!result.passed) process.exitCode = 1
