import { createServer, type Server } from 'node:http'
import type { RootRun } from '../../src/shared/root-run'
import type { EngineHistoryRow } from '../../src/renderer/src/core/engine/chat-history'

export interface McpSettingsServer {
  id: string
  name: string
  description?: string
  transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp'
  scope: 'project' | 'global'
  enabled: boolean
  isBuiltIn?: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabledTools?: string[]
  timeoutMs?: number
}
export interface McpSettingsRequest {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
}
export const mcpSettingsToken = 'mcp-settings-disposable-token'
export const mcpSettingsWorkspace = '/mcp-settings-fixture'
export const mcpSettingsDefaultWorkspace = '/mcp-settings-code-default'
export const mcpSettingsModel = 'mcp-settings-model'
export const mcpSettingsTask = { id: 'work-mcp-settings-fixture', title: 'MCP 设置测试会话', workspacePath: null }
const run: RootRun = {
  schemaVersion: 1, runId: 'mcp-settings-run', sessionId: mcpSettingsTask.id, turnId: 'mcp-settings-turn',
  userMessageId: 'mcp-settings-user', assistantMessageId: 'mcp-settings-assistant', seq: 1, version: 2,
  status: 'succeeded', modelId: mcpSettingsModel, pending: [], workspacePaths: [mcpSettingsWorkspace],
  createdAt: 1, updatedAt: 2, startedAt: 1, finishedAt: 2
}
const history: EngineHistoryRow[] = [
  { id: run.userMessageId, role: 'user', content: mcpSettingsTask.title, createdAt: 1,
    conversationId: run.turnId, metadata: { rootRunId: run.runId } },
  { id: run.assistantMessageId, role: 'assistant', content: 'MCP_SETTINGS_READY', createdAt: 2,
    conversationId: run.turnId, metadata: { rootRunId: run.runId } }
]
export const initialMcpSettingsServers: McpSettingsServer[] = [
  { id: 'docs-stdio', name: '文档检索', description: '检索项目资料，保留完整来源和文件路径。', transportType: 'stdio', scope: 'project', enabled: true,
    command: 'node', args: ['fixture-server.mjs', '--mode=read'], env: { DOCS_ROOT: 'fixture-docs' }, disabledTools: ['export_report'], timeoutMs: 15000 },
  { id: 'remote-docs', name: '远端资料', description: '连接团队的资料服务。', transportType: 'streamableHttp', scope: 'global', enabled: false,
    url: 'https://mcp-fixture.invalid/long/path/for/remote-documents', headers: { Authorization: 'Bearer fixture-secret' }, disabledTools: [], timeoutMs: 0 },
  { id: 'builtin-resources', name: '内置资源', description: '由引擎提供的内置连接。', transportType: 'http', scope: 'global', enabled: true,
    url: 'https://builtin-fixture.invalid/mcp', isBuiltIn: true, disabledTools: [] }
]
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

/** Reuses the authenticated disposable-engine pattern from the Agent and plugin UI suites.
 * Endpoints record the real renderer/main-process request; no MCP process is spawned. */
export class McpSettingsFixture {
  readonly errors: string[] = []
  readonly requests: McpSettingsRequest[] = []
  readonly workspaceReads: string[] = []
  servers = structuredClone(initialMcpSettingsServers)
  failTestFor: string | null = null
  failImport = false
  private readonly http: Server
  origin = ''

  constructor() {
    this.http = createServer((request, response) => { void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
      response.setHeader('content-type', 'application/json')
      if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== mcpSettingsToken)
        throw new Error(`Unauthenticated MCP settings request: ${method} ${path}`)
      let raw = ''; for await (const chunk of request) raw += chunk.toString()
      const body: unknown = raw ? JSON.parse(raw) : null
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const sessionRun = sessionId === mcpSettingsTask.id ? run : null
      const sessionHistory = sessionRun ? history : []
      if (path === '/api/v1/workspace/directory') this.workspaceReads.push(sessionId)
      if (path.startsWith('/api/v1/mcp/')) {
        this.requests.push({ method, path, query: Object.fromEntries(url.searchParams), body })
        if (url.searchParams.get('path') !== mcpSettingsWorkspace &&
          !(method === 'GET' && path === '/api/v1/mcp/servers' && !url.searchParams.has('path')))
          throw new Error('MCP request lost the selected remote workspace')
        const scope = url.searchParams.get('scope') ?? 'project'
        if (!['project', 'global'].includes(scope)) throw new Error('Unexpected MCP scope')
        if (path === '/api/v1/mcp/config/export' && method === 'GET') {
          const mcpServers = Object.fromEntries(this.servers.filter(server => server.scope === scope).map(server => {
            const { id, scope: _scope, isBuiltIn: _isBuiltIn, transportType, ...configuration } = server
            return [id, { ...configuration, type: transportType }]
          }))
          response.end(envelope({ mcpServers })); return
        }
        if (path === '/api/v1/mcp/config/import' && method === 'POST') {
          if (this.failImport) { response.end(JSON.stringify({ code: 40001, message: '夹具校验失败：服务器地址无效' })); return }
          if (!record(body) || !['project', 'global'].includes(String(body.scope)) || !record(body.config) || !record(body.config.mcpServers))
            throw new Error('JSON import must preserve scope and the complete config document')
          const selected = body.scope as 'project' | 'global'
          const imported: McpSettingsServer[] = Object.entries(body.config.mcpServers).map(([id, configuration]) => {
            if (!record(configuration)) throw new Error('Imported server is not an object')
            return { ...configuration, id, name: typeof configuration.name === 'string' ? configuration.name : id,
              scope: selected, enabled: configuration.enabled !== false,
              transportType: String(configuration.transportType ?? configuration.type ?? 'http') as McpSettingsServer['transportType'] }
          })
          this.servers = [...this.servers.filter(server => server.scope !== selected), ...imported]
          response.end(envelope({ servers: imported })); return
        }
        const match = /^\/api\/v1\/mcp\/servers(?:\/([^/]+))?(?:\/(enable|disable|test))?$/.exec(path)
        if (!match) throw new Error(`Unexpected MCP route ${method} ${path}`)
        const id = match[1] ? decodeURIComponent(match[1]) : undefined, action = match[2]
        if (!id && method === 'GET') { response.end(envelope(this.servers)); return }
        if (!id && method === 'POST') {
          if (!record(body) || typeof body.id !== 'string' || typeof body.name !== 'string') throw new Error('Incomplete create payload')
          const created = { ...body, scope: body.scope ?? 'project' } as unknown as McpSettingsServer
          if (this.servers.some(server => server.id === created.id && server.scope === created.scope)) throw new Error('Duplicate fixture server')
          this.servers.push(created); response.end(envelope(created)); return
        }
        const index = this.servers.findIndex(server => server.id === id && server.scope === scope)
        if (index < 0) throw new Error(`MCP target missing or wrong scope: ${scope}/${id}`)
        const server = this.servers[index]
        if (action === 'test' && method === 'POST') {
          if (body !== null) throw new Error('Connection test must use the stored server identity')
          if (this.failTestFor === id) { response.end(JSON.stringify({ code: 50000, message: '夹具连接失败，请检查服务器设置' })); return }
          response.end(envelope({ toolCount: 2, tools: [
            { name: `mcp_${id}_read_file`, description: '按路径读取文档并返回完整来源。' },
            { name: `mcp_${id}_export_report`, description: '生成可编辑的报告文件。' }
          ] })); return
        }
        if ((action === 'enable' || action === 'disable') && method === 'POST') {
          if (body !== null || server.isBuiltIn) throw new Error('Invalid server toggle')
          server.enabled = action === 'enable'; response.end(envelope(server)); return
        }
        if (!action && method === 'PATCH' && record(body)) {
          if (Object.hasOwn(body, 'id')) throw new Error('An edit cannot rename the server identity')
          const next = { ...server, ...body } as unknown as McpSettingsServer
          if (body.timeoutMs === null) delete next.timeoutMs
          this.servers[index] = next; response.end(envelope(next)); return
        }
        if (!action && method === 'DELETE') {
          if (body !== null || server.isBuiltIn) throw new Error('Invalid server deletion')
          this.servers.splice(index, 1); response.end(envelope({ deleted: true })); return
        }
        throw new Error(`Unexpected MCP mutation ${method} ${path}`)
      }
      if (path === '/api/v1/workspace/bind' && method === 'POST') {
        if (!record(body) || body.workspaceRoot !== mcpSettingsDefaultWorkspace || body.sessionId === mcpSettingsTask.id)
          throw new Error('Settings must read the existing Work binding without rebinding it')
        response.end(envelope({ workspaceRoot: mcpSettingsDefaultWorkspace, bindingEpoch: 'mcp-settings', contractVersion: 2 })); return
      }
      if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
        response.writeHead(404).end(envelope(null)); return
      }
      if (method !== 'GET') throw new Error(`Unexpected settings mutation: ${method} ${path}`)
      if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
      const data = path === '/health' ? { status: 'ok' }
        : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'mcp-settings-fixture' }
        : path === '/api/v1/models' ? [{ id: mcpSettingsModel, modelId: mcpSettingsModel, provider: 'openai', displayName: 'MCP 设置测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
        : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: sessionHistory, projection: [], run: sessionRun, runs: sessionRun ? [sessionRun] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
        : path === '/api/v1/chat/status' ? { running: false, finished: true, run: sessionRun, lastEventId: null }
        : path === '/api/v1/chat/runs' ? { runs: sessionRun ? [sessionRun] : [] }
        : path === '/api/v1/conversation/history' ? sessionHistory
        : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: sessionHistory.filter(row => row.role === 'user').map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: sessionHistory, loadedTurnIds: sessionHistory.filter(row => row.role === 'user').map(row => row.id), revision: sessionId, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
        : path === '/api/v1/conversation/sessions' ? [{ sessionId: mcpSettingsTask.id, title: mcpSettingsTask.title, lastAt: 2, messageCount: 2 }]
        : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
        : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
        : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
        : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
        : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
        : path === '/api/v1/security/mode' ? { mode: 'standard' }
        : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
        : path === '/api/v1/command-jobs' ? { jobs: [] }
        : path === '/api/v1/workspace/directory' ? { root: sessionId === mcpSettingsTask.id ? mcpSettingsWorkspace : mcpSettingsDefaultWorkspace, entries: [], bindingEpoch: 'mcp-settings' }
        : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
        : /\/sessions\/[^/]+\/toolkits$/.test(path) ? { toolkits: [] }
        : path === '/api/v1/skills' ? { list: [] }
        : path === '/api/v1/toolkits' ? { toolkits: [] }
        : path === '/api/v1/settings' ? {} : []
      response.end(envelope(data))
    })().catch(error => { this.errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('MCP settings fixture failed') }) })
  }
  reset(): void { this.servers = structuredClone(initialMcpSettingsServers); this.requests.length = 0; this.workspaceReads.length = 0; this.failTestFor = null; this.failImport = false }
  async start(): Promise<void> {
    await new Promise<void>((done, reject) => { this.http.once('error', reject); this.http.listen(0, '127.0.0.1', done) })
    const address = this.http.address()
    if (!address || typeof address === 'string') throw new Error('Missing MCP fixture port')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> {
    this.http.closeAllConnections()
    if (this.http.listening) await new Promise<void>(done => this.http.close(() => done()))
  }
}
