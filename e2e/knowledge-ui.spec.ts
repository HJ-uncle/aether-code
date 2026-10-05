/**
 * 真机：知识库设置与聊天绑定。
 *
 * Electron、preload、主进程 HTTP bridge、设置存储和渲染 UI 都是真实实现；
 * 仅远端引擎由同进程 HTTP 夹具提供，以便每轮使用隔离租户和可控数据。
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'

declare global {
  interface Window { aether: AetherIdeApi }
}

type Base = {
  id: string
  name: string
  description: string
  documentCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}
type Document = {
  id: string
  knowledgeBaseId: string | null
  filename: string
  contentType: string
  content: string
  chunkCount: number
  status: 'ready'
  error: null
  createdAt: number
  updatedAt: number
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const sessionId = 'knowledge-ui-session'
const oversizedContent = 1024 * 1024 + 1
let fixture = ''
let baseUrl = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server | undefined
let baseCounter = 0
let documentCounter = 0
let bases: Base[] = []
let documents: Document[] = []

function now(): number { return Math.floor(Date.now() / 1000) }

function envelope(data: unknown, code = 200, message = 'ok'): string {
  return JSON.stringify({ code, message, data })
}

function responseJson(response: import('node:http').ServerResponse, data: unknown, code = 200, message = 'ok'): void {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  response.end(envelope(data, code, message))
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => resolveBody(raw))
    request.on('error', reject)
  })
}

function baseWithCounts(base: Base): Base {
  const docs = documents.filter(document => document.knowledgeBaseId === base.id)
  return { ...base, documentCount: docs.length, chunkCount: docs.reduce((sum, item) => sum + item.chunkCount, 0) }
}

function findBase(id: string): Base | undefined { return bases.find(base => base.id === id) }
function findDocument(id: string): Document | undefined { return documents.find(document => document.id === id) }

function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) env[key] = value
  }
  return {
    ...env,
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: join(fixture, 'workspace'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
    SKILLS_ROOT: join(fixture, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false'
  }
}

async function launchApp(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: launchEnvironment() })
  page = await app.firstWindow()
  await expect(page.locator('.status-bar')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('ready')
}

async function openKnowledgeSettings(): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible())) await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.getByRole('tab', { name: '知识库', exact: true }).click()
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible()
}

async function confirmDialog(buttonName: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: buttonName, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

function documentRow(filename: string) {
  return page.locator('.knowledge-document').filter({ hasText: filename }).first()
}

test.describe.serial('知识库设置与聊天绑定真机验收', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'knowledge-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })

    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        if (path === '/health') return responseJson(response, { status: 'ok' })
        if (path === '/meta') return responseJson(response, {
          version: '1.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1,
          toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'knowledge-ui-fixture'
        })
        if (path === '/api/v1/tools') return responseJson(response, [])
        if (!path.startsWith('/api/v1/knowledge/')) return responseJson(response, [])

        const knowledgePath = path.slice('/api/v1/knowledge'.length)
        const parts = knowledgePath.split('/').filter(Boolean).map(decodeURIComponent)
        const method = request.method ?? 'GET'

        if (parts[0] === 'formats' && method === 'GET') return responseJson(response, {
          extensions: ['.txt', '.md', '.json', '.pdf', '.docx', '.xlsx', '.png'],
          description: '文本/代码、表格、文档、PDF 和图片 OCR'
        })

        if (parts[0] === 'bases') {
          if (method === 'GET' && parts.length === 1) return responseJson(response, bases.map(baseWithCounts))
          if (method === 'POST' && parts.length === 1) {
            const body = JSON.parse(await readBody(request) || '{}') as { name?: string; description?: string }
            const base: Base = {
              id: `kb-ui-${++baseCounter}`, name: String(body.name ?? ''), description: String(body.description ?? ''),
              documentCount: 0, chunkCount: 0, createdAt: now(), updatedAt: now()
            }
            bases.push(base)
            return responseJson(response, baseWithCounts(base))
          }
          const id = parts[1]
          const base = findBase(id)
          if (!base) return responseJson(response, null, 40400, 'Knowledge base not found')
          if (method === 'PUT') {
            const body = JSON.parse(await readBody(request) || '{}') as { name?: string; description?: string }
            if (body.name !== undefined) base.name = body.name
            if (body.description !== undefined) base.description = body.description
            base.updatedAt = now()
            return responseJson(response, baseWithCounts(base))
          }
          if (method === 'DELETE') {
            bases = bases.filter(item => item.id !== id)
            documents = documents.filter(item => item.knowledgeBaseId !== id)
            return responseJson(response, { deleted: true })
          }
        }

        if (parts[0] === 'documents') {
          if (method === 'GET' && parts.length === 1) {
            const scope = url.searchParams.get('knowledgeBaseId')
            return responseJson(response, documents.filter(document => !scope || document.knowledgeBaseId === scope))
          }
          if (method === 'POST' && parts.length === 1) {
            const body = JSON.parse(await readBody(request) || '{}') as { filename?: string; content?: string; contentType?: string; knowledgeBaseId?: string }
            const content = String(body.content ?? '')
            if (content.length > 1024 * 1024) return responseJson(response, null, 40001, '文档内容超过允许大小（1 MiB）')
            const item: Document = {
              id: `doc-ui-${++documentCounter}`, knowledgeBaseId: body.knowledgeBaseId ?? null,
              filename: String(body.filename ?? ''), contentType: String(body.contentType ?? 'text/plain'), content,
              chunkCount: content ? Math.max(1, Math.ceil(content.length / 512)) : 0,
              status: 'ready', error: null, createdAt: now(), updatedAt: now()
            }
            documents.push(item)
            return responseJson(response, item)
          }
          const id = parts[1]
          const document = findDocument(id)
          if (!document) return responseJson(response, null, 40400, 'Document not found')
          if (method === 'GET') return responseJson(response, document)
          if (method === 'PUT') {
            const body = JSON.parse(await readBody(request) || '{}') as Partial<Document>
            if (body.filename !== undefined) document.filename = String(body.filename)
            if (body.content !== undefined) {
              if (String(body.content).length > 1024 * 1024) return responseJson(response, null, 40001, '文档内容超过允许大小（1 MiB）')
              document.content = String(body.content)
              document.chunkCount = Math.max(1, Math.ceil(document.content.length / 512))
            }
            document.updatedAt = now()
            return responseJson(response, document)
          }
          if (method === 'DELETE') {
            documents = documents.filter(item => item.id !== id)
            return responseJson(response, { deleted: true })
          }
        }

        if (parts[0] === 'search' && method === 'POST') {
          const body = JSON.parse(await readBody(request) || '{}') as { query?: string; knowledgeBaseIds?: string[] }
          const query = String(body.query ?? '').toLowerCase()
          const scopes = body.knowledgeBaseIds?.length ? new Set(body.knowledgeBaseIds) : null
          const results = documents
            .filter(document => (!scopes || scopes.has(document.knowledgeBaseId ?? '')) && document.content.toLowerCase().includes(query))
            .map((document, index) => ({ chunkId: `${document.id}-0`, documentId: document.id, knowledgeBaseId: document.knowledgeBaseId, filename: document.filename, content: document.content, score: 1, chunkIndex: index }))
          return responseJson(response, results)
        }
        return responseJson(response, null, 40400, 'Not found')
      })().catch(error => responseJson(response, null, 50000, error instanceof Error ? error.message : String(error)))
    })
    await new Promise<void>(resolveListen => server!.listen(0, '127.0.0.1', resolveListen))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '', autoStartEngine: true,
      preferredPort: 12488, lastFolder: '', lastSessionId: sessionId, lastModelId: ''
    }))
    await launchApp()
    await openKnowledgeSettings()
  })

  test.afterAll(async () => {
    await app?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()))
    if (fixture) {
      if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('knowledge-ui-')) throw new Error('Unsafe knowledge fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('知识库创建栏在窄设置面板保持紧凑控件高度', async () => {
    const heights = await page.locator('.knowledge-toolbar__fields .field__input').evaluateAll(
      elements => elements.map(element => Math.round(element.getBoundingClientRect().height))
    )
    // The settings body is intentionally narrow beside the explorer/chat panes.
    // Desktop flex-basis values must not become 180/240px vertical heights.
    expect(heights.length).toBe(2)
    expect(Math.max(...heights)).toBeLessThanOrEqual(40)
  })

  test('创建并编辑知识库，保存后的名称和描述可重新读取', async () => {
    await page.getByLabel('知识库名称', { exact: true }).fill('知识库界面验收')
    await page.getByLabel('知识库描述', { exact: true }).fill('知识库编辑描述')
    await page.getByRole('button', { name: '新建知识库', exact: true }).click()
    await expect(page.locator('#knowledge-base-select')).toContainText('知识库界面验收')
    await expect.poll(() => bases.length).toBe(1)

    await page.getByRole('button', { name: '编辑知识库', exact: true }).click()
    await page.getByLabel('编辑知识库名称', { exact: true }).fill('知识库界面验收（已编辑）')
    await page.getByLabel('编辑知识库描述', { exact: true }).fill('保存后的知识库描述')
    await page.getByRole('button', { name: '保存知识库', exact: true }).click()
    await expect(page.locator('#knowledge-base-select')).toContainText('知识库界面验收（已编辑）')
    expect(bases[0]).toMatchObject({ name: '知识库界面验收（已编辑）', description: '保存后的知识库描述' })
  })

  test('上传文本文档，详情编辑、检索和删除均更新真实引擎夹具', async () => {
    await page.locator('#knowledge-base-select').selectOption({ label: '知识库界面验收（已编辑）' })
    await page.getByLabel('文档文件名', { exact: true }).fill('guide.txt')
    await page.getByLabel('文档内容', { exact: true }).fill('AETHER_KNOWLEDGE_SEARCH_MARKER')
    await page.getByRole('button', { name: '上传并索引', exact: true }).click()
    await expect(documentRow('guide.txt')).toBeVisible()
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({ filename: 'guide.txt', content: 'AETHER_KNOWLEDGE_SEARCH_MARKER', status: 'ready' })

    const row = documentRow('guide.txt')
    await row.getByRole('button', { name: '详情', exact: true }).click()
    await expect(page.getByText('文档详情', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '编辑文档', exact: true }).click()
    await expect(page.getByLabel('编辑文档文件名', { exact: true })).toBeVisible()
    await expect(page.getByLabel('编辑文档内容', { exact: true })).toHaveValue('AETHER_KNOWLEDGE_SEARCH_MARKER')
    await page.getByLabel('编辑文档文件名', { exact: true }).fill('guide-edited.md')
    await page.getByLabel('编辑文档内容', { exact: true }).fill('AETHER_KNOWLEDGE_EDITED_MARKER')
    await page.getByRole('button', { name: '保存文档', exact: true }).click()
    await expect(documentRow('guide-edited.md')).toBeVisible()
    expect(documents[0]).toMatchObject({ filename: 'guide-edited.md', content: 'AETHER_KNOWLEDGE_EDITED_MARKER' })

    await page.getByLabel('知识库检索关键词', { exact: true }).fill('EDITED_MARKER')
    await page.getByRole('button', { name: '检索', exact: true }).click()
    await expect(page.locator('.knowledge-results')).toContainText('AETHER_KNOWLEDGE_EDITED_MARKER')

    await documentRow('guide-edited.md').getByRole('button', { name: '删除', exact: true }).click()
    await confirmDialog('删除文档')
    await expect(documentRow('guide-edited.md')).toHaveCount(0)
    expect(documents).toHaveLength(0)
  })

  test('格式说明与当前知识库作用域保持同步', async () => {
    const formats = page.locator('.knowledge-formats')
    await formats.locator('summary').click()
    await expect(formats).toContainText('文本/代码、表格、文档、PDF 和图片 OCR')
    const fileInput = page.locator('input[type="file"][aria-label="选择文档文件"]')
    await expect(fileInput).toHaveAttribute('accept', expect.stringContaining('.pdf'))
    await fileInput.setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
    await expect(page.locator('.knowledge-file-drop__selected')).toContainText('fixture.pdf')
    // Continue with a plain-text upload so this test keeps the fixture focused on
    // the UI selection path; the engine's multipart extraction is covered by the
    // knowledge route tests.
    await page.getByLabel('文档内容', { exact: true }).fill('')

    await page.getByLabel('知识库名称', { exact: true }).fill('第二个知识库')
    await page.getByRole('button', { name: '新建知识库', exact: true }).click()
    await expect(page.locator('#knowledge-base-select')).toHaveValue(/kb-ui-/)
    await page.getByLabel('文档文件名', { exact: true }).fill('second.txt')
    await page.getByLabel('文档内容', { exact: true }).fill('SECOND_KB_MARKER')
    await page.getByRole('button', { name: '上传并索引', exact: true }).click()
    await expect(documentRow('second.txt')).toBeVisible()

    // Switching to all bases and back must update both the list and retrieval scope.
    await page.locator('#knowledge-base-select').selectOption('')
    await expect(documentRow('second.txt')).toBeVisible()
    await page.locator('#knowledge-base-select').selectOption({ label: '第二个知识库' })
    await expect(page.locator('.knowledge-document-summary')).toContainText('“第二个知识库”中的文档')
    await expect(documentRow('second.txt')).toBeVisible()
    await page.getByLabel('知识库检索关键词', { exact: true }).fill('SECOND_KB_MARKER')
    await page.getByRole('button', { name: '检索', exact: true }).click()
    await expect(page.locator('.knowledge-results')).toContainText('SECOND_KB_MARKER')
  })

  test('超过文档大小限制时 UI 阻止上传且不创建文档', async () => {
    await page.getByLabel('文档文件名', { exact: true }).fill('too-large.txt')
    await page.getByLabel('文档内容', { exact: true }).fill('x'.repeat(oversizedContent))
    const upload = page.getByRole('button', { name: '上传并索引', exact: true })
    await expect(upload).toBeDisabled()
    await expect(page.locator('.knowledge-size-hint')).toContainText('1048576')
    expect(documents.some(document => document.filename === 'too-large.txt')).toBe(false)
  })

  test('聊天资源选择器可绑定当前会话，关闭后重开会刷新知识库列表', async () => {
    // Recreate a base after the previous lifecycle test so the picker sees a real document count.
    const base: Base = { id: `kb-ui-${++baseCounter}`, name: '聊天绑定知识库', description: '', documentCount: 0, chunkCount: 0, createdAt: now(), updatedAt: now() }
    bases.push(base)
    const document: Document = { id: `doc-ui-${++documentCounter}`, knowledgeBaseId: base.id, filename: 'binding.txt', contentType: 'text/plain', content: 'binding', chunkCount: 1, status: 'ready', error: null, createdAt: now(), updatedAt: now() }
    documents.push(document)

    const composer = page.locator('.chat__input')
    await composer.click()
    await composer.fill('')
    await composer.type('/kb')
    const resources = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    await expect(resources).toBeVisible()

    const item = resources.getByRole('option').filter({ hasText: '聊天绑定知识库' })
    await expect(item).toBeVisible()
    await item.click()
    await expect(page.locator('.resource-binding-chip.is-kb')).toContainText(base.id)
    expect(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), base.id)).toBe(true)
    await page.locator('.resource-binding-chip.is-kb').click()
    expect(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), base.id)).toBe(false)

    const refreshed: Base = { id: `kb-ui-${++baseCounter}`, name: '重新打开后出现的知识库', description: '', documentCount: 0, chunkCount: 0, createdAt: now(), updatedAt: now() }
    bases.push(refreshed)
    await composer.click()
    await composer.fill('')
    await composer.type('/kb')
    await expect(resources).toBeVisible()
    await expect(resources.getByRole('option', { name: /重新打开后出现的知识库/ })).toBeVisible()
  })
})
