/** Fresh native Excel chart Work acceptance. Original binary files come from the
 * current built engine, then pass through real Work IPC, workers and previews.
 * Fixture engine is isolated; no production models, old E2E or export dialogs. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { WorkbenchBridge, WorkbenchAction } from '../../ai-agent-engine/src/tools/workbench/bridge'
import type { AgentContext, ToolResult } from '../../ai-agent-engine/src/core/agent-context'
import type { BrowserExecutionIdentity } from '../../ai-agent-engine/src/core/browser-execution'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const sessionId = 'work-xlsx-charts', modelId = 'xlsx-charts-fixture', token = 'xlsx-charts-instance-token'
const title = 'Excel 原生图表验收', now = Date.now(), identity = { tenantId: 'default' }
const ctx = { sessionId, rootSessionId: sessionId, rootRunId: 'xlsx-charts-run' } as AgentContext
const importBuilt = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>
const errors: string[] = [], files = new Map<string, Buffer>(), hashes = new Map<string, string>()
let bridge: WorkbenchBridge, app: ElectronApplication | undefined, page: Page
let fixture = '', workspace = '', connected = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
type BridgeBody = { sessionId: string; actions: WorkbenchAction[]; clientToken: string; requestId: string; execution: BrowserExecutionIdentity; result: ToolResult }

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated: ${path}`)
  if (path.startsWith('/api/v1/workbench/clients')) {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as BridgeBody
    if (path === '/api/v1/workbench/clients') {
      const client = bridge.register(identity, body.sessionId, body.actions)
      if (body.sessionId === sessionId) connected = true
      response.end(envelope(client)); return
    }
    const match = /^\/api\/v1\/workbench\/clients\/([^/]+)\/(poll|state|results|disconnect)$/.exec(path)
    if (!match) throw new Error('Unknown bridge route')
    const [, id, action] = match
    if (action === 'poll') response.end(envelope({ commands: await bridge.poll(identity, id, body.clientToken) }))
    else if (action === 'state') response.end(envelope({ active: bridge.active(identity, id, body.clientToken, body.requestId, body.execution) }))
    else if (action === 'results') response.end(envelope({ accepted: bridge.result(identity, id, body.clientToken, body.requestId, body.execution, body.result) }))
    else { bridge.unregister(identity, id, body.clientToken); response.end(envelope({ removed: true })) }
    return
  }
  if (['/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  const id = url.searchParams.get('sessionId') ?? ''
  if (path === '/api/v1/workspace/file/content') {
    const relative = url.searchParams.get('path') ?? '', bytes = files.get(relative)
    if (id !== sessionId || !bytes) throw new Error(`Unexpected file read: ${relative}`)
    response.end(envelope({ content: bytes.toString('base64'), isBinary: true, totalSize: bytes.length, root: workspace, bindingEpoch: 'audit-one' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'xlsx-charts-engine' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Office 验收夹具', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'default', sessionId: id, namespace: { id: 'xlsx-charts-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 0 }]
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'audit-one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace } : []
  response.end(envelope(data))
})().catch(error => {
  const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
  if (status !== 409) errors.push(String(error))
  if (!response.headersSent) response.writeHead(status)
  response.end(JSON.stringify({ code: status, message: String(error), data: null }))
}) })

const types = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] as const
const names = ['月度产出', '投入对比', '进度走势', '资源投入', '业务占比', '任务构成', '样本分布']

test.beforeAll(async () => {
  mkdirSync(tempRoot, { recursive: true }); fixture = mkdtempSync(join(tempRoot, 'xlsx-charts-profile-'))
  workspace = join(fixture, 'workspace'); mkdirSync(workspace)
  const engineDist = resolve(root, '../ai-agent-engine/dist')
  const { WorkbenchBridge } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/workbench/bridge')>(pathToFileURL(join(engineDist, 'tools/workbench/bridge.js')).href)
  bridge = new WorkbenchBridge()
  const { createXlsx, appendXlsxSheets } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/office/xlsx')>(pathToFileURL(join(engineDist, 'tools/office/xlsx.js')).href)
  let bytes = await createXlsx({ sheets: [{ name: '七种图表', columns: [
    { header: '月份', key: 'month', type: 'text' }, { header: '产出', key: 'output', type: 'number' },
    { header: '投入', key: 'cost', type: 'number' }, { header: '样本位置', key: 'x', type: 'number' }
  ], rows: [{ month: '一月', output: 12, cost: 8, x: 1 }, { month: '二月', output: 25, cost: 13, x: 2 }, { month: '三月', output: 18, cost: 16, x: 5 }, { month: '四月', output: 38, cost: 20, x: 9 }],
  charts: types.map((type, index) => ({ type, title: names[index], categoryKey: type === 'scatter' ? 'x' : 'month',
    series: type === 'pie' || type === 'doughnut' ? [{ key: 'output' }] : [{ key: 'output' }, { key: 'cost' }] }))
  }] })
  bytes = await appendXlsxSheets(bytes, { sheets: [{ name: '空值与负数', columns: [{ header: '阶段', key: 'label' }, { header: '变化', key: 'value', type: 'number' }],
    rows: [{ label: '开始', value: 10 }, { label: '缺数据', value: null }, { label: '持平', value: 0 }, { label: '回落', value: -4 }, { label: '恢复', value: 20 }],
    charts: [{ type: 'line', title: '空值不会变成零', categoryKey: 'label', series: [{ key: 'value' }] }] },
    { name: '复杂图表', columns: [{ header: '分类', key: 'label' }, { header: '值', key: 'value', type: 'number' }], rows: [{ label: '甲', value: 12 }, { label: '乙', value: 8 }],
    charts: [{ type: 'column', title: '原有堆叠图', categoryKey: 'label', series: [{ key: 'value' }] }] }
  ] })
  const zip = await JSZip.loadAsync(bytes)
  // Simulate an ordinary existing workbook with an old chart cache and a
  // currently unsupported chart. Actual cells must win; unsupported must show.
  const paths = Object.keys(zip.files).filter(file => /^xl\/charts\/[^/]+\.xml$/.test(file))
  const first = paths[0], last = paths[paths.length - 1]
  zip.file(first, (await zip.file(first)!.async('string')).replace('<c:v>12</c:v>', '<c:v>999</c:v>'))
  zip.file(last, (await zip.file(last)!.async('string')).replace('val="clustered"', 'val="stacked"'))
  const workbook = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  files.set('charts.xlsx', workbook); writeFileSync(join(workspace, 'charts.xlsx'), workbook)
  hashes.set('charts.xlsx', createHash('sha256').update(workbook).digest('hex'))
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: workspace, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'dark', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect.poll(() => connected).toBe(true)
  const result = await bridge.execute('artifact.open', { path: join(workspace, 'charts.xlsx') }, ctx)
  expect(result.success, result.output).toBe(true)
  await expect(page.getByRole('table', { name: '七种图表', exact: true })).toBeVisible()
})

test.afterAll(async () => {
  try { await app?.close() } finally {
    bridge?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== tempRoot || !basename(target).startsWith('xlsx-charts-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
const preview = () => page.locator('.document-preview[data-document-preview="xlsx"]:visible')
async function showSheet(name: string) {
  const back = preview().getByRole('button', { name: '返回工作表' })
  if (await back.isVisible()) await back.click()
  await preview().getByRole('tab', { name, exact: true }).click()
}
async function selectChart(name: string) {
  await preview().getByRole('button', { name: '图表', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
  const figure = preview().locator('[data-focused-chart]').getByRole('figure', { name, exact: true })
  await expect(figure).toBeVisible()
  return figure
}

async function expectReadableNavigation() {
  await expect(async () => {
  const result = await preview().getByRole('button', { name: '返回工作表' }).evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const ancestors: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
    for (const ancestor of ancestors) { context.fillStyle = getComputedStyle(ancestor).backgroundColor; context.fillRect(0, 0, 1, 1) }
    const background = context.getImageData(0, 0, 1, 1).data
    context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
    const foreground = context.getImageData(0, 0, 1, 1).data
    const luminance = (rgba: Uint8ClampedArray) => {
      const linear = [...rgba].slice(0, 3).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const values = [luminance(background), luminance(foreground)]
    return { contrast: (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05), color: getComputedStyle(element).color, background: [...background], appearance: document.documentElement.dataset.appearance }
  })
  expect(result.contrast, JSON.stringify(result)).toBeGreaterThanOrEqual(4.5)
  }).toPass({ timeout: 3000 })
}

test('seven native chart types can be found and read in Work, with data and theme views', async ({}, info) => {
  await showSheet('七种图表')
  await expect(preview().getByRole('button', { name: '图表', exact: true })).toContainText('7')
  for (const [index, type] of types.entries()) {
    const figure = await selectChart(names[index])
    await expect(figure).toHaveAttribute('data-chart-type', type)
    await expect(figure.getByRole('img')).toBeVisible()
    if (type === 'pie' || type === 'doughnut') await expect(figure.locator('[data-chart-slice]')).toHaveCount(4)
    else await expect(figure.locator('[data-chart-point]')).toHaveCount(8)
    if (['column', 'line', 'area'].includes(type)) {
      // SVG title is a tooltip child, not a second painted category label.
      const labels = await figure.locator('svg .spreadsheet-chart__category').evaluateAll(nodes => nodes.map(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('')))
      expect(labels).toEqual(['一月', '二月', '三月', '四月'])
    }
    const invalid = await figure.locator('svg [d],svg [x],svg [cx]').evaluateAll(nodes => nodes.flatMap(node => [...node.attributes].filter(attribute => /^(?:d|x|y|cx|cy|width|height)$/.test(attribute.name) && /NaN|Infinity/.test(attribute.value)).map(attribute => attribute.value)))
    expect(invalid).toEqual([])
    await figure.screenshot({ path: info.outputPath(`${type}-dark.png`) })
  }
  const column = await selectChart(names[0])
  await column.getByRole('button', { name: `查看数据：${names[0]}` }).click()
  await expect(column.getByRole('cell', { name: '12', exact: true })).toBeVisible()
  await expect(column.getByRole('cell', { name: '999', exact: true })).toHaveCount(0)
  await column.getByRole('button', { name: `显示图形：${names[0]}` }).click()
  await expectReadableNavigation()
  await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
  await expectReadableNavigation()
  await preview().screenshot({ path: info.outputPath('column-light.png') })
  await preview().getByRole('button', { name: '返回工作表' }).click()
  await expect(preview().getByRole('table', { name: '七种图表', exact: true })).toBeVisible()
  await expect(preview().locator('[data-focused-chart]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('missing values remain gaps, zero and negatives remain data, and narrow preview stays usable', async ({}, info) => {
  await showSheet('空值与负数')
  const figure = await selectChart('空值不会变成零')
  await expect(figure.locator('[data-chart-point]')).toHaveCount(4)
  await expect(figure.locator('[data-chart-point="1"]')).toHaveCount(0)
  await expect(figure.locator('[data-chart-line]')).toHaveCount(2)
  await figure.getByRole('button', { name: '查看数据：空值不会变成零' }).click()
  await expect(figure.getByRole('cell', { name: '0', exact: true })).toBeVisible()
  await expect(figure.getByRole('cell', { name: '-4', exact: true })).toBeVisible()
  await expect(figure.getByRole('cell', { name: '—', exact: true })).toBeVisible()
  await figure.getByRole('button', { name: '显示图形：空值不会变成零' }).click()
  await preview().screenshot({ path: info.outputPath('line-gaps-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
  await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1080, 800) })
  await expect(preview().getByRole('button', { name: '返回工作表' })).toBeInViewport()
  await expect(preview().getByRole('button', { name: '图表', exact: true })).toBeInViewport()
  await expectReadableNavigation()
  const overflow = await figure.evaluate(element => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await preview().screenshot({ path: info.outputPath('line-compact-dark.png') })
  expect(errors).toEqual([])
})

test('unsupported charts explain the limitation without losing the underlying sheet or changing the file', async ({}, info) => {
  await showSheet('复杂图表')
  const figure = await selectChart('原有堆叠图')
  await expect(figure).toHaveAttribute('data-chart-type', 'unsupported')
  await expect(figure.getByText('此图表的类型或设置暂不支持预览，原图表已保留。')).toBeVisible()
  await expect(figure.getByRole('img')).toHaveCount(0)
  await figure.locator('summary').click()
  await expect(figure.locator('details')).toContainText('堆积')
  await preview().screenshot({ path: info.outputPath('unsupported-chart.png') })
  await preview().getByRole('button', { name: '返回工作表' }).click()
  await expect(preview().getByRole('table', { name: '复杂图表', exact: true }).getByRole('cell', { name: '甲', exact: true })).toBeVisible()
  expect(createHash('sha256').update(readFileSync(join(workspace, 'charts.xlsx'))).digest('hex')).toBe(hashes.get('charts.xlsx'))
  expect(errors).toEqual([])
})

test('inline chart inspection restores worksheet position and chart menu works from the keyboard', async () => {
  await showSheet('七种图表')
  const sheetBody = preview().getByRole('tabpanel')
  const anchor = preview().locator('.document-preview__chart-anchor').first()
  await sheetBody.evaluate((element, position) => element.scrollTo({ top: position.top, left: position.left }),
    await anchor.evaluate(element => ({ top: Math.max(0, (element as HTMLElement).offsetTop - 16), left: Math.max(0, (element as HTMLElement).offsetLeft - 16) })))
  const open = anchor.getByRole('button', { name: `查看图表：${names[0]}` })
  await open.scrollIntoViewIfNeeded()
  await expect(open).toBeInViewport()
  const position = await sheetBody.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))
  await open.click()
  await expect(preview().locator('[data-focused-chart]').getByRole('figure', { name: names[0], exact: true })).toBeVisible()
  await preview().getByRole('button', { name: '返回工作表' }).click()
  await expect.poll(() => sheetBody.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(position)
  const menu = preview().getByRole('button', { name: '图表', exact: true })
  await menu.focus(); await page.keyboard.press('Enter')
  const choice = page.getByRole('menuitem', { name: names[2], exact: true })
  await expect(choice).toBeVisible(); await choice.focus(); await page.keyboard.press('Enter')
  await expect(preview().locator('[data-focused-chart]').getByRole('figure', { name: names[2], exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

