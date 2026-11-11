/** Real Electron + isolated authenticated HTTP fixture: Agent management and
 * selection, complete saved configuration, missing bindings, default tool
 * permissions, templates and temperature validation, category tri-state and
 * filtered selection, independent detail actions, guarded cancellation, locked tasks,
 * and bounded light/dark/narrow layouts. Does not call an actual model. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { WorkState, WorkTask } from '../src/renderer/src/contrib/work/work-state'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { WORK_AGENT_TEMPLATES, type WorkAgentTemplate } from '../src/renderer/src/contrib/work/work-agent-templates'

interface AgentConfig {
  id: string; name: string; description: string; systemPrompt: string; model: string; temperature?: number
  skills: string[]; mcpServers: string[]; knowledgeBases: string[]; allowedTools: string[]
}
type AgentPayload = Omit<AgentConfig, 'id'>
const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'disposable-agent-manager-ui-token', modelId = 'agent-manager-model', workspace = 'D:\\fixtures\\agent-manager'
const alpha: AgentConfig = { id: 'agent-review', name: '资料审阅助手', description: '检查来源、结论与交付材料',
  systemPrompt: '逐项核对事实。\n保留来源并标明尚未核实的信息。', model: modelId, temperature: 0.4,
  skills: ['文档审阅', 'missing-skill'], mcpServers: ['mcp-docs', 'missing-mcp'],
  knowledgeBases: ['kb-team', 'missing-knowledge'], allowedTools: ['read_file', 'legacy_tool'] }
const beta: AgentConfig = { id: 'agent-writer', name: '项目写作助手', description: '撰写简洁清晰的客户说明',
  systemPrompt: '以事实和可验证结果组织内容。', model: '', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['read_file'] }
const initialAgents: AgentConfig[] = [alpha, beta, ...Array.from({ length: 36 }, (_, index) => ({ ...beta,
  id: `agent-catalog-${index}`, name: `工作助手 ${String(index + 1).padStart(2, '0')}`,
  description: `处理第 ${index + 1} 类资料。保留完整内容并按统一标准检查交付质量。` }))]
const longDescription = '执行受控命令前检查工作目录和参数。'.repeat(100) + '完整说明结尾：不得遗漏确认执行结果。'
const tools = [
  { name: 'read_file', displayName: '读取文件', description: '读取指定文件的内容。', defaultEnabled: true },
  { name: 'write_file', displayName: '写入文件', description: '将确认后的内容保存到文件。' },
  { name: 'run_command', displayName: '运行命令', description: longDescription, defaultEnabled: false },
  { name: 'plan_update', displayName: '内部计划控制', description: '不应出现在权限选择中。', defaultEnabled: true },
  ...(['list', 'get', 'create', 'update', 'delete'] as const).map((operation, index) => ({ name: `agent_${operation}`,
    displayName: ['列出 Agent', '读取 Agent', '创建 Agent', '更新 Agent', '删除 Agent'][index],
    description: `管理自定义助手的${['列表', '读取', '创建', '更新', '删除'][index]}操作。`, defaultEnabled: false })),
  ...Array.from({ length: 55 }, (_, index) => ({ name: `optional_tool_${index}`, displayName: `扩展工具 ${String(index + 1).padStart(2, '0')}`,
    description: `用于检查第 ${index + 1} 类文档的内容和结构。`, defaultEnabled: false })),
]
const skills = [
  { id: 'skill-path-hash', name: '文档审阅', description: '按来源检查文档。', enabled: true },
  { id: 'skill-path-hash-2', name: '报告写作', description: '整理报告结构和内容。', enabled: true },
  { id: 'skill-disabled', name: '停用技能', description: '不应可选', enabled: false },
]
const mcpServers = [{ id: 'mcp-docs', name: '团队文档', description: '读取团队文档资料', enabled: true }]
const knowledgeBases = [{ id: 'kb-team', name: '团队知识库', description: '已核实的团队知识', documentCount: 12, createdAt: 1 }]
let agents = structuredClone(initialAgents), seededTask: WorkTask | null = null
const mutations: Array<{ method: string; id: string; body: unknown }> = [], errors: string[] = [], forbidden: string[] = []
const workspaceBindings: Array<{ sessionId: string; workspaceRoot: string }> = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function payload(value: unknown): AgentPayload {
  if (!record(value) || !['name', 'description', 'systemPrompt', 'model'].every(key => typeof value[key] === 'string') ||
    !['skills', 'mcpServers', 'knowledgeBases', 'allowedTools'].every(key => Array.isArray(value[key]) && value[key].every(item => typeof item === 'string')) ||
    value.temperature !== undefined && typeof value.temperature !== 'number') throw new Error('Incomplete Agent configuration payload')
  return value as AgentPayload
}
function currentRun(id: string): RootRun | null {
  if (seededTask?.id !== id) return null
  return { schemaVersion: 1, runId: `run-${id}`, sessionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}`,
    assistantMessageId: `assistant-${id}`, seq: 1, version: 2, status: 'succeeded', modelId, pending: [],
    workspacePaths: [workspace], createdAt: seededTask.createdAt, updatedAt: seededTask.updatedAt,
    startedAt: seededTask.createdAt, finishedAt: seededTask.updatedAt }
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body: unknown = raw ? JSON.parse(raw) : null
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated request: ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  // The remote Code workspace bootstraps before Work is selected; both modes
  // may bind only the directory owned by this disposable fixture.
  if (request.method === 'POST' && path === '/api/v1/workspace/bind') {
    if (!record(body) || typeof body.sessionId !== 'string' || !body.sessionId.trim() || body.workspaceRoot !== workspace ||
      Object.keys(body).some(key => key !== 'sessionId' && key !== 'workspaceRoot'))
      throw new Error(`Invalid fixture workspace binding: ${JSON.stringify(body)}`)
    workspaceBindings.push({ sessionId: body.sessionId, workspaceRoot: workspace })
    response.end(envelope({ workspaceRoot: workspace, bindingEpoch: 'one', contractVersion: 2 })); return
  }
  const agentPath = /^\/api\/v1\/agents(?:\/([^/]+))?$/.exec(path)
  if (agentPath) {
    const target = agentPath[1] ? decodeURIComponent(agentPath[1]) : ''
    if (request.method === 'GET') { response.end(envelope(target ? agents.find(agent => agent.id === target) : agents)); return }
    if (request.method === 'POST' && !target) {
      const next = { ...payload(body), id: `created-agent-${mutations.length + 1}` }
      agents.push(next); mutations.push({ method: 'POST', id: next.id, body }); response.end(envelope(next)); return
    }
    if (request.method === 'PUT' && agents.some(agent => agent.id === target)) {
      const next = { ...payload(body), id: target }
      agents = agents.map(agent => agent.id === target ? next : agent)
      mutations.push({ method: 'PUT', id: target, body }); response.end(envelope(next)); return
    }
    if (request.method === 'DELETE' && agents.some(agent => agent.id === target) && body === null) {
      agents = agents.filter(agent => agent.id !== target); mutations.push({ method: 'DELETE', id: target, body })
      response.end(envelope({ success: true })); return
    }
    throw new Error(`Invalid Agent mutation: ${request.method} ${path}`)
  }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Unexpected mutation: ${path}`) }
  const current = currentRun(id), rows = current ? [
    { id: current.userMessageId, role: 'user', content: seededTask!.title, createdAt: current.createdAt, conversationId: current.turnId, metadata: { rootRunId: current.runId } },
    { id: current.assistantMessageId, role: 'assistant', content: '已完成资料审阅。', createdAt: current.updatedAt, conversationId: current.turnId, metadata: { rootRunId: current.runId } },
  ] : []
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'agent-manager-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '配置测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/tools' ? tools
    : path === '/api/v1/skills' ? { list: skills }
    : path === '/api/v1/mcp/servers' ? mcpServers
    : path === '/api/v1/knowledge/bases' ? knowledgeBases
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: current ? [{ userMessageId: current.userMessageId, conversationId: current.turnId, preview: seededTask!.title, createdAt: current.createdAt }] : [], messages: rows,
      loadedTurnIds: current ? [current.userMessageId] : [], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'agent-manager-fixture', sessionId: id,
      namespace: { id: 'agent-manager-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(current), agentId: current ? alpha.id : null, metadata: null, agent: current ? alpha : null }
    : path === '/api/v1/memory/settings' ? { sessionId: id, memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('Agent manager fixture failed') }) })

const manager = (): Locator => page.locator('.work-agent-manager-page')
const form = (): Locator => page.locator('.work-agent-manager__form')
const state = (): Promise<WorkState> => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}') as WorkState, storageKey)
const tab = (name: string): Locator => form().getByRole('tab', { name: new RegExp(`^${name}`) })
const checkbox = (name: string): Locator => form().getByRole('checkbox', { name, exact: true })
const temperature = (): Locator => form().getByRole('spinbutton', { name: '温度', exact: true })
const templateSelector = (): Locator => form().getByRole('button', { name: 'Agent 模板', exact: true })
async function chooseTemplate(label: string): Promise<void> {
  await templateSelector().click()
  await page.locator('.work-agent-manager__template-panel').getByRole('menuitem', { name: new RegExp(`^${label}(?:\\s|$)`) }).click()
}
async function assertTemplate(template: WorkAgentTemplate): Promise<void> {
  await expect(templateSelector()).toContainText(template.label)
  await expect(form().getByLabel('名称', { exact: true })).toHaveValue(template.name)
  await expect(form().getByLabel('用途', { exact: true })).toHaveValue(template.description)
  await expect(form().getByRole('textbox', { name: '工作指令', exact: true })).toHaveValue(template.systemPrompt)
  await expect(temperature()).toHaveValue(template.temperature)
}
async function selectToolCategory(group: string): Promise<void> {
  const button = form().getByRole('button', { name: `${group}工具分类`, exact: true })
  await expect(button).toBeVisible()
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(form().getByRole('region', { name: `${group}工具列表`, exact: true })).toBeVisible()
}
async function assertSemanticButtonStates(button: Locator, kind: 'primary' | 'danger'): Promise<void> {
  const assertState = async (state: 'hover' | 'pressed'): Promise<void> => {
    const background = kind === 'primary' ? state === 'hover' ? '--accent-hover' : '--accent'
      : state === 'hover' ? '--danger-hover' : '--danger-active'
    const color = kind === 'primary' ? '--accent-fg' : '--danger-contrast'
    await expect.poll(() => button.evaluate((element, tokens) => {
      const probe = document.createElement('span'); element.parentElement!.append(probe)
      probe.style.backgroundColor = `var(${tokens.background})`; probe.style.color = `var(${tokens.color})`
      probe.style.borderTopColor = `var(${tokens.background})`
      const expected = getComputedStyle(probe), actual = getComputedStyle(element)
      const result = actual.backgroundColor === expected.backgroundColor && actual.color === expected.color &&
        actual.borderTopColor === expected.borderTopColor && actual.filter === 'none'
      probe.remove(); return result
    }, { background, color }), { message: `${kind} ${state} retains button colors` }).toBe(true)
  }
  await button.hover(); await assertState('hover'); await page.mouse.down()
  try { await assertState('pressed') } finally {
    // Release away from the target: inspect its pressed state without invoking
    // the save/delete operation before the test's existing explicit click.
    await page.mouse.move(10, 80); await page.mouse.up()
  }
}
async function seed(options: { locked?: boolean; page?: 'agents' | 'home'; selectedId?: string } = {}): Promise<void> {
  const timestamp = Date.now() - 60_000
  seededTask = options.locked ? { id: 'work-agent-locked', title: '已启动且固定 Agent 的任务', status: 'done', agentId: alpha.id,
    agentLocked: true, workspacePath: workspace, createdAt: timestamp, updatedAt: timestamp, draft: '', modelId, attachments: [], sources: [] } : null
  await page.evaluate(({ storageKey, task, selectedId, destination, workspace }) => {
    localStorage.setItem(storageKey, JSON.stringify({ tasks: task ? [task] : [], activeTaskId: task?.id ?? null,
      homeDraft: '', homeWorkspacePath: workspace, homeAgentId: selectedId ?? '' }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: destination, collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { storageKey, task: seededTask, selectedId: options.selectedId, destination: options.page ?? 'agents', workspace })
  await page.reload(); await expect(page.locator('.work-sidebar')).toContainText('引擎已连接')
  if ((options.page ?? 'agents') === 'agents') await expect(manager().getByRole('button', { name: `编辑 Agent ${alpha.name}`, exact: true })).toBeVisible()
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function appearance(value: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: value === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', value)
  await settings.getByRole('button', { name: '关闭', exact: true }).click(); await expect(settings).toHaveCount(0)
}
async function shot(name: string): Promise<void> {
  await page.evaluate(async () => {
    let timeout = 0
    try {
      await Promise.race([
        (async () => {
          // Presence transitions may start on the frame after a reload or tab
          // switch. Wait for actual finite animations, including follow-on ones.
          for (let pass = 0; pass < 10; pass++) {
            await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
            const animations = document.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') &&
              Number.isFinite(animation.effect?.getComputedTiming().endTime))
            if (!animations.length) return
            await Promise.allSettled(animations.map(animation => animation.finished))
          }
          throw new Error('Agent layout kept starting finite transitions')
        })(),
        new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Agent layout did not settle within 5 seconds')), 5_000) }),
      ])
    } finally { window.clearTimeout(timeout) }
  })
  const path = test.info().outputPath(`${name}.png`); await page.screenshot({ path })
  await test.info().attach(name, { path, contentType: 'image/png' })
}
async function edit(agent: AgentConfig): Promise<void> {
  await manager().getByRole('button', { name: `编辑 Agent ${agent.name}`, exact: true }).click()
  await expect(form().getByLabel('名称', { exact: true })).toHaveValue(agent.name)
}

test.describe.serial('Work Agent 管理', () => {
  test.beforeAll(async () => {
    const consoleErrors: Array<{ text: string; location: { url: string; lineNumber: number; columnNumber: number } }> = []
    const failedRequests: Array<{ url: string; method: string; error: string | null }> = []
    let stderrTail = ''
    try {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-agent-manager-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    storageKey = sessionStorageKey('aether.work.state.v1', source)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: workspace, autoStartEngine: true, lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    app.process().stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-16_000) })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    page.on('console', message => {
      if (message.type() !== 'error') return
      consoleErrors.push({ text: message.text(), location: message.location() })
      if (consoleErrors.length > 80) consoleErrors.shift()
    })
    page.on('requestfailed', request => {
      failedRequests.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText ?? null })
      if (failedRequests.length > 80) failedRequests.shift()
    })
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 1000); win.show(); win.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    } catch (cause) {
      const diagnostics: Record<string, unknown> = { error: cause instanceof Error ? cause.stack : String(cause),
        url: page?.url() ?? null, closed: page?.isClosed() ?? null, pageErrors: [...errors], consoleErrors, failedRequests, stderrTail }
      if (page && !page.isClosed()) {
        diagnostics.body = await page.locator('body').innerText({ timeout: 2_000 }).then(text => text.slice(0, 16_000)).catch(error => `Unreadable body: ${String(error)}`)
        diagnostics.html = await page.locator('html').innerHTML({ timeout: 2_000 }).then(text => text.slice(0, 24_000)).catch(error => `Unreadable HTML: ${String(error)}`)
        try {
          const path = test.info().outputPath('agent-startup-failure.png')
          await page.screenshot({ path, timeout: 5_000 })
          await test.info().attach('agent-startup-failure', { path, contentType: 'image/png' })
        } catch (error) { diagnostics.screenshotError = String(error) }
      }
      await test.info().attach('agent-startup-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' }).catch(() => undefined)
      throw cause
    }
  })
  test.beforeEach(async () => { agents = structuredClone(initialAgents); mutations.length = 0; await setWindow(1440, 1000); await seed() })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) await shot('agent-manager')
    await info.attach('agent-fixture-requests', { body: JSON.stringify({ errors, forbidden, mutations, workspaceBindings }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(forbidden).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-agent-manager-profile-')) throw new Error('Unsafe Agent fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('连续列表可搜索，主行编辑和右侧选用互不误触', async () => {
    const search = manager().getByRole('textbox', { name: '搜索 Agent', exact: true })
    await search.fill('客户说明')
    await expect(manager().getByRole('button', { name: `编辑 Agent ${beta.name}`, exact: true })).toHaveCount(1)
    await expect(manager().getByRole('button', { name: `编辑 Agent ${alpha.name}`, exact: true })).toHaveCount(0)
    await edit(beta); expect((await state()).homeAgentId).toBe(''); expect(mutations).toEqual([])
    await expect(templateSelector()).toHaveCount(0)
    await form().getByLabel('名称', { exact: true }).fill('临时修改后将恢复')
    await form().getByLabel('名称', { exact: true }).fill(beta.name)
    await page.getByRole('button', { name: '返回 Agent 列表', exact: true }).click(); await expect(form()).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '放弃修改？', exact: true })).toHaveCount(0)
    await search.fill(''); await manager().getByRole('button', { name: `使用 Agent ${alpha.name}`, exact: true }).click()
    await expect(manager()).toHaveCount(0)
    await expect.poll(async () => (await state()).homeAgentId).toBe(alpha.id)
    expect(mutations).toEqual([])
  })

  test('新建 Agent 保留引擎默认工具并提交完整配置和资源标识', async () => {
    await manager().getByRole('button', { name: '新建 Agent', exact: true }).click()
    const expected: AgentPayload = { name: '交付检查助手', description: '核对客户交付', systemPrompt: '按清单逐项核对。\n保留原文缩进与换行。',
      model: modelId, temperature: 0.7, skills: ['报告写作'], mcpServers: ['mcp-docs'], knowledgeBases: ['kb-team'],
      allowedTools: ['read_file', 'write_file', 'run_command'] }
    await form().getByLabel('名称', { exact: true }).fill(expected.name)
    await form().getByLabel('用途', { exact: true }).fill(expected.description)
    await form().getByRole('textbox', { name: '工作指令', exact: true }).fill(expected.systemPrompt)
    await temperature().fill('0.7')
    await form().getByRole('button', { name: 'Agent 默认模型', exact: true }).click()
    await page.getByRole('menuitem', { name: '配置测试模型', exact: true }).click()
    await shot('agent-create-basics')
    await tab('资源绑定').click(); await checkbox('报告写作').check(); await expect(checkbox('停用技能')).toHaveCount(0)
    await shot('agent-create-resources')
    await form().getByRole('button', { name: /^MCP 服务/ }).click(); await checkbox('团队文档').check()
    await form().getByRole('button', { name: /^知识库/ }).click(); await checkbox('团队知识库').check()
    await tab('工具权限').click(); await selectToolCategory('文件与搜索')
    await expect(checkbox('读取文件')).toBeChecked(); await expect(checkbox('写入文件')).toBeChecked()
    await selectToolCategory('终端命令')
    await expect(checkbox('运行命令')).not.toBeChecked(); await expect(checkbox('内部计划控制')).toHaveCount(0)
    await checkbox('运行命令').check()
    await form().getByRole('button', { name: '使用默认助手工具', exact: true }).click()
    await selectToolCategory('文件与搜索')
    await expect(checkbox('读取文件')).toBeChecked(); await expect(checkbox('写入文件')).toBeChecked()
    await selectToolCategory('终端命令')
    await expect(checkbox('运行命令')).not.toBeChecked()
    await checkbox('运行命令').check()
    await assertSemanticButtonStates(page.getByRole('button', { name: '保存 Agent', exact: true }), 'primary')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => mutations.length).toBe(1)
    expect(mutations[0]).toEqual({ method: 'POST', id: 'created-agent-1', body: expected })
    expect(agents.find(agent => agent.id === 'created-agent-1')).toEqual({ ...expected, id: 'created-agent-1' })
    await expect(form()).toHaveCount(0); await page.reload()
    await expect(manager().getByRole('button', { name: `编辑 Agent ${expected.name}`, exact: true })).toBeVisible()
  })

  test('五种场景模板填充完整内容，直接切回空白不提交或触发多余确认', async () => {
    await manager().getByRole('button', { name: '新建 Agent', exact: true }).click()
    await assertTemplate(WORK_AGENT_TEMPLATES[0])
    const labels = ['软件开发工程师', '项目经理', '研究分析师', '办公文档助手', '内容策划']
    expect(WORK_AGENT_TEMPLATES.map(template => template.label)).toEqual(['空白 Agent', ...labels])
    for (const label of labels) {
      const template = WORK_AGENT_TEMPLATES.find(item => item.label === label)!
      expect(template.systemPrompt.length).toBeGreaterThan(300)
      expect(template.systemPrompt).toMatch(/1\.[\s\S]+5\./)
      await chooseTemplate(label); await assertTemplate(template)
      await expect(page.getByRole('dialog', { name: '替换模板内容？', exact: true })).toHaveCount(0)
      expect(mutations).toEqual([])
    }
    await shot('agent-template-basics')
    await chooseTemplate('空白 Agent'); await assertTemplate(WORK_AGENT_TEMPLATES[0])
    await expect(page.getByRole('dialog', { name: '替换模板内容？', exact: true })).toHaveCount(0)
    expect(mutations).toEqual([]); expect(agents).toEqual(initialAgents)
    await page.getByRole('button', { name: '返回 Agent 列表', exact: true }).click()
    await expect(form()).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '放弃修改？', exact: true })).toHaveCount(0)
  })

  test('模板替换需确认修改，取消保留草稿，确认后保留模型资源工具并完整保存', async () => {
    await manager().getByRole('button', { name: '新建 Agent', exact: true }).click()
    await chooseTemplate('软件开发工程师')
    await form().getByRole('button', { name: 'Agent 默认模型', exact: true }).click()
    await page.getByRole('menuitem', { name: '配置测试模型', exact: true }).click()
    await tab('资源绑定').click(); await checkbox('报告写作').check()
    await form().getByRole('button', { name: /^MCP 服务/ }).click(); await checkbox('团队文档').check()
    await form().getByRole('button', { name: /^知识库/ }).click(); await checkbox('团队知识库').check()
    await tab('工具权限').click(); await selectToolCategory('文件与搜索')
    await expect(checkbox('读取文件')).toBeChecked(); await expect(checkbox('写入文件')).toBeChecked()
    await selectToolCategory('终端命令')
    await checkbox('运行命令').check()
    await tab('基础配置').click()
    const edited = { name: '保留我的自定义名称', description: '保留我的自定义用途', systemPrompt: '保留我的完整指令。\n第二段不能丢失。', temperature: '0.9' }
    await form().getByLabel('名称', { exact: true }).fill(edited.name)
    await form().getByLabel('用途', { exact: true }).fill(edited.description)
    await form().getByRole('textbox', { name: '工作指令', exact: true }).fill(edited.systemPrompt)
    await temperature().fill(edited.temperature)
    await chooseTemplate('软件开发工程师')
    const confirmation = page.getByRole('dialog', { name: '替换模板内容？', exact: true })
    await expect(confirmation).toHaveCount(0)
    await assertTemplate({ id: 'software-engineer', label: '软件开发工程师', ...edited })
    await chooseTemplate('研究分析师'); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await assertTemplate({ id: 'software-engineer', label: '软件开发工程师', ...edited })
    expect(mutations).toEqual([])
    await chooseTemplate('研究分析师'); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '替换内容', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    const template = WORK_AGENT_TEMPLATES.find(item => item.id === 'research-analyst')!
    await assertTemplate(template)
    await expect(form().getByRole('button', { name: 'Agent 默认模型', exact: true })).toContainText('配置测试模型')
    await tab('资源绑定').click(); await form().getByRole('button', { name: /^技能/ }).click()
    await expect(checkbox('报告写作')).toBeChecked()
    await form().getByRole('button', { name: /^MCP 服务/ }).click(); await expect(checkbox('团队文档')).toBeChecked()
    await form().getByRole('button', { name: /^知识库/ }).click(); await expect(checkbox('团队知识库')).toBeChecked()
    await tab('工具权限').click(); await selectToolCategory('文件与搜索')
    for (const name of ['读取文件', '写入文件']) await expect(checkbox(name)).toBeChecked()
    await selectToolCategory('终端命令'); await expect(checkbox('运行命令')).toBeChecked()
    expect(mutations).toEqual([])
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    const expected: AgentPayload = { name: template.name, description: template.description, systemPrompt: template.systemPrompt,
      temperature: Number(template.temperature), model: modelId, skills: ['报告写作'], mcpServers: ['mcp-docs'], knowledgeBases: ['kb-team'],
      allowedTools: ['read_file', 'write_file', 'run_command'] }
    await expect.poll(() => mutations).toEqual([{ method: 'POST', id: 'created-agent-1', body: expected }])
    expect(agents.find(agent => agent.id === 'created-agent-1')).toEqual({ id: 'created-agent-1', ...expected })
  })

  for (const value of [0, 0.35]) test(`温度 ${value} 可通过${value === 0 ? '保存按钮' : 'Ctrl+S'}提交，保留完整 Agent 配置`, async () => {
    await edit(beta); await temperature().fill(String(value))
    if (value === 0) await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    else await temperature().press('Control+s')
    const { id, ...original } = beta
    await expect.poll(() => mutations).toEqual([{ method: 'PUT', id, body: { ...original, temperature: value } }])
    expect(agents.find(agent => agent.id === id)).toEqual({ ...beta, temperature: value })
    await expect(form()).toHaveCount(0)
  })

  test('温度超过 2 时显示有效范围并阻止写入', async () => {
    await edit(beta); await temperature().fill('2.01')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect(manager().getByRole('alert')).toContainText('温度必须是 0 到 2 之间的数字')
    await expect(temperature()).toHaveValue('2.01')
    expect(mutations).toEqual([]); expect(agents.find(agent => agent.id === beta.id)).toEqual(beta)
  })

  test('编辑保留缺失资源，取消和返回确认不会悄悄丢失配置', async () => {
    await edit(alpha)
    await form().getByLabel('名称', { exact: true }).fill('资料审阅助手 · 更新')
    await tab('资源绑定').click(); await expect(checkbox('missing-skill')).toBeChecked()
    await form().getByRole('button', { name: /^MCP 服务/ }).click(); await expect(checkbox('missing-mcp')).toBeChecked()
    await form().getByRole('button', { name: /^知识库/ }).click(); await expect(checkbox('missing-knowledge')).toBeChecked()
    await tab('工具权限').click(); await selectToolCategory('其它工具'); await expect(checkbox('legacy_tool')).toBeChecked()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    const discard = page.getByRole('dialog', { name: '放弃修改？', exact: true })
    await expect(discard).toBeVisible(); await discard.getByRole('button', { name: '取消', exact: true }).click()
    await expect(discard).toHaveCount(0); await expect(checkbox('legacy_tool')).toBeChecked()
    await tab('基础配置').click(); await expect(form().getByLabel('名称', { exact: true })).toHaveValue('资料审阅助手 · 更新')
    await form().press('Control+s'); await expect.poll(() => mutations.length).toBe(1)
    const { id, ...original } = alpha
    expect(mutations[0]).toEqual({ method: 'PUT', id, body: { ...original, name: '资料审阅助手 · 更新' } })
    await edit(agents.find(agent => agent.id === alpha.id)!)
    await form().getByRole('textbox', { name: '工作指令', exact: true }).fill('这次改动应被明确放弃')
    await page.getByRole('button', { name: '返回 Agent 列表', exact: true }).click()
    await discard.getByRole('button', { name: '放弃修改', exact: true }).click(); await expect(form()).toHaveCount(0)
    expect(mutations).toHaveLength(1); expect(agents.find(agent => agent.id === alpha.id)?.systemPrompt).toBe(alpha.systemPrompt)
  })

  test('工具分组三态反映选择，筛选批量操作只修改匹配项并保存完整权限', async () => {
    await edit(beta); await tab('工具权限').click()
    const group = form().getByRole('group', { name: 'Agent 管理', exact: true })
    const toggle = group.getByRole('button', { name: 'Agent 管理工具分类', exact: true })
    const all = group.getByRole('checkbox', { name: '选择本组全部工具：Agent 管理', exact: true })
    const matching = group.getByRole('checkbox', { name: '选择本组匹配工具：Agent 管理', exact: true })
    const search = form().getByRole('textbox', { name: '搜索工具权限', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(all).not.toBeChecked(); await expect(all).toHaveAttribute('aria-checked', 'false')

    await search.fill('创建 Agent')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(group.locator('.work-agent-manager__tool-group-count')).toHaveText('0/5')
    await expect(form().locator('.work-agent-manager__tool-panel-heading')).toContainText('匹配 1 项')
    await matching.check(); await expect(checkbox('创建 Agent')).toBeChecked()
    await expect(checkbox('读取 Agent')).toHaveCount(0)
    await search.fill(''); await selectToolCategory('Agent 管理')
    await expect(all).toHaveAttribute('aria-checked', 'mixed')
    await expect.poll(() => all.evaluate(element => element instanceof HTMLInputElement && element.indeterminate)).toBe(true)
    for (const name of ['列出 Agent', '读取 Agent', '更新 Agent', '删除 Agent']) await expect(checkbox(name)).not.toBeChecked()

    await all.check()
    await expect(all).toBeChecked(); await expect(all).toHaveAttribute('aria-checked', 'true')
    await expect(group.locator('.work-agent-manager__tool-group-count')).toHaveText('5/5')
    for (const name of ['列出 Agent', '读取 Agent', '创建 Agent', '更新 Agent', '删除 Agent']) await expect(checkbox(name)).toBeChecked()
    await checkbox('读取 Agent').uncheck(); await expect(all).toHaveAttribute('aria-checked', 'mixed')
    await search.fill('更新 Agent')
    await expect(matching).toBeChecked(); await matching.uncheck()
    await expect(checkbox('更新 Agent')).not.toBeChecked()
    await search.fill(''); await selectToolCategory('Agent 管理')
    await expect(all).toHaveAttribute('aria-checked', 'mixed')
    await expect(group.locator('.work-agent-manager__tool-group-count')).toHaveText('3/5')
    for (const name of ['列出 Agent', '创建 Agent', '删除 Agent']) await expect(checkbox(name)).toBeChecked()
    for (const name of ['读取 Agent', '更新 Agent']) await expect(checkbox(name)).not.toBeChecked()
    await selectToolCategory('文件与搜索')
    await expect(checkbox('读取文件')).toBeChecked(); await expect(checkbox('写入文件')).not.toBeChecked()
    await selectToolCategory('Agent 管理')
    expect(mutations).toEqual([])
    await shot('agent-tools-category-selection')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => mutations.length).toBe(1)
    const { id, ...original } = beta, saved = mutations[0].body as AgentPayload
    expect(mutations[0]).toEqual({ method: 'PUT', id, body: { ...original, allowedTools: saved.allowedTools } })
    expect([...saved.allowedTools].sort()).toEqual(['read_file', 'agent_create', 'agent_list', 'agent_delete'].sort())
  })

  test('工具详情独立展开完整长说明，筛选和滚动不改变权限', async () => {
    await edit(alpha); await tab('工具权限').click(); await selectToolCategory('终端命令')
    const details = form().getByRole('button', { name: '查看 运行命令 详情', exact: true })
    const row = details.locator('..'), originalHeight = await row.evaluate(element => element.getBoundingClientRect().height)
    expect(originalHeight).toBeLessThan(54)
    await expect(row.locator('.work-agent-manager__binding-option')).not.toContainText(longDescription)
    await expect(row.locator('strong')).toHaveAttribute('title', 'run_command')
    await expect(checkbox('运行命令')).not.toBeChecked(); await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'true'); await expect(checkbox('运行命令')).not.toBeChecked()
    const detailId = await details.getAttribute('aria-controls'); expect(detailId).not.toBeNull()
    await expect(page.locator(`[id=${JSON.stringify(detailId)}]`)).toContainText(longDescription)
    await details.click(); await expect(details).toHaveAttribute('aria-expanded', 'false')
    await expect(checkbox('运行命令')).not.toBeChecked()
    await form().getByRole('checkbox', { name: '仅看已选工具权限', exact: true }).check()
    await selectToolCategory('文件与搜索'); await expect(checkbox('读取文件')).toBeChecked()
    await selectToolCategory('其它工具'); await expect(checkbox('legacy_tool')).toBeChecked()
    await expect(checkbox('运行命令')).toHaveCount(0)
    await form().getByRole('checkbox', { name: '仅看已选工具权限', exact: true }).uncheck()
    const search = form().getByRole('textbox', { name: '搜索工具权限', exact: true })
    await search.fill('扩展工具 55'); await expect(checkbox('扩展工具 55')).not.toBeChecked()
    await expect(checkbox('读取文件')).toHaveCount(0); await search.fill(''); await selectToolCategory('其它工具')
    const list = form().locator('.work-agent-manager__binding-list')
    const before = await form().locator('.work-agent-manager__binding-toolbar').boundingBox()
    await list.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    const after = await form().locator('.work-agent-manager__binding-toolbar').boundingBox()
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
    await expect(page.getByRole('button', { name: '保存 Agent', exact: true })).toBeInViewport()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    await expect.poll(() => mutations.length).toBe(1)
    expect((mutations[0].body as AgentPayload).allowedTools).toEqual(alpha.allowedTools)
  })

  test('分类导航独立于勾选，支持键盘切换并可移除缺失工具', async () => {
    await edit(alpha); await tab('工具权限').click()
    const categories = form().getByRole('navigation', { name: '工具分类', exact: true })
    const files = categories.getByRole('button', { name: '文件与搜索工具分类', exact: true })
    const terminal = categories.getByRole('button', { name: '终端命令工具分类', exact: true })
    await expect(files).toHaveAttribute('aria-pressed', 'true')
    await expect(checkbox('读取文件')).toBeChecked()
    await expect(checkbox('运行命令')).toHaveCount(0)
    await files.focus(); await files.press('ArrowDown')
    await expect(terminal).toBeFocused(); await expect(terminal).toHaveAttribute('aria-pressed', 'true')
    await expect(checkbox('运行命令')).not.toBeChecked()
    await expect(checkbox('读取文件')).toHaveCount(0)
    await terminal.press('Home'); await expect(files).toBeFocused()
    await expect(checkbox('读取文件')).toBeChecked()
    const terminalGroup = categories.getByRole('checkbox', { name: '选择本组全部工具：终端命令', exact: true })
    await terminalGroup.check()
    await expect(files).toHaveAttribute('aria-pressed', 'true')
    await expect(checkbox('运行命令')).toHaveCount(0)
    await selectToolCategory('终端命令'); await expect(checkbox('运行命令')).toBeChecked()
    await terminalGroup.uncheck()
    const search = form().getByRole('textbox', { name: '搜索工具权限', exact: true })
    await search.fill('legacy_tool')
    await expect(form().getByRole('button', { name: '其它工具工具分类', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(checkbox('legacy_tool')).toBeChecked()
    // Removing a missing binding removes its row immediately, so there is no
    // attached checkbox for uncheck() to inspect after the click.
    await checkbox('legacy_tool').click()
    await expect(checkbox('legacy_tool')).toHaveCount(0)
    await expect(form().locator('.work-agent-manager__tool-panel')).toContainText('没有匹配的工具')
    await search.fill(''); await selectToolCategory('文件与搜索')
    await expect(checkbox('读取文件')).toBeChecked(); await expect(checkbox('写入文件')).not.toBeChecked()
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
    const { id, ...original } = alpha
    await expect.poll(() => mutations).toEqual([{ method: 'PUT', id, body: { ...original, allowedTools: ['read_file'] } }])
  })

  test('选择弹窗保持编辑与选用独立，标记尺寸固定且删除只影响确认目标', async () => {
    await seed({ page: 'home', selectedId: alpha.id })
    await page.getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '自定义 Agent', exact: true })
    await expect(dialog).toBeVisible()
    const chosen = dialog.getByRole('button', { name: `使用 Agent ${alpha.name}`, exact: true }).locator('.work-agent-manager__picked')
    const box = await chosen.boundingBox(); expect(box?.width).toBeCloseTo(20, 0); expect(box?.height).toBeCloseTo(20, 0)
    await shot('agent-picker-list')
    await dialog.getByRole('button', { name: `编辑 Agent ${beta.name}`, exact: true }).click()
    await expect(form().getByLabel('名称', { exact: true })).toHaveValue(beta.name)
    expect((await state()).homeAgentId).toBe(alpha.id)
    await tab('工具权限').click(); await selectToolCategory('其它工具')
    const toolList = form().locator('.work-agent-manager__binding-list')
    const toolSearch = form().getByRole('textbox', { name: '搜索工具权限', exact: true })
    await expect(toolSearch).toBeInViewport()
    await expect(page.getByRole('button', { name: '保存 Agent', exact: true })).toBeInViewport()
    await expect(checkbox('扩展工具 55')).toHaveCount(1)
    await toolList.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => toolList.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await expect(toolSearch).toBeInViewport()
    await expect(page.getByRole('button', { name: '保存 Agent', exact: true })).toBeInViewport()
    await shot('agent-picker-editor-tools')
    await tab('基础配置').click()
    await expect(form().getByLabel('名称', { exact: true })).toHaveValue(beta.name)
    await shot('agent-picker-editor-basics')
    await page.getByRole('button', { name: '取消', exact: true }).click(); await expect(form()).toHaveCount(0)
    await dialog.getByRole('button', { name: `${beta.name}的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '删除 Agent', exact: true }).click()
    const deletion = page.getByRole('dialog', { name: '删除 Agent', exact: true })
    await expect(deletion).toContainText(beta.name); await deletion.getByRole('button', { name: '取消', exact: true }).click()
    await expect(deletion).toHaveCount(0); expect(mutations).toEqual([])
    await dialog.getByRole('button', { name: `使用 Agent ${beta.name}`, exact: true }).click()
    await expect(dialog).toHaveCount(0); await expect.poll(async () => (await state()).homeAgentId).toBe(beta.id)
    await page.getByRole('button', { name: '管理与选择 Agent', exact: true }).click()
    await dialog.getByRole('button', { name: `${alpha.name}的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '删除 Agent', exact: true }).click()
    await expect(deletion).toContainText(alpha.name)
    await assertSemanticButtonStates(deletion.getByRole('button', { name: '删除', exact: true }), 'danger')
    await deletion.getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => mutations).toEqual([{ method: 'DELETE', id: alpha.id, body: null }])
    await expect(dialog.getByRole('button', { name: `使用 Agent ${alpha.name}`, exact: true })).toHaveCount(0)
    expect(agents.some(agent => agent.id === alpha.id)).toBe(false)
    expect(agents.find(agent => agent.id === beta.id)).toEqual(beta); expect((await state()).homeAgentId).toBe(beta.id)
  })

  test('已固定 Agent 的任务仍能编辑配置，但不可换绑或删除当前 Agent', async () => {
    await seed({ locked: true })
    await expect(manager().getByRole('button', { name: `使用 Agent ${alpha.name}`, exact: true })).toBeDisabled()
    await expect(manager().getByRole('button', { name: `使用 Agent ${beta.name}`, exact: true })).toBeDisabled()
    await expect(manager().getByRole('button', { name: `编辑 Agent ${alpha.name}`, exact: true })).toBeEnabled()
    await manager().getByRole('button', { name: `${alpha.name}的操作`, exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '删除 Agent', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape'); await edit(alpha)
    await form().getByLabel('用途', { exact: true }).fill('保留已固定身份并更新用途')
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click(); await expect.poll(() => mutations.length).toBe(1)
    expect(mutations[0].method).toBe('PUT'); expect(mutations[0].id).toBe(alpha.id)
    const current = await state(); expect(current.activeTaskId).toBe('work-agent-locked')
    expect(current.tasks.find(task => task.id === current.activeTaskId)?.agentId).toBe(alpha.id)
  })

  test('浅深主题和窄窗中列表有界，工具搜索与保存操作持续可见', async () => {
    for (const theme of ['light', 'dark'] as const) {
      await appearance(theme)
      for (const width of [1640, 760]) {
        await setWindow(width, 860)
        const container = manager().locator('.work-agent-manager--page')
        const bounds = await container.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(1122)
        await expect(manager().getByRole('textbox', { name: '搜索 Agent', exact: true })).toBeInViewport()
        const overflow = await manager().evaluate(element => ({ self: element.scrollWidth - element.clientWidth,
          outside: [...element.querySelectorAll('button, input')].filter(item => {
            const rect = item.getBoundingClientRect(); return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1)
          }).length }))
        expect(overflow).toEqual({ self: 0, outside: 0 }); await shot(`agents-${theme}-${width}`)
        await edit(alpha); await tab('工具权限').click(); await selectToolCategory('其它工具')
        const browser = form().locator('.work-agent-manager__tool-browser')
        const categories = form().getByRole('navigation', { name: '工具分类', exact: true })
        const managerWidth = await manager().locator('.work-agent-manager--page').evaluate(element => element.clientWidth)
        await expect.poll(() => categories.evaluate(element => getComputedStyle(element).flexDirection)).toBe(managerWidth <= 580 ? 'row' : 'column')
        const layout = await browser.evaluate(element => {
          const navigation = element.querySelector('nav')!, panel = element.querySelector('.work-agent-manager__tool-panel')!
          const a = navigation.getBoundingClientRect(), b = panel.getBoundingClientRect()
          return { overflow: element.scrollWidth - element.clientWidth, sideBySide: a.right <= b.left + 1,
            stacked: a.bottom <= b.top + 1, categoriesOverflow: navigation.scrollWidth > navigation.clientWidth }
        })
        expect(layout.overflow).toBeLessThanOrEqual(1)
        expect(managerWidth <= 580 ? layout.stacked : layout.sideBySide).toBe(true)
        if (managerWidth <= 580) expect(layout.categoriesOverflow).toBe(true)
        const list = form().locator('.work-agent-manager__binding-list')
        await list.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
        await expect(form().getByRole('textbox', { name: '搜索工具权限', exact: true })).toBeInViewport()
        await expect(page.getByRole('button', { name: '保存 Agent', exact: true })).toBeInViewport()
        await shot(`agent-tools-${theme}-${width}`)
        await page.getByRole('button', { name: '返回 Agent 列表', exact: true }).click(); await expect(form()).toHaveCount(0)
      }
    }
  })
})
