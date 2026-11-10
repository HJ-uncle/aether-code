/** Real Electron Git dialogs backed by an authenticated, isolated HTTP fixture.
 * Covers rich branch choices, search/keyboard selection, multi-remote selection,
 * prompt sequencing and validation, cancelled destructive actions, and detail
 * layouts in both themes and narrow windows. Git writes are captured and checked
 * against the exact session binding. Legacy names-only responses read actual
 * commits from an isolated temporary Git repository; user repositories and
 * remotes are never touched.
 * Build first and run with playwright.git-dialogs.config.ts (workers: 1). */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { GitCommitInfo, GitFileChange, GitLogEntry, GitRemoteBranchInfo, GitStashEntry } from '../src/shared/git-types'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'git-dialogs-token', model = 'git-dialogs-model', sessionId = 'work-git-dialogs'
const workspace = '/remote/git-dialogs', epoch = 'git-dialogs-binding', title = 'Git 弹窗验收'
const now = Date.now(), errors: string[] = [], actions: Record<string, unknown>[] = [], reads: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = ''
let permittedActions = new Set<string>()
let namesOnly = false, metadataRepository = ''
let currentEpoch = epoch, changeBindingOnMetadata = false
const metadataReads: Array<{ refs: string; limit: string | null }> = []
const realBranchInfos = new Map<string, GitRemoteBranchInfo>()
const date = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

function fixtureGit(args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  return execFileSync('git', args, {
    cwd: metadataRepository, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...isolatedEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(fixture, 'empty-gitconfig'), ...env },
    ...(input === undefined ? {} : { input })
  }).trim()
}

function prepareMetadataRepository(): void {
  metadataRepository = join(fixture, 'branch-metadata-repository')
  mkdirSync(metadataRepository)
  fixtureGit(['init', '--initial-branch=dev'])
  const tree = fixtureGit(['mktree'], {}, '')
  let parent: string | undefined
  for (const entry of [
    { local: 'feature/alpha-older', remote: 'origin/alpha-older', minutes: 90, author: '陈青', subject: 'fix: 真仓库旧分支摘要' },
    { local: 'feature/team/middle', remote: 'origin/team/middle', minutes: 12, author: '李明', subject: 'fix: 真仓库多级分支摘要' },
    { local: 'feature/zeta-recent', remote: 'origin/zeta-recent', minutes: 3, author: '张晴', subject: 'feat: 真仓库最新功能摘要' },
    { local: 'dev', remote: undefined, minutes: 1, author: 'Fixture User', subject: 'chore: 真仓库当前分支' }
  ]) {
    const timestamp = date(entry.minutes)
    const hash = fixtureGit(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', entry.subject], {
      GIT_AUTHOR_NAME: entry.author, GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_NAME: entry.author, GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: timestamp
    })
    fixtureGit(['update-ref', `refs/heads/${entry.local}`, hash])
    if (entry.remote) fixtureGit(['update-ref', `refs/remotes/${entry.remote}`, hash])
    const shortHash = fixtureGit(['rev-parse', '--short', hash])
    for (const name of [entry.local, entry.remote].filter((name): name is string => Boolean(name))) {
      realBranchInfos.set(name, { name, hash: shortHash, subject: entry.subject, author: entry.author, date: timestamp })
    }
    parent = hash
  }
  fixtureGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/zeta-recent'])
}

function legacyBranches(remote: boolean): string[] {
  return fixtureGit(['for-each-ref', '--format=%(refname:short)', remote ? 'refs/remotes' : 'refs/heads']).split(/\r?\n/).filter(Boolean)
}

function legacyLog(url: URL): GitLogEntry[] {
  const refs = url.searchParams.get('refs') ?? ''
  const requestedLimit = Number(url.searchParams.get('limit') ?? 50)
  // A bounded batch cannot cover every branch tip. Simulate an older endpoint's
  // smaller page so the UI must also resolve the untouched, older branch refs.
  const limit = refs === 'all' ? Math.min(2, requestedLimit) : requestedLimit
  const raw = fixtureGit(['log', '--topo-order', `-${limit}`,
    '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e',
    ...(refs === 'all' ? ['--all'] : [refs])])
  return raw.split('\x1e').filter(record => record.trim()).map(record => {
    const [hash, shortHash, author, timestamp, subject, body, parents, decorations] = record.split('\x1f')
    return { hash, shortHash, author, date: timestamp, subject, body, parents: parents.split(' ').filter(Boolean),
      refs: decorations.split(',').filter(Boolean).map(value => {
        const name = value.trim()
        return { name, type: name.startsWith('origin/') ? 'remote' : name.startsWith('tag:') ? 'tag' : 'branch' }
      }), fileChanges: [] }
  })
}
const localInfos: GitRemoteBranchInfo[] = [
  { name: 'feature/alpha-older', hash: 'a11ce01', subject: 'fix: 较早的布局修正', author: '陈青', date: date(90) },
  { name: 'dev', hash: 'd44ee04', subject: 'chore: 当前分支', author: 'Fixture User', date: date(1) },
  { name: 'feature/zeta-recent', hash: 'c33ff03', subject: 'feat: 最近的双行选择列表', author: '张晴', date: date(3) },
  { name: 'feature/team/middle', hash: 'b22de02', subject: 'fix: 保留多级分支路径', author: '李明', date: date(12) }
]
const remoteInfos: GitRemoteBranchInfo[] = [
  { ...localInfos[0], name: 'origin/alpha-older' },
  { ...localInfos[2], name: 'origin/zeta-recent' },
  { ...localInfos[3], name: 'origin/team/middle' },
  ...Array.from({ length: 18 }, (_, index) => ({ name: `origin/archive/very-long-branch-name-for-dialog-boundary-${index + 1}`,
    hash: (index + 10).toString(16).padStart(7, 'e'), subject: `chore: 归档提交 ${index + 1}`, author: '归档作者', date: date(120 + index) }))
]
const initialRemotes = [
  { name: 'origin', url: 'https://origin.invalid/team/project.git' },
  { name: 'mirror-a', url: 'https://mirror.invalid/a/team/project.git' },
  { name: 'mirror-b', url: 'ssh://git@mirror.invalid/b/team/project.git' },
  { name: 'backup', url: 'https://backup.invalid/team/project.git' }
]
let remotes = [...initialRemotes]
const files: GitFileChange[] = [{ path: 'src/dialog-fixture.tsx', changeType: 'modified', staged: true,
  stagedChange: 'modified', unstagedChange: null, binary: false, additions: 3, deletions: 1, stagedAdditions: 3, stagedDeletions: 1 }]
const longPath = 'src/需要保留完整目录信息的模块/用于验证弹窗中长文件名不会撑破窗口的说明文件.tsx'
const commits: GitLogEntry[] = Array.from({ length: 3 }, (_, index) => ({
  hash: (index + 1).toString(16).padStart(40, 'a'), shortHash: (index + 1).toString(16).padStart(7, 'a'),
  subject: index === 0 ? 'feat: 统一 Git 弹窗的布局与操作反馈' : `chore: 弹窗验收提交 ${index + 1}`,
  author: 'Fixture User', date: date(index + 1), parents: index < 2 ? [(index + 2).toString(16).padStart(40, 'a')] : [],
  refs: index === 0 ? [{ name: 'dev', type: 'head' }] : [], fileChanges: [{ code: 'M', path: longPath }]
}))
const detail: GitCommitInfo = { ...commits[0], parents: commits[0].parents!, body: '保留原有 Git 操作语义。\n为分支、远程与存储提供清晰的元信息。',
  additions: 12, deletions: 3, fileChanges: [{ code: 'M', path: longPath }, { code: 'A', path: 'docs/弹窗验收.md' }] }
const stashes: GitStashEntry[] = [{ index: 0, hash: 'b'.repeat(40), message: 'On dev: 需要核对完整目录的界面修改', date: date(24) }]
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const bindingFields = { sessionId, cwd: '.', expectedRoot: workspace, bindingEpoch: epoch }
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks), parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  if (path === '/api/v1/git/action') {
    actions.push(input)
    if (!permittedActions.has(String(input.op))) throw new Error(`Unexpected Git write: ${JSON.stringify(input)}`)
    for (const [key, value] of Object.entries(bindingFields)) if (input[key] !== value) throw new Error(`Invalid action binding: ${JSON.stringify(input)}`)
    if (input.op === 'add-remote') remotes.push({ name: String(input.name), url: String(input.url) })
    response.end(envelope({ success: true })); return
  }
  if (path.startsWith('/api/v1/git/')) {
    const op = path.slice('/api/v1/git/'.length); reads.push(`${id}:${op}`)
    if (id !== sessionId) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error(`Unexpected Git session: ${id}`)
      const empty = op === 'binding' ? { root: workspace, epoch, contractVersion: 2, mutationRequiresBinding: true }
        : op === 'status' ? { success: true, isRepo: false, files: [] }
        : op === 'branch-info' ? { success: true, isRepo: false, info: null }
        : op === 'list-stashes' ? { success: true, stashes: [] }
        : op === 'log' || op === 'incoming' ? { success: true, commits: [] } : undefined
      if (empty === undefined) throw new Error(`Unexpected background Code Git read: ${op}`)
      response.end(envelope(empty)); return
    }
    if (op !== 'binding') for (const [key, value] of Object.entries({ ...bindingFields, bindingEpoch: currentEpoch })) {
      if (url.searchParams.get(key) !== value) throw new Error(`Invalid read binding: ${url.pathname}${url.search}`)
    }
    if (op === 'log' && url.searchParams.get('refs')) {
      metadataReads.push({ refs: url.searchParams.get('refs')!, limit: url.searchParams.get('limit') })
    }
    const data = op === 'binding' ? { root: workspace, epoch: currentEpoch, contractVersion: 2, mutationRequiresBinding: true }
      : op === 'lease' ? { success: true, lease: { busy: false, recoverable: false } }
      : op === 'status' ? { success: true, isRepo: true, files }
      : op === 'branch-info' ? { success: true, isRepo: true, info: { branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 0 } }
      : op === 'list-stashes' ? { success: true, stashes }
      : op === 'list-remotes' ? { success: true, remotes }
      : op === 'list-branches' ? namesOnly
        ? { success: true, branches: legacyBranches(false), current: 'dev' }
        : { success: true, branches: localInfos.map(info => info.name), current: 'dev', infos: localInfos }
      : op === 'list-remote-branches' ? namesOnly
        ? { success: true, branches: legacyBranches(true) }
        : { success: true, branches: ['origin', 'origin/HEAD', ...remoteInfos.map(info => info.name)], infos: remoteInfos }
      : op === 'log' ? { success: true, commits: namesOnly && url.searchParams.get('refs') ? legacyLog(url) : commits }
      : op === 'incoming' ? { success: true, commits: [] }
      : op === 'user-name' ? { success: true, name: 'Fixture User' }
      : op === 'list-authors' ? { success: true, authors: ['Fixture User'] }
      : op === 'list-tags' ? { success: true, tags: ['v1.0.0'] }
      : op === 'stash-show-files' ? { success: true, content: `${longPath}\ndocs/弹窗验收.md` }
      : op === 'stash-show' ? { success: true, content: 'diff --git a/dialog-fixture.tsx b/dialog-fixture.tsx\n+fixture dialog' }
      : op === 'commit-show' ? { success: true, commit: detail }
      : undefined
    if (data === undefined) throw new Error(`Unexpected Git read: ${op}`)
    if (changeBindingOnMetadata && op === 'log' && url.searchParams.get('refs') === 'all') {
      currentEpoch = `${epoch}-rebound`
      changeBindingOnMetadata = false
    }
    response.end(envelope(data)); return
  }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: input.workspaceRoot })); return }
  if (path === '/api/v1/chat/admission/receipt') { response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'git-dialogs' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: 'Git 弹窗测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'git-dialogs-tenant', sessionId: id, namespace: { id: 'git-dialogs-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 0 }]
    : path === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: epoch, entries: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const panel = (): Locator => page.getByRole('region', { name: '任务 Git', exact: true })
const dialog = (name: string): Locator => page.getByRole('dialog', { name, exact: true })
async function focusWindow(): Promise<void> {
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
}
async function settle(target: Locator): Promise<void> {
  await target.evaluate(async element => {
    await document.fonts.ready
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => undefined)))
  })
}
async function menuAction(group: string, label: string): Promise<void> {
  await focusWindow()
  await panel().getByRole('button', { name: '更多操作', exact: true }).click()
  const parent = page.getByRole('menuitem', { name: group, exact: true })
  await parent.click()
  const item = page.getByRole('menuitem', { name: label, exact: true })
  await expect(item).toBeEnabled(); await item.click()
}
async function openPicker(group: string, label: string): Promise<Locator> {
  await menuAction(group, label)
  const picker = dialog(label)
  await expect(picker).toBeVisible(); await settle(picker)
  await expect(picker.getByRole('combobox')).toBeFocused()
  return picker
}
async function closeDialog(target: Locator): Promise<void> {
  await page.keyboard.press('Escape'); await expect(target).toHaveCount(0)
}
async function expectActions(expected: Record<string, unknown>[]): Promise<void> {
  await expect.poll(() => actions.length).toBe(expected.length)
  expect(actions).toEqual(expected.map(action => ({ ...bindingFields, ...action })))
  await expect(panel().getByRole('button', { name: /^切换或新建分支：/ })).toBeEnabled()
}
async function setWindow(width: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  const tab = page.locator('.work-mobile-tabs').getByRole('button', { name: '工作区', exact: true })
  if (await tab.isVisible()) await tab.click()
  await expect(panel()).toBeVisible(); await settle(panel())
}
async function screenshotDialog(info: TestInfo, target: Locator, name: string): Promise<void> {
  await settle(target)
  const geometry = await target.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight,
      overflow: element.scrollWidth - element.clientWidth }
  })
  expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.y).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.width); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
  expect(geometry.overflow).toBeLessThanOrEqual(1)
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path }); await info.attach(name, { path, contentType: 'image/png' })
}

test.describe.serial('统一 Git 操作弹窗', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'git-dialogs-profile-'))
    prepareMetadataRepository()
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace,
      autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'dark', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(520, 600); window.setContentSize(1440, 900); window.show(); window.focus()
      // Native pointer movement on the shared desktop must not override CDP hover.
      window.setIgnoreMouseEvents(true)
    })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => {
    actions.length = 0; permittedActions = new Set(); remotes = [...initialRemotes]
    namesOnly = false; metadataReads.length = 0
    currentEpoch = epoch; changeBindingOnMetadata = false
    await page.evaluate(({ key, sessionId, title, workspace, model, now }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', mentions: [], createdAt: now, updatedAt: now,
        workspacePath: workspace, modelId: model, attachments: [], sources: [] }], activeTaskId: sessionId, homeSources: [] }))
      localStorage.setItem('aether.app.mode', 'work'); localStorage.setItem('aether:git:autoFetch:enabled', '0')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: true, workspace: true, tab: 'git', pane: 'workspace', ratio: 35 }))
    }, { key: storageKey, sessionId, title, workspace, model, now })
    await page.reload(); await focusWindow(); await setWindow(1440)
    await expect(panel()).toContainText('dialog-fixture.tsx')
    await expect(panel().getByRole('button', { name: '存储', exact: true }).locator('.git-panel__count')).toHaveText('1')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('git-dialogs-failure.png')
      await page.screenshot({ path }); await info.attach('Git 弹窗失败窗口', { path, contentType: 'image/png' })
    }
    await info.attach('git-dialogs-http', { body: JSON.stringify({ errors, actions, reads, metadataReads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('git-dialogs-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('拉取分支按最近提交排序，作者和哈希可搜索，键盘选中保留完整分支路径', async () => {
    permittedActions.add('pull-from')
    const picker = await openPicker('拉取，推送', '拉取自…'), search = picker.getByRole('combobox')
    const rows = picker.getByRole('option')
    await expect(rows.first()).toContainText('origin/zeta-recent')
    await expect(rows.nth(1)).toContainText('origin/team/middle')
    await expect(rows.first()).toContainText('c33ff03')
    await expect(rows.first()).toContainText('feat: 最近的双行选择列表')
    await expect(rows.first()).toContainText('张晴')
    await search.fill('张晴'); await expect(rows).toHaveCount(1); await expect(rows).toContainText('origin/zeta-recent')
    await search.fill('b22de02'); await expect(rows).toHaveCount(1); await expect(rows).toContainText('origin/team/middle')
    await search.fill('完全没有匹配的分支'); await expect(rows).toHaveCount(0); await expect(picker.getByRole('status')).toContainText('无匹配项')
    await search.press('Enter'); expect(actions).toEqual([])
    await search.clear(); await expect(rows).toHaveCount(remoteInfos.length)
    for (let index = 1; index < remoteInfos.length; index++) await search.press('ArrowDown')
    await expect(rows.last()).toHaveAttribute('aria-selected', 'true')
    expect(await picker.getByRole('listbox').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await search.fill('张晴'); await expect(rows).toHaveCount(1)
    await search.clear(); await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
    await search.press('ArrowDown'); await search.press('Enter')
    await expect(picker).toHaveCount(0)
    await expectActions([{ op: 'pull-from', remote: 'origin', branch: 'team/middle' }])
    expect(metadataReads).toEqual([])
  })

  test('合并和变基共用带提交元信息的本地分支列表并发送正确目标', async () => {
    permittedActions = new Set(['merge', 'rebase'])
    const merge = await openPicker('分支', '合并分支…'), rows = merge.getByRole('option')
    await expect(rows).toHaveCount(localInfos.length - 1)
    await expect(rows.first()).toContainText('feature/zeta-recent')
    await expect(rows.first()).toContainText('张晴')
    await expect(rows.filter({ hasText: 'chore: 当前分支' })).toHaveCount(0)
    await merge.getByRole('combobox').press('ArrowDown'); await merge.getByRole('combobox').press('Enter')
    await expect(merge).toHaveCount(0); await expectActions([{ op: 'merge', ref: 'feature/team/middle' }])
    const rebase = await openPicker('分支', '变基到分支…')
    await rebase.getByRole('combobox').fill('c33ff03')
    await expect(rebase.getByRole('option')).toHaveCount(1)
    await expect(rebase.getByRole('option')).toContainText('feat: 最近的双行选择列表')
    await rebase.getByRole('combobox').press('Enter'); await expect(rebase).toHaveCount(0)
    await expectActions([{ op: 'merge', ref: 'feature/team/middle' }, { op: 'rebase', ref: 'feature/zeta-recent' }])
    expect(metadataReads).toEqual([])
  })

  test('旧引擎仅返回分支名时，从真实 Git 补齐远程和本地提交元信息及排序', async ({}, info) => {
    namesOnly = true
    await page.locator('html').evaluate(element => element.setAttribute('data-appearance', 'light'))
    const headBefore = fixtureGit(['rev-parse', 'HEAD'])
    for (const remote of [true, false]) {
      const picker = await openPicker(remote ? '拉取，推送' : '分支', remote ? '拉取自…' : '合并分支…')
      const rows = picker.getByRole('option'), prefix = remote ? 'origin/' : 'feature/'
      await expect(rows).toHaveCount(3)
      const ordered = ['zeta-recent', 'team/middle', 'alpha-older'].map(name => `${prefix}${name}`)
      await expect(rows.locator('.git-pickdlg__item-label')).toHaveText(ordered)
      for (const name of ordered) {
        const entry = realBranchInfos.get(name)!
        const row = rows.filter({ has: page.locator('.git-pickdlg__item-label', { hasText: name }) })
        await expect(row.locator('.git-pickdlg__item-hint')).toContainText(entry.hash)
        await expect(row.locator('.git-pickdlg__item-hint')).toContainText(/分钟前|小时前/)
        await expect(row.locator('.git-pickdlg__item-desc')).toContainText(entry.subject)
        await expect(row.locator('.git-pickdlg__item-desc')).toContainText(`@${entry.author}`)
      }
      const search = picker.getByRole('combobox')
      await search.fill('李明'); await expect(rows).toHaveCount(1); await expect(rows).toContainText(`${prefix}team/middle`)
      await search.fill(realBranchInfos.get(`${prefix}alpha-older`)!.hash)
      await expect(rows).toHaveCount(1); await expect(rows).toContainText('fix: 真仓库旧分支摘要')
      await search.clear()
      await screenshotDialog(info, picker, remote ? 'legacy-remote-metadata' : 'legacy-local-metadata')
      await closeDialog(picker)
    }
    expect(metadataReads.filter(read => read.refs === 'all')).toHaveLength(2)
    expect(metadataReads.filter(read => read.refs === 'all').every(read => read.limit === '500')).toBe(true)
    for (const ref of ['refs/remotes/origin/team/middle', 'refs/remotes/origin/alpha-older',
      'refs/heads/feature/team/middle', 'refs/heads/feature/alpha-older']) {
      expect(metadataReads).toContainEqual({ refs: ref, limit: '1' })
    }
    expect(metadataReads.some(read => read.refs.endsWith('/HEAD'))).toBe(false)
    expect(actions).toEqual([])
    expect(fixtureGit(['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(fixtureGit(['status', '--porcelain'])).toBe('')
  })

  test('补齐提交元信息期间工作区重新绑定，不发布旧分支数据或执行写入', async () => {
    namesOnly = true; changeBindingOnMetadata = true
    const picker = await openPicker('拉取，推送', '拉取自…')
    await expect(panel()).toContainText('任务 Git 工作区已重新绑定，请重新打开面板')
    await expect(picker.getByRole('option')).toHaveCount(0)
    await expect(picker.getByRole('status')).toHaveText('暂无可选项')
    expect(metadataReads).toContainEqual({ refs: 'all', limit: '500' })
    expect(metadataReads.some(read => read.refs.startsWith('refs/'))).toBe(false)
    expect(actions).toEqual([])
    await closeDialog(picker)
  })

  test('多远程选择支持 URL 搜索、清空和跨搜索全选，确认只推送所选远程', async () => {
    permittedActions.add('push-to')
    await menuAction('拉取，推送', '推送到多个远程…')
    const picker = dialog('推送到多个远程…'), search = picker.getByRole('textbox')
    await expect(picker).toBeVisible(); await expect(picker.getByRole('button', { name: '确定（0）', exact: true })).toBeDisabled()
    await picker.getByRole('button', { name: '全选', exact: true }).click()
    await expect(picker.getByRole('status')).toContainText('已选 4 / 4')
    await picker.getByRole('button', { name: '清空', exact: true }).click()
    await expect(picker.getByRole('checkbox', { name: 'origin', exact: true })).not.toBeChecked()
    await picker.getByRole('checkbox', { name: 'origin', exact: true }).check()
    await search.fill('mirror.invalid'); await expect(picker.getByRole('checkbox')).toHaveCount(2)
    await picker.getByRole('button', { name: '全选匹配项', exact: true }).click()
    await expect(picker.getByRole('status')).toContainText('已选 3 / 4')
    await search.clear(); await expect(picker.getByRole('checkbox', { name: 'origin', exact: true })).toBeChecked()
    await expect(picker.getByRole('checkbox', { name: 'backup', exact: true })).not.toBeChecked()
    expect(actions).toEqual([])
    await picker.getByRole('button', { name: '确定（3）', exact: true }).click()
    const result = dialog('多远程推送完成'); await expect(result).toBeVisible()
    await expectActions(['origin', 'mirror-a', 'mirror-b'].map(remote => ({ op: 'push-to', remote, branch: 'dev' })))
    await expect(result).toContainText('origin'); await expect(result).toContainText('mirror-a'); await expect(result).toContainText('mirror-b')
    await closeDialog(result)
  })

  test('新建分支空值留在输入弹窗，填写后取消不创建或切换分支', async () => {
    await menuAction('分支', '新建分支…')
    const prompt = dialog('新建分支'), input = prompt.getByRole('textbox')
    await expect(prompt).toBeVisible(); await expect(input).toBeFocused()
    await input.press('Enter'); await expect(prompt).toContainText('内容不能为空'); expect(actions).toEqual([])
    await input.fill('feature/cancel-dialog')
    await prompt.getByRole('button', { name: '取消', exact: true }).click(); await expect(prompt).toHaveCount(0)
    expect(actions).toEqual([])
  })

  test('添加远程的连续输入保留第二步，取消无写入，确认传递完整名称和 URL', async () => {
    permittedActions.add('add-remote')
    await menuAction('远程', '添加远程仓库…')
    let prompt = dialog('添加远程仓库')
    await prompt.getByRole('textbox').fill('cancelled-remote'); await prompt.getByRole('textbox').press('Enter')
    await expect(prompt.getByLabel('仓库 URL', { exact: true })).toBeVisible()
    await prompt.getByRole('button', { name: '取消', exact: true }).click(); await expect(prompt).toHaveCount(0)
    expect(actions).toEqual([])
    await menuAction('远程', '添加远程仓库…'); prompt = dialog('添加远程仓库')
    await prompt.getByRole('textbox').fill('review'); await prompt.getByRole('textbox').press('Enter')
    const url = prompt.getByLabel('仓库 URL', { exact: true })
    await expect(url).toBeVisible(); await url.fill('ssh://git@review.invalid/team/project.git'); await url.press('Enter')
    await expect(prompt).toHaveCount(0)
    await expectActions([{ op: 'add-remote', name: 'review', url: 'ssh://git@review.invalid/team/project.git' }])
  })

  test('删除分支、改写提交与强推确认取消后不产生 Git 写入', async () => {
    for (const remote of [false, true]) {
      const label = remote ? '删除远程分支…' : '删除分支…', target = remote ? 'origin/team/middle' : 'feature/team/middle'
      const picker = await openPicker('分支', label)
      await picker.getByRole('combobox').fill(target); await expect(picker.getByRole('option')).toHaveCount(1)
      await picker.getByRole('combobox').press('Enter')
      const confirmation = dialog(remote ? '删除远程分支' : '删除分支')
      await expect(confirmation).toBeVisible(); await expect(confirmation).toContainText(target)
      await expect(confirmation.getByRole('button', { name: '删除', exact: true })).toHaveClass(/btn--danger/)
      expect(actions).toEqual([])
      await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await expect(confirmation).toHaveCount(0)
      expect(actions).toEqual([])
    }
    for (const action of [
      { group: '提交', label: '修补上次提交（amend）', title: '修补上次提交（amend）' },
      { group: '提交', label: '撤销上次提交', title: '撤销上次提交' },
      { group: '拉取，推送', label: '强制推送（force-with-lease）', title: '强制推送' }
    ]) {
      await menuAction(action.group, action.label)
      const confirmation = dialog(action.title)
      await expect(confirmation).toBeVisible(); expect(actions).toEqual([])
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await expect(confirmation).toHaveCount(0); expect(actions).toEqual([])
    }
  })

  test('深浅色宽窄窗口中的分支、提交与存储详情保持完整内容和可见操作', async ({}, info) => {
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(appearance === 'light' ? 1440 : 560)
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), appearance)
      const picker = await openPicker('拉取，推送', '拉取自…')
      await expect(picker.getByRole('option').first()).toContainText('张晴')
      const focusStyle = await picker.getByRole('combobox').evaluate(element => ({
        outline: getComputedStyle(element).outlineStyle, shadow: getComputedStyle(element).boxShadow
      }))
      expect(focusStyle.outline).toBe('none'); expect(focusStyle.shadow).toBe('none')
      await screenshotDialog(info, picker, `git-picker-${appearance}`); await closeDialog(picker)
      const history = panel().getByRole('button', { name: '提交历史', exact: true })
      if (await history.getAttribute('aria-expanded') !== 'true') await history.click()
      const row = panel().locator('.git-panel__commit-row').filter({ hasText: commits[0].subject })
      await expect(row).toBeVisible(); await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '查看提交详情', exact: true }).click()
      const commit = dialog(`提交 ${detail.shortHash}`)
      await expect(commit).toBeVisible(); await expect(commit).toContainText(detail.body)
      await expect(commit.locator('.git-commitdlg__file-name').first()).toHaveAttribute('title', longPath)
      await commit.getByTitle('复制完整哈希', { exact: true }).click()
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(detail.hash)
      await screenshotDialog(info, commit, `git-commit-detail-${appearance}`); await closeDialog(commit)
      await menuAction('存储', '查看存储详情…')
      const stashPicker = dialog('查看存储详情…')
      await expect(stashPicker.getByRole('option')).toContainText('需要核对完整目录的界面修改')
      await stashPicker.getByRole('combobox').press('Enter')
      const stash = dialog('存储 0 详情')
      await expect(stash).toBeVisible(); await expect(stash).toContainText(longPath)
      await expect(stash.getByRole('button', { name: '恢复改动（保留存储）', exact: true })).toBeVisible()
      await expect(stash.getByRole('button', { name: '恢复改动并删除存储', exact: true })).toBeVisible()
      await screenshotDialog(info, stash, `git-stash-detail-${appearance}`); await closeDialog(stash)
    }
    expect(actions).toEqual([])
  })
})
