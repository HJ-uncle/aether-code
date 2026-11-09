/** Real Work delivery list: authenticated generated assets, responsive vertical
 * / horizontal navigation, edge hints, native wheel and immutable-file selection.
 * Each layout also audits visible app-owned horizontal scrollers for missing markers. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult } from '../src/shared/final-result'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'horizontal-responsive-fixture-token', sessionId = 'work-horizontal-responsive', modelId = 'responsive-fixture-model'
const title = '成果列表横纵滚动验收', now = Date.now() - 10_000, count = 24
const assets = new Map<string, { name: string; bytes: Buffer; mimeType: string; binary: boolean; marker: string }>()
const errors: string[] = [], reads: string[] = [], mutations: string[] = []
const observations: Array<Record<string, unknown>> = []
const run: RootRun = { schemaVersion: 1, runId: 'responsive-delivery-run', sessionId, turnId: 'responsive-delivery-turn',
  userMessageId: 'responsive-user', assistantMessageId: 'responsive-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
let result: FinalResult, app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const assetId = (index: number) => `responsive-asset-${index}`
const workspace = () => page.getByRole('region', { name: '本会话成果', exact: true })
const files = () => workspace().getByRole('navigation', { name: '本轮交付物', exact: true })
const preview = () => workspace().getByRole('region', { name: '交付物预览', exact: true })
const entry = (index: number) => files().locator(`[data-final-result-item="${assetId(index)}"]`)

async function makeAssets(): Promise<void> {
  for (let index = 0; index < count; index++) {
    const marker = `DELIVERY_CONTENT_${index}`, binary = index === 0
    let bytes = Buffer.from(`${marker}\n已校验的第 ${index + 1} 份成果。\n`)
    if (binary) {
      const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('项目概览')
      sheet.getCell('A1').value = marker; sheet.getColumn(1).width = 30
      bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    }
    assets.set(assetId(index), { name: `交付${String(index + 1).padStart(2, '0')} 项目成果与核对说明.${binary ? 'xlsx' : 'txt'}`,
      bytes, binary, marker, mimeType: binary ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain' })
  }
  result = { schemaVersion: 1, sessionId, runId: run.runId, turnId: run.turnId, assistantMessageId: run.assistantMessageId,
    text: '成果已准备好，可逐份核对。', publishedAt: now,
    items: [...assets].map(([id, asset]) => ({ id, assetId: id, name: asset.name, path: `交付/${asset.name}`, mimeType: asset.mimeType,
      size: asset.bytes.length, sha256: createHash('sha256').update(asset.bytes).digest('hex'), kind: 'file' })) }
}
function history(id: string): EngineHistoryRow[] {
  return id !== sessionId ? [] : [
    { id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: result.text, createdAt: now + 1,
      conversationId: run.turnId, metadata: { rootRunId: run.runId, finalResult: result } }
  ]
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Browsing deliveries must not mutate: ${path}`)
  }
  if (path === '/api/v1/conversation/result-asset') {
    const key = url.searchParams.get('assetId') ?? '', asset = assets.get(key)
    if (!asset || id !== sessionId || url.searchParams.get('runId') !== run.runId) throw new Error('Foreign or unknown result asset')
    reads.push(key)
    response.end(envelope({ content: asset.bytes.toString('base64'), isBinary: asset.binary, encoding: 'base64', totalSize: asset.bytes.length,
      mimeType: asset.mimeType, tooLarge: false, truncated: false })); return
  }
  const rows = history(id), matching = id === sessionId ? run : undefined
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: 'responsive-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'responsive-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '响应式验收模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'responsive-fixture', sessionId: id,
      namespace: { id: 'responsive-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/responsive', entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/responsive' } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

async function setLayout(narrow: boolean): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), narrow ? 1200 : 1440)
  const divider = page.getByRole('separator', { name: '调整对话与工作区宽度', exact: true })
  await expect(divider).toBeVisible()
  const box = (await divider.boundingBox())!, ratio = Number(await divider.getAttribute('aria-valuenow'))
  const width = await divider.evaluate(element => element.parentElement!.clientWidth)
  await page.mouse.move(box.x + box.width / 2, box.y + 100)
  await page.mouse.down()
  try { await page.mouse.move(box.x + box.width / 2 + ((narrow ? 62 : 35) - ratio) * width / 100, box.y + 100, { steps: 8 }) }
  finally { await page.mouse.up() }
  await expect(files()).toHaveCSS('overflow-x', narrow ? 'auto' : 'hidden')
  await expect(files()).toHaveCSS('overflow-y', narrow ? 'hidden' : 'auto')
  await expect.poll(() => workspace().evaluate(element => element.clientWidth)).toBeGreaterThan(narrow ? 250 : 520)
  if (narrow) expect(await workspace().evaluate(element => element.clientWidth)).toBeLessThanOrEqual(520)
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  if (await page.locator('html').getAttribute('data-appearance') === appearance) return
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}
async function selectAsset(index: number): Promise<void> {
  await entry(index).click()
  await expect(entry(index)).toHaveAttribute('aria-current', 'true')
  await expect(preview()).toHaveAttribute('data-final-result-asset', assetId(index))
  const marker = assets.get(assetId(index))!.marker
  if (index === 0) await expect(preview().getByRole('cell', { name: marker, exact: true })).toBeVisible({ timeout: 60_000 })
  else await expect(preview().locator('.work-text-preview')).toContainText(marker)
  expect(reads).toContain(assetId(index))
}
async function auditVisibleHorizontalRegions(label: string, info: TestInfo): Promise<void> {
  const report = await page.evaluate(() => {
    const candidates: Array<Record<string, unknown>> = [], dualAxis: Array<Record<string, unknown>> = []
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      if (!element.getClientRects().length || element.closest('[hidden], [inert], [aria-hidden="true"]')) continue
      const style = getComputedStyle(element), box = element.getBoundingClientRect()
      if (style.visibility !== 'visible' || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight
        || element.scrollWidth <= element.clientWidth + 1 || !/^(auto|scroll)$/.test(style.overflowX)) continue
      const entry = { tag: element.tagName, id: element.id, classes: typeof element.className === 'string' ? element.className : '',
        role: element.getAttribute('role'), label: element.getAttribute('aria-label'), marker: element.getAttribute('data-scroll-axis'),
        overflowX: style.overflowX, overflowY: style.overflowY, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, edges: element.getAttribute('data-scroll-edges') }
      if (/^(auto|scroll)$/.test(style.overflowY)) dualAxis.push(entry)
      else candidates.push(entry)
    }
    return { viewport: { width: innerWidth, height: innerHeight }, candidates, dualAxis }
  })
  observations.push({ label, ...report })
  const output = info.outputPath(`horizontal-audit-${label}.json`)
  writeFileSync(output, JSON.stringify(report, null, 2)); await info.attach(`单轴滚动扫描-${label}`, { path: output, contentType: 'application/json' })
  expect(report.candidates.filter(candidate => candidate.marker !== 'x'), `${label}: missing data-scroll-axis on visible single-axis scrollers`).toEqual([])
}

test.describe.serial('成果文件列表响应式滚动', () => {
  test.beforeAll(async () => {
    await makeAssets()
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'horizontal-responsive-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/responsive', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, now, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
        updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'files', pane: 'workspace', ratio: 35 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(files().getByRole('button')).toHaveCount(count)
    await expect(preview().getByRole('cell', { name: 'DELIVERY_CONTENT_0', exact: true })).toBeVisible({ timeout: 60_000 })
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const screenshot = info.outputPath('responsive-scroll-failure.png')
      await page.screenshot({ path: screenshot }); await info.attach('响应式列表失败窗口', { path: screenshot, contentType: 'image/png' })
    }
    const report = info.outputPath('responsive-scroll-observations.json')
    writeFileSync(report, JSON.stringify({ reads, mutations, errors, observations }, null, 2))
    await info.attach('列表交互回执', { path: report, contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('horizontal-responsive-')) throw new Error('Unsafe responsive fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('窄列表两端渐变和悬浮细条不占高度，切换交付物读取各自内容', async ({}, info) => {
    await setLayout(true)
    await expect(files()).toHaveAttribute('data-scroll-axis', 'x')
    await expect(files()).toHaveCSS('scrollbar-width', 'none')
    const metrics = await files().evaluate(element => {
      const node = element as HTMLElement, style = getComputedStyle(element)
      return { extraHeight: node.offsetHeight - node.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
        widths: [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect().width), overflow: element.scrollWidth - element.clientWidth }
    })
    expect(Math.abs(metrics.extraHeight)).toBeLessThanOrEqual(1)
    expect(metrics.overflow).toBeGreaterThan(200)
    expect(metrics.widths.every(width => width >= 159 && width <= 221)).toBe(true)
    await files().evaluate(element => { element.scrollLeft = 0 })
    await page.mouse.move(24, 80); await expect(files()).toHaveAttribute('data-scroll-edges', 'right')
    await selectAsset(1)
    await files().hover(); const top = await files().evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, 150)
    await expect.poll(() => files().evaluate(element => element.scrollLeft)).toBeGreaterThan(50)
    await expect(files()).toHaveAttribute('data-scroll-edges', 'both')
    expect(await files().evaluate(element => element.scrollTop)).toBe(top)
    const bar = page.locator('.horizontal-scrollbar')
    await expect(bar).toBeVisible()
    const painted = await bar.locator('.horizontal-scrollbar__thumb').evaluate(element => parseFloat(getComputedStyle(element, '::after').height))
    expect(painted).toBeGreaterThan(0); expect(painted).toBeLessThanOrEqual(2)
    await files().evaluate(element => { element.scrollLeft = element.scrollWidth })
    await expect(files()).toHaveAttribute('data-scroll-edges', 'left')
    await selectAsset(count - 1)
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await files().evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2 })
      await page.mouse.move(24, 80); await expect(files()).toHaveAttribute('data-scroll-edges', 'both')
      await auditVisibleHorizontalRegions(`narrow-${appearance}`, info)
      const screenshot = info.outputPath(`responsive-files-narrow-${appearance}.png`)
      await workspace().screenshot({ path: screenshot }); await info.attach(`窄成果列表-${appearance}`, { path: screenshot, contentType: 'image/png' })
    }
  })

  test('恢复宽列表保留原生纵向滚动且清除横向遮罩，再次收窄仍生效', async ({}, info) => {
    await setLayout(false)
    await expect(files()).toHaveCSS('scrollbar-width', 'auto')
    await expect(files()).not.toHaveAttribute('data-scroll-edges')
    await expect(files()).toHaveCSS('mask-image', 'none')
    await expect.poll(() => files().evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(60)
    expect(await files().evaluate(element => parseFloat(getComputedStyle(element, '::-webkit-scrollbar').width))).toBeGreaterThan(0)
    await files().evaluate(element => { element.scrollTop = 0 })
    await files().hover(); await page.mouse.wheel(0, 180)
    await expect.poll(() => files().evaluate(element => element.scrollTop)).toBeGreaterThan(60)
    expect(await files().evaluate(element => element.scrollLeft)).toBe(0)
    await expect(page.locator('.horizontal-scrollbar')).toBeHidden()
    await selectAsset(2)
    for (const appearance of ['dark', 'light'] as const) {
      await setAppearance(appearance); await page.mouse.move(24, 80)
      await expect(files()).not.toHaveAttribute('data-scroll-edges')
      await auditVisibleHorizontalRegions(`wide-${appearance}`, info)
      const screenshot = info.outputPath(`responsive-files-wide-${appearance}.png`)
      await workspace().screenshot({ path: screenshot }); await info.attach(`宽成果列表-${appearance}`, { path: screenshot, contentType: 'image/png' })
    }
    await setLayout(true)
    await files().evaluate(element => { element.scrollLeft = 0 })
    await expect(files()).toHaveAttribute('data-scroll-edges', 'right')
    await selectAsset(0)
    await auditVisibleHorizontalRegions('narrow-again-xlsx', info)
  })
})
