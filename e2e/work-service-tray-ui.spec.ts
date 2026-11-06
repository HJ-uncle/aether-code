/** Real-window coverage for Work's anchored service popover: compact rows,
 * progressive command/log details, clipboard, stop receipts, history, keyboard
 * focus, outside dismissal and bounded dark/light/narrow layout. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { RootRun } from '../src/shared/root-run'
import { commandJobInvocation } from '../src/renderer/src/core/engine/command-job-state'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-service-popover-fixture-token'
const sessionId = 'work-service-popover-session'
const model = 'work-service-popover-model'
const now = Date.now() - 5000
const run: RootRun = { schemaVersion: 1, sessionId, runId: 'service-run', turnId: 'service-turn',
  userMessageId: 'service-user', assistantMessageId: 'service-assistant', seq: 1, version: 1,
  status: 'succeeded', modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
const service: CommandJobSnapshot = { schemaVersion: 1, jobId: 'preview-service', sessionId, ownerSessionId: sessionId,
  runId: run.runId, turnId: run.turnId, version: 1, status: 'running', command: 'C:/tools/python/python.exe',
  args: ['server.py', '--host', '127.0.0.1', '--description', 'LONG_SERVICE_ARGUMENT_'.repeat(30)],
  cwd: 'C:/work/projects/very-long-workspace-name/generated/previews/service-build/output',
  background: true, createdAt: now, updatedAt: now, exitCode: null, signal: null, cursor: 1, earliestCursor: 0 }
const historyJob: CommandJobSnapshot = { ...service, jobId: 'previous-service', command: 'node', args: ['old-server.js'],
  status: 'succeeded', exitCode: 0, updatedAt: now - 1000, finishedAt: now - 1000 }
const jobs = new Map([[service.jobId, service], [historyJob.jobId, historyJob]])
const log = 'Preview service ready at http://127.0.0.1:4173\n'
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const errors: string[] = []
const stopRequests: { jobId: string; sessionId: unknown }[] = []
let outputReads = 0
let rejectStop = true
let server: ReturnType<typeof createServer> | undefined
let app: ElectronApplication | undefined
let page: Page
let health: ElectronHealthMonitor | undefined
let fixture = ''
const trigger = () => page.getByRole('button', { name: '查看后台服务', exact: true })
const tray = () => page.getByRole('complementary', { name: '后台服务', exact: true })
const runningCard = () => tray().locator(`[data-job-id="${service.jobId}"]`)

test.describe.serial('Work 后台服务弹层', () => {
  test.beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
          response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null)); return
        }
        let raw = ''
        for await (const chunk of request) raw += String(chunk)
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
        response.setHeader('content-type', 'application/json')
        const route = path.match(/^\/api\/v1\/command-jobs\/([^/]+)\/(output|cancel)$/)
        if (route) {
          let job = jobs.get(route[1])
          if (!job || (route[2] === 'output' ? url.searchParams.get('sessionId') : body.sessionId) !== sessionId) {
            response.writeHead(404).end(envelope(null)); return
          }
          if (route[2] === 'cancel') {
            stopRequests.push({ jobId: job.jobId, sessionId: body.sessionId })
            if (rejectStop) { response.writeHead(409).end(JSON.stringify({ code: 409, message: '服务暂时无法停止', data: null })); return }
            job = { ...job, status: 'cancelling', version: job.version + 1, updatedAt: Date.now() }
            jobs.set(job.jobId, job)
            response.end(envelope(job)); return
          }
          outputReads++
          if (job.status === 'cancelling') {
            job = { ...job, status: 'cancelled', version: job.version + 1, updatedAt: Date.now(), finishedAt: Date.now(),
              exitCode: 1, error: { code: 'COMMAND_CANCELLED', message: 'Cancelled by user' } }
            jobs.set(job.jobId, job)
          }
          response.end(envelope({ job, entries: [{ seq: 1, stream: 'stdout', text: log }], nextCursor: 1,
            earliestCursor: 0, truncated: false, hasMore: false })); return
        }
        const history = [
          { id: run.userMessageId, role: 'user', content: '预览服务测试', conversationId: run.turnId, createdAt: now, metadata: { runId: run.runId, turnId: run.turnId } },
          { id: run.assistantMessageId, role: 'assistant', content: '预览服务已就绪。', conversationId: run.turnId, createdAt: now + 1, metadata: { runId: run.runId, turnId: run.turnId } }
        ]
        const data = path === '/health' ? { status: 'ok' }
          : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-service-popover' }
          : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '服务测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', finished: true, eventId: null, projection: [], history, run, runs: [run], todos: [], changes: [], commandJobs: [...jobs.values()] }
          : path === '/api/v1/chat/status' ? { running: false, finished: true, run }
          : path === '/api/v1/chat/runs' ? { runs: [run] }
          : path === '/api/v1/conversation/history' ? history
          : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: '服务弹层回归', lastAt: now, messageCount: history.length }]
          : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'fixture', sessionId, namespace: { id: 'work-service-popover-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
          : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
          : path === '/api/v1/memory/settings' ? { sessionId, memoryScope: 'session', effectiveScope: 'session', enabled: false }
          : path === '/api/v1/workspace/directory' ? { root: 'C:/work/service-fixture', entries: [] }
          : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
          : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
          : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
          : path === '/api/v1/command-jobs' ? { jobs: [...jobs.values()] }
          : []
        response.end(envelope(data))
      })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(envelope(null)) })
    })
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing service fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-service-popover-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastModelId: model, appearance: 'light', lastFolder: '' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-service-popover', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    await page.evaluate(({ key, sessionId, model, now }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title: '服务弹层回归', status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: null, modelId: model, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), sessionId, model, now })
    await page.reload()
    await expect(page.getByRole('heading', { name: '服务弹层回归', exact: true })).toBeVisible()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server?.closeAllConnections()
      await new Promise<void>(done => server ? server.close(() => done()) : done())
      if (fixture) {
        const target = resolve(fixture), child = relative(fixtureRoot, target)
        if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Refusing cleanup outside the fixture directory')
        rmSync(target, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  })

  test('默认仅名称和状态，弹层依内容高度并锚定按钮', async ({}, info) => {
    await trigger().click()
    await expect(runningCard()).toBeVisible()
    await expect(runningCard().getByRole('button', { name: '查看服务详情：python server.py', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(runningCard()).toContainText('运行中')
    await expect(tray()).not.toContainText(service.cwd)
    await expect(tray()).not.toContainText('LONG_SERVICE_ARGUMENT_')
    await expect(tray().getByRole('button', { name: /历史记录/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(tray().locator(`[data-job-id="${historyJob.jobId}"]`)).toHaveCount(0)
    const geometry = await page.evaluate(() => {
      const anchor = document.querySelector('.work-service-tray__button')!.getBoundingClientRect()
      const panel = document.querySelector('.work-service-tray__popover')!.getBoundingClientRect()
      return { width: panel.width, height: panel.height, anchored: Math.abs(panel.top - anchor.bottom - 6) < 3 }
    })
    expect(geometry.width).toBeGreaterThanOrEqual(320)
    expect(geometry.width).toBeLessThanOrEqual(380)
    expect(geometry.height).toBeLessThan(220)
    expect(geometry.anchored).toBe(true)
    await tray().screenshot({ path: info.outputPath('services-light-compact.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(tray()).not.toBeVisible()
    await expect(trigger()).toBeFocused()
  })

  test('按需展开完整命令目录和日志，复制后可收起并点击外部关闭', async () => {
    await trigger().click()
    await runningCard().getByRole('button', { name: /^查看服务详情/ }).click()
    await expect(runningCard().locator('.work-service-card__command')).toHaveText(commandJobInvocation(service))
    await expect(runningCard().locator('dd').filter({ hasText: service.cwd })).toHaveCount(1)
    await expect(runningCard().getByLabel('命令输出', { exact: true })).toHaveText(log)
    await runningCard().getByRole('button', { name: '复制诊断', exact: true }).click()
    await expect(runningCard().getByRole('button', { name: '已复制诊断', exact: true })).toBeVisible()
    const clipboard = await app!.evaluate(({ clipboard }) => clipboard.readText())
    expect(clipboard).toContain(commandJobInvocation(service))
    expect(clipboard).toContain(service.cwd)
    expect(clipboard).toContain(log.trim())
    await runningCard().getByRole('button', { name: /^收起服务详情/ }).click()
    await expect(runningCard().getByLabel('命令输出', { exact: true })).not.toBeVisible()
    await page.getByRole('heading', { name: '服务弹层回归', exact: true }).click()
    await expect(tray()).not.toBeVisible()
    const reads = outputReads, closedAt = Date.now()
    await expect.poll(() => { expect(outputReads).toBe(reads); return Date.now() - closedAt }, { timeout: 3000, intervals: [200] }).toBeGreaterThanOrEqual(1200)
  })

  test('深色与窄窗仍保持边界，展开详情有有限高度和内部滚动', async ({}, info) => {
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
    await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 320); window.setContentSize(640, 620) })
    await trigger().click()
    await runningCard().getByRole('button', { name: /^查看服务详情/ }).click()
    await expect(runningCard().getByLabel('命令输出', { exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.work-service-tray__popover').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { contained: rect.left >= 7 && rect.right <= innerWidth - 7 && rect.top >= 7 && rect.bottom <= innerHeight - 7,
        bounded: rect.height <= 482, overflow: element.scrollWidth > element.clientWidth }
    })).toEqual({ contained: true, bounded: true, overflow: false })
    await tray().screenshot({ path: info.outputPath('services-dark-narrow-details.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(trigger()).toBeFocused()
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  })

  test('停止失败保留可操作服务，确认停止移入默认折叠历史，空态只出现一次', async () => {
    await trigger().click()
    await runningCard().getByRole('button', { name: '停止命令', exact: true }).click()
    await expect(runningCard().getByRole('alert')).toContainText('服务暂时无法停止')
    expect(jobs.get(service.jobId)?.status).toBe('running')
    rejectStop = false
    await runningCard().getByRole('button', { name: '停止命令', exact: true }).click()
    await expect.poll(() => jobs.get(service.jobId)?.status).toBe('cancelled')
    expect(stopRequests).toEqual([{ jobId: service.jobId, sessionId }, { jobId: service.jobId, sessionId }])
    await expect(tray().getByText('没有正在运行的服务', { exact: true })).toHaveCount(1)
    await expect(tray().getByRole('button', { name: /历史记录/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(runningCard()).toHaveCount(0)
    await expect(tray().getByRole('button', { name: '关闭后台服务', exact: true })).toBeFocused()
    await tray().getByRole('button', { name: /历史记录/ }).click()
    await expect(runningCard().getByRole('status')).toHaveText('已停止')
    await expect(tray().locator(`[data-job-id="${historyJob.jobId}"]`).getByRole('status')).toHaveText('已完成')
    await runningCard().getByRole('button', { name: /^查看服务详情/ }).click()
    await expect(runningCard().getByLabel('命令输出', { exact: true })).toHaveText(log)
    await expect(runningCard()).toContainText('已按你的请求停止命令。')
    await page.keyboard.press('Escape')
    await trigger().click()
    await expect(tray().getByRole('button', { name: /历史记录/ })).toHaveAttribute('aria-expanded', 'false')
    await tray().getByRole('button', { name: '关闭后台服务', exact: true }).click()
    await expect(trigger()).toBeFocused()
  })
})
