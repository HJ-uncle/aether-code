/** Real Electron + authenticated HTTP fixture: Work/Code lifecycle isolation,
 * persisted drafts and task history, actual SSE send/cancel/error paths, and
 * shared themed selectors, message alignment and narrow-window/motion behavior.
 * The provider is controlled; the IPC,
 * engine host, streaming decoder, React tree and native window stay real. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload, EngineFileChange } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { AetherIdeApi } from '../src/preload'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

let health: ElectronHealthMonitor | undefined

declare global {
  interface Window {
    aether: AetherIdeApi
  }
}

const root = resolve(__dirname, '..'),
  fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-mode-fixture-token',
  modelId = 'work-mode-fixture-model',
  alternateModelId = 'work-mode-alternate-model'
const sessions = new Map<string, FixtureSession>()
const chatRequests: Array<{
  sessionId: string
  message: string
  model?: string
  agentId?: string
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
  thinkingMode?: unknown
  memoryScope?: unknown
  workspacePaths?: string[]
}> = []
const toolResponses: Array<{
  sessionId: string
  runId: string
  toolResponse: Record<string, unknown>
}> = []
const cancellations: string[] = [],
  errors: string[] = []
const fixtureAgents = new Map<string, Record<string, unknown>>()
const fixtureSkills = [
  { id: 'skill-review', name: '代码审查技能', description: '检查实现与测试', enabled: true },
  { id: 'skill-docs', name: '文档技能', description: '整理技术文档', enabled: true }
]
const fixtureMcpServers = [
  { id: 'mcp-git', name: 'Git 服务', description: '访问 Git 仓库', enabled: true },
  { id: 'mcp-search', name: '搜索服务', description: '查询外部资料', enabled: true }
]
const fixtureKnowledgeBases = [
  { id: 'kb-product', name: '产品知识库', description: '产品规范与设计资料', documentCount: 4, createdAt: Date.now() }
]
const fixtureTools = [
  { name: 'read_file', displayName: '读取文件', description: '读取工作区文件' },
  { name: 'write_file', displayName: '写入文件', description: '写入工作区文件' },
  { name: 'run_command', displayName: '运行命令', description: '执行受控命令' }
]
const memoryScopes = new Map<string, string>()
const securityModes = new Map<string, string>()
const utilityRequests: Array<{ body: Record<string, unknown>; response: ServerResponse }> = []
let fixture = '',
  app: ElectronApplication | undefined,
  page: Page,
  runCount = 0,
  failedWorkSnapshots = 0

interface FixtureSession {
  run?: RootRun
  history: EngineHistoryRow[]
  projection: ChatSsePayload[]
  response?: ServerResponse
  sequence: number
  content: string
}

function session(id: string): FixtureSession {
  let value = sessions.get(id)
  if (!value) {
    value = { history: [], projection: [], sequence: 0, content: '' }
    sessions.set(id, value)
  }
  return value
}

function frame(id: string, payload: ChatSsePayload & { error?: string }): void {
  const value = session(id)
  if (!value.response || value.response.writableEnded || !value.run)
    throw new Error(`Missing open Work stream: ${id}`)
  if (typeof payload.content === 'string') value.content += payload.content
  value.projection.push(structuredClone(payload))
  value.response.write(
    `id: ${value.run.runId}:${++value.sequence}\ndata: ${JSON.stringify(payload)}\n\n`
  )
}

function finish(id: string, status: 'succeeded' | 'cancelled' | 'failed' = 'succeeded'): void {
  const value = session(id)
  if (!value.run) throw new Error(`Missing Work run: ${id}`)
  value.run = {
    ...value.run,
    status,
    seq: value.sequence + 1,
    version: value.run.version + 1,
    updatedAt: Date.now(),
    finishedAt: Date.now(),
    ...(status === 'failed' ? { error: 'WORK_PROVIDER_FAILED：模型暂时不可用' } : {})
  }
  value.history.push({
    id: value.run.assistantMessageId,
    role: 'assistant',
    content: value.content,
    conversationId: value.run.turnId,
    createdAt: Date.now(),
    modelId
  })
  if (value.response && !value.response.writableEnded && !value.response.destroyed) {
    if (status === 'failed') frame(id, { error: 'WORK_PROVIDER_FAILED：模型暂时不可用' })
    frame(id, { run: value.run })
    value.response.end('data: [DONE]\n\n')
  }
  value.projection = []
}

const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
      path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 401, message: 'Invalid fixture token' }))
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk.toString()
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (path === '/api/v1/utility/chat') { utilityRequests.push({ body, response }); return }
    if (path === '/api/v1/memory/settings' || path === '/api/v1/security/mode') {
      const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
      const memory = path.includes('/memory/')
      if (request.method === 'PUT') (memory ? memoryScopes : securityModes).set(id, String(memory ? body.memoryScope : body.mode))
      response.setHeader('content-type', 'application/json')
      response.end(envelope(memory
        ? { sessionId: id, memoryScope: memoryScopes.get(id) ?? 'session', effectiveScope: memoryScopes.get(id) ?? 'session', enabled: true }
        : { sessionId: id, mode: securityModes.get(id) ?? 'safe' }))
      return
    }
    if (path === '/api/v1/skills' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ list: fixtureSkills }))
      return
    }
    if (path === '/api/v1/mcp/servers' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope(fixtureMcpServers))
      return
    }
    if (path === '/api/v1/knowledge/bases' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope(fixtureKnowledgeBases))
      return
    }
    if (path === '/api/v1/system-tools' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ list: fixtureTools }))
      return
    }
    if (path === '/api/v1/agents' || path.startsWith('/api/v1/agents/')) {
      response.setHeader('content-type', 'application/json')
      const id = path === '/api/v1/agents' ? null : decodeURIComponent(path.slice('/api/v1/agents/'.length))
      if (request.method === 'POST') {
        const created = {
          ...body,
          id: `fixture-agent-${fixtureAgents.size + 1}`,
          ...(body.allowedTools === undefined ? { allowedTools: ['read_file'] } : {}),
          ...(body.skills === undefined ? { skills: ['keep-existing-skill'] } : {})
        }
        fixtureAgents.set(created.id, created); response.end(envelope(created))
      } else if (request.method === 'PUT' && id) {
        fixtureAgents.set(id, { ...fixtureAgents.get(id), ...body }); response.end(envelope(fixtureAgents.get(id)))
      } else if (request.method === 'DELETE' && id) {
        fixtureAgents.delete(id); response.end(envelope({ id }))
      } else response.end(envelope(id ? fixtureAgents.get(id) : [...fixtureAgents.values()]))
      return
    }
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const id = String(body.sessionId ?? ''),
        value = session(id)
      if (!id.startsWith('work-')) throw new Error(`Work wrote to a Code session: ${id}`)
      if (body.toolResponse && typeof body.toolResponse === 'object') {
        if (!value.run || value.run.status !== 'waiting')
          throw new Error('No waiting Work request to answer')
        const answer = body.toolResponse as Record<string, unknown>
        toolResponses.push({ sessionId: id, runId: String(body.runId), toolResponse: answer })
        value.response = response
        value.run = {
          ...value.run,
          status: 'running',
          version: value.run.version + 1,
          updatedAt: Date.now(),
          pending: value.run.pending.map((item) =>
            item.requestId === answer.requestId
              ? { ...item, status: 'answered', output: String(answer.output) }
              : item
          )
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        frame(id, { run: value.run })
        return
      }
      chatRequests.push({
        sessionId: id,
        message: String(body.message ?? ''),
        model: typeof body.model === 'string' ? body.model : undefined,
        agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
        skills: Array.isArray(body.skills) ? body.skills as string[] : undefined,
        mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers as string[] : undefined,
        knowledgeBases: Array.isArray(body.knowledgeBases) ? body.knowledgeBases as string[] : undefined,
        allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools as string[] : undefined,
        thinkingMode: body.thinkingMode,
        memoryScope: body.memoryScope,
        workspacePaths: Array.isArray(body.workspacePaths)
          ? (body.workspacePaths as string[])
          : undefined
      })
      runCount += 1
      value.sequence = 0
      value.content = ''
      value.projection = []
      value.response = response
      value.run = {
        schemaVersion: 1,
        runId: `work-fixture-run-${runCount}`,
        sessionId: id,
        turnId: `work-fixture-turn-${runCount}`,
        userMessageId: `work-fixture-user-${runCount}`,
        assistantMessageId: `work-fixture-assistant-${runCount}`,
        seq: 1,
        version: 1,
        status: 'running',
        modelId,
        pending: [],
        workspacePaths: Array.isArray(body.workspacePaths) ? body.workspacePaths as string[] : [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      const user: EngineHistoryRow = {
        id: value.run.userMessageId,
        role: 'user',
        content: String(body.message ?? ''),
        conversationId: value.run.turnId,
        createdAt: Date.now()
      }
      value.history.push(user)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(id, { run: value.run })
      frame(id, { userMessage: user })
      return
    }
    if (path === '/api/v1/chat/stream') {
      const value = session(url.searchParams.get('sessionId') ?? '')
      value.response = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      return
    }
    if (path === '/api/v1/chat/cancel' && request.method === 'POST') {
      const id = String(body.sessionId ?? '')
      cancellations.push(id)
      finish(id, 'cancelled')
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(envelope({ cancelled: true, sessionId: id }))
      return
    }
    if (
      path === '/api/v1/chat/snapshot' &&
      url.searchParams.get('sessionId')?.startsWith('work-') &&
      failedWorkSnapshots > 0
    ) {
      failedWorkSnapshots -= 1
      response
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 503, message: 'WORK_HISTORY_UNAVAILABLE：暂时无法读取历史' }))
      return
    }
    response.setHeader('content-type', 'application/json')
    const id = url.searchParams.get('sessionId') ?? '',
      value = session(id)
    const data =
      path === '/health'
        ? { status: 'ok' }
        : path === '/meta'
          ? {
              version: '2.0.0',
              buildId: `sha256:${'f'.repeat(64)}`,
              protocolVersion: 1,
              toolProfiles: ['code'],
              subagentSchemaVersion: 1,
              instanceId: 'work-mode-fixture'
            }
          : path === '/api/v1/models'
            ? [
                {
                  id: modelId,
                  modelId,
                  provider: 'openai',
                  displayName: 'Work fixture model',
                  isEnabled: true,
                  capabilities: { toolCalling: true, contextWindow: 128000 }
                },
                {
                  id: alternateModelId,
                  modelId: alternateModelId,
                  provider: 'openai',
                  displayName: 'Work alternate model',
                  isEnabled: true,
                  capabilities: { toolCalling: true, contextWindow: 128000 }
                }
              ]
            : path === '/api/v1/conversation/sessions'
              ? [...sessions.entries()]
                  .filter(([, item]) => item.history.length)
                  .map(([sessionId, item]) => ({
                    sessionId,
                    title: item.history[0]?.content ?? '',
                    lastAt: Date.now(),
                    messageCount: item.history.length
                  }))
              : path === '/api/v1/chat/snapshot'
                ? {
                    schemaVersion: 1,
                    sessionId: id,
                    source: value.run?.status === 'running' ? 'live' : 'persisted',
                    eventId: value.run ? `${value.run.runId}:${value.sequence}` : null,
                    finished: value.run?.status !== 'running',
                    projection: value.projection,
                    history: value.history,
                    run: value.run,
                    runs: value.run ? [value.run] : [],
                    todos: [],
                    changes: [],
                    commandJobs: []
                  }
                : path === '/api/v1/chat/status'
                  ? {
                      running: value.run?.status === 'running',
                      finished: Boolean(value.run && value.run.status !== 'running'),
                      run: value.run,
                      lastEventId: value.run ? `${value.run.runId}:${value.sequence}` : null
                    }
                : path === '/api/v1/chat/runs'
                  ? { runs: value.run ? [value.run] : [] }
                  : path === '/api/v1/workspace/directory'
                    ? { root: '/remote/work-mode-fixture', entries: [] }
                    : path === '/api/v1/workspace/bind'
                      ? { workspaceRoot: '/remote/work-mode-fixture' }
                      : []
    response.end(envelope(data))
  })().catch((error) => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})

const work = () => page.locator('.work-view')
const runStatus = () => work().locator('.work-run-status')
const workMode = () => page.getByRole('tab', { name: 'Work 办公', exact: true })
const codeMode = () => page.getByRole('tab', { name: 'Code 开发', exact: true })
async function switchTo(mode: 'code' | 'work'): Promise<void> {
  await (mode === 'work' ? workMode() : codeMode()).click()
  await expect(page.locator(`.mode-surface[data-mode="${mode}"]`)).toBeVisible()
  await expect(
    page.locator(`.mode-surface[data-mode="${mode === 'work' ? 'code' : 'work'}"]`)
  ).toBeHidden()
}
async function startTask(prompt: string): Promise<string> {
  await switchTo('work')
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const previous = chatRequests.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => chatRequests.length).toBe(previous + 1)
  return chatRequests[previous].sessionId
}

test.describe.serial('Work 模式', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing Work fixture port')
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-mode-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({
        engineMode: 'remote',
        remoteBaseUrl: `http://127.0.0.1:${address.port}`,
        autoStartEngine: true,
        remoteWorkspaceRoot: '/remote/code-project',
        lastSessionId: '',
        lastModelId: modelId,
        thinkingMode: 'off',
        appearance: 'dark',
        lastFolder: ''
      })
    )
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`],
      cwd: root,
      env: {
        ...process.env,
        AETHER_IDE_REMOTE_INSTANCE_TOKEN: token,
        AETHER_GLOBAL_DIR: join(fixture, 'global')
      }
    })
    health = await monitorElectronHealth(app, 'work-mode', [token])
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await expect(codeMode()).toHaveAttribute('aria-selected', 'true')
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, testInfo) => {
    for (const value of sessions.values()) value.response?.destroy()
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      if (fixture) {
        const absolute = resolve(fixture)
        if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('work-mode-'))
          throw new Error(`Unsafe Work fixture cleanup: ${absolute}`)
        rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('左上切换保留 Code DOM、草稿和原有布局，隐藏层不能聚焦', async ({}, testInfo) => {
    const codeInput = page.locator('.mode-surface[data-mode="code"] .chat__input')
    await expect(codeInput).toBeVisible()
    await codeInput.fill('CODE_DRAFT_SHOULD_SURVIVE')
    await page.locator('.mode-surface[data-mode="code"] .workbench__body').evaluate((element) => {
      ;(window as Window & { workCodeNode?: Element }).workCodeNode = element
    })
    const before = await page.evaluate(() => localStorage.getItem('aether.ide.layout'))
    await switchTo('work')
    await expect(page.locator('.mode-surface[data-mode="code"]')).toHaveAttribute('inert', '')
    await work()
      .getByRole('textbox', { name: '任务目标', exact: true })
      .fill('WORK_DRAFT_SHOULD_SURVIVE')
    await switchTo('code')
    await expect(codeInput).toContainText('CODE_DRAFT_SHOULD_SURVIVE')
    expect(
      await page.evaluate(
        () =>
          (window as Window & { workCodeNode?: Element }).workCodeNode ===
          document.querySelector('.mode-surface[data-mode="code"] .workbench__body')
      )
    ).toBe(true)
    expect(await page.evaluate(() => localStorage.getItem('aether.ide.layout'))).toBe(before)
    await switchTo('work')
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toHaveText(
      'WORK_DRAFT_SHOULD_SURVIVE'
    )
    await page.reload()
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toHaveText(
      'WORK_DRAFT_SHOULD_SURVIVE'
    )
    await page.screenshot({
      path: testInfo.outputPath('work-home-1440.png'),
      animations: 'disabled'
    })
    await expect(page.locator('.mode-surface[data-mode="work"]')).toHaveCSS('opacity', '1')
  })

  test('真实任务流使用独立会话，切换模式不中断，完成后刷新可回放', async () => {
    const codeSelection = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId'))
      )
    )
    const id = await startTask('WORK_SUCCESS：整理客户反馈并给出有序结论')
    expect(chatRequests.at(-1)).toMatchObject({
      sessionId: id,
      message: 'WORK_SUCCESS：整理客户反馈并给出有序结论',
      model: modelId
    })
    expect(chatRequests.at(-1)?.workspacePaths).toEqual([])
    await expect(runStatus()).toBeVisible()
    await expect(runStatus()).toHaveAttribute('data-state', 'running')
    const elapsed = runStatus().locator('.work-run-status__elapsed')
    await expect(elapsed).toHaveText(/^(?:\d+ 分 )?\d+ 秒$/)
    const initialElapsed = await elapsed.textContent()
    await expect(elapsed).not.toHaveText(initialElapsed!, { timeout: 5_000 })
    frame(id, { content: 'WORK_PROGRESS：已经整理第一批资料。' })
    await expect(work()).toContainText('WORK_PROGRESS')
    await expect(runStatus()).toHaveAttribute('data-phase', 'generating')
    await expect(runStatus()).toContainText('正在生成回复')
    await expect(work().locator('.work-message__author')).toHaveCount(0)
    const alignment = await work()
      .locator('.work-conversation__content')
      .evaluate((element) => {
        const user = element.querySelector('.work-message--user .md')
        const assistant = element.querySelector('.work-message--assistant .md')
        if (!user || !assistant) throw new Error('Missing rendered Work messages')
        const container = element.getBoundingClientRect(),
          padding = getComputedStyle(element),
          left = container.left + parseFloat(padding.paddingLeft),
          right = container.right - parseFloat(padding.paddingRight),
          userRect = user.getBoundingClientRect()
        return {
          userRightGap: Math.abs(right - userRect.right),
          assistantLeftGap: Math.abs(assistant.getBoundingClientRect().left - left),
          userWidth: userRect.width,
          contentWidth: right - left
        }
      })
    expect(alignment.userRightGap).toBeLessThanOrEqual(2)
    expect(alignment.assistantLeftGap).toBeLessThanOrEqual(2)
    expect(alignment.userWidth).toBeLessThan(alignment.contentWidth)
    await switchTo('code')
    await expect(runStatus()).toBeHidden()
    expect(cancellations).toEqual([])
    frame(id, { content: '\n\nWORK_RESULT：\n1. 优化响应速度。\n2. 简化资料整理。' })
    finish(id)
    await switchTo('work')
    await expect(work()).toContainText('WORK_RESULT')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    expect(
      await page.evaluate(() =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId'))
        )
      )
    ).toEqual(codeSelection)
    await page.reload()
    await expect(work()).toContainText('WORK_RESULT')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
  })

  test('真实停止请求只取消当前 Work 任务，已停止状态刷新后保留', async () => {
    const id = await startTask('WORK_STOP：整理一份尚在执行的调查')
    frame(id, { content: 'WORK_STOP_PROGRESS：任务正在处理中。' })
    await expect(work()).toContainText('WORK_STOP_PROGRESS')
    await expect(runStatus()).toBeVisible()
    await runStatus().getByRole('button', { name: /停止/ }).click()
    await expect.poll(() => cancellations).toContain(id)
    await expect(work()).toContainText('已停止')
    await expect(runStatus()).toHaveCount(0)
    await page.reload()
    await expect(work()).toContainText('WORK_STOP_PROGRESS')
    await expect(work()).toContainText('已停止')
    await expect(runStatus()).toHaveCount(0)
    expect(new Set(chatRequests.map((request) => request.sessionId)).size).toBe(2)
  })

  test('执行失败如实呈现，可继续输入，不伪装成完成', async () => {
    const id = await startTask('WORK_FAILURE：验证服务端失败提示')
    await expect(runStatus()).toBeVisible()
    frame(id, { content: 'WORK_BEFORE_FAILURE' })
    finish(id, 'failed')
    await expect(work()).toContainText('WORK_PROVIDER_FAILED')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeEnabled()
  })

  test('工作步骤只有一层折叠，成果可预览和引用，用户上滚时保留阅读位置', async ({}, testInfo) => {
    const id = await startTask('WORK_ARTIFACT：生成调查报告并列出步骤')
    frame(id, {
      todo: {
        todos: [
          { id: 'research', title: '核对调查来源', status: 'done', priority: 'medium' },
          { id: 'report', title: '整理调查报告', status: 'in_progress', priority: 'medium' }
        ]
      }
    })
    frame(id, {
      content: Array.from(
        { length: 28 },
        (_, index) =>
          `WORK_READING_${index + 1}：正在整理第 ${index + 1} 项事实，保持用户在工作对话中的阅读位置。`
      ).join('\n\n')
    })
    const scroll = work().locator('.work-conversation__scroll')
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight))
      // The compact process row and activity disclosure no longer add the old
      // full-width tool card height; assert real overflow without coupling the
      // reading test to a particular viewport/font rasterization.
      .toBeGreaterThan(200)
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThanOrEqual(2)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    const steps = work().locator('.work-steps')
    await expect(steps.locator('summary')).toHaveCount(1)
    await expect(steps).not.toHaveAttribute('open', '')
    await steps.locator('summary').click()
    await expect(steps.locator('li')).toHaveCount(2)
    await expect(steps.locator('li').first()).toBeVisible()
    await steps.locator('summary').click()
    await expect(steps.locator('li').first()).toBeHidden()
    await steps.locator('summary').click()
    await scroll.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(runStatus()).toBeInViewport()
    await expect(work().getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    frame(id, { content: '\n\nWORK_LATE_PROGRESS：新的调查结论。' })
    await expect(work()).toContainText('WORK_LATE_PROGRESS')
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2)
    await work().getByRole('button', { name: '回到最新', exact: true }).click()
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThanOrEqual(2)

    const change: EngineFileChange = {
      id: 'work-report-receipt',
      toolCallId: 'work-write-tool',
      path: '/remote/work-mode-fixture/report.md',
      displayPath: 'report.md',
      kind: 'write',
      oldContent: null,
      newContent: '# WORK_ARTIFACT_CONTENT\n\n1. 来源已核对。\n2. 后续行动明确。',
      isNew: true,
      truncated: false,
      status: 'kept',
      createdAt: Date.now()
    }
    frame(id, {
      toolStart: { id: 'work-write-tool', name: 'write_file', args: { path: 'report.md' } }
    })
    await expect(runStatus()).toHaveAttribute('data-phase', 'tool')
    await expect(runStatus()).toContainText('写入文件')
    frame(id, { fileChange: change })
    frame(id, {
      toolEnd: { id: 'work-write-tool', name: 'write_file', output: '文件已写入', success: true }
    })
    await expect(runStatus()).toContainText('正在生成回复')
    await work().getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true }).click()
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_ARTIFACT_CONTENT')
    await expect(work().locator('.work-artifact-select')).toContainText('草稿')
    await page.screenshot({
      path: testInfo.outputPath('work-active-1440.png'),
      animations: 'disabled'
    })
    const sentBeforeReference = chatRequests.length
    await work().getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(
      /report\.md.*work-report-receipt/
    )
    expect(chatRequests.length, '引用文件只补充草稿，不应直接发起模型请求').toBe(
      sentBeforeReference
    )
    frame(id, {
      toolStart: { id: 'work-summary-tool', name: 'write_file', args: { path: 'summary.md' } }
    })
    frame(id, {
      fileChange: {
        ...change,
        id: 'work-summary-receipt',
        toolCallId: 'work-summary-tool',
        path: '/remote/work-mode-fixture/summary.md',
        displayPath: 'summary.md',
        newContent: '# WORK_SECOND_ARTIFACT\n\n另一份成果的独立内容。'
      }
    })
    frame(id, {
      toolEnd: { id: 'work-summary-tool', name: 'write_file', output: '文件已写入', success: true }
    })
    const artifactSelect = work().getByRole('button', { name: '选择成果', exact: true })
    await expect(artifactSelect).toContainText('report.md')
    await artifactSelect.click()
    await page.getByRole('menuitem', { name: /^summary\.md\s/ }).click()
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_SECOND_ARTIFACT')
    await expect(work().locator('.work-artifact-preview')).not.toContainText(
      'WORK_ARTIFACT_CONTENT'
    )
    await artifactSelect.click()
    await page.getByRole('menuitem', { name: /^report\.md\s/ }).click()
    await expect(work().locator('.work-artifact-preview')).toContainText('WORK_ARTIFACT_CONTENT')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    await expect(work().locator('.work-activities__list button')).toHaveCount(2)
    await work().locator('.work-activities__list button').first().click()
    await expect(work().locator('.work-activity-detail')).toContainText('report.md')
    frame(id, {
      toolStart: { id: 'work-module-tool', name: 'write_file', args: { path: 'module.mjs' } }
    })
    frame(id, {
      fileChange: {
        ...change,
        id: 'work-module-receipt',
        toolCallId: 'work-module-tool',
        path: '/remote/work-mode-fixture/module.mjs',
        displayPath: 'module.mjs',
        newContent: 'export const WORK_MODULE_RESULT = 42;\n'
      }
    })
    frame(id, {
      toolEnd: { id: 'work-module-tool', name: 'write_file', output: '模块文件已写入', success: true }
    })
    await work().getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true }).click()
    await artifactSelect.click()
    await page.getByRole('menuitem', { name: /^module\.mjs\s/ }).click()
    const modulePreview = work().locator('.work-artifact-preview')
    await expect(modulePreview).toContainText('export const WORK_MODULE_RESULT = 42;')
    await expect(modulePreview.locator('code span.hljs-keyword', { hasText: /^export$/ })).toBeVisible()
    await expect(modulePreview.locator('code span.hljs-keyword', { hasText: /^const$/ })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('work-module-syntax-highlight.png'), animations: 'disabled' })
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    finish(id)
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('tab', { name: '活动', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(
      /work-report-receipt/
    )
  })

  test('待补充问题可真实回答，保留原运行标识并继续完成任务', async () => {
    const id = await startTask('WORK_QUESTION：先确认报告格式再整理')
    const value = session(id),
      run = value.run!
    value.run = {
      ...run,
      status: 'waiting',
      version: run.version + 1,
      updatedAt: Date.now(),
      pending: [
        {
          requestId: 'work-format-question',
          toolCallId: 'ask-work-format',
          toolName: 'ask_user',
          kind: 'ask',
          status: 'pending',
          args: {
            question: '你希望报告采用什么格式？',
            options: [{ label: '简明结论' }, { label: '详细分析' }]
          }
        }
      ]
    }
    frame(id, { run: value.run })
    value.response!.end('data: [DONE]\n\n')
    await expect(work().locator('.work-task-heading')).toContainText('等你补充')
    await expect(runStatus()).toBeVisible()
    await expect(runStatus()).toHaveAttribute('data-state', 'waiting')
    await expect(runStatus()).toHaveAttribute('data-phase', 'waiting')
    await expect(runStatus().getByRole('status', { name: '任务运行状态', exact: true })).toHaveText(
      '等你补充'
    )
    await expect(runStatus().locator('.ui-spinner')).toHaveCount(0)
    await expect(
      work().getByRole('button', { name: 'Work 使用的模型', exact: true })
    ).toBeDisabled()
    await expect(work().getByRole('button', { name: '提交回复', exact: true })).toBeDisabled()
    await work()
      .getByRole('textbox', { name: '继续对话', exact: true })
      .fill('等待时暂存的补充要求')
    await expect(work().getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await work().getByRole('radio', { name: '简明结论', exact: true }).check()
    await work().getByRole('button', { name: '提交回复', exact: true }).click()
    await expect.poll(() => toolResponses.length).toBe(1)
    await expect(runStatus()).toBeVisible()
    await expect(runStatus()).toHaveAttribute('data-state', 'running')
    expect(toolResponses[0]).toEqual({
      sessionId: id,
      runId: run.runId,
      toolResponse: {
        requestId: 'work-format-question',
        runId: run.runId,
        toolCallId: 'ask-work-format',
        name: 'ask_user',
        output: '简明结论'
      }
    })
    frame(id, { content: 'WORK_ANSWER_RESULT：已按简明结论整理。' })
    finish(id)
    await expect(work()).toContainText('WORK_ANSWER_RESULT')
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(runStatus()).toHaveCount(0)
    await expect(work().getByRole('button', { name: '提交回复', exact: true })).toHaveCount(0)
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(
      '等待时暂存的补充要求'
    )
  })

  test('历史读取失败时保留目标且不发送，重新加载后只启动一次任务', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const prompt = 'WORK_HISTORY_RETRY：历史恢复完成后再运行'
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
    const before = chatRequests.length
    failedWorkSnapshots = 1
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(work().getByRole('alert')).toContainText('WORK_HISTORY_UNAVAILABLE')
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(prompt)
    expect(chatRequests.length).toBe(before)
    await work().getByRole('button', { name: '重新加载', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(before + 1)
    const id = chatRequests[before].sessionId
    expect(chatRequests[before].message).toBe(prompt)
    frame(id, { content: 'WORK_RECOVERED_RESULT：历史恢复后执行成功。' })
    finish(id)
    await expect(work()).toContainText('WORK_RECOVERED_RESULT')
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    expect(chatRequests.length).toBe(before + 1)
  })

  test('公共选择器随主题取色，键盘和鼠标选择真正传入模型请求，长消息窄窗不溢出', async ({}, testInfo) => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const modelSelect = work().getByRole('button', { name: 'Work 使用的模型', exact: true })
    await expect(modelSelect).toHaveClass(/select__trigger/)
    await expect(work().locator('select')).toHaveCount(0)
    const themes = [
      { appearance: 'dark', appearanceLabel: '深色', accent: 'purple', accentLabel: '紫色' },
      { appearance: 'light', appearanceLabel: '浅色', accent: 'blue', accentLabel: '蓝色' }
    ]
    const panelBackgrounds: string[] = []
    for (const theme of themes) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings.getByRole('radio', { name: theme.appearanceLabel, exact: true }).click()
      await settings.getByRole('radio', { name: theme.accentLabel, exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', theme.appearance)
      await expect(page.locator('html')).toHaveAttribute('data-accent', theme.accent)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await modelSelect.click()
      const panel = page.locator('.popover__panel').filter({ has: page.locator('.select__panel') })
      await expect(panel).toBeVisible()
      await expect(panel.locator('.select__item.is-active')).toBeFocused()
      const colors = await panel.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--material-bg)'
        probe.style.color = 'var(--accent)'
        element.append(probe)
        const expected = getComputedStyle(probe),
          check = element.querySelector('.select__check')
        if (!check) throw new Error('Missing selected-model indicator')
        const result = {
          background: getComputedStyle(element).backgroundColor,
          expectedBackground: expected.backgroundColor,
          check: getComputedStyle(check).color,
          expectedCheck: expected.color
        }
        probe.remove()
        return result
      })
      expect(colors.background).toBe(colors.expectedBackground)
      expect(colors.check).toBe(colors.expectedCheck)
      panelBackgrounds.push(colors.background)
      await page.screenshot({
        path: testInfo.outputPath(`work-model-${theme.appearance}.png`),
        animations: 'disabled'
      })
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await expect(modelSelect).toBeFocused()
      await modelSelect.click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).click()
      await expect(panel).toHaveCount(0)
    }
    expect(panelBackgrounds[0]).not.toBe(panelBackgrounds[1])
    await modelSelect.click()
    await expect(page.locator('.select__panel')).toBeVisible()
    // Keyboard activation bypasses outside mousedown: the hidden mode itself must close its portal.
    await codeMode().focus()
    await expect(page.locator('.select__panel')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(codeMode()).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await switchTo('work')
    await expect(modelSelect).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await modelSelect.click()
    await page.getByRole('menuitem', { name: '默认模型', exact: true }).click()
    await expect(modelSelect).toContainText('默认模型')
    await modelSelect.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.select__panel')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.select__panel')).toHaveCount(0)
    await expect(modelSelect).toContainText('Work alternate model')
    const prompt = `WORK_MODEL_SELECTION：${'连续无空格的长资料'.repeat(50)}`
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
    const previous = chatRequests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(previous + 1)
    const request = chatRequests[previous]
    expect(request).toMatchObject({ message: prompt, model: alternateModelId })
    frame(request.sessionId, {
      content: `WORK_LONG_REPLY：https://example.com/${'continuous-result-'.repeat(80)}`
    })
    await expect(work()).toContainText('WORK_LONG_REPLY')
    await expect(modelSelect).toBeDisabled()
    finish(request.sessionId)
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(940, 600))
    for (const role of ['user', 'assistant']) {
      const message = work().locator(`.work-message--${role}`)
      await expect(message).toBeVisible()
      const overflow = await message.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          horizontal: element.scrollWidth - element.clientWidth,
          viewport: Math.max(0, rect.right - innerWidth, -rect.left)
        }
      })
      expect(overflow.horizontal).toBeLessThanOrEqual(1)
      expect(overflow.viewport).toBeLessThanOrEqual(1)
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  })

  test('940px 窗口深浅主题内容不越界，标题栏保持原高度', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(940, 600))
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await expect(settings).toBeVisible()
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings
        .getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true })
        .click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(settings).toHaveCount(0)
      await expect(workMode()).toHaveAttribute('aria-selected', 'true')
      await expect
        .poll(() => work().evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1)
      const metrics = await page.evaluate(() => {
        const title = document.querySelector('.menubar') ?? document.querySelector('.menu-bar')
        const view = document.querySelector('.work-view')
        if (!title || !view) throw new Error('Missing application layout')
        return {
          titleHeight: title.getBoundingClientRect().height,
          right: view.getBoundingClientRect().right,
          viewport: innerWidth
        }
      })
      expect(metrics.titleHeight).toBeGreaterThanOrEqual(45)
      expect(metrics.titleHeight).toBeLessThanOrEqual(47)
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewport + 1)
      await page.screenshot({
        path: testInfo.outputPath(`work-${appearance}-940.png`),
        animations: 'disabled'
      })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  })

  test('五任务同时运行可反复切换，两个共享目录任务不串流，后台归档完成可导出与继续', async ({}, testInfo) => {
    const ids: string[] = []
    const cancelledBefore = cancellations.length
    for (let index = 0; index < 5; index++) {
      const id = await startTask(`WORK_STRESS_${index + 1}：并行整理独立资料`)
      ids.push(id)
      const value = session(id)
      // Model the workspace recorded by a remote engine after task admission:
      // two collaborators share a project, the other three use isolated roots.
      value.run!.workspacePaths = [index < 2 ? '/remote/work-stress-shared' : `/remote/work-stress-${index + 1}`]
      frame(id, { run: value.run })
      frame(id, { content: `STRESS_OWNER_${index + 1}` })
      await expect(work().locator('.work-conversation')).toContainText(`STRESS_OWNER_${index + 1}`)
    }
    expect(ids.every(id => session(id).run?.status === 'running')).toBe(true)
    expect(new Set(ids).size).toBe(5)
    expect(cancellations).toHaveLength(cancelledBefore)
    expect(session(ids[0]).run?.workspacePaths).toEqual(session(ids[1]).run?.workspacePaths)
    expect(new Set(ids.map(id => session(id).run?.workspacePaths[0])).size).toBe(4)

    for (let round = 0; round < 3; round++) {
      for (let index = ids.length - 1; index >= 0; index--) {
        await work().locator('.work-sidebar__task', { hasText: `WORK_STRESS_${index + 1}：` }).click()
        await expect(work().locator('.work-task-heading h1')).toContainText(`WORK_STRESS_${index + 1}`)
        frame(ids[index], { content: `\nSTRESS_ROUND_${round + 1}_OWNER_${index + 1}` })
        await expect(work().locator('.work-conversation')).toContainText(`STRESS_ROUND_${round + 1}_OWNER_${index + 1}`)
        await expect(runStatus()).toHaveAttribute('data-state', 'running')
        for (let other = 0; other < ids.length; other++) {
          if (index !== other) await expect(work().locator('.work-conversation')).not.toContainText(`STRESS_OWNER_${other + 1}`)
        }
      }
    }

    await work().locator('.work-task-heading').getByRole('button', { name: '重命名任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务名称', exact: true }).fill('WORK_STRESS_SHARED_RENAMED')
    await page.keyboard.press('Enter')
    await expect(work().locator('.work-task-heading h1')).toHaveText('WORK_STRESS_SHARED_RENAMED')
    await work().locator('.work-sidebar__task', { hasText: 'WORK_STRESS_4：' }).click()
    await work().locator('.work-task-heading').getByRole('button', { name: '重命名任务', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '任务名称', exact: true })).toHaveValue('WORK_STRESS_4：并行整理独立资料')
    await page.keyboard.press('Escape')
    await work().locator('.work-task-heading').getByRole('button', { name: '归档', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toBeVisible()
    expect(cancellations).toHaveLength(cancelledBefore)
    frame(ids[3], { content: '\nWORK_STRESS_ARCHIVED_FINAL' })
    finish(ids[3])
    expect(session(ids[3]).run?.status).toBe('succeeded')

    await work().locator('.work-sidebar__archived summary').click()
    const archived = work().locator('.work-sidebar__archived-row', { hasText: 'WORK_STRESS_4：' })
    await page.evaluate(() => {
      const original = URL.createObjectURL
      URL.createObjectURL = (blob: Blob): string => {
        void blob.text().then((text) => {
          ;(window as Window & { workExport?: string }).workExport = text
        })
        return original(blob)
      }
    })
    await archived.getByRole('button', { name: '导出', exact: true }).click()
    await expect.poll(() => page.evaluate(() => {
      const value = (window as Window & { workExport?: string }).workExport
      return Boolean(value)
    })).toBe(true)
    const exported = await page.evaluate(() => JSON.parse((window as Window & { workExport: string }).workExport))
    expect(exported.transcript.some((message: { content: string }) => message.content.includes('WORK_STRESS_ARCHIVED_FINAL'))).toBe(true)
    expect(exported.status).toBe('done')
    await archived.getByRole('button', { name: '恢复', exact: true }).click()
    await expect(work().locator('.work-sidebar__archived-row', { hasText: 'WORK_STRESS_4：' })).toHaveCount(0)

    await work().locator('.work-sidebar__task', { hasText: 'WORK_STRESS_2：' }).click()
    await work().locator('.work-task-heading').getByRole('button', { name: '停止任务', exact: true }).click()
    await expect.poll(() => cancellations.slice(cancelledBefore)).toEqual([ids[1]])
    expect(ids.filter((id, index) => index !== 1 && index !== 3).every(id => session(id).run?.status === 'running')).toBe(true)
    await work().locator('.work-task-heading').getByRole('button', { name: '继续任务', exact: true }).click()
    const continued = chatRequests.length
    await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('WORK_STRESS_CONTINUE')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(continued + 1)
    expect(chatRequests.at(-1)).toMatchObject({ sessionId: ids[1], workspacePaths: ['/remote/work-stress-shared'] })
    for (let index = 0; index < ids.length; index++) {
      if (index === 3) continue
      frame(ids[index], { content: `\nWORK_STRESS_COMPLETED_${index + 1}` })
      finish(ids[index])
    }
    await expect(work().locator('.work-task-heading')).toContainText('已完成')
    await expect(work().locator('.work-conversation')).toContainText('WORK_STRESS_COMPLETED_2')
    await page.reload()
    await expect(work().locator('.work-conversation')).toContainText('WORK_STRESS_COMPLETED_2')
    expect(errors).toEqual([])
  })

  test('Work 复用对话偏好，记忆和思考选择进入真实请求且跨刷新保留', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '对话偏好', exact: true }).click()
    await page.getByTitle('选择思考档位', { exact: true }).click()
    await page.getByRole('menuitem', { name: /^Off/ }).click()
    await expect(page.locator('.composer-options__dd-menu:visible')).toHaveCount(0)
    await page.getByTitle('选择长期记忆范围', { exact: true }).click()
    await page.getByRole('menuitem', { name: /^全局记忆/ }).click()
    await expect.poll(() => [...memoryScopes.values()].includes('global')).toBe(true)
    await expect(page.locator('.composer-options__dd-menu:visible')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_PREFERENCES')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.at(-1)?.message).toBe('WORK_PREFERENCES')
    const id = chatRequests.at(-1)!.sessionId
    expect(chatRequests.at(-1)).toMatchObject({ thinkingMode: false, memoryScope: 'global' })
    frame(id, { content: 'WORK_PREFERENCES_OK' }); finish(id)
    await expect(runStatus()).toHaveCount(0)
    await page.reload()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
    await work().getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(page.getByTitle('选择思考档位', { exact: true })).toHaveText(/Off/)
    await expect(page.getByTitle('选择长期记忆范围', { exact: true })).toHaveText(/全局记忆/)
    await page.keyboard.press('Escape')
  })

  test('Agent 独立管理页支持模型、温度与技能/MCP/知识库/工具绑定，保存后可恢复并参与任务', async () => {
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '新建 Agent', exact: true }).click()
    await page.getByLabel('名称', { exact: true }).fill('独立配置 Agent')
    await page.getByLabel('用途', { exact: true }).fill('验证完整资源绑定')
    await page.getByLabel('工作指令', { exact: true }).fill('使用绑定的资源完成任务。')
    await page.getByLabel('温度', { exact: true }).fill('0.7')
    await page.getByRole('button', { name: 'Agent 默认模型', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Work fixture model', exact: true }).click()

    const group = (title: string) => page.locator('fieldset.work-agent-manager__binding').filter({ has: page.locator('legend', { hasText: title }) })
    await group('技能').getByRole('checkbox').first().check()
    await group('MCP 服务').getByRole('checkbox').first().check()
    await group('知识库').getByRole('checkbox').first().check()
    await group('工具权限').getByRole('checkbox').nth(1).check()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.size).toBeGreaterThan(0)
    const id = [...fixtureAgents.entries()].find(([, value]) => value.name === '独立配置 Agent')?.[0]
    expect(id).toBeTruthy()
    expect(fixtureAgents.get(id!) ).toMatchObject({
      temperature: 0.7,
      skills: ['skill-review'],
      mcpServers: ['mcp-git'],
      knowledgeBases: ['kb-product'],
      allowedTools: ['write_file']
    })

    await page.getByRole('button', { name: '编辑 Agent 独立配置 Agent', exact: true }).click()
    await expect(group('技能').getByRole('checkbox').first()).toBeChecked()
    await expect(group('MCP 服务').getByRole('checkbox').first()).toBeChecked()
    await expect(group('知识库').getByRole('checkbox').first()).toBeChecked()
    await expect(group('工具权限').getByRole('checkbox').nth(1)).toBeChecked()
    // Unbinding is explicit and survives a second save; it must not be hidden
    // behind a failed resource catalogue request.
    await group('技能').getByRole('checkbox').first().uncheck()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.get(id!)?.skills).toEqual([])

    await page.getByRole('button', { name: '使用 Agent 独立配置 Agent', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('AGENT_RESOURCE_REQUEST')
    const previous = chatRequests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(previous + 1)
    const request = chatRequests.at(-1)!
    expect(request.agentId).toBe(id)
    expect(request.skills).toBeUndefined()
    // Agent bindings are resolved by the engine from agentId. Work must leave
    // these request-level overrides undefined so an empty composer resource
    // list cannot erase the persisted Agent configuration.
    expect(request.mcpServers).toBeUndefined()
    expect(request.knowledgeBases).toBeUndefined()
    expect(request.allowedTools).toBeUndefined()
    frame(request.sessionId, { content: 'AGENT_RESOURCE_REQUEST_OK' }); finish(request.sessionId)
    await expect(runStatus()).toHaveCount(0)
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: '删除 Agent 独立配置 Agent', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect.poll(() => fixtureAgents.has(id!)).toBe(false)
  })

  test('Agent 可创建编辑选择和删除，首次发送后绑定固定且保留隐藏资源配置', async ({}, testInfo) => {
    // Each serial test owns its starting surface; previous cases may end on Code
    // after a reload or settings check.
    await switchTo('work')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await page.getByRole('button', { name: '新建 Agent', exact: true }).click()
    await page.getByLabel('名称', { exact: true }).fill('Work review agent')
    await page.getByLabel('用途', { exact: true }).fill('审查实现与边界')
    await page.getByLabel('工作指令', { exact: true }).fill('阅读文件并检查测试，给出具体反馈。')
    // Agent 编辑弹窗中的 Select 也是 portal 浮层；它必须压在 modal-overlay
    // 之上，否则菜单会被遮罩盖住，看起来像是"跑到后面"。
    await page.getByRole('button', { name: 'Agent 默认模型', exact: true }).click()
    const agentModelMenu = page.locator('.popover__panel.work-agent-manager__model-panel')
    await expect(agentModelMenu).toBeVisible()
    const layerOrder = await agentModelMenu.evaluate((menu) => {
      const overlay = document.querySelector<HTMLElement>('.modal-overlay')
      return {
        menuZ: Number.parseInt(getComputedStyle(menu).zIndex || '0', 10),
        overlayZ: Number.parseInt(overlay ? getComputedStyle(overlay).zIndex || '0' : '0', 10)
      }
    })
    expect(layerOrder.menuZ).toBeGreaterThan(layerOrder.overlayZ)
    await page.screenshot({ path: testInfo.outputPath('work-agent-model-menu-layer.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.size).toBe(1)
    const id = [...fixtureAgents.keys()][0]
    expect(fixtureAgents.get(id)?.systemPrompt).toBe('阅读文件并检查测试，给出具体反馈。')
    await page.getByRole('button', { name: '编辑 Agent Work review agent', exact: true }).click()
    await page.getByLabel('名称', { exact: true }).fill('Work persistent reviewer')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => fixtureAgents.get(id)?.name).toBe('Work persistent reviewer')
    expect(fixtureAgents.get(id)).toMatchObject({ allowedTools: ['read_file'], skills: ['keep-existing-skill'] })
    for (const appearance of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(860, 720))
      const metrics = await page.locator('.work-agent-manager').evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right, bottom: bounds.bottom, width: innerWidth, height: innerHeight, overflow: element.scrollWidth > element.clientWidth + 1 }
      })
      expect(metrics.left).toBeGreaterThanOrEqual(0)
      expect(metrics.right).toBeLessThanOrEqual(metrics.width)
      expect(metrics.bottom).toBeLessThanOrEqual(metrics.height)
      expect(metrics.overflow).toBe(false)
      await page.screenshot({ path: testInfo.outputPath(`work-agents-${appearance}-860.png`), animations: 'disabled' })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await page.getByRole('button', { name: '使用 Agent Work persistent reviewer', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_AGENT_BOUND')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chatRequests.at(-1)?.message).toBe('WORK_AGENT_BOUND')
    expect(chatRequests.at(-1)?.agentId).toBe(id)
    const task = chatRequests.at(-1)!.sessionId
    frame(task, { content: 'WORK_AGENT_BOUND_OK' }); finish(task)
    await expect(runStatus()).toHaveCount(0)
    await page.reload()
    await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await expect(page.getByRole('button', { name: '使用 Agent Work persistent reviewer', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '删除 Agent Work persistent reviewer', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await page.getByRole('button', { name: '删除 Agent Work persistent reviewer', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect.poll(() => fixtureAgents.size).toBe(0)
    await page.getByRole('button', { name: '完成', exact: true }).click()
  })

  test('Agent 在 Work 一级页面提供独立的增删改查入口', async () => {
    await switchTo('work')
    await work().getByRole('button', { name: 'Agent', exact: true }).click()
    const pageSurface = work().locator('.work-agent-manager-page')
    await expect(pageSurface.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
    await expect(pageSurface.getByRole('button', { name: '新建 Agent', exact: true })).toBeVisible()
    await pageSurface.getByRole('button', { name: '新建 Agent', exact: true }).click()
    await expect(pageSurface.getByLabel('名称', { exact: true })).toBeVisible()
    await expect(pageSurface.locator('legend').filter({ hasText: 'MCP 服务' })).toBeVisible()
    await expect(pageSurface.locator('legend').filter({ hasText: '知识库' })).toBeVisible()
    await expect(pageSurface.locator('legend').filter({ hasText: '工具权限' })).toBeVisible()
    await pageSurface.getByRole('button', { name: '取消', exact: true }).click()
    await expect(pageSurface.getByRole('button', { name: '新建 Agent', exact: true })).toBeEnabled()
  })

  test('润色期间切换任务可再次润色，旧回复不能覆盖新任务草稿', async () => {
    const original = await startTask('WORK_POLISH_ORIGINAL')
    frame(original, { content: 'WORK_POLISH_READY' }); finish(original)
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('旧任务的草稿')
    const before = utilityRequests.length
    await work().getByRole('button', { name: 'AI 润色', exact: true }).click()
    await expect.poll(() => utilityRequests.length).toBe(before + 1)
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const homeInput = work().getByRole('textbox', { name: '任务目标', exact: true })
    await homeInput.fill('新任务的草稿')
    await expect(work().getByRole('button', { name: 'AI 润色', exact: true })).toBeEnabled()
    utilityRequests[before].response.setHeader('content-type', 'application/json')
    utilityRequests[before].response.end(envelope({ text: '不该覆盖的新文本' }))
    await work().getByRole('button', { name: 'AI 润色', exact: true }).click()
    await expect.poll(() => utilityRequests.length).toBe(before + 2)
    expect(utilityRequests[before + 1].body.userPrompt).toBe('新任务的草稿')
    utilityRequests[before + 1].response.setHeader('content-type', 'application/json')
    utilityRequests[before + 1].response.end(envelope({ text: '新任务的润色结果' }))
    await expect(homeInput).toHaveText('新任务的润色结果')
  })

  test('快速切换以最后一次选择为准，减少动态效果时不运行过渡', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('tablist', { name: '应用模式', exact: true }).evaluate((element) => {
      const buttons = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
      for (let index = 0; index < 10; index++) buttons[index % 2].click()
      buttons.find((button) => button.textContent?.includes('Work'))?.click()
    })
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.mode-surface[data-mode="code"]')).toBeHidden()
    expect(
      await work().evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === 'running').length
      )
    ).toBe(0)
    await codeMode().focus()
    await page.keyboard.press('ArrowRight')
    await expect(workMode()).toBeFocused()
    await expect(workMode()).toHaveAttribute('aria-selected', 'true')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(errors).toEqual([])
  })
})
