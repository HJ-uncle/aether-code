/** Real Electron with authenticated HTTP and a disposable disk workspace:
 * partial rollback, retry/truncate, compact result disclosures and zero-item
 * results, plus authoritative recovery after a committed rollback loses its
 * acknowledgement. Includes shared surface radii, disk assertions and
 * wide/narrow light/dark screenshots. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
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
const acknowledgementCases = (['lost', 'malformed'] as const).map(failure => {
  const id = `work-rollback-${failure}-ack`, prompt = `请制作 ${failure} 回执验证报告`
  const rootRun: RootRun = { ...run, sessionId: id, runId: `${id}-root`, turnId: `${id}-turn`,
    userMessageId: `${id}-user`, assistantMessageId: `${id}-answer` }
  const publication: FinalResult = { ...manifest, sessionId: id, turnId: rootRun.turnId, runId: rootRun.runId,
    assistantMessageId: rootRun.assistantMessageId, items: manifest.items.map(item => ({ ...item, id: `${id}-item`, assetId: `${id}-asset` })) }
  return { failure, sessionId: id, title: `${failure === 'lost' ? '丢失' : '无效'}回执自动恢复`, prompt, run: rootRun, manifest: publication,
    disk: '', committed: false, writes: [] as Array<{ path: string; requestKey: string }>, recoveryReads: [] as string[] }
})
let app: ElectronApplication | undefined, page: Page, fixture = '', disk = '', stage = 0
let emptyTruncated = false
test.describe.configure({ mode: 'serial' })
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function result(): FinalResult { return { ...manifest, items: stage > 0 ? [] : manifest.items } }
function history(id: string): EngineHistoryRow[] {
  const acknowledgement = acknowledgementCases.find(item => item.sessionId === id)
  if (acknowledgement) return acknowledgement.committed ? [] : [
    { id: acknowledgement.run.userMessageId, role: 'user', content: acknowledgement.prompt, createdAt: now,
      conversationId: acknowledgement.run.turnId, metadata: { rootRunId: acknowledgement.run.runId } },
    { id: acknowledgement.run.assistantMessageId, role: 'assistant', content: acknowledgement.manifest.text, createdAt: now + 1,
      conversationId: acknowledgement.run.turnId, metadata: { rootRunId: acknowledgement.run.runId, finalResult: acknowledgement.manifest } }
  ]
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
function localPath(relative: string, id = sessionId): string {
  const workspace = acknowledgementCases.find(item => item.sessionId === id)?.disk ?? disk
  const target = resolve(workspace, relative || '.')
  if (target !== workspace && !target.startsWith(workspace + sep)) throw new Error('Fixture path escaped')
  return target
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const acknowledgement = acknowledgementCases.find(item => item.sessionId === (body.sessionId ?? id))
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Unauthenticated fixture request')
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (acknowledgement) {
    const change = { ...changes[0], id: `${acknowledgement.sessionId}-change`, sessionId: acknowledgement.sessionId,
      turnId: acknowledgement.run.turnId, runId: acknowledgement.run.runId, kind: 'write', oldContent: null,
      newContent: content, isNew: true, truncated: false, createdAt: now, status: acknowledgement.committed ? 'reverted' : 'pending' }
    if (path === '/api/v1/changes/revert-preview') {
      expect(body).toEqual({ sessionId: acknowledgement.sessionId, fromTurnId: acknowledgement.run.turnId, scope: 'all' })
      response.end(envelope({ total: 1, changes: [change] })); return
    }
    if (path === '/api/v1/conversation/rollback') {
      expect(body).toEqual({ sessionId: acknowledgement.sessionId, messageId: acknowledgement.run.userMessageId,
        reviewedCommandChangeIds: [], requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/i) })
      acknowledgement.writes.push({ path, requestKey: String(body.requestKey) })
      expect(acknowledgement.committed, 'A lost acknowledgement must not automatically replay the mutation').toBe(false)
      rmSync(localPath(`交付/${fileName}`, acknowledgement.sessionId))
      rmdirSync(localPath('交付', acknowledgement.sessionId))
      // Commit disk, history and publication first, then fail only the receipt.
      // Restoring the UI before any reload must go through the real useChat.
      acknowledgement.committed = true
      if (acknowledgement.failure === 'lost') response.destroy()
      else response.end(envelope({ total: 1, reverted: 1, historyTruncated: true }))
      return
    }
    if (request.method === 'POST' && ['/api/v1/conversation/truncate', '/api/v1/changes/revert-batch', '/api/v1/chat'].includes(path)) {
      acknowledgement.writes.push({ path, requestKey: String(body.requestKey ?? '') })
      throw new Error('Acknowledgement recovery must not replay or split a mutation: ' + path)
    }
    if (path === '/api/v1/changes') {
      response.end(envelope(url.searchParams.get('status') === 'pending' && acknowledgement.committed ? [] : [change])); return
    }
    if (path === '/api/v1/conversation/result-asset') {
      expect(url.searchParams.get('runId')).toBe(acknowledgement.run.runId)
      expect(url.searchParams.get('assetId')).toBe(acknowledgement.manifest.items[0].assetId)
      if (acknowledgement.committed) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '交付物已撤回', data: null })); return }
      response.end(envelope({ content, isBinary: false, encoding: 'utf8', totalSize: Buffer.byteLength(content), mimeType: 'text/plain', tooLarge: false, truncated: false })); return
    }
    if (acknowledgement.committed && ['/api/v1/chat/snapshot', '/api/v1/conversation/display', '/api/v1/conversation/history'].includes(path))
      acknowledgement.recoveryReads.push(path)
  }
  if (path === '/api/v1/changes/revert-preview') {
    if (body.sessionId === emptySessionId) {
      expect(body).toEqual({ sessionId: emptySessionId, fromTurnId: emptyRun.turnId, scope: 'all' })
      response.end(envelope({ total: 0, changes: [] })); return
    }
    expect(body).toEqual({ sessionId, fromTurnId: run.turnId, scope: 'all' })
    response.end(envelope({ total: changes.length, changes: changes.map(change => stage > 0 && change.id === 'report' ? { ...change, status: 'reverted' } : change) })); return
  }
  if (path === '/api/v1/conversation/rollback') {
    if (body.sessionId === emptySessionId) {
      expect(body).toEqual({ sessionId: emptySessionId, messageId: emptyRun.userMessageId, reviewedCommandChangeIds: [], requestKey: expect.any(String) })
      emptyWrites.push(path)
      emptyTruncated = true
      response.end(envelope({ total: 0, reverted: 0, conflicts: 0, unavailable: 0, failed: 0, results: [], historyTruncated: true, removedFrom: emptyRun.userMessageId })); return
    }
    expect(body).toEqual({ sessionId, messageId: run.userMessageId, reviewedCommandChangeIds: ['generator'], requestKey: expect.any(String) })
    writes.push(path)
    const first = stage === 0
    if (first) {
      rmSync(localPath(`交付/${fileName}`)); rmSync(localPath('交付'), { recursive: true })
      stage = 1
    } else { rmSync(localPath('generator.js')); stage = 2 }
    response.end(envelope({ total: 2, reverted: 1, conflicts: first ? 1 : 0, unavailable: 0, failed: 0,
      historyTruncated: !first, ...(!first ? { removedFrom: run.userMessageId } : {}),
      removedDirectories: first ? [`${remoteRoot}/交付`] : [], results: [
        { ...changes[0], status: first ? 'reverted' : 'already_reverted' },
        { ...changes[1], status: first ? 'conflict' : 'reverted', ...(first ? { message: 'generator.js 已由用户修改，请确认版本后重试。' } : {}) }
      ] })); return
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
    expect([sessionId, ...acknowledgementCases.map(item => item.sessionId)]).toContain(id)
    const relative = url.searchParams.get('path') ?? '', file = localPath(relative, id)
    reads.push(`file:${relative}`)
    if (!existsSync(file)) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '文件已撤回', data: null })); return }
    const text = readFileSync(file, 'utf8')
    response.end(envelope({ content: text, isBinary: false, totalSize: Buffer.byteLength(text), root: remoteRoot, bindingEpoch: 'one', truncated: false })); return
  }
  if (path === '/api/v1/workspace/directory') {
    const requested = url.searchParams.get('path') ?? ''
    const relative = requested === '.' ? '' : requested
    reads.push(`directory:${relative}`)
    const directory = localPath(relative, id)
    response.end(envelope({ root: remoteRoot, bindingEpoch: 'one', entries: readdirSync(directory).map(name => {
      const stat = statSync(join(directory, name))
      return { name, path: `${relative ? relative + '/' : ''}${name}`, isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs }
    }) })); return
  }
  const rows = history(id), matching = acknowledgement && !acknowledgement.committed ? acknowledgement.run
    : id === sessionId && stage < 2 ? run : id === emptySessionId && !emptyTruncated ? emptyRun : undefined
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
      preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: users.map(row => row.id),
      revision: `rollback-${id}-${stage}-${emptyTruncated}-${acknowledgement?.committed}`, mutationRevision: `rollback-${id}-${stage}-${emptyTruncated}-${acknowledgement?.committed}`, backend: 'jsonl', completeness: 'complete' })); return
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
      ...(emptyTruncated ? [] : [{ sessionId: emptySessionId, title: emptyTitle, lastAt: now, messageCount: 2 }]),
      ...acknowledgementCases.filter(item => !item.committed).map(item => ({ sessionId: item.sessionId, title: item.title, lastAt: now, messageCount: 2 }))]
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
  for (const acknowledgement of acknowledgementCases) {
    acknowledgement.disk = join(fixture, acknowledgement.sessionId)
    mkdirSync(join(acknowledgement.disk, '交付'), { recursive: true })
    writeFileSync(join(acknowledgement.disk, '交付', fileName), content)
  }
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
  await page.evaluate(({ key, sessionId, title, emptySessionId, emptyTitle, acknowledgementTasks, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title }, { id: emptySessionId, title: emptyTitle }, ...acknowledgementTasks]
      .map(task => ({ ...task, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] })), activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, emptySessionId, emptyTitle,
    acknowledgementTasks: acknowledgementCases.map(item => ({ id: item.sessionId, title: item.title })), now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    await page.screenshot({ path: info.outputPath('rollback-failure.png') })
    const diagnostics = JSON.stringify({ errors, reads, writes, emptyWrites, stage, emptyTruncated, acknowledgementCases,
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

test('工作区页签：三栏标题对齐，悬停与键盘聚焦不横移，关闭页签不删除文件', async ({}, info) => {
  const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
  const strip = workspace.getByRole('toolbar', { name: '工作区标签', exact: true })
  const more = work().locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true })
  const sidebar = work().getByRole('complementary', { name: '应用导航', exact: true })
  const before = { writes: [...writes], emptyWrites: [...emptyWrites], stage }
  const evidence: unknown[] = []
  const settleLayout = () => work().evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => undefined)))
  })
  const sampleFrames = () => strip.evaluate(async element => {
    const read = () => {
      const targets: Array<{ name: string; element: Element; icon?: boolean }> = [{ name: 'strip', element }]
      const application = element.closest('.work-view')!
      for (const [name, selector] of [
        ['sidebar-heading', '.work-sidebar__top'], ['conversation-heading', '.work-task-heading'],
        ['sidebar-control', '.work-sidebar__top .ui-icon-button > svg'],
        ['conversation-control', '.work-task-heading [aria-label="更多工作区"] > svg']
      ] as const) targets.push({ name, element: application.querySelector(selector)! })
      for (const button of element.querySelectorAll('.work-workspace__tab-button')) {
        const tab = button.closest('.work-workspace__tab')!
        const name = button.id
        targets.push({ name: `${name}:tab`, element: tab }, { name: `${name}:button`, element: button },
          { name: `${name}:label`, element: button.querySelector('.work-workspace__tab-label')! },
          { name: `${name}:icon`, element: button.querySelector('svg')!, icon: true },
          { name: `${name}:close`, element: tab.querySelector('.work-workspace__tab-close')! },
          { name: `${name}:close-icon`, element: tab.querySelector('.work-workspace__tab-close svg')!, icon: true })
      }
      for (const [name, selector] of [['collapse', '.work-workspace__collapse > button'], ['new', '.work-workspace__new-tab']] as const) {
        const button = element.querySelector(selector)!
        targets.push({ name, element: button }, { name: `${name}:icon`, element: button.querySelector('svg')!, icon: true })
      }
      return targets.map(target => {
        const rect = target.element.getBoundingClientRect(), style = getComputedStyle(target.element)
        return { name: target.name, icon: Boolean(target.icon), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          centerY: rect.y + rect.height / 2, translate: style.translate, transform: style.transform,
          hover: target.element.matches(':hover'), focused: target.element.matches(':focus-visible') }
      })
    }
    const frame = () => new Promise<void>(done => requestAnimationFrame(() => done()))
    const samples = [read()]
    await frame(); samples.push(read())
    const animations = element.getAnimations({ subtree: true }).filter(animation =>
      animation.playState !== 'finished' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    let settled = animations.length === 0
    const completion = Promise.all(animations.map(animation => animation.finished.catch(() => undefined))).then(() => { settled = true })
    // Keep every intermediate rectangle: waiting for only the final position
    // would hide a close button that slides out and returns during hover.
    while (!settled) { await frame(); samples.push(read()) }
    await completion; await frame(); samples.push(read())
    return samples
  })
  try {
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1560); await setAppearance(appearance)
      for (const width of [1560, 1100, 900, 560]) {
        await setWindow(width)
        const collapse = work().getByRole('button', { name: '收起工作区', exact: true })
        if (await collapse.isVisible()) await collapse.click()
        const conversation = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
        if (await conversation.isVisible()) await conversation.click()
        await work().getByRole('region', { name: '本轮成果摘要', exact: true })
          .getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
        const workspaceTab = work().locator('.work-mobile-tabs').getByRole('button', { name: '工作区', exact: true })
        if (await workspaceTab.isVisible()) await workspaceTab.click()
        await expect(strip.getByRole('tab', { name: '成果', exact: true })).toBeVisible()
        await more.click()
        await page.getByRole('menu', { name: '更多工作区', exact: true }).getByRole('menuitem', { name: '工作区', exact: true }).click()
        await expect(strip.getByRole('tab')).toHaveCount(2)
        await expect(strip.getByRole('tab', { name: '工作区', exact: true })).toHaveAttribute('aria-selected', 'true')
        await expect(workspace.getByRole('region', { name: '工作区文件', exact: true })).toBeVisible()
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        // The workspace enters outside the strip's animation subtree. Settle
        // that opening once, before the hover measurements begin.
        await settleLayout()
        const assertHeaderBands = async (state: string): Promise<void> => {
          const geometry = (await sampleFrames()).at(-1)!
          const named = (name: string) => {
            const target = geometry.find(item => item.name === name)
            if (!target) throw new Error(`Missing header geometry: ${name}`)
            return target
          }
          const middle = named('conversation-heading'), left = named('sidebar-heading'), right = named('strip')
          const middleControl = named('conversation-control'), leftControl = named('sidebar-control')
          const rightControls = geometry.filter(item => item.icon)
          evidence.push({ appearance, width, state, headerBands: { left, middle, right }, leftControl, middleControl, rightControls })
          // This fixture has no Agent badge. Preserve the existing 36/48px
          // conversation header; Agent wrapping is a separate layout concern.
          expect(middle.height).toBe(width <= 560 ? 48 : 36)
          for (const [name, band] of [['sidebar', left], ['workspace', right]] as const) {
            expect(Math.abs(band.height - middle.height), `${state}/${name}: same height as conversation`).toBeLessThanOrEqual(1)
            if (width >= 991) {
              expect(Math.abs(band.y - middle.y), `${state}/${name}: aligned top`).toBeLessThanOrEqual(1)
              expect(Math.abs(band.y + band.height - middle.y - middle.height), `${state}/${name}: aligned bottom`).toBeLessThanOrEqual(1)
            }
          }
          const middleOffset = middleControl.centerY - middle.y
          expect(Math.abs(middleOffset - middle.height / 2)).toBeLessThanOrEqual(1)
          expect(Math.abs(leftControl.centerY - left.y - middleOffset), `${state}: sidebar control follows conversation center`).toBeLessThanOrEqual(1)
          for (const control of rightControls) {
            expect(Math.abs(control.centerY - right.y - middleOffset), `${state}/${control.name}: workspace control follows conversation center`).toBeLessThanOrEqual(1)
          }
          if (state === 'navigation-drawer') {
            expect(Math.abs(left.y - middle.y)).toBeLessThanOrEqual(1)
            expect(Math.abs(left.y + left.height - middle.y - middle.height)).toBeLessThanOrEqual(1)
          }
        }
        await assertHeaderBands('initial')
        if (width === 1560) {
          await sidebar.getByRole('button', { name: '收起 应用导航', exact: true }).click()
          await expect(work()).toHaveAttribute('data-collapsed', 'true'); await settleLayout()
          await expect(sidebar.locator('.work-sidebar__brand')).toBeHidden()
          await assertHeaderBands('navigation-collapsed')
          const path = info.outputPath(`workspace-tabs-${appearance}-${width}-collapsed.png`)
          await page.screenshot({ path }); await info.attach(`三栏手动收起 ${appearance}`, { path, contentType: 'image/png' })
          await sidebar.getByRole('button', { name: '展开 应用导航', exact: true }).click()
          await expect(work()).toHaveAttribute('data-collapsed', 'false'); await settleLayout()
          await assertHeaderBands('navigation-restored')
        } else {
          await expect(sidebar.locator('.work-sidebar__brand')).toBeHidden()
          expect(await sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(64)
        }
        if (width === 900) {
          await sidebar.getByRole('button', { name: '展开 应用导航', exact: true }).click()
          await expect(work()).toHaveAttribute('data-nav-open', 'true'); await settleLayout()
          await expect(sidebar.locator('.work-sidebar__brand')).toBeVisible()
          await assertHeaderBands('navigation-drawer')
          const path = info.outputPath(`workspace-tabs-${appearance}-${width}-drawer.png`)
          await page.screenshot({ path }); await info.attach(`三栏导航抽屉 ${appearance}`, { path, contentType: 'image/png' })
          await work().getByRole('button', { name: '关闭导航抽屉', exact: true }).click()
          await expect(work()).toHaveAttribute('data-nav-open', 'false'); await settleLayout()
          await assertHeaderBands('navigation-drawer-closed')
        }
        await page.mouse.move(6, 6); await more.focus()
        const baseline = (await sampleFrames()).at(-1)!
        const assertStable = async (state: string): Promise<void> => {
          const samples = await sampleFrames()
          const failures: Array<{ frame: number; element: string; dimension: string; delta: number }> = []
          let maxDelta = 0, maxIconOffset = 0
          for (const [frame, sample] of samples.entries()) {
            expect(sample.map(item => item.name)).toEqual(baseline.map(item => item.name))
            for (const [index, item] of sample.entries()) {
              for (const dimension of ['x', 'y', 'width', 'height'] as const) {
                const delta = Math.abs(item[dimension] - baseline[index][dimension])
                maxDelta = Math.max(maxDelta, delta)
                if (delta > 0.5) failures.push({ frame, element: item.name, dimension, delta })
              }
            }
            const centers = sample.filter(item => item.icon).map(item => item.centerY)
            expect(centers).toHaveLength(6)
            maxIconOffset = Math.max(maxIconOffset, Math.max(...centers) - Math.min(...centers))
          }
          evidence.push({ appearance, width, state, frames: samples.length, maxDelta, maxIconOffset, baseline,
            failures, first: samples[0], last: samples.at(-1) })
          expect(failures, `${appearance}/${width}/${state}: all sampled positions remain fixed`).toEqual([])
          expect(maxIconOffset, `${appearance}/${width}/${state}: label, close, collapse and add icons share a center line`).toBeLessThanOrEqual(1)
        }
        await assertStable('rest')
        for (let repetition = 1; repetition <= 3; repetition++) {
          for (const name of ['成果', '工作区'] as const) {
            await strip.getByRole('tab', { name, exact: true }).hover()
            await assertStable(`${repetition}/${name}/tab-hover`)
            await strip.getByRole('button', { name: `关闭${name}`, exact: true }).hover()
            await assertStable(`${repetition}/${name}/close-hover`)
            await page.mouse.move(6, 6)
            await assertStable(`${repetition}/${name}/leave`)
          }
        }
        for (const name of ['成果', '工作区'] as const) {
          const tab = strip.getByRole('tab', { name, exact: true })
          const close = strip.getByRole('button', { name: `关闭${name}`, exact: true })
          await tab.focus(); await assertStable(`${name}/tab-focus`)
          await page.keyboard.press('Tab'); await expect(close).toBeFocused()
          expect(await close.evaluate(element => element.matches(':focus-visible'))).toBe(true)
          await assertStable(`${name}/keyboard-close-focus`)
          await more.focus(); await assertStable(`${name}/focus-leave`)
        }
        const path = info.outputPath(`workspace-tabs-${appearance}-${width}.png`)
        await page.screenshot({ path })
        await info.attach(`工作区页签 ${appearance} ${width}`, { path, contentType: 'image/png' })
        await strip.getByRole('button', { name: '关闭工作区', exact: true }).click()
        await expect(strip.getByRole('tab', { name: '工作区', exact: true })).toHaveCount(0)
        await expect(strip.getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true')
        expect({ writes, emptyWrites, stage }).toEqual(before)
        expect(readFileSync(join(disk, '交付', fileName), 'utf8')).toBe(content)
        expect(readFileSync(join(disk, 'generator.js'), 'utf8')).toBe('// user edit')
        await strip.getByRole('button', { name: '收起工作区', exact: true }).click()
      }
    }
    await setWindow(1560, 1000)
    expect(errors).toEqual([])
  } finally {
    await info.attach('workspace-tab-geometry', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  }
})

test('统一框圆角：交付物、成果条、输入区和真实菜单弹窗在深浅宽窄窗口均为12px', async ({}, info) => {
  const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
  const card = work().locator('.work-final-deliverable[data-final-result-item="report-item"]')
  const summary = work().getByRole('region', { name: '本轮成果摘要', exact: true })
  const composer = work().locator('.input-composer.work-composer')
  const evidence: Array<{ appearance: string; width: number; surface: string; corners: string[] }> = []
  const before = { writes: [...writes], emptyWrites: [...emptyWrites], stage }
  const screenshot = async (name: string): Promise<void> => {
    const path = info.outputPath(`surface-radius-${name}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await info.attach(`圆角 ${name}`, { path, contentType: 'image/png' })
  }
  const showConversation = async (): Promise<void> => {
    const close = work().getByRole('button', { name: '收起工作区', exact: true })
    if (await close.isVisible()) await close.click()
    const tab = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
    if (await tab.isVisible()) await tab.click()
    await expect(card).toBeVisible()
  }
  for (const appearance of ['light', 'dark'] as const) {
    await setWindow(1560); await setAppearance(appearance)
    for (const width of [1560, 560]) {
      await setWindow(width); await showConversation()
      const corners = async (surface: string, target: Locator, expected = '12px'): Promise<void> => {
        await expect(target, surface).toBeVisible()
        const measured = await target.evaluate(element => {
          const style = getComputedStyle(element)
          return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
        })
        evidence.push({ appearance, width, surface, corners: measured })
        expect(measured, `${appearance} / ${width} / ${surface}`).toEqual(Array(4).fill(expected))
      }
      const aliases = await page.locator('html').evaluate(element => {
        const style = getComputedStyle(element)
        return ['--radius', '--radius-sm', '--radius-lg', '--radius-xl', '--radius-panel', '--input-radius', '--menu-row-radius']
          .map(name => ({ name, value: style.getPropertyValue(name).trim() }))
      })
      for (const alias of aliases) expect(alias.value, alias.name).toBe('12px')
      await corners('对话输入框', composer)
      await corners('交付物卡片', card)
      await corners('成果条', summary.locator('.work-progress-panel__section--changes'))
      await corners('成果待确认按钮', summary.getByRole('button', { name: '查看本轮成果，2 个文件待确认', exact: true }))
      // Integrated action cells stay square, while the outside card provides
      // their clipping. Circular controls must not become rounded rectangles.
      await corners('交付物拼接预览按钮', card.getByRole('button', { name: `预览 ${fileName}`, exact: true }), '0px')
      await corners('交付物拼接下载按钮', card.getByRole('button', { name: `下载 ${fileName}`, exact: true }), '0px')
      await corners('圆形发送按钮', composer.getByRole('button', { name: '发送', exact: true }), '50%')
      await screenshot(`${appearance}-${width}-conversation`)

      await card.getByRole('group', { name: fileName, exact: true }).click({ button: 'right' })
      const contextMenu = page.locator('.context-menu:not(.context-menu--submenu):not([aria-hidden="true"])')
      await corners('右键菜单', contextMenu)
      await corners('右键菜单行', contextMenu.getByRole('menuitem', { name: '复制绝对路径', exact: true }))
      await screenshot(`${appearance}-${width}-context-menu`)
      await page.keyboard.press('Escape'); await expect(contextMenu).toHaveCount(0)

      await composer.getByRole('button', { name: '对话偏好', exact: true }).click()
      const preferences = page.getByRole('dialog', { name: '对话偏好', exact: true })
      await corners('对话偏好浮层', preferences)
      const thinking = preferences.getByRole('switch', { name: '显示思考', exact: true })
      await corners('胶囊开关', thinking, '999px')
      await corners('圆形开关滑块', thinking.locator('.toggle__knob'), '50%')
      await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
      await expect(preferences).toHaveCount(0)

      await summary.getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
      const workspaceTab = work().locator('.work-mobile-tabs').getByRole('button', { name: '工作区', exact: true })
      if (await workspaceTab.isVisible()) await workspaceTab.click()
      const artifacts = workspace.getByRole('region', { name: '本会话成果与改动', exact: true })
      const search = artifacts.getByRole('searchbox', { name: '搜索当前范围文件', exact: true })
      await corners('成果搜索框', search)
      await search.fill('generator.js')
      await expect(artifacts.locator('.work-session-artifacts__file-header strong')).toHaveText('generator.js')
      await corners('成果范围选择按钮', artifacts.getByRole('button', { name: '差异范围', exact: true }))
      await screenshot(`${appearance}-${width}-search`)
      await artifacts.getByRole('button', { name: '批量改动操作', exact: true }).click()
      const actions = page.getByRole('dialog', { name: '批量改动操作', exact: true })
      await corners('批量操作菜单', actions)
      await corners('批量操作菜单行', actions.getByRole('menuitem', { name: '保留待确认改动', exact: true }))
      await actions.getByRole('menuitem', { name: '保留待确认改动', exact: true }).click()
      const confirmation = page.getByRole('dialog', { name: '保留待确认改动', exact: true })
      await expect(confirmation).toContainText('generator.js')
      await corners('确认弹窗', confirmation)
      await corners('确认弹窗取消按钮', confirmation.getByRole('button', { name: '取消', exact: true }))
      await corners('确认弹窗主按钮', confirmation.getByRole('button', { name: '保留', exact: true }))
      await screenshot(`${appearance}-${width}-confirmation`)
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await expect(confirmation).toHaveCount(0)
      await search.fill('')
      await showConversation()
    }
  }
  await info.attach('surface-radius-computed', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  await setWindow(1560, 1000)
  expect({ writes, emptyWrites, stage }).toEqual(before)
  expect(readFileSync(join(disk, '交付', fileName), 'utf8')).toBe(content)
  expect(readFileSync(join(disk, 'generator.js'), 'utf8')).toBe('// user edit')
  expect(errors).toEqual([])
})

test('partial rollback removes assets immediately; compact results disclose safely and retry truncates history', async ({}, info) => {
  const work = page.locator('.work-view'), workspace = work.getByRole('region', { name: '任务工作区', exact: true })
  await work.getByRole('button', { name: `预览 ${fileName}`, exact: true }).click()
  await expect(workspace.getByText(content, { exact: true })).toBeVisible()
  const openTab = async (name: string): Promise<void> => {
    const tab = workspace.getByRole('tab', { name, exact: true })
    if (await tab.isVisible()) await tab.click()
    else { await work.locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
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
  expect(writes).toEqual(['/api/v1/conversation/rollback'])
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
  const toolbar = workspace.locator('.work-session-artifacts__toolbar')
  await expect(toolbar.getByRole('button', { name: '批量改动操作', exact: true })).toBeVisible()
  const layout = await toolbar.evaluate(element => {
    const bounds = (selector: string): { left: number; right: number; top: number; bottom: number; center: number } => {
      const target = element.querySelector(selector)
      if (!target) throw new Error(`Missing rollback toolbar element: ${selector}`)
      const box = target.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, center: box.top + box.height / 2 }
    }
    return { controls: bounds('.work-session-artifacts__controls'), count: bounds('.work-session-artifacts__header'),
      actions: bounds('.work-session-artifacts__batch .work-change-review__actions'), refresh: bounds('.work-session-artifacts__refresh'), report: bounds('.change-revert-report') }
  })
  expect(Math.abs(layout.count.center - layout.actions.center)).toBeLessThanOrEqual(1)
  expect(layout.count.bottom).toBeLessThanOrEqual(layout.report.top)
  expect(layout.actions.bottom).toBeLessThanOrEqual(layout.report.top)
  expect(Math.abs(layout.report.left - layout.controls.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(layout.report.right - layout.refresh.right)).toBeLessThanOrEqual(1)
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
  expect(writes).toEqual(['/api/v1/conversation/rollback', '/api/v1/conversation/rollback'])
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
  expect(emptyWrites).toEqual(['/api/v1/conversation/rollback'])
  await notice.getByRole('button', { name: '关闭回退结果', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(notice).toHaveCount(0)
  expect(emptyWrites).toEqual(['/api/v1/conversation/rollback'])
  expect(errors).toEqual([])
})

for (const acknowledgement of acknowledgementCases) test(`committed rollback with ${acknowledgement.failure} acknowledgement restores history and previews without replay`, async ({}, info) => {
  await setWindow(1560, 1000)
  await work().locator(`.work-sidebar__task-row[data-task-id="${acknowledgement.sessionId}"] .work-sidebar__task`).click()
  await expect(work().getByRole('heading', { name: acknowledgement.title, exact: true })).toBeVisible()
  const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
  const preview = workspace.getByRole('region', { name: '交付物预览', exact: true })
  await expect(work().locator('.work-conversation-turn')).toHaveCount(1)
  await work().getByRole('button', { name: `预览 ${fileName}`, exact: true }).click()
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute('data-final-result-item', acknowledgement.manifest.items[0].id)
  await expect(workspace.getByText(content, { exact: true })).toBeVisible()
  expect(readFileSync(localPath(`交付/${fileName}`, acknowledgement.sessionId), 'utf8')).toBe(content)

  await work().getByRole('button', { name: '回退文件', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '回退文件', exact: true })
  await expect(dialog).toContainText('1 处文件及目录改动')
  await dialog.getByRole('button', { name: '回退文件', exact: true }).click()

  await expect.poll(() => acknowledgement.committed).toBe(true)
  // No manual reload or session switch is allowed before these assertions:
  // useChat must recover the committed snapshot despite lacking a valid receipt.
  await expect.poll(() => acknowledgement.recoveryReads).toContain('/api/v1/chat/snapshot')
  await expect(work().locator('.work-conversation-turn')).toHaveCount(0)
  await expect(work().locator('.work-final-deliverable')).toHaveCount(0)
  await expect(preview).toHaveCount(0)
  await expect(workspace.getByText(content, { exact: true })).toHaveCount(0)
  await expect(work().getByRole('region', { name: '本次回退结果', exact: true })).toHaveCount(0)
  expect(readdirSync(acknowledgement.disk)).toEqual([])
  expect(acknowledgement.writes).toHaveLength(1)
  expect(acknowledgement.writes[0].path).toBe('/api/v1/conversation/rollback')

  const tab = workspace.getByRole('tab', { name: '工作区', exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    await work().locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
  }
  const tree = workspace.getByRole('region', { name: '工作区文件', exact: true })
  await expect(tree).toBeVisible()
  await expect(tree.getByRole('treeitem')).toHaveCount(0)

  // A later reload must observe the already committed result, never resubmit
  // the unknown operation or resurrect a resident history/publication cache.
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(work().getByRole('heading', { name: acknowledgement.title, exact: true })).toBeVisible()
  await expect(work().locator('.work-conversation-turn')).toHaveCount(0)
  await expect(work().locator('.work-final-deliverable')).toHaveCount(0)
  await expect(work().locator(`[data-final-result-item="${acknowledgement.manifest.items[0].id}"]`)).toHaveCount(0)
  expect(acknowledgement.writes).toHaveLength(1)
  expect(errors).toEqual([])
  await info.attach(`rollback-${acknowledgement.failure}-ack`, { body: JSON.stringify({
    sessionId: acknowledgement.sessionId, committed: acknowledgement.committed,
    writes: acknowledgement.writes, recoveryReads: acknowledgement.recoveryReads,
    diskFiles: readdirSync(acknowledgement.disk), errors
  }, null, 2), contentType: 'application/json' })
})
