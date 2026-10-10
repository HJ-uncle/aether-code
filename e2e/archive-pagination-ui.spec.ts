/** Real Electron: authenticated paged history, same-count edits, and a delayed old-source response. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..'), sessionId = 'archive-pagination-session', token = 'archive-pagination-token'
let fixture = '', app: ElectronApplication | undefined, page: Page, revision = 'r1', holdPage = false, held: ServerResponse | undefined
const errors: string[] = [], calls: Array<{ source: string; current: number; pageSize: number }> = []
const rows: EngineHistoryRow[] = Array.from({ length: 301 }, (_, index) => [
  { id: 'u-' + index, role: 'user', content: 'ARCHIVE_USER_' + index, conversationId: 'turn-' + index, createdAt: index * 2 + 1 },
  { id: 'a-' + index, role: 'assistant', content: 'ARCHIVE_REPLY_' + index, conversationId: 'turn-' + index, createdAt: index * 2 + 2, modelId: index % 2 ? 'glm-5.3' : 'kimi-k2.6', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
]).flat()
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function snapshot(source: string, id = sessionId) {
  const history = source === 'a' ? [{ id: 'summary', role: 'system', metadata: { isCompactSummary: true } }, ...rows.slice(-2)] : [{ id: 'source-b-user', role: 'user', content: 'SOURCE_B_HISTORY', conversationId: 'source-b-turn' }, { id: 'source-b-assistant', role: 'assistant', content: 'SOURCE_B_REPLY', modelId: 'MiniMax-M2.5', conversationId: 'source-b-turn' }]
  return { schemaVersion: 1, source: 'persisted', sessionId: id, eventId: null, finished: true, projection: [], runs: [], history, historyCompacted: source === 'a', todos: [], changes: [], commandJobs: [] }
}
function serve(source: string): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    response.setHeader('content-type', 'application/json')
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    if (path === '/api/v1/conversation/archive') {
      const current = Number(url.searchParams.get('current')), pageSize = Number(url.searchParams.get('pageSize'))
      calls.push({ source, current, pageSize })
      if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) { response.writeHead(400).end(JSON.stringify({ code: 400, message: 'Archive requests must be truly bounded' })); return }
      if (holdPage && source === 'a' && pageSize === 200) { held = response; return }
      response.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, archiveRevision: revision } })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'd'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'archive-source-' + source }
      : path === '/api/v1/chat/snapshot' ? snapshot(source, url.searchParams.get('sessionId') ?? sessionId)
      : path === '/api/v1/models' ? ['glm-5.3', 'kimi-k2.6', 'MiniMax-M2.5'].map(modelId => ({ id: modelId, modelId, provider: 'openai', displayName: modelId, isEnabled: true, capabilities: { contextWindow: 100000 } }))
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/archive', entries: [] }
      : []
    response.end(envelope(data))
  })
}
const primary = serve('a'), secondary = serve('b')
const origin = (server: Server) => 'http://127.0.0.1:' + (server.address() as AddressInfo).port
const archiveButton = () => page.locator('.chat__load-earlier[data-archive-page]')
async function loadPage() {
  await archiveButton().click()
  await expect.poll(async () => await archiveButton().count() === 0 || !(await archiveButton().isDisabled())).toBe(true)
}
test.describe.serial('归档真实分页、编辑同步和连接隔离', () => {
  test.beforeAll(async () => {
    for (const server of [primary, secondary]) await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'archive-pagination-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin(primary), autoStartEngine: true, lastSessionId: '', thinkingMode: 'off' }))
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    const key = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl: origin(primary) }))
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key) ?? '', key)).not.toBe('')
    await page.evaluate(({ key, sessionId }) => localStorage.setItem(key, sessionId), { key, sessionId }); await page.reload()
    await expect(page.locator('.message--user')).toContainText('ARCHIVE_USER_300')
  })
  test.afterAll(async () => {
    held?.destroy(); await app?.close()
    for (const server of [primary, secondary]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('archive-pagination-ui-')) throw new Error('Unsafe archive fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('先读取尾页再逐页前插，完整用户ID顺序、turn与模型保持准确，HTTP没有全量请求', async () => {
    while (await archiveButton().count()) await loadPage()
    expect(calls.slice(0, 2)).toEqual([{ source: 'a', current: 1, pageSize: 1 }, { source: 'a', current: 4, pageSize: 200 }])
    expect(calls.filter(call => call.pageSize === 200).map(call => call.current)).toEqual([4, 3, 2, 1])
    expect(calls.every(call => call.pageSize <= 200)).toBe(true)
    const userIds = await page.locator('.message--user[data-message-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id')))
    expect(userIds).toEqual(Array.from({ length: 301 }, (_, index) => 'u-' + index))
    await expect(page.locator('.message--user[data-message-id="u-0"]')).toHaveAttribute('data-turn-id', 'turn-0')
    await expect(page.locator('.message--user[data-message-id="u-300"]')).toHaveAttribute('data-turn-id', 'turn-300')
    expect(await page.locator('.turn-usage__model').allTextContents()).toEqual(Array.from({ length: 301 }, (_, index) => index % 2 ? 'glm-5.3' : 'kimi-k2.6'))
    expect(errors).toEqual([])
  })
  test('相同消息数量下的编辑更新会刷新已载入归档窗口，保留消息与轮次ID', async () => {
    await page.reload(); await expect(archiveButton()).toBeVisible(); await loadPage(); await loadPage()
    rows[501] = { ...rows[501], content: 'ARCHIVE_REPLY_250_CORRECTED' }; revision = 'r2'
    await loadPage()
    const edited = page.locator('.message--assistant[data-message-id="a-250"]')
    await expect(edited).toContainText('ARCHIVE_REPLY_250_CORRECTED')
    await expect(edited).toHaveAttribute('data-turn-id', 'turn-250')
    expect(errors).toEqual([])
  })
  test('延迟归档响应在切换引擎来源后被丢弃，相同会话ID也不能串历史', async () => {
    await page.reload(); await expect(archiveButton()).toBeVisible(); holdPage = true
    await archiveButton().click(); await expect.poll(() => Boolean(held)).toBe(true)
    const destination = origin(secondary)
    const key = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl: destination }))
    await page.evaluate(async ({ destination, key, sessionId }) => {
      localStorage.setItem(key, sessionId)
      await window.aether.settings.update({ remoteBaseUrl: destination })
      await window.aether.engine.restart()
    }, { destination, key, sessionId })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(page.locator('.message--user')).toContainText('SOURCE_B_HISTORY')
    held?.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice(600), pagination: { current: 4, pageSize: 200, total: rows.length, totalPages: 4 }, metadata: { archiveMessageCount: rows.length, archiveRevision: revision } }))
    holdPage = false
    // Let the late HTTP result and its IPC callback settle across actual render frames.
    await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))))
    await expect(page.locator('.message--user')).not.toContainText('ARCHIVE_USER_300')
    await expect(page.locator('.message--user')).toContainText('SOURCE_B_HISTORY')
    expect(await archiveButton().count()).toBe(0)
    expect(errors).toEqual([])
  })
})
