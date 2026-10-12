/** Real Electron/HTTP/SSE coverage: ordered Work messages, activity deep links,
 * independently scrolling narrow panes, and child continuation preserving drafts. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

let health: ElectronHealthMonitor | undefined

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-timeline-fixture-token', modelId = 'work-timeline-model'
const requests: Record<string, unknown>[] = [], errors: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', responseStream: ServerResponse | undefined
let run: RootRun | undefined, child: SubagentRun | undefined, sequence = 0
let childLookupDelay: Promise<void> | null = null, childLookupCount = 0
const history: Array<{ id: string; role: string; content: string; createdAt: number; sessionId: string }> = []
const projection: ChatSsePayload[] = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: ChatSsePayload): void {
  if (!run || !responseStream || responseStream.writableEnded) throw new Error('No live fixture stream')
  projection.push(payload)
  responseStream.write(`id: ${run.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function finish(): void {
  if (!run) throw new Error('No fixture run')
  run = { ...run, status: 'succeeded', updatedAt: Date.now(), finishedAt: Date.now(), version: run.version + 1 }
  frame({ run })
  responseStream!.end('data: [DONE]\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401).end(envelope(null)); return
    }
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (path === '/api/v1/chat' && request.method === 'POST') {
      requests.push(body)
      const id = String(body.sessionId)
      sequence = 0; projection.length = 0; responseStream = response
      run = {
        schemaVersion: 1, runId: `timeline-run-${requests.length}`, sessionId: id,
        turnId: `timeline-turn-${requests.length}`, userMessageId: `timeline-user-${requests.length}`,
        assistantMessageId: `timeline-assistant-${requests.length}`, seq: 1, version: 1, status: 'running',
        modelId, pending: [], workspacePaths: [], createdAt: Date.now(), updatedAt: Date.now()
      }
      const user = { id: run.userMessageId, role: 'user', content: String(body.message), createdAt: Date.now() }
      history.push({ ...user, sessionId: id })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ run }); frame({ userMessage: user }); return
    }
    if (path === '/api/v1/subagent/runs/child-first-run' && childLookupDelay) {
      childLookupCount += 1
      await childLookupDelay
    }
    const id = url.searchParams.get('sessionId') ?? ''
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'work-timeline-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Timeline fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: run?.status === 'running' ? 'live' : 'persisted', eventId: run ? `${run.runId}:${sequence}` : null, finished: run?.status !== 'running', projection: id === run?.sessionId ? projection : [], history: id === run?.sessionId ? history.filter(row => row.sessionId === id) : [], run: id === run?.sessionId ? run : undefined, runs: id === run?.sessionId ? [run] : [], todos: [], changes: [], commandJobs: [] }
            : path === '/api/v1/chat/runs' ? { runs: id === run?.sessionId ? [run] : [] }
              : path === '/api/v1/subagent/runs' ? child && url.searchParams.get('parentSessionId') === child.parentSessionId ? [child] : []
                : path === '/api/v1/subagent/runs/child-first-run' ? child
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                      : path === '/api/v1/agents' ? [{ id: 'timeline-agent', name: '界面验收 Agent', description: '检查响应式布局' }]
                        : path === '/api/v1/skills' ? { list: [{ id: 'review-ui', name: '界面审查', description: '检查交互与布局', enabled: true }, ...Array.from({ length: 28 }, (_, index) => ({ id: `review-${index}`, name: `验收技能 ${index + 1}`, description: '长列表键盘与滚动检查', enabled: true }))] }
                          : path === '/api/v1/mcp/servers' ? [{ id: 'browser-tools', name: '浏览器工具', description: '验证页面', enabled: true }]
                            : path === '/api/v1/knowledge/bases' ? [{ id: 'design-docs', name: '设计资料', description: '验收资料', documentCount: 2, createdAt: Date.now() }]
                              : path === '/api/v1/workspace/directory' ? { root: '/remote/work-timeline', entries: [] }
                        : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/work-timeline' } : []
    response.setHeader('content-type', 'application/json')
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const work = () => page.locator('.work-view')
async function expectPointerTarget(option: Locator): Promise<void> {
  await expect(option).toBeVisible()
  await expect.poll(() => option.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit !== null && element.contains(hit)
  })).toBe(true)
}

async function expectPopoverInViewport(palette: Locator, input: Locator): Promise<void> {
  await expect(palette).toBeVisible()
  const metrics = await palette.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, chromeBottom: document.querySelector('.menu-bar')?.getBoundingClientRect().bottom ?? 0 }
  })
  expect(metrics.left).toBeGreaterThanOrEqual(8)
  expect(metrics.right).toBeLessThanOrEqual(metrics.width - 8)
  expect(metrics.top).toBeGreaterThanOrEqual(metrics.chromeBottom)
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.height - 8)
  const inputBounds = await input.boundingBox()
  expect(inputBounds).not.toBeNull()
  expect(metrics.bottom <= inputBounds!.y || metrics.top >= inputBounds!.y + inputBounds!.height).toBe(true)
  await expectPointerTarget(palette.locator('.work-agent-picker__title, .resource-picker__title'))
}

test.describe.serial('Work 时间线与协作详情', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-timeline-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, remoteWorkspaceRoot: '/remote/code-project', lastSessionId: '', lastModelId: modelId, appearance: 'dark', lastFolder: '' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-timeline', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, testInfo) => {
    responseStream?.destroy()
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-timeline-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('首页与小窗口的 @ Agent 和 / 资源候选可点击，选择结果保留在输入区', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 760))
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    await input.fill('@')
    const agentPalette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    const agentOption = agentPalette.getByRole('option', { name: /界面验收 Agent/ })
    await expectPopoverInViewport(agentPalette, input)
    await expectPointerTarget(agentOption)
    await page.screenshot({ path: testInfo.outputPath('work-home-agent-940.png'), animations: 'disabled' })
    await agentOption.click()
    await expect(input.locator('.mention-chip--agent')).toHaveText('界面验收 Agent')
    await expect(page.locator('.work-agent-picker')).toHaveCount(0)
    await input.fill('/')
    const resourcePalette = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    const resourceOption = resourcePalette.getByRole('option', { name: /界面审查/ })
    await expectPopoverInViewport(resourcePalette, input)
    await expectPointerTarget(resourceOption)
    await page.screenshot({ path: testInfo.outputPath('work-home-resources-940.png'), animations: 'disabled' })
    await resourceOption.click()
    await expect(work().locator('.work-resource-chip')).toHaveText('技能 · review-ui ×')
    await expect(page.locator('.resource-picker')).toHaveCount(0)
    await work().locator('.work-resource-chip').click()
    await expect(work().locator('.work-resource-chip')).toHaveCount(0)
    await input.fill('')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('候选键盘选择和空结果回车不会发送任务，内部滚动可抵达末项', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 640))
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    await input.fill('@')
    const agentPalette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    await expect(agentPalette.getByRole('option', { name: /界面验收 Agent/ })).toBeVisible()
    await expectPopoverInViewport(agentPalette, input)
    await input.press('Enter')
    await expect(input.locator('.mention-chip--agent')).toHaveText('界面验收 Agent')
    expect(requests).toHaveLength(0)
    await input.fill('@missing-agent')
    await expect(agentPalette).toContainText('没有可用的自定义 Agent')
    await input.press('Enter')
    await expect(agentPalette).toBeVisible()
    expect(requests).toHaveLength(0)
    await input.press('Escape')
    await expect(page.locator('.work-completion-popover')).toHaveCount(0)
    await input.fill('/')
    const resourcePalette = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    await expect(resourcePalette.getByRole('option')).toHaveCount(31)
    await expectPopoverInViewport(resourcePalette, input)
    await input.press('ArrowUp')
    await expectPointerTarget(resourcePalette.getByRole('option', { name: /设计资料/ }))
    await input.press('Enter')
    await expect(work().locator('.work-resource-chip')).toHaveText('知识库 · design-docs ×')
    await expect(resourcePalette).toHaveCount(0)
    expect(requests).toHaveLength(0)
    await work().locator('.work-resource-chip').click()
    await input.fill('/')
    await expect(resourcePalette.getByRole('option')).toHaveCount(31)
    await resourcePalette.hover()
    await page.mouse.wheel(0, 2200)
    await expect.poll(() => resourcePalette.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(resourcePalette).toBeVisible()
    const lastResource = resourcePalette.getByRole('option', { name: /设计资料/ })
    await lastResource.scrollIntoViewIfNeeded()
    await expectPointerTarget(lastResource)
    await page.screenshot({ path: testInfo.outputPath('work-resources-scrolled-940.png'), animations: 'disabled' })
    await lastResource.click()
    await expect(work().locator('.work-resource-chip')).toHaveText('知识库 · design-docs ×')
    await work().locator('.work-resource-chip').click()
    await input.fill('/missing-resource')
    await expect(resourcePalette).toContainText('没有匹配资源')
    await input.press('Enter')
    await expect(resourcePalette).toBeVisible()
    expect(requests).toHaveLength(0)
    await input.press('Escape')
    await expect(page.locator('.work-completion-popover')).toHaveCount(0)
    await input.fill('')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('正文与操作按实际发生顺序显示，工具状态行直接打开对应活动', async ({}, testInfo) => {
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('按顺序调研、编辑和验证，不要混淆过程与正文')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    // Both command palettes remain usable while a task is running. This is a
    // real contenteditable interaction, not a static screenshot assertion.
    const composerInput = work().getByRole('textbox', { name: '继续对话', exact: true })
    await composerInput.fill('@')
    const agentPalette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    await expect(agentPalette).toContainText('界面验收 Agent')
    await expectPointerTarget(agentPalette.getByRole('option', { name: /界面验收 Agent/ }))
    await expectPopoverInViewport(agentPalette, composerInput)
    await composerInput.press('Escape')
    await expect(page.locator('.work-completion-popover')).toHaveCount(0)
    await composerInput.fill('/')
    const resourcePalette = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    await expect(resourcePalette).toContainText('界面审查')
    const taskResource = resourcePalette.getByRole('option', { name: /界面审查/ })
    await expectPointerTarget(taskResource)
    await expectPopoverInViewport(resourcePalette, composerInput)
    await taskResource.click()
    await expect(work().locator('.work-resource-chip')).toHaveText('技能 · review-ui ×')
    await expect(page.locator('.resource-picker')).toHaveCount(0)
    await work().locator('.work-resource-chip').click()
    frame({ content: '先读取需求，确认验收范围。' })
    frame({ toolStart: { id: 'read-plan', name: 'read_file', args: { path: 'requirements.md' } } })
    frame({ toolEnd: { id: 'read-plan', name: 'read_file', output: 'READ_REQUIREMENTS_RESULT', success: true } })
    frame({ content: '需求已确认，现在实现页面。' })
    frame({ toolStart: { id: 'write-page', name: 'write_file', args: { path: 'index.html' } } })
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const message = conversation.locator('.work-message--assistant').last()
    await expect(message.locator('.work-process').last()).toContainText('进行中 · 写入文件')
    expect(await message.locator(':scope > .md, :scope > .work-process').allTextContents()).toEqual([
      '先读取需求，确认验收范围。', '已完成 · 读取文件requirements.md', '需求已确认，现在实现页面。', '进行中 · 写入文件index.html'
    ])
    await expect(message.locator('.work-process__items')).toHaveCount(0)
    await message.locator('.work-process').first().click()
    await expect(work().getByRole('tab', { name: '活动', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(work().getByRole('option', { selected: true })).toContainText('读取文件')
    await expect(work().getByRole('article', { name: '活动详情' })).toContainText('READ_REQUIREMENTS_RESULT')
    await work().getByRole('group', { name: '活动筛选' }).getByRole('button', { name: '已完成', exact: true }).click()
    await message.locator('.work-process').last().click()
    await expect(work().getByRole('option', { selected: true })).toContainText('写入文件')
    await expect(work().getByRole('article', { name: '活动详情' })).toContainText('index.html')
    await expect(work().getByRole('group', { name: '活动筛选' }).getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true')
    frame({ todo: { todos: [{ id: 'plan', title: '核对需求范围', status: 'done', priority: 'medium' }, { id: 'verify', title: '运行页面验收', status: 'in_progress', priority: 'medium' }] } })
    await expect(conversation.locator('.work-steps')).toHaveCount(0)
    await expect(work().locator('.work-activities .work-steps')).toBeVisible()
    await expect(work().locator('.work-steps ol')).toBeHidden()
    await work().locator('.work-steps summary').click()
    await expect(work().locator('.work-steps ol')).toContainText('运行页面验收')
    frame({ toolEnd: { id: 'write-page', name: 'write_file', output: 'WRITE_PAGE_RESULT\n'.repeat(150), success: true } })
    frame({ content: '页面已实现，等待最终验收。' })
    finish()
    await expect(message.locator('.work-process').last()).toContainText('已完成 · 写入文件')
    await expect(message.locator('.md').last()).toContainText('页面已实现')
    await page.screenshot({ path: testInfo.outputPath('work-timeline-1440.png'), animations: 'disabled' })
  })

  test('窄窗口活动列表与详情独立滚动，没有横向溢出', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 780))
    await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ }).click()
    const list = work().getByRole('listbox', { name: '工具活动列表' }), detail = work().getByRole('article', { name: '活动详情' })
    await expect(list).toBeVisible(); await expect(detail).toBeVisible()
    await expect.poll(() => work().locator('.work-activities').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2)
    const listRect = await list.boundingBox(), detailRect = await detail.boundingBox()
    expect(listRect).not.toBeNull(); expect(detailRect).not.toBeNull()
    // Responsive workspace may keep a side-by-side inspector when Electron
    // enforces its minimum window width, or stack it in a genuinely narrow
    // pane. Both layouts keep each region bounded and independently scrollable.
    const separated = detailRect!.y >= listRect!.y + listRect!.height - 2 || detailRect!.x >= listRect!.x + listRect!.width - 2
    expect(separated).toBe(true)
    expect(detailRect!.height).toBeGreaterThan(120)
    await detail.locator('pre').last().evaluate(node => { node.scrollTop = 500 })
    await expect.poll(() => detail.locator('pre').last().evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    expect(await list.evaluate(node => node.scrollTop)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('work-activity-680.png'), animations: 'disabled' })
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('子代理详情可查看并继续同一代理，父对话的输入草稿保留', async () => {
    if (!run) throw new Error('Missing parent run')
    child = {
      schemaVersion: 1, runId: 'child-first-run', tenantId: 'fixture', rootSessionId: run.sessionId, parentSessionId: run.sessionId,
      parentConversationId: run.turnId, parentMessageId: run.assistantMessageId, parentToolCallId: 'child-tool', childSessionId: 'child-session',
      task: '实现页面并验证可访问性', description: '页面开发代理', modelId, status: 'succeeded', lastSeq: 3,
      createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), continuation: { role: 'implementer', readOnly: false },
      resultSummary: 'CHILD_RESULT：页面已完成，键盘导航通过。', usage: { totalTokens: 42 }, toolCalls: []
    }
    await work().getByRole('tab', { name: '子代理', exact: true }).click()
    const panel = work().getByRole('region', { name: '协作代理', exact: true })
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel).toContainText('页面开发代理')
    await expect(panel).toContainText('开发实现')
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('DRAFT_MUST_SURVIVE_CHILD_CONTINUATION')
    await panel.getByRole('button', { name: '继续此代理', exact: true }).click()
    const continuation = panel.getByRole('textbox', { name: '给这个代理的新任务', exact: true })
    await continuation.fill('继续检查小屏布局，修复后给出验证结果')
    let releaseLookup: () => void = () => undefined
    childLookupDelay = new Promise<void>(resolve => { releaseLookup = resolve })
    try {
      await panel.getByRole('button', { name: '继续执行', exact: true }).click()
      await expect.poll(() => childLookupCount).toBe(1)
      await expect(continuation).toBeDisabled()
      await expect(continuation).toHaveValue('继续检查小屏布局，修复后给出验证结果')
      await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      await expect(panel.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled()
      expect(requests).toHaveLength(1)
    } finally { childLookupDelay = null; releaseLookup() }
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1].sessionId).toBe(requests[0].sessionId)
    expect(String(requests[1].message)).toContain('"resumeRunId": "child-first-run"')
    expect(String(requests[1].message)).toContain('继续检查小屏布局')
    expect(String(requests[1].message)).not.toContain('DRAFT_MUST_SURVIVE')
    await expect(input).toHaveText('DRAFT_MUST_SURVIVE_CHILD_CONTINUATION')
    frame({ content: '子代理已继续同一上下文。' }); finish()
    await expect(input).toHaveText('DRAFT_MUST_SURVIVE_CHILD_CONTINUATION')
    expect(errors).toEqual([])
  })

  test('首页滚动移走输入区后关闭候选并释放键盘，临近顶部时菜单不遮挡标题栏', async ({}, testInfo) => {
    // Build a genuinely scrollable recent-task list using normal task creation.
    for (let index = 0; index < 10; index++) {
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(`滚动定位验收 ${index + 1}`)
      const count = requests.length
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => requests.length).toBe(count + 1)
      frame({ content: `滚动验收 ${index + 1} 已完成。` }); finish()
      await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(`滚动验收 ${index + 1} 已完成。`)
    }
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 640))
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    const home = work().locator('.work-home')
    await input.fill('@')
    const palette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    await expectPointerTarget(palette.getByRole('option', { name: /界面验收 Agent/ }))
    const bounds = await home.boundingBox()
    if (!bounds) throw new Error('Missing scrollable Work homepage')
    await page.mouse.move(bounds.x + bounds.width - 24, bounds.y + bounds.height - 30)
    await page.mouse.wheel(0, 145)
    await expect.poll(() => home.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await expectPopoverInViewport(palette, input)
    await page.screenshot({ path: testInfo.outputPath('work-agent-near-chrome.png'), animations: 'disabled' })
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => input.evaluate(element => element.closest('.work-composer')!.getBoundingClientRect().bottom)).toBeLessThan(0)
    await expect(palette).toHaveCount(0)
    await expect(input).toBeFocused()
    const count = requests.length
    await page.keyboard.press('Tab')
    await expect(input).not.toBeFocused()
    expect(requests).toHaveLength(count)
    expect(errors).toEqual([])
  })

  test('大量活动分页保留跨页键盘与详情，拖动分栏只在释放时保存布局', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_ACTIVITY_PERFORMANCE')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    for (let index = 0; index < 90; index++) {
      frame({ toolStart: { id: `performance-tool-${index}`, name: 'read_file', args: { path: `performance-${index}.txt` } } })
      frame({ toolEnd: { id: `performance-tool-${index}`, name: 'read_file', output: `PERFORMANCE_TOOL_RESULT_${index}`, success: true } })
    }
    frame({ content: '活动压力任务已完成。' }); finish()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    await expect(conversation).toContainText('活动压力任务已完成。')
    await conversation.getByRole('button', { name: '活动', exact: true }).click()
    const list = work().getByRole('listbox', { name: '工具活动列表' })
    await expect(list.getByRole('option')).toHaveCount(80)
    await expect(work().locator('.work-workspace__body--git .work-git-panel')).toHaveCount(0)
    await list.getByRole('option').first().press('End')
    await expect(list.getByRole('option')).toHaveCount(10)
    await expect(list.getByRole('option', { selected: true })).toHaveAttribute('aria-posinset', '90')
    await expect(list.getByRole('option', { selected: true })).toBeFocused()
    await expect(work().getByRole('article', { name: '活动详情' })).toContainText('PERFORMANCE_TOOL_RESULT_89')
    await list.getByRole('option', { selected: true }).press('Home')
    await expect(list.getByRole('option')).toHaveCount(80)
    await expect(list.getByRole('option', { selected: true })).toHaveAttribute('aria-posinset', '1')
    await expect(list.getByRole('option', { selected: true })).toBeFocused()
    const divider = work().getByRole('separator', { name: '调整对话与工作区宽度' })
    const storedRatio = () => page.evaluate(() => Number(JSON.parse(localStorage.getItem('aether.work.view.v1') || '{}').ratio))
    const ratio = Number(await divider.getAttribute('aria-valuenow'))
    await expect.poll(storedRatio).toBe(ratio)
    const rect = await divider.boundingBox()
    if (!rect) throw new Error('Missing Work divider')
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width / 2 + (ratio > 55 ? -80 : 80), rect.y + rect.height / 2, { steps: 12 })
    await expect.poll(() => divider.getAttribute('aria-valuenow')).not.toBe(String(ratio))
    expect(await storedRatio()).toBe(ratio)
    await page.mouse.up()
    const painted = await work().locator('.work-task-body').evaluate(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--work-conversation-ratio')))
    await expect.poll(storedRatio).toBeCloseTo(painted, 4)
    expect(errors).toEqual([])
  })

  test('长对话限制初始DOM，上滚继续接收回复及展开历史保持阅读锚点', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    for (let index = 0; index < 32; index++) {
      const input = work().getByRole('textbox', { name: index === 0 ? '任务目标' : '继续对话', exact: true })
      await input.fill(`PERFORMANCE_HISTORY_INPUT_${index}`)
      const send = work().getByRole('button', { name: index === 0 ? '开始任务' : '发送', exact: true })
      await expect(send).toBeEnabled()
      const before = requests.length
      await send.click()
      await expect.poll(() => requests.length).toBe(before + 1)
      frame({ content: `# 轮次 ${index + 1}\n\nPERFORMANCE_HISTORY_REPLY_${index}\n\n本轮已完成，可继续查看历史内容。` }); finish()
      await expect(conversation.locator('.work-message--assistant').last()).toContainText(`PERFORMANCE_HISTORY_REPLY_${index}`)
    }
    await expect(conversation.locator('.work-message')).toHaveCount(60)
    const scroll = conversation.locator('.work-conversation__scroll')
    await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
    await expect(conversation.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    const anchor = await conversation.locator('.work-message').first().getAttribute('data-message-id')
    await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('PERFORMANCE_HISTORY_WHILE_READING')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => requests.at(-1)?.message).toBe('PERFORMANCE_HISTORY_WHILE_READING')
    frame({ content: 'READING_ANCHOR_MUST_SURVIVE' }); finish()
    await expect(conversation.locator('.work-message--assistant').last()).toContainText('READING_ANCHOR_MUST_SURVIVE')
    await expect(conversation.locator('.work-message').first()).toHaveAttribute('data-message-id', anchor!)
    expect(await scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
    const anchored = conversation.locator(`.work-message[data-message-id="${anchor}"]`)
    const beforeTop = await anchored.evaluate(element => element.getBoundingClientRect().top)
    await conversation.getByRole('button', { name: /^查看更早消息/ }).click()
    await expect(conversation.locator('.work-message')).toHaveCount(66)
    await expect(conversation.locator('.work-message').first()).toContainText('PERFORMANCE_HISTORY_INPUT_0')
    expect(Math.abs(await anchored.evaluate(element => element.getBoundingClientRect().top) - beforeTop)).toBeLessThanOrEqual(2)
    await conversation.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(conversation.locator('.work-message')).toHaveCount(60)
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
  })
})
