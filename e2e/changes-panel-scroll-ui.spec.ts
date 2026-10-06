/**
 * Real Electron layout contract for the remote ChangesPanel.
 *
 * The fixture serves a pending ledger over the same HTTP API used by the
 * remote engine.  This keeps the test on the production preload/renderer
 * path: no DOM is injected and no local engine state is seeded.
 *
 * The list must take at most min(320px, 36vh), scroll internally, and leave
 * the tray controls and composer at the same geometry.  A short list should
 * still collapse to its content height instead of reserving the maximum.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import type { EngineFileChange } from '../src/shared/ipc'

declare global {
  interface Window { aether: AetherIdeApi }
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'changes-panel-scroll-fixture-token'
const workspaceRoot = '/remote/changes-scroll-project'
const sessionId = 'changes-panel-scroll-session'

let fixture = ''
let server: Server | undefined
let app: ElectronApplication | undefined
let page: Page
let changeCount = 24

function envelope(data: unknown): string {
  return JSON.stringify({ code: 200, message: 'ok', data })
}

function pendingChanges(): EngineFileChange[] {
  return Array.from({ length: changeCount }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return {
      id: `changes-scroll-${n}`,
      path: `${workspaceRoot}/src/generated/file-${n}.ts`,
      displayPath: `src/generated/file-${n}.ts`,
      kind: 'write',
      oldContent: null,
      newContent: `export const generated${n} = ${index + 1}\n`,
      truncated: false,
      status: 'pending',
      createdAt: Date.now(),
      isNew: true
    }
  })
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${fixture}`],
    cwd: root,
    env: {
      ...process.env,
      AETHER_IDE_REMOTE_INSTANCE_TOKEN: token,
      AETHER_GLOBAL_DIR: join(fixture, 'global'),
      WORKSPACE_ROOT: join(fixture, 'workspace'),
      MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
      SKILLS_ROOT: join(fixture, 'skills'),
      ENABLE_LONG_TERM_MEMORY: 'false'
    }
  })
  page = await app.firstWindow()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
}

function cleanupFixture(): void {
  if (!fixture) return
  const absolute = resolve(fixture)
  if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('changes-panel-scroll-ui-')) {
    throw new Error('Refusing ChangesPanel fixture cleanup outside test root')
  }
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function openChangesTray(count: number): Promise<void> {
  const tab = page.getByRole('button', { name: `改动 ${count}`, exact: true })
  await expect(tab).toBeVisible()
  // The tray starts collapsed.  Clicking its tab is idempotent for this
  // fixture because each test reloads the page before selecting the tab.
  if (!(await page.locator('.changes-panel__list').isVisible())) await tab.click()
  await expect(page.locator('.changes-panel__list')).toBeVisible()
  await expect(page.locator('.changes-panel__item')).toHaveCount(count)
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }

async function geometry(): Promise<Record<'footer' | 'tab' | 'input', Rect>> {
  return page.evaluate(() => {
    const read = (selector: string): Rect => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) throw new Error(`Missing geometry probe: ${selector}`)
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    return {
      footer: read('.changes-panel__footer'),
      tab: read('.session-tray__bar'),
      input: read('.chat__input')
    }
  })
}

function expectGeometryStable(before: Record<'footer' | 'tab' | 'input', Rect>, after: Record<'footer' | 'tab' | 'input', Rect>): void {
  for (const key of ['footer', 'tab', 'input'] as const) {
    for (const field of ['left', 'top', 'right', 'bottom', 'width', 'height'] as const) {
      expect(Math.abs(after[key][field] - before[key][field]), `${key}.${field} moved while the list scrolled`).toBeLessThanOrEqual(1)
    }
  }
}

test.describe.serial('改动面板最大高度与内部滚动', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'changes-panel-scroll-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })

    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const suppliedToken = request.headers['x-aether-instance-token']
      if (path.startsWith('/api/') && suppliedToken !== token) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(envelope({ code: 40100, message: 'Invalid or missing instance token' }))
        return
      }
      response.setHeader('content-type', 'application/json')
      if (path === '/health') {
        response.end(envelope({ status: 'ok' }))
        return
      }
      if (path === '/meta') {
        response.end(envelope({
          version: '1.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1,
          toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'changes-panel-scroll-fixture'
        }))
        return
      }
      if (path === '/api/v1/tools' || path === '/api/v1/models' || path === '/api/v1/system-tools' ||
          path === '/api/v1/external-skills' || path === '/api/v1/todos' || path === '/api/v1/mcp/servers') {
        response.end(envelope([]))
        return
      }
      if (path === '/api/v1/conversation/sessions') {
        response.end(envelope([]))
        return
      }
      if (path === '/api/v1/chat/runs') {
        response.end(envelope({ runs: [] }))
        return
      }
      if (path === '/api/v1/chat/snapshot' || path === '/api/v1/conversation/history') {
        response.end(envelope(path.endsWith('snapshot') ? {
          schemaVersion: 1, source: 'persisted', sessionId, eventId: null,
          finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: []
        } : []))
        return
      }
      if (path === '/api/v1/changes') {
        response.end(envelope(pendingChanges()))
        return
      }
      if (path === '/api/v1/workspace/directory') {
        // Remote workspace bootstrap is independent of the changes ledger.
        // Returning an absolute root keeps the real workspace client from
        // retrying a missing directory contract while this test measures UI.
        response.end(envelope({ root: workspaceRoot, entries: [] }))
        return
      }
      // The app may probe additional read-only capabilities during bootstrap;
      // valid empty envelopes keep those probes out of the layout assertion.
      response.end(envelope([]))
    })
    await new Promise<void>((resolveListen, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address() as AddressInfo
    const remoteUrl = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'remote', remoteBaseUrl: remoteUrl, remoteWorkspaceRoot: '',
      autoStartEngine: true, lastFolder: '', lastSessionId: sessionId
    }))
    await launch()
  })

  test.afterAll(async () => {
    await app?.close()
    app = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolveClose => server!.close(() => resolveClose()))
      server = undefined
    }
    cleanupFixture()
  })

  test('默认窗口和最小窗口中，长列表只在列表内部滚动', async ({}, testInfo) => {
    await openChangesTray(changeCount)
    const list = page.locator('.changes-panel__list')
    const defaultWindow = await app!.evaluate(({ BrowserWindow }) => {
      const size = BrowserWindow.getAllWindows()[0]?.getSize() ?? [0, 0]
      return { width: size[0], height: size[1] }
    })
    expect(defaultWindow.width, '默认窗口宽度低于产品最小值').toBeGreaterThanOrEqual(940)
    expect(defaultWindow.height, '默认窗口高度低于产品最小值').toBeGreaterThanOrEqual(640)

    const probe = async (): Promise<{ list: Rect; scrollHeight: number; clientHeight: number; maxHeight: number; viewportHeight: number }> =>
      page.evaluate(() => {
        const element = document.querySelector('.changes-panel__list')
        if (!(element instanceof HTMLElement)) throw new Error('Missing changes list')
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          list: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          maxHeight: Number.parseFloat(style.maxHeight),
          viewportHeight: window.innerHeight
        }
      })

    const checkScrollable = async (label: string): Promise<void> => {
      const initial = await probe()
      const limit = Math.min(320, initial.viewportHeight * 0.36)
      expect(initial.clientHeight, `${label}:列表超过最大高度`).toBeLessThanOrEqual(limit + 1)
      expect(initial.scrollHeight, `${label}:夹具行数没有形成可滚动内容`).toBeGreaterThan(initial.clientHeight + 20)
      expect(initial.maxHeight, `${label}:CSS 最大高度没有按 viewport 生效`).toBeLessThanOrEqual(limit + 1)

      await list.evaluate(element => { element.scrollTop = 0 })
      const before = await geometry()
      const box = await list.boundingBox()
      if (!box) throw new Error(`${label}:列表没有可用几何区域`)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 1200)
      await expect.poll(
        () => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop),
        { timeout: 5_000 }
      ).toBeLessThanOrEqual(1)
      const after = await geometry()
      expectGeometryStable(before, after)

      const screenshot = testInfo.outputPath(`${label === '默认窗口' ? 'default' : 'minimum'}-changes-scroll.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(`${label}改动列表`, { path: screenshot, contentType: 'image/png' })
    }

    await checkScrollable('默认窗口')

    await app!.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setSize(size.width, size.height)
    }, { width: 940, height: 640 })
    await page.waitForTimeout(300)
    const minimumWindow = await app!.evaluate(({ BrowserWindow }) => {
      const size = BrowserWindow.getAllWindows()[0]?.getSize() ?? [0, 0]
      return { width: size[0], height: size[1] }
    })
    expect(minimumWindow.width, '窗口未保持产品最小宽度').toBeGreaterThanOrEqual(940)
    expect(minimumWindow.height, '窗口未保持产品最小高度').toBeGreaterThanOrEqual(640)
    await checkScrollable('最小窗口')
  })

  test('少量改动按内容收缩，不保留最大高度空白', async () => {
    changeCount = 2
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await openChangesTray(changeCount)
    const metrics = await page.locator('.changes-panel__list').evaluate(element => {
      const list = element as HTMLElement
      return { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, maxHeight: Number.parseFloat(getComputedStyle(list).maxHeight) }
    })
    expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.maxHeight + 1)
    expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.scrollHeight + 1)
    // A short list should not reserve the 320px/36vh cap; the row content is
    // the height source (allowing one pixel for device-pixel rounding).
    expect(metrics.clientHeight).toBeLessThan(200)
    expect(metrics.scrollHeight - metrics.clientHeight).toBeLessThanOrEqual(1)
  })
})

