/** Local synthetic native shutdown diagnosis: inspector quit, titlebar IPC,
 * and a directly spawned host with Chromium CDP but no Node inspector.
 * Each route must survive an identical-profile restart and final OS exit. */
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import { monitorElectronHealth, nativeEventFailed, redactNativeLog } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const engineRoot = process.env.AETHER_TEST_ENGINE_ROOT || resolve(root, '..', 'ai-agent-engine')
const entry = process.env.AETHER_E2E_APP_ENTRY || '.'
const executable = require('electron') as string
declare global { interface Window { aether: AetherIdeApi } }

test.describe.serial('原生退出入口对照', () => {
  for (const route of ['inspector-app-quit', 'inspector-window-close', 'plain-window-close'] as const) {
    test(route + '：相同隔离环境重启与真实OS退出', async ({}, testInfo) => {
      test.setTimeout(90000)
      mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
      const fixture = mkdtempSync(join(root, '.e2e-tmp', 'native-close-'))
      const requests: string[] = []
      const server = createServer((req, res) => {
        requests.push(req.url ?? '')
        const manifest = JSON.parse(readFileSync(join(engineRoot, 'dist/runtime/build-manifest.json'), 'utf8'))
        const data = req.url === '/health' ? { status: 'ok' }
          : req.url === '/meta' ? { ...manifest, instanceId: 'native-close-remote' }
          : req.url?.startsWith('/api/v1/chat/runs') ? { runs: [] } : []
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 200, data }))
      })
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
      const port = (server.address() as AddressInfo).port
      writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
        engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${port}`, autoStartEngine: true,
        lastFolder: fixture, thinkingMode: 'off'
      }))
      const env: NodeJS.ProcessEnv = { ...process.env,
        AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false',
        AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false'
      }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      delete env.AETHER_IDE_REMOTE_INSTANCE_TOKEN
      let passed = false
      let liveApp: ElectronApplication | undefined
      let liveChild: ChildProcess | undefined
      let liveChildClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
      const receipts: Array<Record<string, unknown>> = []
      try {
        for (let round = 0; round < 2; round++) {
          let page: Page
          if (route !== 'plain-window-close') {
            const app = liveApp = await electron.launch({ args: [entry, `--user-data-dir=${fixture}`], cwd: root, env })
            const health = await monitorElectronHealth(app, `native-${route}-${round}`)
            page = await app.firstWindow()
            const pageErrors: string[] = []
            page.on('pageerror', error => pageErrors.push(error.message))
            await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30000 })
            const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
            expect(snapshot.instanceId).toBe('native-close-remote')
            expect(pageErrors).toEqual([])
            if (route === 'inspector-app-quit') await health.closeAndAssert(testInfo)
            else await health.closeAndAssert(testInfo, () => page.evaluate(() => {
              // The IPC is the same titlebar action used by the product. Return
              // from evaluate before it destroys its own renderer context.
              window.setTimeout(() => { void window.aether.window.close() }, 0)
            }))
            liveApp = undefined
            receipts.push({ round, route, instanceId: snapshot.instanceId, osExitVerified: true })
          } else {
            let stderr = ''
            const child = liveChild = spawn(executable, [entry, `--user-data-dir=${fixture}`, '--remote-debugging-port=0'],
              { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
            const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
              child.once('exit', (code, signal) => done({ code, signal }))
            })
            const closed = liveChildClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
              child.once('close', (code, signal) => done({ code, signal }))
            })
            let readyTimer: ReturnType<typeof setTimeout> | undefined
            const endpoint = await new Promise<string>((done, reject) => {
              readyTimer = setTimeout(() => reject(new Error('Direct host did not publish Chromium CDP readiness')), 30000)
              child.once('error', reject)
              child.once('exit', code => reject(new Error('Direct host exited before readiness: ' + code)))
              child.stderr?.on('data', chunk => {
                stderr = (stderr + redactNativeLog(String(chunk))).slice(-32768)
                const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
                if (match) done(match[1])
              })
            }).finally(() => clearTimeout(readyTimer))
            const browser = await chromium.connectOverCDP(endpoint)
            try {
              const context = browser.contexts()[0]
              expect(context).toBeDefined()
              page = context.pages()[0] ?? await context.waitForEvent('page')
              const pageErrors: string[] = []
              page.on('pageerror', error => pageErrors.push(error.message))
              await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30000 })
              const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
              expect(snapshot.instanceId).toBe('native-close-remote')
              expect(pageErrors).toEqual([])
              await page.evaluate(() => { window.setTimeout(() => { void window.aether.window.close() }, 0) })
              let exitTimer: ReturnType<typeof setTimeout> | undefined
              const [exit, close] = await Promise.race([Promise.all([exited, closed]), new Promise<never>((_done, reject) => {
                exitTimer = setTimeout(() => reject(new Error('Direct host did not exit after titlebar IPC')), 30000)
              })]).finally(() => clearTimeout(exitTimer))
              receipts.push({ round, route, hostPid: child.pid, exit, close, stderrTail: stderr })
              expect(exit).toEqual({ code: 0, signal: null })
              expect(close).toEqual({ code: 0, signal: null })
              expect(stderr).not.toMatch(/Debugger listening on|Waiting for the debugger to disconnect/)
              liveChild = undefined
              liveChildClosed = undefined
            } finally { await browser.close() }
          }
          const journal = readFileSync(join(fixture, 'logs/native-processes.jsonl'), 'utf8')
            .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
          const startup = journal.filter(row => row.event === 'startup').at(-1)
          expect(startup).toBeDefined()
          const hostEvents = journal.filter(row => row.pid === startup!.pid)
          expect(hostEvents.some(row => row.event === 'will-quit')).toBe(true)
          expect(hostEvents.some(row => row.event === 'process-exit' && row.exitCode === 0)).toBe(true)
          expect(hostEvents.filter(row => nativeEventFailed({
            kind: String(row.event),
            reason: typeof row.reason === 'string' ? row.reason : undefined,
            exitCode: typeof row.exitCode === 'number' ? row.exitCode : undefined
          }))).toEqual([])
          const reports = join(fixture, 'Crashpad/reports')
          expect(existsSync(reports) ? readdirSync(reports).filter(name => name.endsWith('.dmp')) : []).toEqual([])
        }
        expect(requests).toContain('/api/v1/tools')
        passed = true
      } finally {
        // Retain failed profiles; the owned fixture server must close even if
        // an Electron assertion throws. No user instance is addressed here.
        let cleanupError: unknown
        try {
          if (liveApp) await liveApp.close()
          if (liveChild) {
            if (liveChild.exitCode === null) liveChild.kill()
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([liveChildClosed, new Promise<never>((_done, reject) => {
              cleanupTimer = setTimeout(() => reject(new Error('Owned direct host has not closed after failed matrix cleanup')), 10000)
            })]).finally(() => clearTimeout(cleanupTimer))
          }
        } catch (error) {
          passed = false
          cleanupError = error
          receipts.push({ cleanupFailure: String(error) })
        }
        server.closeAllConnections()
        await new Promise<void>(done => server.close(() => done()))
        await testInfo.attach('native-close-matrix', { body: JSON.stringify({ route, fixture, passed, receipts }), contentType: 'application/json' })
        if (dirname(fixture) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('native-close-')) throw new Error('Unsafe native fixture cleanup')
        if (passed) rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        if (cleanupError) throw cleanupError
      }
    })
  }
})
