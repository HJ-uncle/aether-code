import { test, expect } from '@playwright/test'
import { EngineQueueGateway, type QueueEnginePort } from '../src/main/next-turn-engine-gateway'
import { engineHost } from '../src/main/engine/host'
import { engineRequest } from '../src/main/engine/client'
import { remoteRequestError } from '../src/main/engine/protocol'
import { NextTurnQueueError } from '../src/shared/next-turn-queue'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import type { WorkQueueDraft } from '../src/shared/work-next-turn-api'
import { WORK_QUEUE_TRANSPORT, freezeQueueRequest, assertFrozenQueueRequest } from '../src/main/next-turn-admission-protocol'
import { promises as fs } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

/** Actual main gateway under an injected authenticated transport; no sockets or provider. */
function setup(remote = true, workspace: string[] = []) {
  const epoch = new AbortController(), snapshot = { ...engineHost.getSnapshot(), phase: 'ready' as const, mode: remote ? 'remote' as const : 'embedded' as const,
    baseUrl: 'https://synthetic.invalid', instanceId: 'synthetic-instance', accountId: 'synthetic-account' }
  let root = { runId: 'synthetic-initial', attemptId: 'initial-attempt', version: 1, status: 'succeeded', workspacePaths: workspace, modelId: 'synthetic-model', agentId: 'synthetic-primary' }
  const context = { protocolVersion: 1, tenantId: 'middleware-tenant', sessionId: 'work-synthetic', namespace: { id: 'synthetic-db', generation: 'one' }, transport: WORK_QUEUE_TRANSPORT,
    predecessor: { runId: root.runId, attemptId: root.attemptId, version: root.version }, root }
  const requests: EngineRequestInput[] = [], posts: RequestInit[] = [], files = new Map<string, Buffer>(), receipts = new Map<string, unknown>()
  let adapters = 0, modelEnabled = true, denyReceipt = false
  const port: QueueEnginePort = {
    snapshot: () => snapshot, signal: () => epoch.signal,
    headers: async () => ({ Authorization: 'Bearer synthetic-test-credential', 'X-Aether-Tool-Profile': 'general', 'X-Aether-Run-Lifetime': 'durable' }),
    request: async <T>(input: EngineRequestInput): Promise<EngineRequestResult<T>> => {
      requests.push(structuredClone(input)); let data: unknown
      if (input.path === '/chat/admission/context') data = { ...context, root, predecessor: { runId: root.runId, attemptId: root.attemptId, version: root.version } }
      else if (input.path === '/models') data = [{ id: 'synthetic-model-row', modelId: 'synthetic-model', isEnabled: modelEnabled }]
      else if (input.path === '/workspace/file') { const body = input.body as { path: string; content: string }; files.set(body.path, Buffer.from(body.content, 'base64')); data = { path: body.path } }
      else if (input.path === '/chat/admission/receipt') { const body = input.body as { requestKey: string; sessionId: string; namespace: unknown }
        data = receipts.get(body.requestKey) ?? { protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey } }
      else throw new Error('Unexpected synthetic route ' + input.path)
      return { ok: true, code: 200, message: '', data: data as T }
    },
    fetch: async (input, options) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/workspace/file/download') {
        const data = files.get(url.searchParams.get('path')!)
        return data ? new Response(new Uint8Array(data), { status: 200 }) : new Response('not found', { status: 404 })
      }
      if (url.pathname !== '/api/v1/chat') throw new Error('Unexpected synthetic fetch')
      posts.push(options!); const body = JSON.parse(String(options?.body))
      root = { ...root, runId: 'synthetic-accepted', attemptId: 'accepted-attempt', status: 'running' }
      if (!denyReceipt) receipts.set(body.admission.requestKey, { protocolVersion: 1, status: 'accepted',
        receipt: { ...body.admission, sessionId: 'work-synthetic', rootRunId: root.runId, turnId: 'synthetic-turn', userMessageId: 'synthetic-user', assistantMessageId: 'synthetic-anchor' },
        run: { runId: root.runId, version: root.version, status: root.status, workspacePaths: root.workspacePaths, modelId: root.modelId,
          sessionId: 'work-synthetic', turnId: 'synthetic-turn', userMessageId: 'synthetic-user', assistantMessageId: 'synthetic-anchor' },
        projection: { rootVersion: root.version, rootAttemptId: root.attemptId, user: { messageId: 'synthetic-user', state: 'projected' }, assistant: { anchorMessageId: 'synthetic-anchor', state: 'unwritten' } } })
      return new Response('event: message\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    remoteBody: async body => { adapters++; const value = body as Record<string, unknown>; return { ...value, workspacePaths: [...root.workspacePaths] } },
    allowed: value => {
      const target = resolve(value), boundary = resolve(process.cwd(), '.e2e-tmp'), rel = relative(boundary, target)
      if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('outside controlled fixture')
      return target
    }
  }
  const gateway = new EngineQueueGateway(port), submission: WorkQueueDraft = { draft: { text: 'synthetic task', revision: 1, mentions: [] }, model: { kind: 'engine-default' },
    resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'override', ids: ['synthetic-kb'] } }, thinking: { kind: 'off' }, attachments: [] }
  return { gateway, port, epoch, snapshot, context, requests, posts, files, submission, adapters: () => adapters, disableModel: () => { modelEnabled = false }, denyReceipt: () => { denyReceipt = true } }
}
test('actual gateway rejects an idle authority before reading any source', async () => {
  await expect(new EngineQueueGateway().capture('work-synthetic')).rejects.toThrow('尚未就绪')
})
test('remote authority carries trusted tenant and exact scoped transport, copied/stale lease is rejected', async () => {
  const env = setup(), lease = await env.gateway.capture('work-synthetic')
  expect(lease.scope.tenantId).toBe('middleware-tenant'); expect(lease.scope.source.accountId).toBe('synthetic-account')
  expect(env.requests[0].expectedEngine?.instanceId).toBe('synthetic-instance'); expect(env.requests[0].toolProfile).toBe('general'); expect(env.requests[0].subagentProtocol).toBe(2)
  expect(() => env.gateway.assertCurrent({ ...lease })).toThrow('not owned'); env.epoch.abort(); expect(() => env.gateway.assertCurrent(lease)).toThrow('已变化')
})
test('remote exact two routes are allowed only for their methods; adjacent arbitrary routes are blocked', () => {
  expect(remoteRequestError('remote', 'GET', '/chat/admission/context')).toBeNull(); expect(remoteRequestError('remote', 'POST', '/chat/admission/receipt')).toBeNull()
  for (const [method, path] of [['POST', '/chat/admission/context'], ['GET', '/chat/admission/receipt'], ['POST', '/chat/admission/other'], ['DELETE', '/chat/admission/receipt']]) expect(remoteRequestError('remote', method, path)).not.toBeNull()
})
test('actual remote preparation is once and final serialized admission survives POST; headers are not persisted', async () => {
  const env = setup(), lease = await env.gateway.capture('work-synthetic'), envelope = await env.gateway.envelope(lease.scope, env.submission), context = await env.gateway.context(lease.scope)
  expect(envelope.model).toEqual({ kind: 'engine-default', observedModelId: 'synthetic-model' }); expect(envelope.agent.primaryAgentId).toBe('synthetic-primary')
  const body = await env.gateway.prepare(lease.scope, envelope, context), frozen = freezeQueueRequest(lease.scope, body, 1, context.predecessor)
  await env.gateway.submit(lease.scope, assertFrozenQueueRequest(lease.scope, frozen), new AbortController().signal)
  expect(env.posts[0].body).toBe(frozen.wireBody); expect(JSON.parse(String(env.posts[0].body)).admission.bodyDigest).toBe(frozen.bodyDigest)
  expect(env.adapters()).toBe(1); expect(frozen.wireBody).not.toContain('synthetic-test-credential')
  expect(body.thinkingMode).toBe(false); expect(body.mcpServers).toEqual([]); expect(body).not.toHaveProperty('securityMode'); expect(body).not.toHaveProperty('memoryScope')
  const exact = await env.gateway.receipt(lease.scope, { id: 'synthetic-entry', revision: 1, createdAt: 1, updatedAt: 1, envelope, phase: 'dispatching', frozen })
  expect(exact.status).toBe('accepted')
})
test('disabled captured model blocks preparation without POST or silent fallback', async () => {
  const env = setup(), lease = await env.gateway.capture('work-synthetic'), envelope = await env.gateway.envelope(lease.scope, env.submission), context = await env.gateway.context(lease.scope)
  env.disableModel(); await expect(env.gateway.prepare(lease.scope, envelope, context)).rejects.toThrow('模型已不可用'); expect(env.posts).toHaveLength(0)
})
test('remote/scratch bytes are staged immutably beneath .ae; lost token is replaced by verified path receipt', async () => {
  const env = setup(); env.files.set('.ae/attachments/original.txt', Buffer.from('old bytes'))
  const lease = await env.gateway.capture('work-synthetic'), envelope = await env.gateway.envelope(lease.scope, { ...env.submission,
    attachments: [{ path: '.ae/attachments/original.txt', name: 'original.txt', type: 'text/plain', size: 9, remoteUploadId: 'volatile-token' }] })
  const receipt = envelope.attachments[0]; expect(receipt.path).toMatch(/^\.ae\/attachments\/next-turn-/); expect(receipt.scope).toEqual(lease.scope)
  env.files.set('.ae/attachments/original.txt', Buffer.from('changed bytes')); const body = await env.gateway.prepare(lease.scope, envelope, await env.gateway.context(lease.scope))
  expect(body.attachments).toEqual([{ name: receipt.path, type: 'text/plain' }]); expect(body).not.toHaveProperty('remoteUploadId')
  env.files.set(receipt.path, Buffer.from('bad bytes')); await expect(env.gateway.prepare(lease.scope, envelope, await env.gateway.context(lease.scope))).rejects.toThrow('丢失或已改变')
})
test('actual attachment-only envelope and wire retain empty authored message', async () => {
  const env = setup(); env.files.set('.ae/attachments/image.png', Buffer.from('test'))
  const lease = await env.gateway.capture('work-synthetic'), envelope = await env.gateway.envelope(lease.scope, { ...env.submission, draft: { text: '', mentions: [], revision: 1 },
    attachments: [{ path: '.ae/attachments/image.png', name: 'image.png', type: 'image/png', size: 4 }] })
  const body = await env.gateway.prepare(lease.scope, envelope, await env.gateway.context(lease.scope)); expect(body.message).toBe(''); expect(body.attachments).toHaveLength(1)
})
test('absolute paths and traversal cannot enter a remote attachment receipt', async () => {
  const env = setup(), lease = await env.gateway.capture('work-synthetic')
  for (const path of ['D:/private/file.txt', '../private.txt', '/private.txt', 'foo/../private.txt', '\\\\server\\secret.txt']) {
    await expect(env.gateway.envelope(lease.scope, { ...env.submission, attachments: [{ path, name: 'private.txt', type: 'text/plain', size: 1 }] })).rejects.toThrow('当前会话')
  }
  expect(env.files.size).toBe(0); expect(env.posts).toHaveLength(0)
})
test('actual local workspace staging retains bytes and rejects another workspace despite broad fixture grant', async () => {
  const boundary = join(process.cwd(), '.e2e-tmp', 'actual-gateway-local'), project = join(boundary, 'project'), outside = join(boundary, 'another-project.txt')
  await fs.mkdir(project, { recursive: true }); const original = join(project, 'source.txt'); await fs.writeFile(original, 'snapshot'); await fs.writeFile(outside, 'outside')
  try {
    const env = setup(false, [project]), lease = await env.gateway.capture('work-synthetic')
    const envelope = await env.gateway.envelope(lease.scope, { ...env.submission, attachments: [{ path: original, name: 'source.txt', type: 'text/plain', size: 8 }] })
    const receipt = envelope.attachments[0]
    await fs.writeFile(original, 'modified'); expect(await fs.readFile(join(project, receipt.path), 'utf8')).toBe('snapshot')
    expect(receipt.path).toMatch(/^\.ae\/attachments\/next-turn-/)
    const body = await env.gateway.prepare(lease.scope, envelope, await env.gateway.context(lease.scope))
    expect(body.attachments).toEqual([{ name: join(project, receipt.path), type: 'text/plain' }])
    await expect(env.gateway.envelope(lease.scope, { ...env.submission, attachments: [{ path: outside, name: 'outside.txt', type: 'text/plain', size: 7 }] })).rejects.toThrow('固定工作区')
  } finally { const target = resolve(boundary), intended = resolve(process.cwd(), '.e2e-tmp'); if (!target.startsWith(intended + sep)) throw new NextTurnQueueError('SCOPE', 'fixture cleanup boundary failed'); await fs.rm(target, { recursive: true, force: true }) }
})

test('a local staged directory redirected into another granted project is rejected before writing any snapshot', async () => {
  const boundary = join(process.cwd(), '.e2e-tmp', 'actual-gateway-redirect'), project = join(boundary, 'project'), other = join(boundary, 'other')
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(other, { recursive: true }); await fs.writeFile(join(project, 'source.txt'), 'test')
  await fs.symlink(other, join(project, '.ae'), 'junction')
  try {
    const env = setup(false, [project]), lease = await env.gateway.capture('work-synthetic')
    await expect(env.gateway.envelope(lease.scope, { ...env.submission, attachments: [{ path: join(project, 'source.txt'), name: 'source.txt', type: 'text/plain', size: 4 }] })).rejects.toThrow('普通目录')
    expect(await fs.readdir(other)).toEqual([]); expect(env.posts).toHaveLength(0)
  } finally { const target = resolve(boundary), intended = resolve(process.cwd(), '.e2e-tmp'); if (!target.startsWith(intended + sep)) throw new NextTurnQueueError('SCOPE', 'fixture cleanup boundary failed'); await fs.rm(target, { recursive: true, force: true }) }
})

test('owned gateway close aborts staged downloads without stopping the user engine epoch', async () => {
  const env = setup(), lease = await env.gateway.capture('work-synthetic'); let downloading = false, observedSignal: AbortSignal | undefined
  env.port.fetch = async (_input, options) => {
    downloading = true; observedSignal = options?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => { observedSignal?.addEventListener('abort', () => reject(new Error('synthetic owned download aborted')), { once: true }) })
  }
  const staged = env.gateway.envelope(lease.scope, { ...env.submission, attachments: [{ path: '.ae/attachments/source.txt', name: 'source.txt', type: 'text/plain', size: 4 }] })
  const outcome = staged.then(() => 'unexpected snapshot', error => error instanceof Error ? error.message : 'error')
  await expect.poll(() => downloading).toBe(true); env.gateway.close()
  expect(await outcome).toContain('download aborted'); expect(observedSignal?.aborted).toBe(true); expect(env.epoch.signal.aborted).toBe(false)
  expect(env.files.size).toBe(0); await expect(env.gateway.capture('work-synthetic')).rejects.toThrow('已关闭')
})

test('actual main request transport honors the private owner abort signal independently of the engine', async () => {
  const env = setup(false), owned = new AbortController(), originalSnapshot = engineHost.getSnapshot, originalHeaders = engineHost.prepareRequestHeaders
  const baseUrl = Object.getOwnPropertyDescriptor(engineHost, 'baseUrl'), previousFetch = globalThis.fetch
  let requested = false, observedSignal: AbortSignal | undefined
  engineHost.getSnapshot = () => env.snapshot
  engineHost.prepareRequestHeaders = async () => ({})
  Object.defineProperty(engineHost, 'baseUrl', { configurable: true, get: () => env.snapshot.baseUrl })
  globalThis.fetch = async (_input, options) => {
    requested = true; observedSignal = options?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => { observedSignal?.addEventListener('abort', () => reject(new Error('synthetic private request aborted')), { once: true }) })
  }
  try {
    const pending = engineRequest({ method: 'GET', path: '/chat/admission/context', query: { sessionId: 'work-synthetic' }, expectedEngine: env.snapshot, toolProfile: 'general', subagentProtocol: 2 }, owned.signal)
    const outcome = pending.then(() => 'unexpected response', error => error instanceof Error ? error.message : 'error')
    await expect.poll(() => requested).toBe(true); owned.abort()
    expect(await outcome).toContain('private request aborted'); expect(observedSignal?.aborted).toBe(true); expect(engineHost.requestSignal.aborted).toBe(false)
  } finally {
    owned.abort(); globalThis.fetch = previousFetch; engineHost.getSnapshot = originalSnapshot; engineHost.prepareRequestHeaders = originalHeaders
    if (baseUrl) Object.defineProperty(engineHost, 'baseUrl', baseUrl); else Reflect.deleteProperty(engineHost, 'baseUrl')
  }
})
