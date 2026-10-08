/** Real Electron: persisted engine delivery links open real local/remote files, survive reload and retain session boundaries. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const sessionId = 'artifact-link-session'
const nested = '页面/五子棋 100% #标签+.html'
const documentHtml = '<!doctype html><html><meta charset="utf-8"><body><h1>交付的五子棋</h1><p>黑棋先行，中文正常。</p></body></html>'
const link = (path: string, owner = sessionId) => '/api/v1/workspace/file/download?' + new URLSearchParams({ sessionId: owner, path })
const answer = [
  `[index.html](${link('index.html')})`, `[中文页面](${link(nested)})`,
  `[跨会话文件](${link('foreign.html', 'foreign-session')})`, `[越界文件](${link('../outside.html')})`
].join('\n\n')

function fixtureDirectory(prefix: string): string {
  mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
  return mkdtempSync(join(root, '.e2e-tmp', prefix))
}
function cleanup(fixture: string): void {
  if (!fixture) return
  const absolute = resolve(fixture)
  if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('artifact-link-')) throw new Error('Unsafe fixture cleanup')
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}
async function openAndPreview(page: Page, name: string, filename: string): Promise<void> {
  await page.locator('.message--assistant .md').getByRole('link', { name, exact: true }).click()
  await expect(page.locator('.editor-tab.is-active')).toContainText(filename)
  await expect(page.locator('.editor-tab').filter({ hasText: 'download?' })).toHaveCount(0)
  await expect(page.locator('.doc-view__source .view-lines').first()).toContainText('交付的五子棋')
  await page.getByRole('button', { name: '分屏预览', exact: true }).click()
  await expect(page.frameLocator('iframe[title="HTML 预览内容"]').getByRole('heading', { name: '交付的五子棋', exact: true })).toBeVisible()
}

test.describe.serial('本地会话交付链接', () => {
  let fixture = '', app: ElectronApplication | undefined, page: Page
  const errors: string[] = []
  test.beforeAll(async () => {
    fixture = fixtureDirectory('artifact-link-local-')
    const workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    const database = join(profile, 'engine', 'state', 'agent.db')
    mkdirSync(join(workspace, '页面'), { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(workspace, 'index.html'), documentHtml)
    writeFileSync(join(workspace, nested), documentHtml)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12451, autoStartEngine: true,
      lastSessionId: sessionId, lastFolder: workspace, thinkingMode: 'off'
    }))
    const env: NodeJS.ProcessEnv = { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
      AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', ENABLE_LONG_TERM_MEMORY: 'false',
      AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'),
      MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'),
      LLM_FALLBACK_MODEL: '', ENCRYPTION_KEY: 'd'.repeat(64) }
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    // Seed through real stores so snapshot replay attaches the owning run and its workspace.
    const seed = `
      const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {RootRunStore}=await import(${JSON.stringify(url('storage/root-runs/index.js'))});
      const {JSONLConversationHistory}=await import(${JSON.stringify(url('storage/conversation/jsonl-history.js'))});
      await initDb();
      const store=new RootRunStore(); const history=new JSONLConversationHistory();
      const ctx={tenantId:'default',sessionId:${JSON.stringify(sessionId)}};
      const run=await store.create(ctx.tenantId,ctx.sessionId,'fixture-model',[${JSON.stringify(workspace)}],{toolProfile:'code'});
      await history.append({id:run.userMessageId,role:'user',content:'交付五子棋文件',conversationId:run.turnId,metadata:{rootRunId:run.runId}},ctx);
      await history.append({id:run.assistantMessageId,role:'assistant',content:${JSON.stringify(answer)},conversationId:run.turnId,metadata:{rootRunId:run.runId}},ctx);
      await store.update(ctx.tenantId,run.runId,{status:'succeeded',stopReason:'completed'});
      getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], {
      env: { ...env, DATA_DIR: database }, encoding: 'utf8', windowsHide: true, timeout: 30000
    })
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => { await app?.close(); cleanup(fixture) })

  test('真实下载协议链接打开 index.html 并预览，历史重载后仍可打开', async () => {
    await openAndPreview(page, 'index.html', 'index.html')
    await page.reload()
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    await page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText('index.html')
    await expect(page.locator('.editor-tab').filter({ hasText: 'download?' })).toHaveCount(0)
  })
  test('嵌套中文和特殊字符文件名仅解码一次，跨会话与越界不创建标签', async () => {
    await openAndPreview(page, '中文页面', '五子棋 100% #标签+.html')
    const count = await page.locator('.editor-tab').count()
    await page.locator('.message--assistant .md').getByRole('link', { name: '跨会话文件', exact: true }).click()
    await expect(page.getByText('文件链接不属于这条消息所在的会话，已阻止打开。', { exact: true })).toBeVisible()
    await page.locator('.message--assistant .md').getByRole('link', { name: '越界文件', exact: true }).click()
    await expect(page.getByText('文件链接指向工作区外或无效路径，已阻止打开。', { exact: true })).toBeVisible()
    await expect(page.locator('.editor-tab')).toHaveCount(count)
  })
})

test.describe.serial('远端会话交付链接', () => {
  let fixture = '', app: ElectronApplication | undefined, server: Server | undefined, page: Page
  let selectedSessionKey = ''
  const token = 'artifact-link-fixture-instance-token'
  const reads: Array<{ path: string | null; sessionId: string | null }> = []
  const snapshotSessions: Array<string | null> = []
  const workspace = '/remote/artifact-project'
  const run: RootRun = { schemaVersion: 1, runId: 'artifact-run', sessionId, turnId: 'artifact-turn', userMessageId: 'artifact-user',
    assistantMessageId: 'artifact-assistant', seq: 1, version: 1, status: 'succeeded', modelId: 'fixture-model',
    workspacePaths: [workspace], createdAt: Date.now(), updatedAt: Date.now(), pending: [] }
  const history = [
    { id: run.userMessageId, role: 'user', content: '查看远端交付文件', conversationId: run.turnId, createdAt: Date.now() },
    { id: run.assistantMessageId, role: 'assistant', content: answer, conversationId: run.turnId, createdAt: Date.now(), metadata: { rootRunId: run.runId } }
  ]
  test.beforeAll(async () => {
    fixture = fixtureDirectory('artifact-link-remote-')
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid')
      const send = (data: unknown) => response.end(JSON.stringify({ code: 200, message: 'ok', data }))
      response.setHeader('Content-Type', 'application/json')
      if (url.pathname.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
        response.writeHead(401); response.end(JSON.stringify({ code: 40100, message: 'missing instance token' })); return
      }
      switch (url.pathname) {
        case '/health': send({ status: 'ok' }); return
        case '/meta': send({ version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'artifact-remote-fixture' }); return
        case '/api/v1/models': send([{ id: 'artifact-fixture-model', tenantId: 'default', provider: 'openai',
          modelId: 'fixture-model', apiKey: '...fixture', baseUrl: 'https://fixture.invalid/v1', displayName: '交付链接测试模型',
          isEnabled: true, capabilities: { thinking: true, toolCalling: true, contextWindow: 128000 },
          createdAt: run.createdAt, updatedAt: run.updatedAt }]); return
        case '/api/v1/chat/snapshot': {
          const requestedSession = url.searchParams.get('sessionId')
          snapshotSessions.push(requestedSession)
          const ownsHistory = requestedSession === sessionId
          send({ schemaVersion: 1, source: 'persisted', sessionId: requestedSession, eventId: null, finished: true,
            projection: [], runs: ownsHistory ? [run] : [], ...(ownsHistory ? { run } : {}),
            history: ownsHistory ? history : [], todos: [], changes: [], commandJobs: [] }); return
        }
        case '/api/v1/chat/runs': send({ runs: url.searchParams.get('sessionId') === sessionId ? [run] : [] }); return
        case '/api/v1/conversation/history': send(url.searchParams.get('sessionId') === sessionId ? history : []); return
        case '/api/v1/workspace/bind': send({ workspaceRoot: workspace }); return
        case '/api/v1/workspace/directory': send({ root: workspace, entries: [] }); return
        case '/api/v1/workspace/file/content':
          reads.push({ path: url.searchParams.get('path'), sessionId: url.searchParams.get('sessionId') })
          send({ content: documentHtml, isBinary: false, totalSize: Buffer.byteLength(documentHtml), truncated: false }); return
        default: send([])
      }
    })
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing remote fixture address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl,
      remoteWorkspaceRoot: workspace, autoStartEngine: true, lastSessionId: '', lastFolder: '', thinkingMode: 'high' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: {
      ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global'), ENABLE_LONG_TERM_MEMORY: 'false'
    } })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    // Remote selection belongs to the endpoint's localStorage, not the embedded
    // engine's settings.lastSessionId. Seed that real persistence contract, then
    // reload so AppProvider selects the fixture before chat history is restored.
    selectedSessionKey = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl }))
    await page.evaluate(({ key, sessionId }) => localStorage.setItem(key, sessionId), { key: selectedSessionKey, sessionId })
    await page.reload()
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
    await expect.poll(() => snapshotSessions).toContain(sessionId)
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
    expect(await page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)).toBe('')
    await expect.poll(() => page.evaluate(async () => (await window.aether.settings.get()).lastModelId)).toBe('fixture-model')
  })
  test.afterAll(async () => {
    await app?.close(); server?.closeAllConnections()
    if (server) await new Promise<void>(done => server!.close(() => done()))
    cleanup(fixture)
  })
  test('远端交付文件通过绑定会话的认证 content 接口读取，未降级本机文件服务', async () => {
    await page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText('index.html')
    await expect(page.locator('.doc-view__source .view-lines').first()).toContainText('交付的五子棋')
    expect(reads).toContainEqual({ path: 'index.html', sessionId })
    await expect(page.locator('.editor-tab').filter({ hasText: 'download?' })).toHaveCount(0)
    const before = reads.length
    await page.locator('.message--assistant .md').getByRole('link', { name: '跨会话文件', exact: true }).click()
    await expect(page.getByText('文件链接不属于这条消息所在的会话，已阻止打开。', { exact: true })).toBeVisible()
    expect(reads).toHaveLength(before)
  })
  test('修改普通对话设置仍保留远端选中会话与交付历史', async () => {
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await page.getByTitle('选择思考档位', { exact: true }).click()
    await page.getByRole('menuitem', { name: /^Off / }).click()
    await expect.poll(() => page.evaluate(async () => (await window.aether.settings.get()).thinkingMode)).toBe('off')
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
    expect(await page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)).toBe('')
    await page.reload()
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
  })
})
