/** Five real project turns through Electron -> HTTP -> ReAct -> guarded file
 * tools -> on-disk changes/assets. Only the upstream model replies are scripted.
 * Exercises same-path multi-write diffs, delete/recreate, immutable deliveries,
 * atomic rollback 5 -> 4 and 2..4 -> 1, live refresh and full process restart.
 * Build both repositories before running; this test never builds or reads user data. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult, FinalResultItem } from '../src/shared/final-result'
import { lifecycleRounds, sha256, startLifecycleProvider, type LifecycleRound, type DeterministicProvider } from './fixtures/project-lifecycle'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/project-lifecycle')
const engineEntry = resolve(process.env.AETHER_E2E_ENGINE_ENTRY || join(root, '../ai-agent-engine/dist/main.js'))
const appEntry = process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js')
const modelId = 'project-lifecycle-deterministic'
const token = randomBytes(32).toString('hex'), encryptionKey = randomBytes(32).toString('hex'), rounds = lifecycleRounds()
const errors: string[] = [], observedRequests: Array<{ method: string; path: string; body?: unknown }> = []
const roots: RootRun[] = [], manifests: FinalResult[] = [], changesByRound: FileChange[][] = []
const rollbackRequests = new Map<number, { requestKey: string; messageId: string }>()
let fixture = '', workspace = '', profile = '', origin = '', sessionId = '', port = 0, engineLog = '', generation = 0, verified = false
let provider: DeterministicProvider, runner: ChildProcess | undefined, runnerClosed: Promise<unknown> | undefined, runnerStartedAt = 0
let app: ElectronApplication | undefined, page: Page
const importBuilt = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>
interface FileChange { id: string; seq: number; runId: string; turnId: string; path: string; kind: 'write' | 'delete';
  oldContent: string | null; newContent: string | null; oldHash: string; newHash: string; status: string }
interface HistoryRow { id: string; role: string; content: unknown; conversationId?: string; metadata?: { finalResult?: FinalResult; rootRunId?: string } }
interface Snapshot { run?: RootRun; executionRun?: RootRun; runs: RootRun[]; history: HistoryRow[]; changes: FileChange[] }
interface Asset { content: string; encoding: 'base64'; sha256: string }
interface RevertReport { total: number; reverted: number; conflicts: number; unavailable: number; failed: number; historyTruncated: boolean; removedDirectories?: string[] }
interface RollbackReceipt { state: string; turnIds: string[]; roots: Array<Pick<RootRun, 'runId' | 'turnId' | 'attemptId'>>; report: RevertReport }
const delay = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const normalize = (path: string): string => path.replace(/\\/g, '/')
const local = (path: string): string => join(workspace, ...path.split('/'))
const work = (): Locator => page.locator('.work-view')
const pane = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const turn = (ordinal: number): Locator => work().locator(`.work-conversation-turn[data-turn-id="message:${roots[ordinal - 1].userMessageId}"]`)
const summary = (ordinal: number): Locator => turn(ordinal).getByRole('region', { name: '本轮成果摘要', exact: true })
const headers = (): Record<string, string> => ({ 'content-type': 'application/json', 'x-aether-instance-token': token,
  'x-aether-tool-profile': 'general', 'x-aether-subagent-protocol': '2', 'x-aether-run-lifetime': 'durable' })
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api/v1' + path, { method, headers: headers(), signal: AbortSignal.timeout(20000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json() as { code: number; message?: string; data: T }
  if (!response.ok || value.code !== 200) throw new Error(`${method} ${path}: HTTP ${response.status} ${value.code} ${value.message}`)
  return value.data
}
const snapshot = (): Promise<Snapshot> => api('/chat/snapshot?sessionId=' + sessionId)
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ||
    /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ENCRYPTION|ELECTRON_|NODE_OPTIONS|^AETHER_|^DATA_DIR$|^MEMORY_|^HISTORY_|^WORKSPACE_|^SKILLS_|^MCP_|^LLM_|^AUTH_|^OSM_|^QA_|^LOG_|^OPENAI_|^ANTHROPIC_|^DEEPSEEK_|^DEFAULT_SECURITY_MODE$|^ENABLE_LONG_TERM_MEMORY$|^MAX_ITERATIONS$/i.test(key) ? [] : [[key, value]]))
}
function owned(target: string): string {
  const absolute = resolve(target)
  if (absolute !== fixture && !absolute.startsWith(fixture + sep)) throw new Error('Path is outside owned lifecycle fixture')
  let current = absolute
  while (current.startsWith(fixture)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Lifecycle fixture traverses a link')
    const parent = dirname(current); if (parent === current) break; current = parent
  }
  return absolute
}
function evidence(name: string, value: unknown): void {
  const file = owned(join(fixture, 'evidence', name)); mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}
async function startEngine(): Promise<void> {
  const host = join(fixture, 'engine-host.mjs'), built = dirname(engineEntry)
  // Only seed an enabled fake model configuration; never seed changes, root runs,
  // history or result assets. Every business record must come from real /chat.
  const source = `import { pathToFileURL } from 'node:url';
process.on('message', message => { if (message?.command === 'shutdown') process.emit('SIGTERM') });
await import(${JSON.stringify(pathToFileURL(join(built, 'env.js')).href)});
const { initDb } = await import(${JSON.stringify(pathToFileURL(join(built, 'storage/sqlite/db.js')).href)});
await initDb();
const { ModelsStore } = await import(${JSON.stringify(pathToFileURL(join(built, 'storage/sqlite/models.js')).href)});
const store = new ModelsStore();
if (!(await store.getModels('default')).some(model => model.modelId === ${JSON.stringify(modelId)})) {
  await store.createModel({ tenantId:'default',provider:'openai',modelId:${JSON.stringify(modelId)},apiKey:'lifecycle-fixture-no-real-credential',
    baseUrl:${JSON.stringify(provider.origin + '/v1')},apiFormat:'openai',displayName:'项目生命周期确定性响应',isEnabled:true,
    capabilities:{toolCalling:true,thinking:false,vision:false,contextWindow:256000,maxOutputTokens:8192} });
}
await import(${JSON.stringify(pathToFileURL(engineEntry).href)});
`
  writeFileSync(host, source)
  generation++; runnerStartedAt = Date.now()
  runner = spawn(process.execPath, [host], { cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...cleanEnv(), AUTH_ENABLED: 'false', DATA_DIR: join(fixture, 'engine/state/agent.db'), MEMORY_DB_PATH: join(fixture, 'engine/state/memory.db'),
    ENCRYPTION_KEY: encryptionKey, WORKSPACE_ROOT: workspace, AETHER_GLOBAL_DIR: join(fixture, 'engine/global'), SKILLS_ROOT: join(fixture, 'engine/skills'),
    MCP_CONFIG_PATH: join(fixture, 'engine/mcp.json'), PROGRAMDATA: join(fixture, 'managed-config'),
    AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PORT: String(port), AETHER_INSTANCE_TOKEN: token, AETHER_DESKTOP_OWNED: '1',
    DEFAULT_SECURITY_MODE: 'standard', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'balanced', ENABLE_LONG_TERM_MEMORY: 'false', QA_LOG_ENABLED: 'false',
    QA_LOG_DIR: join(fixture, 'engine/qa'), LOG_LEVEL: 'warn', NODE_ENV: 'development', LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: modelId,
    LLM_MODEL: modelId, LLM_FALLBACK_MODEL: '' } })
  runnerClosed = new Promise(done => { runner!.once('error', error => done({ error: error.message })); runner!.once('close', (code, signal) => done({ code, signal })) })
  for (const stream of [runner.stdout, runner.stderr]) stream?.on('data', bytes => {
    engineLog = (engineLog + bytes.toString()).slice(-300000)
    writeFileSync(join(fixture, 'engine.log'), engineLog)
  })
  await expect.poll(async () => {
    if (runner!.exitCode !== null) throw new Error('Real lifecycle engine exited: ' + engineLog.slice(-4000))
    try { return (await api<Array<{ modelId: string; isEnabled: boolean }>>('/models')).some(model => model.modelId === modelId && model.isEnabled) }
    catch { return false }
  }, { timeout: 90000, intervals: [250, 500, 1000] }).toBe(true)
}
async function stopEngine(): Promise<void> {
  if (!runner) return
  if (runner.connected) runner.send({ command: 'shutdown' })
  if (!await Promise.race([runnerClosed!.then(() => true), delay(12000).then(() => false)])) {
    const { stopCommandProcessTree } = await importBuilt<{ stopCommandProcessTree: (process: ChildProcess, started: number) => Promise<void> }>(pathToFileURL(join(dirname(engineEntry), 'core/command-jobs/process-tree.js')).href)
    await stopCommandProcessTree(runner, runnerStartedAt)
  }
  await Promise.race([runnerClosed!, delay(5000).then(() => { throw new Error('Lifecycle engine did not close') })])
  runner = undefined; runnerClosed = undefined
}
async function launchApp(initial = false): Promise<void> {
  app = await electron.launch({ args: [appEntry, '--user-data-dir=' + profile], cwd: root,
    env: { ...cleanEnv(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'desktop-global') } })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  page.on('request', request => {
    const url = request.url()
    if (!url.startsWith(origin) || !/\/conversation\/(rollback|truncate)|\/changes\/revert/.test(url)) return
    observedRequests.push({ method: request.method(), path: new URL(url).pathname, body: request.postDataJSON() as unknown })
  })
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1600, 1000) })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  if (initial) {
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toBeVisible()
    await work().locator('.work-composer-workspace__trigger').click()
    const picker = page.getByRole('dialog', { name: '选择工作区', exact: true })
    await picker.getByRole('button', { name: '输入工作区路径…', exact: true }).click()
    await picker.getByRole('textbox', { name: '远端工作区路径', exact: true }).fill(workspace)
    await picker.getByRole('button', { name: '使用此工作区', exact: true }).click()
    await expect(picker).toHaveCount(0)
  } else {
    await expect(work().locator(`.work-sidebar__task-row[data-task-id="${sessionId}"]`)).toBeVisible()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
  }
}
function diskState(): { files: Record<string, { sha256: string; bytes: number }>; directories: string[] } {
  const files: Record<string, { sha256: string; bytes: number }> = {}, directories: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), key = normalize(relative(workspace, path))
      if (entry.isSymbolicLink()) throw new Error('Unexpected link inside lifecycle project')
      if (entry.isDirectory()) { directories.push(key); visit(path) }
      else { const bytes = readFileSync(path); files[key] = { sha256: sha256(bytes), bytes: bytes.length } }
    }
  }
  if (existsSync(local('project'))) { directories.push('project'); visit(local('project')) }
  return { files, directories: directories.sort() }
}
async function assertDisk(round: LifecycleRound): Promise<void> {
  const expected = { files: Object.fromEntries(Object.entries(round.files).map(([path, content]) => [path, { sha256: sha256(content), bytes: Buffer.byteLength(content) }])), directories: round.directories }
  await expect.poll(diskState).toEqual(expected)
  for (const [path, content] of Object.entries(round.files)) expect(readFileSync(local(path), 'utf8'), path).toBe(content)
}
async function assertAssets(kept: number, withdrawn: number[] = []): Promise<void> {
  for (let index = 0; index < kept; index++) {
    const result = manifests[index], round = rounds[index]
    expect(result.items).toHaveLength(round.deliveries.length)
    for (const item of result.items) {
      const path = normalize(relative(workspace, item.path)), expected = round.files[path]
      expect(expected, path).toBeDefined()
      const value = await api<Asset>(`/conversation/result-asset?sessionId=${sessionId}&runId=${result.runId}&assetId=${item.assetId}`)
      const bytes = Buffer.from(value.content, 'base64')
      expect(bytes.toString(), `round ${index + 1} immutable ${path}`).toBe(expected)
      expect(sha256(bytes)).toBe(item.sha256); expect(value.sha256).toBe(item.sha256)
    }
  }
  for (const ordinal of withdrawn) for (const item of manifests[ordinal - 1].items) {
    const response = await fetch(`${origin}/api/v1/conversation/result-asset?sessionId=${sessionId}&runId=${manifests[ordinal - 1].runId}&assetId=${item.assetId}`, { headers: headers() })
    expect((await response.json() as { code: number }).code, `withdrawn ${ordinal}/${item.name}`).toBe(40400)
  }
}
async function assertSummary(round: LifecycleRound): Promise<void> {
  const card = summary(round.ordinal)
  await expect(card).toBeVisible(); await expect(card.locator('.work-progress-panel__count')).toHaveText(`${round.net.length} 个文件`)
  const toggle = card.locator('.work-progress-panel__changes-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await expect(card.locator('.work-progress-panel__file')).toHaveCount(round.net.length)
  for (const net of round.net) await expect(card.locator('.work-progress-panel__file-name').filter({ hasText: basename(net.path) })).toHaveCount(1)
  await expect(card).not.toContainText('temporary.txt')
  if (round.ordinal === 2) {
    const row = card.locator('.work-progress-panel__file').filter({ has: page.locator('.work-progress-panel__file-name', { hasText: 'game.js' }) })
    await expect(row.locator('.work-progress-panel__file-added')).toHaveText('+2')
    await expect(row.locator('.work-progress-panel__file-removed')).toHaveText('-2')
  }
}
async function assertTurnDiff(ordinal: number, path: string): Promise<void> {
  const round = rounds[ordinal - 1], net = round.net.find(change => change.path === path)!
  await assertSummary(round)
  const latest = changesByRound[ordinal - 1].filter(change => normalize(relative(workspace, change.path)) === path).at(-1)!
  await summary(ordinal).locator(`[data-change-id="${latest.id}"] .work-progress-panel__file`).click()
  const inspector = pane().getByRole('region', { name: '本会话成果与改动', exact: true })
  await expect(inspector).toBeVisible(); await expect(inspector).toHaveAttribute('data-session-id', sessionId)
  await expect(inspector.locator('.work-session-artifacts__file-header > strong')).toHaveText(basename(path))
  await expect(inspector.getByRole('button', { name: '差异范围', exact: true })).toContainText('本轮改动')
  const diff = inspector.locator('.work-session-artifacts__diff[data-diff-scope="turn"]')
  await expect(diff).toBeVisible()
  const deleted = net.oldContent?.trimEnd().split('\n').filter(line => !net.newContent?.split('\n').includes(line)) ?? []
  const added = net.newContent?.trimEnd().split('\n').filter(line => !net.oldContent?.split('\n').includes(line)) ?? []
  for (const line of deleted) await expect(diff.locator('.diff-row--del')).toContainText([line])
  for (const line of added) await expect(diff.locator('.diff-row--add')).toContainText([line])
  await expect(inspector.locator('[role="treeitem"][aria-selected="true"]')).toHaveAttribute('data-path', latest.path)
  if (ordinal === 4 && path.endsWith('index.html')) await expect(diff).not.toContainText('ROUND_4_DRAFT')
}
async function previewAsset(ordinal: number, path = 'project/src/game.js'): Promise<FinalResultItem> {
  const result = manifests[ordinal - 1], item = result.items.find(value => normalize(relative(workspace, value.path)) === path)!
  expect(item, path).toBeDefined()
  await turn(ordinal).getByRole('button', { name: '预览 ' + item.name, exact: true }).click()
  const preview = pane().getByRole('region', { name: '交付物预览', exact: true })
  await expect(preview).toHaveAttribute('data-final-result-run', result.runId)
  await expect(preview).toHaveAttribute('data-final-result-item', item.id)
  for (const line of rounds[ordinal - 1].files[path].trimEnd().split('\n')) await expect(preview).toContainText(line)
  return item
}
async function assertOperationDiff(ordinal: number, path: string, operationIndex: number): Promise<void> {
  await assertTurnDiff(ordinal, path)
  const operations = changesByRound[ordinal - 1].filter(change => normalize(relative(workspace, change.path)) === path)
  const operation = operations[operationIndex]
  const inspector = pane().getByRole('region', { name: '本会话成果与改动', exact: true })
  await inspector.getByRole('button', { name: '差异范围', exact: true }).click()
  await page.getByRole('menuitem').filter({ has: page.locator('.select__item-head', { hasText: /^修改记录$/ }) }).click()
  await inspector.getByRole('button', { name: '选择单次修改', exact: true }).click()
  const choices = page.getByRole('menu').getByRole('menuitem')
  await expect(choices).toHaveCount(operations.length)
  await choices.nth(operations.length - operationIndex - 1).click()
  const diff = inspector.locator('.work-session-artifacts__diff[data-diff-scope="operation"]')
  await expect(diff).toHaveAttribute('data-change-id', operation.id)
  for (const line of operation.oldContent?.trimEnd().split('\n').filter(line => !operation.newContent?.split('\n').includes(line)) ?? [])
    await expect(diff.locator('.diff-row--del')).toContainText([line])
  for (const line of operation.newContent?.trimEnd().split('\n').filter(line => !operation.oldContent?.split('\n').includes(line)) ?? [])
    await expect(diff.locator('.diff-row--add')).toContainText([line])
}
async function inspectHistoryWhileRunning(): Promise<void> {
  await expect.poll(() => provider.heldFinalRounds.has(5), { timeout: 90000 }).toBe(true)
  const active = await snapshot(), run = active.executionRun ?? active.run!
  expect(run.status).toBe('running'); expect(active.runs).toHaveLength(5)
  expect(active.runs.slice(0, 4).map(value => value.runId)).toEqual(roots.map(value => value.runId))
  await assertDisk(rounds[4]) // Current files have advanced beyond the historical cards.
  await assertAssets(4); await assertSummary(rounds[1]); await assertSummary(rounds[3])
  await assertTurnDiff(4, 'project/src/game.js')
  await assertOperationDiff(4, 'project/index.html', 0) // ROUND_2 -> DRAFT
  await assertOperationDiff(4, 'project/index.html', 1) // DRAFT -> FINAL
  await assertOperationDiff(2, 'project/src/game.js', 1) // Only score 1 -> 2
  await previewAsset(1, 'project/docs/guide.txt')
  await previewAsset(4)
  await assertTurnDiff(4, 'project/index.html')
  const stillRunning = await snapshot()
  expect((stillRunning.executionRun ?? stillRunning.run)?.status).toBe('running')
  evidence('history-while-fifth-round-running.json', { active, disk: diskState(), checkedTurns: [1, 2, 4],
    checkedOperations: [changesByRound[3][0].id, changesByRound[3][1].id, changesByRound[1][2].id] })
  const info = test.info(), path = info.outputPath('history-while-fifth-round-running.png')
  await page.screenshot({ path, animations: 'disabled' }); await info.attach('history-while-fifth-round-running', { path, contentType: 'image/png' })
  provider.releaseFinal(5)
}
async function sendRound(round: LifecycleRound): Promise<void> {
  const initial = round.ordinal === 1
  const composer = work().getByRole('textbox', { name: initial ? '任务目标' : '继续对话', exact: true })
  await composer.fill(round.prompt); await work().getByRole('button', { name: initial ? '开始任务' : '发送', exact: true }).click()
  if (initial) {
    const row = work().locator('.work-sidebar__task-row')
    await expect(row).toHaveCount(1)
    sessionId = (await row.getAttribute('data-task-id'))!
    expect(sessionId).toMatch(/^work-/)
  }
  if (round.ordinal === 5) await inspectHistoryWhileRunning()
  await expect.poll(async () => {
    const state = await snapshot(), run = state.executionRun ?? state.run
    if (run && ['failed', 'waiting', 'cancelled'].includes(run.status)) throw new Error(`Round ${round.ordinal} stopped: ${JSON.stringify(run)}`)
    return state.runs.length === round.ordinal && run?.status === 'succeeded'
  }, { timeout: 90000, intervals: [200, 500] }).toBe(true)
  const state = await snapshot(), run = state.executionRun ?? state.run!
  roots.push(run)
  const result = state.history.find(message => message.id === run.assistantMessageId)?.metadata?.finalResult
  expect(result, 'Real engine must publish an owned final-result manifest').toBeDefined()
  manifests.push(result!)
  const changes = (await api<FileChange[]>('/changes?sessionId=' + sessionId)).filter(change => change.runId === run.runId).sort((a, b) => a.seq - b.seq)
  changesByRound.push(changes)
  expect(changes.map(change => ({ path: normalize(relative(workspace, change.path)), oldContent: change.oldContent, newContent: change.newContent, oldHash: change.oldHash, newHash: change.newHash })))
    .toEqual(round.changes)
  expect(state.history.filter(message => message.role === 'user').map(message => message.content)).toEqual(rounds.slice(0, round.ordinal).map(item => item.prompt))
  await assertDisk(round); await assertAssets(round.ordinal); await assertSummary(round)
  await expect(turn(round.ordinal)).toContainText(`LIFECYCLE_DONE_${round.ordinal}`)
  await expect(turn(round.ordinal).locator('.work-final-deliverable')).toHaveCount(round.deliveries.length)
  await assertTurnDiff(round.ordinal, 'project/src/game.js')
  await previewAsset(round.ordinal)
  evidence(`round-${round.ordinal}.json`, { disk: diskState(), run, result, changes, modelRequests: provider.requests })
}
async function openWorkspaceTree(): Promise<Locator> {
  const tab = pane().getByRole('tab', { name: '工作区', exact: true })
  if (await tab.isVisible()) await tab.click()
  else { await work().locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '工作区', exact: true }).click() }
  const tree = pane().getByRole('region', { name: '工作区文件', exact: true })
  await expect(tree).toBeVisible()
  return tree
}
async function expandTree(tree: Locator, round: LifecycleRound): Promise<void> {
  const list = tree.getByRole('tree')
  await expect(list).toHaveAttribute('aria-busy', 'false')
  // Wait for each asynchronous directory read before looking for descendants;
  // do not descend into the engine's unrelated .ae/default workspace folders.
  for (const path of [...round.directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    const row = tree.getByRole('treeitem', { name: basename(path), exact: true })
    await expect(row).toHaveCount(1)
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
    await expect(list).toHaveAttribute('aria-busy', 'false')
  }
}
async function assertTree(round: LifecycleRound): Promise<void> {
  const tree = await openWorkspaceTree(); await expandTree(tree, round)
  const expectedNames = [...new Set([...Object.keys(round.files), ...round.directories].map(path => basename(path)))].sort()
  // Every fixture filename is unique; the tree must also remove rolled-back empty directories live.
  for (const name of expectedNames) await expect(tree.getByRole('treeitem', { name, exact: true })).toHaveCount(1)
  for (const name of ['temporary.txt', ...(round.ordinal <= 4 ? ['releases', 'round5', 'deep', 'audit.txt'] : []),
    ...(round.ordinal === 1 ? ['features', 'score', 'score.js', 'hints', 'nested', 'hints.js', 'release', 'round4.txt'] : [])]) {
    await expect(tree.getByRole('treeitem', { name, exact: true })).toHaveCount(0)
  }
}
async function rollbackFrom(ordinal: number, expectedKept: number): Promise<void> {
  // Keep a revoked asset actively open while the user rolls back its producing turn.
  const removedItem = await previewAsset(ordinal)
  await turn(ordinal).getByRole('button', { name: '回退文件', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '回退文件', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '回退文件', exact: true }).click()
  await expect.poll(async () => {
    try { return (await snapshot()).runs.length }
    catch (error) {
      // The atomic route correctly fences snapshot readers until the files and
      // transcript agree. This temporary admission conflict is not a failure.
      if (error instanceof Error && error.message.endsWith('409 ADMISSION_HISTORY_MUTATING')) return -1
      throw error
    }
  }).toBe(expectedKept)
  // This row can only be written by the real atomic route. Renderer network
  // events alone are insufficient because desktop IPC performs HTTP in main.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(fixture, 'engine/state/agent.db'), { readOnly: true })
  try {
    const query = db.prepare('SELECT request_key,message_id,record FROM conversation_rollback_requests WHERE tenant_id=? AND session_id=? AND message_id=?')
    const readRows = () => query.all('default', sessionId, roots[ordinal - 1].userMessageId)
    await expect.poll(() => readRows().map(row => (JSON.parse(String(row.record)) as RollbackReceipt).state),
      { message: 'UI must finish one real atomic rollback request' }).toEqual(['succeeded'])
    const [row] = readRows(), requestKey = String(row.request_key), messageId = String(row.message_id)
    expect(requestKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(messageId).toBe(roots[ordinal - 1].userMessageId)
    expect([...rollbackRequests.values()].map(request => request.requestKey)).not.toContain(requestKey)
    rollbackRequests.set(ordinal, { requestKey, messageId })
    const receipt = JSON.parse(String(row.record)) as RollbackReceipt
    const removedRoots = roots.slice(ordinal - 1, ordinal === 5 ? 5 : 4)
    expect(receipt.state).toBe('succeeded')
    expect(receipt.turnIds).toEqual(removedRoots.map(run => run.turnId))
    expect(receipt.roots).toEqual(removedRoots.map(({ runId, turnId, attemptId }) => ({ runId, turnId, ...(attemptId ? { attemptId } : {}) })))
    expect(receipt.report.conflicts + receipt.report.unavailable + receipt.report.failed).toBe(0)
    evidence(`rollback-receipt-${ordinal}.json`, { requestKey, messageId, receipt })
  } finally { db.close() }
  await assertDisk(rounds[expectedKept - 1])
  await expect(work().locator('.work-conversation-turn')).toHaveCount(expectedKept)
  await expect(pane().locator(`[data-final-result-item="${removedItem.id}"]`)).toHaveCount(0)
  for (let i = expectedKept + 1; i <= roots.length; i++) {
    await expect(work().locator(`[data-final-result-run="${roots[i - 1].runId}"]`)).toHaveCount(0)
    await expect(work().locator(`[data-turn-id="message:${roots[i - 1].userMessageId}"]`)).toHaveCount(0)
  }
  await expect(work().getByRole('region', { name: '本次回退结果', exact: true })).toContainText('文件回退完成')
  await assertAssets(expectedKept, Array.from({ length: manifests.length - expectedKept }, (_, index) => expectedKept + index + 1))
  await assertTree(rounds[expectedKept - 1])
  await assertSummary(rounds[0]); await previewAsset(1)
  evidence(`rollback-from-${ordinal}.json`, { state: await snapshot(), disk: diskState() })
}
async function assertRecovered(kept: number, info: TestInfo, label: string): Promise<void> {
  const state = await snapshot()
  expect(state.runs.map(run => run.runId)).toEqual(roots.slice(0, kept).map(run => run.runId))
  expect(state.history.filter(message => message.role === 'user').map(message => message.content)).toEqual(rounds.slice(0, kept).map(round => round.prompt))
  await expect(work().locator('.work-conversation-turn')).toHaveCount(kept)
  await assertDisk(rounds[kept - 1]); await assertAssets(kept, Array.from({ length: manifests.length - kept }, (_, index) => kept + index + 1))
  for (let ordinal = 1; ordinal <= kept; ordinal++) await assertSummary(rounds[ordinal - 1])
  await assertTree(rounds[kept - 1]); await previewAsset(1)
  evidence(label + '.json', { state, disk: diskState(), generation })
  const image = info.outputPath(label + '.png'); await page.screenshot({ path: image, animations: 'disabled' }); await info.attach(label, { path: image, contentType: 'image/png' })
}
async function restart(): Promise<void> {
  await app!.close(); app = undefined
  await stopEngine(); await startEngine(); await launchApp()
}

test.describe.serial('真实引擎五轮项目生命周期', () => {
  test.beforeAll(async () => {
    expect(existsSync(engineEntry), 'Build the engine before this test').toBe(true)
    expect(existsSync(appEntry), 'Build the desktop before this test').toBe(true)
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'run-'))
    workspace = join(fixture, 'workspace'); profile = join(fixture, 'profile'); mkdirSync(workspace); mkdirSync(profile)
    provider = await startLifecycleProvider(rounds, modelId, { holdFinalRounds: [5] })
    const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done))
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing engine port')
    port = address.port; await new Promise<void>(done => listener.close(() => done())); origin = 'http://127.0.0.1:' + port
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace,
      autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    await startEngine(); await launchApp(true)
  })
  test.afterAll(async ({}, info) => {
    let evidenceAttached = false
    // Setup failures skip afterEach. Preserve everything unless the full test
    // explicitly reached verification and all evidence has been copied out.
    try {
      if (fixture) {
        evidence('execution-summary.json', { fixture, sessionId, verified, roots, manifests, rollbackRequests: [...rollbackRequests],
          providerRequests: provider?.requests, providerErrors: provider?.errors, errors, observedRequests, generation })
        if (!verified && page && !page.isClosed()) {
          const path = info.outputPath('lifecycle-failure.png')
          await page.screenshot({ path }); await info.attach('lifecycle-failure', { path, contentType: 'image/png' })
        }
        for (const name of readdirSync(join(fixture, 'evidence'))) {
          const path = info.outputPath(name)
          writeFileSync(path, readFileSync(join(fixture, 'evidence', name)))
          await info.attach(name, { path, contentType: 'application/json' })
        }
      }
      const logPath = info.outputPath('engine.log'); writeFileSync(logPath, engineLog)
      await info.attach('engine-log', { path: logPath, contentType: 'text/plain' })
      evidenceAttached = true
    }
    finally {
      provider?.releaseFinal(5)
      try { await app?.close(); app = undefined; await stopEngine() }
      finally {
        provider?.server.closeAllConnections()
        if (provider?.server.listening) await new Promise<void>(done => provider.server.close(() => done()))
      }
    }
    if (verified && evidenceAttached && info.status === 'passed' && fixture && !runner) {
      if (dirname(resolve(fixture)) !== fixtureRoot || !basename(fixture).startsWith('run-')) throw new Error('Unsafe lifecycle cleanup')
      rmSync(owned(fixture), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      if (existsSync(fixtureRoot) && !lstatSync(fixtureRoot).isSymbolicLink() && readdirSync(fixtureRoot).length === 0) rmdirSync(fixtureRoot)
    }
  })
  test('五轮真实文件与交付 → 撤销第五轮 → 撤销二至四轮，刷新和重启保持一致', async ({}, info) => {
    test.setTimeout(600000)
    expect(resolve(info.outputDir).startsWith(resolve(root, '.e2e-tmp') + sep), 'Test output must remain under .e2e-tmp').toBe(true)
    for (const round of rounds) await sendRound(round)
    await assertTurnDiff(2, 'project/src/game.js')
    await assertTurnDiff(4, 'project/index.html')
    await previewAsset(1, 'project/docs/guide.txt') // Source is currently deleted; historical asset remains readable.
    await previewAsset(3, 'project/recycle.txt') // Source now contains round 5, but this asset must still be round 3.
    await assertTree(rounds[4])
    await rollbackFrom(5, 4)
    await page.reload(); await assertRecovered(4, info, 'after-first-rollback-refresh')
    await restart(); await assertRecovered(4, info, 'after-first-rollback-restart')
    await assertTurnDiff(2, 'project/src/game.js')
    await rollbackFrom(2, 1)
    await page.reload(); await assertRecovered(1, info, 'after-second-rollback-refresh')
    await restart(); await assertRecovered(1, info, 'after-second-rollback-restart')
    // The UI must use the atomic backend operation, never leave an observable
    // split between a file rollback and independently truncated messages.
    const repeatedRequest = rollbackRequests.get(2)
    expect(repeatedRequest, 'Retry must reuse the real UI operation key after restart').toBeDefined()
    const beforeRepeat = await snapshot()
    const repeat = await api<RevertReport>('/conversation/rollback', 'POST', { sessionId, ...repeatedRequest!, reviewedCommandChangeIds: [] })
    expect(repeat.historyTruncated).toBe(true); expect(repeat.conflicts + repeat.unavailable + repeat.failed).toBe(0)
    const afterRepeat = await snapshot()
    expect(afterRepeat.runs).toEqual(beforeRepeat.runs); expect(afterRepeat.history).toEqual(beforeRepeat.history)
    await assertDisk(rounds[0]); await assertAssets(1, [2, 3, 4, 5])
    expect(provider.errors).toEqual([]); expect(errors).toEqual([])
    expect(provider.requests.filter(request => request.tool === 'delete_file')).toHaveLength(rounds.flatMap(round => round.operations).filter(operation => operation.kind === 'delete').length)
    evidence('verified-final.json', { remainingRoots: (await snapshot()).runs, disk: diskState(), rounds: rounds.length, engineRestarts: generation - 1,
      onlyUpstreamResponsesScripted: true, realReAct: true, realFileTools: true, realDiskAndSnapshots: true, realRollbackAndHistory: true })
    verified = true
  })
})
