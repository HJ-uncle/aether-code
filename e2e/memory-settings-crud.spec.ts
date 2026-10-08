import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const sessionId = 'memory-ui-session'
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server | undefined
let baseUrl = ''
let counter = 0

type RecordItem = {
  id: string
  scope: 'global' | 'session'
  sessionId?: string
  type: string
  summary: string
  detail: string | null
  importance: number
  tags: string[]
  createdAt: number
  updatedAt: number
}

const records: RecordItem[] = []

function send(response: import('node:http').ServerResponse, data: unknown, code = 200, message = 'ok', pagination?: unknown): void {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ code, message, data, ...(pagination ? { pagination } : {}) }))
}
function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => { try { resolveBody(JSON.parse(raw || '{}')) } catch (error) { reject(error) } })
    request.on('error', reject)
  })
}
function now(): number { return Math.floor(Date.now() / 1000) }
function scopeOf(url: URL): { scope: 'global' | 'session'; sessionId?: string } {
  const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'global'
  return scope === 'session' ? { scope, sessionId: url.searchParams.get('sessionId') ?? '' } : { scope }
}
function visible(item: RecordItem, scope: { scope: 'global' | 'session'; sessionId?: string }): boolean {
  return item.scope === scope.scope && (scope.scope === 'global' || item.sessionId === scope.sessionId)
}

function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) env[key] = value
  }
  return { ...env, AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'true' }
}

async function launchApp(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: launchEnvironment() })
  page = await app.firstWindow()
  await expect(page.locator('.status-bar')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('ready')
}

async function openMemorySettings(): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible())) await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.getByRole('tab', { name: '记忆', exact: true }).click()
  await expect(page.getByRole('heading', { name: '记忆', exact: true })).toBeVisible()
}

test.describe.serial('全局与会话记忆设置 CRUD 真机闭环', () => {
  test.beforeAll(async () => {
    records.length = 0
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'memory-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        const method = request.method ?? 'GET'
        if (path === '/health') return send(response, { status: 'ok' })
        if (path === '/meta') return send(response, { version: '1.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'memory-ui-fixture' })
        if (path === '/api/v1/tools' || path === '/api/v1/models') return send(response, [])
        if (path === '/api/v1/conversation/sessions') return send(response, [{ sessionId, title: '记忆测试会话', lastAt: now() }])
        if (!path.startsWith('/api/v1/memory')) return send(response, [])
        const parts = path.slice('/api/v1/memory'.length).split('/').filter(Boolean).map(decodeURIComponent)
        const scope = scopeOf(url)
        if (parts[0] === 'list' && method === 'GET') {
          const keyword = (url.searchParams.get('keyword') ?? '').toLowerCase()
          const type = url.searchParams.get('type') ?? ''
          const all = records.filter(item => visible(item, scope) && (!keyword || `${item.summary} ${item.detail ?? ''}`.toLowerCase().includes(keyword)) && (!type || item.type === type))
          const current = Math.max(1, Number(url.searchParams.get('current') ?? 1))
          const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20))
          return send(response, all.slice((current - 1) * pageSize, current * pageSize), 200, 'ok', { current, pageSize, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / pageSize)) })
        }
        if (parts[0] === 'nodes' && method === 'POST') {
          const body = await readBody(request)
          const timestamp = now()
          const item: RecordItem = { id: `memory-${++counter}`, scope: scope.scope, ...(scope.scope === 'session' ? { sessionId: scope.sessionId } : {}), type: String(body.type ?? 'fact'), summary: String(body.summary ?? ''), detail: body.detail == null ? null : String(body.detail), importance: Number(body.importance ?? 0.5), tags: Array.isArray(body.tags) ? body.tags.map(String) : [], createdAt: timestamp, updatedAt: timestamp }
          records.push(item)
          return send(response, item)
        }
        const id = parts[0]
        const item = records.find(candidate => candidate.id === id && visible(candidate, scope))
        if (!item) return send(response, null, 40400, 'Memory not found')
        if (method === 'GET') return send(response, item)
        if (method === 'PUT') {
          const body = await readBody(request)
          if (body.summary !== undefined) item.summary = String(body.summary)
          if (body.detail !== undefined) item.detail = body.detail == null ? null : String(body.detail)
          if (body.type !== undefined) item.type = String(body.type)
          if (body.importance !== undefined) item.importance = Number(body.importance)
          if (body.tags !== undefined) item.tags = Array.isArray(body.tags) ? Array.from(new Set(body.tags.map(String))) : []
          item.updatedAt = now()
          return send(response, item)
        }
        if (method === 'DELETE') {
          records.splice(records.indexOf(item), 1)
          return send(response, { success: true, id })
        }
        return send(response, null, 40400, 'Not found')
      })().catch(error => send(response, null, 50000, error instanceof Error ? error.message : String(error)))
    })
    await new Promise<void>(resolveListen => server!.listen(0, '127.0.0.1', resolveListen))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '', autoStartEngine: true, preferredPort: 12488, lastFolder: '', lastSessionId: sessionId, lastModelId: '' }))
    await launchApp()
    await openMemorySettings()
  })

  test.afterAll(async () => {
    await app?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()))
    if (fixture) {
      if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('memory-ui-')) throw new Error('Unsafe memory fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('全局记忆创建、编辑、搜索筛选、详情和删除', async () => {
    await expect(page.getByText('暂无记忆条目')).toBeVisible()
    await page.getByRole('button', { name: /新建记忆/ }).click()
    await page.getByLabel('记忆摘要').fill('全局偏好：简洁输出')
    await page.getByLabel('记忆详情').fill('所有会话都使用简洁回答')
    await page.getByLabel('记忆标签').fill('global, preference')
    await page.locator('.memory-settings__editor-actions .btn--primary').click()
    await expect(page.getByText('全局偏好：简洁输出')).toBeVisible()
    const row = page.locator('.memory-settings__item').filter({ hasText: '全局偏好：简洁输出' })
    await row.getByRole('button', { name: '编辑记忆' }).click()
    await page.getByLabel('记忆摘要').fill('全局偏好：更新后的简洁输出')
    await page.getByLabel('记忆标签').fill('updated')
    await page.locator('.memory-settings__editor-actions .btn--primary').click()
    await expect(page.getByText('全局偏好：更新后的简洁输出')).toBeVisible()
    await page.getByLabel('搜索记忆').fill('更新后的')
    await page.getByLabel('搜索记忆').press('Enter')
    await expect(page.locator('.memory-settings__item')).toHaveCount(1)
    const updatedRow = page.locator('.memory-settings__item').filter({ hasText: '全局偏好：更新后的简洁输出' })
    await updatedRow.getByRole('button', { name: '查看记忆' }).click()
    await expect(page.getByRole('heading', { name: '记忆详情' })).toBeVisible()
    await page.getByRole('button', { name: '删除记忆' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '删除记忆', exact: true }).click()
    await expect(page.getByText('暂无记忆条目')).toBeVisible()
  })

  test('会话记忆选择会话后创建，并且全局列表不受影响', async () => {
    await page.getByRole('button', { name: '会话记忆', exact: true }).click()
    await page.locator('.memory-settings__session select').selectOption(sessionId)
    await page.getByRole('button', { name: /新建记忆/ }).click()
    await page.getByLabel('记忆摘要').fill('只属于本会话的记忆')
    await page.locator('.memory-settings__editor-actions .btn--primary').click()
    await expect(page.getByText('只属于本会话的记忆')).toBeVisible()
    await page.getByRole('button', { name: '全局记忆', exact: true }).click()
    await expect(page.getByText('暂无记忆条目')).toBeVisible()
    expect(records.some(item => item.scope === 'session' && item.sessionId === sessionId)).toBe(true)
  })
})
