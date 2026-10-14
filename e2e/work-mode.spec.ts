/** Real Electron + authenticated HTTP fixture: Work/Code lifecycle isolation,
 * persisted drafts and task history, actual SSE send/cancel/error paths, and
 * shared themed selectors/composers, Work context usage, message alignment and
 * narrow-window/motion behavior.
 * The provider is controlled; the IPC,
 * engine host, streaming decoder, React tree and native window stay real. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload, EngineFileChange } from '../src/shared/ipc'
import type { AgentCollaborator, SubagentRun, SubagentRunView, SubagentDiscoveryRef, SubagentDiscoveryPage } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { AetherIdeApi } from '../src/preload'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

let health: ElectronHealthMonitor | undefined

declare global {
  interface Window {
    aether: AetherIdeApi
  }
}

const root = resolve(__dirname, '..'),
  fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-mode-fixture-token',
  modelId = 'work-mode-fixture-model',
  alternateModelId = 'work-mode-alternate-model',
  alternateModelRecordId = 'work-mode-alternate-record'
const sessions = new Map<string, FixtureSession>()
const chatRequests: Array<{
  sessionId: string
  message: string
  model?: string
  hasModelOverride: boolean
  agentId?: string
  collaborators?: AgentCollaborator[]
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
  thinkingMode?: unknown
  memoryScope?: unknown
  workspacePaths?: string[]
  toolProfile?: string
  runLifetime?: string
  attachments?: Array<{ name: string; type?: string }>
}> = []
const profileRequests: Array<{ path: string; profile: string }> = []
const toolResponses: Array<{
  sessionId: string
  runId: string
  toolResponse: Record<string, unknown>
}> = []
const cancellations: string[] = [],
  errors: string[] = []
const fixtureAgents = new Map<string, Record<string, unknown>>()
const fixtureSubagents = new Map<string, SubagentRun>()
let modernDiscovery = false, modernRevision = 1000
const modernRuns = new Map<string, SubagentRunView>()
const modernChanges: SubagentDiscoveryRef[] = []
const modernReads: Array<{ method: string; path: string; query: Record<string, string> }> = []
const modernCancels: Array<{ runId: string; query: Record<string, string> }> = []
function modernRef(run: SubagentRunView, revision: number, deleted = false): SubagentDiscoveryRef {
  return { runId: run.runId, tenantId: run.tenantId, parentSessionId: run.parentSessionId, rootSessionId: run.rootSessionId,
    parentConversationId: run.parentConversationId, parentMessageId: run.parentMessageId, parentToolCallId: run.parentToolCallId,
    childSessionId: run.childSessionId, modelId: run.modelId, createdAt: run.createdAt, status: run.status,
    agentId: run.agentId, agentName: run.agentName,
    revision, createdRevision: run.runId.endsWith('75') ? 1001 : 1003, runSeq: run.lastSeq, deleted }
}
const fixtureTranscripts = new Map<string, EngineHistoryRow[]>()
let failNextTranscript = false
const fixtureSkills = [
  { id: 'skill-review', name: '代码审查技能', description: '检查实现与测试', enabled: true },
  { id: 'skill-docs', name: '文档技能', description: '整理技术文档', enabled: true }
]
const fixtureMcpServers = [
  { id: 'mcp-git', name: 'Git 服务', description: '访问 Git 仓库', enabled: true },
  { id: 'mcp-search', name: '搜索服务', description: '查询外部资料', enabled: true }
]
const fixtureKnowledgeBases = [
  {
    id: 'kb-product',
    name: '产品知识库',
    description: '产品规范与设计资料',
    documentCount: 4,
    createdAt: Date.now()
  }
]
const fixtureTools = [
  { name: 'read_file', displayName: '读取文件', description: '读取工作区文件' },
  { name: 'write_file', displayName: '写入文件', description: '写入工作区文件' },
  { name: 'run_command', displayName: '运行命令', description: '执行受控命令' }
]
let skillCatalogueDenied = false
let skillCatalogueReads = 0
let holdNextSkillCatalogue = false
const heldSkillCatalogues: ServerResponse[] = []
let hideFixtureModels = false
let failNextAgentSave = false
let failNextAgentCatalogue = false
let agentCatalogueReads = 0
let extraFixtureTools: typeof fixtureTools = []
let holdNextWorkSnapshot = false
const heldWorkSnapshots: Array<{ id: string; response: ServerResponse }> = []
const memoryScopes = new Map<string, string>()
const securityModes = new Map<string, string>()
const utilityRequests: Array<{ body: Record<string, unknown>; response: ServerResponse }> = []
const sourceFiles = new Map<string, { bytes: Buffer; type: string; name: string; truncated?: boolean; tooLarge?: boolean }>()
const sessionRoots = new Map<string, string>()
const sourceWrites: Array<{ sessionId: string; path: string; content: string }> = []
const sourceReads: Array<{ sessionId: string; path: string }> = []
const sourceDeletes: Array<{ sessionId: string; path: string }> = []
let failNextSourcePath: string | null = null
let holdNextSourcePath: string | null = null
const heldSourceReads: Array<{ sessionId: string; path: string; response: ServerResponse }> = []
let fixture = '',
  app: ElectronApplication | undefined,
  page: Page,
  runCount = 0,
  failedWorkSnapshots = 0,
  failedWorkSnapshotCode = 503,
  failedWorkSnapshotReads = 0

interface FixtureSession {
  run?: RootRun
  history: EngineHistoryRow[]
  projection: ChatSsePayload[]
  response?: ServerResponse
  sequence: number
  content: string
}

function session(id: string): FixtureSession {
  let value = sessions.get(id)
  if (!value) {
    value = { history: [], projection: [], sequence: 0, content: '' }
    sessions.set(id, value)
  }
  return value
}

function frame(id: string, payload: ChatSsePayload & { error?: string }): void {
  const value = session(id)
  if (!value.response || value.response.writableEnded || !value.run)
    throw new Error(`Missing open Work stream: ${id}`)
  if (typeof payload.content === 'string') value.content += payload.content
  if (payload.subagentEvent) fixtureSubagents.set(payload.subagentEvent.runId, structuredClone(payload.subagentEvent.snapshot))
  value.projection.push(structuredClone(payload))
  value.response.write(
    `id: ${value.run.runId}:${++value.sequence}\ndata: ${JSON.stringify(payload)}\n\n`
  )
}

function finish(id: string, status: 'succeeded' | 'cancelled' | 'failed' = 'succeeded'): void {
  const value = session(id)
  if (!value.run) throw new Error(`Missing Work run: ${id}`)
  value.run = {
    ...value.run,
    status,
    seq: value.sequence + 1,
    version: value.run.version + 1,
    updatedAt: Date.now(),
    finishedAt: Date.now(),
    ...(status === 'failed' ? { error: 'WORK_PROVIDER_FAILED：模型暂时不可用' } : {})
  }
  value.history.push({
    id: value.run.assistantMessageId,
    role: 'assistant',
    content: value.content,
    conversationId: value.run.turnId,
    createdAt: Date.now(),
    modelId,
    // Switching tasks rehydrates from history; the fixture must retain the
    // same confirmed usage that its SSE stream delivered to the client.
    usage: value.projection.filter((payload) => payload.usage).at(-1)?.usage
  })
  if (value.response && !value.response.writableEnded && !value.response.destroyed) {
    if (status === 'failed') frame(id, { error: 'WORK_PROVIDER_FAILED：模型暂时不可用' })
    frame(id, { run: value.run })
    value.response.end('data: [DONE]\n\n')
  }
  value.projection = []
}

const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function sourceContent(sessionId: string, path: string): { content: string; isBinary: boolean; totalSize: number; truncated?: boolean; tooLarge?: boolean } {
  const stored = sourceFiles.get(`${sessionId}:${path}`)
  if (!stored) throw new Error(`Missing synthetic source ${sessionId}:${path}`)
  const isBinary = stored.type.startsWith('image/')
  return { content: stored.bytes.toString(isBinary ? 'base64' : 'utf8'), isBinary, totalSize: stored.bytes.length, truncated: stored.truncated, tooLarge: stored.tooLarge }
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
      path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 401, message: 'Invalid fixture token' }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    if (path === '/api/v1/workspace/upload' && request.method === 'POST') {
      const form = await new Response(Uint8Array.from(bytes), { headers: { 'content-type': String(request.headers['content-type']) } }).formData()
      const sessionId = String(form.get('sessionId') ?? ''), relative = String(form.get('path') ?? ''), file = form.get('file')
      if (!sessionId || !relative || !file || typeof file === 'string') throw new Error('Invalid synthetic multipart source')
      sourceFiles.set(`${sessionId}:${relative}`, { bytes: Buffer.from(await file.arrayBuffer()), type: file.type, name: file.name })
      response.writeHead(200, { 'content-type': 'application/json' }).end(envelope({ uploaded: true }))
      return
    }
    const raw = bytes.toString('utf8')
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    profileRequests.push({ path, profile: String(request.headers['x-aether-tool-profile'] ?? '') })
    if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
      const sessionId = url.searchParams.get('sessionId') ?? '', relative = url.searchParams.get('path') ?? ''
      const stored = sourceFiles.get(`${sessionId}:${relative}`)
      response.setHeader('content-type', 'application/json')
      if (!stored) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '资料不存在' })); return }
      if (path.endsWith('/info')) { response.end(envelope({ workspacePath: `${sessionRoots.get(sessionId) ?? '/remote/work-mode-fixture'}/${relative}`, size: stored.bytes.length, isDirectory: false, mtimeMs: 1 })); return }
      sourceReads.push({ sessionId, path: relative })
      if (failNextSourcePath === relative) {
        failNextSourcePath = null
        response.writeHead(503).end(JSON.stringify({ code: 503, message: 'SOURCE_PREVIEW_RETRY：资料读取暂时失败' }))
        return
      }
      if (holdNextSourcePath === relative) {
        holdNextSourcePath = null
        heldSourceReads.push({ sessionId, path: relative, response })
        return
      }
      response.end(envelope(sourceContent(sessionId, relative)))
      return
    }
    if (path === '/api/v1/workspace/file' && request.method === 'DELETE') {
      sourceDeletes.push({ sessionId: String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), path: String(body.path ?? url.searchParams.get('path') ?? '') })
      response.end(envelope({ deleted: true }))
      return
    }
    if (path === '/api/v1/workspace/file' && request.method === 'POST') {
      const sessionId = String(body.sessionId ?? ''), relative = String(body.path ?? ''), content = String(body.content ?? '')
      if (!sessionId || !relative || relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid synthetic session write')
      sourceWrites.push({ sessionId, path: relative, content })
      sourceFiles.set(`${sessionId}:${relative}`, { bytes: Buffer.from(content), name: basename(relative), type: 'text/plain' })
      response.end(envelope({ written: true }))
      return
    }
    if (modernDiscovery && path.startsWith('/api/v1/subagent/')) {
      modernReads.push({ method: request.method ?? '', path, query: Object.fromEntries(url.searchParams) })
      response.setHeader('content-type', 'application/json')
      if (path === '/api/v1/subagent/capabilities') {
        response.end(envelope({ schemaVersion: 2, eventVersions: [2], views: ['summary'], toolPagination: true,
          eventPagination: true, detailChunks: true, exactWatermarks: true, activeDiscovery: true,
          lifecycleChanges: true, discoveryProtocol: 1 }))
      } else if (path === '/api/v1/subagent/discovery') {
        const parent = url.searchParams.get('parentSessionId') ?? '', mode = url.searchParams.get('mode') === 'changes' ? 'changes' : 'active'
        const active = [...modernRuns.values()].filter(run => run.parentSessionId === parent && ['queued', 'running', 'waiting', 'cancelling'].includes(run.status))
        const after = Number(url.searchParams.get('afterRevision') ?? '0')
        const items = mode === 'active' ? active.map(run => modernRef(run, modernRevision))
          : modernChanges.filter(item => item.parentSessionId === parent && item.revision > after)
        const scope = { tenantId: 'fixture', parentSessionId: parent,
          ...(url.searchParams.has('rootSessionId') ? { rootSessionId: url.searchParams.get('rootSessionId')! } : {}),
          ...(url.searchParams.has('parentConversationId') ? { parentConversationId: url.searchParams.get('parentConversationId')! } : {}) }
        const data: SubagentDiscoveryPage = { protocolVersion: 1, source: 'durable-lifecycle', generation: 'window-discovery-G1',
          scope, mode, asOfRevision: modernRevision, floorRevision: 1,
          ...(mode === 'changes' ? { nextRevision: modernRevision } : {}), activeCount: active.length,
          includedCount: items.length, scannedCount: items.length, membershipCompleteness: 'complete',
          hasMore: false, nextCursor: null, items }
        response.end(envelope(data))
      } else {
        const segments = path.split('/'), run = modernRuns.get(decodeURIComponent(segments[5] ?? ''))
        if (run && segments[6] === 'cancel' && request.method === 'POST') {
          modernCancels.push({ runId: run.runId, query: Object.fromEntries(url.searchParams) })
          const cancelling: SubagentRunView = { ...run, status: 'cancelling', lastSeq: run.lastSeq + 1,
            updatedAt: Date.now(), coverage: { ...run.coverage, asOfSeq: run.lastSeq + 1 } }
          modernRuns.set(run.runId, cancelling)
          modernChanges.push(modernRef(cancelling, ++modernRevision))
          response.end(envelope(cancelling))
        } else if (run) response.end(envelope(run))
        else if (path === '/api/v1/subagent/runs') throw new Error('Modern discovery must not crawl the ordinary directory to find a child')
        else response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Missing exact modern run' }))
      }
      return
    }
    // The ordinary fixture emits legacy events; only the explicit modern test opts in.
    if (path === '/api/v1/subagent/capabilities' || path === '/api/v1/cron/capabilities') {
      response.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 404, message: 'Capability is not implemented by this legacy fixture' }))
      return
    }
    if (path === '/api/v1/models' && request.method === 'GET' && hideFixtureModels) {
      response.setHeader('content-type', 'application/json')
      response.end(envelope([]))
      return
    }
    if (path === '/api/v1/utility/chat') {
      utilityRequests.push({ body, response })
      return
    }
    if (path === '/api/v1/subagent/runs' || path.startsWith('/api/v1/subagent/runs/')) {
      const segments = path.split('/')
      const child = fixtureSubagents.get(decodeURIComponent(segments[5] ?? ''))
      response.setHeader('content-type', 'application/json')
      if (path === '/api/v1/subagent/runs') response.end(envelope([...fixtureSubagents.values()].filter(run => run.parentSessionId === url.searchParams.get('parentSessionId'))))
      else if (child && segments[6] === 'cancel' && request.method === 'POST') {
        const stopped: SubagentRun = { ...child, status: 'cancelled', lastSeq: child.lastSeq + 1, updatedAt: Date.now(), finishedAt: Date.now(), stopReason: 'user_cancelled' }
        fixtureSubagents.set(child.runId, stopped)
        response.end(envelope(stopped))
      } else if (child) response.end(envelope(child))
      else response.writeHead(404).end(JSON.stringify({ code: 404, message: '没有该子代理记录', data: null }))
      return
    }
    if (path === '/api/v1/conversation/archive') {
      response.setHeader('content-type', 'application/json')
      if (failNextTranscript) {
        failNextTranscript = false
        response.writeHead(503).end(JSON.stringify({ code: 50001, data: null, message: 'TRANSCRIPT_RETRY：暂时无法读取子代理记录' }))
        return
      }
      const rows = fixtureTranscripts.get(url.searchParams.get('sessionId') ?? '') ?? []
      const current = Number(url.searchParams.get('current') ?? '1'), pageSize = Number(url.searchParams.get('pageSize') ?? '50')
      response.end(JSON.stringify({ code: 200, data: rows.slice((current - 1) * pageSize, current * pageSize),
        pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) },
        metadata: { archiveMessageCount: rows.length, archiveRevision: `transcript-${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`, backend: 'jsonl', compressed: false }
      }))
      return
    }
    if (path === '/api/v1/memory/settings' || path === '/api/v1/security/mode') {
      const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
      const memory = path.includes('/memory/')
      if (request.method === 'PUT')
        (memory ? memoryScopes : securityModes).set(
          id,
          String(memory ? body.memoryScope : body.mode)
        )
      response.setHeader('content-type', 'application/json')
      response.end(
        envelope(
          memory
            ? {
                sessionId: id,
                memoryScope: memoryScopes.get(id) ?? 'session',
                effectiveScope: memoryScopes.get(id) ?? 'session',
                enabled: true
              }
            : { sessionId: id, mode: securityModes.get(id) ?? 'safe' }
        )
      )
      return
    }
    if (path === '/api/v1/skills' && request.method === 'GET') {
      skillCatalogueReads += 1
      response.setHeader('content-type', 'application/json')
      if (holdNextSkillCatalogue) {
        holdNextSkillCatalogue = false
        heldSkillCatalogues.push(response)
        return
      }
      if (skillCatalogueDenied) {
        response.writeHead(403).end(
          JSON.stringify({
            code: 41015,
            message: '权限不足：需要以下角色之一 [admin, skill-manager]'
          })
        )
        return
      }
      response.end(envelope({ list: fixtureSkills }))
      return
    }
    if (path === '/api/v1/mcp/servers' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope(fixtureMcpServers))
      return
    }
    if (path === '/api/v1/knowledge/bases' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope(fixtureKnowledgeBases))
      return
    }
    if ((path === '/api/v1/system-tools' || path === '/api/v1/tools') && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope([...fixtureTools, ...extraFixtureTools]))
      return
    }
    if (path === '/api/v1/agents' || path.startsWith('/api/v1/agents/')) {
      response.setHeader('content-type', 'application/json')
      if (path === '/api/v1/agents' && request.method === 'GET') {
        agentCatalogueReads += 1
        if (failNextAgentCatalogue) {
          failNextAgentCatalogue = false
          response.writeHead(503).end(JSON.stringify({ code: 503, message: 'AGENT_CATALOGUE_RETRY：目录暂不可用，请重试' }))
          return
        }
      }
      if (failNextAgentSave && (request.method === 'POST' || request.method === 'PUT')) {
        failNextAgentSave = false
        response
          .writeHead(503)
          .end(JSON.stringify({ code: 503, message: 'AGENT_SAVE_RETRY：保存暂时不可用，请重试' }))
        return
      }
      const id =
        path === '/api/v1/agents' ? null : decodeURIComponent(path.slice('/api/v1/agents/'.length))
      if (request.method === 'POST') {
        const created = {
          ...body,
          id: `fixture-agent-${fixtureAgents.size + 1}`,
          ...(body.allowedTools === undefined ? { allowedTools: [] } : {}),
          ...(body.skills === undefined ? { skills: [] } : {})
        }
        fixtureAgents.set(created.id, created)
        response.end(envelope(created))
      } else if (request.method === 'PUT' && id) {
        fixtureAgents.set(id, { ...fixtureAgents.get(id), ...body })
        response.end(envelope(fixtureAgents.get(id)))
      } else if (request.method === 'DELETE' && id) {
        fixtureAgents.delete(id)
        response.end(envelope({ id }))
      } else response.end(envelope(id ? fixtureAgents.get(id) : [...fixtureAgents.values()]))
      return
    }
    if (path === '/api/v1/chat/admission/context' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? '', current = sessions.get(sessionId)?.run ?? null
      const root = current ? { ...current, attemptId: 'fixture-attempt-' + current.runId } : null
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ protocolVersion: 1, tenantId: 'work-fixture', sessionId,
        namespace: { id: 'work-fixture-db', generation: 'generation-one' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root,
        predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null }))
      return
    }
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const id = String(body.sessionId ?? ''),
        value = session(id)
      const ownerProfile = String(request.headers['x-aether-tool-profile'] ?? '')
      // Shared composer contracts submit Code requests too. Each still has to
      // address its own session, even after switching the active surface.
      if (!['code', 'general'].includes(ownerProfile) || !id || (ownerProfile === 'general') !== id.startsWith('work-'))
        throw new Error(`Profile ${ownerProfile} wrote to the wrong session: ${id}`)
      if (body.toolResponse && typeof body.toolResponse === 'object') {
        if (!value.run || value.run.status !== 'waiting')
          throw new Error('No waiting Work request to answer')
        const answer = body.toolResponse as Record<string, unknown>
        toolResponses.push({ sessionId: id, runId: String(body.runId), toolResponse: answer })
        value.response = response
        value.run = {
          ...value.run,
          status: 'running',
          version: value.run.version + 1,
          updatedAt: Date.now(),
          pending: value.run.pending.map((item) =>
            item.requestId === answer.requestId
              ? { ...item, status: 'answered', output: String(answer.output) }
              : item
          )
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        frame(id, { run: value.run })
        return
      }
      chatRequests.push({
        sessionId: id,
        message: String(body.message ?? ''),
        model: typeof body.model === 'string' ? body.model : undefined,
        hasModelOverride: Object.hasOwn(body, 'model'),
        agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
        collaborators: Array.isArray(body.collaborators) ? body.collaborators as AgentCollaborator[] : undefined,
        skills: Array.isArray(body.skills) ? (body.skills as string[]) : undefined,
        mcpServers: Array.isArray(body.mcpServers) ? (body.mcpServers as string[]) : undefined,
        knowledgeBases: Array.isArray(body.knowledgeBases)
          ? (body.knowledgeBases as string[])
          : undefined,
        allowedTools: Array.isArray(body.allowedTools)
          ? (body.allowedTools as string[])
          : undefined,
        thinkingMode: body.thinkingMode,
        memoryScope: body.memoryScope,
        toolProfile: String(request.headers['x-aether-tool-profile'] ?? ''),
        runLifetime: String(request.headers['x-aether-run-lifetime'] ?? ''),
        attachments: Array.isArray(body.attachments) ? body.attachments as Array<{ name: string; type?: string }> : undefined,
        workspacePaths: Array.isArray(body.workspacePaths)
          ? (body.workspacePaths as string[])
          : undefined
      })
      runCount += 1
      value.sequence = 0
      value.content = ''
      value.projection = []
      value.response = response
      value.run = {
        schemaVersion: 1,
        runId: `work-fixture-run-${runCount}`,
        sessionId: id,
        turnId: `work-fixture-turn-${runCount}`,
        userMessageId: `work-fixture-user-${runCount}`,
        assistantMessageId: `work-fixture-assistant-${runCount}`,
        seq: 1,
        version: 1,
        status: 'running',
        modelId,
        pending: [],
        workspacePaths: Array.isArray(body.workspacePaths) ? (body.workspacePaths as string[]) : [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      const user: EngineHistoryRow = {
        id: value.run.userMessageId,
        role: 'user',
        content: String(body.message ?? ''),
        conversationId: value.run.turnId,
        createdAt: Date.now(),
        ...(Array.isArray(body.attachments) ? { metadata: { attachments: body.attachments.map((item: { name: string; type?: string; size?: number }) => ({ name: item.name, type: item.type, size: item.size })) } } : {})
      }
      value.history.push(user)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(id, { run: value.run })
      frame(id, { userMessage: user })
      return
    }
    if (path === '/api/v1/chat/stream') {
      const value = session(url.searchParams.get('sessionId') ?? '')
      value.response = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      return
    }
    if (path === '/api/v1/chat/cancel' && request.method === 'POST') {
      const id = String(body.sessionId ?? '')
      cancellations.push(id)
      finish(id, 'cancelled')
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(envelope({ cancelled: true, sessionId: id }))
      return
    }
    if (
      path === '/api/v1/chat/snapshot' &&
      url.searchParams.get('sessionId')?.startsWith('work-') &&
      holdNextWorkSnapshot
    ) {
      holdNextWorkSnapshot = false
      heldWorkSnapshots.push({ id: url.searchParams.get('sessionId')!, response })
      return
    }
    if (
      path === '/api/v1/chat/snapshot' &&
      url.searchParams.get('sessionId')?.startsWith('work-') &&
      failedWorkSnapshots > 0
    ) {
      failedWorkSnapshots -= 1
      failedWorkSnapshotReads += 1
      response
        .writeHead(failedWorkSnapshotCode, { 'content-type': 'application/json' })
        .end(JSON.stringify({
          code: failedWorkSnapshotCode,
          message: failedWorkSnapshotCode === 403 ? 'WORK_HISTORY_FORBIDDEN：请修复历史访问授权后重新加载' : 'WORK_HISTORY_UNAVAILABLE：暂时无法读取历史'
        }))
      return
    }
    response.setHeader('content-type', 'application/json')
    const id = url.searchParams.get('sessionId') ?? '',
      value = session(id)
    const data =
      path === '/health'
        ? { status: 'ok' }
        : path === '/meta'
          ? {
              version: '2.0.0',
              buildId: `sha256:${'f'.repeat(64)}`,
              protocolVersion: 1,
              toolProfiles: ['general', 'code'],
              subagentSchemaVersion: 1,
              instanceId: 'work-mode-fixture'
            }
          : path === '/api/v1/models'
            ? [
                {
                  id: modelId,
                  modelId,
                  provider: 'openai',
                  displayName: 'Work fixture model',
                  isEnabled: true,
                  capabilities: { toolCalling: true, contextWindow: 128000 }
                },
                {
                  id: alternateModelRecordId,
                  modelId: alternateModelId,
                  provider: 'openai',
                  displayName: 'Work alternate model',
                  isEnabled: true,
                  capabilities: { toolCalling: true, contextWindow: 128000 }
                }
              ]
            : path === '/api/v1/conversation/sessions'
              ? [...sessions.entries()]
                  .filter(([, item]) => item.history.length)
                  .map(([sessionId, item]) => ({
                    sessionId,
                    title: item.history[0]?.content ?? '',
                    lastAt: Date.now(),
                    messageCount: item.history.length
                  }))
              : path === '/api/v1/chat/snapshot'
                ? {
                    schemaVersion: 1,
                    sessionId: id,
                    source: value.run?.status === 'running' ? 'live' : 'persisted',
                    eventId: value.run ? `${value.run.runId}:${value.sequence}` : null,
                    finished: value.run?.status !== 'running',
                    projection: value.projection,
                    history: value.history,
                    run: value.run,
                    runs: value.run ? [value.run] : [],
                    todos: [],
                    changes: [],
                    commandJobs: [],
                    subagentRuns: [...fixtureSubagents.values()].filter(run => run.parentSessionId === id)
                  }
                : path === '/api/v1/chat/status'
                  ? {
                      running: value.run?.status === 'running',
                      finished: Boolean(value.run && value.run.status !== 'running'),
                      run: value.run,
                      lastEventId: value.run ? `${value.run.runId}:${value.sequence}` : null
                    }
                  : path === '/api/v1/chat/runs'
                    ? { runs: value.run ? [value.run] : [] }
                    : path === '/api/v1/workspace/directory'
                      ? { root: sessionRoots.get(id) ?? '/remote/work-mode-fixture', entries: [] }
                      : path === '/api/v1/workspace/bind'
                        ? { workspaceRoot: '/remote/work-mode-fixture' }
                        : []
    response.end(envelope(data))
  })().catch((error) => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })


})

const work = () => page.locator('.work-view')
const runStatus = () => work().locator('[data-current-run-feedback="true"]')
const workMode = () => page.getByRole('tab', { name: 'Work 办公', exact: true })
const codeMode = () => page.getByRole('tab', { name: 'Code 开发', exact: true })
async function switchTo(mode: 'code' | 'work'): Promise<void> {
  await (mode === 'work' ? workMode() : codeMode()).click()
  await expect(page.locator(`.mode-surface[data-mode="${mode}"]`)).toBeVisible()
  await expect(
    page.locator(`.mode-surface[data-mode="${mode === 'work' ? 'code' : 'work'}"]`)
  ).toBeHidden()
}
async function startTask(prompt: string): Promise<string> {
  await switchTo('work')
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const previous = chatRequests.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => chatRequests.length).toBe(previous + 1)
  return chatRequests[previous].sessionId
}

async function selectWorkTask(title: string): Promise<void> {
  const item = work().locator('.work-sidebar__task', { hasText: title })
  // Compact windows keep recent tasks in a navigation drawer. Open the actual
  // user-facing drawer instead of trying to click its hidden task buttons.
  if (!await item.isVisible()) {
    await work().getByRole('button', { name: '展开 Work 导航', exact: true }).click()
  }
  await expect(item).toBeVisible()
  await item.click()
  await expect(work().locator('.work-navigation-scrim')).toHaveCount(0)
  await expect(work().locator('.work-task-heading h1')).toContainText(title)
}

function agentCreateEntry(surface: 'page' | 'dialog') {
  // The empty state also offers creation; exercise each surface's primary entry explicitly.
  const toolbar = surface === 'page'
    ? work().locator('.work-agent-manager-page__header')
    : page.getByRole('dialog', { name: '自定义 Agent', exact: true }).locator('.work-agent-manager__toolbar')
  return toolbar.getByRole('button', { name: '新建 Agent', exact: true })
}

async function taskHeadingAction(name: '重命名任务' | '归档任务' | '继续任务'): Promise<void> {
  await work().locator('.work-task-heading').getByRole('button', { name: '任务更多操作', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '任务更多操作', exact: true }).getByRole('menu')
  await menu.getByRole('menuitem', { name, exact: true }).click()
}

test.describe.serial('Work 模式', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing Work fixture port')
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-mode-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({
        engineMode: 'remote',
        remoteBaseUrl: `http://127.0.0.1:${address.port}`,
        autoStartEngine: true,
        remoteWorkspaceRoot: '/remote/code-project',
        lastSessionId: '',
        lastModelId: modelId,
        thinkingMode: 'off',
        appearance: 'dark',
        lastFolder: ''
      })
    )
    // Delay only the IPC completion in one regression. SSE, cancellation and
    // durable snapshots still use the real bridge and authenticated fixture.
    const entry = process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js')
    const bootstrap = join(fixture, 'stream-completion-bootstrap.cjs')
    writeFileSync(bootstrap, `
      const { ipcMain } = require('electron');
      const original = ipcMain.handle.bind(ipcMain);
      const control = globalThis.workStreamCompletions = { hold: false, waiting: new Map() };
      ipcMain.handle = (channel, handler) => original(channel, async (event, input, ...rest) => {
        const result = await handler(event, input, ...rest);
        if (channel === 'engine:stream:start' && input?.path === '/chat' && control.hold) {
          await new Promise(resolve => control.waiting.set(input.streamId, { sessionId: input.body?.sessionId, resolve }));
        }
        return result;
      });
      require(${JSON.stringify(entry)});
    `)
    app = await electron.launch({
      // A built snapshot avoids losing renderer files during another chat's rebuild.
      args: [bootstrap, `--user-data-dir=${fixture}`],
      cwd: root,
      env: {
        ...process.env,
        AETHER_IDE_REMOTE_INSTANCE_TOKEN: token,
        AETHER_GLOBAL_DIR: join(fixture, 'global')
      }
    })
    health = await monitorElectronHealth(app, 'work-mode', [token])
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await expect(codeMode()).toHaveAttribute('aria-selected', 'true')
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, testInfo) => {
    for (const value of sessions.values()) value.response?.destroy()
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      if (fixture) {
        const absolute = resolve(fixture)
        if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('work-mode-'))
          throw new Error(`Unsafe Work fixture cleanup: ${absolute}`)
        rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('左上切换保留 Code DOM、草稿和原有布局，隐藏层不能聚焦', async ({}, testInfo) => {
    const codeInput = page.locator('.mode-surface[data-mode="code"] .chat__input')
    await expect(codeInput).toBeVisible()
    await codeInput.fill('CODE_DRAFT_SHOULD_SURVIVE')
    await page.locator('.mode-surface[data-mode="code"] .workbench__body').evaluate((element) => {
      ;(window as Window & { workCodeNode?: Element }).workCodeNode = element
    })
    const before = await page.evaluate(() => localStorage.getItem('aether.ide.layout'))
    await switchTo('work')
    await expect(page.locator('.mode-surface[data-mode="code"]')).toHaveAttribute('inert', '')
    await work()
      .getByRole('textbox', { name: '任务目标', exact: true })
      .fill('WORK_DRAFT_SHOULD_SURVIVE')
    await switchTo('code')
    await expect(codeInput).toContainText('CODE_DRAFT_SHOULD_SURVIVE')
    expect(
      await page.evaluate(
        () =>
          (window as Window & { workCodeNode?: Element }).workCodeNode ===
          document.querySelector('.mode-surface[data-mode="code"] .workbench__body')
      )
    ).toBe(true)
    expect(await page.evaluate(() => localStorage.getItem('aether.ide.layout'))).toBe(before)
    await switchTo('work')
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toHaveText(
      'WORK_DRAFT_SHOULD_SURVIVE'
    )
    await page.reload()
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toHaveText(
      'WORK_DRAFT_SHOULD_SURVIVE'
    )
    await page.screenshot({
      path: testInfo.outputPath('work-home-1440.png'),
      animations: 'disabled'
    })
    await expect(page.locator('.mode-surface[data-mode="work"]')).toHaveCSS('opacity', '1')
  })

  test('真实任务流使用独立会话，切换模式不中断，完成后刷新可回放', async ({}, testInfo) => {
    const codeSelection = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId'))
      )
    )
    const id = await startTask('WORK_SUCCESS：整理客户反馈并给出有序结论')
    expect(chatRequests.at(-1)).toMatchObject({
      sessionId: id,
      message: 'WORK_SUCCESS：整理客户反馈并给出有序结论',
      model: modelId,
      toolProfile: 'general',
      runLifetime: 'durable'
    })
    expect(chatRequests.at(-1)?.workspacePaths).toEqual([])
    await expect(runStatus()).toBeVisible()
    await expect(runStatus()).toHaveAttribute('data-state', 'running')
    const feedback = work().locator('.work-turn-feedback')
    await expect(feedback).toBeVisible()
    await expect(feedback).toHaveAttribute('data-phase', 'processing')
    await expect(feedback).toContainText('等待 Agent 响应')
    await page.screenshot({
      path: testInfo.outputPath('work-first-response-feedback.png'),
      animations: 'disabled'
    })
    const elapsed = runStatus().locator('.work-run-status__elapsed, .work-turn-feedback__elapsed')
    await expect(elapsed).toHaveText(/^(?:\d+ 分 )?\d+ 秒$/)
    const initialElapsed = await elapsed.textContent()
    await expect(elapsed).not.toHaveText(initialElapsed!, { timeout: 5_000 })
    await expect(feedback.locator('.work-turn-feedback__elapsed')).not.toHaveText('0 秒')
    frame(id, { thinking: '正在分析资料' })
    await expect(feedback).toHaveAttribute('data-phase', 'thinking')
    frame(id, { content: 'WORK_PROGRESS：已经整理第一批资料。' })
    await expect(work()).toContainText('WORK_PROGRESS')
    await expect(runStatus()).toHaveAttribute('data-phase', 'generating')
    await expect(feedback).toHaveAttribute('data-phase', 'generating')
    await expect(runStatus()).toContainText('正在生成回复')
    await expect(work().locator('.work-message__author')).toHaveCount(0)
    const alignment = await work()
      .locator('.work-conversation__content')
      .evaluate((element) => {
        const user = element.querySelector('.work-message--user .message__bubble')
        const assistant = element.querySelector('.work-message--assistant .md')
        if (!user || !assistant) throw new Error('Missing rendered Work messages')
        const container = element.getBoundingClientRect(),
          padding = getComputedStyle(element),
          left = container.left + parseFloat(padding.paddingLeft),
          right = container.right - parseFloat(padding.paddingRight),
          userRect = user.getBoundingClientRect()
        return {
          userRightGap: Math.abs(right - userRect.right),
          assistantLeftGap: Math.abs(assistant.getBoundingClientRect().left - left),
          userWidth: userRect.width,
          contentWidth: right - left
        }
      })
    expect(alignment.userRightGap).toBeLessThanOrEqual(2)
    expect(alignment.assistantLeftGap).toBeLessThanOrEqual(2)
    expect(alignment.userWidth).toBeLessThan(alignment.contentWidth)
    await switchTo('code')
    await expect(runStatus()).toBeHidden()
    expect(cancellations).toEqual([])
    frame(id, { content: '\n\nWORK_RESULT：\n1. 优化响应速度。\n2. 简化资料整理。' })
    finish(id)
    await switchTo('work')
    await expect(work()).toContainText('WORK_RESULT')
    await expect(runStatus()).toHaveCount(0)
    await expect(feedback).toHaveCount(0)
    await expect(work().getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    expect(
      await page.evaluate(() =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId'))
        )
      )
    ).toEqual(codeSelection)
    await page.reload()
    await expect(work()).toContainText('WORK_RESULT')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
  })

  test('最新消息反馈与阅读历史时的固定反馈互斥，窗口缩小和返回最新保留真实任务', async ({}, testInfo) => {
    const id = await startTask('WORK_FEEDBACK：持续执行时检查反馈位置')
    try {
      await expect(work().locator('.work-turn-feedback')).toBeVisible()
      await expect(work().locator('.work-conversation__footer .work-run-status')).toHaveCount(0)
      await expect(runStatus()).toHaveCount(1)
      frame(id, { content: Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：这是隔离的持续任务记录，用于验证阅读位置和当前执行反馈。`).join('\n\n') })
      const scroll = work().locator('.work-conversation__scroll')
      await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600)
      for (const [width, height] of [[1440, 900], [940, 680], [760, 520]]) {
        await app!.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 0); window.setContentSize(size.width, size.height) }, { width, height })
        await scroll.evaluate(el => { el.scrollTop = 0 })
        const fixed = work().locator('.work-conversation__footer .work-run-status')
        await expect(fixed).toBeVisible()
        await expect(runStatus()).toHaveCount(1)
        await expect(fixed.getByRole('status', { name: '任务运行状态', exact: true })).toHaveText('正在生成回复…')
        await expect(work().locator('.work-turn-feedback [role="status"]')).toHaveAttribute('aria-live', 'off')
        await page.screenshot({ path: testInfo.outputPath(`feedback-history-${width}-${height}.png`) })
        await work().getByRole('button', { name: '回到最新', exact: true }).click()
        await expect(fixed).toHaveCount(0)
        await expect(runStatus()).toHaveCount(1)
        await expect(work().locator('.work-turn-feedback [role="status"]')).toHaveAttribute('aria-live', 'polite')
        await expect(work().getByRole('button', { name: '停止任务', exact: true })).toBeEnabled()
        await page.screenshot({ path: testInfo.outputPath(`feedback-latest-${width}-${height}.png`) })
      }
    } finally {
      finish(id)
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    }
    await expect(runStatus()).toHaveCount(0)
  })

  test('会话准备时显示反馈，停止后迟到的历史响应不能启动任务', async () => {
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    holdNextWorkSnapshot = true
    const previous = chatRequests.length
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_PREFLIGHT_STOP')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(work().locator('.work-turn-feedback')).toHaveAttribute('data-phase', 'preparing')
    await expect.poll(() => heldWorkSnapshots.length).toBeGreaterThan(0)
    await work().getByRole('button', { name: '停止任务', exact: true }).click()
    const held = heldWorkSnapshots.shift()!
    held.response.writeHead(200, { 'content-type': 'application/json' }).end(
      envelope({
        schemaVersion: 1,
        sessionId: held.id,
        source: 'persisted',
        eventId: null,
        finished: true,
        projection: [],
        history: [],
        run: null,
        runs: [],
        todos: [],
        changes: [],
        commandJobs: []
      })
    )
    await expect(work().locator('.work-turn-feedback')).toHaveCount(0)
    await expect(work().locator('.work-loading')).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
    expect(chatRequests.length).toBe(previous)
    await page.reload()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
    expect(chatRequests.length).toBe(previous)
  })

  test('真实停止请求只取消当前 Work 任务，已停止状态刷新后保留', async () => {
    const beforeRequests = chatRequests.length, beforeCancels = cancellations.length
    const id = await startTask('WORK_STOP：整理一份尚在执行的调查')
    const otherStatuses = [...sessions.entries()].filter(([key]) => key !== id).map(([key, value]) => [key, value.run?.status])
    frame(id, { content: 'WORK_STOP_PROGRESS：任务正在处理中。' })
    await expect(work()).toContainText('WORK_STOP_PROGRESS')
    await expect(runStatus()).toBeVisible()
    const rootStop = work().getByRole('button', { name: '停止任务', exact: true })
    await expect(rootStop).toBeEnabled()
    await expect(work().locator('.input-composer').getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    // An active task offers a next-turn queue; cancellation belongs to its heading.
    await expect(work().locator('.input-composer').getByRole('button', { name: '排到下一轮', exact: true })).toBeDisabled()
    await rootStop.click()
    await expect.poll(() => cancellations).toContain(id)
    await expect(work()).toContainText('已停止')
    await expect(runStatus()).toHaveCount(0)
    await page.reload()
    await expect(work()).toContainText('WORK_STOP_PROGRESS')
    await expect(work()).toContainText('已停止')
    await expect(runStatus()).toHaveCount(0)
    expect(chatRequests.length).toBe(beforeRequests + 1)
    expect(cancellations.slice(beforeCancels)).toEqual([id])
    expect([...sessions.entries()].filter(([key]) => key !== id).map(([key, value]) => [key, value.run?.status])).toEqual(otherStatuses)
  })

  test('执行失败如实呈现，可继续输入，不伪装成完成', async () => {
    const id = await startTask('WORK_FAILURE：验证服务端失败提示')
    await expect(runStatus()).toBeVisible()
    frame(id, { content: 'WORK_BEFORE_FAILURE' })
    finish(id, 'failed')
    await expect(work()).toContainText('WORK_PROVIDER_FAILED')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeEnabled()
  })

  test('工作步骤只有一层折叠，成果可预览和引用，用户上滚时保留阅读位置', async ({}, testInfo) => {
    const id = await startTask('WORK_ARTIFACT：生成调查报告并列出步骤')
    frame(id, {
      todo: {
        todos: [
          { id: 'research', title: '核对调查来源', status: 'done', priority: 'medium' },
          { id: 'report', title: '整理调查报告', status: 'in_progress', priority: 'medium' }
        ]
      }
    })
    frame(id, {
      content: Array.from(
        { length: 28 },
        (_, index) =>
          `WORK_READING_${index + 1}：正在整理第 ${index + 1} 项事实，保持用户在工作对话中的阅读位置。`
      ).join('\n\n')
    })
    const scroll = work().locator('.work-conversation__scroll')
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight))
      // The compact process row and activity disclosure no longer add the old
      // full-width tool card height; assert real overflow without coupling the
      // reading test to a particular viewport/font rasterization.
      .toBeGreaterThan(200)
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThanOrEqual(2)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    const steps = work().locator('.work-steps')
    await expect(steps.locator('summary')).toHaveCount(1)
    await expect(steps).not.toHaveAttribute('open', '')
    await steps.locator('summary').click()
    await expect(steps.locator('li')).toHaveCount(2)
    await expect(steps.locator('li').first()).toBeVisible()
    await steps.locator('summary').click()
    await expect(steps.locator('li').first()).toBeHidden()
    await steps.locator('summary').click()
    await scroll.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(runStatus()).toBeInViewport()
    await expect(work().getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    frame(id, { content: '\n\nWORK_LATE_PROGRESS：新的调查结论。' })
    await expect(work()).toContainText('WORK_LATE_PROGRESS')
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2)
    await work().getByRole('button', { name: '回到最新', exact: true }).click()
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThanOrEqual(2)

    const change: EngineFileChange = {
      id: 'work-report-receipt',
      toolCallId: 'work-write-tool',
      path: '/remote/work-mode-fixture/report.md',
      displayPath: 'report.md',
      kind: 'write',
      oldContent: null,
      newContent: '# WORK_ARTIFACT_CONTENT\n\n1. 来源已核对。\n2. 后续行动明确。',
      isNew: true,
      truncated: false,
      status: 'kept',
      createdAt: Date.now()
    }
    frame(id, {
      toolStart: { id: 'work-write-tool', name: 'write_file', args: { path: 'report.md' } }
    })
    await expect(runStatus()).toHaveAttribute('data-phase', 'tool')
    await expect(runStatus()).toContainText('写入文件')
    frame(id, { fileChange: change })
    frame(id, {
      toolEnd: { id: 'work-write-tool', name: 'write_file', output: '文件已写入', success: true }
    })
    await expect(runStatus()).toContainText('正在生成回复')
    await work()
      .getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true })
      .click()
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_ARTIFACT_CONTENT')
    await expect(work().locator('.work-artifact-select')).toContainText('草稿')
    await page.screenshot({
      path: testInfo.outputPath('work-active-1440.png'),
      animations: 'disabled'
    })
    const sentBeforeReference = chatRequests.length
    const composer = work().getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('已有草稿保留')
    await work().getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(composer).toContainText('已有草稿保留')
    await expect(composer.locator('.mention-chip--file')).toHaveText('report.md')
    await expect(composer.locator('.mention-chip--file')).toHaveAttribute('title', /report\.md/)
    await expect(composer).not.toContainText('work-report-receipt')
    await expect(composer).not.toContainText('WORK_ARTIFACT_CONTENT')
    expect(chatRequests.length, '引用文件只补充草稿，不应直接发起模型请求').toBe(
      sentBeforeReference
    )
    frame(id, {
      toolStart: { id: 'work-summary-tool', name: 'write_file', args: { path: 'summary.md' } }
    })
    frame(id, {
      fileChange: {
        ...change,
        id: 'work-summary-receipt',
        toolCallId: 'work-summary-tool',
        path: '/remote/work-mode-fixture/summary.md',
        displayPath: 'summary.md',
        newContent: '# WORK_SECOND_ARTIFACT\n\n另一份成果的独立内容。'
      }
    })
    frame(id, {
      toolEnd: { id: 'work-summary-tool', name: 'write_file', output: '文件已写入', success: true }
    })
    const artifactSelect = work().getByRole('button', { name: '选择成果', exact: true })
    await expect(artifactSelect).toContainText('report.md')
    await artifactSelect.click()
    await page.getByRole('menuitem', { name: /^summary\.md\s/ }).click()
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_SECOND_ARTIFACT')
    await expect(work().locator('.work-artifact-preview')).not.toContainText(
      'WORK_ARTIFACT_CONTENT'
    )
    await artifactSelect.click()
    await page.getByRole('menuitem', { name: /^report\.md\s/ }).click()
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_ARTIFACT_CONTENT')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    await expect(work().locator('.work-activities__list button')).toHaveCount(2)
    await work().locator('.work-activities__list button').first().click()
    const detail = work().locator('.work-activity-detail')
    const inputArguments = detail.locator('details').filter({
      has: page.locator('summary').filter({ hasText: /^查看输入参数$/ })
    })
    await expect(detail).toContainText('文件已写入')
    await expect(inputArguments).not.toHaveAttribute('open', '')
    await inputArguments.locator('summary').click()
    await expect(detail).toContainText('report.md')
    frame(id, {
      toolStart: { id: 'work-module-tool', name: 'write_file', args: { path: 'module.mjs' } }
    })
    frame(id, {
      fileChange: {
        ...change,
        id: 'work-module-receipt',
        toolCallId: 'work-module-tool',
        path: '/remote/work-mode-fixture/module.mjs',
        displayPath: 'module.mjs',
        newContent: 'export const WORK_MODULE_RESULT = 42;\n'
      }
    })
    frame(id, {
      toolEnd: {
        id: 'work-module-tool',
        name: 'write_file',
        output: '模块文件已写入',
        success: true
      }
    })
    await work()
      .getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true })
      .click()
    await artifactSelect.click()
    await page.getByRole('menuitem', { name: /^module\.mjs\s/ }).click()
    const modulePreview = work().locator('.work-artifact-preview')
    await expect(modulePreview).toContainText('export const WORK_MODULE_RESULT = 42;')
    await expect(
      modulePreview.locator('code span.hljs-keyword', { hasText: /^export$/ })
    ).toBeVisible()
    await expect(
      modulePreview.locator('code span.hljs-keyword', { hasText: /^const$/ })
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('work-module-syntax-highlight.png'),
      animations: 'disabled'
    })
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    finish(id)
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('tab', { name: '活动', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(composer).toContainText('已有草稿保留')
    await expect(composer.locator('.mention-chip--file')).toHaveText('report.md')
  })

  test('成果读取当前版本、手动刷新、片段和历史回执都如实标记，引用保留覆盖范围', async () => {
    const id = await startTask('WORK_ARTIFACT_COVERAGE：验证成果文件版本与引用')
    const relative = 'coverage-report.md', path = `/remote/work-mode-fixture/${relative}`
    const put = (content: string, truncated = false) => sourceFiles.set(`${id}:${relative}`, { bytes: Buffer.from(content), type: 'text/markdown', name: relative, truncated })
    put('# CURRENT_FILE_VERSION')
    const change: EngineFileChange = { id: 'coverage-receipt', toolCallId: 'coverage-write', path, displayPath: relative, kind: 'write',
      oldContent: null, newContent: '# HISTORICAL_RECEIPT_VERSION', isNew: true, truncated: false, status: 'kept', createdAt: Date.now() }
    frame(id, { toolStart: { id: 'coverage-write', name: 'write_file', args: { path: relative } } })
    frame(id, { fileChange: change })
    frame(id, { toolEnd: { id: 'coverage-write', name: 'write_file', output: '文件已写入', success: true } })
    const artifactTab = work().getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true })
    if (!await artifactTab.isVisible()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await artifactTab.click()
    const panel = work().getByRole('region', { name: '成果预览', exact: true }), preview = panel.locator('.work-artifact-preview')
    const composer = work().getByRole('textbox', { name: '继续对话', exact: true }), sentBefore = chatRequests.length
    await expect(preview).toContainText('CURRENT_FILE_VERSION')
    await expect(preview).not.toContainText('HISTORICAL_RECEIPT_VERSION')
    await expect(panel.locator('.work-artifact-panel-v2__notice')).toHaveCount(0)
    put('# CURRENT_REFRESHED_VERSION')
    await panel.getByRole('button', { name: '刷新成果预览', exact: true }).click()
    await expect(preview).toContainText('CURRENT_REFRESHED_VERSION')
    put('# PARTIAL_PREVIEW_VERSION', true)
    await panel.getByRole('button', { name: '刷新成果预览', exact: true }).click()
    await expect(panel.locator('.work-artifact-panel-v2__notice')).toContainText('仅显示文件的预览片段')
    await expect(panel.getByRole('button', { name: '复制片段', exact: true })).toBeEnabled()
    await expect(panel.getByRole('button', { name: '下载片段', exact: true })).toBeEnabled()
    await composer.fill('已有覆盖范围草稿')
    await panel.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(composer.locator('.mention-chip--file')).toHaveText(relative)
    await expect(composer).toContainText('已有覆盖范围草稿')
    await expect(composer).not.toContainText('PARTIAL_PREVIEW_VERSION')
    const selectPreview = async () => preview.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await selectPreview()
    await panel.getByRole('button', { name: '引用选中内容', exact: true }).click()
    await expect(composer).toContainText('文件预览片段中的选中内容')
    await expect(composer).toContainText('PARTIAL_PREVIEW_VERSION')
    sourceFiles.delete(`${id}:${relative}`)
    await panel.getByRole('button', { name: '刷新成果预览', exact: true }).click()
    await expect(preview).toContainText('HISTORICAL_RECEIPT_VERSION')
    await expect(panel.locator('.work-artifact-panel-v2__notice')).toContainText('历史版本')
    await expect(panel.getByRole('button', { name: '复制回执', exact: true })).toBeEnabled()
    await composer.fill('历史引用草稿')
    await selectPreview()
    await panel.getByRole('button', { name: '引用选中内容', exact: true }).click()
    await expect(composer).toContainText('历史写入回执中的选中内容')
    await expect(composer).toContainText('HISTORICAL_RECEIPT_VERSION')
    expect(chatRequests.length).toBe(sentBefore)
    frame(id, { toolStart: { id: 'missing-receipt-tool', name: 'write_file', args: { path: 'unavailable.md' } } })
    frame(id, { fileChange: { ...change, id: 'missing-receipt', toolCallId: 'missing-receipt-tool', path: '/remote/work-mode-fixture/unavailable.md', newContent: null, createdAt: Date.now() + 1 } })
    frame(id, { toolEnd: { id: 'missing-receipt-tool', name: 'write_file', output: '未存档正文', success: true } })
    await work().getByRole('button', { name: '选择成果', exact: true }).click()
    await page.getByRole('menuitem', { name: /^unavailable\.md\s/ }).click()
    await expect(preview.getByRole('alert')).toContainText('资料不存在')
    await expect(panel.getByRole('button', { name: '复制', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '下载', exact: true })).toBeDisabled()
    frame(id, { toolStart: { id: 'invalid-path-tool', name: 'write_file', args: { path: '' } } })
    frame(id, { fileChange: { ...change, id: 'invalid-path-receipt', toolCallId: 'invalid-path-tool', path: '', newContent: null, createdAt: Date.now() + 2 } })
    frame(id, { toolEnd: { id: 'invalid-path-tool', name: 'write_file', output: '路径不可用', success: true } })
    // Wait until the final receipt has reached React before checking its
    // empty-path guard; a menu opened before SSE flush can still have two rows.
    frame(id, { content: 'ARTIFACT_EMPTY_PATH_DELIVERED' })
    await expect(work()).toContainText('ARTIFACT_EMPTY_PATH_DELIVERED')
    await work().getByRole('button', { name: '选择成果', exact: true }).click()
    await expect(page.getByRole('menuitem')).toHaveCount(3)
    await page.getByRole('menuitem', { name: '', exact: true }).click()
    await expect(preview.getByRole('alert')).toContainText('没有有效的文件路径')
    await expect(panel.getByRole('button', { name: '复制', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '下载', exact: true })).toBeDisabled()
    await expect(panel.locator('.work-artifact-panel-v2__loading')).toHaveCount(0)
    finish(id)
  })

  test('Work 两个 scratch 任务同名成果在编辑器读取保存独立，Code 全局选择保持原值', async () => {
    const selection = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId'))))
    async function taskWithReport(label: string, content: string): Promise<string> {
      const id = await startTask(label), root = `/remote/session-editor/${id}`
      sessionRoots.set(id, root)
      sourceFiles.set(`${id}:report.txt`, { bytes: Buffer.from(content), type: 'text/plain', name: 'report.txt' })
      frame(id, { toolStart: { id: `${id}-write`, name: 'write_file', args: { path: 'report.txt' } } })
      frame(id, { fileChange: { id: `${id}-receipt`, toolCallId: `${id}-write`, path: `${root}/report.txt`, displayPath: 'report.txt', kind: 'write', oldContent: null, newContent: 'OLD_RECEIPT_NOT_EDITOR_BYTES', truncated: false, isNew: true, status: 'kept', createdAt: Date.now() } })
      frame(id, { toolEnd: { id: `${id}-write`, name: 'write_file', output: '文件已写入', success: true } })
      finish(id)
      if (!await work().getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true }).isVisible()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
      await work().getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true }).click()
      await expect(work().locator('.work-artifact-preview')).toContainText(content)
      await work().getByRole('button', { name: '在编辑器打开', exact: true }).click()
      await switchTo('code')
      const surface = page.locator('.mode-surface[data-mode="code"]')
      await expect(surface.locator('.monaco-editor .view-lines').first()).toContainText(content)
      await expect(surface.locator('.doc-view')).not.toContainText('OLD_RECEIPT_NOT_EDITOR_BYTES')
      await surface.locator('.monaco-editor').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(`_${label}_SAVED`)
      await page.keyboard.press('Control+s')
      await expect.poll(() => sourceFiles.get(`${id}:report.txt`)?.bytes.toString()).toBe(`${content}_${label}_SAVED`)
      await expect(surface.locator('.editor-tab').filter({ hasText: 'report.txt' }).filter({ has: page.locator('.editor-tab__dirty') })).toHaveCount(0)
      await switchTo('work')
      return id
    }
    const first = await taskWithReport('WORK_EDITOR_TASK_A', 'CURRENT_A_BYTES')
    const savedA = sourceFiles.get(`${first}:report.txt`)!.bytes.toString()
    const second = await taskWithReport('WORK_EDITOR_TASK_B', 'CURRENT_B_BYTES')
    expect(sourceFiles.get(`${first}:report.txt`)!.bytes.toString()).toBe(savedA)
    expect(sourceWrites.filter(write => write.sessionId === first)).toEqual([{ sessionId: first, path: 'report.txt', content: savedA }])
    expect(sourceWrites.filter(write => write.sessionId === second)).toEqual([{ sessionId: second, path: 'report.txt', content: 'CURRENT_B_BYTES_WORK_EDITOR_TASK_B_SAVED' }])
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId'))))).toEqual(selection)
  })

  test('待补充问题可真实回答，保留原运行标识并继续完成任务', async () => {
    const id = await startTask('WORK_QUESTION：先确认报告格式再整理')
    const value = session(id),
      run = value.run!
    value.run = {
      ...run,
      status: 'waiting',
      version: run.version + 1,
      updatedAt: Date.now(),
      pending: [
        {
          requestId: 'work-format-question',
          toolCallId: 'ask-work-format',
          toolName: 'ask_user',
          kind: 'ask',
          status: 'pending',
          args: {
            question: '你希望报告采用什么格式？',
            options: [{ label: '简明结论' }, { label: '详细分析' }]
          }
        }
      ]
    }
    frame(id, { run: value.run })
    value.response!.end('data: [DONE]\n\n')
    await expect(work().locator('.work-task-heading')).toContainText('等你补充')
    await expect(runStatus()).toBeVisible()
    await expect(runStatus()).toHaveAttribute('data-state', 'waiting')
    await expect(runStatus()).toHaveAttribute('data-phase', 'waiting')
    await expect(runStatus().getByRole('status', { name: '任务运行状态', exact: true })).toHaveText(
      '等你补充'
    )
    await expect(runStatus().locator('.ui-spinner')).toHaveCount(0)
    await expect(
      work().getByRole('button', { name: 'Work 使用的模型', exact: true })
    ).toBeEnabled()
    await expect(work().getByRole('button', { name: '提交回复', exact: true })).toBeDisabled()
    await work()
      .getByRole('textbox', { name: '继续对话', exact: true })
      .fill('等待时暂存的补充要求')
    await expect(work().getByRole('button', { name: '排到下一轮', exact: true })).toBeEnabled()
    expect(chatRequests.at(-1)?.sessionId).toBe(id)
    await work().getByRole('radio', { name: '简明结论', exact: true }).check()
    await work().getByRole('button', { name: '提交回复', exact: true }).click()
    await expect.poll(() => toolResponses.length).toBe(1)
    await expect(runStatus()).toBeVisible()
    await expect(runStatus()).toHaveAttribute('data-state', 'running')
    expect(toolResponses[0]).toEqual({
      sessionId: id,
      runId: run.runId,
      toolResponse: {
        requestId: 'work-format-question',
        runId: run.runId,
        toolCallId: 'ask-work-format',
        name: 'ask_user',
        output: '简明结论'
      }
    })
    frame(id, { content: 'WORK_ANSWER_RESULT：已按简明结论整理。' })
    finish(id)
    await expect(work()).toContainText('WORK_ANSWER_RESULT')
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('button', { name: '提交回复', exact: true })).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(
      '等待时暂存的补充要求'
    )
  })

  test('历史访问被拒时保留目标且不发送，明确重新加载后只启动一次任务', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const prompt = 'WORK_HISTORY_RETRY：历史恢复完成后再运行'
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
    const before = chatRequests.length
    failedWorkSnapshots = 1
    failedWorkSnapshotCode = 403
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(work().getByRole('alert')).toContainText('WORK_HISTORY_FORBIDDEN')
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(prompt)
    expect(chatRequests.length).toBe(before)
    const retry = work().getByRole('button', { name: '重新加载', exact: true })
    await expect(retry).toBeEnabled()
    await expect(work().getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await retry.click()
    await expect.poll(() => chatRequests.length).toBe(before + 1)
    const id = chatRequests[before].sessionId
    expect(chatRequests[before].message).toBe(prompt)
    frame(id, { content: 'WORK_RECOVERED_RESULT：历史恢复后执行成功。' })
    finish(id)
    await expect(work()).toContainText('WORK_RECOVERED_RESULT')
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    expect(chatRequests.length).toBe(before + 1)
    failedWorkSnapshotCode = 503
  })

  test('历史连续503时自动恢复且保留目标，恢复成功只发送一次原始任务', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const prompt = 'WORK_HISTORY_AUTO_RETRY：连接恢复后再运行，不能重复发送'
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
    const before = chatRequests.length
    const readsBefore = failedWorkSnapshotReads
    failedWorkSnapshotCode = 503
    failedWorkSnapshots = Number.MAX_SAFE_INTEGER
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    const alert = work().getByRole('alert')
    await expect(alert).toContainText('WORK_HISTORY_UNAVAILABLE')
    await expect(alert.getByRole('status')).toHaveText('正在自动重新连接，恢复后继续任务。')
    await expect(work().getByRole('button', { name: '重新加载', exact: true })).toHaveCount(0)
    await expect.poll(() => failedWorkSnapshotReads - readsBefore).toBeGreaterThanOrEqual(3)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(prompt)
    await expect(work().getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect(chatRequests.length).toBe(before)
    failedWorkSnapshots = 0
    await expect.poll(() => chatRequests.length).toBe(before + 1)
    const id = chatRequests[before].sessionId
    expect(chatRequests[before].message).toBe(prompt)
    frame(id, { content: 'WORK_AUTO_RECOVERED_RESULT：自动恢复后执行成功。' })
    finish(id)
    await expect(work()).toContainText('WORK_AUTO_RECOVERED_RESULT')
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(alert).toHaveCount(0)
    expect(chatRequests.length).toBe(before + 1)
  })

  for (const code of [503, 403] as const) {
    test(`历史${code === 503 ? '503退避' : '403授权阻塞'}期间可取消初始任务，迟到恢复与刷新不会发送`, async () => {
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      const prompt = `WORK_HISTORY_${code}_CANCEL：恢复后不得执行已取消的目标`
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
      const before = chatRequests.length
      const cancelledBefore = cancellations.length
      const readsBefore = failedWorkSnapshotReads
      failedWorkSnapshotCode = code
      failedWorkSnapshots = code === 503 ? Number.MAX_SAFE_INTEGER : 1
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect(work().getByRole('alert')).toContainText(code === 503 ? 'WORK_HISTORY_UNAVAILABLE' : 'WORK_HISTORY_FORBIDDEN')
      if (code === 503) await expect.poll(() => failedWorkSnapshotReads - readsBefore).toBeGreaterThanOrEqual(2)
      const rootStop = work().getByRole('button', { name: '停止任务', exact: true })
      await expect(rootStop).toHaveCount(1)
      await expect(rootStop).toBeEnabled()
      if (code === 503) holdNextWorkSnapshot = true
      await rootStop.click()
      await expect(work().locator('.work-task-heading')).toContainText('已停止')
      await expect(rootStop).toHaveCount(0)
      if (code === 403) {
        // Repairing access may read history, but must not restore cancelled intent.
        holdNextWorkSnapshot = true
        await work().getByRole('button', { name: '重新加载', exact: true }).click()
      }
      await expect.poll(() => heldWorkSnapshots.length).toBe(1)
      const held = heldWorkSnapshots.shift()!
      expect(chatRequests.length).toBe(before)
      expect(cancellations).toHaveLength(cancelledBefore)
      expect(session(held.id).run).toBeUndefined()
      failedWorkSnapshots = 0
      failedWorkSnapshotCode = 503
      held.response.writeHead(200, { 'content-type': 'application/json' }).end(envelope({
        schemaVersion: 1, sessionId: held.id, source: 'persisted', eventId: null, finished: true,
        projection: [], history: [], run: null, runs: [], todos: [], changes: [], commandJobs: [], subagentRuns: []
      }))
      await expect(work().locator('.work-loading')).toHaveCount(0)
      await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(prompt)
      await expect(work().getByRole('button', { name: '发送', exact: true })).toBeEnabled()
      await expect(work().locator('.work-task-heading')).toContainText('已停止')
      await expect.poll(() => page.evaluate((id) => {
        const states = Object.entries(localStorage).filter(([key]) => key.startsWith('aether.work.state.v1'))
        for (const [, value] of states) {
          const state = JSON.parse(value) as { tasks?: Array<{ id: string; status: string }> }
          const task = state.tasks?.find(item => item.id === id)
          if (task) return task.status
        }
        return null
      }, held.id)).toBe('stopped')
      expect(chatRequests.length).toBe(before)
      expect(session(held.id).run).toBeUndefined()
      await page.reload()
      await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(prompt)
      await expect(work().getByRole('button', { name: '发送', exact: true })).toBeEnabled()
      await expect(work().locator('.work-task-heading')).toContainText('已停止')
      await expect(work().locator('.work-task-heading')).not.toContainText('已完成')
      await expect(rootStop).toHaveCount(0)
      expect(chatRequests.length).toBe(before)
      expect(cancellations).toHaveLength(cancelledBefore)
      expect(session(held.id).run).toBeUndefined()
    })
  }

  test('中文 @智能体 和 @agent 都可选择协作代理，真正传入同一主任务请求', async () => {
    const agentId = 'work-chinese-alias-collaborator'
    const agentName = '中文别名协作助手'
    fixtureAgents.set(agentId, { id: agentId, name: agentName, description: '验证中文与英文协作入口' })
    try {
      await switchTo('work')
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      const draft = work().getByRole('textbox', { name: '任务目标', exact: true })
      const agentPicker = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
      const beforeSearch = chatRequests.length
      for (const query of ['@智能体\u00a0中文别名', '@agent\u3000中文别名']) {
        await draft.fill(query)
        await expect(agentPicker.getByRole('option', { name: new RegExp(agentName) })).toBeVisible()
        await expect(agentPicker.getByRole('option')).toHaveCount(1)
        expect(chatRequests.length).toBe(beforeSearch)
      }
      for (const text of ['person@agent 中文别名', '@文件 名称', '@agent\t中文别名', '@智能体\n中文别名']) {
        await draft.fill(text)
        await expect(agentPicker).toHaveCount(0)
        // Native contenteditable line breaks are BR/block nodes; textContent
        // omits that boundary while the visible draft and serializer retain it.
        await expect(draft).toHaveText(text, { useInnerText: true })
        expect(chatRequests.length).toBe(beforeSearch)
      }
      let taskId: string | undefined
      for (const [index, alias] of ['@智能体', '@agent'].entries()) {
        const input = work().getByRole('textbox', { name: index === 0 ? '任务目标' : '继续对话', exact: true })
        await input.fill(`${alias} 中文别名`)
        const picker = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
        const option = picker.getByRole('option', { name: new RegExp(agentName) })
        await expect(option).toBeVisible()
        await expect(picker.getByRole('option')).toHaveCount(1)
        await option.click()
        await expect(picker).toHaveCount(0)
        await expect(input.locator('[data-mention-key]').filter({ hasText: agentName })).toHaveCount(1)
        await input.press('End')
        await page.keyboard.insertText(` 完成中文别名入口第 ${index + 1} 轮协作检查。`)
        const before = chatRequests.length
        await work().getByRole('button', { name: index === 0 ? '开始任务' : '发送', exact: true }).click()
        await expect.poll(() => chatRequests.length).toBe(before + 1)
        const request = chatRequests[before]
        expect(request.collaborators).toEqual([{ agentId }])
        if (taskId) expect(request.sessionId).toBe(taskId)
        else taskId = request.sessionId
        frame(request.sessionId, { content: `WORK_CHINESE_AGENT_ALIAS_${index + 1}_OK` })
        finish(request.sessionId)
        await expect(runStatus()).toHaveCount(0)
        await expect(work().locator('.work-conversation')).toContainText(`WORK_CHINESE_AGENT_ALIAS_${index + 1}_OK`)
      }
    } finally {
      fixtureAgents.delete(agentId)
    }
  })

  test('技能目录403保留可用MCP和知识库，键盘重试成功后资源真实进入任务请求', async () => {
    skillCatalogueDenied = true
    try {
      await switchTo('work')
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      const input = work().getByRole('textbox', { name: '任务目标', exact: true })
      const before = chatRequests.length
      const picker = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
      await input.fill('/技能')
      await expect(picker.getByRole('alert')).toContainText('资源加载失败：技能')
      await expect(picker).not.toContainText('请先在设置中创建')
      await input.fill('/')
      const mcp = picker.getByRole('option', { name: /Git 服务/ })
      const knowledge = picker.getByRole('option', { name: /产品知识库/ })
      await expect(mcp).toBeEnabled()
      await expect(knowledge).toBeEnabled()
      await mcp.click()
      await expect(picker).toHaveCount(0)
      await expect(work().locator('.work-resource-strip')).toContainText('mcp-git')
      await input.fill('/')
      await expect(picker.getByRole('alert')).toContainText('资源加载失败：技能')
      await picker.getByRole('option', { name: /产品知识库/ }).click()
      await expect(picker).toHaveCount(0)
      await expect(work().locator('.work-resource-strip')).toContainText('kb-product')
      await input.fill('/')
      await expect(picker.getByRole('alert')).toContainText('资源加载失败：技能')
      await expect(picker.getByRole('option', { name: /Git 服务/ })).toBeVisible()
      const readsBefore = skillCatalogueReads
      skillCatalogueDenied = false
      holdNextSkillCatalogue = true
      const retry = picker.getByRole('button', { name: '重试加载资源', exact: true })
      await retry.focus()
      await retry.press('Enter')
      await expect.poll(() => skillCatalogueReads).toBe(readsBefore + 1)
      await expect.poll(() => heldSkillCatalogues.length).toBe(1)
      await expect(picker.getByRole('status')).toHaveText('加载中…')
      await expect(picker.getByRole('option')).toHaveCount(0)
      expect(chatRequests.length).toBe(before)
      heldSkillCatalogues.shift()!.end(envelope({ list: fixtureSkills }))
      await expect(picker.getByRole('alert')).toHaveCount(0)
      await input.fill('/技能')
      await picker.getByRole('option', { name: /代码审查技能/ }).click()
      await expect(picker).toHaveCount(0)
      await expect(work().locator('.work-resource-strip')).toContainText('skill-review')
      expect(chatRequests.length).toBe(before)
      await input.fill('WORK_RESOURCE_CATALOGUE_RECOVERY：使用已绑定资源完成任务')
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(before + 1)
      expect(chatRequests[before]).toMatchObject({ skills: ['skill-review'], mcpServers: ['mcp-git'], knowledgeBases: ['kb-product'] })
      const id = chatRequests[before].sessionId
      frame(id, { content: 'WORK_RESOURCE_CATALOGUE_RECOVERED_RESULT' })
      finish(id)
      await expect(work()).toContainText('WORK_RESOURCE_CATALOGUE_RECOVERED_RESULT')
      await expect(runStatus()).toHaveCount(0)
      expect(chatRequests.length).toBe(before + 1)
    } finally {
      skillCatalogueDenied = false
      holdNextSkillCatalogue = false
      for (const response of heldSkillCatalogues.splice(0)) response.destroy()
    }
  })

  test('资源类别加名称可检索技能MCP与知识库，非法空白关闭补全且真实请求保留三种绑定', async () => {
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    const picker = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    const before = chatRequests.length
    const queries = [
      ['/skill 代码审查', '代码审查技能'],
      ['/skills 文档', '文档技能'],
      ['/技能 代码审查', '代码审查技能'],
      ['/mcp Git 服务', 'Git 服务'],
      ['/mcp\u00a0Git 服务', 'Git 服务'],
      ['/mcp\u3000Git 服务', 'Git 服务'],
      ['/kb 产品', '产品知识库'],
      ['/knowledge 产品', '产品知识库'],
      ['/知识库 产品', '产品知识库']
    ]
    for (const [query, label] of queries) {
      await input.fill(query)
      await expect(picker.getByRole('option', { name: new RegExp(label) })).toBeVisible()
      await expect(picker.getByRole('option')).toHaveCount(1)
      expect(chatRequests.length).toBe(before)
    }
    await picker.getByRole('option', { name: /产品知识库/ }).click()
    await expect(picker).toHaveCount(0)
    await expect(work().locator('.work-resource-strip')).toContainText('kb-product')
    await input.fill('/mcp Git 服务')
    await picker.getByRole('option', { name: /Git 服务/ }).click()
    await expect(picker).toHaveCount(0)
    await expect(work().locator('.work-resource-strip')).toContainText('mcp-git')
    await input.fill('/skill 代码审查')
    await picker.getByRole('option', { name: /代码审查技能/ }).click()
    await expect(picker).toHaveCount(0)
    await expect(work().locator('.work-resource-strip')).toContainText('skill-review')
    for (const text of ['/未知类别 检索', '/mcp\tGit', '/mcp\nGit']) {
      await input.fill(text)
      await expect(picker).toHaveCount(0)
      await expect(input).toHaveText(text, { useInnerText: true })
      expect(chatRequests.length).toBe(before)
    }
    await input.fill('WORK_NAMED_RESOURCE_SEARCH：使用筛选后绑定的资源完成任务')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(before + 1)
    expect(chatRequests[before]).toMatchObject({ skills: ['skill-review'], mcpServers: ['mcp-git'], knowledgeBases: ['kb-product'] })
    const id = chatRequests[before].sessionId
    frame(id, { content: 'WORK_NAMED_RESOURCE_SEARCH_RESULT' })
    finish(id)
    await expect(work()).toContainText('WORK_NAMED_RESOURCE_SEARCH_RESULT')
    await expect(runStatus()).toHaveCount(0)
    expect(chatRequests.length).toBe(before + 1)
  })

  test('Code 与 Work 的 @ 都有显式分类，无工作区也能选择并真实下发协作 Agent', async ({}, testInfo) => {
    const agentId = 'shared-reference-collaborator', agentName = '共享引用协作工程师'
    fixtureAgents.set(agentId, { id: agentId, name: agentName, description: '验证两种模式的真实结构化委派' })
    try {
      for (const mode of ['code', 'work'] as const) {
        await switchTo(mode)
        if (mode === 'work') await work().getByRole('button', { name: '新任务', exact: true }).click()
        else await page.locator('.mode-surface[data-mode="code"]').getByRole('button', { name: '新建', exact: true }).click()
        const input = mode === 'work' ? work().getByRole('textbox', { name: '任务目标', exact: true }) : page.locator('.mode-surface[data-mode="code"] .chat__input')
        await input.fill('@')
        const portal = page.locator('.completion-popover', { has: page.getByRole('tablist', { name: '引用类型', exact: true }) })
        await expect(portal).toBeVisible()
        await expect(portal.getByRole('tab', { name: '文件与目录', exact: true })).toBeVisible()
        await portal.getByRole('tab', { name: '协作 Agent', exact: true }).click()
        const option = portal.getByRole('option', { name: new RegExp(agentName) })
        await expect(option).toBeVisible()
        const requestsBefore = chatRequests.length
        await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
        await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true })
        await expect(portal).toBeVisible()
        expect(chatRequests.length).toBe(requestsBefore)
        await option.click()
        await expect(portal).toHaveCount(0)
        await expect(input.locator('.mention-chip--agent')).toHaveText(agentName)
        await input.press('End')
        await page.keyboard.insertText(` 请完成 ${mode} 共享引用边界检查。`)
        await input.press('Enter')
        await expect.poll(() => chatRequests.length).toBe(requestsBefore + 1)
        const request = chatRequests[requestsBefore]
        expect(request.collaborators).toEqual([{ agentId }])
        if (mode === 'work') expect(request.workspacePaths ?? []).toEqual([])
        frame(request.sessionId, { content: `SHARED_MENTION_${mode}_OK` }); finish(request.sessionId)
        await expect(mode === 'work' ? work().locator('.work-conversation') : page.locator('.mode-surface[data-mode="code"] .chat')).toContainText(`SHARED_MENTION_${mode}_OK`)
        await expect(mode === 'work' ? runStatus() : page.locator('.mode-surface[data-mode="code"] .chat__send--stop')).toHaveCount(0)
        // Plain text with the same identity must not authorize another Agent run.
        const followupInput = mode === 'work' ? work().getByRole('textbox', { name: '继续对话', exact: true }) : input
        await followupInput.fill(`@${agentId} 仅手工文字，不是已选择的标签`)
        await followupInput.press('Enter')
        await expect.poll(() => chatRequests.length).toBe(requestsBefore + 2)
        expect(chatRequests[requestsBefore + 1].collaborators).toBeUndefined()
        finish(chatRequests[requestsBefore + 1].sessionId)
        await expect(mode === 'work' ? runStatus() : page.locator('.mode-surface[data-mode="code"] .chat__send--stop')).toHaveCount(0)
        await page.screenshot({ path: testInfo.outputPath(`shared-reference-${mode}.png`) })
      }
    } finally { fixtureAgents.delete(agentId) }
  })

  test('共享 @ 弹层在短窗口独立滚动，Alt切换分类、Tab选中、Esc关闭并释放隐藏模式按键', async ({}, testInfo) => {
    const agentId = 'shared-reference-narrow', agentName = '小窗口引用工程师'
    fixtureAgents.set(agentId, { id: agentId, name: agentName })
    try {
      for (const size of [{ width: 620, height: 520 }, { width: 960, height: 600 }, { width: 1440, height: 900 }]) {
        await app!.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0]?.setSize(dimensions.width, dimensions.height), size)
        await switchTo('work')
        await work().getByRole('button', { name: '新任务', exact: true }).click()
        const input = work().getByRole('textbox', { name: '任务目标', exact: true })
        await input.fill('@')
        const portal = page.locator('.completion-popover', { has: page.getByRole('tablist', { name: '引用类型', exact: true }) })
        await input.press('Alt+ArrowLeft')
        await expect(portal.getByRole('tab', { name: '文件与目录', exact: true })).toHaveAttribute('aria-selected', 'true')
        await input.press('Alt+ArrowRight')
        await expect(portal.getByRole('tab', { name: '协作 Agent', exact: true })).toHaveAttribute('aria-selected', 'true')
        await expect(portal.getByRole('option', { name: new RegExp(agentName) })).toBeVisible()
        const geometry = await portal.evaluate(element => {
          const rect = element.getBoundingClientRect(), list = element.querySelector('.agent-ref-picker__list') as HTMLElement | null
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, listHeight: list?.clientHeight ?? 0,
            portalInBody: element.parentElement === document.body, listOverflow: list ? getComputedStyle(list).overflowY : '' }
        })
        expect(geometry.portalInBody).toBe(true)
        expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width)
        expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
        expect(geometry.listHeight).toBeGreaterThan(0); expect(geometry.listOverflow).toBe('auto')
        await page.screenshot({ path: testInfo.outputPath(`shared-reference-${size.width}x${size.height}.png`) })
        await input.press('Tab')
        await expect(input.locator('.mention-chip--agent')).toHaveCount(1)
        await expect(portal).toHaveCount(0)
        await input.fill('@')
        await expect(portal).toBeVisible()
        await input.press('Escape')
        await expect(portal).toHaveCount(0)
        await input.fill('@')
        await expect(portal).toBeVisible()
        await switchTo('code')
        await expect(portal).toHaveCount(0)
        const codeInput = page.locator('.mode-surface[data-mode="code"] .chat__input')
        await codeInput.fill('隐藏 Work 补全不会接管 Code 键盘')
        const before = chatRequests.length
        await codeInput.press('Enter')
        await expect.poll(() => chatRequests.length).toBe(before + 1)
        finish(chatRequests[before].sessionId)
        await expect(page.locator('.mode-surface[data-mode="code"] .chat__send--stop')).toHaveCount(0)
      }
    } finally {
      fixtureAgents.delete(agentId)
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    }
  })

  test('Code 的协作Agent加载失败可键盘重试，重试与候选选择都不提前发消息', async () => {
    const agentId = 'code-reference-retry', agentName = 'Code目录重试工程师'
    fixtureAgents.set(agentId, { id: agentId, name: agentName })
    try {
      await switchTo('code')
      const input = page.locator('.mode-surface[data-mode="code"] .chat__input')
      failNextAgentCatalogue = true
      await input.fill('@agent Code目录重试')
      const picker = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
      await expect(picker.getByRole('alert')).toContainText('AGENT_CATALOGUE_RETRY')
      const before = chatRequests.length, readsBefore = agentCatalogueReads
      const retry = picker.getByRole('button', { name: '重试', exact: true })
      await retry.focus(); await retry.press('Enter')
      await expect.poll(() => agentCatalogueReads).toBe(readsBefore + 1)
      await expect(picker.getByRole('option', { name: new RegExp(agentName) })).toBeVisible()
      expect(chatRequests.length).toBe(before)
      await picker.getByRole('option', { name: new RegExp(agentName) }).click()
      await expect(picker).toHaveCount(0)
      await expect(input.locator('.mention-chip--agent')).toHaveText(agentName)
      expect(chatRequests.length).toBe(before)
      await input.fill('')
    } finally { failNextAgentCatalogue = false; fixtureAgents.delete(agentId) }
  })

  test('无工作区任务的资料可预览text/image、失败重试、引用标签、移除持久化且不删除历史和原bytes', async () => {
    const text = 'WORK_SOURCE_TEXT：独立任务资料，不依赖本机项目。'
    const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const filesBefore = new Set(sourceFiles.keys())
    await work().locator('.work-file-input').setInputFiles([
      { name: 'source-probe.txt', mimeType: 'text/plain', buffer: Buffer.from(text, 'utf8') },
      { name: 'source-probe.gif', mimeType: 'image/gif', buffer: image }
    ])
    await expect(work().locator('.work-attachments .attach-chip')).toHaveCount(2)
    await expect(work().getByRole('button', { name: '添加资料', exact: true })).toBeEnabled()
    const uploadedTextKey = [...sourceFiles.entries()].find(([key, file]) => !filesBefore.has(key) && file.type === 'text/plain')![0]
    failNextSourcePath = uploadedTextKey.slice(uploadedTextKey.indexOf(':') + 1)
    const previous = chatRequests.length
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_SOURCE_PREVIEW_AND_PERSISTENCE')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(previous + 1)
    const id = chatRequests[previous].sessionId
    frame(id, { content: 'WORK_SOURCE_TASK_OK' }); finish(id)
    await expect(runStatus()).toHaveCount(0)
    const storedSources = [...sourceFiles.entries()].filter(([key]) => key.startsWith(`${id}:`))
    expect(storedSources).toHaveLength(2)
    await work().getByRole('tab', { name: '资料', exact: true }).click()
    const sources = work().getByRole('tabpanel', { name: '资料', exact: true })
    await expect(sources.getByRole('listbox', { name: '资料文件', exact: true }).getByRole('option')).toHaveCount(2)
    await expect(sources.getByRole('alert')).toContainText('SOURCE_PREVIEW_RETRY')
    const beforeRetry = sourceReads.length
    await sources.getByRole('button', { name: '重试读取', exact: true }).click()
    await expect(sources.locator('.work-sources__preview')).toContainText(text)
    expect(sourceReads.length).toBeGreaterThan(beforeRetry)
    const textRow = sources.locator('.work-source-row').filter({ hasText: 'source-probe.txt' })
    await textRow.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true }).locator('.mention-chip--file')).toHaveText('source-probe.txt')
    const imageOption = sources.getByRole('option', { name: /source-probe.gif/ })
    await imageOption.click()
    const preview = sources.locator('.work-sources__preview img')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const historyBefore = structuredClone(session(id).history), deletesBefore = sourceDeletes.length
    const bytesBefore = storedSources.map(([key, file]) => [key, createHash('sha256').update(file.bytes).digest('hex')])
    await textRow.getByRole('button', { name: '从任务资料移除 source-probe.txt', exact: true }).click()
    await textRow.getByRole('button', { name: '确认移除 source-probe.txt', exact: true }).click()
    await expect(sources.getByRole('listbox', { name: '资料文件', exact: true }).getByRole('option')).toHaveCount(1)
    await expect.poll(() => page.evaluate(taskId => {
      for (const key of Object.keys(localStorage).filter(key => key.startsWith('aether.work.state.v1'))) {
        const value = JSON.parse(localStorage.getItem(key) ?? '{}') as { tasks?: Array<{ id: string; workspacePath: string | null; sources: Array<{ path: string }> }> }
        const task = value.tasks?.find(task => task.id === taskId)
        if (task) return { count: task.sources.length, workspacePath: task.workspacePath }
      }
      return null
    }, id)).toEqual({ count: 1, workspacePath: null })
    expect(sourceDeletes).toHaveLength(deletesBefore)
    expect(session(id).history).toEqual(historyBefore)
    expect(storedSources.map(([key]) => [key, createHash('sha256').update(sourceFiles.get(key)!.bytes).digest('hex')])).toEqual(bytesBefore)
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await switchTo('work')
    await work().getByRole('tab', { name: '资料', exact: true }).click()
    const restored = work().getByRole('tabpanel', { name: '资料', exact: true })
    await expect(restored.getByRole('option', { name: /source-probe.txt/ })).toHaveCount(0)
    await expect(restored.getByRole('option', { name: /source-probe.gif/ })).toBeVisible()
    expect(session(id).history).toEqual(historyBefore)
  })

  test('资料旧任务和旧引擎的迟到读取都不能覆盖当前任务预览', async () => {
    async function createSourceTask(name: string, text: string, hold = false): Promise<{ id: string; path: string }> {
      await switchTo('work')
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      const beforeKeys = new Set(sourceFiles.keys())
      await work().locator('.work-file-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
      await expect(work().locator('.work-attachments .attach-chip')).toHaveCount(1)
      await expect(work().getByRole('button', { name: '添加资料', exact: true })).toBeEnabled()
      const uploadedKey = [...sourceFiles.keys()].find(key => !beforeKeys.has(key))!
      const relative = uploadedKey.slice(uploadedKey.indexOf(':') + 1)
      if (hold) holdNextSourcePath = relative
      const before = chatRequests.length
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(name)
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(before + 1)
      const id = chatRequests[before].sessionId
      frame(id, { content: `SOURCE_TASK_${name}_OK` }); finish(id)
      await expect(runStatus()).toHaveCount(0)
      await work().getByRole('tab', { name: '资料', exact: true }).click()
      return { id, path: relative }
    }
    const flushHeld = (): void => {
      for (const held of heldSourceReads.splice(0)) if (!held.response.destroyed && !held.response.writableEnded)
        held.response.end(envelope(sourceContent(held.sessionId, held.path)))
    }
    let alternateSource: ReturnType<typeof createServer> | undefined
    const originalUrl = await page.evaluate(async () => (await window.aether.settings.get()).remoteBaseUrl)
    try {
      const first = await createSourceTask('late-source-first.txt', 'FIRST_SOURCE_MUST_NOT_LEAK', true)
      await expect.poll(() => heldSourceReads.some(read => read.sessionId === first.id && read.path === first.path)).toBe(true)
      await createSourceTask('late-source-second.txt', 'SECOND_SOURCE_STAYS_CURRENT')
      await expect(work().locator('.work-sources__preview')).toContainText('SECOND_SOURCE_STAYS_CURRENT')
      flushHeld()
      await expect(work().locator('.work-sources__preview')).not.toContainText('FIRST_SOURCE_MUST_NOT_LEAK')
      await selectWorkTask('late-source-first.txt')
      await expect(work().locator('.work-sources__preview')).toContainText('FIRST_SOURCE_MUST_NOT_LEAK')
      const third = await createSourceTask('late-source-old-engine.txt', 'OLD_ENGINE_SOURCE_MUST_NOT_LEAK', true)
      await expect.poll(() => heldSourceReads.some(read => read.sessionId === third.id)).toBe(true)
      alternateSource = createServer((request, response) => { server.emit('request', request, response) })
      await new Promise<void>((done, reject) => { alternateSource!.once('error', reject); alternateSource!.listen(0, '127.0.0.1', done) })
      const address = alternateSource.address()
      if (!address || typeof address === 'string') throw new Error('Missing isolated source port')
      const nextUrl = `http://127.0.0.1:${address.port}`
      await page.evaluate(async ({ url }) => {
        const current = await window.aether.settings.get()
        await window.aether.settings.saveEngine({ engineMode: 'remote', remoteBaseUrl: url,
          preferredPort: current.preferredPort, autoStartEngine: current.autoStartEngine,
          remoteWorkspaceRoot: current.remoteWorkspaceRoot })
        await window.aether.engine.restart()
      }, { url: nextUrl })
      await expect.poll(() => page.evaluate(async () => (await window.aether.engine.getSnapshot()).baseUrl)).toBe(nextUrl)
      await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
      flushHeld()
      await expect(work().locator('.work-sources__preview')).toHaveCount(0)
      await expect(work()).not.toContainText('OLD_ENGINE_SOURCE_MUST_NOT_LEAK')
    } finally {
      failNextSourcePath = null; holdNextSourcePath = null; flushHeld()
      if (alternateSource) {
        await page.evaluate(async ({ url }) => {
          const current = await window.aether.settings.get()
          await window.aether.settings.saveEngine({ engineMode: 'remote', remoteBaseUrl: url,
            preferredPort: current.preferredPort, autoStartEngine: current.autoStartEngine,
            remoteWorkspaceRoot: current.remoteWorkspaceRoot })
          await window.aether.engine.restart()
        }, { url: originalUrl })
        await expect.poll(() => page.evaluate(async () => (await window.aether.engine.getSnapshot()).baseUrl)).toBe(originalUrl)
        await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
        alternateSource.closeAllConnections()
        await new Promise<void>(done => alternateSource!.close(() => done()))
      }
    }
  })

  test('Agent目录失败可用Enter重试，中文候选恢复只插入协作引用而不发送', async () => {
    const agentId = 'work-agent-catalogue-keyboard-retry'
    const agentName = '键盘恢复协作助手'
    fixtureAgents.set(agentId, { id: agentId, name: agentName, description: '验证目录恢复操作' })
    try {
      await switchTo('work')
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      const input = work().getByRole('textbox', { name: '任务目标', exact: true })
      const before = chatRequests.length
      failNextAgentCatalogue = true
      await input.fill('@智能体 键盘恢复')
      const picker = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
      await expect(picker.getByRole('alert')).toContainText('AGENT_CATALOGUE_RETRY')
      await expect(picker.getByRole('option')).toHaveCount(0)
      const readsBefore = agentCatalogueReads
      const retry = picker.getByRole('button', { name: '重试', exact: true })
      await retry.focus()
      await retry.press('Enter')
      await expect.poll(() => agentCatalogueReads).toBe(readsBefore + 1)
      await expect(picker.getByRole('alert')).toHaveCount(0)
      const option = picker.getByRole('option', { name: new RegExp(agentName) })
      await expect(option).toBeVisible()
      await expect(picker.getByRole('option')).toHaveCount(1)
      expect(chatRequests.length).toBe(before)
      await option.click()
      await expect(picker).toHaveCount(0)
      await expect(input.locator('[data-mention-key]').filter({ hasText: agentName })).toHaveCount(1)
      expect(chatRequests.length).toBe(before)
      await input.fill('')
    } finally {
      failNextAgentCatalogue = false
      fixtureAgents.delete(agentId)
    }
  })

  test('公共选择器随主题取色，键盘和鼠标选择真正传入模型请求，长消息窄窗不溢出', async ({}, testInfo) => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const modelSelect = work().getByRole('button', { name: 'Work 使用的模型', exact: true })
    await expect(modelSelect).toHaveClass(/select__trigger/)
    await expect(work().locator('select')).toHaveCount(0)
    const themes = [
      { appearance: 'dark', appearanceLabel: '深色', accent: 'purple', accentLabel: '紫色' },
      { appearance: 'light', appearanceLabel: '浅色', accent: 'blue', accentLabel: '蓝色' }
    ]
    const panelBackgrounds: string[] = []
    for (const theme of themes) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings.getByRole('radio', { name: theme.appearanceLabel, exact: true }).click()
      await settings.getByRole('radio', { name: theme.accentLabel, exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', theme.appearance)
      await expect(page.locator('html')).toHaveAttribute('data-accent', theme.accent)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await modelSelect.click()
      const panel = page.locator('.popover__panel').filter({ has: page.locator('.select__panel') })
      await expect(panel).toBeVisible()
      await expect(panel.locator('.select__item.is-active')).toBeFocused()
      const colors = await panel.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--material-bg)'
        probe.style.color = 'var(--accent)'
        element.append(probe)
        const expected = getComputedStyle(probe),
          check = element.querySelector('.select__check')
        if (!check) throw new Error('Missing selected-model indicator')
        const result = {
          background: getComputedStyle(element).backgroundColor,
          expectedBackground: expected.backgroundColor,
          check: getComputedStyle(check).color,
          expectedCheck: expected.color
        }
        probe.remove()
        return result
      })
      expect(colors.background).toBe(colors.expectedBackground)
      expect(colors.check).toBe(colors.expectedCheck)
      panelBackgrounds.push(colors.background)
      await page.screenshot({
        path: testInfo.outputPath(`work-model-${theme.appearance}.png`),
        animations: 'disabled'
      })
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await expect(modelSelect).toBeFocused()
      await modelSelect.click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).click()
      await expect(panel).toHaveCount(0)
    }
    expect(panelBackgrounds[0]).not.toBe(panelBackgrounds[1])
    await modelSelect.click()
    await expect(page.locator('.select__panel')).toBeVisible()
    // Keyboard activation bypasses outside mousedown: the hidden mode itself must close its portal.
    await codeMode().focus()
    await expect(page.locator('.select__panel')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(codeMode()).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await switchTo('work')
    await expect(modelSelect).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await modelSelect.click()
    await page.getByRole('menuitem', { name: /^默认/ }).click()
    await expect(modelSelect).toHaveText('Work fixture model · 客户端默认')
    await expect(modelSelect).toHaveAttribute('title', 'Work fixture model · 客户端默认')
    await modelSelect.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.select__panel')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await expect(modelSelect).toContainText('Work alternate model')
    const prompt = `WORK_MODEL_SELECTION：${'连续无空格的长资料'.repeat(50)}`
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
    const previous = chatRequests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(previous + 1)
    const request = chatRequests[previous]
    expect(request).toMatchObject({ message: prompt, model: alternateModelId })
    expect(request.model).not.toBe(alternateModelRecordId)
    frame(request.sessionId, {
      content: `WORK_LONG_REPLY：https://example.com/${'continuous-result-'.repeat(80)}`
    })
    await expect(work()).toContainText('WORK_LONG_REPLY')
    await expect(modelSelect).toBeDisabled()
    finish(request.sessionId)
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(940, 600))
    const userMessage = work().locator('.work-message--user')
    const userContent = userMessage.locator('.message__bubble-content')
    const collapse = userMessage.getByRole('button', { name: '显示更多', exact: true })
    await expect(collapse).toHaveAttribute('aria-expanded', 'false')
    await expect(userContent).toHaveClass(/is-collapsed/)
    const collapsedHeight = await userContent.evaluate(element => element.clientHeight)
    await collapse.click()
    await expect(userContent).not.toHaveClass(/is-collapsed/)
    await expect(userContent).toHaveText(prompt)
    expect(await userContent.evaluate(element => element.clientHeight)).toBeGreaterThan(collapsedHeight)
    await userMessage.getByRole('button', { name: '收起', exact: true }).click()
    await expect(userContent).toHaveClass(/is-collapsed/)
    for (const role of ['user', 'assistant']) {
      const message = work().locator(`.work-message--${role}`)
      await expect(message).toBeVisible()
      const overflow = await message.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          horizontal: element.scrollWidth - element.clientWidth,
          viewport: Math.max(0, rect.right - innerWidth, -rect.left)
        }
      })
      expect(overflow.horizontal).toBeLessThanOrEqual(1)
      expect(overflow.viewport).toBeLessThanOrEqual(1)
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  })

  test('940px 窗口深浅主题内容不越界，标题栏保持原高度', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(940, 600))
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await expect(settings).toBeVisible()
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings
        .getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true })
        .click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(settings).toHaveCount(0)
      await expect(workMode()).toHaveAttribute('aria-selected', 'true')
      await expect
        .poll(() => work().evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1)
      const metrics = await page.evaluate(() => {
        const title = document.querySelector('.menubar') ?? document.querySelector('.menu-bar')
        const view = document.querySelector('.work-view')
        if (!title || !view) throw new Error('Missing application layout')
        return {
          titleHeight: title.getBoundingClientRect().height,
          right: view.getBoundingClientRect().right,
          viewport: innerWidth
        }
      })
      expect(metrics.titleHeight).toBeGreaterThanOrEqual(45)
      expect(metrics.titleHeight).toBeLessThanOrEqual(47)
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewport + 1)
      await page.screenshot({
        path: testInfo.outputPath(`work-${appearance}-940.png`),
        animations: 'disabled'
      })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  })

  test('五任务同时运行可反复切换，两个共享目录任务不串流，后台归档完成可导出与继续', async ({}, testInfo) => {
    const ids: string[] = []
    const cancelledBefore = cancellations.length
    for (let index = 0; index < 5; index++) {
      const id = await startTask(`WORK_STRESS_${index + 1}：并行整理独立资料`)
      ids.push(id)
      const value = session(id)
      // Model the workspace recorded by a remote engine after task admission:
      // two collaborators share a project, the other three use isolated roots.
      value.run!.workspacePaths = [
        index < 2 ? '/remote/work-stress-shared' : `/remote/work-stress-${index + 1}`
      ]
      frame(id, { run: value.run })
      frame(id, { content: `STRESS_OWNER_${index + 1}` })
      await expect(work().locator('.work-conversation')).toContainText(`STRESS_OWNER_${index + 1}`)
    }
    expect(ids.every((id) => session(id).run?.status === 'running')).toBe(true)
    expect(new Set(ids).size).toBe(5)
    expect(cancellations).toHaveLength(cancelledBefore)
    expect(session(ids[0]).run?.workspacePaths).toEqual(session(ids[1]).run?.workspacePaths)
    expect(new Set(ids.map((id) => session(id).run?.workspacePaths[0])).size).toBe(4)

    for (let round = 0; round < 3; round++) {
      for (let index = ids.length - 1; index >= 0; index--) {
        await work()
          .locator('.work-sidebar__task', { hasText: `WORK_STRESS_${index + 1}：` })
          .click()
        await expect(work().locator('.work-task-heading h1')).toContainText(
          `WORK_STRESS_${index + 1}`
        )
        frame(ids[index], { content: `\nSTRESS_ROUND_${round + 1}_OWNER_${index + 1}` })
        await expect(work().locator('.work-conversation')).toContainText(
          `STRESS_ROUND_${round + 1}_OWNER_${index + 1}`
        )
        await expect(runStatus()).toHaveAttribute('data-state', 'running')
        for (let other = 0; other < ids.length; other++) {
          if (index !== other)
            await expect(work().locator('.work-conversation')).not.toContainText(
              `STRESS_OWNER_${other + 1}`
            )
        }
      }
    }

    await taskHeadingAction('重命名任务')
    await work()
      .getByRole('textbox', { name: '任务名称', exact: true })
      .fill('WORK_STRESS_SHARED_RENAMED')
    await page.keyboard.press('Enter')
    await expect(work().locator('.work-task-heading h1')).toHaveText('WORK_STRESS_SHARED_RENAMED')
    await work().locator('.work-sidebar__task', { hasText: 'WORK_STRESS_4：' }).click()
    await taskHeadingAction('重命名任务')
    await expect(work().getByRole('textbox', { name: '任务名称', exact: true })).toHaveValue(
      'WORK_STRESS_4：并行整理独立资料'
    )
    await page.keyboard.press('Escape')
    await taskHeadingAction('归档任务')
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toBeVisible()
    expect(cancellations).toHaveLength(cancelledBefore)
    frame(ids[3], { content: '\nWORK_STRESS_ARCHIVED_FINAL' })
    finish(ids[3])
    expect(session(ids[3]).run?.status).toBe('succeeded')

    await work().locator('.work-sidebar__archived summary').click()
    const archived = work().locator('.work-sidebar__archived-row', { hasText: 'WORK_STRESS_4：' })
    await page.evaluate(() => {
      const original = URL.createObjectURL
      URL.createObjectURL = (blob: Blob): string => {
        void blob.text().then((text) => {
          ;(window as Window & { workExport?: string }).workExport = text
        })
        return original(blob)
      }
    })
    await archived.getByRole('button', { name: '导出', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const value = (window as Window & { workExport?: string }).workExport
          return Boolean(value)
        })
      )
      .toBe(true)
    const exported = await page.evaluate(() =>
      JSON.parse((window as Window & { workExport: string }).workExport)
    )
    expect(
      exported.transcript.some((message: { content: string }) =>
        message.content.includes('WORK_STRESS_ARCHIVED_FINAL')
      )
    ).toBe(true)
    expect(exported.status).toBe('done')
    await archived.getByRole('button', { name: '恢复', exact: true }).click()
    await expect(
      work().locator('.work-sidebar__archived-row', { hasText: 'WORK_STRESS_4：' })
    ).toHaveCount(0)

    await work().locator('.work-sidebar__task', { hasText: 'WORK_STRESS_2：' }).click()
    await work()
      .locator('.work-task-heading')
      .getByRole('button', { name: '停止任务', exact: true })
      .click()
    await expect.poll(() => cancellations.slice(cancelledBefore)).toEqual([ids[1]])
    expect(
      ids
        .filter((id, index) => index !== 1 && index !== 3)
        .every((id) => session(id).run?.status === 'running')
    ).toBe(true)
    await taskHeadingAction('继续任务')
    const continued = chatRequests.length
    await work()
      .getByRole('textbox', { name: '继续对话', exact: true })
      .fill('WORK_STRESS_CONTINUE')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(continued + 1)
    expect(chatRequests.at(-1)).toMatchObject({
      sessionId: ids[1],
      workspacePaths: ['/remote/work-stress-shared']
    })
    for (let index = 0; index < ids.length; index++) {
      if (index === 3) continue
      frame(ids[index], { content: `\nWORK_STRESS_COMPLETED_${index + 1}` })
      finish(ids[index])
    }
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(work().locator('.work-conversation')).toContainText('WORK_STRESS_COMPLETED_2')
    await page.reload()
    await expect(work().locator('.work-conversation')).toContainText('WORK_STRESS_COMPLETED_2')
    expect(errors).toEqual([])
  })

  test('旧任务流回执迟到不锁住已停止任务的继续发送，也不释放新一轮发送', async () => {
    await app!.evaluate(() => {
      const control = (globalThis as typeof globalThis & { workStreamCompletions: { hold: boolean } }).workStreamCompletions
      control.hold = true
    })
    let background = '', selected = ''
    try {
      background = await startTask('WORK_DELAYED_BACKGROUND：后台任务')
      frame(background, { content: 'BACKGROUND_STILL_RUNNING' })
      await expect(work().locator('.work-conversation')).toContainText('BACKGROUND_STILL_RUNNING')
      selected = await startTask('WORK_DELAYED_SELECTED：停止后继续')
      await expect.poll(() => app!.evaluate(() => {
        const control = (globalThis as typeof globalThis & { workStreamCompletions: { waiting: Map<string, { sessionId: string }> } }).workStreamCompletions
        return [...control.waiting.values()].map(item => item.sessionId)
      })).toContain(background)
      frame(selected, { content: 'SELECTED_BEFORE_STOP' })
      await expect(work().locator('.work-conversation')).toContainText('SELECTED_BEFORE_STOP')
      await work().locator('.work-task-heading').getByRole('button', { name: '停止任务', exact: true }).click()
      await expect.poll(() => session(selected).run?.status).toBe('cancelled')
      await expect.poll(() => app!.evaluate(() => {
        const control = (globalThis as typeof globalThis & { workStreamCompletions: { waiting: Map<string, { sessionId: string }> } }).workStreamCompletions
        return [...control.waiting.values()].map(item => item.sessionId)
      })).toContain(selected)
      await taskHeadingAction('继续任务')
      await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('WORK_DELAYED_CONTINUE')
      await expect(work().getByRole('button', { name: '发送', exact: true })).toBeEnabled()
      const before = chatRequests.length
      await work().getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(before + 1)
      expect(chatRequests.at(-1)).toMatchObject({ sessionId: selected, message: 'WORK_DELAYED_CONTINUE' })
      expect(session(background).run?.status).toBe('running')
      // A late old completion cannot clear the new attempt's single-flight gate.
      await app!.evaluate(() => {
        const control = (globalThis as typeof globalThis & { workStreamCompletions: { hold: boolean; waiting: Map<string, { resolve: () => void }> } }).workStreamCompletions
        control.hold = false
        for (const item of control.waiting.values()) item.resolve()
        control.waiting.clear()
      })
      await expect(runStatus()).toHaveAttribute('data-state', 'running')
      await expect(work().getByRole('button', { name: '发送', exact: true })).toBeDisabled()
      frame(selected, { content: 'WORK_DELAYED_CONTINUE_DONE' })
      finish(selected)
      await expect(runStatus()).toHaveCount(0)
      expect(chatRequests.length).toBe(before + 1)
    } finally {
      await app!.evaluate(() => {
        const control = (globalThis as typeof globalThis & { workStreamCompletions: { hold: boolean; waiting: Map<string, { resolve: () => void }> } }).workStreamCompletions
        control.hold = false
        for (const item of control.waiting.values()) item.resolve()
        control.waiting.clear()
      })
      if (background && session(background).run?.status === 'running') finish(background)
      if (selected && session(selected).run?.status === 'running') finish(selected)
    }
  })

  test('Work 复用对话偏好，记忆和思考选择进入真实请求且跨刷新保留', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '对话偏好', exact: true }).click()
    await page.getByTitle('选择思考档位', { exact: true }).click()
    await page.getByRole('menuitem', { name: /^Off/ }).click()
    await expect(page.locator('.composer-options__dd-menu:visible')).toHaveCount(0)
    await page.getByTitle('选择长期记忆范围', { exact: true }).click()
    await page.getByRole('menuitem', { name: /^全局记忆/ }).click()
    await expect.poll(() => [...memoryScopes.values()].includes('global')).toBe(true)
    await expect(page.locator('.composer-options__dd-menu:visible')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_PREFERENCES')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.at(-1)?.message).toBe('WORK_PREFERENCES')
    const id = chatRequests.at(-1)!.sessionId
    expect(chatRequests.at(-1)).toMatchObject({ thinkingMode: false, memoryScope: 'global' })
    frame(id, { content: 'WORK_PREFERENCES_OK' })
    finish(id)
    await expect(runStatus()).toHaveCount(0)
    await page.reload()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
    await work().getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(page.getByTitle('选择思考档位', { exact: true })).toHaveText(/Off/)
    await expect(page.getByTitle('选择长期记忆范围', { exact: true })).toHaveText(/全局记忆/)
    await page.keyboard.press('Escape')
  })

  test('Agent 独立管理页支持模型、温度与技能/MCP/知识库/工具绑定，保存后可恢复并参与任务', async () => {
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
    await agentCreateEntry('page').click()
    await page.getByLabel('名称', { exact: true }).fill('独立配置 Agent')
    await page.getByLabel('用途', { exact: true }).fill('验证完整资源绑定')
    await page.getByLabel('工作指令', { exact: true }).fill('使用绑定的资源完成任务。')
    await page.getByLabel('温度', { exact: true }).fill('0.7')
    await page.getByRole('button', { name: 'Agent 默认模型', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Work fixture model', exact: true }).click()

    const group = (title: string) =>
      page
        .locator('fieldset.work-agent-manager__binding')
        .filter({ has: page.locator('legend', { hasText: title }) })
    await page.getByRole('tab', { name: /^资源绑定/ }).click()
    await group('技能').getByRole('checkbox').first().check()
    await page
      .locator('.work-agent-manager__resource-nav')
      .getByRole('button', { name: /^MCP 服务/ })
      .click()
    await group('MCP 服务').getByRole('checkbox').first().check()
    await page
      .locator('.work-agent-manager__resource-nav')
      .getByRole('button', { name: /^知识库/ })
      .click()
    await group('知识库').getByRole('checkbox').first().check()
    await page.getByRole('tab', { name: /^工具权限/ }).click()
    await page.getByRole('button', { name: '仅对话', exact: true }).click()
    await group('工具权限').getByRole('checkbox').nth(1).check()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.size).toBeGreaterThan(0)
    const id = [...fixtureAgents.entries()].find(
      ([, value]) => value.name === '独立配置 Agent'
    )?.[0]
    expect(id).toBeTruthy()
    expect(fixtureAgents.get(id!)).toMatchObject({
      temperature: 0.7,
      skills: ['代码审查技能'],
      mcpServers: ['mcp-git'],
      knowledgeBases: ['kb-product'],
      allowedTools: ['write_file']
    })

    await page.getByRole('button', { name: '编辑 Agent 独立配置 Agent', exact: true }).click()
    await page.getByRole('tab', { name: /^资源绑定/ }).click()
    await page
      .locator('.work-agent-manager__resource-nav')
      .getByRole('button', { name: /^技能/ })
      .click()
    await expect(group('技能').getByRole('checkbox').first()).toBeChecked()
    await page
      .locator('.work-agent-manager__resource-nav')
      .getByRole('button', { name: /^MCP 服务/ })
      .click()
    await expect(group('MCP 服务').getByRole('checkbox').first()).toBeChecked()
    await page
      .locator('.work-agent-manager__resource-nav')
      .getByRole('button', { name: /^知识库/ })
      .click()
    await expect(group('知识库').getByRole('checkbox').first()).toBeChecked()
    await page.getByRole('tab', { name: /^工具权限/ }).click()
    await expect(group('工具权限').getByRole('checkbox').nth(1)).toBeChecked()
    // Unbinding is explicit and survives a second save; it must not be hidden
    // behind a failed resource catalogue request.
    await page.getByRole('tab', { name: /^资源绑定/ }).click()
    await page
      .locator('.work-agent-manager__resource-nav')
      .getByRole('button', { name: /^技能/ })
      .click()
    await group('技能').getByRole('checkbox').first().uncheck()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.get(id!)?.skills).toEqual([])

    await page.getByRole('button', { name: '使用 Agent 独立配置 Agent', exact: true }).click()
    await work()
      .getByRole('textbox', { name: '任务目标', exact: true })
      .fill('AGENT_RESOURCE_REQUEST')
    const previous = chatRequests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(previous + 1)
    const request = chatRequests.at(-1)!
    expect(request.agentId).toBe(id)
    expect(request.skills).toBeUndefined()
    // Agent bindings are resolved by the engine from agentId. Work must leave
    // these request-level overrides undefined so an empty composer resource
    // list cannot erase the persisted Agent configuration.
    expect(request.mcpServers).toBeUndefined()
    expect(request.knowledgeBases).toBeUndefined()
    expect(request.allowedTools).toBeUndefined()
    frame(request.sessionId, { content: 'AGENT_RESOURCE_REQUEST_OK' })
    finish(request.sessionId)
    await expect(runStatus()).toHaveCount(0)
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: '删除 Agent 独立配置 Agent', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect.poll(() => fixtureAgents.has(id!)).toBe(false)
  })

  test('Agent 可创建编辑选择和删除，首次发送后绑定固定且保留隐藏资源配置', async ({}, testInfo) => {
    // Each serial test owns its starting surface; previous cases may end on Code
    // after a reload or settings check.
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await agentCreateEntry('dialog').click()
    await page.getByLabel('名称', { exact: true }).fill('Work review agent')
    await page.getByLabel('用途', { exact: true }).fill('审查实现与边界')
    await page.getByLabel('工作指令', { exact: true }).fill('阅读文件并检查测试，给出具体反馈。')
    // Agent 编辑弹窗中的 Select 也是 portal 浮层；它必须压在 modal-overlay
    // 之上，否则菜单会被遮罩盖住，看起来像是"跑到后面"。
    await page.getByRole('button', { name: 'Agent 默认模型', exact: true }).click()
    const agentModelMenu = page.locator('.popover__panel.work-agent-manager__model-panel')
    await expect(agentModelMenu).toBeVisible()
    const layerOrder = await agentModelMenu.evaluate((menu) => {
      const overlay = document.querySelector<HTMLElement>('.modal-overlay')
      return {
        menuZ: Number.parseInt(getComputedStyle(menu).zIndex || '0', 10),
        overlayZ: Number.parseInt(overlay ? getComputedStyle(overlay).zIndex || '0' : '0', 10)
      }
    })
    expect(layerOrder.menuZ).toBeGreaterThan(layerOrder.overlayZ)
    await page.screenshot({
      path: testInfo.outputPath('work-agent-model-menu-layer.png'),
      animations: 'disabled'
    })
    await page.getByRole('menuitem', { name: '使用任务模型', exact: true }).click()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.size).toBe(1)
    const id = [...fixtureAgents.keys()][0]
    expect(fixtureAgents.get(id)?.systemPrompt).toBe('阅读文件并检查测试，给出具体反馈。')
    // A removed/unavailable skill on an existing Agent must survive unrelated edits.
    fixtureAgents.set(id, { ...fixtureAgents.get(id), skills: ['keep-existing-skill'] })
    await page.getByRole('button', { name: '编辑 Agent Work review agent', exact: true }).click()
    await page.getByLabel('名称', { exact: true }).fill('Work persistent reviewer')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.get(id)?.name).toBe('Work persistent reviewer')
    expect(fixtureAgents.get(id)).toMatchObject({
      allowedTools: fixtureTools.map((tool) => tool.name),
      skills: ['keep-existing-skill']
    })
    for (const appearance of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings
        .getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true })
        .click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
      await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(860, 720)
      )
      const metrics = await page.locator('.work-agent-manager').evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          bottom: bounds.bottom,
          width: innerWidth,
          height: innerHeight,
          overflow: element.scrollWidth > element.clientWidth + 1
        }
      })
      expect(metrics.left).toBeGreaterThanOrEqual(0)
      expect(metrics.right).toBeLessThanOrEqual(metrics.width)
      expect(metrics.bottom).toBeLessThanOrEqual(metrics.height)
      expect(metrics.overflow).toBe(false)
      await page.screenshot({
        path: testInfo.outputPath(`work-agents-${appearance}-860.png`),
        animations: 'disabled'
      })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await page
      .getByRole('button', { name: '使用 Agent Work persistent reviewer', exact: true })
      .click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_AGENT_BOUND')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.at(-1)?.message).toBe('WORK_AGENT_BOUND')
    expect(chatRequests.at(-1)?.agentId).toBe(id)
    const task = chatRequests.at(-1)!.sessionId
    frame(task, { content: 'WORK_AGENT_BOUND_OK' })
    finish(task)
    await expect(runStatus()).toHaveCount(0)
    await page.reload()
    await expect(work().locator('.work-task-heading__agent')).toHaveText('Work persistent reviewer')
    await page.screenshot({
      path: testInfo.outputPath('work-task-agent-identity.png'),
      animations: 'disabled'
    })
    await expect(work().locator('.work-agent-button')).toHaveCount(0)
    await expect(work().locator('.work-folder-button')).toHaveCount(0)
    await work().getByRole('button', { name: '查看 Agent 配置', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '使用 Agent Work persistent reviewer', exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole('button', { name: '删除 Agent Work persistent reviewer', exact: true })
    ).toBeDisabled()
    await work().getByRole('button', { name: '返回任务', exact: true }).click()
    await expect(work()).toContainText('WORK_AGENT_BOUND_OK')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await page
      .getByRole('button', { name: '删除 Agent Work persistent reviewer', exact: true })
      .click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect.poll(() => fixtureAgents.size).toBe(0)
    await page.getByRole('button', { name: '完成', exact: true }).click()
  })

  test('Agent 在 Work 一级页面提供独立的增删改查入口', async () => {
    const profilesBefore = profileRequests.length
    await switchTo('work')
    await work().getByRole('button', { name: 'Agent', exact: true }).click()
    const pageSurface = work().locator('.work-agent-manager-page')
    await expect(pageSurface.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
    await expect(agentCreateEntry('page')).toBeVisible()
    await agentCreateEntry('page').click()
    await expect
      .poll(() =>
        profileRequests
          .slice(profilesBefore)
          .some((item) => item.path === '/api/v1/tools' && item.profile === 'general')
      )
      .toBe(true)
    await expect(pageSurface.getByLabel('名称', { exact: true })).toBeVisible()
    const existingAgentIds = [...fixtureAgents.keys()]
    await pageSurface.getByLabel('名称', { exact: true }).fill('一级 Agent 页面返回草稿')
    await pageSurface.getByRole('button', { name: '返回 Agent 列表', exact: true }).click()
    await expect(pageSurface.getByLabel('名称', { exact: true })).toHaveValue('一级 Agent 页面返回草稿')
    await expect(pageSurface.getByText('放弃尚未保存的配置？', { exact: true })).toBeVisible()
    await pageSurface.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(pageSurface.getByLabel('名称', { exact: true })).toHaveValue('一级 Agent 页面返回草稿')
    expect([...fixtureAgents.keys()]).toEqual(existingAgentIds)
    await pageSurface.getByRole('tab', { name: /^资源绑定/ }).click()
    await expect(
      pageSurface
        .locator('.work-agent-manager__resource-nav')
        .getByRole('button', { name: /^MCP 服务/ })
    ).toBeVisible()
    await expect(
      pageSurface
        .locator('.work-agent-manager__resource-nav')
        .getByRole('button', { name: /^知识库/ })
    ).toBeVisible()
    await pageSurface.getByRole('tab', { name: /^工具权限/ }).click()
    await expect(pageSurface.locator('legend').filter({ hasText: '工具权限' })).toBeVisible()
    await pageSurface.getByRole('button', { name: '返回 Agent 列表', exact: true }).click()
    await expect(pageSurface.getByText('放弃尚未保存的配置？', { exact: true })).toBeVisible()
    await pageSurface.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(pageSurface.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
    await expect(pageSurface.getByLabel('名称', { exact: true })).toHaveCount(0)
    await expect(agentCreateEntry('page')).toBeVisible()
    await expect(agentCreateEntry('page')).toBeEnabled()
    expect([...fixtureAgents.keys()]).toEqual(existingAgentIds)
    expect([...fixtureAgents.values()].some(agent => agent.name === '一级 Agent 页面返回草稿')).toBe(false)
  })

  test('Agent 编辑页在窄窗可完成资源授权重试、长工具选择与保存失败恢复', async ({}, testInfo) => {
    skillCatalogueDenied = true
    extraFixtureTools = Array.from({ length: 36 }, (_, index) => ({
      name: `work_extra_${index + 1}`,
      displayName: `扩展工具 ${index + 1}`,
      description: `适用于复杂工作流的扩展能力 ${index + 1}，描述应完整换行且允许键盘访问。`
    }))
    try {
      await switchTo('work')
      await work().getByRole('button', { name: 'Agent', exact: true }).click()
      await agentCreateEntry('page').click()
      await page.getByLabel('名称', { exact: true }).fill('流程验证助手')
      await page.getByLabel('工作指令', { exact: true }).fill('保留草稿并完成复杂工作流。')
      for (const [width, height] of [
        [860, 640],
        [1100, 760],
        [1440, 900]
      ]) {
        await app!.evaluate(
          ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]),
          [width, height]
        )
        const bounds = await page.locator('.work-agent-manager--page').evaluate((element) => {
          const footer = element
            .querySelector('.work-agent-manager__page-footer')!
            .getBoundingClientRect()
          const panel = element.querySelector('.work-agent-manager__editor-scroll')!
          return {
            footerBottom: footer.bottom,
            height: innerHeight,
            panelOverflow: panel.scrollWidth - panel.clientWidth,
            pageOverflow: element.scrollWidth - element.clientWidth
          }
        })
        expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.height)
        expect(bounds.panelOverflow).toBeLessThanOrEqual(1)
        expect(bounds.pageOverflow).toBeLessThanOrEqual(1)
        await expect(page.getByRole('button', { name: '保存 Agent', exact: true })).toBeInViewport()
        await page.screenshot({
          path: testInfo.outputPath(`agent-basics-${width}.png`),
          animations: 'disabled'
        })
      }
      await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(860, 640)
      )
      await page.getByRole('tab', { name: /^资源绑定/ }).click()
      await expect(page.locator('.work-agent-manager__resource-error')).toContainText(
        '当前账号无法浏览技能'
      )
      await expect(page.locator('.work-agent-manager__binding-empty')).toHaveCount(0)
      await page.screenshot({
        path: testInfo.outputPath('agent-resource-permission-860.png'),
        animations: 'disabled'
      })
      await page
        .locator('.work-agent-manager__resource-nav')
        .getByRole('button', { name: /^MCP 服务/ })
        .click()
      await page.getByRole('checkbox', { name: /Git 服务/ }).check()
      await page
        .locator('.work-agent-manager__resource-nav')
        .getByRole('button', { name: /^技能/ })
        .click()
      skillCatalogueDenied = false
      await page.getByRole('button', { name: '重试技能', exact: true }).click()
      await page.getByRole('checkbox', { name: /代码审查技能/ }).check()
      await expect(page.locator('.work-agent-manager__resource-error')).toHaveCount(0)
      await page.getByRole('tab', { name: /^工具权限/ }).click()
      await expect(page.getByRole('checkbox', { name: /扩展工具 36 / })).toBeChecked()
      await page.getByRole('button', { name: '仅对话', exact: true }).click()
      await expect(page.locator('.work-agent-manager__notice')).toContainText('只能回复文本')
      await page.getByLabel('搜索工具权限', { exact: true }).fill('扩展工具 36')
      await page.getByRole('checkbox', { name: /扩展工具 36 / }).check()
      await expect(page.getByRole('button', { name: '保存 Agent', exact: true })).toBeInViewport()
      await page.screenshot({
        path: testInfo.outputPath('agent-tools-search-860.png'),
        animations: 'disabled'
      })
      await page.getByRole('tab', { name: '基础配置', exact: true }).click()
      await expect(page.getByLabel('名称', { exact: true })).toHaveValue('流程验证助手')
      failNextAgentSave = true
      await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
      await expect(page.locator('.work-agent-manager__error')).toContainText('AGENT_SAVE_RETRY')
      await expect(page.getByLabel('名称', { exact: true })).toHaveValue('流程验证助手')
      await page.getByLabel('名称', { exact: true }).press('Control+s')
      await expect(
        page.getByRole('button', { name: '编辑 Agent 流程验证助手', exact: true })
      ).toBeVisible()
      const saved = [...fixtureAgents.values()].find((agent) => agent.name === '流程验证助手')
      expect(saved).toMatchObject({
        allowedTools: ['work_extra_36'],
        skills: ['代码审查技能'],
        mcpServers: ['mcp-git'],
        systemPrompt: '保留草稿并完成复杂工作流。'
      })
      await page.getByRole('button', { name: '删除 Agent 流程验证助手', exact: true }).click()
      await page.getByRole('button', { name: '确认删除', exact: true }).click()
      await expect
        .poll(() => [...fixtureAgents.values()].some((agent) => agent.name === '流程验证助手'))
        .toBe(false)
    } finally {
      skillCatalogueDenied = false
      extraFixtureTools = []
      failNextAgentSave = false
      await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
      )
    }
  })

  test('Agent 弹窗键盘切换保留配置，关闭编辑器须明确放弃草稿', async () => {
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await agentCreateEntry('dialog').click()
    const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true })
    await dialog.getByLabel('名称', { exact: true }).fill('尚未保存的键盘配置')
    await dialog.getByRole('tab', { name: '基础配置', exact: true }).press('ArrowRight')
    await expect(dialog.getByRole('tab', { name: /^资源绑定/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.keyboard.press('Escape')
    await expect(dialog.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click()
    await dialog.getByRole('tab', { name: '基础配置', exact: true }).click()
    await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('尚未保存的键盘配置')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect([...fixtureAgents.values()].some((agent) => agent.name === '尚未保存的键盘配置')).toBe(
      false
    )
  })

  test('润色期间切换任务可再次润色，旧回复不能覆盖新任务草稿', async () => {
    const original = await startTask('WORK_POLISH_ORIGINAL')
    frame(original, { content: 'WORK_POLISH_READY' })
    finish(original)
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('旧任务的草稿')
    const before = utilityRequests.length
    await work().getByRole('button', { name: 'AI 润色输入', exact: true }).click()
    await expect.poll(() => utilityRequests.length).toBe(before + 1)
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const homeInput = work().getByRole('textbox', { name: '任务目标', exact: true })
    await homeInput.fill('新任务的草稿')
    await expect(work().getByRole('button', { name: 'AI 润色输入', exact: true })).toBeEnabled()
    utilityRequests[before].response.setHeader('content-type', 'application/json')
    utilityRequests[before].response.end(envelope({ text: '不该覆盖的新文本' }))
    await work().getByRole('button', { name: 'AI 润色输入', exact: true }).click()
    await expect.poll(() => utilityRequests.length).toBe(before + 2)
    expect(utilityRequests[before + 1].body.userPrompt).toBe('新任务的草稿')
    utilityRequests[before + 1].response.setHeader('content-type', 'application/json')
    utilityRequests[before + 1].response.end(envelope({ text: '新任务的润色结果' }))
    await expect(homeInput).toHaveText('新任务的润色结果')
  })

  test('对话中的活动原位展开，共享 Code 紧凑工具行且新回复不会抢走阅读位置', async ({}, testInfo) => {
    const id = await startTask('WORK_INLINE_ACTIVITY：检查 TypeScript 实现')
    frame(id, { content: '先读取实现，再检查需要修改的地方。' })
    frame(id, { toolStart: { id: 'inline-read', name: 'read_file', args: { path: 'src/app.ts' } } })
    frame(id, { toolEnd: { id: 'inline-read', name: 'read_file', output: 'export const INLINE_ACTIVITY_RESULT = 42;\n', success: true } })
    frame(id, { content: '\n\n读取完成，继续分析。' })
    const workspaceBefore = await work().locator('.work-workspace [role="tab"][aria-selected="true"]').allTextContents()
    const group = work().locator('.work-inline-activity').first()
    await expect(group.locator('.work-process')).toHaveAttribute('aria-expanded', 'false')
    await group.locator('.work-process').click()
    await expect(group.getByRole('region', { name: '活动详情', exact: true })).toBeVisible()
    expect(await work().locator('.work-workspace [role="tab"][aria-selected="true"]').allTextContents()).toEqual(workspaceBefore)
    const row = group.locator('.logline-wrap').filter({ hasText: '读取文件' })
    const toggle = row.locator('button.logline')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(row.locator('.logline__detail')).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(row.locator('.logline__detail pre')).toHaveText('export const INLINE_ACTIVITY_RESULT = 42;\n')
    // Routine receipts should use Code's result-only view, with no repeated
    // input/output headings, copy toolbars or enclosing Markdown/JSON cards.
    await expect(group.locator('.work-inline-activity__head')).toHaveCount(0)
    await expect(group.locator('.work-inline-activity__text, .md-code')).toHaveCount(0)
    await expect(group.getByRole('button', { name: '复制完整输出', exact: true })).toHaveCount(0)
    const scroll = work().locator('.work-conversation__scroll')
    const before = await scroll.evaluate(element => element.scrollTop)
    frame(id, { content: Array.from({ length: 24 }, (_, index) => `\n\n新增分析 ${index}：保持已打开的工具阅读位置。`).join('') })
    await expect(work()).toContainText('新增分析 23')
    expect(await scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(before + 2)
    await expect(group.locator('.work-process')).toHaveAttribute('aria-expanded', 'true')
    await page.screenshot({ path: testInfo.outputPath('work-inline-activity-expanded.png'), animations: 'disabled' })
    finish(id)
    await expect(runStatus()).toHaveCount(0)
    await group.locator('.work-process').click()
    await expect(group.locator('.work-inline-activity__body')).toHaveCount(0)
  })

  test('紧凑工具行保留运行失败取消状态，长结果可滚动且窄窗键盘操作不溢出', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(860, 640))
    const id = await startTask('WORK_COMPACT_TOOLS：核对长输出和工具生命周期')
    try {
      frame(id, { content: '先读取大文件，再检查命令执行和已取消操作。' })
      const longPath = `src/${'nested-directory/'.repeat(20)}large-output.ts`
      frame(id, { toolStart: { id: 'compact-long-read', name: 'read_file', args: { path: longPath } } })
      const group = work().locator('.work-inline-activity').first()
      await group.locator('.work-process').click()
      const read = group.locator('.logline-wrap').filter({ hasText: '读取文件' })
      await expect(read).toContainText('运行中')
      await expect(read.locator('pre')).toHaveCount(0)
      const longOutput = `WORK_COMPACT_LONG_BEGIN\n${Array.from({ length: 600 }, (_, index) => `line ${index}: ${'retained output '.repeat(8)}`).join('\n')}\nWORK_COMPACT_LONG_END`
      frame(id, { toolEnd: { id: 'compact-long-read', name: 'read_file', output: longOutput, success: true, durationMs: 51 } })
      await expect(read).toContainText('成功')
      await expect(read.locator('button.logline')).toContainText('51 ms')
      await expect(read.locator('.logline__detail')).toHaveCount(0)
      const readToggle = read.locator('button.logline')
      await readToggle.focus()
      await readToggle.press('Enter')
      await expect(readToggle).toHaveAttribute('aria-expanded', 'true')
      const output = read.locator('.logline__detail pre')
      await expect(output).toHaveText(longOutput)
      await expect.poll(() => output.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      const outputBounds = await output.boundingBox()
      expect(outputBounds?.height).toBeLessThanOrEqual(260)
      await output.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect.poll(() => output.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true)
      await readToggle.press('Space')
      await expect(readToggle).toHaveAttribute('aria-expanded', 'false')

      frame(id, { toolStart: { id: 'compact-failed-command', name: 'execute_cmd', args: { command: 'node', args: ['verify-work.js'] } } })
      frame(id, { toolEnd: { id: 'compact-failed-command', name: 'execute_cmd', output: 'WORK_COMPACT_COMMAND_OUTPUT', success: false, error: { message: 'WORK_COMPACT_COMMAND_FAILED：校验脚本未通过' } } })
      const failed = group.locator('.logline-wrap').filter({ hasText: '执行命令' })
      await expect(failed).toContainText('失败')
      await expect(failed.locator('.logline__detail')).toHaveCount(0)
      await failed.locator('button.logline').click()
      await expect(failed.locator('.message__error')).toHaveText('WORK_COMPACT_COMMAND_FAILED：校验脚本未通过')
      await expect(failed.locator('pre')).toHaveText('WORK_COMPACT_COMMAND_OUTPUT')
      await failed.locator('button.logline').click()

      frame(id, { toolStart: { id: 'compact-cancelled-list', name: 'list_files', args: { path: 'cancelled-search' } } })
      frame(id, { toolEnd: { id: 'compact-cancelled-list', name: 'list_files', output: 'WORK_COMPACT_CANCELLED：用户已停止目录检索', status: 'cancelled' } })
      const cancelled = group.locator('.logline-wrap').filter({ hasText: '列出文件' })
      await expect(cancelled).toContainText('已取消')
      await expect(cancelled.locator('button.logline')).not.toContainText('成功')
      await cancelled.locator('button.logline').click()
      await expect(cancelled.locator('pre')).toHaveText('WORK_COMPACT_CANCELLED：用户已停止目录检索')
      await expect(group.locator('.logline')).toHaveCount(3)
      await expect(group.locator('.compact-tool-row')).toHaveCount(3)
      await expect(group.locator('.work-inline-activity__text, .md-code')).toHaveCount(0)
      const rowBounds = await readToggle.boundingBox()
      expect(rowBounds?.height).toBeLessThanOrEqual(28)
      expect(await group.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
      await page.screenshot({ path: testInfo.outputPath('work-compact-tools-860.png'), animations: 'disabled' })
      finish(id)
      await expect(runStatus()).toHaveCount(0)
      await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeEnabled()
    } finally {
      if (session(id).run?.status === 'running') finish(id, 'cancelled')
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    }
  })

  test('活动文件卡片支持键盘展开并保留阅读位置，路径打开当前 Work 成果', async () => {
    const id = await startTask('WORK_INLINE_FILE：生成 TypeScript 文件')
    const path = '/remote/work-mode-fixture/inline-module.ts'
    frame(id, { content: '生成文件并检查差异。' })
    frame(id, { toolStart: { id: 'inline-file-write', name: 'write_file', args: { path: 'inline-module.ts' } } })
    frame(id, { fileChange: {
      id: 'inline-file-receipt', toolCallId: 'inline-file-write', path, displayPath: 'inline-module.ts',
      kind: 'write', oldContent: null, newContent: 'export const WORK_INLINE_FILE_RESULT = 42;\n',
      isNew: true, truncated: false, status: 'kept', createdAt: Date.now()
    } })
    frame(id, { toolEnd: { id: 'inline-file-write', name: 'write_file', output: '文件已写入', success: true } })
    const group = work().locator('.work-inline-activity').first()
    await group.locator('.work-process').click()
    const header = group.getByRole('button', { name: '新建文件 inline-module.ts', exact: true })
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await header.focus()
    await header.press('Space')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await work().getByRole('button', { name: '回到最新', exact: true }).click()
    await header.focus()
    await header.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    const scroll = work().locator('.work-conversation__scroll')
    const before = await scroll.evaluate(element => element.scrollTop)
    frame(id, { content: Array.from({ length: 24 }, (_, index) => `\n\n文件检查 ${index}：键盘展开后保持阅读位置。`).join('') })
    await expect(work()).toContainText('文件检查 23')
    expect(await scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(before + 2)
    const open = group.locator('.diff-card__path')
    await expect(open).toBeEnabled()
    await open.click()
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await expect(work().getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_INLINE_FILE_RESULT')
    finish(id)
    await expect(runStatus()).toHaveCount(0)
  })

  test('@Agent 在固定主任务中参与协作，重复调用与详情续跑保留同一上下文', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await switchTo('work')
    const mainId = 'collaboration-main', frontId = 'collaboration-front', backId = 'collaboration-back'
    fixtureAgents.set(mainId, { id: mainId, name: '主任务协调员', description: '汇总协作结果' })
    fixtureAgents.set(frontId, { id: frontId, name: '前端协作工程师', description: '开发页面与交互' })
    fixtureAgents.set(backId, { id: backId, name: '后端协作工程师', description: '开发接口与数据' })
    try {
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
      await page.getByRole('button', { name: '使用 Agent 主任务协调员', exact: true }).click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_COLLABORATION_MAIN')
      const start = chatRequests.length
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(start + 1)
      const id = chatRequests.at(-1)!.sessionId
      expect(chatRequests.at(-1)?.agentId).toBe(mainId)
      frame(id, { content: '主任务已就绪，可以邀请其他 Agent 协作。' })
      finish(id)
      await expect(runStatus()).toHaveCount(0)
      const input = work().getByRole('textbox', { name: '继续对话', exact: true })
      const invite = async (name: string, first = false): Promise<void> => {
        if (first) await input.fill('@agent')
        else { await input.press('End'); await page.keyboard.insertText(' @agent') }
        await page.getByRole('option', { name: new RegExp(name) }).click()
        await expect(input.locator('[data-mention-key]').filter({ hasText: name })).toHaveCount(1)
      }
      await invite('前端协作工程师', true)
      await invite('后端协作工程师')
      await input.press('End')
      await page.keyboard.insertText(' 分别实现页面与接口，并返回独立结果。')
      const firstSend = chatRequests.length
      await work().getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(firstSend + 1)
      expect(chatRequests.at(-1)?.agentId).toBe(mainId)
      expect(chatRequests.at(-1)?.collaborators, JSON.stringify(chatRequests.at(-1))).toEqual([{ agentId: frontId }, { agentId: backId }])
      await expect(work().locator('.work-task-heading__agent')).toHaveText('主任务协调员')
      const inviteMessage = work().locator('.work-message--user').last()
      await expect(inviteMessage.locator('.mention-chip--agent')).toHaveText(['前端协作工程师', '后端协作工程师'])
      await expect(inviteMessage).not.toContainText('aether-refs')
      const childRun = (agentId: string, name: string, runId: string, childSessionId: string, previous?: string): SubagentRun => ({
        schemaVersion: 1, runId, tenantId: 'fixture', rootSessionId: id, parentSessionId: id,
        parentConversationId: session(id).run!.turnId, parentMessageId: session(id).run!.assistantMessageId,
        parentToolCallId: `${runId}-tool`, childSessionId, resumeFromRunId: previous,
        agentId, agentName: name, continuation: { readOnly: false }, task: '完成分配的工作', description: name,
        modelId, status: 'running', lastSeq: 1, createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(),
        usage: {}, toolCalls: [{ id: `${runId}-read`, name: 'read_file', args: { path: 'src/app.ts' }, status: 'running' }],
        partialOutput: '正在检查接口与实现。'
      })
      const publish = (run: SubagentRun, kind: string): void => {
        frame(id, { subagentEvent: { schemaVersion: 1, kind, runId: run.runId, seq: run.lastSeq, snapshot: run } })
      }
      const complete = (run: SubagentRun, result: string): SubagentRun => ({ ...run, status: 'succeeded', lastSeq: run.lastSeq + 1,
        updatedAt: Date.now(), finishedAt: Date.now(), durationMs: 1200, resultSummary: result,
        toolCalls: run.toolCalls.map(call => ({ ...call, status: 'succeeded', output: '读取内容成功' })) })
      const front = childRun(frontId, '前端协作工程师', 'collab-front-1', 'collab-front-context')
      const back = childRun(backId, '后端协作工程师', 'collab-back-1', 'collab-back-context')
      publish(front, 'started'); publish(back, 'started')
      if (!await work().locator('.work-workspace').count()) {
        await work().getByRole('button', { name: '打开工作区', exact: true }).click()
      }
      const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
      const subagentsTab = workspace.getByRole('tablist', { name: '工作区内容', exact: true }).getByRole('tab', { name: '子代理', exact: true })
      await subagentsTab.click()
      await expect(subagentsTab).toHaveAttribute('aria-selected', 'true')
      const panel = workspace.getByRole('tabpanel', { name: '子代理', exact: true }).getByRole('region', { name: '协作代理', exact: true })
      await expect(panel.locator('.work-subagents__row')).toHaveCount(2)
      await expect(panel.getByRole('region', { name: '正在运行的子代理', exact: true })).toContainText('前端协作工程师')
      await panel.getByRole('button', { name: '查看 前端协作工程师 子代理详情', exact: true }).click()
      await expect(panel).toContainText('正在读取文件')
      // Keep the same child history throughout: opening its transcript early
      // must not replace a short archive with invented earlier records later.
      const frontHistory: EngineHistoryRow[] = [
        ...Array.from({ length: 58 }, (_, index): EngineHistoryRow => ({ id: `front-record-${index}`, role: index % 2 ? 'assistant' : 'user', content: `EARLIER_COLLABORATION_${index}：保留上下文记录` })),
        { id: 'front-tool-call', role: 'assistant', content: '', toolCall: { id: 'front-history-tool', name: 'read_file', args: { path: 'src/app.ts' } } },
        { id: 'front-tool-output', role: 'tool', content: 'ARCHIVED_TOOL_OUTPUT：源码读取成功', toolCallId: 'front-history-tool', success: true },
        { id: 'front-full-result', role: 'assistant', content: 'RUNNING_CHILD_TRANSCRIPT：正在检查接口与实现。' }
      ]
      fixtureTranscripts.set(front.childSessionId, frontHistory)
      const live = panel.locator('.work-subagents__live')
      const liveSpinner = live.locator(':scope > .ui-spinner')
      const spinnerMeasurements: Array<Record<string, unknown>> = []
      // Read computed dimensions before rotation: a stretched ellipse can have a
      // deceptively small bounding box at one animation frame.
      for (const appearance of ['dark', 'light'] as const) {
        await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
        await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1100, height: 760 }, { width: 940, height: 640 }]) {
          await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), { width, height })
          await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
          if (!await workspace.isVisible()) {
            await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区(?: · \d+)?$/, exact: true }).click()
          }
          await expect(workspace, `${appearance}/${width}: workspace visible`).toBeVisible()
          await expect(subagentsTab, `${appearance}/${width}: selected workspace tab survives resize`).toHaveAttribute('aria-selected', 'true')
          for (const detailView of ['工作轮次', '完整对话'] as const) {
            await panel.getByRole('button', { name: detailView, exact: true }).click()
            if (detailView === '完整对话') await expect(panel).toContainText('RUNNING_CHILD_TRANSCRIPT')
            for (const reducedMotion of ['no-preference', 'reduce'] as const) {
              await page.emulateMedia({ reducedMotion })
              const context = `${appearance}/${width}/${detailView}/${reducedMotion}`
              await expect(live, context).toBeInViewport()
              await expect(liveSpinner, context).toHaveCount(1)
              await expect(liveSpinner, context).toHaveCSS('width', '14px')
              await expect(liveSpinner, context).toHaveCSS('height', '14px')
              await expect(liveSpinner, context).toHaveCSS('flex-grow', '0')
              await expect(liveSpinner, context).toHaveCSS('flex-shrink', '0')
              await expect(liveSpinner, context).toHaveCSS('animation-name', reducedMotion === 'reduce' ? 'none' : 'ui-spinner-rotate')
              const metrics = await live.evaluate(element => {
                const spinner = element.querySelector(':scope > .ui-spinner')
                const label = element.querySelector('.work-subagents__live-label')
                if (!spinner || !label) throw new Error('Missing live subagent status controls')
                const style = getComputedStyle(spinner)
                return {
                  width: style.width, height: style.height, flexGrow: style.flexGrow,
                  viewportWidth: innerWidth, viewportHeight: innerHeight,
                  textFlexGrow: getComputedStyle(label).flexGrow,
                  overflow: element.scrollWidth - element.clientWidth,
                  runningAnimations: spinner.getAnimations().filter(animation => animation.playState === 'running').length
                }
              })
              expect(metrics.textFlexGrow, context).toBe('1')
              expect(metrics.overflow, context).toBeLessThanOrEqual(1)
              expect(metrics.runningAnimations, context).toBe(reducedMotion === 'reduce' ? 0 : 1)
              spinnerMeasurements.push({ appearance, requestedWidth: width, requestedHeight: height, detailView, reducedMotion, ...metrics })
            }
          }
          await page.screenshot({ path: testInfo.outputPath(`work-subagent-live-${appearance}-${width}.png`), animations: 'disabled' })
        }
      }
      const spinnerGeometryPath = testInfo.outputPath('work-subagent-live-spinner-geometry.json')
      writeFileSync(spinnerGeometryPath, JSON.stringify(spinnerMeasurements, null, 2))
      await testInfo.attach('work-subagent-live-spinner-geometry', { path: spinnerGeometryPath, contentType: 'application/json' })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
      await panel.getByRole('button', { name: '工作轮次', exact: true }).click()
      const frontDone = complete(front, 'FRONT_FIRST_RESULT：完成页面与交互。')
      publish(frontDone, 'finished')
      publish(complete(back, 'BACK_FIRST_RESULT：完成接口与数据。'), 'finished')
      frame(id, { content: '协作结果已汇总。' }); finish(id)
      await expect(panel).toContainText('FRONT_FIRST_RESULT')
      await expect(live).toHaveCount(0)
      await expect(runStatus()).toHaveCount(0)
      await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click()
      await expect(panel.getByRole('region', { name: '已结束的子代理', exact: true }).locator('.work-subagents__row')).toHaveCount(2)
      await invite('前端协作工程师', true)
      await input.press('End'); await page.keyboard.insertText(' 继续完善上一轮页面。')
      const repeated = chatRequests.length
      await work().getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(repeated + 1)
      expect(chatRequests.at(-1)?.collaborators).toEqual([{ agentId: frontId }])
      const second = childRun(frontId, '前端协作工程师', 'collab-front-2', front.childSessionId, front.runId)
      publish(second, 'started')
      await expect(panel.locator('.work-subagents__row')).toHaveCount(2)
      await panel.getByRole('button', { name: '查看 前端协作工程师 子代理详情', exact: true }).click()
      publish(complete(second, 'FRONT_SECOND_RESULT：沿用原上下文完善页面。'), 'finished')
      frame(id, { content: '第二轮完成。' }); finish(id)
      await expect(panel.locator('.work-subagents__round')).toHaveCount(2)
      await expect(panel).toContainText('FRONT_SECOND_RESULT')
      await expect(runStatus()).toHaveCount(0)
      fixtureTranscripts.set(front.childSessionId, frontHistory.map(row => row.id === 'front-full-result'
        ? { ...row, content: `${'完整产出记录。'.repeat(2200)}\n\nFULL_CHILD_TRANSCRIPT_END：超过快照上限的尾部仍可查看。` }
        : row))
      await panel.getByRole('button', { name: '完整对话', exact: true }).click()
      await expect(panel.getByRole('button', { name: '完整对话', exact: true })).toBeFocused()
      const transcript = panel.getByRole('region', { name: '前端协作工程师 的完整对话', exact: true })
      await expect(transcript).toContainText('当前窗口 11 / 61 条记录')
      await transcript.getByRole('button', { name: '加载更早记录', exact: true }).click()
      await expect(transcript.locator('[data-transcript-id="front-record-0"]')).toContainText('EARLIER_COLLABORATION_0')
      const fullResult = transcript.locator('[data-transcript-id="front-full-result"]')
      await expect(fullResult).not.toContainText('FULL_CHILD_TRANSCRIPT_END')
      while (await fullResult.getByRole('button', { name: /^继续展开/ }).count()) {
        await fullResult.getByRole('button', { name: /^继续展开/ }).click()
      }
      await expect(fullResult).toContainText('FULL_CHILD_TRANSCRIPT_END')
      await transcript.locator('[data-transcript-id="front-tool-output"] summary').click()
      await expect(transcript).toContainText('ARCHIVED_TOOL_OUTPUT')
      failNextTranscript = true
      await transcript.getByRole('button', { name: '更新子代理完整对话', exact: true }).click()
      await expect(transcript.getByRole('alert')).toContainText('TRANSCRIPT_RETRY')
      await expect(fullResult).toContainText('FULL_CHILD_TRANSCRIPT_END')
      await transcript.getByRole('button', { name: '重试读取', exact: true }).click()
      await expect(transcript.getByRole('alert')).toHaveCount(0)
      await expect(panel.getByRole('textbox', { name: '继续交给 前端协作工程师', exact: true })).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath('work-subagent-full-transcript.png'), animations: 'disabled' })
      await panel.getByRole('button', { name: '工作轮次', exact: true }).click()
      await input.fill('未发送的主任务草稿应保留')
      const followup = panel.getByRole('textbox', { name: '继续交给 前端协作工程师', exact: true })
      await followup.fill('THIRD_ROUND：继续检查可访问性')
      const continued = chatRequests.length
      await followup.press('Control+Enter')
      await expect.poll(() => chatRequests.length).toBe(continued + 1)
      expect(chatRequests.at(-1)?.collaborators).toEqual([{ resumeRunId: second.runId }])
      expect(chatRequests.at(-1)?.message).toBe('THIRD_ROUND：继续检查可访问性')
      expect(chatRequests.at(-1)?.agentId).toBe(mainId)
      const third = childRun(frontId, '前端协作工程师', 'collab-front-3', front.childSessionId, second.runId)
      publish(third, 'started')
      await expect(panel.locator('.work-subagents__round')).toHaveCount(3)
      await panel.getByRole('button', { name: '停止本轮', exact: true }).click()
      await expect.poll(() => fixtureSubagents.get(third.runId)?.status).toBe('cancelled')
      await expect(panel.locator('.work-subagents__heading [role="status"]')).toHaveText('已取消')
      await expect(live).toHaveCount(0)
      frame(id, { content: '已停止子代理本轮。' }); finish(id)
      await expect(runStatus()).toHaveCount(0)
      await expect(input).toHaveText('未发送的主任务草稿应保留')
      await panel.getByRole('button', { name: '工作轮次', exact: true }).click()
      const collaborationBackgrounds: string[] = []
      for (const appearance of ['dark', 'light'] as const) {
        await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(860, 640))
        await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
        await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        collaborationBackgrounds.push(await panel.evaluate(element => getComputedStyle(element).backgroundColor))
        const bounds = await panel.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, bottom: element.getBoundingClientRect().bottom, height: innerHeight }))
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1)
        await expect(followup).toBeInViewport()
        await page.screenshot({ path: testInfo.outputPath(`work-collaboration-${appearance}-860.png`), animations: 'disabled' })
      }
      expect(collaborationBackgrounds[0]).not.toBe(collaborationBackgrounds[1])
      await page.reload()
      await expect(work().locator('.work-task-heading__agent')).toHaveText('主任务协调员')
      await expect(work().locator('.work-subagents__row')).toHaveCount(2)
      await work().getByRole('button', { name: '查看 前端协作工程师 子代理详情', exact: true }).click()
      await expect(work().locator('.work-subagents__round')).toHaveCount(3)
    } finally {
      fixtureAgents.delete(mainId); fixtureAgents.delete(frontId); fixtureAgents.delete(backId)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    }
  })

  test('快速切换以最后一次选择为准，减少动态效果时不运行过渡', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('tablist', { name: '应用模式', exact: true }).evaluate((element) => {
      const buttons = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
      for (let index = 0; index < 10; index++) buttons[index % 2].click()
      buttons.find((button) => button.textContent?.includes('Work'))?.click()
    })
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.mode-surface[data-mode="code"]')).toBeHidden()
    expect(
      await work().evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === 'running').length
      )
    ).toBe(0)
    await codeMode().focus()
    await page.keyboard.press('ArrowRight')
    await expect(workMode()).toBeFocused()
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(errors).toEqual([])
  })

  test('Code 与 Work 首页和任务页复用输入框，润色在右上角且窄窗工具条对齐', async ({}, testInfo) => {
    const title = 'WORK_SHARED_COMPOSER_GEOMETRY'
    const id = await startTask(title)
    frame(id, { content: '共享输入框布局验证就绪。' })
    finish(id)
    await expect(runStatus()).toHaveCount(0)

    const measure = async (mode: 'code' | 'work') => {
      const surface = page.locator(`.mode-surface[data-mode="${mode}"] .input-composer`)
      await expect(page.locator(`.mode-surface[data-mode="${mode}"]`)).toHaveCSS('opacity', '1')
      await expect(surface).toHaveCount(1)
      await expect(surface).toBeInViewport()
      await expect(surface.getByRole('button', { name: 'AI 润色输入', exact: true })).toBeEnabled()
      // Compare final theme/focus colors rather than sampling two different
      // frames of the focus-border transition.
      await expect.poll(() => surface.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0)
      return surface.evaluate((element) => {
        const toolbar = element.querySelector('.input-composer__toolbar')
        const polish = element.querySelector('[aria-label="AI 润色输入"]')
        const model = element.querySelector('.model-picker .select__trigger')
        const send = element.querySelector('.chat__send')
        if (!toolbar || !polish || !model || !send) throw new Error('Missing shared composer controls')
        const box = (node: Element) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        }
        const style = getComputedStyle(element), polishStyle = getComputedStyle(polish), sendStyle = getComputedStyle(send)
        return {
          surface: box(element), toolbar: box(toolbar), polish: box(polish), model: box(model), send: box(send),
          overflow: element.scrollWidth - element.clientWidth,
          viewport: { width: innerWidth, height: innerHeight },
          toolbarButtons: [...toolbar.querySelectorAll('button')].map(box).filter(rect => rect.width > 0 && rect.height > 0),
          sharedStyle: {
            background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius,
            shadow: style.boxShadow, padding: style.padding,
            polishColor: polishStyle.color, polishWidth: box(polish).width, polishHeight: box(polish).height,
            sendColor: sendStyle.color, sendBackground: sendStyle.backgroundColor, sendRadius: sendStyle.borderRadius,
            sendWidth: box(send).width, sendHeight: box(send).height
          }
        }
      })
    }
    const check = (metrics: Awaited<ReturnType<typeof measure>>, context: string) => {
      expect(metrics.overflow, `${context}: composer overflow`).toBeLessThanOrEqual(1)
      expect(metrics.surface.left, `${context}: left viewport edge`).toBeGreaterThanOrEqual(-1)
      expect(metrics.surface.right, `${context}: right viewport edge`).toBeLessThanOrEqual(metrics.viewport.width + 1)
      expect(metrics.surface.bottom, `${context}: bottom viewport edge`).toBeLessThanOrEqual(metrics.viewport.height + 1)
      expect(metrics.polish.left, `${context}: polish belongs in right half`).toBeGreaterThan(metrics.surface.left + metrics.surface.width / 2)
      expect(metrics.polish.top, `${context}: polish top inset`).toBeGreaterThan(metrics.surface.top)
      expect(metrics.polish.bottom, `${context}: polish stays above footer`).toBeLessThanOrEqual(metrics.toolbar.top)
      expect(metrics.polish.top - metrics.surface.top, `${context}: polish stays in upper half`).toBeLessThan(metrics.surface.height / 2)
      expect(Math.abs((metrics.model.top + metrics.model.bottom) / 2 - (metrics.send.top + metrics.send.bottom) / 2), `${context}: model/send alignment`).toBeLessThanOrEqual(1)
      expect(metrics.model.right, `${context}: model/send do not overlap`).toBeLessThanOrEqual(metrics.send.left)
      expect(metrics.toolbarButtons.length, `${context}: toolbar contains real controls`).toBeGreaterThanOrEqual(3)
      const toolbarCenter = (metrics.toolbar.top + metrics.toolbar.bottom) / 2
      for (const control of metrics.toolbarButtons) {
        expect(control.left, `${context}: control stays inside surface`).toBeGreaterThanOrEqual(metrics.surface.left)
        expect(control.right, `${context}: control stays inside surface`).toBeLessThanOrEqual(metrics.surface.right)
        expect(Math.abs((control.top + control.bottom) / 2 - toolbarCenter), `${context}: controls share a baseline`).toBeLessThanOrEqual(1)
      }
      for (let index = 0; index < metrics.toolbarButtons.length; index++) {
        for (let other = index + 1; other < metrics.toolbarButtons.length; other++) {
          const first = metrics.toolbarButtons[index], second = metrics.toolbarButtons[other]
          expect(Math.min(first.right, second.right) - Math.max(first.left, second.left), `${context}: toolbar controls do not overlap`).toBeLessThanOrEqual(1)
        }
      }
    }
    try {
      for (const appearance of ['dark', 'light'] as const) {
        await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
        await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        for (const width of [1440, 940]) {
          await app!.evaluate(({ BrowserWindow }, windowWidth) => BrowserWindow.getAllWindows()[0]?.setSize(windowWidth, windowWidth === 940 ? 600 : 900), width)
          await switchTo('code')
          await page.locator('.mode-surface[data-mode="code"] .chat__input').fill('CODE_SHARED_COMPOSER_DRAFT')
          const code = await measure('code')
          check(code, `${appearance}/${width}/Code`)
          await switchTo('work')
          await work().getByRole('button', { name: '新任务', exact: true }).click()
          await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_SHARED_HOME_DRAFT')
          const home = await measure('work')
          check(home, `${appearance}/${width}/Work home`)
          expect(home.sharedStyle).toEqual(code.sharedStyle)
          await selectWorkTask(title)
          await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('WORK_SHARED_ACTIVE_DRAFT')
          const active = await measure('work')
          check(active, `${appearance}/${width}/Work active`)
          expect(active.sharedStyle).toEqual(code.sharedStyle)
          await page.screenshot({ path: testInfo.outputPath(`shared-composer-${appearance}-${width}.png`), animations: 'disabled' })
        }
      }
      expect(errors).toEqual([])
    } finally {
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    }
  })

  test('Work 上下文环显示已确认用量和详情，切换任务及 Code 不串数据', async () => {
    const title = 'WORK_CONFIRMED_CONTEXT_RING'
    const id = await startTask(title)
    frame(id, { content: 'WORK_CONTEXT_READY' })
    frame(id, { usage: {
      usageScope: 'turn', modelId, currentPromptTokens: 64000, contextWindow: 128000,
      contextUsageEstimated: false, contextUsageProvisional: false,
      promptTokens: 64000, completionTokens: 100, totalTokens: 64100,
      confirmedContext: { used: 64000, contextWindow: 128000, modelId }
    } })
    const ring = work().locator('.input-composer .context-ring')
    await expect(ring).toBeVisible()
    await expect(ring.locator('.context-ring__label')).toHaveText('50')
    await expect(ring).toHaveAttribute('data-context-source', 'reported')
    await expect(ring).toHaveAttribute('data-context-pending', 'false')
    await expect(ring).toHaveAttribute('aria-label', /64k \/ 128k/)
    await ring.hover()
    const card = page.getByTestId('context-usage-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.ctx-card__percent')).toHaveText('50.0%')
    await expect(card.locator('.ctx-card__tokens-value:not(.ctx-card__exact-tokens)')).toHaveText('64k / 128k')
    await expect(page.getByTestId('context-used-number')).toHaveAttribute('data-value', '64000')
    // Leaving the hover target prevents a portal tooltip from covering a mode
    // switch; the persisted sample must then survive actual session hydration.
    await workMode().hover()
    finish(id)
    await expect(runStatus()).toHaveCount(0)
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toBeVisible()
    await expect(ring).toHaveCount(0)
    await switchTo('code')
    await expect(page.locator('.mode-surface[data-mode="code"] .input-composer .context-ring')).toHaveCount(0)
    await switchTo('work')
    await selectWorkTask(title)
    await expect(ring.locator('.context-ring__label')).toHaveText('50')
    await expect(ring).toHaveAttribute('data-context-source', 'reported')
    await page.reload()
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await expect(ring.locator('.context-ring__label')).toHaveText('50')
    await expect(ring).toHaveAttribute('aria-label', /64k \/ 128k/)
    expect(errors).toEqual([])
  })

  test('未知旧会话如实跟随引擎，默认模型显示与润色和主请求一致', async () => {
    await page.evaluate(model => window.aether.settings.update({ lastModelId: model, utilityModelId: '' }), modelId)
    await page.reload()
    const picker = work().getByRole('button', { name: 'Work 使用的模型', exact: true })
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    for (const restoredModel of [undefined, '当前配置 of AI']) {
      const id = await startTask(`WORK_UNKNOWN_REQUESTED_MODEL：${restoredModel ?? '缺少模型'}`)
      frame(id, { content: '旧会话模型恢复验证就绪。' })
      finish(id)
      await expect(runStatus()).toHaveCount(0)
      // The controlled server preserves an old run with unknown requested model
      // and a different actual fallback. Neither is a client-default selection.
      session(id).run = { ...session(id).run!, modelId: restoredModel, actualModelId: alternateModelId }
      await page.reload()
      await expect(picker).toHaveText('跟随引擎配置')
      await expect(picker).toHaveAttribute('title', '跟随引擎配置 · 发送时由引擎解析')
      await input.fill('请整理旧任务的补充要求')
      let utilityBefore = utilityRequests.length
      await work().getByRole('button', { name: 'AI 润色输入', exact: true }).click()
      await expect.poll(() => utilityRequests.length).toBe(utilityBefore + 1)
      expect(utilityRequests[utilityBefore].body).not.toHaveProperty('model')
      utilityRequests[utilityBefore].response.setHeader('content-type', 'application/json')
      utilityRequests[utilityBefore].response.end(envelope({ text: '整理后的旧任务补充要求' }))
      await expect(input).toHaveText('整理后的旧任务补充要求')
      const requestsBefore = chatRequests.length
      await work().getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => chatRequests.length).toBe(requestsBefore + 1)
      expect(chatRequests[requestsBefore]).toMatchObject({ sessionId: id, message: '整理后的旧任务补充要求', hasModelOverride: false })
      frame(id, { content: '引擎默认已处理补充要求。' })
      finish(id)
      await expect(runStatus()).toHaveCount(0)
      // A new run with a known requested model can explicitly choose the client
      // default; its named source must also match the utility request.
      await picker.click()
      await page.getByRole('menuitem', { name: /^默认 · Work fixture model/ }).click()
      await page.reload()
      await expect(picker).toHaveText('Work fixture model · 客户端默认')
      await input.fill('请按客户端默认模型整理要求')
      utilityBefore = utilityRequests.length
      await work().getByRole('button', { name: 'AI 润色输入', exact: true }).click()
      await expect.poll(() => utilityRequests.length).toBe(utilityBefore + 1)
      expect(utilityRequests[utilityBefore].body.model).toBe(modelId)
      utilityRequests[utilityBefore].response.setHeader('content-type', 'application/json')
      utilityRequests[utilityBefore].response.end(envelope({ text: '客户端默认模型已整理的要求' }))
      await expect(input).toHaveText('客户端默认模型已整理的要求')
    }
    expect(errors).toEqual([])
  })

  test('活动布局在三种内容视口下独立滚动，原文复制与唯一根停止保留真实作用', async ({}, testInfo) => {
    const id = await startTask('WORK_VISUAL_MATRIX：检查活动阅读与停止范围')
    const body = Array.from({ length: 350 }, (_, index) => `ACTIVITY_BODY_${index}：保持文件正文可读。`).join('\n')
    const raw = JSON.stringify({ path: '/remote/work-mode-fixture/visual.ts', expectedHash: 'a'.repeat(64), startLine: 1, endLine: 350, totalLines: 350, content: body })
    frame(id, { content: '正在检查源文件，并整理工作步骤。', todo: { todos: Array.from({ length: 12 }, (_, index) => ({ id: `visual-step-${index}`, title: `视觉校验步骤 ${index}`, status: index ? 'pending' : 'in_progress', priority: 'medium' })) } })
    frame(id, { toolStart: { id: 'visual-read', name: 'read_file', args: { path: 'visual.ts' } } })
    frame(id, { toolEnd: { id: 'visual-read', name: 'read_file', output: raw, success: true } })
    for (let index = 0; index < 81; index++) {
      frame(id, { toolStart: { id: `visual-list-${index}`, name: 'list_files', args: { path: `source-${index}` } } })
      frame(id, { toolEnd: { id: `visual-list-${index}`, name: 'list_files', output: `目录 ${index}`, success: true } })
    }
    await expect(work().getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    if (!await work().locator('.work-workspace').count()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    if (!await work().locator('.work-workspace').isVisible()) await work().getByRole('button', { name: /^工作区(?: · \d+)?$/, exact: true }).click()
    await work().getByRole('tab', { name: /^活动(?: \d+)?$/, exact: true }).click()
    const activities = work().locator('.work-activities')
    const list = activities.getByRole('listbox', { name: '工具活动列表', exact: true })
    const detail = activities.locator('.work-activity-detail')
    try {
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance }, appearance)
        for (const size of [{ width: 940, height: 640 }, { width: 1100, height: 760 }, { width: 1440, height: 900 }]) {
          await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
          await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size)
          const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
          if (!await workspace.isVisible()) {
            await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区(?: · \d+)?$/, exact: true }).click()
          }
          await expect(workspace, `${appearance}/${size.width}: workspace visible`).toBeVisible()
          await expect(workspace.getByRole('tab', { name: /^活动(?: \d+)?$/, exact: true })).toHaveAttribute('aria-selected', 'true')
          for (const reducedMotion of ['no-preference', 'reduce'] as const) {
            await page.emulateMedia({ reducedMotion })
            const context = `${appearance}/${size.width}/${reducedMotion}`
            await expect(work().getByRole('button', { name: '停止任务', exact: true }), context).toBeInViewport()
            await expect(activities.locator('.work-steps')).not.toHaveAttribute('open', '')
            await list.locator('[role="option"]').first().click()
            await expect(detail.locator('h4').first()).toHaveText('文件内容')
            await expect(detail.locator('details')).toHaveCount(2)
            await expect(detail.locator('details').first().locator('pre')).toHaveCount(0)
            await expect(detail).toContainText('ACTIVITY_BODY_0')
            const dimensions = await activities.evaluate(element => {
              const list = element.querySelector('.work-activities__list')!, detail = element.querySelector('.work-activity-detail')!
              return { list: getComputedStyle(list).overflowY, detail: getComputedStyle(detail).overflowY,
                listRect: list.getBoundingClientRect().toJSON(), detailRect: detail.getBoundingClientRect().toJSON(), overflow: element.scrollWidth - element.clientWidth }
            })
            expect(dimensions.list, context).toBe('auto')
            expect(dimensions.detail, context).toBe('auto')
            expect(dimensions.detailRect.left, context).toBeGreaterThanOrEqual(dimensions.listRect.right - 2)
            expect(dimensions.overflow, context).toBeLessThanOrEqual(2)
            await list.evaluate(element => { element.scrollTop = 0 })
            await detail.evaluate(element => { element.scrollTop = 0 })
            await expect.poll(() => detail.evaluate(element => element.scrollHeight > element.clientHeight), { message: context }).toBe(true)
            await detail.hover({ position: { x: 12, y: 24 } })
            await page.mouse.wheel(0, 180)
            await expect.poll(() => detail.evaluate(element => element.scrollTop), { message: `${context}: detail wheel scroll` }).toBeGreaterThan(0)
            expect(await list.evaluate(element => element.scrollTop), context).toBe(0)
            const position = await detail.evaluate(element => element.scrollTop)
            await list.hover({ position: { x: 12, y: 24 } })
            await page.mouse.wheel(0, 140)
            await expect.poll(() => list.evaluate(element => element.scrollTop), { message: `${context}: list wheel scroll` }).toBeGreaterThan(0)
            expect(await detail.evaluate(element => element.scrollTop), context).toBe(position)
            await list.evaluate(element => { element.scrollTop = 0 })
            await detail.evaluate(element => { element.scrollTop = 0 })
            await page.screenshot({ path: testInfo.outputPath(`work-activity-${appearance}-${size.width}-${reducedMotion}.png`), animations: 'disabled' })
          }
        }
      }
      await detail.getByRole('button', { name: '复制读取信息与原始输出', exact: true }).click()
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), { message: 'Copy finishes with the exact original tool output' }).toBe(raw)
      await list.getByRole('group', { name: '活动分页', exact: true }).getByRole('button', { name: '下一页', exact: true }).click()
      await expect(list.getByRole('option')).toHaveCount(2)
      await expect(list.getByRole('group', { name: '活动分页', exact: true })).toContainText('2 / 2')
      const previousCancellations = cancellations.length
      await work().getByRole('button', { name: '停止任务', exact: true }).click()
      await expect.poll(() => cancellations.slice(previousCancellations)).toEqual([id])
      await expect(work().getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    } finally {
      if (session(id).run?.status === 'running') finish(id, 'cancelled')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    }
  })

  test('Code 与 Work 模型菜单真正打开添加和管理入口，空模型列表仍可配置', async () => {
    // Code hosts settings in the editor; Work opens the same content in a dialog.
    const settings = page.locator('.app-settings:visible')
    const modelsView = settings.locator('.settings-view--models')
    const closeSettings = async (): Promise<void> => {
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      else await page.locator('.mode-surface[data-mode="code"]').getByRole('button', { name: '关闭 设置', exact: true }).click()
      await expect(settings).toHaveCount(0)
    }
    const refreshCatalogue = async (): Promise<void> => {
      if (!await settings.isVisible()) {
        await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      }
      await settings.getByRole('tab', { name: '模型', exact: true }).click()
      await modelsView.getByRole('button', { name: '刷新', exact: true }).click()
      if (hideFixtureModels) {
        await expect(modelsView).toContainText('尚未配置模型')
        await expect(modelsView.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
      } else {
        await expect(modelsView.getByRole('button', { name: '编辑', exact: true })).toHaveCount(2)
      }
      await closeSettings()
    }
    const requestsBefore = chatRequests.length
    try {
      for (const emptyCatalogue of [false, true]) {
        hideFixtureModels = emptyCatalogue
        await refreshCatalogue()
        for (const mode of ['code', 'work'] as const) {
          await switchTo(mode)
          if (mode === 'work') await work().getByRole('button', { name: '新任务', exact: true }).click()
          const surface = page.locator(`.mode-surface[data-mode="${mode}"] .input-composer`)
          const modelSelect = surface.locator('.model-picker .select__trigger')
          await expect(modelSelect).toBeEnabled()
          await modelSelect.click()
          const menu = page.getByRole('menu', { name: mode === 'work' ? 'Work 使用的模型' : '选择模型', exact: true })
          await expect(menu).toBeVisible()
          if (emptyCatalogue) await expect(menu).toContainText('还没有配置模型')
          await menu.getByRole('menuitem', { name: '添加模型', exact: true }).click()
          const addDialog = page.getByRole('dialog', { name: '添加模型', exact: true })
          await expect(addDialog).toBeVisible()
          await expect(addDialog.getByPlaceholder('可选', { exact: true })).toBeEditable()
          await addDialog.getByRole('button', { name: '取消', exact: true }).click()
          await expect(addDialog).toHaveCount(0)
          await modelSelect.click()
          await menu.getByRole('menuitem', { name: '管理模型', exact: true }).click()
          await expect(settings).toBeVisible()
          await expect(settings.getByRole('tab', { name: '模型', exact: true })).toHaveAttribute('aria-selected', 'true')
          await expect(modelsView).toBeVisible()
          if (emptyCatalogue) await expect(modelsView).toContainText('尚未配置模型')
          else await expect(modelsView.getByRole('button', { name: '编辑', exact: true })).toHaveCount(2)
          await closeSettings()
        }
      }
      expect(chatRequests).toHaveLength(requestsBefore)
      expect(errors).toEqual([])
    } finally {
      hideFixtureModels = false
      const addDialog = page.getByRole('dialog', { name: '添加模型', exact: true })
      if (await addDialog.isVisible()) await addDialog.getByRole('button', { name: '取消', exact: true }).click()
      await refreshCatalogue()
    }
  })
  test('后台子代理在父任务结束且面板关闭时仍可发现，切模式保留，续轮与停止使用准确身份', async ({}, testInfo) => {
    modernDiscovery = true; modernRevision = 1000; modernRuns.clear(); modernChanges.length = 0; modernReads.length = 0; modernCancels.length = 0
    try {
      await page.evaluate(async () => { await window.aether.engine.restart() })
      await page.reload()
      await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
      const id = await startTask('WORK_MODERN_DISCOVERY_PARENT')
      frame(id, { content: 'PARENT_FINISHED_WITHOUT_CHILD_SSE' }); finish(id)
      await expect(runStatus()).toHaveCount(0)
      const parent = session(id).run!
      const first: SubagentRunView = { schemaVersion: 2, view: 'summary', runId: 'discovery-window-run75', tenantId: 'fixture',
        rootSessionId: id, parentSessionId: id, parentConversationId: parent.turnId, parentMessageId: parent.assistantMessageId,
        parentToolCallId: 'discovery-window-dispatch75', childSessionId: 'discovery-window-context75',
        agentId: 'discovery-agent75', agentName: '后台发现协作员', task: '没有父SSE也继续工作', description: '发现第75个后台任务',
        modelId, status: 'running', lastSeq: 100, createdAt: Date.now(), updatedAt: Date.now(), usage: { totalTokens: 42 },
        toolCalls: [], toolCount: 0, activeToolCount: 0,
        coverage: { asOfSeq: 100, toolCount: 0, activeToolCount: 0, includedToolCount: 0, includedActiveToolCount: 0,
          ids: [], hasMore: false, truncated: false, completeness: 'complete' } }
      modernRuns.set(first.runId, first); modernChanges.push(modernRef(first, ++modernRevision))
      await expect.poll(() => modernReads.some(read => read.path.endsWith('/' + first.runId)
        && read.query.parentSessionId === id && read.query.view === 'summary')).toBe(true)
      expect(session(id).projection.some(payload => payload.subagentEvent)).toBe(false)
      expect(modernCancels).toEqual([])
      if (!await work().locator('.work-workspace').count()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
      const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
      await workspace.getByRole('tablist', { name: '工作区内容', exact: true }).getByRole('tab', { name: '子代理', exact: true }).click()
      const panel = workspace.getByRole('region', { name: '协作代理', exact: true })
      await expect(panel.getByRole('button', { name: '查看 后台发现协作员 子代理详情', exact: true })).toBeVisible()
      await switchTo('code'); await switchTo('work')
      await expect(panel).toContainText('后台发现协作员')
      expect(modernCancels).toEqual([])
      const removed: SubagentRunView = { ...first, status: 'cancelled', lastSeq: 102, coverage: { ...first.coverage, asOfSeq: 102 } }
      modernRuns.delete(first.runId); modernChanges.push(modernRef(removed, ++modernRevision, true))
      const second: SubagentRunView = { ...first, runId: 'discovery-window-run76', parentToolCallId: 'discovery-window-dispatch76',
        resumeFromRunId: first.runId, description: '保留同一子会话继续第二轮', createdAt: Date.now(), updatedAt: Date.now() }
      modernRuns.set(second.runId, second); modernChanges.push(modernRef(second, ++modernRevision))
      await expect.poll(() => modernReads.some(read => read.path.endsWith('/' + second.runId))).toBe(true)
      await panel.getByRole('button', { name: '查看 后台发现协作员 子代理详情', exact: true }).click()
      await expect(panel.locator('article.work-subagents__round[data-run-id="discovery-window-run76"]')).toBeVisible()
      await expect(panel.locator('article.work-subagents__round[data-run-id="discovery-window-run75"]')).toHaveCount(0)
      await panel.getByRole('button', { name: '停止本轮', exact: true }).click()
      await expect.poll(() => modernCancels.length).toBe(1)
      expect(modernCancels[0]).toEqual({ runId: second.runId, query: { parentSessionId: id, rootSessionId: id, parentConversationId: parent.turnId, view: 'summary' } })
      await expect(panel.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled()
      expect(modernRuns.get(second.runId)?.status).toBe('cancelling')
      expect(modernReads.some(read => read.path === '/api/v1/subagent/runs')).toBe(false)
      expect(errors).toEqual([])
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        if (!await work().locator('.work-workspace').count()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
        await work().getByRole('region', { name: '任务工作区', exact: true }).getByRole('tab', { name: '子代理', exact: true }).click()
        await testInfo.attach('modern-discovery-visible-diagnostic', { body: await work().innerText(), contentType: 'text/plain' })
      }
      await testInfo.attach('modern-discovery-wire', { body: JSON.stringify({ reads: modernReads, cancels: modernCancels,
        changes: modernChanges, runs: [...modernRuns.values()], appErrors: errors }), contentType: 'application/json' })
      modernDiscovery = false; modernRuns.clear(); modernChanges.length = 0
    }
  })

  test('Code与Work直接显示当前访问权限，可选择且跨刷新保持各自会话设置', async () => {
    const id = await startTask('WORK_DIRECT_ACCESS_PICKER')
    frame(id, { content: 'ACCESS_PICKER_PARENT_READY' }); finish(id)
    await expect(runStatus()).toHaveCount(0)
    const workPicker = work().locator('.composer-access-picker .select__trigger')
    await expect(workPicker).toHaveText(/安全模式/)
    await workPicker.click()
    await page.getByRole('menuitem', { name: /^完全访问/ }).click()
    await expect(workPicker).toHaveText(/完全访问/)
    await expect.poll(() => securityModes.get(id)).toBe('full-access')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await switchTo('code')
    const codePicker = page.locator('.mode-surface[data-mode="code"] .composer-access-picker .select__trigger')
    await expect(codePicker).toBeEnabled()
    await codePicker.click()
    await page.getByRole('menuitem', { name: /^标准模式/ }).click()
    await expect(codePicker).toHaveText(/标准模式/)
    expect(securityModes.get(id)).toBe('full-access')
    await switchTo('work')
    await expect(workPicker).toHaveText(/完全访问/)
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await switchTo('work')
    await expect(workPicker).toHaveText(/完全访问/)
    await switchTo('code')
    await expect(codePicker).toHaveText(/标准模式/)
    await codePicker.click()
    await page.getByRole('menuitem', { name: /^安全模式/ }).click()
    await expect(codePicker).toHaveText(/安全模式/)
    await switchTo('work')
    await expect(workPicker).toHaveText(/完全访问/)
    await workPicker.click()
    await page.getByRole('menuitem', { name: /^安全模式/ }).click()
    await expect.poll(() => securityModes.get(id)).toBe('safe')
    expect(errors).toEqual([])
  })

  test('Code 排队消息编辑移除附件后实际发送同步，清空附件不会携带旧上传', async () => {
    await switchTo('code')
    const code = page.locator('.mode-surface[data-mode="code"]')
    await code.getByRole('button', { name: '新建', exact: true }).click()
    const input = code.locator('.chat__input')
    const before = chatRequests.length
    await input.fill('QUEUE_ATTACHMENT_ACTIVE')
    await input.press('Enter')
    await expect.poll(() => chatRequests.length).toBe(before + 1)
    const id = chatRequests[before].sessionId
    await expect(code.locator('.chat__send--stop')).toBeVisible()
    for (const clearAll of [false, true]) {
      const files = [
        { name: 'queue-keep.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic keep') },
        { name: 'queue-remove.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic remove') }
      ]
      await code.locator('.chat__composer input[type="file"]').setInputFiles(files)
      await expect(code.locator('.chat__attach-strip .attach-chip--busy')).toHaveCount(0)
      await expect(code.locator('.chat__attach-strip .attach-chip')).toHaveCount(2)
      const uploaded = [...sourceFiles.entries()].filter(([key]) => key.startsWith(id + ':')).slice(-2)
      expect(uploaded.map(([, file]) => file.bytes.toString())).toEqual(['synthetic keep', 'synthetic remove'])
      await input.fill(clearAll ? 'QUEUE_REMOVE_ALL' : 'QUEUE_REMOVE_ONE')
      await input.press('Enter')
      const tray = code.locator('.session-tray')
      await expect(tray).toContainText(clearAll ? 'QUEUE_REMOVE_ALL' : 'QUEUE_REMOVE_ONE')
      expect(chatRequests.length).toBe(before + (clearAll ? 2 : 1))
      const expand = tray.getByRole('button', { name: '展开托盘', exact: true })
      if (await expand.isVisible()) await expand.click()
      await tray.getByRole('button', { name: '编辑第 1 条排队消息', exact: true }).click()
      await expect(tray.locator('.session-tray__queue-thumbwrap')).toHaveCount(2)
      await tray.getByRole('button', { name: '移除该附件', exact: true }).last().click()
      if (clearAll) await tray.getByRole('button', { name: '移除该附件', exact: true }).click()
      await tray.locator('.session-tray__queue-textarea').fill(clearAll ? 'QUEUE_EDITED_ALL' : 'QUEUE_EDITED_ONE')
      await tray.getByRole('button', { name: '保存', exact: true }).click()
      await expect(tray.locator('.session-tray__queue-attach')).toHaveCount(clearAll ? 0 : 1)
      frame(id, { content: clearAll ? 'QUEUE_SECOND_DONE' : 'QUEUE_FIRST_DONE' }); finish(id)
      await expect.poll(() => chatRequests.length).toBe(before + (clearAll ? 3 : 2))
      const sent = chatRequests.at(-1)!
      expect(sent.sessionId).toBe(id)
      expect(sent.message).toBe(clearAll ? 'QUEUE_EDITED_ALL' : 'QUEUE_EDITED_ONE')
      expect(sent.attachments).toEqual(clearAll ? undefined : [{ name: uploaded[0][0].slice(id.length + 1), type: 'text/plain' }])
      await expect(tray.locator('.session-tray__queue-item')).toHaveCount(0)
      // The queued turn becomes the active turn for the second edit scenario.
      await expect(code.locator('.chat__send--stop')).toBeVisible()
    }
    frame(id, { content: 'QUEUE_ATTACHMENT_TEST_DONE' }); finish(id)
    await expect(code.locator('.chat__send--stop')).toHaveCount(0)
    expect(errors).toEqual([])
  })

})
