/** New PPT design acceptance: real engine-generated OOXML, real workbench bridge,
 * Work client, Office worker and isolated Chromium capture. No legacy/export tests.
 * Build both repos first; AETHER_E2E_APP_ENTRY selects the fresh client build. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { WorkbenchBridge, WorkbenchAction } from '../../ai-agent-engine/src/tools/workbench/bridge'
import type { AgentContext, ToolResult } from '../../ai-agent-engine/src/core/agent-context'
import type { BrowserExecutionIdentity } from '../../ai-agent-engine/src/core/browser-execution'
import type { PptxInput } from '../../ai-agent-engine/src/tools/office/pptx-schema'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const sessionId = 'work-ppt-design', modelId = 'ppt-design-fixture', token = 'ppt-design-instance-token'
const title = 'PPT 内容设计与逐页验收', now = Date.now(), identity = { tenantId: 'default' }
const ctx = { sessionId, rootSessionId: sessionId, rootRunId: 'ppt-design-run' } as AgentContext
const importBuilt = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>
const errors: string[] = [], readPaths: string[] = []
let bridge: WorkbenchBridge, app: ElectronApplication | undefined, page: Page
let fixture = '', workspace = '', deckPath = '', hash = '', deck: Buffer, connected = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
type BridgeBody = { sessionId: string; actions: WorkbenchAction[]; clientToken: string; requestId: string; execution: BrowserExecutionIdentity; result: ToolResult }
function markerImage(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
    let value = 0xffffffff
    for (const byte of Buffer.concat([name, data])) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
    }
    length.writeUInt32BE(data.length); crc.writeUInt32BE((value ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, name, data, crc])
  }
  const width = 320, height = 180, header = Buffer.alloc(13), pixels = Buffer.alloc((width * 3 + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3
    const color = y < 18 || y >= 162 ? [52, 86, 162] : x < 160 ? [197, 80, 56] : [46, 110, 97]
    pixels.set(color, offset)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated: ${path}`)
  if (path.startsWith('/api/v1/workbench/clients')) {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as BridgeBody
    if (path === '/api/v1/workbench/clients') {
      const client = bridge.register(identity, body.sessionId, body.actions)
      if (body.sessionId === sessionId) { expect(body.actions).toContain('artifact.render'); connected = true }
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
    const relative = url.searchParams.get('path')
    if (id !== sessionId || relative !== 'design-review.pptx') throw new Error('Unexpected session file read')
    readPaths.push(relative)
    response.end(envelope({ content: deck.toString('base64'), isBinary: true, totalSize: deck.length, root: workspace, bindingEpoch: 'ppt-one' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'ppt-design-engine' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'PPT 验收夹具', isEnabled: true, capabilities: { toolCalling: true, vision: true } }]
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'default', sessionId: id,
      namespace: { id: 'ppt-design-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 0 }]
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'ppt-one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace } : []
  response.end(envelope(data))
})().catch(error => {
  // Match the real bridge HTTP route: a reload can overlap its old lease until
  // disconnect arrives. The client retries 409; it is not a renderer exception.
  const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
  if (status !== 409) errors.push(String(error))
  if (!response.headersSent) response.writeHead(status)
  response.end(JSON.stringify({ code: status, message: String(error), data: null }))
}) })

test.beforeAll(async () => {
  mkdirSync(tempRoot, { recursive: true }); fixture = mkdtempSync(join(tempRoot, 'ppt-design-profile-'))
  workspace = join(fixture, 'workspace'); mkdirSync(workspace)
  const engineDist = resolve(root, '../ai-agent-engine/dist')
  const { WorkbenchBridge } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/workbench/bridge')>(pathToFileURL(join(engineDist, 'tools/workbench/bridge.js')).href)
  bridge = new WorkbenchBridge()
  const { createPptx } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/office/pptx')>(pathToFileURL(join(engineDist, 'tools/office/pptx.js')).href)
  const png = markerImage()
  writeFileSync(join(workspace, 'marker.png'), png)
  const input: PptxInput = { title, theme: { accent: 'B75A36', background: 'F6F2EB', foreground: '20362D', muted: '65736C' }, slides: [
    { title: '让内容决定每一页', layout: 'cover', subtitle: 'PPT_DESIGN_ACCEPTANCE · 原文件逐页检查' },
    { title: '从问题到可执行计划', layout: 'section', subtitle: '01 / 清晰表达' },
    { title: '先确定读者需要什么', layout: 'bullets', bullets: ['每页只回答一个主要问题', '关键数字保留来源和单位', '正文可编辑，图表可修改数据'] },
    { title: '两种表达方式的比较', layout: 'columns', columns: [{ title: '文字清单', body: '适合少量结论和行动要求。避免把所有资料塞在一页。' }, { title: '原生图表', body: '适合趋势和量级比较。保留数据，便于后续编辑。' }] },
    { title: '图片来自真实文件', layout: 'image', subtitle: '图片与源文件一同写入演示文稿', image: { path: 'marker.png', fit: 'contain', caption: '测试图片用于验证嵌入和解码' } },
    { title: '可编辑的数据比较', layout: 'chart', chart: { type: 'bar', categories: ['第一周', '第二周', '第三周'], series: [{ name: '样例数量', values: [12, 25, 38] }] } },
    { title: '明确下一步与责任人', layout: 'table', table: { headers: ['行动', '负责人', '时间'], rows: [['整理来源', '研究员', '周一'], ['检查页面', '设计师', '周二'], ['交付验收', '测试员', '周三']] } },
    { title: '表达原则', layout: 'quote', quote: { text: '清楚表达，比装满一页更重要。', attribution: '本次验收样例' } },
    { title: '从草稿到真实画面', layout: 'timeline', steps: [{ title: '规划', body: '明确结论与证据' }, { title: '生成', body: '保存可编辑对象' }, { title: '验收', body: '逐页看实际画面' }] },
    { title: '自定义构图', layout: 'custom', elements: [{ type: 'shape', shape: 'rect', x: 0, y: 0, w: 5, h: 7.5, fill: '20362D' }, { type: 'text', text: '自由构图', x: 0.7, y: 2.4, w: 3.7, h: 1, fontSize: 36, bold: true, color: 'FFFFFF' }, { type: 'text', text: '保持对齐、留白和可编辑文字。', x: 6, y: 2.7, w: 6, h: 1, fontSize: 24, color: '20362D' }] },
    { title: '两组数据的变化', layout: 'chart', chart: { type: 'line', categories: ['第一周', '第二周', '第三周'], series: [{ name: '样例 A', values: [12, 25, 38] }, { name: '样例 B', values: [10, 17, 30] }] } },
    { title: '各项占比', layout: 'chart', chart: { type: 'pie', categories: ['研究', '开发', '验证'], series: [{ name: '样例投入', values: [2, 5, 3] }] } },
    { title: '按画框裁切图片', layout: 'image', image: { path: 'marker.png', fit: 'cover', caption: '上下蓝色边条应被居中裁掉；原图仍保留在 PPTX' } }
  ] }
  deck = await createPptx(input, new Map([['marker.png', readFileSync(join(workspace, 'marker.png'))]]))
  deckPath = join(workspace, 'design-review.pptx'); writeFileSync(deckPath, deck)
  hash = createHash('sha256').update(deck).digest('hex')
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
})

test.afterAll(async () => {
  try { await app?.close() } finally {
    bridge?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== tempRoot || !basename(target).startsWith('ppt-design-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('new content layouts render all actual PPTX pages through the connected Work client', async ({}, info) => {
  const zip = await JSZip.loadAsync(deck)
  expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(13)
  expect(Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(3)
  expect(Object.keys(zip.files).some(name => /^ppt\/media\//.test(name))).toBe(true)
  const xml = (await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => zip.file(name)!.async('string')))).join('\n')
  expect(xml).not.toContain('Aether ·'); expect(xml).not.toContain('3268AA'); expect(xml).toContain('<a:tbl>')
  const images = new Set<string>()
  const receipts: unknown[] = []
  for (let number = 1; number <= 13; number++) {
    const result = await bridge.execute('artifact.render', { path: deckPath, page: number, expectedHash: hash }, ctx)
    expect(result.success, result.output.slice(0, 1500)).toBe(true)
    const { dataUrl, ...receipt } = JSON.parse(result.output) as { dataUrl: string; page: number; pageCount: number; sha256: string; visualVerification: boolean; width: number; height: number }
    expect(receipt).toMatchObject({ page: number, pageCount: 13, sha256: hash, visualVerification: false, width: 960, height: 540 })
    const png = Buffer.from(dataUrl.split(',')[1], 'base64'); expect(png.length).toBeGreaterThan(5000)
    expect(png.readUInt32BE(16)).toBe(960); expect(png.readUInt32BE(20)).toBe(540)
    if (number === 5 || number === 13) {
      const bounds = await app!.evaluate(({ nativeImage }, dataUrl) => {
        const pixels = nativeImage.createFromDataURL(dataUrl).toBitmap(), counts = [0, 0, 0]
        let minX = 960, minY = 540, maxX = 0, maxY = 0
        for (let offset = 0; offset < pixels.length; offset += 4) {
          let matched = false
          if (pixels[offset] === 56 && pixels[offset + 1] === 80 && pixels[offset + 2] === 197) { counts[0]++; matched = true }
          if (pixels[offset] === 97 && pixels[offset + 1] === 110 && pixels[offset + 2] === 46) { counts[1]++; matched = true }
          if (pixels[offset] === 162 && pixels[offset + 1] === 86 && pixels[offset + 2] === 52) { counts[2]++; matched = true }
          if (matched) { const x = offset / 4 % 960, y = Math.floor(offset / 4 / 960); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
        }
        return { counts, ratio: (maxX - minX + 1) / (maxY - minY + 1) }
      }, dataUrl)
      expect(bounds.counts[0]).toBeGreaterThan(1000); expect(bounds.counts[1]).toBeGreaterThan(1000)
      if (number === 5) { expect(bounds.counts[2]).toBeGreaterThan(1000); expect(Math.abs(bounds.ratio - 320 / 180)).toBeLessThan(0.03) }
      else expect(bounds.counts[2]).toBe(0)
    }
    images.add(createHash('sha256').update(png).digest('hex')); receipts.push(receipt)
    const output = info.outputPath(`slide-${String(number).padStart(2, '0')}.png`)
    writeFileSync(output, png); await info.attach(`原文件第 ${number} 页`, { path: output, contentType: 'image/png' })
  }
  expect(images.size).toBe(13); expect(readPaths).toHaveLength(13)
  const report = info.outputPath('render-receipts.json'); writeFileSync(report, JSON.stringify(receipts, null, 2))
  const opened = await bridge.execute('artifact.open', { path: deckPath }, ctx)
  expect(opened.success, opened.output).toBe(true)
  const preview = page.locator('.document-preview[data-document-preview="pptx"]:visible')
  await expect(preview.locator('[data-document-pages="13"]')).toBeVisible()
  await expect(preview.locator('iframe').first()).toBeVisible()
  for (const number of [6, 11, 12]) {
    const container = preview.locator(`[data-document-page="${number}"]`)
    await container.scrollIntoViewIfNeeded()
    await expect(container.locator('iframe')).toBeVisible()
    const frame = container.locator('iframe').contentFrame()
    await expect(frame.locator('svg[data-pptx-chart]')).toHaveCount(1)
    if (number !== 12) {
      await expect(frame.locator('text[data-pptx-chart-label="data"]')).toHaveCount(0)
      const sizes = await frame.locator('text[data-pptx-chart-label="category"], text[data-pptx-chart-label="value"]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('font-size'))))
      expect(sizes.length).toBeGreaterThan(3); expect(sizes.every(size => size >= 16)).toBe(true)
    }
    if (number === 11) {
      await expect(frame.locator('text[data-pptx-chart-label="legend"]')).toHaveText(['样例 A', '样例 B'])
    }
    if (number === 12) {
      await expect(frame.locator('text[data-pptx-chart-label="data"]')).toHaveText(['研究 20%', '开发 50%', '验证 30%'])
      const overlaps = await frame.locator('svg[data-pptx-chart="pie"]').evaluate(element => {
        const shapes = [...element.querySelectorAll<SVGGeometryElement>('path,circle')]
        return [...element.querySelectorAll<SVGTextElement>('text[data-pptx-chart-label="data"]')].filter(label => {
          const box = label.getBBox()
          return [0, 0.5, 1].some(dx => [0, 0.5, 1].some(dy => shapes.some(shape => shape.isPointInFill(new DOMPoint(box.x + box.width * dx, box.y + box.height * dy)))))
        }).map(label => label.textContent)
      })
      expect(overlaps).toEqual([])
    }
  }
  await preview.locator('[data-document-page="1"]').scrollIntoViewIfNeeded()
  const screen = info.outputPath('work-ppt-preview.png'); await page.screenshot({ path: screen })
  await info.attach('Work 原文件预览', { path: screen, contentType: 'image/png' })
  expect(errors).toEqual([])
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().startsWith('data:')).length)).toBe(0)
})

test('stale versions, unavailable pages and out-of-workspace paths produce failures without images', async () => {
  for (const args of [
    { path: deckPath, page: 1, expectedHash: '0'.repeat(64) },
    { path: deckPath, page: 14, expectedHash: hash },
    { path: join(dirname(workspace), 'foreign.pptx'), page: 1, expectedHash: hash }
  ]) {
    const result = await bridge.execute('artifact.render', args, ctx)
    expect(result.success).toBe(false); expect(result.output).not.toContain('data:image')
    expect(result.output).toMatch(/版本已变化|页码超出范围|工作区/)
  }
  expect(createHash('sha256').update(readFileSync(deckPath)).digest('hex')).toBe(hash)
  expect(errors).toEqual([])
})
