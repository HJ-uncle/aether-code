/** Real Electron with authenticated HTTP and a disposable disk workspace:
 * partial rollback, retry/truncate, compact result disclosures and zero-item
 * results. Includes real disk assertions and wide/narrow light/dark screenshots. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { FinalResult } from '../src/shared/final-result'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const sessionId = 'work-rollback', title = '回退一致性验证', modelId = 'rollback-model', token = 'rollback-token'
const emptySessionId = 'work-rollback-empty', emptyTitle = '无文件改动的回退验证', emptyPrompt = '仅讨论方案，不修改文件'
const now = Date.now() - 10_000, remoteRoot = '/remote/rollback-project', fileName = '已交付报告.txt'
const content = 'IMMUTABLE_ASSET_MUST_DISAPPEAR_AFTER_ROLLBACK'
const run: RootRun = { schemaVersion: 1, runId: 'rollback-root', sessionId, turnId: 'rollback-turn', userMessageId: 'rollback-user',
  assistantMessageId: 'rollback-answer', seq: 1, version: 2, status: 'succeeded', modelId,
  pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
const emptyRun: RootRun = { ...run, sessionId: emptySessionId, runId: 'rollback-empty-root', turnId: 'rollback-empty-turn',
  userMessageId: 'rollback-empty-user', assistantMessageId: 'rollback-empty-answer' }
const manifest: FinalResult = { schemaVersion: 1, sessionId, turnId: run.turnId, runId: run.runId, assistantMessageId: run.assistantMessageId,
  text: '报告已经交付。', publishedAt: now, items: [{ id: 'report-item', assetId: 'report-asset', name: fileName, path: `${remoteRoot}/交付/${fileName}`,
    mimeType: 'text/plain', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), kind: 'file' }] }
const changes = [{ id: 'report', path: `${remoteRoot}/交付/${fileName}`, status: 'pending' },
  { id: 'generator', path: `${remoteRoot}/generator.js`, status: 'pending', requiresExplicitRevert: true }]
const errors: string[] = [], writes: string[] = [], emptyWrites: string[] = [], reads: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', disk = '', stage = 0
let emptyTruncated = false
test.describe.configure({ mode: 'serial' })
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function result(): FinalResult { return { ...manifest, items: stage > 0 ? [] : manifest.items } }
function history(id: string): EngineHistoryRow[] {
  if (id === emptySessionId) return emptyTruncated ? [] : [
    { id: emptyRun.userMessageId, role: 'user', content: emptyPrompt, createdAt: now, conversationId: emptyRun.turnId, metadata: { rootRunId: emptyRun.runId } },
    { id: emptyRun.assistantMessageId, role: 'assistant', content: '方案已说明，没有修改文件。', createdAt: now + 1,
      conversationId: emptyRun.turnId, metadata: { rootRunId: emptyRun.runId } }
  ]
  return id !== sessionId || stage === 2 ? [] : [
    { id: run.userMessageId, role: 'user', content: '请制作报告', createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: manifest.text, createdAt: now + 1, conversationId: run.turnId,
      metadata: { rootRunId: run.runId, finalResult: result() } }
  ]
}
function localPath(relative: string): string {
  const target = resolve(disk, relative || '.')
  if (target !== disk && !target.startsWith(disk + sep)) throw new Error('Fixture path escaped')
  return target
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Unauthenticated fixture request')
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (path === '/api/v1/changes/revert-preview') {
    if (body.sessionId === emptySessionId) {
      expect(body).toEqual({ sessionId: emptySessionId, fromTurnId: emptyRun.turnId, scope: 'all' })
      response.end(envelope({ total: 0, changes: [] })); return
    }
    expect(body).toEqual({ sessionId, fromTurnId: run.turnId, scope: 'all' })
    response.end(envelope({ total: changes.length, changes: changes.map(change => stage > 0 && change.id === 'report' ? { ...change, status: 'reverted' } : change) })); return
  }
  if (path === '/api/v1/changes/revert-batch') {
    if (body.sessionId === emptySessionId) {
      expect(body).toEqual({ sessionId: emptySessionId, fromTurnId: emptyRun.turnId, scope: 'all', reviewedCommandChangeIds: [] })
      emptyWrites.push(path)
      response.end(envelope({ total: 0, reverted: 0, conflicts: 0, unavailable: 0, failed: 0, results: [] })); return
    }
    expect(body).toEqual({ sessionId, fromTurnId: run.turnId, scope: 'all', reviewedCommandChangeIds: ['generator'] })
    writes.push(path)
    const first = stage === 0
    if (first) {
      rmSync(localPath(`交付/${fileName}`)); rmSync(localPath('交付'), { recursive: true })
      stage = 1
    } else rmSync(localPath('generator.js'))
    response.end(envelope({ total: 2, reverted: 1, conflicts: first ? 1 : 0, unavailable: 0, failed: 0,
      removedDirectories: first ? [`${remoteRoot}/交付`] : [], results: [
        { ...changes[0], status: first ? 'reverted' : 'already_reverted' },
        { ...changes[1], status: first ? 'conflict' : 'reverted', ...(first ? { message: 'generator.js 已由用户修改，请确认版本后重试。' } : {}) }
      ] })); return
  }
  if (path === '/api/v1/conversation/truncate') {
    if (body.sessionId === emptySessionId) {
      expect(body).toEqual({ sessionId: emptySessionId, messageId: emptyRun.userMessageId })
      expect(emptyWrites).toEqual(['/api/v1/changes/revert-batch'])
      emptyTruncated = true; emptyWrites.push(path); response.end(envelope({ success: true })); return
    }
    expect(body).toEqual({ sessionId, messageId: run.userMessageId }); expect(stage).toBe(1)
    expect(existsSync(localPath('generator.js'))).toBe(false)
    stage = 2; writes.push(path); response.end(envelope({ success: true })); return
  }
  if (path === '/api/v1/conversation/result-asset') {
    reads.push('asset')
    if (stage) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '交付物已撤回', data: null })); return }
    response.end(envelope({ content, isBinary: false, encoding: 'utf8', totalSize: Buffer.byteLength(content), mimeType: 'text/plain', tooLarge: false, truncated: false })); return
  }
  if (path === '/api/v1/changes') {
    const records = id === sessionId ? changes.map(change => ({ ...change, sessionId, turnId: run.turnId, runId: run.runId,
      kind: 'write', oldContent: null, newContent: change.id === 'report' ? content : '// generated', isNew: true, truncated: false,
      createdAt: now, status: stage === 2 || stage > 0 && change.id === 'report' ? 'reverted' : 'pending' })) : []
    response.end(envelope(url.searchParams.get('status') === 'pending' ? records.filter(change => change.status === 'pending') : records)); return
  }
  if (path === '/api/v1/workspace/file/content') {
    expect(id).toBe(sessionId)
    const relative = url.searchParams.get('path') ?? '', file = localPath(relative)
    reads.push(`file:${relative}`)
    if (!existsSync(file)) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '文件已撤回', data: null })); return }
    const text = readFileSync(file, 'utf8')
    response.end(envelope({ content: text, isBinary: false, totalSize: Buffer.byteLength(text), root: remoteRoot, bindingEpoch: 'one', truncated: false })); return
  }
  if (path === '/api/v1/workspace/directory') {
    const requested = url.searchParams.get('path') ?? ''
    const relative = requested === '.' ? '' : requested
    reads.push(`directory:${relative}`)
    const directory = localPath(relative)
    response.end(envelope({ root: remoteRoot, bindingEpoch: 'one', entries: readdirSync(directory).map(name => {
      const stat = statSync(join(directory, name))
      return { name, path: `${relative ? relative + '/' : ''}${name}`, isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs }
    }) })); return
  }
  const rows = history(id), matching = id === sessionId && stage < 2 ? run : id === emptySessionId && !emptyTruncated ? emptyRun : undefined
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
      preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: users.map(row => row.id),
      revision: `rollback-${id}-${stage}-${emptyTruncated}`, mutationRevision: `rollback-${id}-${stage}-${emptyTruncated}`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'rollback-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '回退测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...(stage === 2 ? [] : [{ sessionId, title, lastAt: now, messageCount: 2 }]),
      ...(emptyTruncated ? [] : [{ sessionId: emptySessionId, title: emptyTitle, lastAt: now, messageCount: 2 }])]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'rollback', sessionId: id,
      namespace: { id: 'rollback-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: remoteRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
async function setWindow(width: number, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(size.width, size.height); win.show(); win.focus() }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
  await page.locator('body').evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => undefined)))
  })
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
async function captureNotice(notice: Locator, phase: 'partial' | 'complete' | 'empty', info: TestInfo): Promise<void> {
  const before = { writes: [...writes], emptyWrites: [...emptyWrites] }
  for (const appearance of ['light', 'dark'] as const) {
    await setWindow(1560); await setAppearance(appearance)
    for (const width of [1560, 560]) {
      await setWindow(width)
      const conversation = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
      if (await conversation.isVisible()) await conversation.click()
      await expect(notice).toBeVisible()
      const geometry = await notice.evaluate(element => {
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height, overflow: element.scrollWidth - element.clientWidth,
          buttons: [...element.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect()
            return { name: button.getAttribute('aria-label'), left: rect.left - box.left, right: rect.right - box.right,
              top: rect.top - box.top, bottom: rect.bottom - box.bottom }
          }) }
      })
      expect(geometry.width).toBeGreaterThan(150); expect(geometry.overflow).toBeLessThanOrEqual(1)
      if (phase !== 'partial') expect(geometry.height).toBeLessThanOrEqual(128)
      for (const button of geometry.buttons) {
        expect(button.left, button.name ?? '').toBeGreaterThanOrEqual(-1)
        expect(button.right, button.name ?? '').toBeLessThanOrEqual(1)
        expect(button.top, button.name ?? '').toBeGreaterThanOrEqual(-1)
        expect(button.bottom, button.name ?? '').toBeLessThanOrEqual(1)
      }
      if (phase === 'partial') {
        await expect(notice.getByRole('button', { name: '逐文件结果', exact: true })).toHaveAttribute('aria-expanded', 'true')
        await expect(notice.getByText('generator.js 已由用户修改，请确认版本后重试。', { exact: true })).toBeVisible()
      }
      const path = info.outputPath(`rollback-${phase}-${appearance}-${width}.png`)
      await page.screenshot({ path, animations: 'disabled' })
      await info.attach(`rollback-${phase}-${appearance}-${width}`, { path, contentType: 'image/png' })
    }
  }
  await setWindow(1560, 1000)
  expect({ writes, emptyWrites }).toEqual(before)
}

test.beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'rollback-profile-'))
  disk = join(fixture, 'workspace'); mkdirSync(join(disk, '交付'), { recursive: true })
  writeFileSync(join(disk, '交付', fileName), content); writeFileSync(join(disk, 'generator.js'), '// user edit')
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: remoteRoot, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'dark' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(1560, 1000); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, emptySessionId, emptyTitle, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title }, { id: emptySessionId, title: emptyTitle }]
      .map(task => ({ ...task, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] })), activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, emptySessionId, emptyTitle, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    await page.screenshot({ path: info.outputPath('rollback-failure.png') })
    const diagnostics = JSON.stringify({ errors, reads, writes, emptyWrites, stage, emptyTruncated,
      treeError: await page.locator('.work-workspace-panel__error').allTextContents() }, null, 2)
    writeFileSync(info.outputPath('rollback-diagnostics.json'), diagnostics)
    await info.attach('rollback-diagnostics', { body: diagnostics, contentType: 'application/json' })
  }
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      if (dirname(resolve(fixture)) !== fixtures || !basename(fixture).startsWith('rollback-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('partial rollback removes assets immediately; compact results disclose safely and retry truncates history', async ({}, info) => {
  const work = page.locator('.work-view'), workspace = work.getByRole('region', { name: '任务工作区', exact: true })
  await work.getByRole('button', { name: `预览 ${fileName}`, exact: true }).click()
  await expect(workspace.getByText(content, { exact: true })).toBeVisible()
  const openTab = async (name: string): Promise<void> => {
    const tab = workspace.getByRole('tab', { name, exact: true })
    if (await tab.count()) await tab.click()
    else { await workspace.getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  }
  await openTab('工作区')
  const tree = workspace.getByRole('region', { name: '工作区文件', exact: true })
  const folder = tree.getByRole('treeitem', { name: '交付', exact: true })
  await folder.click(); await expect(tree.getByText(fileName, { exact: true })).toBeVisible()
  await work.getByRole('button', { name: '回退文件', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '回退文件', exact: true })
  await expect(dialog).toContainText('generator.js'); await expect(dialog).toContainText('同期手动编辑')
  await dialog.getByRole('button', { name: '回退文件', exact: true }).click()
  const notice = work.getByRole('region', { name: '本次回退结果', exact: true })
  await expect(notice).toContainText('部分改动未能回退')
  const details = notice.getByRole('button', { name: '逐文件结果', exact: true })
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(notice.getByText('generator.js 已由用户修改，请确认版本后重试。', { exact: true })).toBeVisible()
  await expect(notice).toContainText(changes[1].path)
  await expect(notice).not.toContainText('对话暂时保留')
  await expect(tree.getByText(fileName, { exact: true })).toHaveCount(0)
  await expect(folder).toHaveCount(0)
  await expect(work.locator('.work-final-deliverable')).toHaveCount(0)
  expect(existsSync(join(disk, '交付'))).toBe(false)
  expect(readFileSync(join(disk, 'generator.js'), 'utf8')).toBe('// user edit')
  expect(writes).toEqual(['/api/v1/changes/revert-batch'])
  await captureNotice(notice, 'partial', info)
  await openTab('成果'); await expect(workspace.getByText(content, { exact: true })).toHaveCount(0)
  await expect(workspace.locator('[data-final-result-item="report-item"]')).toHaveCount(0)
  // The workspace tree opens its own preview. File history belongs to the
  // resource viewer, so follow that preview action before entering the ledger.
  await openTab('工作区')
  await tree.getByRole('treeitem', { name: 'generator.js', exact: true }).click()
  await workspace.getByRole('button', { name: '在资源中打开', exact: true }).click()
  await workspace.getByRole('button', { name: '在成果中查看改动', exact: true }).click()
  const artifactNotice = workspace.getByRole('region', { name: '文件回退结果', exact: true })
  await expect(artifactNotice).toBeVisible()
  await expect(artifactNotice.getByRole('button', { name: '逐文件结果', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(artifactNotice.getByText('generator.js 已由用户修改，请确认版本后重试。', { exact: true })).toBeVisible()
  const batch = workspace.locator('.work-session-artifacts__batch')
  await expect(batch.getByRole('button', { name: '批量改动操作', exact: true })).toBeVisible()
  const layout = await batch.evaluate(element => {
    const bounds = (selector: string): { left: number; right: number; top: number; bottom: number; center: number } => {
      const target = element.querySelector(selector)
      if (!target) throw new Error(`Missing rollback toolbar element: ${selector}`)
      const box = target.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, center: box.top + box.height / 2 }
    }
    return { count: bounds('.work-session-artifacts__header'), actions: bounds('.work-change-review__actions'), report: bounds('.change-revert-report') }
  })
  expect(Math.abs(layout.count.center - layout.actions.center)).toBeLessThanOrEqual(1)
  expect(layout.count.bottom).toBeLessThanOrEqual(layout.report.top)
  expect(layout.actions.bottom).toBeLessThanOrEqual(layout.report.top)
  expect(Math.abs(layout.report.left - layout.count.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(layout.report.right - layout.actions.right)).toBeLessThanOrEqual(1)
  const artifactScreenshot = info.outputPath('rollback-partial-artifact-dark-1560.png')
  await page.screenshot({ path: artifactScreenshot, animations: 'disabled' })
  await info.attach('rollback-partial-artifact-dark-1560', { path: artifactScreenshot, contentType: 'image/png' })
  const partialWrites = [...writes]
  await artifactNotice.getByRole('button', { name: '关闭回退结果', exact: true }).click()
  await expect(artifactNotice).toHaveCount(0)
  await expect(notice).toHaveCount(0)
  await expect(work.locator('.change-revert-report')).toHaveCount(0)
  expect(writes).toEqual(partialWrites)
  await work.getByRole('button', { name: '回退文件', exact: true }).click()
  await dialog.getByRole('button', { name: '回退文件', exact: true }).click()
  await expect.poll(() => stage).toBe(2)
  await expect(work.locator('.work-conversation-turn')).toHaveCount(0)
  await expect(work.locator('[contenteditable="true"]').first()).toContainText('请制作报告')
  expect(existsSync(join(disk, 'generator.js'))).toBe(false)
  expect(writes).toEqual(['/api/v1/changes/revert-batch', '/api/v1/changes/revert-batch', '/api/v1/conversation/truncate'])
  await expect(notice).toContainText('文件回退完成')
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await expect(notice.getByText(changes[1].path, { exact: true })).not.toBeVisible()
  await expect(notice).not.toContainText('generator.js 已由用户修改')
  const completedWrites = [...writes]
  await details.focus(); await page.keyboard.press('Enter')
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(notice.getByText(changes[0].path, { exact: true })).toBeVisible()
  await expect(notice.getByText(changes[1].path, { exact: true })).toBeVisible()
  await expect(notice).toContainText('此前已撤回')
  await details.click(); await expect(details).toHaveAttribute('aria-expanded', 'false')
  await captureNotice(notice, 'complete', info)
  await notice.getByRole('button', { name: '关闭回退结果', exact: true }).click()
  await expect(notice).toHaveCount(0)
  expect(writes).toEqual(completedWrites)
  expect(errors).toEqual([])
})

test('zero-item rollback has no empty details and dismisses without additional writes', async ({}, info) => {
  await setWindow(1560, 1000)
  await work().locator('.work-sidebar__task').filter({ hasText: emptyTitle }).click()
  await expect(work().getByRole('heading', { name: emptyTitle, exact: true })).toBeVisible()
  await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(emptyPrompt)
  const beforeDisk = readdirSync(disk, { recursive: true })
  const beforeWrites = [...writes]
  await work().getByRole('button', { name: '回退文件', exact: true }).click()
  await page.getByRole('dialog', { name: '回退文件', exact: true }).getByRole('button', { name: '回退文件', exact: true }).click()
  await expect.poll(() => emptyTruncated).toBe(true)
  const notice = work().getByRole('region', { name: '本次回退结果', exact: true })
  await expect(notice).toContainText('没有需要撤回的改动')
  await expect(notice.getByRole('button', { name: '逐文件结果', exact: true })).toHaveCount(0)
  await expect(notice.locator('.change-revert-report__details, details, ul')).toHaveCount(0)
  await expect(work().locator('.work-conversation-turn')).toHaveCount(0)
  await expect(work().locator('[contenteditable="true"]').first()).toContainText(emptyPrompt)
  await captureNotice(notice, 'empty', info)
  expect(readdirSync(disk, { recursive: true })).toEqual(beforeDisk)
  expect(writes).toEqual(beforeWrites)
  expect(emptyWrites).toEqual(['/api/v1/changes/revert-batch', '/api/v1/conversation/truncate'])
  await notice.getByRole('button', { name: '关闭回退结果', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(notice).toHaveCount(0)
  expect(emptyWrites).toEqual(['/api/v1/changes/revert-batch', '/api/v1/conversation/truncate'])
  expect(errors).toEqual([])
})
