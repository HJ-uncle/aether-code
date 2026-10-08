/**
 * Real Electron/preload/IPC/HTTP/WebSocket clipboard regression. Only the remote
 * engine/PTY is a protocol fixture. Native clipboard and xterm keyboard/menu
 * interactions are real: exactly-once paste, newline normalization, selection
 * copy, empty clipboard feedback and disconnected/closed sessions.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
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
const terminalClients = new Set<WebSocket>()
const frames: Array<{ type: string; data?: string }> = []
const expectedInputs: string[] = []
const pageErrors: string[] = []

function inputs(): string[] {
  return frames.filter(frame => frame.type === 'input').map(frame => frame.data ?? '')
}

async function expectInputs(): Promise<void> {
  await expect.poll(inputs).toEqual(expectedInputs)
  expect(inputs().join('')).not.toContain('\x16')
}

async function withClipboard(text: string, run: () => Promise<void>, copiedTexts: string[] = []): Promise<void> {
  const instance = app!
  // Preserve common rich clipboard formats together, not just the text. Restore
  // only while the clipboard still contains content owned by this test.
  const previous = await instance.evaluate(({ clipboard }) => ({
    formats: clipboard.availableFormats(),
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage().toPNG().toString('base64'),
    bookmark: clipboard.readBookmark()
  }))
  await instance.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
  try {
    await run()
  } finally {
    await instance.evaluate(({ clipboard, nativeImage }, saved) => {
      if (!saved.owned.includes(clipboard.readText())) return
      if (saved.previous.formats.length === 0) {
        clipboard.clear()
        return
      }
      const data: {
        text?: string
        html?: string
        rtf?: string
        image?: ReturnType<typeof nativeImage.createFromBuffer>
        bookmark?: string
      } = {}
      if (saved.previous.text || saved.previous.formats.some(format => /text|unicode/i.test(format))) data.text = saved.previous.text
      if (saved.previous.html) data.html = saved.previous.html
      if (saved.previous.rtf) data.rtf = saved.previous.rtf
      if (saved.previous.image) data.image = nativeImage.createFromBuffer(Buffer.from(saved.previous.image, 'base64'))
      if (saved.previous.bookmark.title) data.bookmark = saved.previous.bookmark.title
      clipboard.write(data)
    }, { previous, owned: [text, ...copiedTexts] })
  }
}

async function terminalFocus(): Promise<void> {
  await page.locator('.terminal-view .xterm-screen').click({ position: { x: 8, y: 8 } })
}

test.describe.serial('终端真实剪贴板', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'terminal-clipboard-'))
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
      for await (const _chunk of request) { /* drain request body before replying */ }
      const reply = (data: unknown, status = 200): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: status, message: 'ok', data }))
      }
      if (pathname === '/health') return reply({ status: 'ok' })
      if (pathname === '/meta') return reply({ version: '1.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'terminal-clipboard-fixture' })
      if (pathname === '/auth/account/providers') return reply({ providers: [], registrationEnabled: true })
      if (pathname === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'terminal-clipboard-session', finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      if (pathname === '/api/v1/chat/runs') return reply({ runs: [] })
      if (pathname === '/api/v1/workspace/directory') return reply({ root: '/terminal/workspace', entries: [] })
      if (pathname === '/api/v1/terminal/create') return reply({ terminalId: 'clipboard-' + ++createCalls })
      return reply([])
    })
    sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
    })
    sockets.on('connection', (client, request) => {
      if (!(request.url ?? '').includes('/api/v1/terminal/ws/')) return
      terminalClients.add(client)
      client.on('close', () => terminalClients.delete(client))
      client.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string }
        frames.push(message)
        if (message.type === 'input') client.send(JSON.stringify({ type: 'output', data: message.data }))
      })
    })
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const remoteUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: 'terminal-clipboard-session', lastFolder: '' }))
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
    await page.keyboard.press('Control+\x60')
    await expect(page.locator('.terminal-view .xterm-screen')).toBeVisible()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    await expect.poll(() => terminalClients.size).toBe(1)
    await expect.poll(() => frames.some(frame => frame.type === 'resize')).toBe(true)
  })

  test.afterEach(async () => {
    await expectInputs()
    expect(pageErrors).toEqual([])
  })

  test.afterAll(async () => {
    await app?.close()
    for (const client of sockets?.clients ?? []) client.terminate()
    sockets?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    if (!fixture) return
    if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('terminal-clipboard-')) throw new Error('Unsafe terminal clipboard fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('Ctrl+V、Ctrl+Shift+V、Shift+Insert 各粘贴一次，不把 Ctrl+V 字符发送给终端', async () => {
    for (const [key, text] of [
      ['Control+v', 'clipboard-control-v-中文'],
      ['Control+Shift+v', 'clipboard-control-shift-v'],
      ['Shift+Insert', 'clipboard-shift-insert']
    ]) {
      await withClipboard(text, async () => {
        await terminalFocus()
        await page.keyboard.press(key)
        expectedInputs.push(text)
        await expectInputs()
      })
    }
  })

  test('无选区右键仍可粘贴，中文与 CRLF/LF 交给 xterm 统一规范化', async () => {
    const text = 'echo "你好，终端"\r\necho second\nthird\rend'
    await withClipboard(text, async () => {
      await terminalFocus()
      await page.locator('.terminal-view .xterm-screen').click({ button: 'right', position: { x: 10, y: 10 } })
      await expect(page.getByRole('menuitem', { name: /^复制(?:\s|$)/ })).toBeDisabled()
      const paste = page.getByRole('menuitem', { name: /^粘贴(?:\s|$)/ })
      await expect(paste).toBeEnabled()
      await paste.click()
      expectedInputs.push('echo "你好，终端"\recho second\rthird\rend')
      await expectInputs()
      await expect(page.getByRole('menu')).toHaveCount(0)
    })
  })

  test('实际终端选区的 Ctrl+C 与右键复制仍写入系统剪贴板', async () => {
    const marker = 'ClipboardCopyMarker'
    await withClipboard('clipboard-copy-before', async () => {
      for (const client of terminalClients) client.send(JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[H' + marker }))
      // Wait through xterm's paint scheduling before selecting the visible row.
      await page.evaluate(() => new Promise<void>(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint()))))
      const screen = page.locator('.terminal-view .xterm-screen')
      await screen.dblclick({ position: { x: 16, y: 8 } })
      await page.keyboard.press('Control+c')
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(marker)
      await expectInputs()
      // The selection is cleared by copy; a second Ctrl+C must still interrupt.
      await page.keyboard.press('Control+c')
      expectedInputs.push('\x03')
      await expectInputs()

      await app!.evaluate(({ clipboard }) => clipboard.writeText('clipboard-copy-before'))
      await screen.dblclick({ position: { x: 16, y: 8 } })
      await screen.click({ button: 'right', position: { x: 16, y: 8 } })
      const copy = page.getByRole('menuitem', { name: /^复制(?:\s|$)/ })
      await expect(copy).toBeEnabled()
      await copy.click()
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(marker)
    }, [marker])
  })

  test('空剪贴板给出明确提示且不向终端发送输入', async () => {
    await withClipboard('', async () => {
      await terminalFocus()
      await page.keyboard.press('Control+v')
      await expect(page.getByText('剪贴板中没有可粘贴的文本', { exact: true })).toBeVisible()
      await expectInputs()
    })
  })

  test('远端断开后粘贴禁用，关闭终端后不保留粘贴菜单或偷偷新建会话', async () => {
    await withClipboard('clipboard-must-not-reach-closed-terminal', async () => {
      await page.evaluate(() => window.aether.engine.stop())
      await expect(page.locator('.terminal-view__item')).toContainText('已退出')
      await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeDisabled()
      await terminalFocus()
      for (const key of ['Control+v', 'Control+Shift+v', 'Shift+Insert']) await page.keyboard.press(key)
      await page.locator('.terminal-view .xterm-screen').click({ button: 'right', position: { x: 8, y: 8 } })
      await expect(page.getByRole('menuitem', { name: /^粘贴(?:\s|$)/ })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expectInputs()
      await page.getByRole('button', { name: '关闭 终端 1', exact: true }).click()
      await expect(page.locator('.terminal-view__session')).toHaveCount(0)
      await expect(page.locator('.terminal-view [role="status"]')).toContainText('等待远端引擎连接')
      await page.locator('.terminal-view__main').click({ button: 'right' })
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expectInputs()
      expect(createCalls).toBe(1)
    })
  })
})


