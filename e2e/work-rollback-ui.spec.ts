/** Real Electron with controlled authenticated HTTP and a disposable disk workspace:
 * command review, partial rollback, automatic tree/asset invalidation and safe retry. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
const now = Date.now() - 10_000, remoteRoot = '/remote/rollback-project', fileName = '已交付报告.txt'
const content = 'IMMUTABLE_ASSET_MUST_DISAPPEAR_AFTER_ROLLBACK'
const run: RootRun = { schemaVersion: 1, runId: 'rollback-root', sessionId, turnId: 'rollback-turn', userMessageId: 'rollback-user',
  assistantMessageId: 'rollback-answer', seq: 1, version: 2, status: 'succeeded', modelId,
  pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
const manifest: FinalResult = { schemaVersion: 1, sessionId, turnId: run.turnId, runId: run.runId, assistantMessageId: run.assistantMessageId,
  text: '报告已经交付。', publishedAt: now, items: [{ id: 'report-item', assetId: 'report-asset', name: fileName, path: `${remoteRoot}/交付/${fileName}`,
    mimeType: 'text/plain', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), kind: 'file' }] }
const changes = [{ id: 'report', path: `${remoteRoot}/交付/${fileName}`, status: 'pending' },
  { id: 'generator', path: `${remoteRoot}/generator.js`, status: 'accepted', requiresExplicitRevert: true }]
const errors: string[] = [], writes: string[] = [], reads: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', disk = '', stage = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function result(): FinalResult { return { ...manifest, items: stage > 0 ? [] : manifest.items } }
function history(id: string): EngineHistoryRow[] {
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
    expect(body).toEqual({ sessionId, fromTurnId: run.turnId, scope: 'all' })
    response.end(envelope({ total: changes.length, changes: changes.map(change => stage > 0 && change.id === 'report' ? { ...change, status: 'reverted' } : change) })); return
  }
  if (path === '/api/v1/changes/revert-batch') {
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
    expect(body).toEqual({ sessionId, messageId: run.userMessageId }); expect(stage).toBe(1)
    expect(existsSync(localPath('generator.js'))).toBe(false)
    stage = 2; writes.push(path); response.end(envelope({ success: true })); return
  }
  if (path === '/api/v1/conversation/result-asset') {
    reads.push('asset')
    if (stage) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '交付物已撤回', data: null })); return }
    response.end(envelope({ content, isBinary: false, encoding: 'utf8', totalSize: Buffer.byteLength(content), mimeType: 'text/plain', tooLarge: false, truncated: false })); return
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
  const rows = history(id), matching = id === sessionId && stage < 2 ? run : undefined
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
      preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: users.map(row => row.id),
      revision: `rollback-${stage}`, mutationRevision: `rollback-${stage}`, backend: 'jsonl', completeness: 'complete' })); return
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
    : path === '/api/v1/conversation/sessions' ? stage === 2 ? [] : [{ sessionId, title, lastAt: now, messageCount: 2 }]
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
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1560, 1000); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    await page.screenshot({ path: info.outputPath('rollback-failure.png') })
    const diagnostics = JSON.stringify({ errors, reads, writes, stage,
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

test('partial rollback immediately removes delivery and tree entries; retry truncates and restores the prompt', async () => {
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
  await expect(notice).toContainText('generator.js 已由用户修改')
  await expect(tree.getByText(fileName, { exact: true })).toHaveCount(0)
  await expect(folder).toHaveCount(0)
  await expect(work.locator('.work-final-deliverable')).toHaveCount(0)
  expect(existsSync(join(disk, '交付'))).toBe(false)
  expect(readFileSync(join(disk, 'generator.js'), 'utf8')).toBe('// user edit')
  expect(writes).toEqual(['/api/v1/changes/revert-batch'])
  await openTab('成果'); await expect(workspace.getByText(content, { exact: true })).toHaveCount(0)
  await expect(workspace.locator('[data-final-result-item="report-item"]')).toHaveCount(0)
  await work.getByRole('button', { name: '回退文件', exact: true }).click()
  await dialog.getByRole('button', { name: '回退文件', exact: true }).click()
  await expect.poll(() => stage).toBe(2)
  await expect(work.locator('.work-conversation-turn')).toHaveCount(0)
  await expect(work.locator('[contenteditable="true"]').first()).toContainText('请制作报告')
  expect(existsSync(join(disk, 'generator.js'))).toBe(false)
  expect(writes).toEqual(['/api/v1/changes/revert-batch', '/api/v1/changes/revert-batch', '/api/v1/conversation/truncate'])
  expect(errors).toEqual([])
})
