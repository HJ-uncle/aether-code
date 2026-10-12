/** Real Electron + HTTP coverage of Work automation CRUD, session ownership,
 * thinking-mode and execution-limit persistence, and responsive controls. The fixture does not run a scheduler. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

let health: ElectronHealthMonitor | undefined

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-automation-fixture-token', modelId = 'work-automation-model'
interface Job { id: string; name: string; cronExpr: string; message: string; sessionId: string; enabled: boolean; createdAt: number; lastRunAt?: number; thinkingMode?: unknown; timeoutSeconds?: number | null }
interface Session { run: RootRun; history: Array<{ id: string; role: string; content: string; createdAt: number }>; projection: ChatSsePayload[] }
const jobs = new Map<string, Job>(), sessions = new Map<string, Session>()
const mutations: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
const chatRequests: Record<string, unknown>[] = [], errors: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', originalSession = '', jobId = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (method === 'POST' && path === '/api/v1/chat') {
      chatRequests.push(body)
      const id = String(body.sessionId), now = Date.now()
      const run: RootRun = { schemaVersion: 1, runId: `automation-run-${chatRequests.length}`, sessionId: id, turnId: `turn-${chatRequests.length}`, userMessageId: `user-${chatRequests.length}`, assistantMessageId: `assistant-${chatRequests.length}`, seq: 1, version: 1, status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
      const user = { id: run.userMessageId, role: 'user', content: String(body.message), createdAt: now }
      const content = `任务已就绪：${String(body.message)}`
      const projection: ChatSsePayload[] = [{ userMessage: user }, { content }, { run }]
      sessions.set(id, { run, projection, history: [user, { id: run.assistantMessageId, role: 'assistant', content, createdAt: now }] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      projection.forEach((payload, index) => response.write(`id: ${run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`))
      response.end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/cron' && method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(envelope([...jobs.values()])); return }
    if (path.startsWith('/api/v1/cron') && method !== 'GET') {
      mutations.push({ method, path, body })
      const match = path.match(/^\/api\/v1\/cron\/([^/]+)(?:\/(enable|disable))?$/)
      let result: unknown
      if (path === '/api/v1/cron' && method === 'POST') {
        const id = `automation-${jobs.size + 1}`
        const created: Job = { id, name: String(body.name), cronExpr: String(body.cronExpr), message: String(body.message), sessionId: String(body.sessionId), enabled: body.enabled === true, thinkingMode: body.thinkingMode, timeoutSeconds: typeof body.timeoutSeconds === 'number' ? body.timeoutSeconds : null, createdAt: Date.now() }
        jobs.set(id, created); result = created
      } else if (match && jobs.has(match[1])) {
        const previous = jobs.get(match[1])!
        if (method === 'PUT' && !match[2]) { result = { ...previous, ...body }; jobs.set(previous.id, result as Job) }
        else if (method === 'POST' && match[2]) { result = { ...previous, enabled: match[2] === 'enable' }; jobs.set(previous.id, result as Job) }
        else if (method === 'DELETE' && !match[2]) { jobs.delete(previous.id); result = { deleted: true } }
        else throw new Error(`Unsupported fixture mutation ${method} ${path}`)
      } else throw new Error(`Unknown fixture automation ${method} ${path}`)
      response.setHeader('content-type', 'application/json'); response.end(envelope(result)); return
    }
    const id = url.searchParams.get('sessionId') ?? '', session = sessions.get(id)
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'work-automation-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Automation fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: session ? `${session.run.runId}:3` : null, finished: true, projection: session?.projection ?? [], history: session?.history ?? [], run: session?.run, runs: session ? [session.run] : [], todos: [], changes: [], commandJobs: [] }
            : path === '/api/v1/chat/runs' ? { runs: session ? [session.run] : [] }
              : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                  : path === '/api/v1/workspace/directory' ? { root: '/remote/automation-fixture', entries: [] }
                    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/automation-fixture' } : []
    response.setHeader('content-type', 'application/json'); response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const work = () => page.locator('.work-view')
const automation = () => work().locator('.work-automation')
async function startTask(prompt: string): Promise<string> {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const count = chatRequests.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => chatRequests.length).toBe(count + 1)
  await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(`任务已就绪：${prompt}`)
  return String(chatRequests[count].sessionId)
}
async function openAutomations(): Promise<void> { await work().locator('.work-navigation').getByRole('button', { name: '自动化', exact: true }).click() }

test.describe.serial('Work 自动化管理', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing automation fixture port')
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-automation-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, remoteWorkspaceRoot: '/remote/code-project', lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'dark', lastFolder: '' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-automation', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, testInfo) => {
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-automation-')) throw new Error(`Unsafe cleanup: ${target}`); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('从任务创建自动化，关闭思考与会话标识实际提交到引擎', async () => {
    originalSession = await startTask('AUTOMATION_ORIGINAL_SESSION')
    await openAutomations()
    await automation().getByRole('button', { name: '新建自动化', exact: true }).click()
    await expect(automation().getByRole('button', { name: '自动化最长运行时间', exact: true })).toHaveText('30 分钟')
    await automation().getByLabel('名称', { exact: true }).fill('每日检查')
    await automation().getByLabel('时间表达式', { exact: true }).fill('*/15 * * * *')
    await automation().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill('检查构建与测试结果，记录最近一次结论。')
    await automation().getByRole('button', { name: '自动化思考档位', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Off · 关闭思考', exact: true }).click()
    await automation().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => jobs.size).toBe(1)
    jobId = [...jobs.keys()][0]
    expect(mutations.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/cron', body: { name: '每日检查', cronExpr: '*/15 * * * *', sessionId: originalSession, thinkingMode: false, timeoutSeconds: 1800, enabled: true } })
    await expect(automation().locator('.work-automation-row')).toContainText('思考 Off')
    await expect(automation().locator('.work-automation-row')).toContainText('单次最长 30 分钟')
    await expect(automation().locator('form')).toHaveCount(0)
  })

  test('切到其他任务后编辑仍绑定原会话，自动档位与窗口布局正确', async ({}, testInfo) => {
    const otherSession = await startTask('AUTOMATION_OTHER_SESSION')
    expect(otherSession).not.toBe(originalSession)
    jobs.set(jobId, { ...jobs.get(jobId)!, lastRunAt: Date.now() - 60_000 })
    await openAutomations()
    await expect(automation()).toContainText('最近运行')
    await automation().getByRole('button', { name: '编辑自动化 每日检查', exact: true }).click()
    await expect(automation().getByRole('button', { name: '自动化思考档位', exact: true })).toHaveText('Off · 关闭思考')
    await automation().getByLabel('名称', { exact: true }).fill('持续检查')
    await automation().getByLabel('时间表达式', { exact: true }).fill('*/30 * * * *')
    await automation().getByRole('button', { name: '自动化思考档位', exact: true }).click()
    await page.getByRole('menuitem', { name: '自动 · 使用模型默认', exact: true }).click()
    await automation().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => jobs.get(jobId)?.name).toBe('持续检查')
    expect(mutations.at(-1)).toMatchObject({ method: 'PUT', path: `/api/v1/cron/${jobId}`, body: { name: '持续检查', sessionId: originalSession, thinkingMode: null, cronExpr: '*/30 * * * *' } })
    expect(mutations.at(-1)!.body).not.toHaveProperty('enabled')
    expect(mutations.at(-1)!.body).not.toHaveProperty('timeoutSeconds')
    expect(jobs.get(jobId)?.timeoutSeconds).toBe(1800)
    for (const appearance of ['dark', 'light'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 640))
      await automation().getByRole('button', { name: '编辑自动化 持续检查', exact: true }).click()
      await expect(automation().getByRole('button', { name: '自动化思考档位', exact: true })).toHaveText('自动 · 使用模型默认')
      const save = automation().getByRole('button', { name: '保存自动化', exact: true })
      await save.scrollIntoViewIfNeeded()
      await expect(save).toBeVisible()
      expect(await automation().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
      await page.screenshot({ path: testInfo.outputPath(`work-automation-${appearance}-940.png`), animations: 'disabled' })
      await automation().getByRole('button', { name: '取消', exact: true }).click()
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('最长运行时间支持预设和精确秒数，非法输入不发送且修改仍保留会话', async () => {
    await automation().getByRole('button', { name: '编辑自动化 持续检查', exact: true }).click()
    const duration = automation().getByRole('button', { name: '自动化最长运行时间', exact: true })
    await duration.click()
    await expect(page.getByRole('menuitem')).toHaveText(['2 分钟', '10 分钟', '30 分钟', '60 分钟', '3 小时', '6 小时', '24 小时', '自定义时长'])
    await page.getByRole('menuitem', { name: '6 小时', exact: true }).click()
    await expect(automation()).toContainText('运行中修改从下一次执行生效')
    await expect(automation()).toContainText('同一自动化尚未完成时不会重复启动')
    await automation().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => jobs.get(jobId)?.timeoutSeconds).toBe(21600)
    expect(mutations.at(-1)).toMatchObject({ method: 'PUT', path: `/api/v1/cron/${jobId}`, body: { timeoutSeconds: 21600, sessionId: originalSession } })
    expect(mutations.at(-1)!.body).not.toHaveProperty('enabled')
    await expect(automation().locator('.work-automation-row')).toContainText('单次最长 6 小时')

    await automation().getByRole('button', { name: '编辑自动化 持续检查', exact: true }).click()
    await expect(duration).toHaveText('6 小时')
    await duration.click()
    await page.getByRole('menuitem', { name: '自定义时长', exact: true }).click()
    const seconds = automation().getByRole('spinbutton', { name: '自定义时长（秒）', exact: true })
    await expect(seconds).toHaveValue('21600')
    const count = mutations.length
    for (const value of ['', '0', '1.5', '86401']) {
      await seconds.fill(value)
      await expect(seconds).toHaveAttribute('aria-invalid', 'true')
      await expect(automation().getByRole('button', { name: '保存自动化', exact: true })).toBeDisabled()
      await expect(automation()).toContainText('请输入 1 至 86400 的整数秒数。')
    }
    expect(mutations).toHaveLength(count)
    await seconds.fill('125')
    await expect(seconds).toHaveAttribute('aria-invalid', 'false')
    await automation().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => jobs.get(jobId)?.timeoutSeconds).toBe(125)
    await expect(automation().locator('.work-automation-row')).toContainText('单次最长 2 分钟 5 秒')
    await automation().getByRole('button', { name: '编辑自动化 持续检查', exact: true }).click()
    await expect(duration).toHaveText('自定义时长')
    await expect(seconds).toHaveValue('125')
    await automation().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill('保留精确秒数，仅调整任务内容。')
    await automation().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => jobs.get(jobId)?.message).toBe('保留精确秒数，仅调整任务内容。')
    expect(mutations.at(-1)!.body).not.toHaveProperty('timeoutSeconds')
    expect(jobs.get(jobId)?.timeoutSeconds).toBe(125)
  })

  test('旧自动化的空值和缺省时限显示2分钟，无关编辑保留原语义', async () => {
    for (const legacy of [null, undefined]) {
      jobs.set(jobId, { ...jobs.get(jobId)!, timeoutSeconds: legacy })
      await work().locator('.work-navigation').getByRole('button', { name: '工作台', exact: true }).click()
      await openAutomations()
      await expect(automation().locator('.work-automation-row')).toContainText('单次最长 2 分钟')
      await automation().getByRole('button', { name: '编辑自动化 持续检查', exact: true }).click()
      await expect(automation().getByRole('button', { name: '自动化最长运行时间', exact: true })).toHaveText('2 分钟')
      const message = `保留旧时限语义 ${legacy === null ? 'null' : 'undefined'}`
      await automation().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill(message)
      await automation().getByRole('button', { name: '保存自动化', exact: true }).click()
      await expect.poll(() => jobs.get(jobId)?.message).toBe(message)
      expect(mutations.at(-1)!.body).not.toHaveProperty('timeoutSeconds')
      expect(mutations.at(-1)!.body).not.toHaveProperty('enabled')
      expect(mutations.at(-1)!.body.sessionId).toBe(originalSession)
      expect(jobs.get(jobId)?.timeoutSeconds).toBe(legacy)
    }
  })

  test('暂停、启用和删除均变更真实记录，删除后显示空状态', async () => {
    await automation().getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(() => jobs.get(jobId)?.enabled).toBe(false)
    expect(mutations.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/cron/${jobId}/disable` })
    await expect(automation()).toContainText('已暂停')
    await automation().getByRole('button', { name: '启用', exact: true }).click()
    await expect.poll(() => jobs.get(jobId)?.enabled).toBe(true)
    expect(mutations.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/cron/${jobId}/enable` })
    await automation().getByRole('button', { name: '删除自动化 持续检查', exact: true }).click()
    await expect.poll(() => jobs.size).toBe(0)
    expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/v1/cron/${jobId}` })
    await expect(automation()).toContainText('还没有自动化')
    expect(errors).toEqual([])
  })
})
