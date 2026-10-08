/**
 * Real Electron/xterm/IPC/HTTP/WebSocket terminal actions. The remote process is
 * an isolated protocol fixture: assertions cover retained output attachments,
 * target-tab actions, same-process reconnection, restart and actual disposal.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const sessionId = 'terminal-actions-session'
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server
let sockets: WebSocketServer
let rejectCreate = false
let createCalls = 0
let chatMutations = 0
let delayAttachment = false
let releaseAttachment: (() => void) | undefined
let delayCreate = false
let releaseCreate: (() => void) | undefined
const snapshotSessions: string[] = []
const createBodies: Array<{ sessionId?: string }> = []
const connections: string[] = []
const deleted = new Set<string>()
const clients = new Map<string, WebSocket>()
const frames: Array<{ id: string; type: string; data?: string }> = []
const attachments: Array<{ path: string; content: string; sessionId?: string }> = []
const pageErrors: string[] = []
const longLine = 'wrapped-output-' + 'abcdefghij'.repeat(35) + '-中文结尾'
const initialBanner = 'initial remote shell banner\n'
const firstOutput = 'first terminal retained output\n' + longLine + '\n'

function tab(name: string): Locator {
  return page.locator('.terminal-view__item').filter({ has: page.locator('.terminal-view__item-label', { hasText: new RegExp('^' + name + '(?:（.*）)?$') }) })
}

async function menuOn(target: Locator): Promise<void> {
  await target.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
}

async function choose(label: string): Promise<void> {
  await page.getByRole('menuitem', { name: new RegExp('^' + label + '(?:\\s|$)') }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

async function output(id: string, content: string): Promise<void> {
  await expect.poll(() => clients.has(id)).toBe(true)
  clients.get(id)!.send(JSON.stringify({ type: 'output', data: content.replace(/\n/g, '\r\n') }))
  // A fresh output chunk is parsed on xterm's scheduled render; the subsequent
  // menu snapshots must occur after that pass, not merely after WS delivery.
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test.describe.serial('终端右键菜单与恢复连接', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'terminal-actions-'))
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      const reply = (data: unknown, status = 200, message = 'ok'): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: status, message, data }))
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/v1/chat/')) chatMutations++
      if (url.pathname === '/health') return reply({ status: 'ok' })
      if (url.pathname === '/meta') return reply({ version: '1.0.0', buildId: 'sha256:' + 'd'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'terminal-actions-fixture' })
      if (url.pathname === '/auth/account/providers') return reply({ providers: [], registrationEnabled: true })
      if (url.pathname === '/api/v1/chat/snapshot') {
        const requestedSession = url.searchParams.get('sessionId') ?? sessionId
        snapshotSessions.push(requestedSession)
        return reply({ schemaVersion: 1, source: 'persisted', sessionId: requestedSession, finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      }
      if (url.pathname === '/api/v1/chat/runs') return reply({ runs: [] })
      if (url.pathname === '/api/v1/workspace/directory') return reply({ root: '/terminal/workspace', entries: [] })
      if (url.pathname === '/api/v1/workspace/file/info') {
        const file = attachments.find(item => item.path === url.searchParams.get('path'))
        return file ? reply({ isDirectory: false, size: Buffer.byteLength(file.content), mtimeMs: 1 }) : reply(null, 404, 'not found')
      }
      if (url.pathname === '/api/v1/workspace/file' && request.method === 'POST') {
        const path = String(body.path)
        const content = body.encoding === 'base64' ? Buffer.from(String(body.content), 'base64').toString('utf8') : String(body.content)
        if (!/^\.ae\/attachments\/terminal-[^/]+\.txt$/.test(path)) return reply(null, 400, 'Unexpected attachment path')
        attachments.push({ path, content, sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined })
        if (delayAttachment) {
          delayAttachment = false
          await new Promise<void>(done => { releaseAttachment = done })
        }
        return reply({ success: true })
      }
      if (url.pathname === '/api/v1/terminal/create') {
        createCalls++
        const createNumber = createCalls
        createBodies.push(body)
        if (delayCreate) {
          delayCreate = false
          await new Promise<void>(done => { releaseCreate = done })
        }
        return rejectCreate ? reply(null, 503, '测试终端暂时无法启动') : reply({ terminalId: 'actions-' + createNumber })
      }
      if (url.pathname.startsWith('/api/v1/terminal/') && request.method === 'DELETE') {
        deleted.add(decodeURIComponent(url.pathname.slice('/api/v1/terminal/'.length)))
        return reply({ success: true })
      }
      return reply([])
    })
    sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
    })
    sockets.on('connection', (client, request) => {
      const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
      if (!pathname.startsWith('/api/v1/terminal/ws/')) return
      const id = decodeURIComponent(pathname.slice('/api/v1/terminal/ws/'.length))
      connections.push(id)
      clients.set(id, client)
      // Native shells may emit their banner as soon as WS is accepted, before
      // terminal:create has returned over IPC and the renderer registers it.
      if (id === 'actions-1' && connections.filter(value => value === id).length === 1) {
        client.send(JSON.stringify({ type: 'output', data: initialBanner.replace(/\n/g, '\r\n') }))
      }
      client.on('close', () => { if (clients.get(id) === client) clients.delete(id) })
      client.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string }
        frames.push({ id, ...message })
        if (message.type === 'input') client.send(JSON.stringify({ type: 'output', data: message.data }))
        if (message.type === 'kill') deleted.add(id)
      })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const remoteUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: sessionId, lastFolder: '' }))
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: environment })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
    const snapshot = await page.evaluate(() => window.aether.engine.start())
    expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    await page.keyboard.press('Control+`')
    await expect(page.locator('.terminal-view .xterm-screen')).toBeVisible()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    await expect.poll(() => frames.some(frame => frame.id === 'actions-1' && frame.type === 'resize')).toBe(true)
    await output('actions-1', firstOutput)
  })

  test.afterEach(() => expect(pageErrors).toEqual([]))
  test.afterAll(async () => {
    releaseAttachment?.()
    releaseCreate?.()
    try { await app?.close() } finally {
      for (const client of sockets?.clients ?? []) client.terminate()
      sockets?.close()
      server?.closeAllConnections()
      if (server) await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('terminal-actions-')) throw new Error('Unsafe terminal actions fixture cleanup')
        rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  })

  test('标签右键创建终端，对非活动标签重命名仅修改目标', async ({}, testInfo) => {
    await tab('终端 1').focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await menuOn(tab('终端 1'))
    await page.screenshot({ path: testInfo.outputPath('terminal-context-menu.png') })
    await choose('新建终端')
    await expect(page.locator('.terminal-view__item')).toHaveCount(2)
    await expect(tab('终端 2')).toHaveAttribute('aria-selected', 'true')
    await menuOn(tab('终端 1'))
    await choose('重命名')
    const dialog = page.getByRole('dialog', { name: '重命名终端', exact: true })
    await dialog.locator('input').fill('构建日志')
    await dialog.getByRole('button', { name: '确定', exact: true }).click()
    await expect(tab('构建日志')).toHaveCount(1)
    await expect(tab('终端 2')).toHaveCount(1)
    await expect(tab('终端 1')).toHaveCount(0)
    expect(createCalls).toBe(2)
  })

  test('无选区添加完整输出，保留启动欢迎语与折行并展开对话但不自动发送', async () => {
    const hideChat = page.getByRole('button', { name: '关闭对话面板', exact: true })
    if (await hideChat.isVisible()) await hideChat.click()
    const before = chatMutations
    await menuOn(tab('构建日志'))
    await choose('添加到当前会话')
    await expect(page.locator('.mention-input')).toBeVisible()
    await expect(page.locator('.mention-chip--terminal')).toContainText('构建日志')
    await expect.poll(() => attachments.length).toBe(1)
    expect(attachments[0].content.trimEnd()).toBe((initialBanner + firstOutput).trimEnd())
    expect(attachments[0].content).not.toContain('\x1b')
    expect(attachments[0].sessionId).toBe(createBodies[0].sessionId)
    expect(chatMutations).toBe(before)
  })

  test('内容区全选后可添加选区，再清屏不会保留旧输出', async () => {
    await tab('终端 2').click()
    await output('actions-2', 'second-terminal-selection\n')
    const screen = page.locator('.terminal-view__session:visible .xterm-screen')
    await menuOn(screen)
    await choose('全选')
    await menuOn(screen)
    await choose('添加到当前会话')
    await expect.poll(() => attachments.length).toBe(2)
    expect(attachments[1].content.trimEnd()).toBe('second-terminal-selection')
    expect(attachments[1].path).not.toBe(attachments[0].path)
    await menuOn(screen)
    await choose('清屏')
    await menuOn(screen)
    await expect(page.getByRole('menuitem', { name: /^添加到当前会话(?:\s|$)/ })).toBeDisabled()
    await page.keyboard.press('Escape')
  })

  test('连接中断后恢复同一远端进程，不创建替代终端且保留原输出', async () => {
    await tab('构建日志').click()
    clients.get('actions-1')!.terminate()
    await expect(tab('构建日志')).toContainText('已断开')
    await menuOn(tab('构建日志'))
    await expect(page.getByRole('menuitem', { name: /^粘贴(?:\s|$)/ })).toBeDisabled()
    await choose('恢复终端连接')
    await expect(tab('构建日志')).not.toContainText('已断开')
    await expect.poll(() => connections.filter(id => id === 'actions-1').length).toBe(2)
    expect(createCalls).toBe(2)
    expect(deleted.has('actions-1')).toBe(false)
    await output('actions-1', 'after reconnect\n')
    await menuOn(tab('构建日志'))
    await choose('添加到当前会话')
    await expect.poll(() => attachments.length).toBe(3)
    expect(attachments[2].content).toContain(longLine)
    expect(attachments[2].content).toContain('after reconnect')
    const screen = page.locator('.terminal-view__session:visible .xterm-screen')
    await screen.click({ position: { x: 8, y: 8 } })
    await page.keyboard.type('same-process-input')
    await expect.poll(() => frames.filter(frame => frame.id === 'actions-1' && frame.type === 'input').map(frame => frame.data).join('')).toContain('same-process-input')
  })

  test('进程退出后重启失败保留原标签，重试成功替换进程且保留名称', async () => {
    clients.get('actions-1')!.send(JSON.stringify({ type: 'exit', code: 7 }))
    await expect(tab('构建日志')).toContainText('已退出')
    rejectCreate = true
    await menuOn(tab('构建日志'))
    await choose('重新启动终端')
    await expect(page.getByText(/测试终端暂时无法启动/).last()).toBeVisible()
    await expect(tab('构建日志')).toContainText('已退出')
    await expect(page.locator('.terminal-view__item')).toHaveCount(2)
    rejectCreate = false
    await menuOn(tab('构建日志'))
    await choose('重新启动终端')
    await expect(tab('构建日志')).not.toContainText('已退出')
    await expect(page.locator('.terminal-view__item')).toHaveCount(2)
    await expect.poll(() => clients.has('actions-4')).toBe(true)
    await expect.poll(() => deleted.has('actions-1')).toBe(true)
    expect(createBodies[3].sessionId).toBe(createBodies[0].sessionId)
  })

  test('附件写入途中切换会话，旧结果不会插入新会话并明确提示失败', async () => {
    await output('actions-4', 'attachment belongs to original session\n')
    delayAttachment = true
    await menuOn(tab('构建日志'))
    await choose('添加到当前会话')
    await expect.poll(() => Boolean(releaseAttachment)).toBe(true)
    await page.getByTitle('新建会话（开一条全新对话）', { exact: true }).click()
    await expect.poll(() => snapshotSessions.at(-1)).not.toBe(createBodies[0].sessionId)
    await expect(page.locator('.mention-chip--terminal')).toHaveCount(0)
    releaseAttachment!()
    releaseAttachment = undefined
    await expect(page.getByText(/添加终端输出失败/).last()).toBeVisible()
    await expect(page.locator('.mention-chip--terminal')).toHaveCount(0)
    expect(attachments[3]).toMatchObject({ content: 'attachment belongs to original session', sessionId: createBodies[0].sessionId })
  })

  test('关闭其他终端保留右键目标，关闭全部销毁远端进程且重开面板不自动新建', async () => {
    await tab('构建日志').click()
    await menuOn(tab('终端 2'))
    await choose('关闭其他终端')
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    await expect(tab('终端 2')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => deleted.has('actions-4')).toBe(true)
    expect(deleted.has('actions-2')).toBe(false)
    await menuOn(tab('终端 2'))
    await choose('关闭全部终端')
    await expect(page.locator('.terminal-view__item')).toHaveCount(0)
    await expect.poll(() => deleted.has('actions-2')).toBe(true)
    const before = createCalls
    await page.keyboard.press('Control+`')
    await page.keyboard.press('Control+`')
    await expect(page.locator('.terminal-view')).toBeVisible()
    await expect(page.locator('.terminal-view__item')).toHaveCount(0)
    expect(createCalls).toBe(before)
  })

  test('新建请求尚未返回时关闭全部，延迟创建的远端进程会被清理且不复活标签', async () => {
    await page.getByRole('button', { name: '创建终端', exact: true }).click()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    await expect.poll(() => clients.has('actions-5')).toBe(true)
    delayCreate = true
    await menuOn(page.locator('.terminal-view__item'))
    await choose('新建终端')
    await expect.poll(() => Boolean(releaseCreate)).toBe(true)
    await menuOn(page.locator('.terminal-view__item'))
    await choose('关闭全部终端')
    await expect(page.locator('.terminal-view__item')).toHaveCount(0)
    releaseCreate!()
    releaseCreate = undefined
    await expect.poll(() => deleted.has('actions-6')).toBe(true)
    await expect.poll(() => clients.has('actions-6')).toBe(false)
    await expect(page.locator('.terminal-view__item')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '创建终端', exact: true })).toBeEnabled()
    expect(createCalls).toBe(6)
  })
})
