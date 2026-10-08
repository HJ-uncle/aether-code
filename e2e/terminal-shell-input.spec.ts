/** Real Electron clipboard -> xterm -> remote HTTP/WS -> real engine Workspace
 * Shell/Node PTY acceptance. Assertions include filesystem side effects, not an
 * echo transport. Native PTY unavailability is reported as a capability skip. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'
import type { IPty } from 'node-pty'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const engineRoot = resolve(root, '../ai-agent-engine')
const shellPath = join(engineRoot, 'dist/terminal/workspace-shell.mjs')
const requireEngine = createRequire(join(engineRoot, 'package.json'))
const sessionId = 'terminal-shell-input-session'
interface ShellSession {
  pty: IPty
  backlog: string
  output: string
  client?: WebSocket
  ready: boolean
  stopping: boolean
  exited: boolean
}
let fixture = ''
let workspace = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server | undefined
let sockets: WebSocketServer | undefined
let nativeFailure = ''
let ptyModule: typeof import('node-pty')
const sessions = new Map<string, ShellSession>()
const inputs: string[] = []
const errors: string[] = []

function commandInputs(offset: number): string[] {
  // ConPTY enables focus reporting. Opening/closing the context menu emits
  // ESC[O/ESC[I independently of paste; retain every other input byte.
  return inputs.slice(offset).filter(data => data !== '\x1b[I' && data !== '\x1b[O')
}

function killShell(session: ShellSession): void {
  if (session.stopping || session.exited) return
  session.stopping = true
  try { session.pty.kill() } catch (error) { errors.push(`PTY cleanup failed: ${String(error)}`) }
}

function releaseOutput(session: ShellSession): void {
  session.ready = true
  if (session.backlog && session.client?.readyState === WebSocket.OPEN) {
    session.client.send(JSON.stringify({ type: 'output', data: session.backlog }))
    session.backlog = ''
  }
}

async function withClipboard(text: string, run: () => Promise<void>): Promise<void> {
  const instance = app!
  const previous = await instance.evaluate(({ clipboard }) => ({
    formats: clipboard.availableFormats(), text: clipboard.readText(),
    html: clipboard.readHTML(), rtf: clipboard.readRTF(),
    image: clipboard.readImage().toPNG().toString('base64'), bookmark: clipboard.readBookmark()
  }))
  await instance.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
  try { await run() } finally {
    await instance.evaluate(({ clipboard, nativeImage }, saved) => {
      // Never overwrite clipboard content the user changed during the test.
      if (clipboard.readText() !== saved.owned) return
      if (!saved.previous.formats.length) { clipboard.clear(); return }
      const data: { text?: string; html?: string; rtf?: string; image?: ReturnType<typeof nativeImage.createFromBuffer>; bookmark?: string } = {}
      if (saved.previous.text || saved.previous.formats.some(format => /text|unicode/i.test(format))) data.text = saved.previous.text
      if (saved.previous.html) data.html = saved.previous.html
      if (saved.previous.rtf) data.rtf = saved.previous.rtf
      if (saved.previous.image) data.image = nativeImage.createFromBuffer(Buffer.from(saved.previous.image, 'base64'))
      if (saved.previous.bookmark.title) data.bookmark = saved.previous.bookmark.title
      clipboard.write(data)
    }, { previous, owned: text })
  }
}

test.describe.serial('终端粘贴实际执行 Workspace Shell', () => {
  test.beforeAll(async () => {
    expect(existsSync(shellPath), 'Build the sibling engine before this acceptance test: npm run build').toBe(true)
    try { ptyModule = requireEngine('node-pty') as typeof import('node-pty') } catch (error) {
      test.skip(true, `ENV-CAPABILITY-SKIP: engine Node PTY native module unavailable: ${String(error)}`)
      return
    }
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'terminal-shell-input-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace)
    mkdirSync(profile)
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
      const reply = (data: unknown, status = 200, message = 'ok'): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: status, message, data }))
      }
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        if (pathname === '/health') return reply({ status: 'ok' })
        if (pathname === '/meta') return reply({ version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'terminal-real-shell-fixture' })
        if (pathname === '/auth/account/providers') return reply({ providers: [], registrationEnabled: true })
        if (pathname === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId, finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
        if (pathname === '/api/v1/chat/runs') return reply({ runs: [] })
        if (pathname === '/api/v1/workspace/directory') return reply({ root: '/terminal/workspace', entries: [] })
        if (pathname === '/api/v1/terminal/create' && request.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sessionId?: string; cols: number; rows: number }
          // The client may restore a connection-scoped conversation from local
          // storage instead of settings.lastSessionId. Accept that legitimate
          // identity, but always bind its PTY to this test's isolated workspace.
          if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) return reply(null, 400, 'Missing terminal session')
          let pty: IPty
          try {
            // Use the engine's Node ABI dependency, not the client package rebuilt
            // for Electron. DLL ConPTY avoids the system helper's teardown race.
            pty = ptyModule.spawn(process.execPath, [shellPath], {
              name: 'xterm-256color', cols: body.cols, rows: body.rows,
              cwd: workspace, useConptyDll: true,
              env: { ...process.env, WORKSPACE_ROOT: workspace, WORKSPACE_ROOTS: JSON.stringify([workspace]) }
            })
          } catch (error) {
            nativeFailure = String(error)
            return reply(null, 503, `Native PTY unavailable: ${nativeFailure}`)
          }
          const id = `real-shell-${sessions.size + 1}`
          const session: ShellSession = { pty, backlog: '', output: '', ready: false, stopping: false, exited: false }
          sessions.set(id, session)
          pty.onData(data => {
            session.output += data
            if (session.ready && session.client?.readyState === WebSocket.OPEN) session.client.send(JSON.stringify({ type: 'output', data }))
            else session.backlog += data
          })
          pty.onExit(({ exitCode }) => {
            session.exited = true
            if (session.client?.readyState === WebSocket.OPEN) session.client.send(JSON.stringify({ type: 'exit', code: exitCode }))
          })
          return reply({ terminalId: id })
        }
        if (pathname.startsWith('/api/v1/terminal/') && request.method === 'DELETE') {
          const session = sessions.get(decodeURIComponent(pathname.split('/').at(-1)!))
          if (session) killShell(session)
          return reply({ success: true })
        }
        return reply([])
      } catch (error) {
        errors.push(`HTTP fixture failed: ${String(error)}`)
        return reply(null, 500, String(error))
      }
    })
    sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets!.handleUpgrade(request, socket, head, client => sockets!.emit('connection', client, request))
    })
    sockets.on('connection', (client, request) => {
      const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
      if (!pathname.startsWith('/api/v1/terminal/ws/')) return
      const session = sessions.get(decodeURIComponent(pathname.split('/').at(-1)!))
      if (!session) { client.close(1008, 'Unknown terminal'); return }
      session.client = client
      client.on('close', () => killShell(session))
      client.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number }
          if (session.exited || session.stopping) return
          if (message.type === 'input' && typeof message.data === 'string') {
            releaseOutput(session)
            inputs.push(message.data)
            session.pty.write(message.data)
          } else if (message.type === 'resize' && message.cols && message.rows) {
            session.pty.resize(message.cols, message.rows)
            // Renderer listener registration precedes its initial resize. Buffer
            // startup output until then rather than racing IPC session creation.
            releaseOutput(session)
          } else if (message.type === 'kill') killShell(session)
        } catch (error) { errors.push(`Terminal protocol failed: ${String(error)}`) }
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolveListen)
    })
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: sessionId, lastFolder: '' }))
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: environment })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
    const snapshot = await page.evaluate(() => window.aether.engine.start())
    expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    await page.keyboard.press('Control+\x60')
    // Observe the real UI's success or failure state so an HTTP/protocol failure
    // reports its reason immediately rather than timing out on the session map.
    await expect(page.locator('.terminal-view .xterm-screen, .terminal-view [role="alert"]').first()).toBeVisible()
    test.skip(Boolean(nativeFailure), `ENV-CAPABILITY-SKIP: native PTY launch unavailable: ${nativeFailure}`)
    const startupError = page.locator('.terminal-view [role="alert"]')
    if (await startupError.isVisible()) throw new Error(`Real shell terminal startup failed: ${await startupError.innerText()}`)
    expect(sessions.size).toBe(1)
    await expect(page.locator('.terminal-view .xterm-screen')).toBeVisible()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    await expect(page.locator('.terminal-view .xterm-rows')).toContainText('Workspace Shell')
    await expect(page.locator('.terminal-view .xterm-rows')).toContainText('~ $')
  })

  test.afterEach(() => {
    expect(errors).toEqual([])
    expect(inputs.join('')).not.toContain('\x16')
  })

  test.afterAll(async () => {
    try {
      await app?.close()
    } finally {
      for (const session of sessions.values()) killShell(session)
      for (const client of sockets?.clients ?? []) client.terminate()
      sockets?.close()
      server?.closeAllConnections()
      if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()))
      if (sessions.size) await expect.poll(() => [...sessions.values()].every(session => session.exited), { timeout: 10_000 }).toBe(true)
      if (fixture) {
        const absolute = resolve(fixture)
        if (dirname(absolute) !== resolve(fixtureRoot) || !basename(absolute).startsWith('terminal-shell-input-')) throw new Error('Unsafe real shell fixture cleanup')
        rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  })

  test('Ctrl+V 粘贴先出现在命令行，按 Enter 后才真正创建文件', async () => {
    const command = 'touch paste-proof.txt'
    const target = join(workspace, 'paste-proof.txt')
    expect(existsSync(target)).toBe(false)
    const before = inputs.length
    await withClipboard(command, async () => {
      await page.locator('.terminal-view .xterm-screen').click({ position: { x: 8, y: 8 } })
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
      await expect(page.locator('.terminal-view .xterm-rows')).toContainText(command)
      expect(commandInputs(before), JSON.stringify(inputs.slice(before))).toEqual([command])
      expect(existsSync(target), 'Pasting without Enter must not execute the command').toBe(false)
      await page.keyboard.press('Enter')
      await expect.poll(() => existsSync(target)).toBe(true)
      expect(commandInputs(before), JSON.stringify(inputs.slice(before))).toEqual([command, '\r'])
    })
  })

  test('无选区右键粘贴中文文件名，回车后由真实 Shell 落盘', async ({}, testInfo) => {
    const command = 'touch 中文粘贴验证.txt'
    const target = join(workspace, '中文粘贴验证.txt')
    expect(existsSync(target)).toBe(false)
    const before = inputs.length
    await withClipboard(command, async () => {
      await page.locator('.terminal-view .xterm-screen').click({ button: 'right', position: { x: 8, y: 8 } })
      const paste = page.getByRole('menuitem', { name: /^粘贴(?:\s|$)/ })
      await expect(paste).toBeEnabled()
      await paste.click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(page.locator('.terminal-view .xterm-rows')).toContainText(command)
      expect(commandInputs(before), JSON.stringify(inputs.slice(before))).toEqual([command])
      expect(existsSync(target)).toBe(false)
      await page.keyboard.press('Enter')
      await expect.poll(() => existsSync(target)).toBe(true)
      expect(commandInputs(before), JSON.stringify(inputs.slice(before))).toEqual([command, '\r'])
      await expect.poll(async () => (await page.locator('.terminal-view .xterm-rows').innerText()).trimEnd()).toMatch(/~ \$$/)
      const screenshot = testInfo.outputPath('paste-success.png')
      await page.locator('.terminal-view').screenshot({ path: screenshot })
      await testInfo.attach('Workspace Shell paste created files', { path: screenshot, contentType: 'image/png' })
    })
  })
})


