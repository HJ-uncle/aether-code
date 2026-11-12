/** Real published currency plugin, installed into an isolated engine and operated through native controls. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import type { PluginRecord } from '../src/renderer/src/core/engine/plugins'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugin-app'), engineEntry = resolve(root, '../ai-agent-engine/dist/main.js')
const origin = 'http://127.0.0.1:12591', token = 'plugin-app-disposable-token'
const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
const sourceProject = join(root, 'e2e/fixtures/currency-converter')
const sourceManifest = JSON.parse(readFileSync(join(sourceProject, 'aether-plugin.json'), 'utf8')) as { version: string }
const sourceFiles = Object.fromEntries(['aether-plugin.json', 'main.mjs', 'README.md', 'package.json', 'examples/cases.json', 'scripts/test.mjs'].map(file => [file, readFileSync(join(sourceProject, file), 'utf8')]))
const examples = JSON.parse(readFileSync(join(sourceProject, 'examples/cases.json'), 'utf8')) as { cases: Array<{ name: string; expected: Record<string, unknown> }> }
const appRegion = (page: Page) => page.getByRole('region', { name: '插件操作页', exact: true })
async function screenshot(page: Page, path: string): Promise<void> {
  await page.screenshot({ path, animations: 'disabled' })
}
function cleanEnv(): Record<string, string> { return Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined || /API_KEY|TOKEN|SECRET|ENCRYPTION|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|^AETHER_|^DATA_DIR$|^WORKSPACE_ROOT$|^SKILLS_ROOT$|^MCP_CONFIG_PATH$/i.test(key) ? [] : [[key, value]])) }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-aether-instance-token': token, 'x-aether-tool-profile': 'general' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json() as { code: number; message: string; data: T }
  if (!response.ok || value.code !== 200) throw new Error(`${path}: ${value.message}`)
  return value.data
}

test('正式货币插件可直接输入、选择币种并换算，固定版本与停用状态真实生效', async ({}, info) => {
  test.setTimeout(180_000)
  mkdirSync(fixtureRoot, { recursive: true })
  const fixture = mkdtempSync(join(fixtureRoot, 'run-')), workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace); mkdirSync(profile); mkdirSync(join(fixture, 'skills'))
  let app: ElectronApplication | undefined, runner: ChildProcess | undefined, page: Page | undefined, log = ''
  const errors: string[] = []
  try {
    const env = { ...cleanEnv(), AUTH_ENABLED: 'false', DATA_DIR: join(fixture, 'agent.db'), MEMORY_DB_PATH: join(fixture, 'memory.db'), WORKSPACE_ROOT: workspace,
      AETHER_GLOBAL_DIR: join(fixture, 'global'), SKILLS_ROOT: join(fixture, 'skills'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), ENCRYPTION_KEY: randomBytes(32).toString('hex'), AETHER_INSTANCE_TOKEN: token,
      AETHER_ENGINE_PORT: '12591', AETHER_ENGINE_HOST: '127.0.0.1', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard', ENABLE_LONG_TERM_MEMORY: 'false' }
    runner = spawn(process.execPath, [engineEntry], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    runner.stdout?.on('data', chunk => { log = (log + String(chunk)).slice(-20000) }); runner.stderr?.on('data', chunk => { log = (log + String(chunk)).slice(-20000) })
    await expect.poll(async () => { if (runner?.exitCode !== null) throw new Error(log); try { return (await fetch(`${origin}/health`)).ok } catch { return false } }, { timeout: 45000 }).toBe(true)
    const preview = await api<{ import: { jobId: string } }>('/plugins/imports/preview', 'POST', { type: 'local', path: sourceProject })
    await api(`/plugins/imports/${preview.import.jobId}/install`, 'POST')
    await api('/plugins/currency-converter/publish', 'POST', { expectedRevision: 1 })
    const published = await api<{ plugin: PluginRecord }>('/plugins/currency-converter')
    const importedFiles = published.plugin.files ?? {}
    const fileComparisons = Object.entries(sourceFiles).map(([path, content]) => ({ path, fixtureSha256: createHash('sha256').update(content).digest('hex'), importedSha256: importedFiles[path] === undefined ? null : createHash('sha256').update(importedFiles[path]).digest('hex'), matches: importedFiles[path] === content }))
    expect(Object.keys(importedFiles)).toHaveLength(5)
    expect(fileComparisons.filter(file => file.path !== 'aether-plugin.json').every(file => file.matches)).toBe(true)
    expect(published.plugin.manifest).toEqual(sourceManifest)
    const expectedSnapshotHash = 'sha256:00b9d6055e87d571bb3dd0516034d7785fcdf477fd9580637f10670473e87fd8'
    expect(published.plugin.revisions.find(item => item.revision === 1)?.hash).toBe(expectedSnapshotHash)
    writeFileSync(info.outputPath('currency-import-identity.json'), JSON.stringify({ projectFileCount: Object.keys(sourceFiles).length, importedFileCount: Object.keys(importedFiles).length, expectedSnapshotHash, fixtureFiles: sourceFiles, importedRecord: published.plugin, fileComparisons, explanation: 'Native importer stores aether-plugin.json as the manifest object, excluding its file mirror. The 5-file native import snapshot hash differs from a 6-file service.create/update snapshot; the executable and other source files match byte for byte.' }, null, 2))
    await api('/plugins/currency-converter', 'PUT', { manifest: { ...published.plugin.manifest, description: '未发布草稿，不得替换正式操作页' }, files: published.plugin.files, expectedRevision: 1 })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: workspace, lastFolder: '', appearance: 'light', thinkingMode: 'off' }))
    app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env: { ...cleanEnv(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'ide-global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 45000 })
    await page.evaluate(key => {
      localStorage.setItem(key, JSON.stringify({ tasks: [], activeTaskId: null, homeDraft: '', homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] } }))
      localStorage.setItem('aether.app.mode', 'work'); localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'plugins', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, stateKey)
    await page.reload()
    await page.getByRole('button', { name: '打开插件 货币换算器', exact: true }).click()
    const application = appRegion(page)
    await expect(application.getByRole('heading', { name: '货币换算器', exact: true })).toBeVisible()
    await expect(application).not.toContainText('未发布草稿')
    await expect(application.getByLabel('插件功能').getByRole('option', { selected: true })).toHaveText('单笔换算')
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.locator('.work-plugin-app__headline')).toHaveText('710.00 CNY')
    await expect(application.locator('.work-plugin-app__result-note')).toContainText('无可验证的数据来源和日期，非实时行情')
    const builtinReceipt = JSON.parse(await application.locator('.work-plugin-app__raw > pre').textContent() ?? '{}') as { result: Record<string, unknown> }
    expect(builtinReceipt.result).toEqual(examples.cases[0].expected)
    await screenshot(page, info.outputPath('currency-app-default.png'))
    await application.getByLabel('金额', { exact: true }).fill('-1')
    await application.getByLabel('金额', { exact: true }).press('Enter')
    await expect(application.getByRole('alert')).toContainText('不能小于 0')
    await expect(application.getByLabel('插件运行结果')).toHaveCount(0)
    await application.getByLabel('金额', { exact: true }).fill('1.005')
    await application.getByLabel('指定汇率', { exact: true }).fill('3')
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.locator('.work-plugin-app__headline')).toHaveText('3.02 CNY')
    const precisionReceipt = JSON.parse(await application.locator('.work-plugin-app__raw > pre').textContent() ?? '{}') as { result: Record<string, unknown> }
    expect(precisionReceipt.result).toMatchObject({ amount: 1.005, from: 'USD', to: 'CNY', rate: 3, result: 3.02, resultText: '3.02 CNY' })
    expect(precisionReceipt.result.expression).toBe('1.005 USD × 3 ≈ 3.02 CNY')
    await application.getByLabel('目标币种', { exact: true }).selectOption('"USD"')
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.getByRole('alert')).toContainText('同币种')
    await expect(application.getByLabel('插件运行结果')).toHaveCount(0)
    await application.getByLabel('目标币种', { exact: true }).selectOption('"CNY"')
    await application.getByLabel('金额', { exact: true }).fill('100000000')
    await application.getByLabel('指定汇率', { exact: true }).fill('7.12345678')
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.locator('.work-plugin-app__expression')).toHaveText('100,000,000 USD × 7.12345678 = 712,345,678.00 CNY')
    const preciseExpressionReceipt = JSON.parse(await application.locator('.work-plugin-app__raw > pre').textContent() ?? '{}') as { result: Record<string, unknown> }
    expect(preciseExpressionReceipt.result).toMatchObject({ amount: 100000000, rate: 7.12345678, rateText: '7.12345678', result: 712345678 })
    await application.getByLabel('金额', { exact: true }).fill('100')
    await application.getByLabel('源币种', { exact: true }).selectOption('"USD"')
    await application.getByLabel('目标币种', { exact: true }).selectOption('"CNY"')
    await application.getByLabel('指定汇率', { exact: true }).fill('7.28')
    await application.getByLabel('指定汇率', { exact: true }).press('Enter')
    await expect(application.locator('.work-plugin-app__headline')).toHaveText('728.00 CNY')
    await expect(application.getByLabel('插件运行结果')).toContainText('汇率来自本次调用参数')
    await expect(application.getByLabel('插件运行结果')).toContainText('r1')
    const explicitReceipt = JSON.parse(await application.locator('.work-plugin-app__raw > pre').textContent() ?? '{}') as { result: Record<string, unknown> }
    expect(explicitReceipt.result).toMatchObject({ amount: 100, from: 'USD', to: 'CNY', rate: 7.28, result: 728, resultText: '728.00 CNY', rateSource: 'direct' })
    await screenshot(page, info.outputPath('currency-app-light.png'))
    await page.evaluate(() => document.documentElement.dataset.appearance = 'dark')
    await screenshot(page, info.outputPath('currency-app-dark.png'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860, 760))
    expect(await application.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await screenshot(page, info.outputPath('currency-app-narrow.png'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 900))
    await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
    await application.getByLabel('插件功能').selectOption('cross_table')
    await expect(application.getByLabel('插件功能').getByRole('option', { selected: true })).toHaveText('汇率表')
    await application.getByLabel('基准币种', { exact: true }).selectOption('"JPY"')
    await application.getByLabel('金额', { exact: true }).fill('10000')
    await application.locator('.work-plugin-app__advanced > summary').click()
    await application.getByLabel('目标币种', { exact: true }).fill('["CNY","USD"]')
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.getByLabel('插件运行结果')).toContainText('10,000 JPY 兑换')
    await expect(application.locator('.work-plugin-app__headline')).toHaveText('10,000 JPY 兑换')
    await expect(application.getByLabel('插件运行结果').getByRole('columnheader', { name: 'rate', exact: true })).toHaveCount(0)
    await expect(application.getByLabel('插件运行结果').getByRole('columnheader', { name: 'result', exact: true })).toHaveCount(0)
    await expect(application.getByLabel('插件运行结果').getByRole('columnheader', { name: 'resultText', exact: true })).toHaveCount(1)
    await expect(application.getByLabel('插件运行结果').getByRole('table')).toContainText('467.11')
    await expect(application.getByLabel('插件运行结果').getByRole('table')).toContainText('65.79')
    const crossReceipt = JSON.parse(await application.locator('.work-plugin-app__raw > pre').textContent() ?? '{}') as { result: Record<string, unknown> }
    expect(crossReceipt.result).toEqual(examples.cases.find(item => item.name === '非默认金额的单位与计算结果一致')?.expected)
    await screenshot(page, info.outputPath('currency-cross-table.png'))
    await api('/plugins/currency-converter', 'PATCH', { enabled: false })
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.getByRole('alert')).toContainText(/停用|启用|发布/)
    await expect(application.getByLabel('插件运行结果')).toHaveCount(0)
    expect((await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), stateKey)).homeResources.toolkits).toEqual([])
    expect(errors).toEqual([])
    const engineMeta = await (await fetch(`${origin}/meta`)).json() as { data?: { buildId?: string } }
    writeFileSync(info.outputPath('currency-app-receipt.json'), JSON.stringify({ fixture: `currency-converter v${sourceManifest.version} reviewed user plugin`, engineBuildId: engineMeta.data?.buildId, publishedRevision: 1, savedDraftRevision: 2, builtin: builtinReceipt, precision: precisionReceipt, preciseExpression: preciseExpressionReceipt, explicit: explicitReceipt, cross: crossReceipt, negativeAmountRejected: true, sameCurrencyInvalidRateRejected: true, agentToolkitsUnchanged: true, disabledInvocationRejected: true, rendererErrors: errors }, null, 2))
  } finally {
    if (page && !page.isClosed() && info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('currency-app-failure.png') })
    await app?.close()
    if (runner && runner.exitCode === null) { runner.kill(); await new Promise<void>(done => runner!.once('exit', () => done())) }
    if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe plugin application fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
