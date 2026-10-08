/** Real Electron/preload/IPC/HTTP/WebSocket regression for disconnected remote
 * terminals. Only the remote engine/PTY is a protocol fixture. No local PTY is
 * allowed while the selected remote service is disconnected. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server
let sockets: WebSocketServer
let createCalls = 0
let rejectCreate = false
const frames: Array<{ type: string; data?: string }> = []
const pageErrors: string[] = []
let mainErrors = ''

test.describe.serial('远端终端连接就绪', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'terminal-connection-'))
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      for await (const _chunk of request) { /* drain request body before replying */ }
      const reply = (data: unknown, status = 200, message = 'ok'): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: status, message, data }))
      }
      if (path === '/health') return reply({ status: 'ok' })
      if (path === '/meta') return reply({ version: '1.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'terminal-connection-fixture' })
      if (path === '/auth/account/providers') return reply({ providers: [], registrationEnabled: true })
      if (path === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'terminal-session', finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      if (path === '/api/v1/chat/runs') return reply({ runs: [] })
      if (path === '/api/v1/workspace/directory') return reply({ root: '/terminal/workspace', entries: [] })
      if (path === '/api/v1/terminal/create') {
        createCalls++
        return rejectCreate ? reply(null, 503, '测试终端资源暂不可用') : reply({ terminalId: `fixture-${createCalls}` })
      }
      return reply([])
    })
    sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
    })
    sockets.on('connection', client => {
      client.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string }
        frames.push(message)
        if (message.type === 'input') client.send(JSON.stringify({ type: 'output', data: message.data }))
      })
    })
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: 'terminal-session', lastFolder: '' }))
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: environment })
    app.process().stderr?.on('data', chunk => { mainErrors += chunk.toString() })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
    await page.keyboard.press('Control+`')
    await expect(page.locator('.terminal-view')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    for (const client of sockets?.clients ?? []) client.terminate()
    sockets?.close()
    server?.closeAllConnections()
    await new Promise<void>(resolveClose => server?.close(() => resolveClose()))
    if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('terminal-connection-')) throw new Error('Unsafe terminal fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('未连接时自动创建和命令入口均等待远端，不创建本地终端', async () => {
    await expect(page.locator('.terminal-view [role="status"]')).toContainText('等待远端引擎连接')
    await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeDisabled()
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette__input').fill('新建终端')
    await page.locator('.palette__item').filter({ hasText: '新建终端' }).click()
    await expect(page.locator('.terminal-view [role="status"]')).toContainText('等待远端引擎连接')
    await expect(page.locator('.terminal-view__item')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeDisabled()
    expect(createCalls).toBe(0)
    expect(mainErrors).not.toContain("handler for 'terminal:create'")
    expect(pageErrors).toEqual([])
  })

  test('连接成功后自动创建，真实启动失败保留原因且可显式重试', async () => {
    rejectCreate = true
    const snapshot = await page.evaluate(() => window.aether.engine.start())
    expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    await expect(page.locator('.terminal-view [role="alert"]')).toContainText('测试终端资源暂不可用')
    await expect(page.locator('.terminal-view__error-detail')).not.toContainText('Error invoking remote method')
    expect(createCalls).toBe(1)
    rejectCreate = false
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    expect(createCalls).toBe(2)
    await page.locator('.terminal-view .xterm').click()
    await page.keyboard.type('remote-terminal-ready')
    await expect.poll(() => frames.filter(frame => frame.type === 'input').map(frame => frame.data).join('')).toContain('remote-terminal-ready')
    await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeEnabled()
  })

  test('断开后禁止新建，主动关闭全部后重连不擅自新开终端', async () => {
    await page.evaluate(() => window.aether.engine.stop())
    await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeDisabled()
    await expect(page.locator('.terminal-view__item')).toContainText('已断开')
    await page.getByRole('button', { name: '关闭 终端 1', exact: true }).click()
    await expect(page.locator('.terminal-view [role="status"]')).toContainText('等待远端引擎连接')
    const snapshot = await page.evaluate(() => window.aether.engine.start())
    expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeEnabled()
    await expect(page.locator('.terminal-view__item')).toHaveCount(0)
    expect(createCalls).toBe(2)
    await page.getByRole('button', { name: '新建终端', exact: true }).click()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    expect(createCalls).toBe(3)
    expect(pageErrors).toEqual([])
  })
})
