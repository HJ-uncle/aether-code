/** Current live acceptance: real DB model, Electron Work, active-run permission switch.
 * No fixture provider; no generated game code is supplied by this harness. */
import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readConfiguredModel } from './gomoku-model-seed.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = join(root, '.ae', 'gomoku-live-' + new Date().toISOString().replace(/[-:.TZ]/g, ''))
const profile = join(runRoot, 'profile'), workspace = process.env.AETHER_GOMOKU_WORKSPACE
  ? resolve(process.env.AETHER_GOMOKU_WORKSPACE) : join(runRoot, 'game')
mkdirSync(profile, { recursive: true }); mkdirSync(workspace, { recursive: true })
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true,
  preferredPort: 12449, lastFolder: '', appearance: 'light', thinkingMode: 'off' }))
const model = readConfiguredModel()
const result = { startedAt: new Date().toISOString(), runRoot, workspace, model: model.modelId, rendererErrors: [], observations: [], passed: false }
const save = () => writeFileSync(join(runRoot, 'result.json'), JSON.stringify(result, null, 2))
const emit = (step, extra = {}) => { console.log(JSON.stringify({ step, ...extra })); save() }
const scrub = error => String(error).split(model.apiKey).join('[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
let app, page
const request = async (method, path, body, query) => {
  const response = await page.evaluate(input => window.aether.engine.request(input), { method, path, body, query, toolProfile: 'general' })
  if (!response.ok) {
    result.lastConnection = await page.evaluate(() => window.aether.engine.getSnapshot()).catch(() => null)
    throw new Error(path + ': ' + response.message)
  }
  return response.data
}
const taskState = () => page.evaluate(() => {
  const snapshot = Object.entries(localStorage).filter(([key]) => key.startsWith('aether.work.state.v1')).map(([, value]) => JSON.parse(value))
  return snapshot.find(value => value.activeTaskId)?.tasks.find(task => task.id === snapshot.find(value => value.activeTaskId)?.activeTaskId) ?? null
})
try {
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(profile, 'global'),
    AETHER_IDE_ENGINE_ENTRY: resolve(root, '..', 'ai-agent-engine', 'dist', 'main.js'),
    WORKSPACE_ROOT: join(runRoot, 'scratch'), AUTH_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard',
    // Use the normal Work capability set so the model can execute its own checks.
    // OSM=off hides execute_cmd even after a security-mode switch.
    ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'balanced', AETHER_IDE_ECHO_ENGINE: '1', SKILLS_ROOT: join(profile, 'skills'), MCP_CONFIG_PATH: join(profile, 'mcp.json') }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], cwd: root, env })
  const capture = chunk => appendFileSync(join(runRoot, 'desktop.log'), scrub(chunk.toString()))
  app.process().stdout?.on('data', capture)
  app.process().stderr?.on('data', capture)
  page = await app.firstWindow()
  page.on('pageerror', error => result.rendererErrors.push(scrub(error)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000))
  await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase), { timeout: 90_000 }).toBe('ready')
  const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
  result.engine = { version: engine.version, buildId: engine.buildId, instanceId: engine.instanceId }
  const account = await page.evaluate(() => window.aether.account.register())
  expect(account.status).toBe('authenticated')
  await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.accountId)).toBe(account.user.id)
  const created = await request('POST', '/models', model)
  await request('PUT', '/models/' + created.id, { isEnabled: true })
  const preflight = await request('POST', '/models/' + created.id + '/test', {})
  expect(preflight.success, 'configured provider preflight').toBe(true)
  emit('configured-real-model', { model: model.modelId })
  // Reload the real client model store after setup through its public IPC API.
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase)).toBe('ready')
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  const work = page.locator('.work-view')
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, workspace)
  await work.locator('.work-folder-button').click()
  await expect(work.locator('.work-folder-button')).toContainText(basename(workspace))
  await work.getByRole('button', { name: 'Work 使用的模型', exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp('^' + (model.displayName || model.modelId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
  const permission = page.getByRole('button', { name: /^切换本会话访问权限：/ }).filter({ visible: true })
  await expect(permission).toContainText('标准模式')
  const prompt = process.env.AETHER_GOMOKU_PROMPT_FILE ? readFileSync(process.env.AETHER_GOMOKU_PROMPT_FILE, 'utf8') : '开发一个可直接打开 index.html 运行的 H5 五子棋游戏，在当前项目目录实际写入全部文件。要求：15×15棋盘，双人黑白轮流落子，四个方向五连胜检测，禁止重复落子和结束后落子，支持悔棋和重新开始，手机和桌面自适应，Apple 风格简洁精致的中文界面，当前执棋与胜负提示清楚。棋盘交叉点采用可操作按钮，给每个点提供中文行列坐标 aria-label，方便键盘及无障碍操作。使用原生 HTML/CSS/JavaScript，不依赖联网资源或安装依赖。请自行运行有意义的规则测试，并提供 README 说明。直接实施完成，不要只给方案。'
  await work.getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  await work.getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(async () => (await taskState())?.id).toMatch(/^work-/)
  result.sessionId = (await taskState()).id
  const status = () => request('GET', '/chat/status', undefined, { sessionId: result.sessionId })
  await expect.poll(async () => (await status()).running, { timeout: 90_000 }).toBe(true)
  result.beforeSwitch = await status()
  expect(result.beforeSwitch.run?.runId).toEqual(expect.any(String))
  emit('task-running-switching', { sessionId: result.sessionId, runId: result.beforeSwitch.run.runId })
  await permission.click()
  await page.getByRole('menuitem', { name: /^完全访问/ }).click()
  await expect(permission).toContainText('完全访问')
  result.security = await request('GET', '/security/mode', undefined, { sessionId: result.sessionId })
  expect(result.security.mode).toBe('full-access')
  result.afterSwitch = await status()
  expect(result.afterSwitch.run.runId).toBe(result.beforeSwitch.run.runId)
  await page.screenshot({ path: join(runRoot, 'work-full-access-active.png') })
  emit('mode-confirmed', { mode: result.security.mode, running: result.afterSwitch.running })
  const deadline = Date.now() + 20 * 60_000
  for (;;) {
    const current = await status()
    result.observations.push({ at: new Date().toISOString(), running: current.running, status: current.run?.status, runId: current.run?.runId })
    save()
    if (!current.running && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(current.run?.status)) {
      result.finalStatus = current; break
    }
    if (Date.now() > deadline) throw new Error('Real model task exceeded 20 minute acceptance budget')
    emit('task-progress', { status: current.run?.status, files: readdirSync(workspace) })
    await delay(15_000)
  }
  result.snapshot = await request('GET', '/chat/snapshot', undefined, { sessionId: result.sessionId })
  writeFileSync(join(runRoot, 'snapshot.json'), JSON.stringify(result.snapshot, null, 2))
  delete result.snapshot
  await page.screenshot({ path: join(runRoot, 'work-completed.png') })
  expect(result.finalStatus.run.status).toBe('succeeded')
  await expect(work.locator('.work-task-heading')).toContainText('已完成')
  expect(existsSync(join(workspace, 'index.html'))).toBe(true)
  expect(result.rendererErrors).toEqual([])
  result.passed = true
  result.finishedAt = new Date().toISOString()
  emit('work-task-passed', { workspace })
} catch (error) {
  result.error = scrub(error)
  await page?.screenshot({ path: join(runRoot, 'failure.png') }).catch(() => {})
  emit('failed', { error: result.error, runRoot })
  process.exitCode = 1
} finally {
  save()
  await app?.close()
}
