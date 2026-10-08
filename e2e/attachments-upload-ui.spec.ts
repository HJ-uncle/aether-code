/** Real renderer -> preload -> main -> HTTP attachment uploads. The server reads
 * multipart bytes and controls completion/failure; cancellation must close the
 * actual fetch, not merely hide its busy indicator. No upload IPC is mocked. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'attachment-upload-fixture-token'
const workspaceRoot = '/remote/attachment-upload-fixture'
const initialSession = 'attachment-upload-initial'
type UploadMode = 'success' | 'hold' | 'http-error' | 'bad-size'
interface UploadRecord {
  tag: string
  sessionId: string
  path: string
  fileName: string
  type: string
  bytes: Buffer
  response: ServerResponse
  mode: UploadMode
  aborted: boolean
}
const planned = new Map<string, UploadMode>()
const uploads: UploadRecord[] = []
const infoRequests: Array<{ sessionId: string; path: string }> = []
const snapshots = new Set<string>()
const serverErrors: string[] = []
const pageErrors: string[] = []
let fixture = ''
let selectionKey = ''
let server: Server | undefined
let app: ElectronApplication | undefined
let page: Page

function envelope(data: unknown, code = 200, message = 'ok'): string { return JSON.stringify({ code, message, data }) }
function bytesFor(tag: string): Buffer { return Buffer.from(`attachment-case:${tag}\n真实附件内容\r\nUTF-8 and exact bytes: \u0000\u00ff\n`, 'utf8') }
function uploadRecord(tag: string): UploadRecord {
  const record = uploads.find(item => item.tag === tag)
  if (!record) throw new Error(`Upload has not reached the server: ${tag}`)
  return record
}
function finishUpload(record: UploadRecord): void {
  // A cancelled client has already closed this response; a late server result
  // must not need a live browser window or revive a discarded request.
  if (record.response.destroyed || record.response.writableEnded) return
  record.response.end(envelope({ path: record.path, size: record.bytes.length, filename: record.fileName }))
}
async function receiveUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData()
  const file = form.get('file')
  if (!file || typeof file === 'string') throw new Error('Missing multipart file')
  const bytes = Buffer.from(await file.arrayBuffer())
  const tag = bytes.toString('utf8').match(/^attachment-case:([^\r\n]+)/)?.[1]
  if (!tag || !planned.has(tag)) throw new Error(`Unexpected upload fixture: ${tag}`)
  const record: UploadRecord = {
    tag, sessionId: String(form.get('sessionId') ?? ''), path: String(form.get('path') ?? ''),
    fileName: file.name, type: file.type, bytes, response, mode: planned.get(tag)!, aborted: false
  }
  response.on('close', () => { record.aborted = !response.writableEnded })
  uploads.push(record)
  if (record.mode === 'hold') return
  if (record.mode === 'http-error') {
    response.writeHead(500)
    response.end(envelope(null, 50000, 'UPLOAD_FIXTURE_UNAVAILABLE'))
    return
  }
  finishUpload(record)
}

const busy = () => page.locator('.chat__composer .attach-chip--busy')
const attached = () => page.locator('.chat__composer .attach-chip:not(.attach-chip--busy)')
const errorAlert = () => page.locator('.chat-panel [role="alert"]')
const sendButton = () => page.getByRole('button', { name: '发送', exact: true })
async function selectedSession(): Promise<string> { return page.evaluate(key => localStorage.getItem(key) ?? '', selectionKey) }
async function pickFile(tag: string, mode: UploadMode = 'success', name = `${tag}.txt`): Promise<UploadRecord> {
  const previousCount = uploads.length
  planned.set(tag, mode)
  await page.locator('.chat__composer input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: bytesFor(tag) })
  await expect.poll(() => uploads.slice(previousCount).some(item => item.tag === tag), { timeout: 10_000, message: `${tag}: file never reached the actual HTTP server` }).toBe(true)
  return uploads.slice(previousCount).find(item => item.tag === tag)!
}
async function expectReady(name: string): Promise<void> {
  await expect(attached().filter({ hasText: name })).toHaveCount(1)
  await expect(busy()).toHaveCount(0)
  await expect(page.getByRole('button', { name: '取消上传', exact: true })).toHaveCount(0)
  await expect(sendButton()).toBeEnabled()
}
async function expectAborted(record: UploadRecord): Promise<void> {
  await expect.poll(() => record.aborted, { timeout: 10_000, message: `${record.tag}: cancelling the UI did not abort the main-process HTTP request` }).toBe(true)
}

test.describe.serial('聊天附件真实上传、失败与取消', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'attachments-upload-ui-'))
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        response.setHeader('content-type', 'application/json')
        if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
          response.writeHead(401); response.end(envelope(null, 401, 'Invalid fixture token')); return
        }
        if (path === '/api/v1/workspace/upload') { await receiveUpload(request, response); return }
        if (path === '/api/v1/workspace/file/info') {
          const query = { sessionId: url.searchParams.get('sessionId') ?? '', path: url.searchParams.get('path') ?? '' }
          infoRequests.push(query)
          const record = uploads.find(item => item.sessionId === query.sessionId && item.path === query.path)
          if (!record) { response.end(envelope(null, 40400, 'File not found')); return }
          response.end(envelope({ workspacePath: `${workspaceRoot}/${record.path}`, size: record.bytes.length + (record.mode === 'bad-size' ? 1 : 0) }))
          return
        }
        if (path === '/api/v1/chat/snapshot') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          snapshots.add(sessionId)
          response.end(envelope({ schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] }))
          return
        }
        const data = path === '/health' ? { status: 'ok' }
          : path === '/meta' ? { version: '1.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'attachments-upload-fixture' }
          : path === '/api/v1/chat/runs' ? { runs: [] }
          : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
          : []
        response.end(envelope(data))
      })().catch(error => {
        serverErrors.push(String(error))
        if (!response.headersSent) response.writeHead(500)
        if (!response.destroyed) response.end(envelope(null, 50000, String(error)))
      })
    })
    await new Promise<void>((resolveListen, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolveListen) })
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    selectionKey = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl: remoteUrl }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, remoteWorkspaceRoot: '', autoStartEngine: true, lastFolder: '', lastSessionId: initialSession }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' }
    for (const key of Object.keys(env)) {
      if (['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    // Only native dialogs are intercepted so an old implementation fails its
    // assertion instead of blocking the runner behind a hidden OS window.
    await app.evaluate(({ dialog }) => {
      Reflect.set(globalThis, '__attachmentUploadDialogs', [])
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async (...args: unknown[]) => {
        const calls = Reflect.get(globalThis, '__attachmentUploadDialogs') as unknown[]
        calls.push(args.at(-1))
        return { response: 1, checkboxChecked: false }
      } })
    })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await expect.poll(selectedSession).not.toBe('')
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: selectionKey, value: initialSession })
    await page.reload()
    await expect.poll(() => snapshots.has(initialSession)).toBe(true)
    await page.clock.install()
  })

  test.beforeEach(async () => {
    const previous = await selectedSession()
    await page.locator('.chat-panel').getByRole('button', { name: '新建', exact: true }).click()
    await expect.poll(selectedSession).not.toBe(previous)
    const session = await selectedSession()
    await expect.poll(() => snapshots.has(session)).toBe(true)
    await expect(attached()).toHaveCount(0)
    await expect(busy()).toHaveCount(0)
    await page.locator('.chat__input').fill('附件上传回归：发送按钮应在完成或失败后恢复')
    await expect(sendButton()).toBeEnabled()
  })
  test.afterEach(async () => {
    expect(serverErrors).toEqual([])
    expect(pageErrors).toEqual([])
    expect(await app!.evaluate(() => (Reflect.get(globalThis, '__attachmentUploadDialogs') as unknown[]).length), '选择文件后不得再等待原生确认窗口').toBe(0)
  })
  test.afterAll(async () => {
    await app?.close()
    if (server) { server.closeAllConnections(); await new Promise<void>(resolveClose => server!.close(() => resolveClose())) }
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('attachments-upload-ui-')) throw new Error('Unsafe attachment fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('选择文件直接上传真实字节，核验远端路径和大小后恢复发送', async ({}, testInfo) => {
    const record = await pickFile('success', 'hold', '真实附件.txt')
    await expect(busy()).toContainText('真实附件.txt')
    await expect(sendButton()).toBeDisabled()
    await expect(page.getByRole('button', { name: '取消上传', exact: true })).toBeVisible()
    const screenshot = testInfo.outputPath('attachment-upload-pending.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('附件上传中与取消入口', { path: screenshot, contentType: 'image/png' })
    expect(record.bytes).toEqual(bytesFor('success'))
    expect(record.sessionId).toBe(await selectedSession())
    expect(record.type).toBe('text/plain')
    expect(record.path).toMatch(/^\.ae\/attachments\/[a-zA-Z0-9_-]+\.txt$/)
    expect(record.fileName).toBe(record.path.slice('.ae/attachments/'.length))
    finishUpload(record)
    await expectReady('真实附件.txt')
    expect(infoRequests).toContainEqual({ sessionId: record.sessionId, path: record.path })
  })

  test('HTTP 失败退出上传状态，错误持续可见且同一文件可重试', async ({}, testInfo) => {
    await pickFile('http-failed', 'http-error', '重试文件.txt')
    await expect(busy()).toHaveCount(0)
    await expect(errorAlert()).toContainText('UPLOAD_FIXTURE_UNAVAILABLE')
    await expect(sendButton()).toBeEnabled()
    await page.clock.fastForward(15_000)
    await expect(errorAlert()).toContainText('UPLOAD_FIXTURE_UNAVAILABLE')
    const screenshot = testInfo.outputPath('attachment-upload-error.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('附件上传失败提示', { path: screenshot, contentType: 'image/png' })
    await page.getByRole('button', { name: '关闭附件错误', exact: true }).click()
    await expect(errorAlert()).toHaveCount(0)
    await pickFile('http-failed', 'success', '重试文件.txt')
    await expectReady('重试文件.txt')
  })

  test('上传响应成功但文件信息大小不符时拒绝附加并恢复输入', async () => {
    await pickFile('bad-size', 'bad-size', '校验失败.txt')
    await expect(busy()).toHaveCount(0)
    await expect(attached()).toHaveCount(0)
    await expect(errorAlert()).toContainText(/路径|大小|校验/)
    await expect(sendButton()).toBeEnabled()
  })

  test('挂起上传可取消，实际 HTTP 连接中止且可立即重新上传', async () => {
    await pickFile('keep-completed')
    await expectReady('keep-completed.txt')
    const record = await pickFile('cancel-held', 'hold')
    await expect(busy()).toContainText('cancel-held.txt')
    await page.getByRole('button', { name: '取消上传', exact: true }).click()
    await expect(busy()).toHaveCount(0)
    await expect(sendButton()).toBeEnabled()
    await expectAborted(record)
    await expect(attached()).toHaveCount(1)
    await expect(attached()).toContainText('keep-completed.txt')
    finishUpload(record)
    await pickFile('after-cancel')
    await expectReady('after-cancel.txt')
    await expect(attached()).toHaveCount(2)
  })

  test('切换会话取消在途上传，旧会话迟到结果不能进入新会话', async () => {
    const record = await pickFile('old-session', 'hold')
    await page.locator('.chat-panel').getByRole('button', { name: '新建', exact: true }).click()
    await expect.poll(selectedSession).not.toBe(record.sessionId)
    const session = await selectedSession()
    await expect.poll(() => snapshots.has(session)).toBe(true)
    await expect(busy()).toHaveCount(0)
    await expectAborted(record)
    finishUpload(record)
    await pickFile('new-session')
    await expectReady('new-session.txt')
    await expect(attached()).toHaveCount(1)
    expect(uploadRecord('new-session').sessionId).toBe(session)
    await expect(attached()).not.toContainText('old-session.txt')
  })

  test('两批并发上传中第一批完成不会提前解除第二批忙碌状态', async () => {
    const first = await pickFile('concurrent-first', 'hold')
    const second = await pickFile('concurrent-second', 'hold')
    finishUpload(first)
    await expect(attached().filter({ hasText: 'concurrent-first.txt' })).toHaveCount(1)
    await expect(busy()).toContainText('concurrent-second.txt')
    await expect(sendButton()).toBeDisabled()
    finishUpload(second)
    await expectReady('concurrent-second.txt')
    await expect(attached()).toHaveCount(2)
  })

  test('120 秒无响应显示持久超时错误，取消实际请求且恢复后能再传', async () => {
    const record = await pickFile('timeout-held', 'hold')
    await expect(busy()).toContainText('timeout-held.txt')
    await page.clock.fastForward(120_001)
    await expect(busy()).toHaveCount(0)
    await expect(errorAlert()).toContainText('超时')
    await expect(sendButton()).toBeEnabled()
    await expectAborted(record)
    await page.clock.fastForward(15_000)
    await expect(errorAlert()).toContainText('超时')
    await pickFile('after-timeout')
    await expectReady('after-timeout.txt')
    await expect(attached()).toHaveCount(1)
  })
})
