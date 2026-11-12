/** New real-Electron regression: legacy binary-labelled published source files
 * render as text; actual binary remains hex; large text stays virtualized and
 * revisiting an immutable asset reuses its validated bytes. No downloads. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult } from '../src/shared/final-result'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'text-deliverables-test-token', sessionId = 'work-text-deliverables', modelId = 'text-deliverables-model'
const title = '源码交付物文本预览', now = Date.now() - 10_000
const assets = [
  { id: 'mjs', name: 'client-test.mjs', text: '#!/usr/bin/env node\n/** 中文测试服务 */\nimport { spawn } from "node:child_process";\nconsole.log("MJS_READY：源码正常");\n' },
  { id: 'cjs', name: 'server.cjs', text: 'module.exports = { ready: "CJS_READY：中文模块" };\n' },
  { id: 'yaml', name: 'settings.yaml', text: 'title: YAML_READY\n说明: 配置内容正常\n' },
  { id: 'noext', name: 'Dockerfile', text: 'FROM node:22\n# DOCKERFILE_READY 中文说明\nWORKDIR /app\n' },
  { id: 'unknown', name: 'report.custom', text: 'CUSTOM_TEXT_READY\n未知后缀的可读文本\n' },
  { id: 'utf16', name: 'windows.ps1', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Write-Output "UTF16_READY：中文"\r\n', 'utf16le')]) },
  { id: 'binary', name: 'opaque.bin', bytes: Buffer.from([0, 1, 2, 255, 128, 18, 29, 88]) },
  { id: 'large', name: 'large.mjs', text: Array.from({ length: 5000 }, (_, index) => `// LINE_${index + 1} 中文源码 ${'x'.repeat(60)}`).join('\n') + '\n// LARGE_END_READY\n' },
  { id: 'corrupt', name: 'broken.mjs', text: 'console.log("must not render unverified text");\n', corrupt: true }
].map(asset => ({ ...asset, bytes: asset.bytes ?? Buffer.from(asset.text ?? ''), mimeType: 'application/octet-stream' }))
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const run: RootRun = { schemaVersion: 1, runId: 'text-deliverables-run', sessionId, turnId: 'text-deliverables-turn',
  userMessageId: 'text-deliverables-user', assistantMessageId: 'text-deliverables-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now + 100, finishedAt: now + 100 }
const result: FinalResult = { schemaVersion: 1, sessionId, runId: run.runId, turnId: run.turnId,
  assistantMessageId: run.assistantMessageId, text: '源码与配置已准备好。', publishedAt: now + 100,
  items: assets.map(asset => ({ id: asset.id, assetId: asset.id, name: asset.name, path: `交付/${asset.name}`, kind: 'file',
    mimeType: asset.mimeType, size: asset.bytes.length, sha256: asset.corrupt ? '0'.repeat(64) : hash(asset.bytes) })) }
const errors: string[] = [], mutations: string[] = [], reads: string[] = [], timings: Array<{ id: string; phase: 'cold' | 'cached'; elapsedMs: number }> = []
const largeText: { byteSize?: number; totalRows?: number; initialMountedRows?: number; endMountedRows?: number } = {}
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function history(id: string): EngineHistoryRow[] {
  return id !== sessionId ? [] : [
    { id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: result.text, createdAt: now + 100,
      conversationId: run.turnId, metadata: { rootRunId: run.runId, finalResult: result } }
  ]
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Preview must not mutate ${path}`)
  }
  if (path === '/api/v1/conversation/result-asset') {
    const asset = assets.find(candidate => candidate.id === url.searchParams.get('assetId'))
    if (!asset || id !== sessionId || url.searchParams.get('runId') !== run.runId) throw new Error('Foreign or unknown asset')
    reads.push(asset.id)
    response.end(envelope({ content: asset.bytes.toString('base64'), isBinary: true, encoding: 'base64', totalSize: asset.bytes.length,
      mimeType: asset.mimeType, tooLarge: false, truncated: false })); return
  }
  if (path === '/api/v1/workspace/file/content') throw new Error('Immutable asset must not read the mutable workspace file')
  const rows = history(id), matching = id === sessionId ? run : null
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: 'text-delivery-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'text-delivery-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '文本预览测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'text-delivery', sessionId: id,
      namespace: { id: 'text-delivery-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/text-delivery', entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/text-delivery' }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const preview = (): Locator => page.locator('.work-final-result:visible')
const files = (): Locator => page.getByRole('navigation', { name: '本轮交付物', exact: true })
async function openAsset(id: string): Promise<void> {
  const phase = reads.includes(id) ? 'cached' : 'cold'
  const started = Date.now()
  await files().locator(`button[data-final-result-item="${id}"]`).click()
  await expect(preview()).toHaveAttribute('data-final-result-item', id)
  await expect(preview().locator('.work-final-result__body')).not.toContainText('正在加载交付物')
  timings.push({ id, phase, elapsedMs: Date.now() - started })
}

test.describe.serial('Work 源码交付物文本识别', () => {
  test.beforeAll(async () => {
    const main = process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js')
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'text-deliverables-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/text-delivery', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [main, `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, now, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
        updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
    await page.reload()
    const firstPreview = page.locator('article[data-final-result-item="mjs"]').getByRole('button', { name: '预览 client-test.mjs', exact: true })
    await expect(firstPreview).toBeVisible()
    const started = Date.now()
    await firstPreview.click()
    await expect(files()).toBeVisible()
    await expect(preview().locator('.work-final-result__body')).not.toContainText('正在加载交付物')
    timings.push({ id: 'mjs', phase: 'cold', elapsedMs: Date.now() - started })
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const shot = info.outputPath('preview.png'); await page.screenshot({ path: shot }); await info.attach('预览截图', { path: shot, contentType: 'image/png' })
    }
    const observations = info.outputPath('observations.json')
    writeFileSync(observations, JSON.stringify({ errors, mutations, reads, timings, largeText }, null, 2))
    await info.attach('preview-observations', { path: observations, contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    writeFileSync(join(fixtureRoot, 'work-text-deliverables-results', 'observation-summary.json'), JSON.stringify({
      appEntry: process.env.AETHER_E2E_APP_ENTRY, errors, mutations, reads, timings, largeText,
      timingNote: 'Elapsed click-to-observed-ready times include Playwright interaction and assertion overhead, on the local authenticated fixture.'
    }, null, 2))
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('text-deliverables-profile-')) throw new Error(`Unsafe cleanup ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('旧引擎标为二进制的 mjs 按完整中文源码显示', async () => {
    const grid = preview().getByRole('grid', { name: 'client-test.mjs 文本预览', exact: true })
    await expect(grid).toBeVisible()
    await expect(grid).toContainText('#!/usr/bin/env node')
    await expect(grid).toContainText('中文测试服务')
    await expect(grid).toContainText('MJS_READY：源码正常')
    await expect(preview().locator('.file-preview')).toHaveCount(0)
  })
  test('模块、配置、无扩展名和自定义后缀同样识别为文本', async () => {
    for (const [id, marker] of [['cjs', 'CJS_READY：中文模块'], ['yaml', 'YAML_READY'], ['noext', 'DOCKERFILE_READY'], ['unknown', 'CUSTOM_TEXT_READY'], ['utf16', 'UTF16_READY：中文']]) {
      await openAsset(id)
      await expect(preview().getByRole('grid')).toContainText(marker)
      await expect(preview().locator('.file-preview')).toHaveCount(0)
    }
  })
  test('真正二进制保留十六进制；校验失败不显示未经验证正文', async () => {
    await openAsset('binary')
    await expect(preview().getByRole('grid')).toHaveCount(0)
    await expect(preview()).toContainText('00 01 02 ff 80 12 1d 58')
    await openAsset('corrupt')
    await expect(preview().getByRole('alert')).toContainText('交付物校验失败')
    await expect(preview()).not.toContainText('must not render unverified text')
  })
  test('大文本只挂载可见行且切换后复用已验证内容', async () => {
    await openAsset('large')
    const grid = preview().getByRole('grid', { name: 'large.mjs 文本预览', exact: true })
    await expect(grid).toHaveAttribute('aria-rowcount', '5002')
    await expect(grid).toContainText('LINE_1 ')
    largeText.byteSize = assets.find(asset => asset.id === 'large')!.bytes.length
    largeText.totalRows = Number(await grid.getAttribute('aria-rowcount'))
    largeText.initialMountedRows = await grid.getByRole('row').count()
    expect(largeText.initialMountedRows).toBeLessThan(100)
    await grid.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(grid).toContainText('LARGE_END_READY')
    largeText.endMountedRows = await grid.getByRole('row').count()
    expect(largeText.endMountedRows).toBeLessThan(100)
    const previous = reads.filter(id => id === 'large').length
    await openAsset('mjs'); await openAsset('large')
    await expect(grid).toBeVisible()
    expect(reads.filter(id => id === 'large')).toHaveLength(previous)
    expect(previous).toBe(1)
    expect(reads.filter(id => id === 'mjs')).toHaveLength(1)
  })
})
