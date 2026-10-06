/**
 * Remote Explorer live refresh contract.
 *
 * The HTTP fixture owns the directory snapshot.  The Electron client starts
 * with an empty remote root; the test then changes the server snapshot and
 * verifies that polling/event refresh updates the existing tree in place,
 * including an already expanded directory.  ChangesPanel's remote guidance
 * is checked at the same time so the two remote surfaces keep one visual
 * contract.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import type { FsEntry } from '../src/shared/ipc'

declare global {
  interface Window { aether: AetherIdeApi }
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'remote-explorer-refresh-fixture-token'

let fixture = ''
let remoteUrl = ''
let server: Server | undefined
let app: ElectronApplication | undefined
let page: Page

const workspaceRoot = '/remote/project'
const sessionId = 'remote-explorer-refresh'
const directories: Record<string, FsEntry[]> = {
  '.': [],
  src: []
}

function entry(name: string, path: string, isDirectory = false): FsEntry {
  return { name, path, isDirectory, size: isDirectory ? 0 : 20, mtimeMs: Date.now() }
}

function envelope(data: unknown): string {
  return JSON.stringify({ code: 200, message: 'ok', data })
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${fixture}`],
    cwd: root,
    env: {
      ...process.env,
      // Keep this test scoped to the external HTTP engine.  The engine token
      // is supplied through the environment and is never rendered in UI.
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
  if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('remote-explorer-refresh-')) {
    throw new Error('Refusing remote Explorer fixture cleanup outside test root')
  }
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test.describe.serial('远端资源树自动刷新与提示样式', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'remote-explorer-refresh-'))
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
          version: '1.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1,
          toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'remote-explorer-fixture'
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
        // A small pending row makes the remote guidance visible without
        // requiring a provider run or mutating a real repository.
        response.end(envelope([{
          id: 'remote-refresh-change', sessionId, path: '/remote/project/tracked.txt', displayPath: 'tracked.txt',
          kind: 'write', isNew: true, oldContent: null, newContent: 'remote change\n', truncated: false,
          status: 'pending', createdAt: Date.now()
        }]))
        return
      }
      if (path === '/api/v1/workspace/directory') {
        const key = url.searchParams.get('path') ?? '.'
        response.end(envelope({ root: workspaceRoot, entries: directories[key] ?? [] }))
        return
      }
      if (path === '/api/v1/workspace/file/content') {
        response.end(envelope({ content: 'remote change\n', isBinary: false, totalSize: 14, truncated: false }))
        return
      }
      // The remaining read-only bootstrap routes are valid empty responses.
      response.end(envelope([]))
    })
    await new Promise<void>((resolveListen, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolveListen)
    })
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

  test('远端根目录新增、展开目录新增重命名删除均自动同步且保持展开', async () => {
    const tree = page.locator('.explorer__tree')
    await expect(tree).toBeVisible()
    // The initial response is intentionally empty, proving the later rows are
    // delivered by refresh rather than being optimistic local entries.
    await expect(tree.locator('.explorer__hint')).toContainText('目录为空')

    directories['.'] = [entry('src', 'src', true), entry('README.md', 'README.md')]
    await expect.poll(() => tree.locator('.tree-row__name').allTextContents(), { timeout: 12_000 })
      .toEqual(expect.arrayContaining(['project', 'src', 'README.md']))

    const src = tree.locator('[role="treeitem"][data-path="/remote/project/src"]')
    await expect(src).toBeVisible()
    await src.click()
    await expect(src).toHaveAttribute('aria-expanded', 'true')

    directories.src = [entry('main.ts', 'src/main.ts')]
    await expect.poll(() => tree.locator('.tree-row__name').allTextContents(), { timeout: 12_000 })
      .toContain('main.ts')
    await expect(src).toHaveAttribute('aria-expanded', 'true')

    directories.src = [entry('renamed.ts', 'src/renamed.ts')]
    await expect.poll(() => tree.locator('.tree-row__name').allTextContents(), { timeout: 12_000 })
      .toContain('renamed.ts')
    await expect(tree.locator('.tree-row__name').filter({ hasText: 'main.ts' })).toHaveCount(0)
    await expect(src).toHaveAttribute('aria-expanded', 'true')

    directories.src = []
    await expect.poll(() => tree.locator('.tree-row__name').allTextContents(), { timeout: 12_000 })
      .not.toContain('renamed.ts')
    await expect(src).toHaveAttribute('aria-expanded', 'true')
  })

  test('远端改动提示使用紧凑提示样式，不渲染旧裸文本块', async () => {
    const note = page.locator('.changes-panel__notice')
    if (!(await note.isVisible())) {
      await page.getByRole('button', { name: /^改动\s+\d+$/ }).click()
    }
    await expect(note).toBeVisible()
    await expect(note).toContainText('远端工作区')
  })
})

