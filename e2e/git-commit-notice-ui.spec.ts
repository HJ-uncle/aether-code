/** Real Electron Work Git input + authenticated HTTP. Reproduces a failed
 * commit followed by an unrelated busy lease, and checks draft/replay safety.
 * All Git responses are fixture-owned; no user's repository is mutated. Build first. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { GitResult } from '../src/shared/git-types'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'git-commit-notice-token', model = 'git-commit-notice-model', sessionId = 'work-git-notice'
const workspace = '/remote/git-notice', epoch = 'git-notice-binding', title = '提交失败提示回归'
const draft = 'feat(subagent): 改进结果展示\n\n1. 保留中文说明。\n2. 保留完整正文与暂存文件。'
const errors: string[] = [], actions: Record<string, unknown>[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = ''
let failure: GitResult = { success: false, error: '提交说明不能包含控制字符', executionDisposition: 'not_started' }
let leaseBusy = false, acceptCommit = false, hasChanges = true, leaseReads = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks), parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  if (path === '/api/v1/git/action') {
    if (input.sessionId !== sessionId || input.expectedRoot !== workspace || input.bindingEpoch !== epoch || input.cwd !== '.')
      throw new Error(`Git action escaped its owner: ${JSON.stringify(input)}`)
    actions.push(input)
    if (input.op !== 'commit') throw new Error(`Unexpected Git mutation: ${String(input.op)}`)
    if (acceptCommit) { hasChanges = false; response.end(envelope({ success: true })); return }
    // A read can hold the lease by the time the UI inspects the failed write.
    leaseBusy = true
    response.end(JSON.stringify({ code: 50000, message: failure.error, data: failure })); return
  }
  if (path.startsWith('/api/v1/git/')) {
    const op = path.slice('/api/v1/git/'.length)
    // The mounted Code workbench may inspect its own UUID session while Work
    // is active. It has no fixture repository and must never issue a mutation.
    if (id !== sessionId) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error(`Unexpected Git session: ${id}`)
      const empty = op === 'binding' ? { root: workspace, epoch, contractVersion: 2, mutationRequiresBinding: true }
        : op === 'status' ? { success: true, isRepo: false, files: [] }
        : op === 'branch-info' ? { success: true, isRepo: false, info: null }
        : op === 'list-stashes' ? { success: true, stashes: [] }
        : op === 'log' || op === 'incoming' ? { success: true, commits: [] }
        : undefined
      if (empty === undefined) throw new Error(`Unexpected background Code Git read: ${op}`)
      response.end(envelope(empty)); return
    }
    const data = op === 'binding' ? { root: workspace, epoch, contractVersion: 2, mutationRequiresBinding: true }
      : op === 'lease' ? (leaseReads++, { success: true, lease: { busy: leaseBusy, recoverable: false } })
      : op === 'status' ? { success: true, isRepo: true, branch: 'dev', files: hasChanges ? [
        { path: 'staged.txt', changeType: 'modified', staged: true, stagedChange: 'modified', unstagedChange: null,
          binary: false, additions: 2, deletions: 1, stagedAdditions: 2, stagedDeletions: 1 }
      ] : [] }
      : op === 'branch-info' ? { success: true, isRepo: true, info: { branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 0 } }
      : op === 'list-stashes' ? { success: true, stashes: [] }
      : op === 'list-remotes' ? { success: true, remotes: [] }
      : op === 'list-branches' ? { success: true, branches: ['dev'], current: 'dev' }
      : op === 'list-remote-branches' ? { success: true, branches: [] }
      : op === 'log' || op === 'incoming' ? { success: true, commits: [] }
      : op === 'user-name' ? { success: true, name: 'Fixture User' }
      : op === 'list-authors' ? { success: true, authors: [] }
      : op === 'list-tags' ? { success: true, tags: [] }
      : undefined
    if (data === undefined) throw new Error(`Unexpected Git read: ${op}`)
    response.end(envelope(data)); return
  }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: input.workspaceRoot })); return }
  if (path === '/api/v1/chat/admission/receipt') { response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'git-commit-notice' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '提交提示测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'git-notice-tenant', sessionId: id,
      namespace: { id: 'git-notice-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: Date.now(), messageCount: 0 }]
    : path === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: epoch, entries: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const gitPanel = (): Locator => page.getByRole('region', { name: '任务 Git', exact: true })
const input = (): Locator => gitPanel().getByRole('textbox', { name: '提交信息', exact: true })
const notice = (): Locator => gitPanel().getByRole('region', { name: 'Git 操作状态', exact: true })
async function submit(): Promise<void> {
  await input().fill(draft)
  const before = actions.length, readsBefore = leaseReads
  await gitPanel().getByRole('button', { name: '提交', exact: true }).click()
  await expect.poll(() => actions.length).toBe(before + 1)
  await expect.poll(() => leaseReads).toBeGreaterThan(readsBefore)
  await expect(notice().getByRole('button', { name: '重新核对', exact: true })).toBeEnabled()
  expect(actions.at(-1)).toMatchObject({ op: 'commit', message: draft, sessionId, cwd: '.', expectedRoot: workspace, bindingEpoch: epoch })
}

test.describe.serial('Git 提交失败与后续占用状态', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'git-commit-notice-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: workspace, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'dark', thinkingMode: 'off' }))
    const launchEnv = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(launchEnv)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete launchEnv[key]
    launchEnv.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; launchEnv.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env: launchEnv })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => {
    actions.length = 0; leaseBusy = false; acceptCommit = false; hasChanges = true
    await page.evaluate(({ key, id, title, workspace, model }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id, title, status: 'done', draft: '', mentions: [], createdAt: Date.now(), updatedAt: Date.now(),
        workspacePath: workspace, modelId: model, attachments: [], sources: [] }], activeTaskId: id, homeSources: [] }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether:git:autoFetch:enabled', '0')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'git', pane: 'workspace', ratio: 35 }))
    }, { key: storageKey, id: sessionId, title, workspace, model })
    await page.reload(); await expect(input()).toBeVisible()
    await expect(gitPanel()).toContainText('staged.txt')
    await expect(notice()).toHaveCount(0)
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('git-commit-notice-failure.png')
      await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('git-notice-http', { body: JSON.stringify({ errors, actions, leaseReads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('git-commit-notice-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('提交说明被拒绝后，其他占用不能掩盖原因或清除草稿', async ({}, info) => {
    failure = { success: false, error: '提交说明不能包含控制字符', executionDisposition: 'not_started' }
    await submit()
    await expect(notice().locator('strong')).toHaveText('提交未完成')
    await expect(notice().locator('.git-repository-notice__error')).toHaveText(failure.error!)
    await expect(notice()).toContainText('当前状态：仓库正被其他操作占用')
    await expect(notice()).not.toContainText('可能已经产生修改')
    await expect(notice().getByRole('button', { name: '重试原操作', exact: true })).toHaveCount(0)
    await expect(input()).toHaveValue(draft)
    await notice().getByRole('button', { name: '刷新仓库', exact: true }).click()
    await expect(input()).toHaveValue(draft)
    expect(actions).toHaveLength(1)
    const path = info.outputPath('validation-failure-with-busy-lease.png')
    await page.screenshot({ path }); await info.attach('校验失败与后续占用', { path, contentType: 'image/png' })
  })

  for (const disposition of ['may_have_effects', undefined] as const) test(`不确定结果 ${disposition ?? 'legacy'} 保留核对提示且不自动重试`, async () => {
    failure = { success: false, error: 'message 无效', ...(disposition ? { executionDisposition: disposition } : {}) }
    await submit()
    await expect(notice().locator('strong')).toHaveText('提交未完成')
    await expect(notice().locator('.git-repository-notice__error')).toHaveText('message 无效')
    await expect(notice()).toContainText('可能已经产生修改')
    leaseBusy = false
    await notice().getByRole('button', { name: '重新核对', exact: true }).click()
    await expect(notice().getByRole('button', { name: '重新核对', exact: true })).toBeEnabled()
    await expect(notice().getByRole('button', { name: '重试原操作', exact: true })).toHaveCount(0)
    await expect(input()).toHaveValue(draft)
    expect(actions).toHaveLength(1)
  })

  test('真实占用拒绝只有解除占用后才允许用户重试原提交', async () => {
    failure = { success: false, error: 'Git repository is busy', errorCode: 'git-busy', executionDisposition: 'not_started' }
    await submit()
    await expect(notice().locator('strong')).toHaveText('仓库正在处理其他操作')
    await expect(notice()).not.toContainText('可能已经产生修改')
    await expect(notice().getByRole('button', { name: '重试原操作', exact: true })).toHaveCount(0)
    leaseBusy = false; acceptCommit = true
    await notice().getByRole('button', { name: '重新核对', exact: true }).click()
    await expect(notice().getByRole('button', { name: '重试原操作', exact: true })).toBeEnabled()
    expect(actions).toHaveLength(1)
    await notice().getByRole('button', { name: '重试原操作', exact: true }).click()
    await expect.poll(() => actions.length).toBe(2)
    expect(actions[1]).toEqual(actions[0])
    await expect(input()).toHaveValue('')
    await expect(notice()).toHaveCount(0)
  })

  test('成功提交完整传送多行中文正文并清空已提交草稿', async () => {
    acceptCommit = true
    await input().fill(draft)
    await gitPanel().getByRole('button', { name: '提交', exact: true }).click()
    await expect.poll(() => actions.length).toBe(1)
    expect(actions[0]).toMatchObject({ op: 'commit', message: draft, sessionId, cwd: '.', expectedRoot: workspace, bindingEpoch: epoch })
    await expect(input()).toHaveValue('')
    await expect(notice()).toHaveCount(0)
  })
})
