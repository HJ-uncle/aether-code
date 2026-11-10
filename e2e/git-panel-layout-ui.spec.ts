/** Real Electron Work Git + authenticated HTTP fixtures. Covers compact clean
 * and changed layouts, 50 history records, four stashes, keyboard disclosure,
 * focus/hover actions, commit input alignment, branch menu placement and
 * cancelled deletion confirmation in both themes. Input focus coverage checks
 * the actual Git picker, standalone fields, Work composer and command palette.
 * No user's repository is accessed. Build first; workers must remain one. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { GitFileChange, GitLogEntry, GitStashEntry } from '../src/shared/git-types'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'git-layout-token', model = 'git-layout-model', sessionId = 'work-git-layout'
const workspace = '/remote/git-layout', epoch = 'git-layout-binding', title = 'Git 面板布局验收'
const now = Date.now(), errors: string[] = [], actions: Record<string, unknown>[] = [], reads: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', hasChanges = true
let manyChanges = false, complexHistory = false, paginationGate: Promise<void> | undefined, releasePagination: (() => void) | undefined
const files: GitFileChange[] = [
  { path: 'src/已暂存的工作区布局.tsx', changeType: 'modified', staged: true, stagedChange: 'modified', unstagedChange: null,
    binary: false, additions: 3, deletions: 1, stagedAdditions: 3, stagedDeletions: 1 },
  { path: 'docs/需要完整显示的界面验收说明.md', changeType: 'modified', staged: false, stagedChange: null, unstagedChange: 'modified',
    binary: false, additions: 5, deletions: 2, unstagedAdditions: 5, unstagedDeletions: 2 }
]
const longChanges: GitFileChange[] = Array.from({ length: 48 }, (_, index) => ({ ...files[1], path: `docs/布局说明-${String(index + 1).padStart(2, '0')}.md` }))
const commits: GitLogEntry[] = Array.from({ length: 50 }, (_, index) => ({
  hash: (index + 1).toString(16).padStart(40, 'a'), shortHash: (index + 1).toString(16).padStart(7, 'a'),
  subject: `${index === 0 ? 'feat: 完整保留提交说明与长文件路径的布局验证' : `chore: 历史提交 ${index + 1}`}`,
  author: index % 2 ? '审阅者' : 'Fixture User', date: new Date(now - index * 60_000).toISOString(),
  parents: index < 49 ? [(index + 2).toString(16).padStart(40, 'a')] : [],
  refs: index === 0 ? [{ name: 'dev', type: 'head' }] : [], fileChanges: [{ code: 'M', path: files[0].path }]
}))
const complexHash = (index: number): string => (index + 1).toString(16).padStart(40, '0')
const complexCommits: GitLogEntry[] = Array.from({ length: 450 }, (_, index) => ({
  hash: complexHash(index), shortHash: complexHash(index).slice(-7),
  subject: index === 8 ? 'merge: 多轨道仍保留提交摘要和完整文件路径' : `chore: 多轨道提交 ${index + 1}`,
  author: '负责提交布局验收的长名称作者', date: new Date(now - index * 60_000).toISOString(),
  // The first rows have one lane, then 64 branches fan out and merge at row 85.
  // Subsequent single-lane rows expose blanket max-width graph alignment.
  parents: index === 8 ? [complexHash(9), ...Array.from({ length: 64 }, (_, lane) => complexHash(20 + lane))]
    : index >= 19 && index < 84 ? [complexHash(84)]
      : index < 449 ? [complexHash(index + 1)] : [],
  refs: index === 0 ? [{ name: 'dev', type: 'head' }] : [], fileChanges: [{ code: 'M', path: files[0].path }]
}))
const stashes: GitStashEntry[] = Array.from({ length: 4 }, (_, index) => ({
  index, hash: (index + 1).toString(16).padStart(40, 'b'),
  message: `On dev: ${index === 0 ? '存储说明较长时仍可打开完整详情并使用独立操作按钮' : `待处理布局调整 ${index + 1}`}`,
  date: new Date(now - index * 3_600_000).toISOString()
}))
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks), parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  if (path === '/api/v1/git/action') {
    actions.push(input)
    throw new Error(`Layout navigation or cancelled confirmation submitted a Git write: ${JSON.stringify(input)}`)
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
    if (op === 'log' && Number(url.searchParams.get('skip') ?? 0) > 0 && paginationGate) await paginationGate
    const history = complexHistory ? complexCommits : commits
    const data = op === 'binding' ? { root: workspace, epoch, contractVersion: 2, mutationRequiresBinding: true }
      : op === 'lease' ? { success: true, lease: { busy: false, recoverable: false } }
      : op === 'status' ? { success: true, isRepo: true, files: hasChanges ? [...files, ...(manyChanges ? longChanges : [])] : [] }
      : op === 'branch-info' ? { success: true, isRepo: true, info: { branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 0 } }
      : op === 'list-stashes' ? { success: true, stashes }
      : op === 'list-remotes' ? { success: true, remotes: [{ name: 'origin', url: 'https://example.invalid/fixture.git' }] }
      : op === 'list-branches' ? { success: true, branches: ['dev', 'feature/很长的分支名称用于确认完整内容与弹窗边界'], current: 'dev' }
      : op === 'list-remote-branches' ? { success: true, branches: ['origin/dev'] }
      : op === 'log' ? { success: true, commits: history.slice(Number(url.searchParams.get('skip') ?? 0), Number(url.searchParams.get('skip') ?? 0) + Number(url.searchParams.get('limit') ?? 50)) }
      : op === 'incoming' ? { success: true, commits: [] }
      : op === 'user-name' ? { success: true, name: 'Fixture User' }
      : op === 'list-authors' ? { success: true, authors: ['Fixture User', '审阅者'] }
      : op === 'list-tags' ? { success: true, tags: [] }
      : op === 'stash-show-files' ? { success: true, content: `${files[0].path}\n${files[1].path}` }
      : op === 'stash-show' ? { success: true, content: 'diff --git a/layout.ts b/layout.ts\n+fixture layout' }
      : op === 'commit-show' ? { success: true, commit: history.find(commit => commit.hash === url.searchParams.get('hash')) }
      : undefined
    if (data === undefined) throw new Error(`Unexpected Git read: ${op}`)
    response.end(envelope(data)); return
  }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: input.workspaceRoot })); return }
  if (path === '/api/v1/chat/admission/receipt') { response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'git-layout' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: 'Git 布局测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'git-layout-tenant', sessionId: id, namespace: { id: 'git-layout-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
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
const group = (name: string): Locator => panel().getByRole('button', { name, exact: true })
async function setExpanded(name: string, expanded: boolean): Promise<void> {
  const button = group(name)
  if ((await button.getAttribute('aria-expanded')) !== String(expanded)) await button.click()
  await expect(button).toHaveAttribute('aria-expanded', String(expanded))
}
async function settle(target: Locator = panel()): Promise<void> {
  await target.evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => undefined)))
  })
}
async function setWindow(width: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  const workspaceTab = page.locator('.work-mobile-tabs').getByRole('button', { name: '工作区', exact: true })
  if (await workspaceTab.isVisible()) await workspaceTab.click()
  await expect(panel()).toBeVisible(); await settle()
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}
async function screenshot(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}
async function expectFieldRing(owner: Locator): Promise<void> {
  await settle(owner)
  await expect(owner).not.toHaveCSS('box-shadow', 'none')
  await expect(owner).toHaveCSS('outline-style', 'none')
  const borders = await owner.evaluate(element => {
    const style = getComputedStyle(element)
    return ['top', 'right', 'bottom', 'left'].map(side => ({
      width: Number.parseFloat(style.getPropertyValue(`border-${side}-width`)),
      style: style.getPropertyValue(`border-${side}-style`),
      color: style.getPropertyValue(`border-${side}-color`)
    }))
  })
  expect(new Set(borders.map(border => border.color)).size, 'The focus border must be one continuous color').toBe(1)
  for (const border of borders) {
    expect(border.style).toBe('solid')
    expect(border.width).toBeGreaterThan(0)
    expect(border.width).toBeLessThanOrEqual(2)
  }
}
async function expectUnframedInput(input: Locator): Promise<void> {
  await expect(input).toBeFocused()
  await expect(input).toHaveCSS('box-shadow', 'none')
  await expect(input).toHaveCSS('outline-style', 'none')
  for (const side of ['top', 'right', 'bottom', 'left']) await expect(input).toHaveCSS(`border-${side}-width`, '0px')
}
async function openPullFromPicker(): Promise<Locator> {
  await panel().locator('.git-panel__toolbar').getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '拉取，推送', exact: true }).hover()
  await page.getByRole('menuitem', { name: '拉取自…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '拉取自…', exact: true })
  await expect(dialog).toBeVisible(); await settle(dialog)
  return dialog
}

test.describe.serial('Git 面板紧凑布局', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'git-layout-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'dark', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(1440, 900); window.show(); window.focus(); window.setIgnoreMouseEvents(true) })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => {
    releasePagination?.(); paginationGate = undefined; releasePagination = undefined
    hasChanges = true; manyChanges = false; complexHistory = false; actions.length = 0
    await page.evaluate(({ key, sessionId, title, workspace, model, now }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', mentions: [], createdAt: now, updatedAt: now, workspacePath: workspace, modelId: model, attachments: [], sources: [] }], activeTaskId: sessionId, homeSources: [] }))
      localStorage.setItem('aether.app.mode', 'work'); localStorage.setItem('aether:git:autoFetch:enabled', '0')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: true, workspace: true, tab: 'git', pane: 'workspace', ratio: 35 }))
    }, { key: storageKey, sessionId, title, workspace, model, now })
    await page.reload(); await setWindow(1440)
    await expect(panel()).toContainText('已暂存的工作区布局.tsx')
    await expect(panel()).toContainText('需要完整显示的界面验收说明.md')
    await expect(group('存储').locator('.git-panel__count')).toHaveText('4')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await screenshot(info, 'git-layout-failure')
    await info.attach('git-layout-http', { body: JSON.stringify({ errors, actions, reads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(actions).toEqual([])
  })
  test.afterAll(async () => {
    releasePagination?.()
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('git-layout-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('深浅主题宽窄面板的空闲提交区与折叠分组紧凑且不溢出', async ({}, info) => {
    await setExpanded('提交历史', true)
    await expect(group('提交历史').locator('.git-panel__count')).toHaveText('50')
    await setExpanded('提交历史', false)
    // Simulate an external clean status and use the real refresh action.
    hasChanges = false
    await panel().locator('.git-panel__toolbar').getByRole('button', { name: '刷新', exact: true }).click()
    await expect(group('暂存的更改')).toHaveCount(0); await expect(group('更改')).toHaveCount(0)
    await expect(panel().getByRole('button', { name: '提交', exact: true })).toBeDisabled()
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440); await setAppearance(appearance)
      for (const width of [1440, 960, 560]) {
        await setWindow(width)
        const geometry = await panel().evaluate(element => {
          const box = element.getBoundingClientRect()
          const rect = (selector: string): DOMRect => element.querySelector(selector)!.getBoundingClientRect()
          const sections = [...element.querySelectorAll('.git-panel__section')].map(section => {
            const bounds = section.getBoundingClientRect(), head = section.querySelector('.git-panel__group-head')!.getBoundingClientRect()
            return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, headHeight: head.height }
          })
          return { overflow: element.scrollWidth - element.clientWidth, toolbar: rect('.git-panel__toolbar').height, sections,
            repository: (() => {
              const header = element.querySelector('.git-panel__repository-header')!, branch = element.querySelector('.git-branchbar')!, commit = element.querySelector('.git-commitbar')!
              return { containsBranch: header.contains(branch), containsCommit: header.contains(commit),
                branchBottom: branch.getBoundingClientRect().bottom, headerBottom: header.getBoundingClientRect().bottom, commitTop: commit.getBoundingClientRect().top }
            })(),
            controls: [...element.querySelectorAll('.git-panel__toolbar button, .git-branchbar button, .git-commitbar button, .git-commitbar textarea')].map(control => {
              const bounds = control.getBoundingClientRect(); return { left: bounds.left - box.left, right: bounds.right - box.right, width: bounds.width, height: bounds.height }
            }) }
        })
        expect(geometry.overflow).toBeLessThanOrEqual(1); expect(geometry.toolbar).toBeLessThanOrEqual(50)
        expect(geometry.repository.containsBranch).toBe(true); expect(geometry.repository.containsCommit).toBe(false)
        expect(geometry.repository.branchBottom).toBeLessThanOrEqual(geometry.repository.headerBottom + 1)
        expect(geometry.repository.headerBottom).toBeLessThanOrEqual(geometry.repository.commitTop + 1)
        expect(geometry.sections).toHaveLength(2)
        for (const section of geometry.sections) { expect(section.height).toBeLessThanOrEqual(52); expect(section.headHeight).toBeGreaterThanOrEqual(28) }
        expect(geometry.sections[1].top - geometry.sections[0].bottom).toBeLessThanOrEqual(12)
        for (const control of geometry.controls) { expect(control.left).toBeGreaterThanOrEqual(-1); expect(control.right).toBeLessThanOrEqual(1); expect(control.width).toBeGreaterThan(0); expect(control.height).toBeGreaterThanOrEqual(24) }
        await screenshot(info, `git-collapsed-${appearance}-${width}`)
      }
    }
  })

  test('分组可通过键盘展开收起，刷新按钮不会触发分组切换', async () => {
    const history = group('提交历史')
    await history.focus(); await page.keyboard.press('Enter')
    await expect(history).toHaveAttribute('aria-expanded', 'true')
    await expect(panel().locator('.git-panel__commit-subject').first()).toHaveText(commits[0].subject)
    await history.focus(); await page.keyboard.press('Space')
    await expect(history).toHaveAttribute('aria-expanded', 'false')
    const historyReads = reads.filter(read => read === `${sessionId}:log`).length
    await panel().getByRole('button', { name: '刷新历史', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => reads.filter(read => read === `${sessionId}:log`).length).toBeGreaterThan(historyReads)
    await expect(history).toHaveAttribute('aria-expanded', 'false')
    await setExpanded('存储', true)
    await expect(panel().locator('.git-panel__stash-row')).toHaveCount(4)
    await group('存储').focus(); await page.keyboard.press('Space')
    await expect(group('存储')).toHaveAttribute('aria-expanded', 'false')
    await expect(panel().locator('.git-panel__stash-row')).toHaveCount(0)
  })

  test('提交输入框单行居中、多行保持内嵌 AI 按钮的右下间距', async ({}, info) => {
    const input = panel().getByRole('textbox', { name: '提交信息', exact: true })
    const measure = () => panel().locator('.git-commitbar__input-wrap').evaluate(element => {
      const input = element.querySelector('textarea')!.getBoundingClientRect()
      const button = element.querySelector('.git-commitbar__ai')!.getBoundingClientRect()
      return { height: input.height, centerOffset: Math.abs(input.top + input.height / 2 - button.top - button.height / 2),
        rightInset: input.right - button.right, bottomInset: input.bottom - button.bottom }
    })
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440); await setAppearance(appearance)
      for (const width of [1440, 560]) {
        await setWindow(width)
        await input.fill('fix: 布局'); await settle()
        const single = await measure()
        expect(single.centerOffset, `${appearance}/${width}: AI button must be centered within a single line`).toBeLessThanOrEqual(1.5)
        await input.fill('fix: 布局\n\n统一控件间距\n保留完整说明'); await settle()
        const multiline = await measure()
        expect(multiline.height).toBeGreaterThan(single.height + 20)
        expect(Math.abs(multiline.rightInset - 4)).toBeLessThanOrEqual(1)
        expect(Math.abs(multiline.bottomInset - 4)).toBeLessThanOrEqual(1)
        await screenshot(info, `git-commit-input-${appearance}-${width}`)
        await input.clear(); await expect(input).toHaveValue(''); await settle()
      }
    }
  })

  test('输入焦点：Git 搜索弹窗在深浅主题和鼠标键盘下只有完整外圈', async ({}, info) => {
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      for (const method of ['mouse', 'keyboard'] as const) {
        const dialog = await openPullFromPicker()
        const input = dialog.locator('.git-pickdlg__input'), owner = dialog.locator('.git-pickdlg__search')
        // Move off the autofocus target first, then enter through the actual
        // pointer/Tab path so both focus-visible modalities are exercised.
        await dialog.getByRole('button', { name: '关闭', exact: true }).focus()
        if (method === 'mouse') await input.click()
        else await page.keyboard.press('Tab')
        await expectUnframedInput(input); await expectFieldRing(owner)
        const geometry = await owner.evaluate(element => {
          const outer = element.getBoundingClientRect(), inner = element.querySelector('input')!.getBoundingClientRect()
          return { leadingInset: inner.left - outer.left, trailingInset: outer.right - inner.right }
        })
        expect(geometry.leadingInset, 'The shared border includes the leading search icon').toBeGreaterThan(16)
        expect(geometry.trailingInset).toBeGreaterThan(0)
        await input.fill('no-such-branch')
        await expect(dialog.locator('.git-pickdlg__item')).toHaveCount(0)
        await expect(dialog.locator('.git-pickdlg__empty')).toHaveText('无匹配项')
        await input.fill('origin/dev')
        await expect(dialog.locator('.git-pickdlg__item')).toHaveCount(1)
        await expect(dialog.locator('.git-pickdlg__item')).toContainText('origin/dev')
        await expectUnframedInput(input); await expectFieldRing(owner)
        await screenshot(info, `input-focus-picker-${appearance}-${method}`)
        // Selection would pull from a remote. Cancel every inspection instead.
        await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
        expect(actions).toEqual([])
      }
    }
  })

  test('输入焦点：提交与历史搜索保留单控件焦点圈及正常编辑', async ({}, info) => {
    await setExpanded('提交历史', true)
    const fields = [
      { input: panel().getByRole('textbox', { name: '提交信息', exact: true }), owner: panel().locator('.git-commitbar__input-wrap'), text: 'fix: 焦点样式' },
      { input: panel().getByPlaceholder('搜索提交信息…', { exact: true }), owner: panel().locator('.git-panel__history-search'), text: '布局' }
    ]
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      for (const { input, owner, text } of fields) {
        await input.click(); await input.fill(text)
        await expect(input).toHaveValue(text); await expect(input).toBeFocused()
        await expectFieldRing(input)
        await expect(owner).toHaveCSS('box-shadow', 'none')
        await expect(owner).toHaveCSS('outline-style', 'none')
        await page.keyboard.press('Tab'); await expect(input).not.toBeFocused()
        await page.keyboard.press('Shift+Tab'); await expect(input).toBeFocused()
        await expectFieldRing(input)
        await input.clear(); await expect(input).toHaveValue('')
      }
      await screenshot(info, `input-focus-standalone-${appearance}`)
    }
    expect(actions).toEqual([])
  })

  test('输入焦点：对话编辑区不重复描边，命令搜索焦点不被浮层裁掉', async ({}, info) => {
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      const conversationTab = page.locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
      if (await conversationTab.isVisible()) await conversationTab.click()
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.click(); await input.fill('尚未发送的焦点检查草稿')
      await expect(input).toHaveText('尚未发送的焦点检查草稿')
      await expectUnframedInput(input)
      await screenshot(info, `input-focus-composer-${appearance}`)
      await input.clear()
      await page.keyboard.press('Control+Shift+P')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      const filter = palette.getByRole('textbox', { name: '过滤命令', exact: true })
      await expect(filter).toBeFocused()
      await filter.fill('命令面板'); await expect(filter).toHaveValue('命令面板')
      await settle(palette)
      await expect(filter).toHaveCSS('outline-style', 'none')
      await expect(filter).toHaveCSS('box-shadow', /inset/)
      await screenshot(info, `input-focus-palette-${appearance}`)
      await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0)
    }
  })

  test('输入焦点：深浅主题样式矩阵保持单圈、禁用错误与编辑器代理边界', async ({}, info) => {
    // These are cascade contracts against the CSS already loaded by Electron.
    // No stylesheet or inline style is injected; the navigation tests above
    // separately verify that real components produce the expected structure.
    const samples: Array<{ name: string; html: string; borderless?: boolean; invalid?: boolean; innerButton?: boolean }> = [
      { name: 'automation-search', html: '<div class="automations-search ui-input-shell ui-input-shell--compact" data-focus-owner><span>搜索</span><input class="ui-input-field" data-focus-field></div>' },
      { name: 'automation-name', html: '<label class="automation-field"><span>名称</span><input class="ui-input" data-focus-field></label>' },
      { name: 'automation-prompt-invalid', invalid: true, html: '<label class="automation-field"><span>指令</span><textarea class="ui-input" data-focus-field aria-invalid="true"></textarea></label>' },
      { name: 'settings-search', innerButton: true, html: '<div class="app-settings__search-wrap ui-input-shell ui-input-shell--compact" data-focus-owner><input class="app-settings__search ui-input-field" data-focus-field><button type="button" data-inner-button>清除</button></div>' },
      { name: 'settings-field', html: '<label class="sg__row"><span>设置项</span><input class="sg__input" data-focus-field></label>' },
      { name: 'model-api-key', html: '<label class="sg__row"><span>API Key</span><input type="password" class="field__input sg__input sg__input--wide" data-focus-field></label>' },
      { name: 'model-context-window', html: '<div class="context-window-input"><input class="field__input context-window-input__value" data-focus-field></div>' },
      { name: 'accent-hex', html: '<div class="accent-color-picker"><label class="accent-color-picker__hex-field ui-input-shell ui-input-shell--compact" data-focus-owner><span>HEX</span><input class="ui-input-field" data-focus-field></label></div>' },
      { name: 'accent-channel-invalid', invalid: true, html: '<div class="accent-color-picker"><label class="accent-color-picker__channel ui-input-shell ui-input-shell--compact" data-focus-owner><span>R</span><input class="ui-input-field" type="number" data-focus-field aria-invalid="true"></label></div>' },
      { name: 'editor-outline', html: '<div class="editor-outline"><input class="editor-outline__filter ui-input ui-input--compact" data-focus-field></div>' },
      { name: 'editor-settings', html: '<div class="editor-settings"><label class="editor-settings__field"><input class="ui-input ui-input--compact" type="number" data-focus-field></label></div>' },
      { name: 'editor-path', html: '<div class="editor-path-picker"><input class="ui-input ui-input--compact" data-focus-field></div>' },
      { name: 'browser-address', html: '<div class="browser-view"><input class="field__input browser-address" data-focus-field></div>' },
      { name: 'work-browser-address', html: '<div class="browser-view" data-browser-surface-mode="work"><input class="field__input browser-address" data-focus-field></div>' },
      { name: 'browser-display', html: '<div class="work-browser-display__popover"><div class="work-browser-display__dimensions"><input class="ui-input ui-input--compact" type="number" data-focus-field></div></div>' },
      { name: 'document-page', html: '<div class="document-preview__toolbar"><input type="number" data-focus-field></div>' },
      { name: 'mention-search', html: '<div class="mention-ref-picker"><input class="mention-ref-picker__search ui-input ui-input--compact" data-focus-field></div>' },
      { name: 'artifacts-search', html: '<div class="work-session-artifacts"><div class="work-session-artifacts__search"><input class="ui-input ui-input--compact" data-focus-field></div></div>' },
      { name: 'work-search', html: '<div class="work-search ui-input-shell ui-input-shell--compact" data-focus-owner><input class="ui-input-field" data-focus-field></div>' },
      { name: 'workspace-filter', innerButton: true, html: '<div class="work-workspace-panel__filter-wrap ui-input-shell ui-input-shell--compact" data-focus-owner><input class="ui-input-field" data-focus-field><button type="button" data-inner-button>清除</button></div>' },
      { name: 'workspace-search', innerButton: true, html: '<div class="work-workspace-panel"><div class="search-view__field ui-input-shell ui-input-shell--compact" data-focus-owner><input class="search-view__input ui-input-field" data-focus-field><button class="search-view__btn" type="button" data-inner-button>正则</button></div></div>' },
      { name: 'workspace-search-filter', html: '<div class="work-workspace-panel"><input class="search-view__filter-input ui-input ui-input--compact" data-focus-field></div>' },
      { name: 'subagent-composer', innerButton: true, html: '<div class="work-subagents"><form class="work-subagents__composer"><div class="work-subagents__composer-editor ui-input-shell ui-input-shell--multiline" data-focus-owner><textarea class="ui-input-field" data-focus-field></textarea><button type="button" data-inner-button>发送</button></div></form></div>' },
      { name: 'subagent-followup', html: '<form class="subagent-followup__form"><textarea class="ui-input" data-focus-field></textarea></form>' },
      { name: 'subagent-search', html: '<div class="work-subagents"><label class="work-subagents__search"><input class="ui-input ui-input--compact" data-focus-field></label></div>' },
      { name: 'chat-composer', innerButton: true, html: '<div class="chat__surface input-composer ui-input-shell ui-input-shell--multiline" data-focus-owner><div class="input-composer__input ui-input-field" contenteditable="true" role="textbox" data-focus-field></div><button type="button" data-inner-button>附件</button></div>' },
      { name: 'git-picker', innerButton: true, html: '<div class="git-pickdlg"><div class="git-pickdlg__search ui-input-shell" data-focus-owner><input class="git-pickdlg__input ui-input-field" data-focus-field><button class="git-pickdlg__clear" type="button" data-inner-button>清除</button></div></div>' }
    ]
    const observations: Array<Record<string, unknown>> = []
    const mount = async (html: string): Promise<Locator> => {
      await page.evaluate(html => {
        document.querySelector('[data-input-focus-matrix]')?.remove()
        const fixture = document.createElement('div')
        fixture.className = 'modal-overlay'
        fixture.setAttribute('data-input-focus-matrix', '')
        fixture.innerHTML = `<section class="modal"><div class="modal__body"><button type="button" data-focus-start>聚焦起点</button>${html}</div></section>`
        document.body.append(fixture)
      }, html)
      return page.locator('[data-input-focus-matrix]')
    }
    const readMaterial = (owner: Locator) => owner.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, radius: style.borderRadius, border: style.borderTopColor, fontSize: style.fontSize,
        unified: element.matches('.ui-input, .ui-input-shell, .field__input, .sg__input'),
        compact: element.matches('.ui-input--compact, .ui-input-shell--compact') }
    })
    try {
      for (const appearance of ['light', 'dark'] as const) {
        await setAppearance(appearance)
        // Compare real control families against the shared field, rather than
        // hard-coding token values that could let a disconnected theme pass.
        await page.mouse.move(0, 0)
        const reference = await mount('<input class="field__input" data-focus-field>')
        const material = await readMaterial(reference.locator('[data-focus-field]'))
        observations.push({ appearance, name: 'shared-field-reference', material })
        await reference.evaluate(element => element.remove())
        for (const sample of samples) await test.step(`${appearance}/${sample.name}`, async () => {
          const fixture = await mount(sample.html), input = fixture.locator('[data-focus-field]')
          const outer = fixture.locator('[data-focus-owner]'), compound = await outer.count() > 0
          const owner = compound ? outer : input
          const before = await owner.evaluate(element => ({ shadow: getComputedStyle(element).boxShadow, border: getComputedStyle(element).borderTopColor }))
          const actualMaterial = await readMaterial(owner)
          if (actualMaterial.unified && !sample.invalid) {
            expect(actualMaterial.background, `${sample.name} uses the shared input surface`).toBe(material.background)
            expect(actualMaterial.radius, `${sample.name} uses the shared corner radius`).toBe(material.radius)
            expect(actualMaterial.border, `${sample.name} uses the shared resting border`).toBe(material.border)
            if (!actualMaterial.compact) expect(actualMaterial.fontSize, `${sample.name} uses the shared input type size`).toBe(material.fontSize)
          }
          await fixture.locator('[data-focus-start]').focus(); await page.keyboard.press('Tab')
          await expect(input).toBeFocused(); await settle(owner)
          if (sample.borderless) {
            await expect(owner).not.toHaveCSS('box-shadow', 'none')
            await expect(owner).toHaveCSS('outline-style', 'none')
          } else await expectFieldRing(owner)
          if (compound) await expectUnframedInput(input)
          const focused = await owner.evaluate(element => ({ shadow: getComputedStyle(element).boxShadow, border: getComputedStyle(element).borderTopColor }))
          expect(focused.shadow, 'Focusing the field must activate its own ring').not.toBe(before.shadow)
          if (sample.invalid) expect(focused.border, 'Focusing must retain the invalid field border').toBe(before.border)
          observations.push({ appearance, name: sample.name, compound, before, focused, material: actualMaterial })
          if (sample.innerButton) {
            await page.keyboard.press('Tab')
            const button = fixture.locator('[data-inner-button]')
            await expect(button).toBeFocused(); await settle(owner)
            await expect(button).not.toHaveCSS('box-shadow', 'none')
            await expect(owner).toHaveCSS('box-shadow', before.shadow)
            await expect(input).toHaveCSS('box-shadow', 'none')
          }
          await fixture.evaluate(element => element.remove())
        })

        await test.step(`${appearance}/disabled-fields`, async () => {
          const fixture = await mount('<label class="automation-field"><input class="ui-input" data-focus-field disabled></label><div class="app-settings__search-wrap ui-input-shell ui-input-shell--compact" data-focus-owner><input class="app-settings__search ui-input-field" data-focus-field disabled></div>')
          await fixture.locator('[data-focus-start]').focus()
          for (const input of await fixture.locator('[data-focus-field]').all()) {
            await expect(input).toBeDisabled()
            await input.evaluate(element => (element as HTMLInputElement).focus())
            await expect(input).not.toBeFocused()
            await expect(input).toHaveCSS('box-shadow', 'none')
          }
          await expect(fixture.locator('[data-focus-owner]')).toHaveCSS('box-shadow', 'none')
          await fixture.evaluate(element => element.remove())
        })

        await test.step(`${appearance}/range-keeps-slider-geometry`, async () => {
          const fixture = await mount('<div class="accent-color-picker"><input type="range" min="0" max="360" value="180" class="accent-color-picker__hue" data-focus-field></div>')
          const input = fixture.locator('[data-focus-field]')
          await fixture.locator('[data-focus-start]').focus(); await page.keyboard.press('Tab')
          await expect(input).toBeFocused()
          const slider = await input.evaluate(element => {
            const style = getComputedStyle(element)
            return { height: element.getBoundingClientRect().height, minimum: Number.parseFloat(style.minHeight), background: style.backgroundImage }
          })
          expect(slider.height).toBeGreaterThan(0); expect(slider.height).toBeLessThanOrEqual(16)
          expect(slider.minimum).toBe(0); expect(slider.background).not.toBe('none')
          await expect(input).toHaveCSS('border-top-width', '0px')
          await expect(input).toHaveCSS('outline-style', 'none')
          await expect(input).not.toHaveCSS('box-shadow', 'none')
          await page.keyboard.press('ArrowRight'); await expect(input).toHaveValue('181')
          observations.push({ appearance, name: 'range', ...slider })
          await fixture.evaluate(element => element.remove())
        })

        for (const proxy of [
          { name: 'monaco-proxy', html: '<div class="monaco-editor"><textarea class="inputarea" data-focus-field></textarea></div>' },
          { name: 'monaco-find-input', html: '<div class="monaco-editor"><input class="input" data-focus-field></div>' },
          { name: 'xterm-proxy', html: '<div class="xterm"><textarea class="xterm-helper-textarea" data-focus-field></textarea></div>' }
        ]) await test.step(`${appearance}/${proxy.name}`, async () => {
          const fixture = await mount(proxy.html), input = fixture.locator('[data-focus-field]')
          // Editor input proxies are intentionally hidden or outside Tab order.
          await input.evaluate(element => (element as HTMLInputElement | HTMLTextAreaElement).focus())
          await expect(input).toBeFocused()
          await expect(input).toHaveCSS('box-shadow', 'none')
          const minimum = await input.evaluate(element => Number.parseFloat(getComputedStyle(element).minHeight))
          expect(minimum, 'Library inputs must not inherit the form control minimum height').toBe(0)
          observations.push({ appearance, name: proxy.name, minimum })
          await fixture.evaluate(element => element.remove())
        })
      }
    } catch (error) {
      await screenshot(info, 'input-focus-matrix-failure')
      throw error
    } finally {
      await info.attach('input-focus-cascade-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
      await page.locator('[data-input-focus-matrix]').evaluateAll(elements => elements.forEach(element => element.remove()))
    }
  })

  test('键盘打开分支远程菜单时贴近触发按钮，退出不执行远程操作', async ({}, info) => {
    const trigger = panel().getByRole('button', { name: '分支远程操作', exact: true })
    for (const width of [1440, 560]) {
      await setWindow(width)
      await trigger.focus(); await page.keyboard.press('Enter')
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible(); await settle(menu)
      const triggerBox = await trigger.boundingBox(), menuBox = await menu.boundingBox()
      if (!triggerBox || !menuBox) throw new Error('Missing branch menu or trigger geometry')
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(menuBox.y - triggerBox.y - triggerBox.height).toBeGreaterThanOrEqual(2)
      expect(menuBox.y - triggerBox.y - triggerBox.height).toBeLessThanOrEqual(6)
      expect(menuBox.x).toBeLessThan(triggerBox.x + triggerBox.width)
      expect(menuBox.x + menuBox.width).toBeGreaterThan(triggerBox.x)
      expect(menuBox.x).toBeGreaterThanOrEqual(3)
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 3)
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height - 3)
      await screenshot(info, `git-branch-menu-keyboard-${width}`)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(actions).toEqual([])
    }
  })

  test('长列表滚动后分组标题保持可点击，历史分页显示紧凑加载状态', async ({}, info) => {
    const content = panel().locator('.git-panel__content')
    const expectPinned = async (name: string): Promise<void> => {
      const header = group(name)
      await expect.poll(() => header.evaluate(element => {
        const scroll = element.closest('.git-panel__content')!, bounds = element.getBoundingClientRect()
        return Math.abs(bounds.top - scroll.getBoundingClientRect().top - scroll.clientTop)
      }), { message: `${name} must remain at the top of the scrolling viewport` }).toBeLessThanOrEqual(1.5)
      expect(await header.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(bounds.left + Math.min(100, bounds.width / 3), bounds.top + bounds.height / 2))
      }), `${name} must receive pointer input after scrolling`).toBe(true)
    }
    await setExpanded('暂存的更改', false); await setExpanded('更改', false); await setExpanded('存储', false)
    await setExpanded('提交历史', true)
    await expect(group('提交历史').locator('.git-panel__count')).toHaveText('50')
    paginationGate = new Promise<void>(done => { releasePagination = done })
    try {
      await content.hover(); await page.mouse.wheel(0, 3000)
      const loading = panel().locator('.git-panel__loading-status')
      await expect(loading).toHaveAttribute('role', 'status')
      await expect(loading).toContainText('加载提交记录')
      await expect(loading.locator('.ui-spinner')).toBeVisible()
      expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(600)
      await expectPinned('提交历史')
      const indicator = await panel().locator('.git-panel__load-more').evaluate(element => {
        const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
        return { height: bounds.height, borders: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle] }
      })
      expect(indicator.height).toBeLessThanOrEqual(40)
      expect(indicator.borders).not.toContain('dashed')
      await screenshot(info, 'git-history-sticky-loading')
      await group('提交历史').click()
      await expect(group('提交历史')).toHaveAttribute('aria-expanded', 'false')
      await expect(panel().locator('.git-panel__history')).toHaveCount(0)
    } finally {
      releasePagination?.(); paginationGate = undefined; releasePagination = undefined
    }
    manyChanges = true
    await panel().locator('.git-panel__toolbar').getByRole('button', { name: '刷新', exact: true }).click()
    await expect(group('更改').locator('.git-panel__count')).toHaveText('49')
    await setExpanded('更改', true); await settle()
    await content.hover(); await page.mouse.wheel(0, 3000)
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(600)
    await expectPinned('更改')
    await screenshot(info, 'git-changes-sticky')
    await group('更改').click()
    await expect(group('更改')).toHaveAttribute('aria-expanded', 'false')
    expect(actions).toEqual([])
  })

  test('450 条多轨道历史在窄栏保留摘要，完整图谱只在自身区域横向滚动', async ({}, info) => {
    complexHistory = true
    await setExpanded('暂存的更改', false); await setExpanded('更改', false); await setExpanded('存储', false)
    await setExpanded('提交历史', true)
    await panel().getByRole('button', { name: '刷新历史', exact: true }).click()
    const content = panel().locator('.git-panel__content')
    const firstRow = panel().locator('.git-panel__commit-row').filter({ has: page.getByText(complexCommits[0].subject, { exact: true }) })
    const wideRow = panel().locator('.git-panel__commit-row').filter({ hasText: complexCommits[8].subject })
    const revealRow = async (index: number): Promise<Locator> => {
      await content.evaluate((element, index) => {
        const list = element.querySelector('.git-panel__history .git-virtual-list')!
        element.scrollTop += list.getBoundingClientRect().top - element.getBoundingClientRect().top + index * 22 - 160
      }, index)
      const row = panel().locator('.git-panel__commit-row').filter({ has: page.getByText(complexCommits[index].subject, { exact: true }) })
      await expect(row).toBeAttached(); await row.scrollIntoViewIfNeeded(); await settle()
      return row
    }
    const expandRow = async (index: number): Promise<Locator> => {
      const row = await revealRow(index)
      if (!(await row.getAttribute('class'))?.includes('is-active')) await row.click()
      await expect(panel().locator('.git-panel__commit-files')).toHaveCount(1)
      await expect(panel().locator('.git-panel__commit-files')).toContainText('已暂存的工作区布局.tsx')
      await settle()
      return row
    }
    await expect(firstRow).toBeVisible()
    for (let count = 100; count <= 450; count += 50) {
      await content.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(group('提交历史').locator('.git-panel__count')).toHaveText(String(count))
    }
    await content.evaluate(element => { element.scrollTop = 0 }); await settle()
    await expect(firstRow).toBeVisible()
    await expandRow(8)
    const expanded = panel().locator('.git-panel__commit-files')
    await expect(expanded).toContainText('已暂存的工作区布局.tsx')
    const toggle = panel().getByRole('button', { name: '完整图谱', exact: true })
    const viewport = panel().locator('.git-panel__history-viewport')
    const outerOverflow = () => content.evaluate(element => element.scrollWidth - element.clientWidth)
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440); await setAppearance(appearance)
      for (const width of [1440, 560]) {
        await setWindow(width); await expandRow(8); await content.evaluate(element => { element.scrollTop = 0 }); await settle()
        await expect(toggle).toHaveAttribute('aria-pressed', 'false')
        await expect(toggle).toHaveCSS('opacity', '1')
        await expect(viewport).toHaveAttribute('data-graph-mode', 'compact')
        await expect(wideRow.locator('.git-graph')).toHaveAttribute('data-clipped', 'true')
        const compact = await wideRow.evaluate(element => ({
          lanes: Number(element.querySelector('.git-graph')!.getAttribute('data-lane-count')),
          graph: element.querySelector('.git-graph')!.getBoundingClientRect().width,
          subject: element.querySelector('.git-panel__commit-subject')!.getBoundingClientRect().width
        }))
        expect(compact.lanes).toBeGreaterThanOrEqual(10)
        expect(compact.graph).toBeLessThanOrEqual(88)
        expect(compact.subject).toBeGreaterThanOrEqual(64)
        expect(await outerOverflow()).toBeLessThanOrEqual(1)
        expect(await expanded.locator('.git-panel__commit-rail').evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(88)
        await screenshot(info, `git-many-lanes-compact-${appearance}-${width}`)
        await toggle.focus(); await page.keyboard.press('Enter')
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await expect(viewport).toHaveAttribute('data-graph-mode', 'full')
        await settle()
        await expect(wideRow.locator('.git-graph')).not.toHaveAttribute('data-clipped', 'true')
        await expect(expanded.locator('.git-panel__commit-rail')).not.toHaveAttribute('data-clipped', 'true')
        const fullGraph = await wideRow.locator('.git-graph').evaluate(element => element.getBoundingClientRect().width)
        expect(fullGraph).toBeGreaterThan(88)
        expect(await expanded.locator('.git-panel__commit-rail').evaluate(element => element.getBoundingClientRect().width)).toBe(fullGraph)
        expect(await viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(32)
        const position = () => wideRow.evaluate(element => ({
          graph: element.querySelector('.git-graph')!.getBoundingClientRect().left,
          subject: element.querySelector('.git-panel__commit-subject')!.getBoundingClientRect().left,
          panel: element.closest('.git-panel__content')!.getBoundingClientRect().left
        }))
        const before = await position()
        await viewport.evaluate(element => { element.scrollLeft = Math.min(120, element.scrollWidth - element.clientWidth) })
        await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(30)
        const after = await position(), distance = await viewport.evaluate(element => element.scrollLeft)
        expect(Math.abs(before.graph - after.graph - distance)).toBeLessThanOrEqual(1)
        expect(Math.abs(before.subject - after.subject - distance)).toBeLessThanOrEqual(1)
        expect(after.panel).toBe(before.panel)
        expect(await content.evaluate(element => element.scrollLeft)).toBe(0)
        expect(await outerOverflow()).toBeLessThanOrEqual(1)
        await screenshot(info, `git-many-lanes-full-${appearance}-${width}`)
        await viewport.evaluate(element => { element.scrollLeft = 0 })
        const rowGeometry: Array<{ index: number; width: number; left: number; gap: number; scrollLeft: number }> = []
        for (const index of [0, 8, 85]) {
          const row = await expandRow(index)
          const dimensions = await row.evaluate(element => {
            const graph = element.querySelector('.git-graph')!.getBoundingClientRect(), subject = element.querySelector('.git-panel__commit-subject')!.getBoundingClientRect()
            const rail = element.parentElement!.querySelector('.git-panel__commit-rail')!.getBoundingClientRect()
            const rows = [...element.closest('.git-virtual-list')!.querySelectorAll('.git-panel__commit-row')]
            const nextGraph = rows[rows.indexOf(element) + 1].querySelector('.git-graph')!.getBoundingClientRect()
            const viewport = element.closest('.git-panel__history-viewport')!
            return { width: graph.width, left: graph.left, gap: subject.left - graph.right, railWidth: rail.width, railLeft: rail.left, nextLeft: nextGraph.left,
              viewportLeft: viewport.getBoundingClientRect().left, scrollLeft: viewport.scrollLeft }
          })
          expect(dimensions.gap).toBeGreaterThanOrEqual(0); expect(dimensions.gap).toBeLessThanOrEqual(12)
          expect(Math.abs(dimensions.railWidth - dimensions.width)).toBeLessThanOrEqual(1)
          expect(Math.abs(dimensions.railLeft - dimensions.left)).toBeLessThanOrEqual(1)
          expect(Math.abs(dimensions.nextLeft - dimensions.left)).toBeLessThanOrEqual(1)
          // Revealing/clicking a wide virtual row can also scroll horizontally.
          // Compare separate samples in canvas coordinates; the simultaneous
          // rail and adjacent-row assertions above retain viewport coordinates.
          rowGeometry.push({ index, width: dimensions.width, left: dimensions.left + dimensions.scrollLeft - dimensions.viewportLeft,
            gap: dimensions.gap, scrollLeft: dimensions.scrollLeft })
          if (index === 85) await screenshot(info, `git-converged-lanes-${appearance}-${width}`)
        }
        await info.attach(`git-row-alignment-${appearance}-${width}`, { body: JSON.stringify(rowGeometry, null, 2), contentType: 'application/json' })
        expect(rowGeometry[1].width).toBeGreaterThan(rowGeometry[0].width + 300)
        expect(rowGeometry[1].width).toBeGreaterThan(rowGeometry[2].width + 300)
        expect(Math.abs(rowGeometry[0].width - rowGeometry[2].width)).toBeLessThanOrEqual(1)
        expect(Math.max(...rowGeometry.map(row => row.left)) - Math.min(...rowGeometry.map(row => row.left))).toBeLessThanOrEqual(1)
        await toggle.focus(); await page.keyboard.press('Enter')
        await expect(viewport).toHaveAttribute('data-graph-mode', 'compact')
      }
    }
  })

  test('滚动后搜索与作者分支筛选紧贴历史标题，鼠标和键盘均可操作', async ({}, info) => {
    await setExpanded('暂存的更改', false); await setExpanded('更改', false); await setExpanded('存储', false)
    const content = panel().locator('.git-panel__content')
    const header = panel().locator('.git-panel__history-header')
    const filters = header.locator('.git-panel__history-filter')
    const search = filters.getByPlaceholder('搜索提交信息…', { exact: true })
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440); await setAppearance(appearance)
      for (const width of [1440, 560]) {
        await setWindow(width); await setExpanded('提交历史', true)
        await expect(group('提交历史').locator('.git-panel__count')).toHaveText('50')
        await settle(); await content.hover(); await page.mouse.wheel(0, 700)
        await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(400)
        const geometry = await header.evaluate(element => {
          const scroll = element.closest('.git-panel__content')!, box = element.getBoundingClientRect()
          const title = element.querySelector('.git-panel__group-head')!.getBoundingClientRect(), filters = element.querySelector('.git-panel__history-filter')!.getBoundingClientRect()
          return { top: box.top - scroll.getBoundingClientRect().top - scroll.clientTop, gap: filters.top - title.bottom,
            controls: [...element.querySelectorAll('.git-panel__history-filter input, .git-panel__history-filter button')].map(control => {
              const bounds = control.getBoundingClientRect()
              return { left: bounds.left - box.left, right: bounds.right - box.right, bottom: bounds.bottom - box.bottom,
                receivesPointer: control.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)) }
            }) }
        })
        expect(Math.abs(geometry.top)).toBeLessThanOrEqual(1.5)
        expect(geometry.gap).toBeGreaterThanOrEqual(-1); expect(geometry.gap).toBeLessThanOrEqual(12)
        for (const control of geometry.controls) {
          expect(control.left).toBeGreaterThanOrEqual(-1); expect(control.right).toBeLessThanOrEqual(1)
          expect(control.bottom).toBeLessThanOrEqual(1); expect(control.receivesPointer).toBe(true)
        }
        await search.click(); await expect(search).toBeFocused()
        await search.fill('布局'); await expect(search).toHaveValue('布局'); await search.clear()
        const author = filters.getByRole('button', { name: '作者', exact: true })
        await author.focus(); await page.keyboard.press('ArrowDown')
        await expect(page.getByRole('menu', { name: '作者', exact: true })).toBeVisible()
        await page.keyboard.press('Escape'); await expect(author).toHaveAttribute('aria-expanded', 'false')
        const branch = filters.getByRole('button', { name: '分支', exact: true })
        await branch.click(); await expect(page.getByRole('menu', { name: '分支', exact: true })).toBeVisible()
        await page.keyboard.press('Escape'); await expect(branch).toHaveAttribute('aria-expanded', 'false')
        await expect(group('提交历史')).toHaveAttribute('aria-expanded', 'true')
        await screenshot(info, `git-history-sticky-filters-${appearance}-${width}`)
        await group('提交历史').focus(); await page.keyboard.press('Space')
        await expect(group('提交历史')).toHaveAttribute('aria-expanded', 'false')
        await expect(filters).toHaveCount(0)
      }
    }
  })

  test('存储操作在悬停与键盘焦点下可见，查看与取消删除不写入仓库', async ({}, info) => {
    await setExpanded('提交历史', false); await setExpanded('存储', true)
    const row = panel().locator('.git-panel__stash-row').first()
    const view = row.getByRole('button', { name: '查看详情', exact: true })
    for (const width of [1440, 560]) {
      await setWindow(width); await row.hover(); await expect(view).toBeVisible()
      await page.mouse.move(0, 0); await view.focus(); await expect(view).toBeFocused()
      await expect(row.locator('.git-panel__stash-actions')).toHaveCSS('opacity', '1')
      const geometry = await row.evaluate(element => {
        const box = element.getBoundingClientRect()
        return { overflow: element.scrollWidth - element.clientWidth, controls: [...element.querySelectorAll('button')].map(button => {
          const bounds = button.getBoundingClientRect(); return { left: bounds.left - box.left, right: bounds.right - box.right, height: bounds.height, width: bounds.width }
        }) }
      })
      expect(geometry.overflow).toBeLessThanOrEqual(1)
      for (const control of geometry.controls) { expect(control.left).toBeGreaterThanOrEqual(-1); expect(control.right).toBeLessThanOrEqual(1); expect(control.height).toBeGreaterThanOrEqual(28); expect(control.width).toBeGreaterThanOrEqual(28) }
      await screenshot(info, `git-stash-focus-${width}`)
    }
    await setWindow(1440)
    await row.getByRole('button', { name: /^查看存储 0：/ }).focus(); await page.keyboard.press('Enter')
    const detail = page.getByRole('dialog').filter({ hasText: '存储说明较长时仍可打开完整详情并使用独立操作按钮' })
    await expect(detail).toBeVisible(); await expect(detail).toContainText(files[0].path)
    await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0)
    await row.getByRole('button', { name: '删除该存储', exact: true }).focus(); await page.keyboard.press('Enter')
    const confirmation = page.getByRole('dialog', { name: '删除存储', exact: true })
    await expect(confirmation).toBeVisible(); expect(actions).toEqual([])
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(panel().locator('.git-panel__stash-row')).toHaveCount(4)
  })
})
