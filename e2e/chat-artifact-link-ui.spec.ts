/** Real Electron: delivery links and inline Markdown images read real local/remote
 * files, retain session boundaries, and survive history reload with keyboard previews. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
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
const imagePath = '图片/验收 截图 100% #标签+.png'
// A real 160 × 96 PNG keeps binary reads and browser decoding in the regression path.
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABgCAYAAACaJ3mZAAABLUlEQVR4nO3SoQ0CAQAEwe+/QQrAoBCED7injCPZEeNX7PF4fi9YOdYBtBmQKQMyZUCmDMiUAZkyIFMGZMqATBmQKQMyZUCmDMiUAZkyIFMGZMqATBmQKQMyZUCmDMiUAZkyIFMGZMqATBmQKQMydbzen6vodj/5AwbEgAbsMiAGNGCXATGgAbsMiAEN2GVADGjALgNiQAN2GRADGrDLgBjQgF0GxIAG7DIgBjRglwExoAG7DIgBDdhlQAxowC4DYkADdhkQAxqwy4AY0IBdBsSABuwyIAY0YJcBMaABuwyIAQ3YZUAMaMAuA2JAA3YZEAMasMuAGNCAXQbEgAbsMiAGNGCXATGgAbsMiAEN2GVADGjALgNiQAN2GRADGrDLgBjQgF0GxIAG7DIgUz+e/ulA2DaA7wAAAABJRU5ErkJggg=='
const imageBytes = Buffer.from(imageBase64, 'base64')
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
async function openAndPreview(app: ElectronApplication, page: Page, name: string, filename: string): Promise<void> {
  await page.locator('.message--assistant .md').getByRole('link', { name, exact: true }).click()
  await expect(page.locator('.editor-tab.is-active').filter({ hasText: filename })).toHaveCount(1)
  await expect(page.locator('.editor-tab').filter({ hasText: 'download?' })).toHaveCount(0)
  await expect(page.locator('.doc-view__source .view-lines').first()).toContainText('交付的五子棋')
  // HTML now runs in the native browser pane. Verify its real DOM and visible
  // surface instead of the retired document iframe preview.
  await page.getByRole('button', { name: '保存并在浏览器中运行', exact: true }).click()
  await expect.poll(() => app.evaluate(async ({ BrowserWindow, WebContentsView }, filename) => {
    const children = BrowserWindow.getAllWindows()[0].contentView.children
    for (const child of children) {
      if (!(child instanceof WebContentsView) || !child.getVisible() || child.getBounds().width <= 0) continue
      const url = child.webContents.getURL()
      if (!/^(?:https?:|aether-local:)/.test(url) || !decodeURIComponent(new URL(url).pathname).endsWith(`/${filename}`)) continue
      return child.webContents.executeJavaScript("document.querySelector('h1')?.textContent")
    }
    return null
  }, filename)).toBe('交付的五子棋')
}
async function markdownImage(page: Page, alt: string): Promise<Locator> {
  const preview = page.locator('.message--assistant .md .md-image').getByRole('button', { name: `放大查看 ${alt}`, exact: true })
  await expect(preview).toBeVisible()
  await expect.poll(() => preview.locator('img').evaluate(image => ({
    complete: (image as HTMLImageElement).complete,
    width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight
  }))).toEqual({ complete: true, width: 160, height: 96 })
  return preview
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
    mkdirSync(join(workspace, '图片'), { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(workspace, 'index.html'), documentHtml)
    writeFileSync(join(workspace, nested), documentHtml)
    writeFileSync(join(workspace, imagePath), imageBytes)
    const localAnswer = [answer, 'LOCAL_IMAGE_BEFORE：下面是实际文件中的图片。',
      `![本地绝对路径图片](<${join(workspace, imagePath).replace(/\\/g, '/')}>)`,
      `![本地相对路径图片](<${imagePath}>)`, `![本地交付协议图片](${link(imagePath)})`,
      `[![带链接图片](<${imagePath}>)](index.html)`,
      `- 生成结果\n  - ![嵌套列表图片](<${imagePath}>)`,
      'LOCAL_IMAGE_AFTER：图片与正文按原顺序展示。'].join('\n\n')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12451, autoStartEngine: true,
      lastSessionId: sessionId, lastFolder: workspace, thinkingMode: 'off'
    }))
    const env: NodeJS.ProcessEnv = { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
      AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', ENABLE_LONG_TERM_MEMORY: 'false',
      AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'),
      AETHER_ALLOWED_WORKSPACE_ROOTS: workspace,
      MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'),
      LLM_FALLBACK_MODEL: '', ENCRYPTION_KEY: 'd'.repeat(64) }
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    // Seed through real stores so snapshot replay attaches the owning run and its workspace.
    const seed = `
      const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {RootRunStore}=await import(${JSON.stringify(url('storage/root-runs/index.js'))});
      const {JSONLConversationHistory}=await import(${JSON.stringify(url('storage/conversation/jsonl-history.js'))});
      const {WorkspaceManager}=await import(${JSON.stringify(url('workspace/manager.js'))});
      await initDb();
      const store=new RootRunStore(); const history=new JSONLConversationHistory();
      const ctx={tenantId:'default',sessionId:${JSON.stringify(sessionId)}};
      new WorkspaceManager().bind(ctx,${JSON.stringify(workspace)});
      const run=await store.create(ctx.tenantId,ctx.sessionId,'fixture-model',[${JSON.stringify(workspace)}],{toolProfile:'code'});
      await history.append({id:run.userMessageId,role:'user',content:'交付五子棋文件',conversationId:run.turnId,metadata:{rootRunId:run.runId}},ctx);
      await history.append({id:run.assistantMessageId,role:'assistant',content:${JSON.stringify(localAnswer)},conversationId:run.turnId,metadata:{rootRunId:run.runId}},ctx);
      await store.update(ctx.tenantId,run.runId,{status:'succeeded',stopReason:'completed'});
      getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], {
      env: { ...env, DATA_DIR: database }, encoding: 'utf8', windowsHide: true, timeout: 30000
    })
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => { await app?.close(); cleanup(fixture) })

  test('真实下载协议链接打开 index.html 并预览，历史重载后仍可打开', async () => {
    await openAndPreview(app!, page, 'index.html', 'index.html')
    await page.reload()
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    await page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true }).click()
    await expect(page.locator('.editor-tab.is-active').filter({ hasText: 'index.html' })).toHaveCount(1)
    await expect(page.locator('.editor-tab').filter({ hasText: 'download?' })).toHaveCount(0)
  })
  test('嵌套中文和特殊字符文件名仅解码一次，跨会话与越界不创建标签', async () => {
    await openAndPreview(app!, page, '中文页面', '五子棋 100% #标签+.html')
    const count = await page.locator('.editor-tab').count()
    await page.locator('.message--assistant .md').getByRole('link', { name: '跨会话文件', exact: true }).click()
    await expect(page.getByText('文件链接不属于这条消息所在的会话，已阻止打开。', { exact: true })).toBeVisible()
    await page.locator('.message--assistant .md').getByRole('link', { name: '越界文件', exact: true }).click()
    await expect(page.getByText('文件链接指向工作区外或无效路径，已阻止打开。', { exact: true })).toBeVisible()
    await expect(page.locator('.editor-tab')).toHaveCount(count)
  })
  test('正文中的本地 PNG 支持中文特殊字符路径、放大与键盘，历史重载后仍可查看', async ({}, testInfo) => {
    for (const alt of ['本地绝对路径图片', '本地相对路径图片', '本地交付协议图片', '带链接图片', '嵌套列表图片']) await markdownImage(page, alt)
    await expect(page.locator('.message--assistant .md li li .md-image img')).toHaveAttribute('alt', '嵌套列表图片')
    const body = page.locator('.message--assistant .md')
    const preview = await markdownImage(page, '本地绝对路径图片')
    expect(await body.evaluate(element => {
      const images = [...element.querySelectorAll('.md-image')]
      const paragraphs = [...element.querySelectorAll('p')]
      const before = paragraphs.find(p => p.textContent?.includes('LOCAL_IMAGE_BEFORE'))
      const after = paragraphs.find(p => p.textContent?.includes('LOCAL_IMAGE_AFTER'))
      return Boolean(before && after && images.length === 5 &&
        before.compareDocumentPosition(images[0]) & Node.DOCUMENT_POSITION_FOLLOWING &&
        images[4].compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    const editorTabs = await page.locator('.editor-tab').count()
    await preview.click()
    const dialog = page.getByRole('dialog', { name: '本地绝对路径图片', exact: true })
    await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(160)
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(preview).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(1)
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalHeight)).toBe(96)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(preview).toBeFocused()
    await expect(page.locator('.editor-tab')).toHaveCount(editorTabs)
    const linked = await markdownImage(page, '带链接图片')
    const activeTabs = () => page.locator('.editor-tab.is-active').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('data-tab-key')))
    const activeTabsBefore = await activeTabs()
    await linked.click()
    const linkedDialog = page.getByRole('dialog', { name: '带链接图片', exact: true })
    await expect(linkedDialog).toBeVisible()
    await expect.poll(() => linkedDialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(160)
    await expect(page.locator('.editor-tab')).toHaveCount(editorTabs)
    await linkedDialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(linkedDialog).toHaveCount(0)
    await expect(linked).toBeFocused()
    await expect(page.locator('.editor-tab')).toHaveCount(editorTabs)
    expect(await activeTabs()).toEqual(activeTabsBefore)
    await body.screenshot({ path: testInfo.outputPath('local-markdown-images.png'), animations: 'disabled' })
    await page.reload()
    for (const alt of ['本地绝对路径图片', '本地相对路径图片', '本地交付协议图片', '带链接图片', '嵌套列表图片']) await markdownImage(page, alt)
    await expect(body).toContainText('LOCAL_IMAGE_AFTER')
    expect(await body.innerText()).not.toContain('data:image/png;base64')
  })
})

test.describe.serial('远端会话交付链接', () => {
  let fixture = '', app: ElectronApplication | undefined, server: Server | undefined, page: Page
  let selectedSessionKey = ''
  const token = 'artifact-link-fixture-instance-token'
  const reads: Array<{ path: string | null; sessionId: string | null }> = []
  const snapshotSessions: Array<string | null> = []
  const rendererErrors: string[] = []
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
    const localOnlyImage = join(fixture, '仅本机图片 不可跨来源.png')
    writeFileSync(localOnlyImage, imageBytes)
    history[1].content = [answer, 'REMOTE_IMAGE_BEFORE：只读取这条消息所属的远端文件。',
      `![远端交付协议图片](${link(imagePath)})`, `![远端相对路径图片](<${imagePath}>)`,
      `![远端绝对路径图片](<${workspace}/${imagePath}>)`,
      `![禁止本机回退图片](<${localOnlyImage.replace(/\\/g, '/')}>)`,
      `![禁止跨会话图片](${link('foreign-image.png', 'foreign-session')})`,
      `![禁止越界图片](${link('../outside-image.png')})`,
      'REMOTE_IMAGE_AFTER：越界来源不应生成缩略图。'].join('\n\n')
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
        case '/api/v1/subagent/capabilities':
          response.writeHead(404); response.end(JSON.stringify({ code: 40400, message: 'Legacy fixture has no subagent v2 API' })); return
        case '/api/v1/chat/admission/context': {
          const requestedSession = url.searchParams.get('sessionId') ?? ''
          const current = requestedSession === sessionId ? { ...run, attemptId: `attempt-${run.runId}` } : null
          send({ protocolVersion: 1, tenantId: 'default', sessionId: requestedSession,
            namespace: { id: 'artifact-link-fixture', generation: 'one' },
            transport: { toolProfile: request.headers['x-aether-tool-profile'] || 'code', runLifetime: 'durable', subagentProtocol: 1 },
            root: current, predecessor: current ? { runId: current.runId, attemptId: current.attemptId, version: current.version } : null }); return
        }
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
        case '/api/v1/workspace/file/content': {
          reads.push({ path: url.searchParams.get('path'), sessionId: url.searchParams.get('sessionId') })
          if (url.searchParams.get('sessionId') !== sessionId || !['index.html', nested, imagePath].includes(url.searchParams.get('path') ?? '')) {
            response.writeHead(403); response.end(JSON.stringify({ code: 40300, message: 'Image fixture rejected an out-of-scope read' })); return
          }
          if (url.searchParams.get('path') === imagePath) {
            send({ content: imageBase64, isBinary: true, totalSize: imageBytes.length, truncated: false, root: workspace }); return
          }
          send({ content: documentHtml, isBinary: false, totalSize: Buffer.byteLength(documentHtml), truncated: false }); return
        }
        default: send([])
      }
    })
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing remote fixture address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl,
      remoteWorkspaceRoot: workspace, autoStartEngine: true, lastSessionId: '', lastFolder: '', thinkingMode: 'high' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env: {
      ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global'), ENABLE_LONG_TERM_MEMORY: 'false'
    } })
    page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(error.message))
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
    for (const alt of ['远端交付协议图片', '远端相对路径图片', '远端绝对路径图片']) await markdownImage(page, alt)
    expect(await page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
    expect(await page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)).toBe('')
    await expect(page.locator('.mode-surface[data-mode="code"] .model-picker .select__trigger')).toHaveAttribute('title', '当前模型：fixture-model')
    expect(await page.evaluate(async () => (await window.aether.settings.get()).lastModelId)).toBe('')
  })
  test.afterAll(async () => {
    await app?.close(); server?.closeAllConnections()
    if (server) await new Promise<void>(done => server!.close(() => done()))
    cleanup(fixture)
    expect(rendererErrors).toEqual([])
  })
  test('远端交付文件通过绑定会话的认证 content 接口读取，未降级本机文件服务', async () => {
    await page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText('index.html')
    await expect(page.locator('.doc-view__source .view-lines').first()).toContainText('交付的五子棋')
    expect(reads).toContainEqual({ path: 'index.html', sessionId })
    await expect(page.locator('.editor-tab').filter({ hasText: 'download?' })).toHaveCount(0)
    const before = reads.length
    await page.locator('.message--assistant .md').getByRole('link', { name: '跨会话文件', exact: true }).click()
    await expect(page.locator('.toast-host__text').filter({ hasText: '文件链接不属于这条消息所在的会话，已阻止打开。' })).toBeVisible()
    expect(reads).toHaveLength(before)
  })
  test('远端正文 PNG 按消息会话认证读取，越界图片不请求且不回退本机，历史重载后保持可见', async ({}, testInfo) => {
    const body = page.locator('.message--assistant .md')
    for (const alt of ['远端交付协议图片', '远端相对路径图片', '远端绝对路径图片']) await markdownImage(page, alt)
    expect(reads).toContainEqual({ path: imagePath, sessionId })
    for (const alt of ['禁止本机回退图片', '禁止跨会话图片', '禁止越界图片']) {
      const status = body.getByRole('status', { name: alt, exact: true })
      await expect(status).toBeVisible()
      await expect(status).not.toContainText('正在加载图片…')
      await expect(body.getByRole('button', { name: `放大查看 ${alt}`, exact: true })).toHaveCount(0)
      await expect(body.getByRole('img', { name: alt, exact: true })).toHaveCount(0)
      await expect(body).toContainText(alt)
    }
    expect(reads.filter(read => read.sessionId !== sessionId || !['index.html', nested, imagePath].includes(read.path ?? ''))).toEqual([])
    const preview = await markdownImage(page, '远端交付协议图片')
    await preview.press('Enter')
    const dialog = page.getByRole('dialog', { name: '远端交付协议图片', exact: true })
    await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(160)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(preview).toBeFocused()
    await body.screenshot({ path: testInfo.outputPath('remote-markdown-images.png'), animations: 'disabled' })
    const readsBeforeReload = reads.filter(read => read.path === imagePath).length
    await page.reload()
    for (const alt of ['远端交付协议图片', '远端相对路径图片', '远端绝对路径图片']) await markdownImage(page, alt)
    await expect.poll(() => reads.filter(read => read.path === imagePath).length).toBeGreaterThan(readsBeforeReload)
    for (const alt of ['禁止本机回退图片', '禁止跨会话图片', '禁止越界图片']) {
      await expect(body.getByRole('status', { name: alt, exact: true })).not.toContainText('正在加载图片…')
      await expect(body.getByRole('img', { name: alt, exact: true })).toHaveCount(0)
      await expect(body).toContainText(alt)
    }
    expect(reads.filter(read => read.sessionId !== sessionId || !['index.html', nested, imagePath].includes(read.path ?? ''))).toEqual([])
    expect(await body.innerText()).not.toContain('data:image/png;base64')
  })
  test('修改普通对话设置仍保留远端选中会话与交付历史', async () => {
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await page.getByTitle('选择思考档位', { exact: true }).click()
    await page.getByRole('menuitem', { name: /^Off / }).click()
    await expect(page.getByTitle('选择思考档位', { exact: true })).toContainText('Off')
    const thinkingKey = selectedSessionKey.replace(/^aether:lastSessionId/, 'aether:sessionThinkingModes')
    await expect.poll(() => page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id], { key: thinkingKey, id: sessionId })).toBe('off')
    expect(await page.evaluate(async () => (await window.aether.settings.get()).thinkingMode)).toBe('high')
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
    expect(await page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)).toBe('')
    await page.reload()
    await expect(page.locator('.message--assistant .md').getByRole('link', { name: 'index.html', exact: true })).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), selectedSessionKey)).toBe(sessionId)
    await expect(page.locator('.mode-surface[data-mode="code"] .model-picker .select__trigger')).toHaveAttribute('title', '当前模型：fixture-model')
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(page.getByTitle('选择思考档位', { exact: true })).toContainText('Off')
    expect(await page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id], { key: thinkingKey, id: sessionId })).toBe('off')
    expect(await page.evaluate(async () => (await window.aether.settings.get()).thinkingMode)).toBe('high')
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
  })
})
