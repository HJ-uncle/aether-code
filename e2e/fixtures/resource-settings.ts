import { createServer, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { RootRun } from '../../src/shared/root-run'
import type { KnowledgeBase, KnowledgeDocument } from '../../src/renderer/src/core/engine/knowledge'
import type { MemoryRecord } from '../../src/renderer/src/core/engine/memory-records'

export const resourceToken = 'resource-settings-disposable-token'
export const resourceWorkspace = '/resource-settings-fixture'
export const resourceModel = 'resource-settings-model'
export const resourceTasks = [
  { id: 'work-resource-alpha', title: '资源设置会话甲', workspacePath: resourceWorkspace },
  { id: 'work-resource-beta', title: '资源设置会话乙', workspacePath: resourceWorkspace }
]
export interface ResourceReceipt { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> }
export interface SkillFixture {
  id: string; name: string; description: string; scope: 'project' | 'global'; enabled: boolean; order: number
  content: string; dir: string; files: Array<{ path: string; size: number }>
}
export interface ResourceUpload { path: string; fields: Record<string, string>; filename: string; type: string; bytes: Buffer }
export const initialResourceSkills: SkillFixture[] = [
  { id: 'project-notes', name: 'project-notes', description: '整理项目记录，保留引用、来源与完整步骤。', scope: 'project', enabled: true, order: 0,
    content: '# Project notes\n\n保留 Unicode 与完整步骤。\n', dir: resourceWorkspace + '/.skills/project-notes', files: [{ path: 'SKILL.md', size: 62 }] },
  { id: 'global-review', name: 'global-review', description: '全局审查技能，当前已停用。', scope: 'global', enabled: false, order: 1,
    content: '# Global review\n\n检查文档与代码。\n', dir: '/global/.skills/global-review', files: [{ path: 'SKILL.md', size: 42 }] }
]
export const initialResourceBases: KnowledgeBase[] = [
  { id: 'base-alpha', name: '项目资料', description: '项目设计与规范。', createdAt: 1_700_000_000, documentCount: 1, chunkCount: 2 },
  { id: 'base-beta', name: '团队手册', description: '团队工作方式。', createdAt: 1_700_000_001, documentCount: 1, chunkCount: 1 }
]
export const initialResourceDocuments: KnowledgeDocument[] = [
  { id: 'doc-alpha', knowledgeBaseId: 'base-alpha', filename: '设计规范.md', contentType: 'text/markdown', content: '# 设计规范\n\n所有项目遵循统一留白。\n', contentExact: true, chunkCount: 2, status: 'ready', createdAt: 1_700_000_002 },
  { id: 'doc-beta', knowledgeBaseId: 'base-beta', filename: '团队流程.txt', contentType: 'text/plain', content: '团队资料需要保留来源。\n', contentExact: true, chunkCount: 1, status: 'ready', createdAt: 1_700_000_003 }
]
export const initialResourceMemories: MemoryRecord[] = [
  { id: 'memory-global', scope: 'global', type: 'preference', summary: '偏好简洁中文', detail: '优先使用清晰的中文段落，并保留必要的技术细节。', importance: 0.73, tags: ['语言', '表达'], createdAt: 1_700_000_000, updatedAt: 1_700_000_010 },
  { id: 'memory-fact', scope: 'global', type: 'fact', summary: '项目使用 TypeScript', detail: '桌面界面使用 React 与 TypeScript。', importance: 0.5, tags: ['工程'], createdAt: 1_700_000_000 },
  { id: 'memory-session', scope: 'session', sessionId: resourceTasks[1].id, type: 'decision', summary: '会话乙的发布决定', detail: '先检查文档，再发布版本。', importance: 0.8, tags: ['发布'], createdAt: 1_700_000_000 }
]
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

/** Only the authenticated engine boundary is substituted. The renderer still
 * uses production IPC, uploads, scope selection and confirmation dialogs. */
export class ResourceSettingsFixture {
  readonly errors: string[] = []
  readonly receipts: ResourceReceipt[] = []
  readonly uploads: ResourceUpload[] = []
  skills = structuredClone(initialResourceSkills)
  bases = structuredClone(initialResourceBases)
  documents = structuredClone(initialResourceDocuments)
  memories = structuredClone(initialResourceMemories)
  preferences = { enabled: true, globalEnabled: false, sessionDefaultEnabled: false }
  imports: Array<{ importId: string; filename: string; status: string; progress: number; stage: string; skillNames: string[]; scope: string }> = []
  failNext: 'skill-create' | 'document-upload' | 'memory-save' | null = null
  holdChunkIndex: number | null = null
  heldChunk: { response: ServerResponse; importId: string } | null = null
  holdMemoryId: string | null = null
  heldMemory: { response: ServerResponse; record: MemoryRecord } | null = null
  origin = ''
  private sequence = 0
  private readonly server: Server

  constructor() {
    this.server = createServer((request, response) => { void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
      response.setHeader('content-type', 'application/json')
      if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== resourceToken) throw new Error(`Unauthenticated ${method} ${path}`)
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks), contentType = String(request.headers['content-type'] ?? '')
      const multipart = contentType.startsWith('multipart/form-data')
      const parsed: unknown = !multipart && bytes.length ? JSON.parse(bytes.toString('utf8')) : {}
      if (!isRecord(parsed)) throw new Error('Mutation body must be a JSON object')
      const body = parsed, query = Object.fromEntries(url.searchParams), sessionId = query.sessionId ?? ''
      const tracked = /^\/api\/v1\/(skills(?:\/|$)|knowledge\/|memory\/)/.test(path)
      if (tracked) this.receipts.push({ method, path, query, body })
      const reject = (kind: typeof this.failNext): boolean => {
        if (this.failNext !== kind) return false
        this.failNext = null; response.end(JSON.stringify({ code: 40001, message: '夹具校验失败，已保留原内容', data: null })); return true
      }

      if (multipart) {
        if (method !== 'POST' || !['/api/v1/skills/imports', '/api/v1/skills/imports/chunks', '/api/v1/knowledge/documents'].includes(path)) throw new Error(`Unexpected multipart ${path}`)
        const form = await new Request('http://fixture/upload', { method: 'POST', headers: { 'content-type': contentType }, body: Uint8Array.from(bytes) }).formData()
        const file = form.get('file'); if (!file || typeof file === 'string') throw new Error('Upload lacks file bytes')
        const fields = Object.fromEntries([...form].flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []))
        const upload = { path, fields, filename: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) }
        this.uploads.push(upload)
        if (path.endsWith('/skills/imports/chunks')) {
          const chunkIndex = Number(fields.chunkIndex)
          if (fields.scope !== 'project' || fields.projectRoot !== resourceWorkspace || fields.totalChunks !== '3'
            || fields.totalSize !== String(6 * 1024 * 1024) || upload.bytes.length !== 2 * 1024 * 1024)
            throw new Error('Chunked import lost content size or scope')
          if (chunkIndex === 0 && fields.importId) throw new Error('First chunk cannot reuse an import')
          const item = chunkIndex === 0 ? { importId: `skill-import-${++this.sequence}`, filename: fields.filename, status: 'uploading', progress: 0, stage: '接收分片', skillNames: [], scope: fields.scope }
            : this.imports.find(item => item.importId === fields.importId)
          if (!item || item.status === 'cancelled') throw new Error('Upload continued after import cancellation')
          if (chunkIndex === 0) this.imports.push(item)
          item.progress = Math.round((chunkIndex + 1) / 3 * 70)
          if (this.holdChunkIndex === chunkIndex) {
            this.holdChunkIndex = null; this.heldChunk = { response, importId: item.importId }; return
          }
          response.end(envelope({ importId: item.importId })); return
        }
        if (path.endsWith('/skills/imports')) {
          if (fields.fileSha256 !== createHash('sha256').update(upload.bytes).digest('hex')) throw new Error('Skill upload lost exact content bytes')
          if (fields.scope === 'project' && fields.projectRoot !== resourceWorkspace) throw new Error('Skill import lost project scope')
          if (!['project', 'global'].includes(fields.scope) || !['reject', 'overwrite', 'versioned'].includes(fields.conflictStrategy)) throw new Error('Invalid import options')
          const name = 'imported-guide', importId = `skill-import-${++this.sequence}`
          this.skills.push({ id: name, name, description: '从文件导入的技能', scope: fields.scope as 'project' | 'global', enabled: true, order: 2,
            content: upload.bytes.toString('utf8'), dir: '/fixture/' + name, files: [{ path: 'SKILL.md', size: upload.bytes.length }] })
          this.imports.push({ importId, filename: upload.filename, status: 'imported', progress: 100, stage: '完成', skillNames: [name], scope: fields.scope })
          response.end(envelope({ importId })); return
        }
        if (reject('document-upload')) return
        const document = this.addDocument({ filename: upload.filename, content: upload.bytes.toString('utf8'), contentType: upload.type, knowledgeBaseId: fields.knowledgeBaseId })
        response.end(envelope(document)); return
      }

      if (path === '/api/v1/skills/imports' && method === 'GET') { response.end(envelope(this.imports.filter(item => item.scope === query.scope))); return }
      if (path.startsWith('/api/v1/skills/imports/') && method === 'DELETE') {
        const item = this.imports.find(item => item.importId === path.split('/').at(-1)); if (!item) throw new Error('Unknown cancelled import')
        if (this.heldChunk) throw new Error('Cancellation removed chunk storage before its upload finished')
        item.status = 'cancelled'; item.stage = '已取消'
        response.end(envelope({ importId: item.importId, status: item.status })); return
      }
      if (path === '/api/v1/skills/imports/chunks/merge' && method === 'POST') throw new Error('Cancelled import must not be committed')
      if (path.startsWith('/api/v1/skills/imports/') && method === 'GET') {
        const item = this.imports.find(item => item.importId === path.split('/').at(-1)); if (!item) throw new Error('Unknown import')
        response.end(envelope(item)); return
      }
      if (path === '/api/v1/skills' && method === 'GET') { response.end(envelope({ list: this.skills })); return }
      if (path === '/api/v1/skills' && method === 'POST') {
        if (reject('skill-create')) return
        if (typeof body.name !== 'string' || typeof body.content !== 'string' || !['project', 'global'].includes(String(body.scope))) throw new Error('Invalid skill creation')
        if (body.scope === 'project' && body.projectRoot !== resourceWorkspace) throw new Error('Skill creation lost project root')
        const item: SkillFixture = { id: body.name, name: body.name, description: String(body.description), content: body.content,
          scope: body.scope as 'project' | 'global', enabled: true, order: this.skills.length, dir: '/fixture/' + body.name,
          files: [{ path: 'SKILL.md', size: Buffer.byteLength(body.content) }] }
        this.skills.push(item); response.end(envelope(item)); return
      }
      const skillMatch = /^\/api\/v1\/skills\/([^/]+)$/.exec(path)
      if (skillMatch) {
        const index = this.skills.findIndex(item => item.id === decodeURIComponent(skillMatch[1]) && item.scope === query.scope)
        if (index < 0 || query.path !== resourceWorkspace) throw new Error('Skill request lost identity or workspace scope')
        if (method === 'GET') { response.end(envelope(this.skills[index])); return }
        if (method === 'PATCH' && typeof body.enabled === 'boolean') { this.skills[index].enabled = body.enabled; response.end(envelope(this.skills[index])); return }
        if (method === 'DELETE') { this.skills.splice(index, 1); response.end(envelope({ deleted: true })); return }
      }

      if (path === '/api/v1/knowledge/formats' && method === 'GET') { response.end(envelope({ extensions: ['.txt', '.md', '.pdf', '.docx'], description: '文本、Markdown、PDF 与 Word 文档。' })); return }
      if (path === '/api/v1/knowledge/bases') {
        if (method === 'GET') { response.end(envelope(this.bases.map(base => ({ ...base, documentCount: this.documents.filter(doc => doc.knowledgeBaseId === base.id).length })))); return }
        if (method === 'POST' && typeof body.name === 'string') {
          const base = { id: `base-created-${++this.sequence}`, name: body.name, description: String(body.description ?? ''), createdAt: 1_700_000_100, documentCount: 0 }
          this.bases.push(base); response.end(envelope(base)); return
        }
      }
      const baseMatch = /^\/api\/v1\/knowledge\/bases\/([^/]+)$/.exec(path)
      if (baseMatch) {
        const index = this.bases.findIndex(item => item.id === decodeURIComponent(baseMatch[1])); if (index < 0) throw new Error('Unknown knowledge collection')
        if (method === 'GET') { response.end(envelope(this.bases[index])); return }
        if (method === 'PUT') { this.bases[index] = { ...this.bases[index], ...body }; response.end(envelope(this.bases[index])); return }
        if (method === 'DELETE') { this.bases.splice(index, 1); this.documents = this.documents.filter(doc => doc.knowledgeBaseId !== baseMatch[1]); response.end(envelope({ deleted: true })); return }
      }
      if (path === '/api/v1/knowledge/documents') {
        if (method === 'GET') { response.end(envelope(this.documents.filter(doc => !query.knowledgeBaseId || doc.knowledgeBaseId === query.knowledgeBaseId))); return }
        if (method === 'POST') { if (reject('document-upload')) return; response.end(envelope(this.addDocument(body))); return }
      }
      const documentMatch = /^\/api\/v1\/knowledge\/documents\/([^/]+)$/.exec(path)
      if (documentMatch) {
        const index = this.documents.findIndex(item => item.id === decodeURIComponent(documentMatch[1])); if (index < 0) throw new Error('Unknown knowledge document')
        if (method === 'GET') { response.end(envelope(this.documents[index])); return }
        if (method === 'PUT') { this.documents[index] = { ...this.documents[index], ...body }; response.end(envelope(this.documents[index])); return }
        if (method === 'DELETE') { this.documents.splice(index, 1); response.end(envelope({ deleted: true })); return }
      }
      if (path === '/api/v1/knowledge/search' && method === 'POST') {
        if (typeof body.query !== 'string' || body.limit !== 8) throw new Error('Invalid retrieval query')
        const ids = Array.isArray(body.knowledgeBaseIds) ? body.knowledgeBaseIds : []
        response.end(envelope(this.documents.filter(doc => (!ids.length || ids.includes(doc.knowledgeBaseId)) && doc.content?.includes(String(body.query))).map(doc => ({
          chunkId: `${doc.id}-chunk`, documentId: doc.id, knowledgeBaseId: doc.knowledgeBaseId, filename: doc.filename, content: doc.content, score: 0.92, chunkIndex: 0
        })))); return
      }

      if (path === '/api/v1/memory/preferences') {
        if (method === 'PUT') {
          if (!Object.keys(body).length || Object.entries(body).some(([key, value]) => !['globalEnabled', 'sessionDefaultEnabled'].includes(key) || typeof value !== 'boolean')) throw new Error('Invalid preference mutation')
          this.preferences = { ...this.preferences, ...body }
        } else if (method !== 'GET') throw new Error('Invalid preference method')
        response.end(envelope(this.preferences)); return
      }
      if (path === '/api/v1/memory/settings' && method === 'GET') {
        const memoryScope = this.preferences.sessionDefaultEnabled ? 'session' : this.preferences.globalEnabled ? 'global' : 'off'
        response.end(envelope({ ...this.preferences, sessionId, memoryScope, effectiveScope: memoryScope, sessionOverride: null,
          sessionEnabled: this.preferences.sessionDefaultEnabled, effectiveScopes: [...(this.preferences.globalEnabled ? ['global'] : []), ...(this.preferences.sessionDefaultEnabled ? ['session'] : [])] })); return
      }
      if (path === '/api/v1/memory/list' && method === 'GET') {
        this.assertMemoryScope(query)
        const all = this.memories.filter(item => item.scope === query.scope && (query.scope === 'global' || item.sessionId === query.sessionId)
          && (!query.type || item.type === query.type) && (!query.keyword || `${item.summary}\n${item.detail}`.includes(query.keyword)))
        const current = Number(query.current || 1), pageSize = Number(query.pageSize || 20)
        response.end(JSON.stringify({ code: 200, message: 'ok', data: all.slice((current - 1) * pageSize, current * pageSize),
          pagination: { current, pageSize, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / pageSize)) } })); return
      }
      if (path === '/api/v1/memory/nodes' && method === 'POST') {
        this.assertMemoryScope(query); if (reject('memory-save')) return
        if (typeof body.summary !== 'string' || typeof body.type !== 'string') throw new Error('Invalid memory payload')
        const item = { ...body, id: `memory-created-${++this.sequence}`, scope: query.scope,
          ...(query.scope === 'session' ? { sessionId: query.sessionId } : {}), createdAt: 1_700_000_100 } as MemoryRecord
        this.memories.push(item); response.end(envelope(item)); return
      }
      const memoryMatch = /^\/api\/v1\/memory\/([^/]+)$/.exec(path)
      if (memoryMatch) {
        this.assertMemoryScope(query)
        const index = this.memories.findIndex(item => item.id === decodeURIComponent(memoryMatch[1]) && item.scope === query.scope && (query.scope === 'global' || item.sessionId === query.sessionId))
        if (index < 0) throw new Error('Memory request crossed record scope')
        if (method === 'GET') {
          if (this.holdMemoryId === this.memories[index].id) {
            this.holdMemoryId = null; this.heldMemory = { response, record: structuredClone(this.memories[index]) }; return
          }
          response.end(envelope(this.memories[index])); return
        }
        if (method === 'PUT') { if (reject('memory-save')) return; this.memories[index] = { ...this.memories[index], ...body }; response.end(envelope(this.memories[index])); return }
        if (method === 'DELETE') { this.memories.splice(index, 1); response.end(envelope({ deleted: true })); return }
      }
      if (tracked) throw new Error(`Unexpected resource operation: ${method} ${path}`)
      if (path === '/api/v1/workspace/bind' && method === 'POST') { response.end(envelope({ workspaceRoot: resourceWorkspace, bindingEpoch: 'resource-settings', contractVersion: 2 })); return }
      if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
      if (method !== 'GET') throw new Error(`Unexpected application mutation: ${method} ${path}`)
      if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
      const task = resourceTasks.find(item => item.id === sessionId), now = Date.now() - 5000
      const run: RootRun | null = task ? { schemaVersion: 1, runId: `run-${sessionId}`, sessionId, turnId: `turn-${sessionId}`, userMessageId: `user-${sessionId}`,
        assistantMessageId: `assistant-${sessionId}`, seq: 1, version: 2, status: 'succeeded', modelId: resourceModel, pending: [], workspacePaths: [resourceWorkspace], createdAt: now, updatedAt: now, finishedAt: now } : null
      const rows = run ? [
        { id: run.userMessageId, role: 'user', content: task!.title, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
        { id: run.assistantMessageId, role: 'assistant', content: 'RESOURCE_SETTINGS_READY', createdAt: now + 1, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
      ] : []
      const data = path === '/health' ? { status: 'ok' }
        : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'resource-settings-fixture' }
        : path === '/api/v1/models' ? [{ id: resourceModel, modelId: resourceModel, provider: 'openai', displayName: '资源设置测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
        : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
        : path === '/api/v1/chat/status' ? { running: false, finished: true, run, lastEventId: null }
        : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
        : path === '/api/v1/conversation/history' ? rows
        : path === '/api/v1/conversation/sessions' ? resourceTasks.map(task => ({ sessionId: task.id, title: task.title, lastAt: now, messageCount: 2 }))
        : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: rows.filter(row => row.role === 'user').map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: rows.filter(row => row.role === 'user').map(row => row.id), revision: sessionId, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
        : path === '/api/v1/workspace/directory' ? { root: resourceWorkspace, entries: [], bindingEpoch: 'resource-settings' }
        : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
        : /\/sessions\/[^/]+\/toolkits$/.test(path) ? { toolkits: [] }
        : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
        : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
        : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
        : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
        : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
        : path === '/api/v1/command-jobs' ? { jobs: [] }
        : path === '/api/v1/toolkits' ? { toolkits: [] }
        : path === '/api/v1/settings' ? {} : []
      response.end(envelope(data))
    })().catch(error => { this.errors.push(String(error)); if (!response.headersSent) response.writeHead(500); if (!response.writableEnded) response.end('Resource settings fixture failed') }) })
  }
  private assertMemoryScope(query: Record<string, string>): void {
    if (!['global', 'session'].includes(query.scope) || query.scope === 'session' && !resourceTasks.some(task => task.id === query.sessionId)
      || query.scope === 'global' && query.sessionId) throw new Error('Invalid memory scope')
  }
  releaseChunk(): void {
    const held = this.heldChunk; this.heldChunk = null
    if (held && !held.response.destroyed && !held.response.writableEnded) held.response.end(envelope({ importId: held.importId }))
  }
  releaseMemory(): void {
    const held = this.heldMemory; this.heldMemory = null
    if (held && !held.response.destroyed && !held.response.writableEnded) held.response.end(envelope(held.record))
  }
  private addDocument(body: Record<string, unknown>): KnowledgeDocument {
    if (typeof body.filename !== 'string' || typeof body.content !== 'string' || body.knowledgeBaseId && !this.bases.some(base => base.id === body.knowledgeBaseId)) throw new Error('Invalid document upload')
    const document: KnowledgeDocument = { id: `document-created-${++this.sequence}`, filename: body.filename, content: body.content,
      contentType: String(body.contentType ?? 'text/plain'), knowledgeBaseId: typeof body.knowledgeBaseId === 'string' ? body.knowledgeBaseId : null,
      contentExact: true, status: 'ready', chunkCount: 1, createdAt: 1_700_000_100 }
    this.documents.push(document); return document
  }
  reset(): void {
    this.releaseChunk(); this.releaseMemory(); this.holdChunkIndex = null; this.holdMemoryId = null
    this.skills = structuredClone(initialResourceSkills); this.bases = structuredClone(initialResourceBases); this.documents = structuredClone(initialResourceDocuments)
    this.memories = structuredClone(initialResourceMemories); this.preferences = { enabled: true, globalEnabled: false, sessionDefaultEnabled: false }
    this.receipts.length = 0; this.uploads.length = 0; this.imports = []; this.failNext = null; this.sequence = 0
  }
  async start(): Promise<void> {
    await new Promise<void>((done, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', done) })
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Missing resource fixture port')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> { this.server.closeAllConnections(); if (this.server.listening) await new Promise<void>(done => this.server.close(() => done())) }
}
