/** Isolated Electron + authenticated engine fixture: four long Chinese agent
 * rows retain readable statuses, complete hover details and native navigation.
 * Covers split/single/narrow panes in both themes and real scroll/focus restore.
 * Build first, then use playwright.work-subagent-list.config.ts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { BuiltinAgentRole, SubagentRunView } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'subagent-list-fixture', sessionId = 'work-subagent-list-parent', modelId = 'subagent-list-model'
const title = '协作代理列表阅读核对', now = Date.now() - 10_000
const errors: string[] = [], mutations: string[] = [], detailReads: string[] = [], archiveReads: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const parent: RootRun = { schemaVersion: 1, runId: 'list-parent-run', sessionId, turnId: 'list-turn', userMessageId: 'list-user',
  assistantMessageId: 'list-answer', seq: 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: [],
  createdAt: now, updatedAt: now + 10, finishedAt: now + 10 }
const names = [
  '负责桌面工作区与多种办公附件预览一致性的组件实现代理',
  '负责历史会话与增量事件协议兼容性证据收集的接口调研代理',
  '负责跨平台构建诊断与运行环境差异核对的集成检查代理',
  '负责长篇需求核对与最终交付材料整理的综合协作代理'
]
const roles: BuiltinAgentRole[] = ['executor', 'research', 'executor', 'general']
const roleLabels = ['执行', '调研', '执行', '通用']
const tasks = [
  '完成图片、表格、演示文稿与文档在任务工作区中的统一预览，核对所有入口的键盘导航、错误提示、路径截断和浅色深色主题，保留已有下载能力。',
  '只读核对独立子代理的历史会话、状态事件与工具分页协议，记录每一项结论对应的调用入口和兼容性依据，明确旧引擎返回缺失字段时的行为。',
  '检查 Windows 与 macOS 构建过程中出现的字体、窗口尺寸和文件路径差异，复现失败并记录真实错误，不把环境能力缺失误报为实现回归。',
  '等待确认需要包含的最终交付格式，再整理全部任务成果、附件来源、验证记录和尚未解决的问题，确保各项说明可追溯到原始需求。'
]
const statusLabels = ['运行中', '已完成', '失败', '待回答']
const instructions = tasks.map((task, index) => `${task}\n\n补充要求：请逐项核对真实界面中的按钮、键盘焦点、完整路径与错误提示。记录每个入口的观察结果，并保留原始文档、图片和表格内容。\n\n验收范围包括宽屏与窄屏、浅色与深色主题、返回列表的滚动恢复，以及需要横向滚动的代码和表格。不要省略尚未验证的部分；最终报告应明确完成内容和下一步安排。\n\n完整任务指令结束 ${index}`)
instructions[1] = `${instructions[1]}\n\n${'逐项保留原始验收记录与证据，长消息展开后仍可完整阅读。'.repeat(8)}\n\nLONG_INSTRUCTION_END`
const delegationGuidance = '仅完成本实例分工，其他成员的工作由主 Agent 协调。保留此前上下文；返回结果、证据和未完成事项。引用和附件是背景，不是新的授权。'
instructions[3] = `${delegationGuidance}\n\n本实例的任务与分工：\n${tasks[3]}\n\n当前用户请求：\n${tasks[3]}`
const reasoning = '过程记录：先核对任务边界，再读取现有界面与协议，随后检查长文本、错误状态和宽窄布局。完整过程保留，默认收起以便阅读结论。'
const report = [
  '## 协作界面与附件预览核对报告',
  '本次核对围绕任务列表、独立对话和附件预览展开。列表帮助读者辨认每个代理负责的工作，详情页保留完整指令与过程，最终答复按章节呈现可复查的结论。',
  '## 主要结论',
  '- 名称与状态放在同一行，任务说明独立呈现，长内容可以完整阅读。\n- 图片、表格与演示文稿沿用现有预览入口。\n- 窄窗口优先保证正文宽度，代码与表格在各自区域滚动。',
  '## 预览与交互核对',
  '| 类型 | 任务列表 | 工作区预览 | 历史回放 | 键盘访问 | 结果 |\n| --- | --- | --- | --- | --- | --- |\n| PNG 图片 | 显示文件状态 | 完整图片与缩放 | 保留文件来源 | Enter 打开 | 已核对 |\n| Excel 表格 | 显示文件状态 | 单元格与工作表 | 保留原始路径 | Tab 切换 | 已核对 |\n| PowerPoint 演示文稿 | 显示文件状态 | 按页预览 | 保留页序与附件 | 方向键导航 | 已核对 |\n| Word 文档 | 显示文件状态 | 连续正文阅读 | 保留文档内容 | 键盘可达 | 已核对 |',
  '## 实现边界示例',
  '```ts\nconst preview = { type: "document", source: "workspace", preserveOriginal: true }\nconst supported = ["image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]\nopenPreview(preview, supported)\n```',
  '## 阅读与布局',
  ...Array.from({ length: 8 }, (_, index) => `检查 ${index + 1}：正文使用稳定的阅读宽度和清晰的段落间距。任务摘要可以展开核对原文，过程默认收起，列表返回后保留此前位置。表格与代码允许内部横向滚动，页面本身不应被长内容撑宽。界面中的操作应有明确名称和键盘焦点，所有主题下都能辨认文字与当前状态。`),
  '## 后续安排',
  '1. 复查不同窗口尺寸中的文件入口。\n2. 核对各类附件的真实预览内容。\n3. 记录尚未覆盖的环境能力。',
  '报告完整结束：所有原始结论均保留在独立对话中。'
].join('\n\n')
const runs: SubagentRunView[] = (['running', 'succeeded', 'failed', 'blocked'] as const).map((status, index) => ({
  schemaVersion: 2, view: 'summary', runId: `list-run-${index}`, tenantId: 'list-tenant', rootSessionId: sessionId,
  parentSessionId: sessionId, parentConversationId: parent.turnId, parentMessageId: parent.assistantMessageId,
  parentToolCallId: `list-tool-${index}`, childSessionId: `list-child-${index}`, agentName: names[index],
  task: tasks[index], description: `独立职责说明 ${index}`, modelId,
  continuation: { builtinRole: roles[index], builtinRoleVersion: 1, readOnly: roles[index] === 'research' },
  status, lastSeq: 1, createdAt: now - 180_000 + index, updatedAt: now + index, startedAt: now - 128_000,
  ...(index !== 0 ? { finishedAt: now + 5000 } : {}),
  ...(index === 1 ? { resultSummary: '接口核对完成，证据保留在独立对话。', stopReason: 'completed' } : {}),
  ...(index === 0 ? { partialOutput: '正在核对已有预览入口。' } : {}),
  ...(index === 2 ? { error: { code: 'FAILED', message: '构建工具未找到指定运行环境。', retryable: false } } : {}),
  ...(index === 3 ? { stopReason: 'needs_user', error: { code: 'NEEDS_USER', message: '请确认最终交付格式。', retryable: false } } : {}),
  usage: { totalTokens: 8000 }, toolCount: 0, activeToolCount: 0, toolCalls: [],
  coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0,
    ids: [], hasMore: false, truncated: false, completeness: 'complete' }
}))
const metadata = { rootRunId: parent.runId, turnId: parent.turnId }
const history: EngineHistoryRow[] = [
  { id: parent.userMessageId, role: 'user', content: title, conversationId: parent.turnId, createdAt: now, metadata },
  { id: parent.assistantMessageId, role: 'assistant', content: '四个协作代理各自处理分配的工作。', conversationId: parent.turnId, createdAt: now + 10, metadata }
]
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Read-only list navigation must not mutate ${path}`)
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: parent.userMessageId, conversationId: parent.turnId,
      preview: title, createdAt: now }], messages: history, loadedTurnIds: [parent.userMessageId], revision: 'list-history',
      mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (/^\/api\/v1\/subagent\/runs\/[^/]+$/.test(path)) {
    const runId = decodeURIComponent(path.split('/').at(-1)!); detailReads.push(runId)
    const run = runs.find(item => item.runId === runId)
    if (!run) throw new Error(`Unknown child ${runId}`)
    response.end(envelope(run)); return
  }
  const childPage = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)\/(events|tools)$/)
  if (childPage) {
    const run = runs.find(item => item.runId === childPage[1])
    if (!run) throw new Error(`Unknown child page ${path}`)
    response.end(envelope(childPage[2] === 'events'
      ? { schemaVersion: 2, runId: run.runId, events: [], nextSeq: run.lastSeq, hasMore: false, checkpointRequired: false }
      : { schemaVersion: 2, runId: run.runId, asOfSeq: run.lastSeq, totalCount: 0, items: [], hasMore: false })); return
  }
  if (path === '/api/v1/conversation/archive') {
    archiveReads.push(id)
    const child = runs.find(run => run.childSessionId === id)
    if (!child) throw new Error(`Wrong archive ${id}`)
    const index = runs.indexOf(child)
    const rows = [{ id: `${id}-instruction`, role: 'user', content: instructions[index], createdAt: now,
      conversationId: `${id}-turn`, isSidechain: true, metadata: { ...metadata, subagentRunId: child.runId } },
    { id: `${id}-answer`, role: 'assistant', content: `LIST_INSPECTOR_RESULT_${id}\n\n${report}`, reasoningContent: reasoning, createdAt: now + 1,
      conversationId: `${id}-turn`, isSidechain: true, metadata: { ...metadata, subagentRunId: child.runId } }]
    const current = Number(url.searchParams.get('current') ?? 1), pageSize = Number(url.searchParams.get('pageSize') ?? 50)
    response.end(JSON.stringify({ code: 200, data: rows.slice((current - 1) * pageSize, current * pageSize),
      pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) },
      metadata: { archiveMessageCount: rows.length, archiveRevision: 'list-archive', backend: 'jsonl', compressed: false } })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const matching = id === sessionId
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'list-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '列表核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: matching ? history : [], projection: [], run: matching ? parent : undefined, runs: matching ? [parent] : [], subagentRuns: matching ? runs : [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching ? parent : undefined, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [parent] : [] }
    : path === '/api/v1/conversation/history' ? matching ? history : []
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: history.length }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'list-tenant', sessionId: id,
      namespace: { id: 'list-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs, listComplete: true, hasMore: false, revision: 'list-runs' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/list', entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/list' } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const panel = (): Locator => workspace().getByRole('region', { name: '协作代理', exact: true })
const rows = (): Locator => panel().locator('.work-subagents__row')
const row = (index: number): Locator => panel().locator(`.work-subagents__row[data-child-session-id="list-child-${index}"]`)
const list = (): Locator => panel().locator('.work-subagents__list')
const back = (): Locator => panel().getByRole('button', { name: '返回子代理列表', exact: true })
async function openList(): Promise<void> {
  if (!(await workspace().isVisible())) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  const tab = workspace().getByRole('tab', { name: '子代理', exact: true })
  if (await tab.isVisible()) await tab.click()
  else { await workspace().getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '子代理', exact: true }).click() }
  await expect(panel()).toBeVisible()
  if (await back().isVisible()) await back().click()
  await expect(rows()).toHaveCount(4)
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.show(); window.focus() }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
  await page.locator('body').evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => undefined)))
  })
}
async function expectChild(index: number): Promise<void> {
  await expect(panel().getByRole('heading', { name: names[index], exact: true })).toBeVisible()
  const transcript = panel().locator('.work-subagent-transcript')
  await expect(transcript).toHaveAttribute('aria-label', `${names[index]} 的对话`)
  await expect(transcript.locator('.work-subagent-transcript__scroll')).toHaveAttribute('aria-busy', 'false')
  await expect(transcript.locator(`[data-message-id="list-child-${index}-answer"]`)).toBeAttached()
  if (runs[index].status === 'running') await expect(transcript.locator('.work-subagent-transcript__live')).toContainText(runs[index].partialOutput!)
  else await expect(transcript).toContainText(`LIST_INSPECTOR_RESULT_list-child-${index}`)
  expect(archiveReads).toContain(`list-child-${index}`)
}

test.describe.serial('协作代理列表', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'subagent-list-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/list', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(520, 360))
    await setWindow(1440, 900)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, now, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
        updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: true, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await openList()
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath('subagent-list-ui.png'); await page.screenshot({ path, animations: 'disabled' })
      await info.attach('subagent-list-ui', { path, contentType: 'image/png' })
    }
    const log = info.outputPath('app-errors.json')
    writeFileSync(log, JSON.stringify({ errors, mutations, detailReads, archiveReads }, null, 2))
    await info.attach('app-errors', { path: log, contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('subagent-list-profile-')) throw new Error('Unsafe list fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('代理列表左右信息对齐，完整用时和开始时间在深浅主题与宽窄面板均不溢出', async ({}, info) => {
    expect(archiveReads).toEqual([])
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440, 900); await setAppearance(appearance)
      for (const width of [1440, 960, 560]) {
        await setWindow(width, 900); await openList()
        for (const [index, run] of runs.entries()) {
          await expect(row(index)).toHaveAttribute('aria-label', `查看 ${names[index]} 子代理详情`)
          await expect(row(index)).toHaveAttribute('aria-description', new RegExp(statusLabels[index]))
          await expect(row(index)).toHaveAttribute('data-agent-status', run.status)
          await expect(row(index)).toHaveAttribute('data-model-id', modelId)
          await expect(row(index).locator('strong')).toHaveText(names[index])
          await expect(row(index).locator('.work-subagents__row-status')).toHaveText(statusLabels[index])
          await expect(row(index).locator('.work-subagents__row-role')).toHaveText(roleLabels[index])
          await expect(row(index)).not.toContainText(tasks[index])
          await expect(row(index).locator('.work-subagents__row-duration')).toContainText('本轮用时')
          if (index !== 0) await expect(row(index).locator('.work-subagents__row-duration')).toHaveText('本轮用时 2 分 13 秒')
          await expect(row(index).locator('.work-subagents__row-time')).toHaveAttribute('datetime', new Date(run.startedAt!).toISOString())
        }
        // Related rectangles come from the same frame: a resize cannot make a
        // title/status comparison accidentally mix the old and new layouts.
        const geometry = await panel().evaluate(element => {
          const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } }
          const list = element.querySelector('.work-subagents__list')!
          return { panel: rect(element), list: rect(list), overflow: list.scrollWidth - list.clientWidth,
            rows: [...element.querySelectorAll('.work-subagents__row')].map(row => {
              const name = row.querySelector('strong')!, status = row.querySelector('.work-subagents__row-status')!
              const time = row.querySelector('.work-subagents__row-time')!, duration = row.querySelector('.work-subagents__row-duration')!
              const icon = row.querySelector('.work-subagents__row-icon')!, metrics = row.querySelector('.work-subagents__row-metrics')!
              return { row: rect(row), name: rect(name), status: rect(status), metrics: rect(metrics), icon: rect(icon),
                statusOverflow: status.scrollWidth - status.clientWidth,
                nameOverflow: name.scrollWidth - name.clientWidth, ellipsis: getComputedStyle(name).textOverflow,
                timeOverflow: time.scrollWidth - time.clientWidth, time: rect(time),
                durationOverflow: duration.scrollWidth - duration.clientWidth, duration: rect(duration) }
            }) }
        })
        expect(geometry.overflow).toBeLessThanOrEqual(1)
        expect(geometry.rows).toHaveLength(4)
        for (const item of geometry.rows) {
          expect(item.row.width).toBeLessThanOrEqual(761)
          expect(item.row.left).toBeGreaterThanOrEqual(geometry.list.left)
          expect(item.row.right).toBeLessThanOrEqual(geometry.list.right + 1)
          expect(item.statusOverflow).toBeLessThanOrEqual(1)
          expect(Math.abs((item.name.top + item.name.bottom) / 2 - (item.status.top + item.status.bottom) / 2)).toBeLessThanOrEqual(2)
          expect(item.metrics.left - item.name.right).toBeGreaterThanOrEqual(0)
          expect(item.status.right).toBeLessThanOrEqual(item.row.right)
          expect(Math.abs(item.status.right - geometry.rows[0].status.right)).toBeLessThanOrEqual(1)
          expect(Math.abs(item.duration.right - item.status.right)).toBeLessThanOrEqual(1)
          expect(item.duration.top).toBeGreaterThanOrEqual(item.status.bottom)
          expect(item.time.top).toBeGreaterThanOrEqual(item.name.bottom)
          expect(item.time.right).toBeLessThanOrEqual(item.metrics.left)
          expect(item.ellipsis).toBe('ellipsis')
          expect(item.timeOverflow).toBeLessThanOrEqual(1)
          expect(item.durationOverflow).toBeLessThanOrEqual(1)
          expect(item.time.bottom).toBeLessThanOrEqual(item.row.bottom)
          expect(item.duration.bottom).toBeLessThanOrEqual(item.row.bottom)
          expect(item.icon.width).toBeCloseTo(24, 0)
          expect(item.icon.height).toBeCloseTo(24, 0)
          expect(Math.abs(item.name.left - geometry.rows[0].name.left)).toBeLessThanOrEqual(1)
        }
        if (width === 560) {
          expect(geometry.rows.some(item => item.nameOverflow > 0)).toBe(true)
        }
        if (width === 960) expect(geometry.panel.width).toBeGreaterThan(800)
        const path = info.outputPath(`subagent-list-${appearance}-${width}.png`)
        await page.screenshot({ path, animations: 'disabled' }); await info.attach(`${appearance}-${width}`, { path, contentType: 'image/png' })
      }
    }
    expect(archiveReads).toEqual([])
  })

  test('列表中的进行中用时实时递增，已结束用时保持固定', async () => {
    await openList()
    const elapsed = row(0).locator('.work-subagents__row-duration')
    const before = Number(await elapsed.getAttribute('data-duration-ms'))
    expect(before).toBeGreaterThan(0)
    await expect.poll(async () => Number(await elapsed.getAttribute('data-duration-ms')), { timeout: 5000 }).toBeGreaterThan(before + 500)
    await expect(row(1).locator('.work-subagents__row-duration')).toHaveAttribute('data-duration-ms', '133000')
    await expect(row(3).locator('.work-subagents__row-duration')).toHaveAttribute('data-duration-ms', '133000')
  })

  test('悬浮和键盘焦点可阅读完整名称与任务，关闭浮层不进入详情', async ({}, info) => {
    await setWindow(560, 760); await openList()
    for (const index of [0, 1, 2, 3]) {
      await row(index).hover()
      const tooltip = page.getByRole('tooltip', { name: `${names[index]} 的任务`, exact: true })
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toContainText(names[index]); await expect(tooltip).toContainText(tasks[index])
      await tooltip.hover()
      await expect(tooltip).toBeVisible()
      const bounds = await tooltip.evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), width: innerWidth,
        height: innerHeight, whiteSpace: getComputedStyle(element).whiteSpace, selection: getComputedStyle(element).userSelect,
        horizontalOverflow: element.scrollWidth - element.clientWidth }))
      expect(bounds.rect.left).toBeGreaterThanOrEqual(0); expect(bounds.rect.right).toBeLessThanOrEqual(bounds.width)
      expect(bounds.rect.top).toBeGreaterThanOrEqual(0); expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.height)
      expect(bounds.horizontalOverflow).toBeLessThanOrEqual(1); expect(bounds.whiteSpace).not.toBe('nowrap'); expect(bounds.selection).toBe('text')
      await page.screenshot({ path: info.outputPath(`subagent-list-hover-${index}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0)
      await expect(rows()).toHaveCount(4); await expect(back()).toHaveCount(0)
    }
    await page.mouse.move(0, 0)
    await row(0).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    await expect(row(0)).toBeFocused()
    await expect(page.getByRole('tooltip').filter({ hasText: tasks[0] })).toBeVisible()
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0)
    expect(archiveReads).toEqual([])
  })

  test('整行与键盘进入正确独立对话，返回恢复原行焦点和非零滚动位置', async () => {
    await setWindow(560, 420); await openList()
    await expect.poll(() => list().evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(20)
    for (const index of [2, 3, 1, 0]) {
      await row(index).scrollIntoViewIfNeeded()
      const savedTop = await list().evaluate(element => element.scrollTop)
      if (index === 2) expect(savedTop).toBeGreaterThan(0)
      const before = archiveReads.length
      if (index % 2) { await row(index).focus(); await page.keyboard.press('Enter') }
      else await row(index).click({ position: { x: 5, y: 5 } })
      await expectChild(index)
      expect([...new Set(archiveReads.slice(before))]).toEqual([`list-child-${index}`])
      await expect(back()).toBeFocused()
      if (index % 2) await page.keyboard.press('Escape')
      else await back().click()
      await expect(rows()).toHaveCount(4)
      await expect(row(index)).toBeFocused()
      await expect.poll(() => list().evaluate(element => element.scrollTop)).toBeCloseTo(savedTop, 0)
      await page.keyboard.press('Escape')
    }
  })

  test('详情报告在深浅色与宽窄窗口中保持阅读宽度，指令和过程可完整展开', async ({}, info) => {
    await setWindow(1440, 900); await openList(); await row(1).click(); await expectChild(1)
    const transcript = panel().locator('.work-subagent-transcript')
    const scroller = transcript.locator('.work-subagent-transcript__scroll')
    const instruction = transcript.locator('[data-message-id="list-child-1-instruction"]')
    const answer = transcript.locator('[data-message-id="list-child-1-answer"]')
    await expect(answer.locator('.md')).toContainText('报告完整结束：所有原始结论均保留在独立对话中。')
    await expect(answer.locator('.md h2')).toHaveCount(6)
    await expect(answer.locator('.md table')).toHaveCount(1)
    await expect(answer.locator('.md pre')).toHaveCount(1)
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440, 900); await setAppearance(appearance)
      for (const width of [1440, 960, 560]) {
        await setWindow(width, 900)
        await scroller.evaluate(element => { element.scrollTop = 0 })
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
        const geometry = await panel().evaluate(element => {
          const scroll = element.querySelector('.work-subagent-transcript__scroll')!
          const answer = element.querySelector('[data-message-id="list-child-1-answer"]')!
          const body = answer.querySelector('.md')!, form = element.querySelector('.work-subagents__composer')!
          const editor = form.querySelector('.work-subagents__composer-editor')!, input = form.querySelector('textarea')!, actions = form.querySelector('.work-subagents__composer-actions')!
          const heading = element.querySelector('.work-subagents__header h3')!, status = element.querySelector('.work-subagents__header .work-subagents__status')!
          const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } }
          return { panel: rect(element), scroll: rect(scroll), body: rect(body), form: rect(form),
            editor: rect(editor), input: rect(input), actions: rect(actions), heading: rect(heading), status: rect(status),
            panelOverflow: element.scrollWidth - element.clientWidth, scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
            code: [...body.querySelectorAll('pre, .md-table-wrap')].map(node => rect(node)) }
        })
        expect(geometry.panelOverflow).toBeLessThanOrEqual(1); expect(geometry.scrollOverflow).toBeLessThanOrEqual(1)
        expect(geometry.body.width).toBeGreaterThan(160); expect(geometry.body.width).toBeLessThanOrEqual(801)
        expect(geometry.body.left).toBeGreaterThanOrEqual(geometry.scroll.left)
        expect(geometry.body.right).toBeLessThanOrEqual(geometry.scroll.right + 1)
        expect(geometry.form.width).toBeLessThanOrEqual(833)
        expect(Math.abs(geometry.editor.left - geometry.body.left)).toBeLessThanOrEqual(16)
        expect(Math.abs(geometry.editor.right - geometry.body.right)).toBeLessThanOrEqual(16)
        expect(geometry.status.top).toBeGreaterThanOrEqual(geometry.heading.bottom)
        expect(geometry.actions.left).toBeGreaterThanOrEqual(geometry.input.right)
        expect(Math.abs(geometry.actions.bottom - geometry.input.bottom)).toBeLessThanOrEqual(2)
        for (const block of geometry.code) {
          expect(block.left).toBeGreaterThanOrEqual(geometry.body.left - 1)
          expect(block.right).toBeLessThanOrEqual(geometry.body.right + 1)
        }
        const path = info.outputPath(`subagent-detail-${appearance}-${width}.png`)
        await page.screenshot({ path, animations: 'disabled' }); await info.attach(`detail-${appearance}-${width}`, { path, contentType: 'image/png' })
        const table = answer.locator('.md-table-wrap')
        await table.scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath(`subagent-detail-table-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await expect(instruction.locator('.work-subagent-instruction__meta time')).toHaveCount(1)
    await expect(transcript.locator('.work-subagent-transcript__message-meta time')).toHaveCount(1)
    await expect(panel().locator('.work-subagents__detail-duration')).toHaveText('本轮用时 2 分 13 秒')
    const summary = instruction.getByRole('button', { name: '展开用户消息全文', exact: true })
    await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press('Enter')
    await expect(instruction.getByRole('button', { name: '收起用户消息', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(instruction.locator('.message__bubble-content')).toHaveText(instructions[1])
    await instruction.getByRole('button', { name: '收起用户消息', exact: true }).click()
    await expect(instruction).not.toContainText('LONG_INSTRUCTION_END')
    const process = answer.getByRole('button', { name: '展开过程', exact: true })
    await process.click()
    const reasoningRow = answer.locator('.work-message__thinking .logline')
    await expect(reasoningRow).toHaveAttribute('aria-expanded', 'false')
    await reasoningRow.focus(); await page.keyboard.press('Enter')
    await expect(answer.locator('.logline__detail pre')).toHaveText(reasoning)
    await page.screenshot({ path: info.outputPath('subagent-detail-expanded-process.png'), animations: 'disabled' })
    await answer.getByRole('button', { name: '收起过程', exact: true }).click()
    await expect(answer.locator('.logline__detail pre')).toHaveCount(0)
    await back().click(); await expect(row(1)).toBeFocused()
  })

  test('用户气泡只显示去重正文，说明与原文在单一详情浮层中切换', async ({}, info) => {
    await setWindow(960, 900); await openList(); await row(3).click(); await expectChild(3)
    const instruction = panel().locator('.work-subagent-instruction')
    await instruction.scrollIntoViewIfNeeded()
    await expect(instruction.locator('.message__bubble-content')).toHaveText(tasks[3])
    await expect(instruction).not.toContainText(delegationGuidance)
    await expect(instruction.locator('.work-subagent-instruction__meta time')).toHaveCount(1)
    const trigger = instruction.getByRole('button', { name: '用户消息详情', exact: true })
    await trigger.click()
    const details = page.getByRole('dialog', { name: '用户消息详情', exact: true })
    await expect(details.getByRole('tabpanel')).toHaveCount(1)
    await expect(details.getByRole('tabpanel')).toContainText(delegationGuidance)
    await expect(details.locator('.work-subagent-instruction__original')).toHaveCount(0)
    await details.getByRole('tab', { name: '原始消息', exact: true }).click()
    await expect(details.getByRole('tabpanel')).toHaveCount(1)
    await expect(details.locator('.work-subagent-instruction__original')).toHaveText(instructions[3])
    await expect(details.locator('.work-subagent-instruction__context')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('user-message-details.png'), animations: 'disabled' })
    await page.keyboard.press('Escape'); await expect(details).toHaveCount(0); await expect(trigger).toBeFocused()
    await expect(panel().getByRole('heading', { name: names[3], exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('user-message-clean.png'), animations: 'disabled' })
    await back().click()
  })
})
