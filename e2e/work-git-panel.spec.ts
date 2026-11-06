/** Real Electron + engine + disposable repositories: full Work Git UI, disk
 * mutations, Monaco diff, history graph/virtualization, branch/tag/stash,
 * automatic file synchronization, read concurrency, hidden-pane suspension,
 * per-task isolation, workspace file reveal/resource tabs, and advanced
 * session-HTTP merge/rebase/cherry-pick/revert. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo
} from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm as removeFixture } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { createFileTreeScope, FILE_TREE_MEMORY_KEY, fileTreePathKey, type FileTreeMemory } from '../src/renderer/src/core/workspace/file-tree-memory'
import { monitorElectronHealth } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const engineRoot = resolve(root, '../ai-agent-engine')
const token = `git-panel-${randomUUID()}`
const sessionA = `work-git-panel-a-${randomUUID()}`
const sessionB = `work-git-panel-b-${randomUUID()}`
const sessionClone = `work-git-panel-clone-${randomUUID()}`
const sessionGraph = `work-git-panel-graph-${randomUUID()}`
const sessionAdvanced = `work-git-panel-advanced-${randomUUID()}`
const sessionReveal = `work-git-panel-reveal-${randomUUID()}`
const codeSession = `code-git-panel-${randomUUID()}`
let fixture = '',
  workspaceRoot = '',
  repoA = '',
  repoB = '',
  codeRepo = '',
  cloneRoot = '',
  graphRepo = '',
  advancedRepo = '',
  revealRepo = '',
  baseUrl = ''
let engine: ChildProcess | undefined
let engineClosed: Promise<void> | undefined
let app: ElectronApplication | undefined
let health: Awaited<ReturnType<typeof monitorElectronHealth>> | undefined
let page: Page
let electronTraceStarted = false
const errors: string[] = []
let codeFingerprint = '',
  otherFingerprint = ''
const advancedHeads: Record<string, string> = {}

interface AdvancedGitAction {
  op: string
  sessionId: string
  expectedRoot: string
  cwd: string
  bindingEpoch: string
  profile: string
  ref?: string
  hash?: string
}
type AdvancedGitProbeGlobal = typeof globalThis & { __workGitAdvancedProbe?: {
  snapshot: () => AdvancedGitAction[]
  restore: () => void
} }

/** Observe real HTTP writes without replacing the response or bypassing UI. */
async function installAdvancedGitProbe(): Promise<void> {
  await app!.evaluate(() => {
    const globals = globalThis as AdvancedGitProbeGlobal
    globals.__workGitAdvancedProbe?.restore()
    const original = globalThis.fetch
    const actions: AdvancedGitAction[] = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input))
      if (init?.method === 'POST' && url.pathname === '/api/v1/git/action' && typeof init.body === 'string') {
        const body = JSON.parse(init.body) as Record<string, unknown>
        actions.push({ op: String(body.op ?? ''), sessionId: String(body.sessionId ?? ''),
          expectedRoot: String(body.expectedRoot ?? ''), cwd: String(body.cwd ?? ''),
          bindingEpoch: String(body.bindingEpoch ?? ''), profile: new Headers(init.headers).get('x-aether-tool-profile') ?? '',
          ...(typeof body.ref === 'string' ? { ref: body.ref } : {}),
          ...(typeof body.hash === 'string' ? { hash: body.hash } : {}) })
      }
      return original(input, init)
    }
    globals.__workGitAdvancedProbe = {
      snapshot: () => actions.map(action => ({ ...action })),
      restore: () => { globalThis.fetch = original; delete globals.__workGitAdvancedProbe }
    }
  })
}
async function expectAdvancedRouting(expected: Array<Partial<AdvancedGitAction>>, info: TestInfo): Promise<void> {
  const actions = await app!.evaluate(() => (globalThis as AdvancedGitProbeGlobal).__workGitAdvancedProbe!.snapshot())
  const operations = new Set(expected.map(action => action.op))
  const relevant = actions.filter(action => operations.has(action.op))
  expect(relevant).toHaveLength(expected.length)
  for (let index = 0; index < expected.length; index++) expect(relevant[index]).toMatchObject(expected[index])
  for (const action of actions) {
    expect(action).toMatchObject({ sessionId: sessionAdvanced, cwd: '.', profile: 'general' })
    expect(action.bindingEpoch).not.toBe('')
    expect(action.expectedRoot.replace(/\\/g, '/').toLowerCase()).toBe(advancedRepo.replace(/\\/g, '/').toLowerCase())
  }
  await attachJson(info, 'work-git-advanced-http', actions)
}

async function attachJson(info: TestInfo, name: string, value: unknown): Promise<void> {
  // The list reporter does not persist successful body-only attachments.
  const path = info.outputPath(`${name}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await info.attach(name, { path, contentType: 'application/json' })
}

interface GitReadMetrics {
  reads: number
  statusStarted: number
  activeStatus: number
  maxActiveStatus: number
  held: boolean
  durationsMs: number[]
}
type GitProbeGlobal = typeof globalThis & { __workGitReadProbe?: {
  snapshot: () => GitReadMetrics
  holdNext: () => void
  release: () => void
  restore: () => void
} }

/** Observe the actual main-process HTTP transport; contextBridge objects are
 * immutable. The optional response gate is used only for the overlap check. */
async function installGitReadProbe(): Promise<void> {
  await app!.evaluate((_, targetSession) => {
    const globals = globalThis as GitProbeGlobal
    globals.__workGitReadProbe?.restore()
    const original = globalThis.fetch
    const metrics: GitReadMetrics = { reads: 0, statusStarted: 0, activeStatus: 0, maxActiveStatus: 0, held: false, durationsMs: [] }
    let holdNext = false
    let release: (() => void) | undefined
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input))
      const observed = (init?.method ?? 'GET') === 'GET' && url.pathname.startsWith('/api/v1/git/') && url.searchParams.get('sessionId') === targetSession
      if (!observed) return original(input, init)
      metrics.reads++
      const status = url.pathname === '/api/v1/git/status'
      const started = Date.now()
      if (status) { metrics.statusStarted++; metrics.activeStatus++; metrics.maxActiveStatus = Math.max(metrics.maxActiveStatus, metrics.activeStatus) }
      try {
        const response = await original(input, init)
        if (status && holdNext) {
          holdNext = false; metrics.held = true
          await new Promise<void>(resolve => { release = resolve })
          metrics.held = false; release = undefined
        }
        return response
      } finally {
        if (status) { metrics.activeStatus--; metrics.durationsMs.push(Date.now() - started) }
      }
    }
    globals.__workGitReadProbe = {
      snapshot: () => ({ ...metrics, durationsMs: [...metrics.durationsMs] }),
      holdNext: () => { holdNext = true },
      release: () => { holdNext = false; release?.() },
      restore: () => { holdNext = false; release?.(); globalThis.fetch = original; delete globals.__workGitReadProbe }
    }
  }, sessionA)
}
async function gitReadMetrics(): Promise<GitReadMetrics> {
  return app!.evaluate(() => (globalThis as GitProbeGlobal).__workGitReadProbe!.snapshot())
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}
function fingerprint(cwd: string): string {
  return JSON.stringify({
    head: git(cwd, 'rev-parse', 'HEAD'),
    index: git(cwd, 'ls-files', '--stage'),
    status: git(cwd, 'status', '--porcelain=v1'),
    content: readFileSync(join(cwd, 'tracked.txt'), 'utf8')
  })
}
function seedRepo(name: string, branch: string): string {
  const path = join(workspaceRoot, name)
  mkdirSync(path)
  git(path, 'init', '-b', branch)
  git(path, 'config', 'user.name', 'Work Git Fixture')
  git(path, 'config', 'user.email', 'work-git@example.invalid')
  git(path, 'config', 'commit.gpgSign', 'false')
  git(path, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(path, 'tracked.txt'), `${name} baseline\n`)
  git(path, 'add', '--', 'tracked.txt')
  git(path, 'commit', '-m', `${name} initial commit`)
  writeFileSync(join(path, 'tracked.txt'), `${name} pending change\n`)
  return path
}
function seedGraphRepo(): string {
  const path = seedRepo('graph', 'main')
  git(path, 'restore', '--', 'tracked.txt')
  // A long real ancestry exercises pagination and the windowed history list;
  // two diamonds expose hash mismatches that spuriously create a lane per row.
  for (let index = 1; index <= 105; index++) {
    git(path, 'commit', '--allow-empty', '-m', `graph trunk ${String(index).padStart(3, '0')}`)
  }
  for (const feature of ['alpha', 'beta']) {
    git(path, 'switch', '-c', `feature/${feature}`)
    for (let index = 1; index <= 2; index++) {
      writeFileSync(join(path, `${feature}.txt`), `${feature} feature ${index}\n`)
      git(path, 'add', '--', `${feature}.txt`)
      git(path, 'commit', '-m', `graph ${feature} feature ${index}`)
    }
    git(path, 'switch', 'main')
    git(path, 'commit', '--allow-empty', '-m', `graph main during ${feature}`)
    git(path, 'merge', '--no-ff', `feature/${feature}`, '-m', `graph merge ${feature}`)
  }
  for (let index = 1; index <= 3; index++) {
    if (index === 3) {
      for (const file of [
        'package.json',
        'docs/ui-tracking-inventory.md',
        'src/main/codemap/service.ts',
        'src/main/engine/runtime.ts',
        'src/preload/code.ts',
        'src/renderer/components/code/CodePane.tsx',
        'src/renderer/components/code/CodePane.test.tsx',
        'tests/main/codemap/service.test.ts'
      ]) {
        mkdirSync(dirname(join(path, file)), { recursive: true })
        writeFileSync(join(path, file), `graph tree content: ${file}\n`)
      }
      git(path, 'add', '--all')
    }
    git(path, 'commit', '--allow-empty', '-m', `graph after merge ${index}`)
  }
  return path
}
function seedAdvancedRepo(): string {
  const path = seedRepo('advanced', 'main')
  git(path, 'restore', '--', 'tracked.txt')
  const base = git(path, 'rev-parse', 'HEAD').trim()
  const branch = (name: string, file: string, content: string, subject: string): void => {
    git(path, 'switch', '-c', name, base)
    writeFileSync(join(path, file), content)
    git(path, 'add', '--', file)
    git(path, 'commit', '-m', subject)
    advancedHeads[name] = git(path, 'rev-parse', 'HEAD').trim()
  }
  // Each target starts from the same clean base; running a filtered advanced
  // test never depends on a preceding test's mutable task-a repository.
  branch('merge/source', 'tracked.txt', 'advanced source conflict\n', 'advanced conflicting source')
  branch('merge/clean', 'merged.txt', 'advanced clean merge\n', 'advanced clean merge source')
  branch('merge/target', 'tracked.txt', 'advanced target conflict\n', 'advanced merge target')
  branch('rebase/source', 'upstream.txt', 'advanced upstream\n', 'advanced upstream commit')
  branch('rebase/target', 'replayed.txt', 'advanced replayed change\n', 'advanced replayed commit')
  branch('pick/source', 'picked.txt', 'advanced picked payload\n', 'advanced pick payload')
  branch('pick/target', 'pick-target.txt', 'advanced pick target\n', 'advanced pick target')
  git(path, 'switch', 'merge/target')
  return path
}

function seedRevealRepo(): string {
  const path = seedRepo('tree-reveal', 'main')
  git(path, 'restore', '--', 'tracked.txt')
  for (const branch of ['alpha', 'omega']) {
    const directory = join(path, branch, 'nested')
    mkdirSync(directory, { recursive: true })
    // The changed file starts beyond a full tree viewport. Opening only its
    // preview, or selecting without scrolling, must not satisfy the regression.
    for (let index = 0; index < 80; index++) {
      writeFileSync(join(directory, `filler-${String(index).padStart(3, '0')}.txt`), `unchanged ${index}\n`)
    }
    writeFileSync(join(directory, `zz-${branch}.txt`), `tree reveal ${branch} baseline\n`)
  }
  git(path, 'add', '--all')
  git(path, 'commit', '-m', 'nested file reveal fixture')
  for (const branch of ['alpha', 'omega']) {
    writeFileSync(join(path, branch, 'nested', `zz-${branch}.txt`), `tree reveal ${branch} changed\n`)
  }
  return path
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}
async function stopEngine(): Promise<void> {
  if (!engine || !engineClosed) return
  const child = engine
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 5_000)
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await engineClosed
  } finally {
    clearTimeout(timer)
  }
}
const work = (): Locator => page.locator('.work-view')
const panel = (): Locator => work().locator('.git-panel')
const row = (name: string): Locator =>
  panel()
    .locator('.git-row, .git-tree__file')
    .filter({ has: page.locator('.git-row__name, .tree-row__name').filter({ hasText: name }) })
async function toggleStage(name: string, staged = false): Promise<void> {
  await row(name).hover()
  await row(name)
    .getByTitle(staged ? '取消暂存' : '暂存', { exact: true })
    .click()
}

async function showGit(expectRepository = true): Promise<void> {
  if (!(await work().getByRole('button', { name: '更多工作区', exact: true }).isVisible())) {
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  }
  const tab = work().getByRole('tab', { name: 'Git', exact: true })
  if (await tab.count()) await tab.click()
  else {
    const more = work().getByRole('button', { name: '更多工作区', exact: true })
    await more.press('ArrowDown')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('menuitem', { name: 'Git', exact: true }).click()
  }
  if (expectRepository) await expect(panel().locator('.git-commitbar__input')).toBeVisible()
  else await expect(panel()).toBeVisible()
  await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
}
async function refresh(): Promise<void> {
  const button = panel().getByTitle('刷新', { exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toBeEnabled()
}
async function menuAction(group: string, item: string): Promise<void> {
  const assertMenuInViewport = async (menu: Locator): Promise<void> => {
    await expect(menu).toBeVisible()
    await expect.poll(() => menu.evaluate(element => {
      const rect = element.getBoundingClientRect()
      // Entrance translation may cross the clamped margin by a few pixels.
      return rect.left >= -4 && rect.top >= -4
        && rect.right <= innerWidth + 4 && rect.bottom <= innerHeight + 4
    })).toBe(true)
  }
  await panel().getByTitle('更多操作', { exact: true }).click()
  await assertMenuInViewport(page.locator('.context-menu:not(.context-menu--submenu)'))
  await page.getByRole('menuitem', { name: `${group} ›`, exact: true }).hover()
  await assertMenuInViewport(page.locator('.context-menu--submenu'))
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}
async function setViewMode(mode: 'list' | 'tree'): Promise<void> {
  await panel().getByTitle('查看与排序', { exact: true }).click()
  await page.getByRole('menuitem', { name: mode === 'tree' ? /以树形式查看/ : /以列表形式查看/ }).click()
}
async function fillPrompt(value: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').fill(value)
  await dialog.locator('.btn--primary').click()
}
async function openTask(title: string, expectRepository = true): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: title }).click()
  await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
  await showGit(expectRepository)
}
async function switchAdvancedBranch(branch: string): Promise<void> {
  await openTask('Git 高级操作任务')
  if (git(advancedRepo, 'branch', '--show-current').trim() !== branch) {
    await panel().locator('.git-branchbar__trigger').click()
    await page.getByPlaceholder('筛选分支，或输入新分支名').fill(branch)
    await page.locator('.git-branchbar__option').filter({ has: page.getByText(branch, { exact: true }) }).click()
    await expect.poll(() => git(advancedRepo, 'branch', '--show-current').trim()).toBe(branch)
    await page.keyboard.press('Escape')
    await expect(page.getByPlaceholder('筛选分支，或输入新分支名')).toHaveCount(0)
  }
  await expect(panel().locator('.git-branchbar__name')).toHaveText(branch)
  await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
}
async function chooseAdvancedBranchOperation(label: string, branch: string): Promise<void> {
  await menuAction('分支', label)
  const dialog = page.getByRole('dialog', { name: label, exact: true })
  await dialog.locator('.git-pickdlg__item').filter({ has: page.getByText(branch, { exact: true }) }).click()
  await expect(dialog).toHaveCount(0)
}
async function advancedHistory(): Promise<Locator> {
  const history = panel().locator('.git-panel__history')
  if (!(await history.isVisible())) await panel().locator('.git-panel__group-head').filter({ hasText: '提交历史' }).click()
  await expect(history).toBeVisible()
  return history
}

interface DiffPaneGeometry {
  x: number; y: number; width: number; height: number
}
interface DiffLayoutGeometry {
  container: DiffPaneGeometry
  original: DiffPaneGeometry
  modified: DiffPaneGeometry
  originalEditor: DiffPaneGeometry
  modifiedEditor: DiffPaneGeometry
}

async function readDiffLayout(diff: Locator): Promise<DiffLayoutGeometry> {
  return diff.locator('.monaco-diff-editor').evaluate(element => {
    const rect = (target: Element): DiffPaneGeometry => {
      const { x, y, width, height } = target.getBoundingClientRect()
      return { x, y, width, height }
    }
    const original = element.querySelector(':scope > .editor.original')!
    const modified = element.querySelector(':scope > .editor.modified')!
    return { container: rect(element), original: rect(original), modified: rect(modified),
      originalEditor: rect(original.querySelector('.monaco-editor')!),
      modifiedEditor: rect(modified.querySelector('.monaco-editor')!) }
  })
}

async function expectNarrowDiffLayout(diff: Locator, sideBySide: boolean): Promise<DiffLayoutGeometry> {
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible()
  // Monaco's default <=900px fallback is the regression trigger. Check the
  // actual editor width, since resizing a window can switch Work to one pane.
  await expect.poll(async () => {
    const { container } = await readDiffLayout(diff)
    return container.width > 0 && container.width < 900 && container.height > 0
  }).toBe(true)
  await expect.poll(async () => {
    const geometry = await readDiffLayout(diff)
    const { container, original, modified, originalEditor, modifiedEditor } = geometry
    const offset = modified.x - container.x
    if (sideBySide) {
      return original.width > container.width * 0.25 && modified.width > container.width * 0.25
        && originalEditor.width > container.width * 0.25 && modifiedEditor.width > container.width * 0.25
        && offset > container.width * 0.25 && original.x < modified.x
        && original.x + original.width <= modified.x + 2
        && modified.x + modified.width <= container.x + container.width + 2
        && Math.abs(original.y - modified.y) < 2 && original.height > 0 && modified.height > 0
    }
    // Inline mode can retain a small original-line-number gutter; it must not
    // retain a second content pane. Allow device-pixel rounding at its edge.
    return original.width < container.width * 0.2 && originalEditor.width < container.width * 0.2
      && offset < container.width * 0.2 && modified.width > container.width * 0.75
      && modifiedEditor.width > container.width * 0.75
  }, { timeout: 15_000 }).toBe(true)
  return readDiffLayout(diff)
}

async function refreshDiffAndExpectLayout(diff: Locator, sideBySide: boolean): Promise<DiffLayoutGeometry> {
  const previous = await diff.locator('.monaco-diff-editor').elementHandle()
  if (!previous) throw new Error('The diff editor must exist before refreshing')
  try {
    await diff.getByRole('button', { name: '刷新差异', exact: true }).click()
    await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false)
    await expect(diff.getByRole('button', { name: sideBySide ? '行内比较' : '并排比较', exact: true }))
      .toHaveAttribute('aria-pressed', String(sideBySide))
    return await expectNarrowDiffLayout(diff, sideBySide)
  } finally { await previous.dispose() }
}

test.describe.serial('Work Git 完整面板', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-git-panel-'))
    workspaceRoot = join(fixture, 'repositories')
    mkdirSync(workspaceRoot)
    repoA = seedRepo('task-a', 'main')
    repoB = seedRepo('task-b', 'main-b')
    codeRepo = seedRepo('code', 'code-main')
    graphRepo = seedGraphRepo()
    advancedRepo = seedAdvancedRepo()
    revealRepo = seedRevealRepo()
    cloneRoot = join(workspaceRoot, 'clone-target')
    mkdirSync(cloneRoot)
    codeFingerprint = fingerprint(codeRepo)
    otherFingerprint = fingerprint(repoB)
    baseUrl = `http://127.0.0.1:${await freePort()}`
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (
        [
          'ELECTRON_RUN_AS_NODE',
          'ELECTRON_RENDERER_URL',
          'AETHER_IDE_REMOTE_AUTH_URL',
          'AETHER_IDE_REMOTE_API_KEY',
          'AETHER_IDE_REMOTE_BEARER_TOKEN'
        ].includes(key.toUpperCase())
      )
        delete environment[key]
    }
    const logs: string[] = []
    engine = spawn(process.execPath, [process.env.AETHER_E2E_ENGINE_ENTRY || join(engineRoot, 'dist', 'main.js')], {
      cwd: fixture,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...environment,
        AUTH_ENABLED: 'false',
        AETHER_INSTANCE_TOKEN: token,
        ENCRYPTION_KEY: 'c'.repeat(64),
        HOST: '127.0.0.1',
        PORT: new URL(baseUrl).port,
        DATA_DIR: join(fixture, 'engine.db'),
        MEMORY_DB_PATH: join(fixture, 'memory.db'),
        AETHER_GLOBAL_DIR: join(fixture, 'global'),
        WORKSPACE_ROOT: workspaceRoot,
        AETHER_ALLOWED_WORKSPACE_ROOTS: workspaceRoot,
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
        SKILLS_ROOT: join(fixture, 'skills'),
        ENABLE_LONG_TERM_MEMORY: 'false'
      }
    })
    engineClosed = new Promise<void>((done) => engine!.once('close', () => done()))
    const record = (chunk: Buffer): void => {
      logs.push(String(chunk))
      if (logs.length > 100) logs.shift()
    }
    engine.stdout?.on('data', record)
    engine.stderr?.on('data', record)
    await expect
      .poll(
        async () => {
          if (engine?.exitCode !== null)
            throw new Error('Git panel engine exited: ' + logs.join('').slice(-3000))
          return fetch(baseUrl + '/health')
            .then((response) => response.status)
            .catch(() => 0)
        },
        { timeout: 90_000 }
      )
      .toBe(200)

    const profile = join(fixture, 'desktop')
    mkdirSync(profile)
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({
        engineMode: 'remote',
        remoteBaseUrl: baseUrl,
        remoteWorkspaceRoot: codeRepo,
        autoStartEngine: true,
        lastSessionId: codeSession,
        appearance: 'dark'
      })
    )
    app = await electron.launch({
      args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`],
      cwd: root,
      env: {
        ...environment,
        AETHER_IDE_REMOTE_INSTANCE_TOKEN: token,
        AETHER_GLOBAL_DIR: join(fixture, 'desktop-global')
      }
    })
    health = await monitorElectronHealth(app, 'work-git-panel', [token])
    page = await app.firstWindow()
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    electronTraceStarted = true
    page.on('pageerror', (error) => {
      errors.push(error.stack || error.message)
      console.error('Work Git page error:', error.stack || error.message)
    })
    page.on('console', (message) => { if (message.type() === 'error') console.error('Git renderer:', message.text()) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
    for (const [sessionId, workspaceRoot] of [
      [sessionA, repoA],
      [sessionB, repoB],
      [codeSession, codeRepo],
      [sessionGraph, graphRepo],
      [sessionAdvanced, advancedRepo],
      [sessionReveal, revealRepo],
      [sessionClone, cloneRoot]
    ]) {
      const result = await page.evaluate(
        ({ sessionId, workspaceRoot }) =>
          window.aether.engine.request({
            method: 'POST',
            path: '/workspace/bind',
            body: { sessionId, workspaceRoot }
          }),
        { sessionId, workspaceRoot }
      )
      expect(result.ok, result.message).toBe(true)
    }
    const source = engineStorageKey({ mode: 'remote', baseUrl })
    const now = Date.now()
    await page.evaluate(
      ({ key, selectedKey, tasks, codeSession }) => {
        localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: tasks[0].id }))
        localStorage.setItem(selectedKey, codeSession)
        localStorage.setItem(
          'aether.work.view.v1',
          JSON.stringify({
            page: 'home',
            workspace: true,
            tab: 'files',
            pane: 'workspace',
            ratio: 40
          })
        )
      },
      {
        key: sessionStorageKey('aether.work.state.v1', source),
        selectedKey: sessionStorageKey('aether:lastSessionId', source),
        codeSession,
        tasks: [
          { id: sessionA, title: 'Git 任务 A', workspacePath: repoA },
          { id: sessionB, title: 'Git 任务 B', workspacePath: repoB },
          { id: sessionGraph, title: 'Git 分支图任务', workspacePath: graphRepo },
          { id: sessionAdvanced, title: 'Git 高级操作任务', workspacePath: advancedRepo },
          { id: sessionReveal, title: 'Git 文件定位任务', workspacePath: revealRepo },
          { id: sessionClone, title: 'Git 克隆任务', workspacePath: cloneRoot }
        ].map((task) => ({
          ...task,
          status: 'draft',
          draft: '',
          createdAt: now,
          updatedAt: now,
          modelId: '',
          attachments: [],
          sources: []
        }))
      }
    )
    await page.reload()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    // The settings landing page can keep the Code sidebar hidden after reload.
    const closeSettings = page.getByRole('button', { name: '关闭 设置', exact: true })
    if (await closeSettings.count()) await closeSettings.click()
    if (!(await page.locator('.git-panel:visible').count())) {
      await page.getByRole('button', { name: '版本控制', exact: true }).click()
    }
    await expect(page.locator('.git-panel:visible .git-branchbar__name')).toHaveText('code-main')
    await page
      .locator('.git-panel:visible')
      .getByRole('textbox', { name: '提交信息', exact: true })
      .fill('Code 独立草稿')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(work().getByRole('heading', { name: 'Git 任务 A', exact: true })).toBeVisible()
    try {
      await showGit()
    } catch (error) {
      await page.screenshot({ path: join(fixtureRoot, 'work-git-setup-failure.png') })
      console.error('Work Git setup UI:', await page.locator('body').innerText())
      console.error('Work Git renderer errors:', errors, 'URL:', page.url())
      throw error
    }
  })
  test.afterEach(() => {
    health?.assertHealthy()
    expect(errors).toEqual([])
    expect(fingerprint(codeRepo)).toBe(codeFingerprint)
    expect(fingerprint(repoB)).toBe(otherFingerprint)
  })
  test.afterAll(async ({}, info) => {
    try {
      try {
        if (electronTraceStarted) {
          const trace = info.outputPath('work-git-electron-trace.zip')
          await page.context().tracing.stop({ path: trace })
          await info.attach('work-git-electron-trace', { path: trace, contentType: 'application/zip' })
        }
      } finally {
        electronTraceStarted = false
        if (health) await health.closeAndAssert(info)
        else await app?.close()
      }
    } finally {
      await stopEngine()
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-git-panel-'))
          throw new Error(`Unsafe fixture cleanup: ${target}`)
        // Windows can release the exited engine's directory handles a little later.
        await removeFixture(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
      }
    }
  })

  test('完整分组与真实暂存、取消暂存、Monaco 差异使用任务仓库', async ({}, info) => {
    await expect(panel().locator('.git-branchbar__name')).toHaveText('main')
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    await expect(panel().locator('.git-row')).toHaveCount(0)
    await expect(
      panel().locator('.git-panel__group-head').filter({ hasText: '提交历史' })
    ).toBeVisible()
    await expect(panel().getByTitle('更多操作', { exact: true })).toBeVisible()
    await toggleStage('tracked.txt')
    await expect.poll(() => git(repoA, 'diff', '--cached', '--name-only')).toBe('tracked.txt\n')
    await toggleStage('tracked.txt', true)
    await expect.poll(() => git(repoA, 'diff', '--cached', '--name-only')).toBe('')
    await expect(row('tracked.txt').getByTitle('暂存', { exact: true })).toBeVisible()
    await row('tracked.txt').click()
    const diff = work().getByRole('region', { name: '任务文件差异', exact: true })
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible()
    await expect(diff).toContainText('task-a pending change')
    const initialInline = await expectNarrowDiffLayout(diff, false)
    await diff.getByRole('button', { name: '并排比较', exact: true }).click()
    await expect(diff.getByRole('button', { name: '行内比较', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const sideBySide = await expectNarrowDiffLayout(diff, true)
    await expect(diff.locator('.editor.original .view-lines')).toContainText('task-a baseline')
    await expect(diff.locator('.editor.modified .view-lines')).toContainText('task-a pending change')
    await diff.screenshot({ path: info.outputPath('work-git-narrow-side-by-side.png') })
    const refreshedSideBySide = await refreshDiffAndExpectLayout(diff, true)
    await diff.getByRole('button', { name: '行内比较', exact: true }).click()
    await expect(diff.getByRole('button', { name: '并排比较', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const inline = await expectNarrowDiffLayout(diff, false)
    const refreshedInline = await refreshDiffAndExpectLayout(diff, false)
    await diff.screenshot({ path: info.outputPath('work-git-narrow-inline.png') })
    await attachJson(info, 'work-git-diff-layout', { initialInline, sideBySide, refreshedSideBySide, inline, refreshedInline })
    await diff.getByRole('button', { name: '关闭差异', exact: true }).click()
    expect(readFileSync(join(repoA, 'tracked.txt'), 'utf8')).toBe('task-a pending change\n')
  })

  test('Work Git 自动检测新建、修改和删除，保留真实暂存版本且报告同步延迟', async ({}, info) => {
    const original = readFileSync(join(repoA, 'tracked.txt'), 'utf8')
    const originalIndex = git(repoA, 'ls-files', '--stage')
    const created = 'live-sync-created.txt'
    const metrics: Record<string, unknown> = {}
    await toggleStage('tracked.txt')
    await expect.poll(() => git(repoA, 'show', ':tracked.txt')).toBe(original)
    const stagedIndex = git(repoA, 'ls-files', '--stage')
    await installGitReadProbe()
    try {
      const createdAt = Date.now()
      writeFileSync(join(repoA, created), 'created outside the Work UI\n')
      writeFileSync(join(repoA, 'tracked.txt'), original + 'external worktree update\n')
      await expect(row(created)).toBeVisible()
      await expect(row('tracked.txt')).toHaveCount(2)
      metrics.createAndModifyLatencyMs = Date.now() - createdAt
      expect(readFileSync(join(repoA, created), 'utf8')).toBe('created outside the Work UI\n')
      expect(readFileSync(join(repoA, 'tracked.txt'), 'utf8')).toBe(original + 'external worktree update\n')
      expect(git(repoA, 'ls-files', '--stage')).toBe(stagedIndex)
      expect(git(repoA, 'show', ':tracked.txt')).toBe(original)

      const deletedAt = Date.now()
      rmSync(join(repoA, created))
      rmSync(join(repoA, 'tracked.txt'))
      await expect(row(created)).toHaveCount(0)
      await expect(row('tracked.txt').locator('.tree-row__name.is-deleted')).toBeVisible()
      metrics.deleteLatencyMs = Date.now() - deletedAt
      expect(existsSync(join(repoA, created))).toBe(false)
      expect(existsSync(join(repoA, 'tracked.txt'))).toBe(false)
      expect(git(repoA, 'ls-files', '--stage')).toBe(stagedIndex)
      expect(git(repoA, 'show', ':tracked.txt')).toBe(original)
      metrics.transport = await gitReadMetrics()
      metrics.mountedRows = await panel().locator('.git-row, .git-tree__file').count()
      expect((metrics.transport as GitReadMetrics).statusStarted).toBeGreaterThanOrEqual(2)
      expect((metrics.transport as GitReadMetrics).maxActiveStatus).toBe(1)
      await attachJson(info, 'work-git-auto-sync-metrics', metrics)
    } finally {
      await app!.evaluate(() => (globalThis as GitProbeGlobal).__workGitReadProbe?.restore())
      writeFileSync(join(repoA, 'tracked.txt'), original)
      rmSync(join(repoA, created), { force: true })
      git(repoA, 'reset', '--quiet', 'HEAD', '--', 'tracked.txt')
    }
    await expect(row('tracked.txt')).toHaveCount(1)
    await expect(row('tracked.txt').getByTitle('暂存', { exact: true })).toBeVisible()
    expect(git(repoA, 'ls-files', '--stage')).toBe(originalIndex)
  })

  test('Work Git 突发更新合并读取，隐藏停止同步，恢复补刷并保持虚拟列表有界', async ({}, info) => {
    const originalIndex = git(repoA, 'ls-files', '--stage')
    const original = readFileSync(join(repoA, 'tracked.txt'), 'utf8')
    const names = Array.from({ length: 125 }, (_, index) => `live-burst-${String(index).padStart(3, '0')}.txt`)
    const hiddenFile = '000-hidden-live-sync.txt'
    const metrics: Record<string, unknown> = { burstFiles: names.length, controlledResponseHoldMs: 650 }
    await setViewMode('list')
    await installGitReadProbe()
    try {
      await app!.evaluate(() => (globalThis as GitProbeGlobal).__workGitReadProbe!.holdNext())
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect.poll(async () => (await gitReadMetrics()).held).toBe(true)
      const held = await gitReadMetrics()
      const burstAt = Date.now()
      for (const [index, name] of names.entries()) writeFileSync(join(repoA, name), `burst content ${index}\n`)
      await page.evaluate(() => { for (let index = 0; index < 25; index++) window.dispatchEvent(new Event('focus')) })
      // Keep a real response pending beyond the scheduler's event debounce;
      // this is an observation window, not a readiness delay.
      await page.waitForTimeout(650)
      expect((await gitReadMetrics()).statusStarted).toBe(held.statusStarted)
      expect((await gitReadMetrics()).maxActiveStatus).toBe(1)
      await app!.evaluate(() => (globalThis as GitProbeGlobal).__workGitReadProbe!.release())
      const list = panel().locator('.git-virtual-list[data-virtualized="true"]').first()
      await expect(list).toBeVisible()
      expect((await gitReadMetrics()).statusStarted - held.statusStarted).toBe(1)
      await expect.poll(() => list.locator('.git-row').count()).toBeLessThan(100)
      await list.evaluate(element => {
        const parent = element.closest<HTMLElement>('.git-panel__content')!
        parent.scrollTop += element.getBoundingClientRect().bottom - parent.getBoundingClientRect().bottom
      })
      await expect(row(names.at(-1)!)).toBeVisible()
      metrics.burstConvergenceLatencyMs = Date.now() - burstAt
      metrics.mountedRows = await list.locator('.git-row').count()
      expect(git(repoA, 'ls-files', '--stage')).toBe(originalIndex)
      expect(readFileSync(join(repoA, names.at(-1)!), 'utf8')).toBe('burst content 124\n')
      metrics.afterBurst = await gitReadMetrics()
      expect((metrics.afterBurst as GitReadMetrics).maxActiveStatus).toBe(1)

      await work().getByRole('button', { name: '收起工作区', exact: true }).click()
      await expect(panel()).toBeHidden()
      await expect.poll(async () => (await gitReadMetrics()).activeStatus).toBe(0)
      const hiddenReads = (await gitReadMetrics()).reads
      writeFileSync(join(repoA, hiddenFile), 'created while the Git pane was hidden\n')
      // Cross the longest 8-second idle polling period to prove no reads occur.
      await page.waitForTimeout(8500)
      metrics.hiddenReadDelta = (await gitReadMetrics()).reads - hiddenReads
      expect(metrics.hiddenReadDelta).toBe(0)
      const reopenedAt = Date.now()
      await showGit()
      await panel().locator('.git-panel__content').evaluate(element => { element.scrollTop = 0 })
      await expect(row(hiddenFile)).toBeVisible()
      metrics.reopenLatencyMs = Date.now() - reopenedAt
      metrics.transport = await gitReadMetrics()
      expect((metrics.transport as GitReadMetrics).reads).toBeGreaterThan(hiddenReads)
      expect((metrics.transport as GitReadMetrics).maxActiveStatus).toBe(1)
      expect(readFileSync(join(repoA, hiddenFile), 'utf8')).toBe('created while the Git pane was hidden\n')
      expect(readFileSync(join(repoA, 'tracked.txt'), 'utf8')).toBe(original)
      expect(git(repoA, 'ls-files', '--stage')).toBe(originalIndex)
      await attachJson(info, 'work-git-burst-hidden-metrics', metrics)
    } finally {
      await app!.evaluate(() => (globalThis as GitProbeGlobal).__workGitReadProbe?.restore())
      for (const name of [...names, hiddenFile]) rmSync(join(repoA, name), { force: true })
    }
    await showGit()
    await setViewMode('tree')
    await expect(panel().locator('.git-tree__file[data-path^="live-burst-"]')).toHaveCount(0)
    await expect(row('tracked.txt')).toHaveCount(1)
    expect(git(repoA, 'ls-files', '--stage')).toBe(originalIndex)
  })

  test('单行、全部和多选放弃工作区更改保留暂存内容，混合选择按分组处理', async () => {
    const stagedContent = 'task-a pending change\n'
    const extra = 'discard-extra.txt'
    const extraStaged = 'extra staged content\n'
    const scopedRow = (path: string, staged: boolean): Locator =>
      panel()
        .locator('.git-row, .git-tree__file')
        .filter({ has: page.getByTitle(staged ? '取消暂存' : '暂存', { exact: true }) })
        .filter({ has: page.locator('.git-row__name, .tree-row__name').filter({ hasText: path }) })
    const confirmDiscard = async (title: string): Promise<void> => {
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '放弃更改', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    const assertIndexAndContents = async (index: string, withExtra = false): Promise<void> => {
      await expect.poll(() => readFileSync(join(repoA, 'tracked.txt'), 'utf8')).toBe(stagedContent)
      await expect.poll(() => git(repoA, 'ls-files', '--stage')).toBe(index)
      expect(git(repoA, 'show', ':tracked.txt')).toBe(stagedContent)
      if (withExtra) {
        await expect.poll(() => readFileSync(join(repoA, extra), 'utf8')).toBe(extraStaged)
        expect(git(repoA, 'show', `:${extra}`)).toBe(extraStaged)
      }
      await expect(scopedRow('tracked.txt', false)).toHaveCount(0)
    }

    await toggleStage('tracked.txt')
    await expect.poll(() => git(repoA, 'show', ':tracked.txt')).toBe(stagedContent)
    const singleIndex = git(repoA, 'ls-files', '--stage')
    writeFileSync(join(repoA, 'tracked.txt'), 'worktree-only second version\n')
    await refresh()
    await expect(row('tracked.txt')).toHaveCount(2)
    await scopedRow('tracked.txt', false).hover()
    await scopedRow('tracked.txt', false).getByTitle('放弃更改', { exact: true }).click()
    await confirmDiscard('放弃更改')
    await assertIndexAndContents(singleIndex)

    writeFileSync(join(repoA, extra), extraStaged)
    git(repoA, 'add', '--', extra)
    const protectedIndex = git(repoA, 'ls-files', '--stage')
    writeFileSync(join(repoA, 'tracked.txt'), 'all discard worktree version\n')
    writeFileSync(join(repoA, extra), 'extra worktree-only version\n')
    await refresh()
    await panel().getByTitle('放弃全部更改（仅工作区，暂存区保留）', { exact: true }).click()
    await confirmDiscard('全部放弃更改')
    await assertIndexAndContents(protectedIndex, true)

    writeFileSync(join(repoA, 'tracked.txt'), 'batch discard worktree version\n')
    writeFileSync(join(repoA, extra), 'extra batch worktree version\n')
    await refresh()
    await scopedRow('tracked.txt', false).click({ modifiers: ['Control'] })
    await scopedRow(extra, false).click({ modifiers: ['Control'] })
    await expect(panel().locator('.git-panel__batch-bar')).toContainText('已选 2 个文件')
    await panel()
      .locator('.git-panel__batch-bar')
      .getByRole('button', { name: '放弃更改', exact: true })
      .click()
    await confirmDiscard('批量放弃更改')
    await assertIndexAndContents(protectedIndex, true)

    // Selecting both projections restores the worktree from index first, then
    // removes only the explicitly selected staged version from the index.
    writeFileSync(join(repoA, 'tracked.txt'), 'mixed selection worktree version\n')
    await refresh()
    await scopedRow('tracked.txt', false).click({ modifiers: ['Control'] })
    await scopedRow('tracked.txt', true).click({ modifiers: ['Control'] })
    await panel()
      .locator('.git-panel__batch-bar')
      .getByRole('button', { name: '放弃更改', exact: true })
      .click()
    await confirmDiscard('批量放弃更改')
    await expect.poll(() => git(repoA, 'show', ':tracked.txt')).toBe('task-a baseline\n')
    await expect.poll(() => readFileSync(join(repoA, 'tracked.txt'), 'utf8')).toBe(stagedContent)
    expect(git(repoA, 'show', `:${extra}`)).toBe(extraStaged)
    expect(readFileSync(join(repoA, extra), 'utf8')).toBe(extraStaged)

    git(repoA, 'reset', '--quiet', 'HEAD', '--', extra)
    rmSync(join(repoA, extra))
    await refresh()
    await expect.poll(() => git(repoA, 'diff', '--cached', '--name-only')).toBe('')
    await expect(row('tracked.txt')).toHaveCount(1)
    expect(readFileSync(join(repoA, 'tracked.txt'), 'utf8')).toBe(stagedContent)
  })

  test('提交写入目标仓库，历史即时显示新提交并清空已提交草稿', async () => {
    await panel()
      .getByRole('textbox', { name: '提交信息', exact: true })
      .fill('feat: Work Git full panel commit')
    await toggleStage('tracked.txt')
    await expect.poll(() => git(repoA, 'diff', '--cached', '--name-only')).toBe('tracked.txt\n')
    await panel().locator('.git-commitbar__primary').click()
    await expect
      .poll(() => git(repoA, 'log', '-1', '--format=%s'))
      .toBe('feat: Work Git full panel commit\n')
    await expect(panel().getByRole('textbox', { name: '提交信息', exact: true })).toHaveValue('')
    await panel().locator('.git-panel__group-head').filter({ hasText: '提交历史' }).click()
    await expect(panel().locator('.git-panel__history')).toContainText(
      'feat: Work Git full panel commit'
    )
    await expect(panel().locator('.git-panel__history')).toContainText('task-a initial commit')
    await panel()
      .locator('.git-panel__commit-row')
      .filter({ hasText: 'feat: Work Git full panel commit' })
      .click()
    await panel().getByTitle('查看 tracked.txt 在此提交中的变更', { exact: true }).click()
    const diff = work().getByRole('region', { name: '任务文件差异', exact: true })
    await expect(diff).toContainText('父提交 ↔')
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible()
    await expect(diff).toContainText('task-a baseline')
    await expect(diff).toContainText('task-a pending change')
    await diff.getByRole('button', { name: '关闭差异', exact: true }).click()
    expect(git(repoA, 'status', '--porcelain=v1')).toBe('')
  })

  test('分支、标签和存储操作通过完整菜单落盘', async () => {
    await panel().locator('.git-branchbar__trigger').click()
    await page.getByPlaceholder('筛选分支，或输入新分支名').fill('feature/work-git')
    await page.getByRole('button', { name: '创建新分支「feature/work-git」', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '创建并切换', exact: true }).click()
    await expect.poll(() => git(repoA, 'branch', '--show-current')).toBe('feature/work-git\n')
    await expect(page.getByRole('dialog', { name: '新建分支', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await menuAction('标记', '创建标签…')
    await fillPrompt('work-git-v1')
    await expect(page.getByRole('dialog')).toContainText('标签说明')
    await fillPrompt('')
    await expect.poll(() => git(repoA, 'tag', '--list')).toBe('work-git-v1\n')
    // Empty optional annotation must create a lightweight tag, not trap the
    // user behind the generic required-name fallback in PromptDialog.
    expect(git(repoA, 'cat-file', '-t', 'work-git-v1')).toBe('commit\n')
    writeFileSync(join(repoA, 'tracked.txt'), 'task-a stashed change\n')
    await refresh()
    await expect(row('tracked.txt')).toBeVisible()
    await menuAction('存储', '存储当前更改…')
    await fillPrompt('work stash checkpoint')
    await expect
      .poll(() => git(repoA, 'stash', 'list', '--format=%s'))
      .toContain('work stash checkpoint')
    await expect
      .poll(() => readFileSync(join(repoA, 'tracked.txt'), 'utf8'))
      .toBe('task-a pending change\n')
    await panel().locator('.git-panel__group-head').filter({ hasText: '存储' }).click()
    const stash = panel()
      .locator('.git-panel__stash-row')
      .filter({ hasText: 'work stash checkpoint' })
    await expect(stash).toBeVisible()
    await stash.hover()
    const apply = stash.getByTitle('恢复改动（保留此存储）', { exact: true })
    await expect(apply).toBeEnabled()
    await apply.click()
    await expect
      .poll(() => readFileSync(join(repoA, 'tracked.txt'), 'utf8'))
      .toBe('task-a stashed change\n')
    expect(git(repoA, 'stash', 'list', '--format=%s')).toContain('work stash checkpoint')
    await page.screenshot({ path: join(fixtureRoot, 'work-git-preview.png') })
  })

  test('多远程推送和指定远程分支写入真实仓库，部分失败逐个报告', async () => {
    const origin = join(workspaceRoot, 'origin.git')
    const backup = join(workspaceRoot, 'backup.git')
    git(workspaceRoot, 'init', '--bare', origin)
    git(workspaceRoot, 'init', '--bare', backup)
    const optionalGit = (cwd: string, ...args: string[]): string => {
      try {
        return git(cwd, ...args).trim()
      } catch {
        return ''
      }
    }
    for (const [name, url] of [
      ['origin', origin],
      ['backup', backup]
    ]) {
      await menuAction('远程', '添加远程仓库…')
      await fillPrompt(name)
      await expect(page.getByRole('dialog')).toContainText('仓库 URL')
      await fillPrompt(url)
      await expect.poll(() => optionalGit(repoA, 'remote', 'get-url', name)).toBe(url)
    }
    const selectRemotesAndPush = async (): Promise<void> => {
      await menuAction('拉取，推送', '推送到多个远程…')
      const dialog = page.getByRole('dialog', { name: '推送到多个远程…', exact: true })
      await dialog.getByRole('checkbox', { name: 'origin', exact: true }).check()
      await dialog.getByRole('checkbox', { name: 'backup', exact: true }).check()
      await dialog.getByRole('button', { name: '确定（2）', exact: true }).click()
    }
    await selectRemotesAndPush()
    const head = git(repoA, 'rev-parse', 'HEAD').trim()
    await expect
      .poll(() => optionalGit(origin, 'rev-parse', 'refs/heads/feature/work-git'))
      .toBe(head)
    await expect
      .poll(() => optionalGit(backup, 'rev-parse', 'refs/heads/feature/work-git'))
      .toBe(head)
    const success = page.getByRole('dialog', { name: '多远程推送完成', exact: true })
    await expect(success).toContainText('origin')
    await expect(success).toContainText('backup')
    await success.locator('.modal__footer').getByRole('button', { name: '关闭', exact: true }).click()

    git(origin, 'update-ref', 'refs/heads/review-target', git(repoA, 'rev-parse', 'HEAD^').trim())
    git(repoA, 'fetch', 'origin')
    await menuAction('拉取，推送', '推送到其他分支…')
    const branches = page.getByRole('dialog', { name: '推送到其他分支…', exact: true })
    await branches.locator('.git-pickdlg__item').filter({ hasText: 'origin/review-target' }).click()
    await page
      .getByRole('dialog', { name: '推送到其他分支', exact: true })
      .getByRole('button', { name: '推送', exact: true })
      .click()
    await expect.poll(() => git(origin, 'rev-parse', 'refs/heads/review-target').trim()).toBe(head)
    expect(git(repoA, 'branch', '--show-current')).toBe('feature/work-git\n')

    git(repoA, 'remote', 'set-url', 'backup', join(workspaceRoot, 'missing-remote.git'))
    await selectRemotesAndPush()
    const partial = page.getByRole('dialog', { name: '多远程推送结果', exact: true })
    await expect(partial).toContainText('origin')
    await expect(partial).toContainText('backup')
    await expect(partial).toContainText('成功')
    await expect(partial).toContainText('失败')
    expect(git(origin, 'rev-parse', 'refs/heads/feature/work-git').trim()).toBe(head)
    await partial.locator('.modal__footer').getByRole('button', { name: '关闭', exact: true }).click()
    git(repoA, 'remote', 'set-url', 'backup', backup)
  })

  test('切换 Work 任务保留各自草稿和分支，不覆盖 Code 工作区', async () => {
    await panel()
      .getByRole('textbox', { name: '提交信息', exact: true })
      .fill('任务 A 的未提交草稿')
    await openTask('Git 任务 B')
    await expect(panel().locator('.git-branchbar__name')).toHaveText('main-b')
    await expect(panel().getByRole('textbox', { name: '提交信息', exact: true })).toHaveValue('')
    await panel()
      .getByRole('textbox', { name: '提交信息', exact: true })
      .fill('任务 B 的未提交草稿')
    await openTask('Git 任务 A')
    await expect(panel().locator('.git-branchbar__name')).toHaveText('feature/work-git')
    await expect(panel().getByRole('textbox', { name: '提交信息', exact: true })).toHaveValue(
      '任务 A 的未提交草稿'
    )
    await openTask('Git 任务 B')
    await expect(panel().getByRole('textbox', { name: '提交信息', exact: true })).toHaveValue(
      '任务 B 的未提交草稿'
    )
    await openTask('Git 任务 A')
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(page.locator('.git-panel:visible .git-branchbar__name')).toHaveText('code-main')
    await expect(
      page.locator('.git-panel:visible').getByRole('textbox', { name: '提交信息', exact: true })
    ).toHaveValue('Code 独立草稿')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await showGit()
    await expect(panel().getByRole('textbox', { name: '提交信息', exact: true })).toHaveValue(
      '任务 A 的未提交草稿'
    )
    expect(fingerprint(codeRepo)).toBe(codeFingerprint)
  })

  test('大量改动使用共享滚动容器虚拟列表，末尾文件仍可准确暂存', async () => {
    await setViewMode('list')
    for (let index = 0; index < 125; index++)
      writeFileSync(join(repoA, `large-${String(index).padStart(3, '0')}.txt`), `file ${index}\n`)
    await refresh()
    const list = panel().locator('.git-virtual-list[data-virtualized="true"]').first()
    await expect(list).toBeVisible()
    await expect.poll(() => list.locator('.git-row').count()).toBeLessThan(100)
    await list.evaluate((element) => {
      const parent = element.closest<HTMLElement>('.git-panel__content')!
      parent.scrollTop +=
        element.getBoundingClientRect().bottom - parent.getBoundingClientRect().bottom
    })
    const last = row('large-124.txt')
    await expect(last).toBeVisible()
    await toggleStage('large-124.txt')
    await expect.poll(() => git(repoA, 'diff', '--cached', '--name-only')).toBe('large-124.txt\n')
    expect(readFileSync(join(repoA, 'large-124.txt'), 'utf8')).toBe('file 124\n')
    await setViewMode('tree')
  })

  test('非仓库任务可克隆到自身工作区并进入完整 Git 面板', async () => {
    const sourceBranch = git(repoA, 'branch', '--show-current').trim()
    const sourceHead = git(repoA, 'rev-parse', 'HEAD')
    const sourceContent = git(repoA, 'show', 'HEAD:tracked.txt')
    // A file:// source obeys the same task boundary as the destination.
    const sources = join(cloneRoot, 'sources')
    mkdirSync(sources)
    const cloneSource = join(sources, 'task-a.git')
    git(cloneRoot, 'clone', '--bare', repoA, cloneSource)
    await openTask('Git 克隆任务', false)
    await expect(panel()).toContainText('当前目录不是 Git 仓库')
    await panel().getByRole('button', { name: '克隆仓库', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '克隆仓库到任务工作区', exact: true })
    await dialog.getByRole('textbox').fill(pathToFileURL(cloneSource).href)
    await dialog.getByRole('button', { name: '克隆', exact: true }).click()
    const cloned = join(cloneRoot, 'task-a')
    await expect.poll(() => existsSync(join(cloned, '.git')), { timeout: 30_000 }).toBe(true)
    await expect(panel().locator('.git-branchbar__name')).toHaveText(sourceBranch)
    await expect(work().getByRole('button', { name: '返回任务根目录', exact: true })).toBeVisible()
    expect(git(cloned, 'rev-parse', 'HEAD')).toBe(sourceHead)
    expect(git(cloned, 'show', 'HEAD:tracked.txt')).toBe(sourceContent)
    // A clone applies the host's checkout policy (including Windows CRLF).
    expect(readFileSync(join(cloned, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(sourceContent)
    await work().getByRole('button', { name: '返回任务根目录', exact: true }).click()
    await expect(panel()).toContainText('当前目录不是 Git 仓库')
    expect(existsSync(join(cloneRoot, '.git'))).toBe(false)
  })

  test('真实分支合并历史复用泳道且连线连续，分页虚拟列表可到达最早提交', async () => {
    await openTask('Git 分支图任务')
    await expect(panel().locator('.git-branchbar__name')).toHaveText('main')
    const history = panel().locator('.git-panel__history')
    if (!(await history.isVisible())) {
      await panel().locator('.git-panel__group-head').filter({ hasText: '提交历史' }).click()
    }
    const rows = history.locator('.git-panel__commit-row')
    await expect(rows.first()).toContainText('graph after merge 3')
    await expect(rows.filter({ hasText: 'graph merge alpha' })).toBeVisible()
    await expect(rows.filter({ hasText: 'graph merge beta' })).toBeVisible()
    const assertContinuousGraph = async (): Promise<void> => {
      const bounds = await rows.evaluateAll((elements) => elements.map((element) => {
        const row = element.getBoundingClientRect()
        const svg = element.querySelector<SVGSVGElement>('svg.git-graph')!
        const graph = svg.getBoundingClientRect()
        return {
          top: row.top,
          bottom: row.bottom,
          height: row.height,
          graphTop: graph.top,
          graphBottom: graph.bottom,
          graphHeight: graph.height,
          circleX: Number(svg.querySelector('circle')!.getAttribute('cx'))
        }
      }))
      expect(bounds.length).toBeGreaterThan(10)
      for (let index = 0; index < bounds.length; index++) {
        const row = bounds[index]
        expect(row.height).toBeGreaterThan(21)
        expect(row.height).toBeLessThan(23)
        expect(Math.abs(row.graphHeight - row.height)).toBeLessThan(0.75)
        expect(Math.abs(row.graphTop - row.top)).toBeLessThan(0.75)
        // Device-pixel rounding may be fractional; a multi-pixel gap is still a failure.
        if (index > 0) {
          expect(Math.abs(row.graphTop - bounds[index - 1].graphBottom)).toBeLessThan(0.75)
        }
        expect(row.circleX).toBeLessThanOrEqual(22)
      }
    }
    await assertContinuousGraph()
    for (const subject of ['graph after merge 3', 'graph after merge 2', 'graph after merge 1']) {
      await expect(rows.filter({ hasText: subject }).locator('.git-graph circle').first())
        .toHaveAttribute('cx', '11')
    }
    await expect(rows.filter({ hasText: 'graph merge beta' }).locator('.git-graph circle'))
      .toHaveCount(2)
    await panel().screenshot({ path: join(fixtureRoot, 'work-git-history-graph.png') })
    await page.screenshot({ path: join(fixtureRoot, 'work-git-history-graph-window.png') })

    const content = panel().locator('.git-panel__content')
    // Scroll to each page sentinel until the virtual list includes the root commit.
    await expect.poll(async () => {
      await content.evaluate((element) => { element.scrollTop = element.scrollHeight })
      return rows.filter({ hasText: 'graph initial commit' }).isVisible()
    }, { timeout: 30_000 }).toBe(true)
    await expect(history.locator('.git-virtual-list[data-virtualized="true"]')).toBeVisible()
    await expect.poll(() => rows.count()).toBeLessThan(100)
    await expect(rows.filter({ hasText: 'graph initial commit' }).locator('.git-graph circle').first())
      .toHaveAttribute('cx', '11')
    await assertContinuousGraph()
    expect(Number(git(graphRepo, 'rev-list', '--count', 'HEAD').trim())).toBe(117)
    expect(git(graphRepo, 'status', '--porcelain=v1')).toBe('')
    await content.evaluate((element) => { element.scrollTop = 0 })
    await expect(rows.first()).toContainText('graph after merge 3')
    await assertContinuousGraph()
    await panel().screenshot({ path: join(fixtureRoot, 'work-git-history-graph-virtual.png') })
  })

  test('历史默认显示可折叠目录树，根文件与层级正确，展开泳道和虚拟高度同步', async ({}, info) => {
    const history = panel().locator('.git-panel__history')
    const content = panel().locator('.git-panel__content')
    const rows = history.locator('.git-panel__commit-row')
    const head = rows.filter({ hasText: 'graph after merge 3' })
    await head.click()
    const details = history.locator('.git-panel__commit-files')
    const tree = details.getByRole('tree', { name: '提交文件', exact: true })
    await expect(tree).toBeVisible()
    await expect(tree.locator('[data-path="package.json"]')).toHaveAttribute('aria-level', '1')
    await expect(tree.locator('.git-panel__commit-dir[data-path="/"]')).toHaveCount(0)
    const source = tree.locator('.git-panel__commit-dir[data-path="src"]')
    const main = tree.locator('.git-panel__commit-dir[data-path="src/main"]')
    const nested = tree.locator('[data-path="src/main/codemap/service.ts"]')
    await expect(source).toHaveAttribute('aria-level', '1')
    await expect(main).toHaveAttribute('aria-level', '2')
    await expect(nested).toHaveAttribute('aria-level', '4')
    await expect(tree.locator('[data-path="src/renderer/components/code"] .tree-row__name'))
      .toHaveText('renderer/components/code')
    const mainIndent = await main.evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))
    const fileIndent = await nested.evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))
    expect(fileIndent).toBeGreaterThan(mainIndent)
    const assertExpandedContinuity = async (): Promise<void> => {
      await expect.poll(async () => {
        const previous = await head.locator('.git-graph').boundingBox()
        const rail = await details.locator('.git-panel__commit-rail').boundingBox()
        const next = await rows.filter({ hasText: 'graph after merge 2' }).locator('.git-graph').boundingBox()
        if (!previous || !rail || !next) return false
        return Math.abs(previous.y + previous.height - rail.y) < 0.75
          && Math.abs(rail.y + rail.height - next.y) < 0.75
          && Math.abs(rail.x - previous.x) < 0.75
      }).toBe(true)
    }
    await expect(details.locator('.git-panel__commit-rail line')).toHaveCount(1)
    await assertExpandedContinuity()
    const fullHeight = await details.evaluate(element => element.getBoundingClientRect().height)
    await source.click()
    await expect(source).toHaveAttribute('aria-expanded', 'false')
    await expect(nested).toHaveCount(0)
    await expect.poll(() => details.evaluate(element => element.getBoundingClientRect().height))
      .toBeLessThan(fullHeight - 100)
    await assertExpandedContinuity()
    await source.focus()
    await source.press('Enter')
    await expect(nested).toBeVisible()
    await assertExpandedContinuity()
    await panel().screenshot({ path: join(fixtureRoot, 'work-git-history-tree.png') })

    await tree.locator('[data-path="package.json"]').click()
    const diff = work().getByRole('region', { name: '任务文件差异', exact: true })
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible()
    await expect(diff).toContainText('graph tree content: package.json')
    await expectNarrowDiffLayout(diff, false)
    await diff.getByRole('button', { name: '并排比较', exact: true }).click()
    const sideBySide = await expectNarrowDiffLayout(diff, true)
    await expect(diff.locator('.editor.modified .view-lines')).toContainText('graph tree content: package.json')
    const refreshedSideBySide = await refreshDiffAndExpectLayout(diff, true)
    await diff.screenshot({ path: info.outputPath('work-git-history-narrow-side-by-side.png') })
    await diff.getByRole('button', { name: '行内比较', exact: true }).click()
    const inline = await expectNarrowDiffLayout(diff, false)
    await attachJson(info, 'work-git-history-diff-layout', { sideBySide, refreshedSideBySide, inline })
    await diff.getByRole('button', { name: '关闭差异', exact: true }).click()

    // Replacing an offscreen expanded row must discard its measured tree height.
    await content.evaluate(element => { element.scrollTop = element.scrollHeight })
    const rootCommit = rows.filter({ hasText: 'graph initial commit' })
    await expect(rootCommit).toBeVisible()
    await rootCommit.click()
    await expect(details.locator('[data-path="tracked.txt"]')).toBeVisible()
    await content.evaluate(element => { element.scrollTop = 0 })
    await expect(head).toBeVisible()
    await expect.poll(async () => {
      const first = await head.boundingBox()
      const second = await rows.filter({ hasText: 'graph after merge 2' }).boundingBox()
      return first && second ? Math.abs(first.y + first.height - second.y) : 100
    }).toBeLessThan(0.75)
    expect(git(graphRepo, 'status', '--porcelain=v1')).toBe('')
  })

  test('Work 高级 Git：真实会话合并冲突隔离，中止恢复原 HEAD 后可再次合并', async ({}, info) => {
    const protectedRepos = [repoA, repoB, codeRepo, graphRepo]
    const untouched = protectedRepos.map(fingerprint)
    await installAdvancedGitProbe()
    try {
      await switchAdvancedBranch('merge/target')
      const before = fingerprint(advancedRepo)
      const originalHead = advancedHeads['merge/target']
      await chooseAdvancedBranchOperation('合并分支…', 'merge/source')
      await expect.poll(() => existsSync(join(advancedRepo, '.git', 'MERGE_HEAD'))).toBe(true)
      await expect(panel().locator('.git-panel__merge-banner')).toContainText('1 个冲突文件')
      expect(git(advancedRepo, 'diff', '--name-only', '--diff-filter=U')).toBe('tracked.txt\n')
      expect(git(advancedRepo, 'rev-parse', 'HEAD').trim()).toBe(originalHead)
      expect(readFileSync(join(advancedRepo, 'tracked.txt'), 'utf8')).toContain('<<<<<<<')
      expect(readFileSync(join(advancedRepo, 'tracked.txt'), 'utf8')).toContain('advanced source conflict')

      await openTask('Git 任务 B')
      await expect(panel().locator('.git-branchbar__name')).toHaveText('main-b')
      await expect(panel().locator('.git-panel__merge-banner')).toHaveCount(0)
      expect(fingerprint(repoB)).toBe(otherFingerprint)
      await openTask('Git 高级操作任务')
      await expect(panel().locator('.git-panel__merge-banner')).toBeVisible()
      await menuAction('分支', '中止合并')
      await expect.poll(() => fingerprint(advancedRepo)).toBe(before)
      await expect.poll(() => existsSync(join(advancedRepo, '.git', 'MERGE_HEAD'))).toBe(false)
      await expect(panel().locator('.git-panel__merge-banner')).toHaveCount(0)

      await chooseAdvancedBranchOperation('合并分支…', 'merge/clean')
      await expect.poll(() => git(advancedRepo, 'show', '-s', '--format=%P', 'HEAD').trim())
        .toBe(`${originalHead} ${advancedHeads['merge/clean']}`)
      expect(readFileSync(join(advancedRepo, 'merged.txt'), 'utf8')).toBe('advanced clean merge\n')
      expect(readFileSync(join(advancedRepo, 'tracked.txt'), 'utf8')).toBe('advanced target conflict\n')
      expect(git(advancedRepo, 'status', '--porcelain=v1')).toBe('')
      expect(git(advancedRepo, 'rev-parse', 'merge/source').trim()).toBe(advancedHeads['merge/source'])
      await expect((await advancedHistory()).locator('.git-panel__commit-row').first()).toContainText('merge/clean')
      await expectAdvancedRouting([
        { op: 'merge', ref: 'merge/source' },
        { op: 'merge-abort' },
        { op: 'merge', ref: 'merge/clean' }
      ], info)
      expect(protectedRepos.map(fingerprint)).toEqual(untouched)
    } finally {
      await app!.evaluate(() => (globalThis as AdvancedGitProbeGlobal).__workGitAdvancedProbe?.restore())
    }
  })

  test('Work 高级 Git：可见菜单变基经真实会话 HTTP 重写父链且不改变其他任务', async ({}, info) => {
    const protectedRepos = [repoA, repoB, codeRepo, graphRepo]
    const untouched = protectedRepos.map(fingerprint)
    await installAdvancedGitProbe()
    try {
      await switchAdvancedBranch('rebase/target')
      const originalHead = advancedHeads['rebase/target']
      await chooseAdvancedBranchOperation('变基到分支…', 'rebase/source')
      await expect.poll(() => git(advancedRepo, 'show', '-s', '--format=%P', 'HEAD').trim())
        .toBe(advancedHeads['rebase/source'])
      const rewritten = git(advancedRepo, 'rev-parse', 'HEAD').trim()
      expect(rewritten).not.toBe(originalHead)
      expect(git(advancedRepo, 'branch', '--show-current')).toBe('rebase/target\n')
      expect(git(advancedRepo, 'log', '-1', '--format=%s')).toBe('advanced replayed commit\n')
      expect(readFileSync(join(advancedRepo, 'upstream.txt'), 'utf8')).toBe('advanced upstream\n')
      expect(readFileSync(join(advancedRepo, 'replayed.txt'), 'utf8')).toBe('advanced replayed change\n')
      expect(git(advancedRepo, 'rev-parse', 'rebase/source').trim()).toBe(advancedHeads['rebase/source'])
      expect(git(advancedRepo, 'status', '--porcelain=v1')).toBe('')
      expect(existsSync(join(advancedRepo, '.git', 'rebase-merge'))).toBe(false)
      expect(existsSync(join(advancedRepo, '.git', 'rebase-apply'))).toBe(false)
      const history = await advancedHistory()
      await expect(history.locator('.git-panel__commit-row').first()).toContainText('advanced replayed commit')
      await expect(history.locator('.git-panel__commit-row').filter({ hasText: 'advanced upstream commit' })).toBeVisible()
      await expectAdvancedRouting([{ op: 'rebase', ref: 'rebase/source' }], info)
      expect(protectedRepos.map(fingerprint)).toEqual(untouched)
    } finally {
      await app!.evaluate(() => (globalThis as AdvancedGitProbeGlobal).__workGitAdvancedProbe?.restore())
    }
  })

  test('Work 高级 Git：历史菜单拣选另一分支提交并反转，真实文件与提交树恢复', async ({}, info) => {
    const protectedRepos = [repoA, repoB, codeRepo, graphRepo]
    const untouched = protectedRepos.map(fingerprint)
    await installAdvancedGitProbe()
    try {
      await switchAdvancedBranch('pick/target')
      const originalHead = advancedHeads['pick/target']
      const originalTree = git(advancedRepo, 'rev-parse', 'HEAD^{tree}').trim()
      const sourceHead = advancedHeads['pick/source']
      expect(existsSync(join(advancedRepo, 'picked.txt'))).toBe(false)
      const history = await advancedHistory()
      await history.getByRole('button', { name: '分支', exact: true }).click()
      await page.getByRole('menuitem', { name: '全部分支', exact: true }).click()
      const source = history.locator('.git-panel__commit-row').filter({ hasText: 'advanced pick payload' })
      await expect(source).toHaveCount(1)
      await source.click({ button: 'right' })
      const cherryPick = page.getByRole('menuitem', { name: '拣选此提交（cherry-pick）', exact: true })
      await expect(cherryPick).toBeEnabled()
      await cherryPick.click()
      await expect.poll(() => existsSync(join(advancedRepo, 'picked.txt'))).toBe(true)
      await expect.poll(() => git(advancedRepo, 'status', '--porcelain=v1')).toBe('')
      const pickedHead = git(advancedRepo, 'rev-parse', 'HEAD').trim()
      expect(pickedHead).not.toBe(sourceHead)
      expect(git(advancedRepo, 'show', '-s', '--format=%P', 'HEAD').trim()).toBe(originalHead)
      expect(readFileSync(join(advancedRepo, 'picked.txt'), 'utf8')).toBe('advanced picked payload\n')
      expect(git(advancedRepo, 'rev-parse', 'pick/source').trim()).toBe(sourceHead)

      // Restrict back to this task's current branch so the original source and
      // its newly picked copy cannot be confused by their identical subjects.
      await history.getByRole('button', { name: '分支', exact: true }).click()
      await page.getByRole('menuitem', { name: '当前分支', exact: true }).click()
      const picked = history.locator('.git-panel__commit-row').filter({ hasText: 'advanced pick payload' })
      await expect(picked).toHaveCount(1)
      await expect(history.locator('.git-panel__commit-row').first()).toContainText('advanced pick payload')
      await picked.click({ button: 'right' })
      const revert = page.getByRole('menuitem', { name: '反转此提交（revert）', exact: true })
      await expect(page.getByRole('menuitem', { name: '复制提交哈希', exact: true })).toBeEnabled()
      // The menu itself owns readiness; the preceding disk write is not proof
      // that its mutation's refresh/finally has released the next write.
      await expect(revert).toBeEnabled()
      await revert.click()
      const confirmation = page.getByRole('dialog', { name: '反转提交', exact: true })
      await expect(confirmation).toContainText(pickedHead.slice(0, 7))
      await confirmation.getByRole('button', { name: '反转', exact: true }).click()
      await expect(confirmation).toHaveCount(0)
      await expect.poll(() => git(advancedRepo, 'rev-parse', 'HEAD^{tree}').trim()).toBe(originalTree)
      expect(existsSync(join(advancedRepo, 'picked.txt'))).toBe(false)
      expect(readFileSync(join(advancedRepo, 'pick-target.txt'), 'utf8')).toBe('advanced pick target\n')
      expect(git(advancedRepo, 'show', '-s', '--format=%P', 'HEAD').trim()).toBe(pickedHead)
      expect(git(advancedRepo, 'rev-list', '--count', `${originalHead}..HEAD`)).toBe('2\n')
      expect(git(advancedRepo, 'log', '-1', '--format=%B')).toContain(pickedHead)
      expect(git(advancedRepo, 'status', '--porcelain=v1')).toBe('')
      await expect(history.locator('.git-panel__commit-row').first()).toContainText('Revert "advanced pick payload"')
      await expectAdvancedRouting([
        { op: 'cherry-pick', hash: sourceHead },
        { op: 'revert-commit', hash: pickedHead }
      ], info)
      expect(protectedRepos.map(fingerprint)).toEqual(untouched)
    } finally {
      await app!.evaluate(() => (globalThis as AdvancedGitProbeGlobal).__workGitAdvancedProbe?.restore())
    }
  })

  test('Git 打开文件自动展开工作区多级目录、选中并滚动定位，切换文件同步更新', async ({}, info) => {
    const before = fingerprint(revealRepo)
    const beforeDiff = git(revealRepo, 'diff')
    const normalizedRoot = revealRepo.replace(/\\/g, '/')
    const workspacePanel = work().getByRole('region', { name: '工作区文件', exact: true })
    const tree = workspacePanel.locator('.explorer__tree')
    const treeRow = (path: string): Locator => tree.locator(`[role="treeitem"][data-path=${JSON.stringify(path)}]`)
    const memoryKey = createFileTreeScope('work', engineStorageKey({ mode: 'remote', baseUrl }), sessionReveal, revealRepo).key
    const memory = (): Promise<FileTreeMemory> => page.evaluate(({ storageKey, key }) => {
      const table: Record<string, FileTreeMemory> = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      if (!table[key]) throw new Error(`Missing reveal tree memory: ${key}`)
      return table[key]
    }, { storageKey: FILE_TREE_MEMORY_KEY, key: memoryKey })

    await openTask('Git 文件定位任务')
    const workspaceTab = work().getByRole('tab', { name: '工作区', exact: true })
    if (await workspaceTab.count()) await workspaceTab.click()
    else {
      await work().getByRole('button', { name: '更多工作区', exact: true }).press('ArrowDown')
      await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
    }
    await expect(workspacePanel).toHaveAttribute('data-session-id', sessionReveal)
    await expect(tree).toHaveAttribute('aria-busy', 'false')
    const rootRow = tree.getByRole('treeitem').first()
    if (await rootRow.getAttribute('aria-expanded') !== 'true') await rootRow.click()
    for (const branch of ['alpha', 'omega']) {
      await expect(treeRow(`${normalizedRoot}/${branch}`)).toHaveAttribute('aria-expanded', 'false')
      await expect(treeRow(`${normalizedRoot}/${branch}/nested/zz-${branch}.txt`)).toHaveCount(0)
    }
    await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBe(0)

    const preview = work().locator('.work-files-workspace__preview').getByRole('region', { name: '成果预览', exact: true })
    const reveal = async (branch: string) => {
      const relativePath = `${branch}/nested/zz-${branch}.txt`
      const absolutePath = `${normalizedRoot}/${relativePath}`
      await expect(workspaceTab).toHaveAttribute('aria-selected', 'true')
      await expect(preview).toBeVisible()
      await expect(preview).toHaveAttribute('data-document-session', sessionReveal)
      await expect.poll(async () => {
        const path = (await preview.getAttribute('data-document-path'))?.replace(/\\/g, '/') ?? ''
        return fileTreePathKey(/^(?:[A-Za-z]:|\/)/.test(path) ? path : `${normalizedRoot}/${path}`)
      }).toBe(fileTreePathKey(absolutePath))
      await expect(preview).toContainText(`tree reveal ${branch} changed`)
      await expect(tree).toBeVisible()
      await expect(tree).toHaveAttribute('aria-busy', 'false')
      const target = treeRow(absolutePath)
      await expect(target).toHaveAttribute('aria-selected', 'true')
      await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1)
      // Ancestors can be outside the virtualized DOM. Persisted expansion plus
      // a rendered descendant proves the entire branch was opened by navigation.
      await expect.poll(async () => (await memory()).expanded.map(fileTreePathKey)).toEqual(expect.arrayContaining([
        normalizedRoot, `${normalizedRoot}/${branch}`, `${normalizedRoot}/${branch}/nested`
      ].map(fileTreePathKey)))
      await expect.poll(async () => (await memory()).selection.map(fileTreePathKey)).toEqual([fileTreePathKey(absolutePath)])
      await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBeGreaterThan(500)
      const geometry = () => target.evaluate(element => {
        const viewport = element.closest<HTMLElement>('.explorer__tree')!
        const bounds = viewport.getBoundingClientRect()
        const row = element.getBoundingClientRect()
        const viewportTop = bounds.top + viewport.clientTop
        const viewportBottom = viewportTop + viewport.clientHeight
        const sticky = viewport.parentElement?.querySelector<HTMLElement>('.explorer__sticky')
        const stickyRect = sticky?.getBoundingClientRect()
        const stickyStyle = sticky ? getComputedStyle(sticky) : null
        const visibleSticky = stickyRect && stickyStyle && stickyStyle.display !== 'none'
          && stickyStyle.visibility !== 'hidden' && Number(stickyStyle.opacity) > 0
          && stickyRect.width > 0 && stickyRect.height > 0
          && stickyRect.bottom > viewportTop && stickyRect.top < viewportBottom
        const hit = document.elementFromPoint((row.left + row.right) / 2, (row.top + row.bottom) / 2)
        return { scrollTop: viewport.scrollTop, top: row.top, bottom: row.bottom,
          viewportTop, viewportBottom, stickyBottom: visibleSticky ? stickyRect.bottom : null,
          hitPath: hit?.closest('[role="treeitem"]')?.getAttribute('data-path') ?? null }
      })
      // Viewport containment alone misses an upward reveal hidden behind the
      // sticky ancestors. The target must also own the hit at its center.
      await expect.poll(async () => {
        const box = await geometry()
        return box.bottom > box.top && box.viewportBottom > box.viewportTop
          && box.top >= box.viewportTop - 1 && box.bottom <= box.viewportBottom + 1
          && (box.stickyBottom === null || box.top >= box.stickyBottom - 1)
          && box.hitPath !== null && fileTreePathKey(box.hitPath) === fileTreePathKey(absolutePath)
      }).toBe(true)
      return { path: absolutePath, ...await geometry() }
    }

    await showGit()
    await setViewMode('list')
    await row('zz-alpha.txt').click()
    const diff = work().getByRole('region', { name: '任务文件差异', exact: true })
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible()
    await diff.getByRole('button', { name: '打开文件', exact: true }).click()
    const first = await reveal('alpha')
    await preview.getByRole('button', { name: '在资源中打开', exact: true }).click()
    await expect(work().getByRole('tab', { name: 'zz-alpha.txt', exact: true })).toHaveAttribute('aria-selected', 'true')

    await showGit()
    await row('zz-omega.txt').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '打开文件', exact: true }).click()
    const second = await reveal('omega')
    expect(second.scrollTop).toBeGreaterThan(first.scrollTop + 500)
    expect((await memory()).selection.map(fileTreePathKey)).not.toContain(fileTreePathKey(first.path))
    await preview.getByRole('button', { name: '在资源中打开', exact: true }).click()
    await expect(work().getByRole('tab', { name: 'zz-omega.txt', exact: true })).toHaveAttribute('aria-selected', 'true')

    const resourceReveals: Array<Awaited<ReturnType<typeof reveal>>> = []
    for (const branch of ['alpha', 'omega']) {
      const resourceTab = work().getByRole('tab', { name: `zz-${branch}.txt`, exact: true })
      await resourceTab.click()
      await expect(resourceTab).toHaveAttribute('aria-selected', 'true')
      const resourcePreview = work().locator('.work-resource-file:visible').getByRole('region', { name: '成果预览', exact: true })
      await expect(resourcePreview).toBeVisible()
      await expect(resourcePreview).toHaveAttribute('data-document-session', sessionReveal)
      await expect(resourcePreview).toContainText(`tree reveal ${branch} changed`)
      await workspaceTab.click()
      resourceReveals.push(await reveal(branch))
    }

    // A second explicit request for the same file must reveal again even when
    // its preview was already selected and the user collapsed/filtered the tree.
    await workspacePanel.getByRole('button', { name: '全部收起', exact: true }).click()
    // Loaded single-child folders compact to their leaf when collapsed.
    await expect(treeRow(`${normalizedRoot}/omega/nested`)).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await memory()).expanded.map(fileTreePathKey)).toEqual([fileTreePathKey(normalizedRoot)])
    const filter = workspacePanel.getByRole('textbox', { name: '筛选文件', exact: true })
    await filter.fill('no-matching-reveal-file')
    await expect(treeRow(second.path)).toHaveCount(0)
    await showGit()
    await row('zz-omega.txt').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '打开文件', exact: true }).click()
    await expect(filter).toHaveValue('')
    const repeated = await reveal('omega')
    await page.screenshot({ path: info.outputPath('work-git-open-file-tree-reveal.png') })

    // Once a reveal completed, user navigation owns the remembered viewport.
    // Closing the surface destroys its local refs, exposing a stale request
    // that would otherwise replay and clear this deliberately different filter.
    await filter.fill('filler-')
    await expect(treeRow(repeated.path)).toHaveCount(0)
    await tree.hover()
    await page.mouse.wheel(0, -10_000)
    await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBe(0)
    await page.mouse.wheel(0, 360)
    await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBe(360)
    await expect.poll(async () => (await memory()).scrollTop).toBe(360)
    const manualMemory = await memory()
    await work().getByRole('button', { name: '关闭工作区', exact: true }).click()
    await expect(workspaceTab).toHaveCount(0)
    await expect(workspacePanel).toHaveCount(0)
    await work().getByRole('button', { name: '更多工作区', exact: true }).press('ArrowDown')
    await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
    await expect(workspacePanel).toHaveAttribute('data-session-id', sessionReveal)
    await expect(tree).toHaveAttribute('aria-busy', 'false')
    // Let the ready tree paint after restoration; a retained request resolves
    // from its restored directory cache and would clear the filter by then.
    await tree.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(filter).toHaveValue(manualMemory.filter)
    await expect.poll(() => tree.evaluate((element, top) => Math.abs(element.scrollTop - top), manualMemory.scrollTop)).toBeLessThanOrEqual(3)
    await expect(treeRow(repeated.path)).toHaveCount(0)
    const restoredMemory = await memory()
    expect(restoredMemory.filter).toBe(manualMemory.filter)
    expect(restoredMemory.selection.map(fileTreePathKey)).toEqual(manualMemory.selection.map(fileTreePathKey))
    expect(Math.abs(restoredMemory.scrollTop - manualMemory.scrollTop)).toBeLessThanOrEqual(3)
    await page.screenshot({ path: info.outputPath('work-git-consumed-reveal-memory.png') })
    await attachJson(info, 'work-git-open-file-tree-reveal', { first, second, resourceReveals, repeated, manualMemory, restoredMemory })
    expect(fingerprint(revealRepo)).toBe(before)
    expect(git(revealRepo, 'diff')).toBe(beforeDiff)
  })
})
