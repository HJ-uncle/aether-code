/** Real Electron + isolated HTTP/SSE: inline tool images, localized browser names,
 * fresh Low preference, retained metadata, persisted multimodal replay and child
 * tool results. No renderer state or DOM is injected to manufacture the output. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const sessionId = 'tool-result-images-session', modelId = 'tool-result-images-model'
const token = 'tool-result-images-fixture-token'
// A complete PNG, so naturalWidth verifies Chromium actually decoded the bytes.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII='
const gif = 'R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs='
const dataUrl = 'data:image/png;base64,' + png
const screenshot = JSON.stringify({ tabId: 'fixture-tab', navigationId: 2, width: 1, height: 1, mimeType: 'image/png', name: '棋盘截图.png', dataUrl })
const malformedPayload = 'data:image/png;base64,' + '%invalid%'.repeat(3000)
let fixture = '', app: ElectronApplication | undefined, page: Page
let heldStream: ServerResponse | undefined, run: RootRun | undefined, sequence = 0, persisted = false
const rendererErrors: string[] = [], serverErrors: string[] = [], chatBodies: Record<string, unknown>[] = []
const projection: Record<string, unknown>[] = []
const history: EngineHistoryRow[] = [
  { id: 'seed-user', role: 'user', content: '图片工具回归会话', conversationId: 'seed-turn', createdAt: 1 },
  { id: 'seed-assistant', role: 'assistant', content: '准备检查图片输出。', conversationId: 'seed-turn', createdAt: 2 }
]
const child: SubagentRun = {
  schemaVersion: 1, runId: 'image-child-run', tenantId: 'default', rootSessionId: sessionId,
  parentSessionId: sessionId, parentConversationId: 'child-turn', parentMessageId: 'child-assistant',
  parentToolCallId: 'child-parent-tool', childSessionId: 'child-image-session', task: '检查子代理的截图展示',
  description: '图片子代理回归', modelId, status: 'succeeded', lastSeq: 2, createdAt: 100, updatedAt: 120,
  startedAt: 100, finishedAt: 120, durationMs: 20, usage: {}, resultSummary: '子代理截图检查完成。',
  toolCalls: [{ id: 'child-shot', name: 'browser_screenshot', args: { tabId: 'child-tab' }, status: 'succeeded',
    output: JSON.stringify({ name: '子代理截图.png', dataUrl, width: 1, height: 1 }) }]
}
let childVisible = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: Record<string, unknown>): void {
  if (!heldStream || heldStream.writableEnded) throw new Error('No open image fixture stream')
  projection.push(structuredClone(payload)); sequence++
  heldStream.write(`id: image-live-run:${sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function addTool(id: string, name: string, output: string, args: Record<string, unknown> = {}): void {
  frame({ toolStart: { id, name, args } })
  frame({ toolEnd: { id, name, output, success: true, durationMs: 138 } })
  history.push(
    { id: `assistant-${id}`, role: 'assistant', conversationId: run!.turnId, metadata: { runId: run!.runId }, toolCall: { id, name, args } },
    { role: 'tool', toolCallId: id, content: output, metadata: { success: true, durationMs: 138 } }
  )
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null)); return
    }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>
      if (body.sessionId !== sessionId) throw new Error('Wrong image fixture session')
      chatBodies.push(body)
      run = { schemaVersion: 1, runId: 'image-live-run', sessionId, turnId: 'image-live-turn', userMessageId: 'image-live-user',
        assistantMessageId: 'image-live-assistant', seq: 1, version: 1, status: 'running', modelId, pending: [], createdAt: Date.now(), updatedAt: Date.now() }
      heldStream = response; response.writeHead(200, { 'content-type': 'text/event-stream' })
      const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: String(body.message), conversationId: run.turnId, createdAt: run.createdAt }
      history.push(user); frame({ run }); frame({ userMessage: user }); return
    }
    if (path === '/api/v1/chat/stream') {
      heldStream = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return
    }
    response.setHeader('content-type', 'application/json')
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'tool-result-images-fixture' }
      : path === '/auth/account/providers' ? { providers: [], registrationEnabled: true }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', isEnabled: true, capabilities: { toolCalling: true, thinking: true, contextWindow: 128000 } }]
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: '图片工具回归会话', lastAt: 2, messageCount: history.length }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: run && !persisted ? 'live' : 'persisted', sessionId,
        eventId: run && !persisted ? 'image-live-run:' + sequence : null, finished: !run || run.status !== 'running',
        run, runs: run ? [run] : [], history, projection: persisted ? [] : projection, todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
      : path === '/api/v1/subagent/runs' ? childVisible ? [child] : []
      : path === '/api/v1/subagent/runs/' + child.runId ? child
      : path === '/api/v1/memory/settings' ? { sessionId: url.searchParams.get('sessionId'), memoryScope: 'session', effectiveScope: 'session', enabled: true }
      : path === '/api/v1/security/mode' ? { sessionId: url.searchParams.get('sessionId'), mode: 'standard' }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/tool-images', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { serverErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

function toolRow(label: string): Locator {
  return page.locator('.logline-wrap').filter({ has: page.locator('.logline__name', { hasText: new RegExp('^' + label + '$') }) })
}
async function expandProcesses(): Promise<void> {
  for (const button of await page.locator('.process__summary[aria-expanded="false"]').all()) await button.click()
}
async function expectDecoded(target: Locator): Promise<void> {
  await expect(target).toBeVisible()
  await expect.poll(() => target.evaluate(image => ({ complete: (image as HTMLImageElement).complete, width: (image as HTMLImageElement).naturalWidth }))).toEqual({ complete: true, width: 1 })
}

test.describe.serial('工具图片输出与中文名称真机回归', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'tool-result-images-ui-'))
    // Omit thinkingMode: using an explicit low value would mask a broken default.
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:' + address.port, autoStartEngine: true, lastSessionId: '', lastModelId: modelId, appearance: 'dark' }))
    const env: NodeJS.ProcessEnv = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => rendererErrors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.getByRole('button', { name: '会话历史', exact: true }).click()
    await page.locator(`.history-view__item[data-session-id="${sessionId}"]`).click()
    await expect(page.locator('.message--user').first()).toContainText('图片工具回归会话')
    await expect(page.locator('.model-picker__trigger')).toBeEnabled()
  })
  test.afterEach(() => { expect(rendererErrors).toEqual([]); expect(serverErrors).toEqual([]) })
  test.afterAll(async () => {
    heldStream?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('tool-result-images-ui-')) throw new Error('Unsafe image fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('新配置默认 Low 且首次真实发送携带 low', async () => {
    expect((await page.evaluate(() => window.aether.settings.get())).thinkingMode).toBe('low')
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(page.getByTitle('选择思考档位', { exact: true })).toContainText('Low')
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await page.locator('.chat__input').fill('检查截图和普通工具输出')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chatBodies.length).toBe(1)
    expect(chatBodies[0]).toMatchObject({ sessionId, thinkingMode: 'low' })
  })

  test('SSE 截图直接显示、中文名称、可放大关闭且详情无 base64', async ({}, testInfo) => {
    addTool('live-screenshot', 'browser_screenshot', screenshot, { tabId: 'fixture-tab', navigationId: 2 })
    const row = toolRow('浏览器截图')
    await expect(row.locator('.logline__name')).toHaveText('浏览器截图')
    await expectDecoded(row.locator('.tool-result__preview img'))
    await row.locator('.tool-result__preview').click()
    const dialog = page.getByRole('dialog', { name: '棋盘截图.png', exact: true })
    await expectDecoded(dialog.locator('img'))
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(row.locator('.tool-result__preview')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(row.locator('.tool-result__preview')).toBeFocused()
    await row.locator('.tool-result__metadata summary').click()
    await expect(row.locator('.tool-result__metadata')).toContainText('fixture-tab')
    expect(await row.innerText()).not.toContain(png)
    expect(await row.innerText()).not.toContain('data:image/png;base64')
    await page.screenshot({ path: testInfo.outputPath('inline-tool-image.png') })
  })

  test('点击示意图限制超长标签，旧记录明确显示未保存位置', async () => {
    const snapshot = { tab: { title: '点击边界测试', url: 'https://fixture.test/before', loading: false },
      text: '页面正文', elements: [], viewport: { width: 1280, height: 720 }, truncated: false }
    const longName = '目标'.repeat(5000), longSelector = '#' + 'selector'.repeat(1000)
    addTool('long-click', 'browser_click', JSON.stringify({ ...snapshot, interaction: {
      type: 'click', x: 320, y: 180, navigationId: 1, pageUrl: snapshot.tab.url,
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      target: { name: longName, selector: longSelector, bounds: { x: 300, y: 160, width: 80, height: 40 } }
    } }))
    const current = toolRow('点击浏览器元素').first()
    await current.locator('button.logline[aria-expanded="false"]').click()
    const target = current.locator('.tool-browser-click__target')
    await expect(target).toBeVisible()
    expect((await target.innerText()).length).toBeLessThan(500)
    expect(await target.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(100)
    await expect(current.locator('.tool-browser-click__point')).toHaveAttribute('cx', '320')
    await current.locator('.tool-result__metadata summary').click()
    await expect(current.locator('.tool-result__metadata')).toContainText(longName)
    await current.locator('.tool-result__metadata summary').click()
    addTool('legacy-click', 'browser_click', JSON.stringify(snapshot))
    const legacy = toolRow('点击浏览器元素').last()
    await expect(toolRow('点击浏览器元素')).toHaveCount(2)
    await legacy.locator('button.logline[aria-expanded="false"]').click()
    await expect(legacy.locator('.tool-browser-click__missing')).toHaveText('这条记录未保存点击位置')
    await expect(legacy.locator('.tool-browser-click__map')).toHaveCount(0)
  })

  test('位置截图无法解码时保留坐标且回退到示意图', async () => {
    // A valid PNG signature/IHDR with no pixel chunks passes transport checks but must fail decoding.
    const damaged = 'data:image/png;base64,' + Buffer.from(png, 'base64').subarray(0, 24).toString('base64')
    addTool('damaged-click-image', 'browser_click', JSON.stringify({
      tab: { title: '图片解码失败回归', url: 'https://fixture.test/damaged', loading: false },
      text: '', elements: [], truncated: false,
      snapshotUnavailable: '页面仍在导航，请读取新快照，不要重复已完成的操作。',
      interaction: { type: 'click', x: 0, y: 0, navigationId: 1, pageUrl: 'https://fixture.test/damaged',
        viewport: { width: 1, height: 1, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
        screenshot: { dataUrl: damaged, width: 1, height: 1 } }
    }))
    const row = toolRow('点击浏览器元素').last()
    await expect(row).toContainText('点击浏览器元素')
    await row.locator('button.logline[aria-expanded="false"]').click()
    await expect(row).toContainText('截图无法显示，已显示位置示意图')
    await expect(row.getByRole('status')).toContainText('操作已执行，页面快照暂不可用')
    await expect(row.getByRole('status')).toContainText('不要重复已完成的操作')
    await expect(row.locator('.tool-browser-click__point')).toHaveAttribute('cx', '0')
    await expect(row.locator('.tool-browser-click__point')).toHaveAttribute('cy', '0')
    await expect(row.locator('.tool-browser-position__image')).toHaveCount(0)
    await expect(row.locator('.tool-result__preview')).toHaveCount(0)
    await expect(row.getByRole('button', { name: '放大查看 点击前页面截图' })).toHaveCount(0)
  })

  test('普通输出保留，错误图片数据不产生大段编码，结束后截图仍可见', async () => {
    addTool('plain-result', 'browser_snapshot', JSON.stringify({ title: '普通快照结果', elements: ['测试按钮'] }))
    addTool('invalid-image', 'browser_console', JSON.stringify({ diagnostic: 'INVALID_IMAGE_METADATA', dataUrl: malformedPayload }))
    frame({ content: '截图输出检查完成。' })
    history.push({ id: 'image-live-final', role: 'assistant', content: '截图输出检查完成。', conversationId: run!.turnId, metadata: { runId: run!.runId } })
    run = { ...run!, status: 'succeeded', version: 2, seq: 2, updatedAt: Date.now(), finishedAt: Date.now() }
    frame({ run }); heldStream!.end('data: [DONE]\n\n')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await expectDecoded(toolRow('浏览器截图').locator('.tool-result__preview img'))
    await expandProcesses()
    const plain = toolRow('读取浏览器页面')
    await plain.locator('button.logline').click()
    await expect(plain.locator('.logline__detail')).toContainText('普通快照结果')
    await expect(plain.locator('.logline__detail')).toContainText('测试按钮')
    const invalid = toolRow('读取浏览器控制台')
    await invalid.locator('button.logline').click()
    await expect(invalid).toContainText('图片数据无效或格式不支持')
    expect(await invalid.innerText()).not.toContain('%invalid%')
    expect((await invalid.innerText()).length).toBeLessThan(2000)
    await expect(invalid.locator('.tool-result__preview')).toHaveCount(0)
  })

  test('持久化历史重放浏览器和多模态图片，不重新执行工具', async () => {
    const multimodal = JSON.stringify({ content: [
      { type: 'text', text: '两种图片协议的附带说明' },
      { type: 'image', mimeType: 'image/png', data: png, name: 'MCP图片.png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif }, name: '多模态图片.gif' }
    ] })
    history.push(
      { id: 'multimodal-user', role: 'user', content: '重放多模态图片', conversationId: 'multimodal-turn' },
      { id: 'multimodal-assistant', role: 'assistant', conversationId: 'multimodal-turn', toolCall: { id: 'multimodal-tool', name: 'browser_screenshot', args: {} } },
      { role: 'tool', toolCallId: 'multimodal-tool', content: multimodal, metadata: { success: true } }
    )
    persisted = true
    await page.reload()
    await expect(page.locator('.message--user').first()).toContainText('图片工具回归会话')
    await expect(page.locator('.tool-result__preview img')).toHaveCount(3)
    for (const img of await page.locator('.tool-result__preview img').all()) await expectDecoded(img)
    const multi = toolRow('浏览器截图').last()
    await multi.locator('.tool-result__metadata summary').click()
    await expect(multi).toContainText('两种图片协议的附带说明')
    expect(await multi.innerText()).not.toContain(png)
    expect(chatBodies).toHaveLength(1)
  })

  test('子代理内部截图也显示图片及中文名称', async () => {
    childVisible = true
    history.push(
      { id: 'child-user', role: 'user', content: '检查子代理图片', conversationId: child.parentConversationId },
      { id: child.parentMessageId, role: 'assistant', conversationId: child.parentConversationId, toolCall: { id: child.parentToolCallId, name: 'subagent', args: { task: child.task } } },
      { role: 'tool', toolCallId: child.parentToolCallId, content: child.resultSummary, metadata: { success: true, subagent: child } }
    )
    await page.reload()
    await expect(page.locator('.message--user').last()).toContainText('检查子代理图片')
    for (const button of await page.locator('.subagent-group__head[aria-expanded="false"]').all()) await button.click()
    const card = page.locator(`.subagent-card[data-run-id="${child.runId}"]`)
    await expect(card).toBeVisible()
    if (await card.getAttribute('open') === null) await card.locator('summary').click()
    if (!await card.locator('.subagent-card__tools-list').isVisible()) await card.locator('.subagent-card__tools-header').click()
    await expect(card.locator('.subagent-card__call-name')).toHaveText('浏览器截图')
    await expectDecoded(card.locator('.tool-result__preview img'))
    await card.locator('.tool-result__preview').click()
    await expect(page.getByRole('dialog', { name: '子代理截图.png', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '子代理截图.png', exact: true })).toBeHidden()
    expect(await card.innerText()).not.toContain(png)
    expect(chatBodies).toHaveLength(1)
  })
})
