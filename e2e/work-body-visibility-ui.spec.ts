/** Fresh Work-mode regression coverage: a completed persisted run whose
 * history has tool/process content and a final answer must keep the answer
 * visible while the process disclosure starts collapsed. This fixture omits
 * the optional final-result manifest to cover the durable-history state that
 * previously hid the whole assistant body. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { applyRootRuns } from '../src/renderer/src/core/engine/root-run-state'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-body-visibility-fixture-token'
const model = 'work-body-visibility-model'
const sessionId = 'work-body-visibility-session'
const turnId = 'work-body-visibility-turn'
const runId = 'work-body-visibility-run'
const userMessageId = 'work-body-visibility-user'
const assistantMessageId = 'work-body-visibility-assistant'
const toolCallId = 'work-body-visibility-tool'
const finalText = '正文必须在过程收起时继续显示。'
const now = Date.now() - 5000
const ledgerChange: EngineFileChange = { id: 'work-body-visibility-report', sessionId, runId, turnId,
  path: '/remote/work-body-visibility/report.md', kind: 'write', oldContent: null, newContent: '# 已恢复的成果',
  truncated: false, status: 'kept', isNew: true, createdAt: now + 4 }

const run: RootRun = {
  schemaVersion: 1, sessionId, runId, turnId, userMessageId, assistantMessageId,
  seq: 1, version: 1, status: 'succeeded', modelId: model, pending: [], workspacePaths: [],
  createdAt: now, updatedAt: now + 100, finishedAt: now + 100
}

// The assistant rows share a turn/run identity, so replayMessages merges the
// process narration, tool receipt and final prose into one durable assistant.
// No metadata.finalResult is supplied: this is the exact persisted state in
// which the root run is done but its immutable answer manifest has not arrived.
const history: EngineHistoryRow[] = [
  { id: userMessageId, role: 'user', content: '请完成这项工作并给出结果。', conversationId: turnId,
    createdAt: now, metadata: { runId, turnId } },
  { id: assistantMessageId, role: 'assistant', content: '正在检查工作区。', conversationId: turnId,
    createdAt: now + 1, metadata: { runId, turnId },
    toolCall: { id: toolCallId, name: 'read_file', args: { path: 'report.md' } } },
  { id: `${toolCallId}-result`, role: 'tool', content: '文件读取完成。', toolCallId: toolCallId,
    conversationId: turnId, createdAt: now + 2, metadata: { success: true } },
  { id: `${assistantMessageId}-tail`, role: 'assistant', content: finalText, conversationId: turnId,
    createdAt: now + 3, metadata: { runId, turnId } }
]

// Keep the fixture honest: the same replay/apply path used by recovery must
// attach the succeeded root identity. Without this guard a malformed fixture
// could accidentally exercise the legacy no-run fallback and pass the UI
// assertion without covering the missing-manifest regression.
const replayedAssistant = applyRootRuns(replayMessages(history), [run]).find(message => message.role === 'assistant')
if (!replayedAssistant?.run || replayedAssistant.run.status !== 'succeeded' || replayedAssistant.runId !== runId) {
  throw new Error('Body-visibility fixture failed to attach its succeeded root run')
}

const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const errors: string[] = []
let server: ReturnType<typeof createServer> | undefined
let app: ElectronApplication | undefined
let page: Page
let health: ElectronHealthMonitor | undefined
let fixture = ''

test.describe.serial('Work 正文在过程收起时保持可见（全新专项）', () => {
  test.beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
          response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null))
          return
        }
        let raw = ''
        for await (const chunk of request) raw += String(chunk)
        if (path === '/api/v1/chat/stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
          return
        }
        response.setHeader('content-type', 'application/json')
        const data = path === '/health' ? { status: 'ok' }
          : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'b'.repeat(64), protocolVersion: 1,
            toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-body-visibility' }
          : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '正文可见性测试模型',
            isEnabled: true, capabilities: { toolCalling: true } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', finished: true,
            eventId: null, projection: [], history, run, runs: [run], todos: [], changes: [], commandJobs: [] }
          : path === '/api/v1/chat/status' ? { running: false, finished: true, run }
          : path === '/api/v1/chat/runs' ? { runs: [run] }
          : path === '/api/v1/conversation/history' ? history
          : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: '正文可见性回归', lastAt: now, messageCount: history.length }]
          : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'fixture', sessionId,
            namespace: { id: 'work-body-visibility-db', generation: 'one' },
            transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
          : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
          : path === '/api/v1/memory/settings' ? { sessionId, memoryScope: 'session', effectiveScope: 'session', enabled: false }
          : path === '/api/v1/workspace/directory' ? { root: '/remote/work-body-visibility', entries: [] }
          : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
          : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
          : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
          : path === '/api/v1/command-jobs' ? { jobs: [] }
          : path === '/api/v1/changes' ? (url.searchParams.get('status') === 'pending' ? [] : [ledgerChange])
          : []
        response.end(envelope(data))
      })().catch(error => {
        errors.push(String(error))
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end(envelope(null))
      })
    })
    await new Promise<void>((resolveListen, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolveListen) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing body-visibility fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    const source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-body-visibility-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastModelId: model, appearance: 'light', lastFolder: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-body-visibility', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const task = { id: sessionId, title: '正文可见性回归', status: 'done', draft: '', createdAt: now, updatedAt: now,
      workspacePath: null, modelId: model, attachments: [], sources: [] }
    await page.evaluate(({ key, task }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id }))
      localStorage.setItem('aether.app.mode', 'work')
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: '正文可见性回归', exact: true })).toBeVisible()
  })

  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server?.closeAllConnections()
      await new Promise<void>(done => server?.close(() => done()))
      if (fixture) rmSync(resolve(fixture), { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('完成轮次默认收起过程，但正文仍可见且有实际布局高度', async () => {
    const conversation = page.locator('.work-view').getByRole('region', { name: '协作对话', exact: true })
    const assistant = conversation.locator('.work-message--assistant').last()
    await expect(assistant).toContainText(finalText)
    await expect(assistant.getByRole('button', { name: /^展开过程/ })).toHaveAttribute('aria-expanded', 'false')
    const answer = assistant.locator('.work-assistant-content').filter({ hasText: finalText }).last()
    await expect(answer).toBeVisible()
    await expect.poll(() => answer.evaluate(element => element.getBoundingClientRect().height), { message: '收起过程不能将正文折叠为零高度' }).toBeGreaterThan(0)
    await expect(answer).not.toHaveAttribute('aria-hidden', 'true')
  })

  test('服务按钮位于对话侧栏，打开后显示简洁服务弹层', async () => {
    const serviceButton = page.getByRole('button', { name: '查看后台服务', exact: true })
    await expect(serviceButton).toBeVisible()
    await serviceButton.click()
    const tray = page.getByRole('complementary', { name: '后台服务', exact: true })
    await expect(tray).toBeVisible()
    await expect(tray).toContainText('没有正在运行的服务')
    await page.getByRole('button', { name: '关闭后台服务', exact: true }).click()
    await expect(tray).not.toBeVisible()
  })

  test('没有最终交付清单时，成果仍显示真实文件改动树', async () => {
    const open = page.getByRole('button', { name: '打开工作区', exact: true })
    if (await open.isVisible()) await open.click()
    const workspace = page.getByRole('region', { name: '任务工作区', exact: true })
    await workspace.getByRole('tab', { name: '成果', exact: true }).click()
    const results = workspace.getByRole('region', { name: '本会话成果', exact: true })
    await expect(results).toHaveAttribute('data-final-result-fallback', 'changes')
    await expect(results.getByRole('tree', { name: '本会话文件树', exact: true })).toContainText('report.md')
  })
})
