import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { SubagentEvent, SubagentRun } from '../src/shared/subagent'
import { SubagentProvider, SUBAGENT_PROBES as probes } from './helpers/subagent-provider'

/**
 * 真机子代理闭环：本地 OpenAI HTTP 服务 → 真实 ReAct/subagent/read_file → 持久化
 * → HTTP SSE → Electron IPC → 卡片。覆盖并发首请求 400、工具详情、单独取消真实
 * provider 连接、兄弟隔离、root-only 历史、切换/重启回放及 Markdown 导出。
 * 同时检查 IDE 的 code profile 经普通 IPC 与 SSE 请求进入实际工具列表和模型请求。
 * 不注入子任务结果、不用真实凭证。运行前构建 IDE 与同级引擎的 dist/main.js；workers=1。
 */
const APP_ROOT = resolve(__dirname, '..')
const ENGINE_ROOT = resolve(APP_ROOT, '..', 'ai-agent-engine')
const ENGINE_ENTRY = join(ENGINE_ROOT, 'dist', 'main.js')
const FIXTURE_ROOT = join(APP_ROOT, '.e2e-tmp', 'subagent-lifecycle')
const WORKSPACE = join(FIXTURE_ROOT, 'workspace')
const USER_DATA = join(FIXTURE_ROOT, 'user-data')
const DB_PATH = join(USER_DATA, 'engine', 'state', 'agent.db')
const SESSION_ID = 'e2e-subagent-lifecycle-12403'
const ENGINE_URL = 'http://127.0.0.1:12403'
const TEST_KEY = 'e2e-local-provider-no-real-credential'
const ENCRYPTION_KEY = 'a'.repeat(64)
const NON_CODE_TOOLS = new Set([
  'remember', 'recall', 'search_memory', 'list_memories', 'forget', 'link_memories',
  'install_package', 'list_packages', 'calculate', 'get_time'
])

declare global {
  interface Window {
    aether: AetherIdeApi
    captureSubagentEvent(event: SubagentEvent): Promise<void>
    captureEngineLog(entry: unknown): Promise<void>
  }
}

const provider = new SubagentProvider()
const liveEvents: SubagentEvent[] = []
const engineLogs: unknown[] = []
const rendererErrors: string[] = []
const completed = new Map<string, SubagentRun>()
let app: ElectronApplication | undefined
let page: Page

function cleanupFixtures(): void {
  // Never let a computed cleanup path escape this spec's dedicated fixture directory.
  const root = resolve(FIXTURE_ROOT)
  if (
    !root.startsWith(resolve(APP_ROOT, '.e2e-tmp') + sep) ||
    !root.endsWith(sep + 'subagent-lifecycle')
  ) {
    throw new Error(`Unsafe fixture path: ${root}`)
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AETHER_IDE_ENGINE_ENTRY: ENGINE_ENTRY,
    AUTH_ENABLED: 'false',
    LLM_PROVIDER: 'openai',
    LLM_PRIMARY_MODEL: probes.model,
    LLM_MODEL: probes.model,
    LLM_FALLBACK_MODEL: '',
    OPENAI_API_KEY: TEST_KEY,
    OPENAI_BASE_URL: provider.baseUrl,
    DEFAULT_SECURITY_MODE: 'standard',
    OSM_MODE: 'methodology',
    HISTORY_BACKEND: 'jsonl',
    WORKSPACE_ROOT: join(FIXTURE_ROOT, 'sandboxes'),
    AETHER_GLOBAL_DIR: join(FIXTURE_ROOT, 'global'),
    MCP_CONFIG_PATH: join(FIXTURE_ROOT, 'mcp.json'),
    TOKEN_BUDGET: '200000',
    HISTORY_MAX_TOKENS: '100000',
    AGENT_TOTAL_TOKEN_LIMIT: '',
    SUBAGENT_TOKEN_LIMIT: '',
    MAX_ITERATIONS: '8',
    ENABLE_LONG_TERM_MEMORY: 'false'
  }
}

function prepareFixtures(): void {
  cleanupFixtures()
  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(join(USER_DATA, 'engine'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'probe.txt'), probes.fileContent, 'utf8')
  writeFileSync(join(FIXTURE_ROOT, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8')
  writeFileSync(
    join(USER_DATA, 'engine', 'engine-secrets.json'),
    JSON.stringify({
      encrypted: false,
      encryptionKey: ENCRYPTION_KEY
    }),
    'utf8'
  )
  writeFileSync(
    join(USER_DATA, 'settings.json'),
    JSON.stringify({
      engineMode: 'embedded',
      preferredPort: 12403,
      autoStartEngine: true,
      remoteBaseUrl: '',
      lastSessionId: SESSION_ID,
      lastAgentId: '',
      lastModelId: probes.model,
      subagentModelId: probes.model,
      utilityModelId: probes.model,
      thinkingMode: 'off',
      lastFolder: WORKSPACE
    }),
    'utf8'
  )

  // The public model-management route deliberately rejects loopback URLs. Seed only configuration
  // through the real storage API, before launch, rather than weakening its SSRF protection.
  const moduleUrl = (path: string): string => pathToFileURL(join(ENGINE_ROOT, 'dist', path)).href
  const script = `
    const { initDb, getDb } = await import(${JSON.stringify(moduleUrl('storage/sqlite/db.js'))});
    const { ModelsStore } = await import(${JSON.stringify(moduleUrl('storage/sqlite/models.js'))});
    const { systemConfigStore } = await import(${JSON.stringify(moduleUrl('storage/sqlite/system-config.js'))});
    await initDb();
    await new ModelsStore().createModel({
      tenantId: 'default', provider: 'openai', modelId: ${JSON.stringify(probes.model)},
      apiKey: ${JSON.stringify(TEST_KEY)}, baseUrl: ${JSON.stringify(provider.baseUrl)},
      displayName: 'E2E local provider', isEnabled: true,
      capabilities: { toolCalling: true, parallelTools: true, streamUsage: true, contextWindow: 128000 }
    });
    const config = ${JSON.stringify(
      Object.fromEntries(
        Object.entries(runtimeEnvironment()).filter(([key]) =>
          [
            'AUTH_ENABLED',
            'LLM_PROVIDER',
            'LLM_PRIMARY_MODEL',
            'LLM_MODEL',
            'OPENAI_API_KEY',
            'OPENAI_BASE_URL',
            'DEFAULT_SECURITY_MODE',
            'OSM_MODE',
            'HISTORY_BACKEND',
            'WORKSPACE_ROOT',
            'AETHER_GLOBAL_DIR',
            'MCP_CONFIG_PATH',
            'TOKEN_BUDGET',
            'HISTORY_MAX_TOKENS',
            'MAX_ITERATIONS',
            'ENABLE_LONG_TERM_MEMORY'
          ].includes(key)
        )
      )
    )};
    for (const [key, value] of Object.entries(config)) await systemConfigStore.set(key, value, key === 'OPENAI_API_KEY');
    getDb().close();
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: FIXTURE_ROOT,
    env: { ...runtimeEnvironment(), DATA_DIR: DB_PATH, ENCRYPTION_KEY },
    encoding: 'utf8',
    timeout: 30_000
  })
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${USER_DATA}`],
    cwd: APP_ROOT,
    env: runtimeEnvironment()
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.exposeFunction('captureSubagentEvent', (event: SubagentEvent) => {
    liveEvents.push(event)
  })
  await page.exposeFunction('captureEngineLog', (entry: unknown) => {
    engineLogs.push(entry)
  })
  await page.evaluate(() => {
    const target = window
    target.aether.engine.onStreamEvent((event) => {
      if (event.type === 'payload' && event.payload.subagentEvent) {
        void target.captureSubagentEvent(event.payload.subagentEvent)
      }
    })
    target.aether.engine.onLog((entry) => {
      void target.captureEngineLog(entry)
    })
  })
  await expect(page.locator('.workbench')).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
  expect(snapshot.baseUrl).toBe(ENGINE_URL)
  expect(snapshot.adopted, '必须启动自己的引擎，不能误用开发机现有进程').toBe(false)
  expect(snapshot.entryPath).toBe(ENGINE_ENTRY)
  expect(snapshot.dataDir).toBe(DB_PATH)
}

async function engineGet<T>(path: string): Promise<T> {
  const result = await page.evaluate(async (requestPath) => {
    const url = new URL(requestPath, 'http://fixture.invalid')
    return window.aether.engine.request({ method: 'GET', path: url.pathname.replace(/^\/api\/v1/, ''), query: Object.fromEntries(url.searchParams) })
  }, path)
  expect(result.ok, result.message).toBe(true)
  return result.data as T
}

async function runs(): Promise<SubagentRun[]> {
  return engineGet(`/api/v1/subagent/runs?parentSessionId=${encodeURIComponent(SESSION_ID)}`)
}

async function waitRun(marker: string, status: SubagentRun['status']): Promise<SubagentRun> {
  await expect
    .poll(async () => (await runs()).find((run) => run.task.includes(marker))?.status, {
      timeout: 45_000,
      message: `${marker} 应持久化为 ${status}`
    })
    .toBe(status)
  const run = (await runs()).find((item) => item.task.includes(marker))
  if (!run) throw new Error(`Missing run: ${marker}`)
  return run
}

async function send(text: string): Promise<void> {
  await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true')
  await page.locator('.chat__input').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

async function expandGroups(): Promise<void> {
  // Reload restores history asynchronously; .all() on the first frame can otherwise see no groups.
  await expect(page.locator('.subagent-group__head').first()).toBeVisible()
  for (const group of await page.locator('.subagent-group__head').all()) {
    if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
  }
}

async function card(run: SubagentRun): Promise<Locator> {
  await expandGroups()
  const locator = page.locator(`.subagent-card[data-run-id="${run.runId}"]`)
  await expect(locator).toBeVisible()
  if ((await locator.getAttribute('open')) === null)
    await locator.locator(':scope > summary').click()
  return locator
}

async function assertRootSessions(): Promise<void> {
  const sessions = await engineGet<Array<{ sessionId: string }>>('/api/v1/conversation/sessions')
  expect(sessions.map((session) => session.sessionId)).toEqual([SESSION_ID])
  const childIds = (await runs()).map((run) => run.childSessionId)
  expect(childIds.length).toBeGreaterThan(0)
  expect(sessions.some((session) => childIds.includes(session.sessionId))).toBe(false)
}

function assertCodeProfile(names: string[]): void {
  expect(names.filter(name => NON_CODE_TOOLS.has(name) || /^(cron_|agent_|task_)/.test(name)),
    'IDE code profile 不应把系统管理、长期记忆或通用计算工具暴露给模型').toEqual([])
}

function dispatchedToolNames(marker: string): string[] {
  const request = provider.requests.find(item => {
    // Memory keyword extraction has only a user message and deliberately no tools.
    if (!item.messages.some(message => message.role === 'system')) return false
    const user = [...item.messages].reverse().find(message => message.role === 'user')
    return typeof user?.content === 'string' && user.content.includes(marker)
  })
  if (!request) throw new Error(`Missing actual provider request for ${marker}`)
  const names = (request.tools ?? []).map(tool => tool.function.name)
  expect(names.length, `${marker} 必须携带真实工具 schema`).toBeGreaterThan(0)
  return names
}

test.describe.serial('子代理：真实引擎 / HTTP / IPC 生命周期', () => {
  test.beforeAll(async () => {
    if (!existsSync(join(APP_ROOT, 'out', 'main', 'index.js')) || !existsSync(ENGINE_ENTRY)) {
      throw new Error('请先构建 IDE 与同级 ai-agent-engine/dist/main.js')
    }
    await provider.start()
    prepareFixtures()
    await launch()
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('subagent-provider-and-events', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            requests: provider.requests,
            providerErrors: provider.errors,
            liveEvents,
            rendererErrors,
            engineLogs: engineLogs.slice(-150)
          },
          null,
          2
        )
      })
    }
  })

  test.afterAll(async () => {
    try {
      await app?.close()
    } finally {
      await provider.close()
      cleanupFixtures()
    }
  })

  test('同轮成功与首请求400：即时独立终态、真实工具详情、失败不显示成功', async () => {
    // Use the real preload/main request path so a missing IDE profile header cannot be masked by test HTTP headers.
    const tools = await page.evaluate(() => window.aether.engine.request<Array<{ name: string }>>({
      method: 'GET', path: '/tools', query: { current: 1, pageSize: 1000 }
    }))
    expect(tools.ok, tools.message).toBe(true)
    expect(Array.isArray(tools.data)).toBe(true)
    const listedNames = (tools.data ?? []).map(tool => tool.name)
    assertCodeProfile(listedNames)
    expect(listedNames).toEqual(expect.arrayContaining([
      'read_file', 'write_file', 'execute_cmd', 'grep_search', 'subagent',
      'web_fetch', 'ask_user', 'list_skills'
    ]))

    await send(`${probes.round} 并行启动一个读取成功任务与一个首请求失败任务。`)
    await expect.poll(() => provider.waiting('success'), { timeout: 45_000 }).toBe(true)
    const failed = await waitRun(probes.failure, 'failed')
    const pendingSuccess = await waitRun(probes.success, 'running')
    completed.set(probes.failure, failed)

    const parentTools = dispatchedToolNames(probes.round)
    assertCodeProfile(parentTools)
    expect(parentTools).toEqual(expect.arrayContaining([
      'subagent', 'read_file', 'grep_search', 'execute_cmd'
    ]))
    for (const marker of [probes.success, probes.failure]) {
      const childTools = dispatchedToolNames(marker)
      assertCodeProfile(childTools)
      expect(childTools).toContain('read_file')
      expect(childTools.filter(name => [
        'subagent', 'ask_user', 'write_file', 'delete_file', 'create_dir', 'execute_cmd'
      ].includes(name)), '默认只读子任务不能因 code profile 扩大权限').toEqual([])
    }

    expect(failed.error?.message).toContain(probes.failureReason)
    expect(failed.toolCalls).toHaveLength(0)
    const failureCard = await card(failed)
    await expect(failureCard).toHaveAttribute('data-status', 'failed')
    await expect(failureCard.locator(':scope > summary')).toContainText('失败')
    await expect(failureCard.locator(':scope > summary')).not.toContainText('成功')
    await expect(failureCard.getByRole('alert')).toContainText(probes.failureReason)
    await expect(await card(pendingSuccess)).toHaveAttribute('data-status', 'running')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    expect(
      liveEvents.some((event) => event.runId === failed.runId && event.snapshot.status === 'failed')
    ).toBe(true)

    // Reload while one child is still waiting: the new viewer must reconcile persisted state
    // and resume the existing stream, without launching the task again.
    await page.reload()
    await page.evaluate(() => {
      window.aether.engine.onStreamEvent(event => {
        if (event.type === 'payload' && event.payload.subagentEvent)
          void window.captureSubagentEvent(event.payload.subagentEvent)
      })
    })
    await expect(await card(pendingSuccess)).toHaveAttribute('data-status', 'running')
    expect((await runs()).filter(run => run.task.includes(probes.success))).toHaveLength(1)
    expect(provider.waiting('success')).toBe(true)
    provider.release('success')
    const succeeded = await waitRun(probes.success, 'succeeded')
    completed.set(probes.success, succeeded)
    expect(succeeded.parentSessionId).toBe(SESSION_ID)
    expect(succeeded.parentToolCallId).not.toBe(failed.parentToolCallId)
    expect(succeeded.toolCalls).toEqual([
      expect.objectContaining({
        name: 'read_file',
        status: 'succeeded',
        output: expect.stringContaining(probes.fileContent)
      })
    ])
    expect(succeeded.resultSummary).toContain(probes.successOutput)
    expect(succeeded.usage.totalTokens, '默认累计用量超过50万仍应完成子任务和父总结').toBeGreaterThan(500_000)
    const successCard = await card(succeeded)
    await expect(successCard).toHaveAttribute('data-status', 'succeeded')
    const details = successCard.locator('.subagent-card__tools-list')
    if (!(await details.isVisible()))
      await successCard.getByRole('button', { name: /^执行详情/ }).click()
    await expect(details).toContainText('读取文件')
    const call = details.locator('.subagent-card__call')
    const callDetails = call.locator('.subagent-card__call-detail')
    if (!(await callDetails.isVisible()))
      await call.getByRole('button', { name: /读取文件/ }).click()
    await expect(callDetails).toContainText(probes.fileContent)
    await expect(page.locator('.chat__messages')).toContainText(probes.parentOutput)
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeHidden()
    await assertRootSessions()

    const failingRequests = provider.requests.filter((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes(probes.failure)
      )
    )
    expect(failingRequests, '400 不应重试整个子任务').toHaveLength(1)
    for (const request of provider.requests) {
      for (const message of request.messages.filter((item) => item.role === 'user')) {
        expect(
          typeof message.content,
          'task 必须只有一层 user message，不能把 Message[] 当 content'
        ).toBe('string')
      }
    }
    expect(provider.errors).toEqual([])
  })

  test('只取消一个子任务：上游连接断开，兄弟保持运行并可独立完成', async () => {
    await send(`${probes.cancelRound} 并行启动两个子任务，仅停止第一个。`)
    await expect
      .poll(() => provider.waiting('cancel') && provider.waiting('sibling'), { timeout: 45_000 })
      .toBe(true)
    const target = await waitRun(probes.cancel, 'running')
    const sibling = await waitRun(probes.sibling, 'running')
    const targetCard = await card(target)
    await targetCard.getByRole('button', { name: '停止子代理' }).click()
    const cancelled = await waitRun(probes.cancel, 'cancelled')
    completed.set(probes.cancel, cancelled)
    await expect
      .poll(() => provider.disconnected.has('cancel'), {
        timeout: 15_000,
        message: '取消应实际终止 provider HTTP 连接，不能只修改 UI 状态'
      })
      .toBe(true)
    await expect(targetCard).toHaveAttribute('data-status', 'cancelled')
    expect(cancelled.partialOutput).toContain(probes.partialOutput)
    expect((await runs()).find((run) => run.runId === sibling.runId)?.status).toBe('running')
    expect(provider.disconnected.has('sibling')).toBe(false)
    expect(provider.waiting('sibling')).toBe(true)
    await expect(await card(sibling)).toHaveAttribute('data-status', 'running')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()

    provider.release('sibling')
    const finishedSibling = await waitRun(probes.sibling, 'succeeded')
    completed.set(probes.sibling, finishedSibling)
    await expect(await card(finishedSibling)).toHaveAttribute('data-status', 'succeeded')
    await expect(page.locator('.chat__messages')).toContainText(probes.cancelParentOutput)
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeHidden()
    expect(
      liveEvents
        .filter((event) => event.runId === cancelled.runId)
        .map((event) => event.snapshot.status)
    ).toEqual(expect.arrayContaining(['cancelling', 'cancelled']))
    await assertRootSessions()
    expect(provider.errors).toEqual([])
  })

  test('切换历史并重启：归属、失败原因、步骤与导出保持一致', async () => {
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await expect(page.locator('.subagent-card')).toHaveCount(0)
    const historyButton = page.getByRole('button', { name: '会话历史', exact: true })
    if ((await historyButton.getAttribute('aria-pressed')) !== 'true') await historyButton.click()
    await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
    // New empty sessions remain visible as local placeholders; assert the real root separately.
    await assertRootSessions()
    const rootHistory = page.locator('.history-view__item').filter({ hasText: probes.round })
    await expect(rootHistory).toHaveCount(1)
    await rootHistory.click()
    await expect(page.locator('.chat__messages')).toContainText(probes.parentOutput)
    for (const run of completed.values())
      await expect(await card(run)).toHaveAttribute('data-status', run.status)

    const requestCount = provider.requests.length
    await app?.close()
    app = undefined
    await launch()
    await expect(page.locator('.chat__messages')).toContainText(probes.parentOutput)
    for (const before of completed.values()) {
      const after = await engineGet<SubagentRun>(`/api/v1/subagent/runs/${before.runId}`)
      expect(after.status).toBe(before.status)
      expect(after.parentToolCallId).toBe(before.parentToolCallId)
      expect(after.childSessionId).toBe(before.childSessionId)
      expect(after.toolCalls).toEqual(before.toolCalls)
      expect(after.error).toEqual(before.error)
      const replayed = await card(after)
      await expect(replayed).toHaveAttribute('data-status', before.status)
      if (after.error) await expect(replayed.getByRole('alert')).toContainText(after.error.message)
    }
    await assertRootSessions()
    expect(provider.requests.length, '浏览历史和重启不能重跑子任务').toBe(requestCount)

    await page.getByRole('button', { name: '多选', exact: true }).click()
    await page.getByRole('button', { name: '全选', exact: true }).click()
    const exportPath = join(FIXTURE_ROOT, 'subagent-export.md')
    if (!app) throw new Error('Electron application is unavailable for export')
    // Electron owns Blob downloads; choose the fixture destination before the native save dialog opens.
    await app.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path))
    }, exportPath)
    await page.getByRole('button', { name: '导出', exact: true }).click()
    let markdown = ''
    await expect.poll(() => {
      try { markdown = readFileSync(exportPath, 'utf8') }
      catch (error) {
        // Windows may expose the new file while Electron still holds its write handle.
        if (!['ENOENT', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        return ''
      }
      return markdown
    }, {
      timeout: 15_000,
      message: 'Electron 应将实际导出内容写入文件'
    }).toContain(probes.siblingOutput)
    expect(markdown).toContain(probes.failureReason)
    expect(markdown).toContain(probes.successOutput)
    expect(markdown).toContain(probes.siblingOutput)
    expect(markdown).toContain('read_file（成功）')
    expect(markdown).toMatch(/子代理[^\n]*\[child:failure\][^\n]*（失败）/)
    expect(markdown).toMatch(/子代理[^\n]*\[child:cancel\][^\n]*（已取消）/)
    expect(markdown).not.toMatch(/子代理[^\n]*\[child:failure\][^\n]*（成功）/)
    expect(rendererErrors).toEqual([])
    expect(provider.errors).toEqual([])
  })
})
