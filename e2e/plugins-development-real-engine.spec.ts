/** Real isolated engine + Electron + source-directory child process and $AE permissions. */
import { fixtureEnrollment } from './fixtures/account-enrollment'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { newPlugin, pluginSource } from './fixtures/plugin'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugin-developer-mode-20261112')
const origin = 'http://127.0.0.1:12548', token = 'development-plugin-e2e-token'
const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined || /(?:API_KEY|TOKEN|SECRET|ENCRYPTION|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|^AETHER_|^DATA_DIR$|^WORKSPACE_ROOT$|^SKILLS_ROOT$|^MCP_CONFIG_PATH$)/i.test(key) ? [] : [[key, value]]))
}
const ui = (version: number): string => `<main style="padding:20px;max-width:600px"><h1>源码质量助手 r${version}</h1><p>直接运行本地工程</p><button id="run">处理输入</button><button id="models">查看模型</button><button id="save">保存设置</button><button id="read">读取设置</button><output id="result" style="display:block;margin-top:20px;white-space:pre-wrap"></output><script>
const show = value => document.querySelector('#result').textContent=JSON.stringify(value);
const action = async operation => { try { show(await operation()) } catch(error) { document.querySelector('#result').textContent=error.message } };
document.querySelector('#run').onclick=()=>action(()=>$AE.invoke('greet',{name:'本地工程'}));
document.querySelector('#models').onclick=()=>action(()=>$AE.models.list());
document.querySelector('#save').onclick=()=>action(()=>$AE.settings.set({value:{threshold:85}}));
document.querySelector('#read').onclick=()=>action(()=>$AE.settings.get());
</script></main>`

test('真实开发模式源码运行、页面刷新、权限保留与撤销及零安装', async ({}, info) => {
  test.setTimeout(180_000)
  mkdirSync(fixtureRoot, { recursive: true })
  const fixture = mkdtempSync(join(fixtureRoot, 'run-')), project = join(fixture, 'source-plugin'), profile = join(fixture, 'profile'), workspace = join(fixture, 'workspace')
  for (const directory of [project, profile, workspace, join(fixture, 'skills'), join(project, 'tools'), join(project, 'ui'), join(project, 'examples')]) mkdirSync(directory, { recursive: true })
  const manifest = { ...newPlugin().manifest, id: 'local-quality-helper', name: '源码质量助手', permissions: { requested: ['models.read', 'settings.read', 'settings.write', 'engine.tools'] },
    contributes: { pages: [{ id: 'review', title: '源码质量助手', kind: 'webview', entry: 'ui/index.html', tools: ['greet'] }] } }
  writeFileSync(join(project, 'aether-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(project, 'tools/greet.mjs'), pluginSource('`SOURCE_R1_${args.name}`'))
  writeFileSync(join(project, 'ui/index.html'), ui(1))
  writeFileSync(join(project, 'examples/cases.json'), JSON.stringify({ cases: [{ name: '默认', tool: 'greet', args: { name: '示例' } }] }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: workspace, appearance: 'light', thinkingMode: 'off' }))
  let app: ElectronApplication | undefined, engine: ChildProcess | undefined, logs = '', accessToken = ''
  const errors: string[] = []
  const api = async (path: string): Promise<{ plugins: unknown[] }> => {
    const response = await fetch(`${origin}/api/v1${path}`, { headers: { 'x-aether-instance-token': token, 'x-aether-tool-profile': 'general', Authorization: `Bearer ${accessToken}` } })
    const body = await response.json() as { code: number; data: { plugins: unknown[] }; message: string }
    if (body.code !== 200) throw new Error(body.message)
    return body.data
  }
  try {
    engine = spawn(process.execPath, [resolve(root, '../ai-agent-engine/dist/main.js')], { cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...cleanEnv(), NODE_ENV: 'development', AUTH_ENABLED: 'false', AETHER_DESKTOP_OWNED: '1', AETHER_DEV_PLUGIN_API: '1', AETHER_DEV_PLUGIN_ROOTS: fixture,
      DATA_DIR: join(fixture, 'agent.db'), MEMORY_DB_PATH: join(fixture, 'memory.db'), WORKSPACE_ROOT: workspace, AETHER_GLOBAL_DIR: join(fixture, 'global'),
      SKILLS_ROOT: join(fixture, 'skills'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      AETHER_INSTANCE_TOKEN: token, AETHER_ENGINE_PORT: '12548', AETHER_ENGINE_HOST: '127.0.0.1', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard', ENABLE_LONG_TERM_MEMORY: 'false'
    } })
    engine.stdout?.on('data', chunk => { logs = (logs + String(chunk)).slice(-30_000) }); engine.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-30_000) })
    await expect.poll(async () => { if (engine?.exitCode !== null) throw new Error(logs); try { return (await fetch(`${origin}/health`)).ok } catch { return false } }, { timeout: 45_000 }).toBe(true)
    const accountResponse = await fetch(`${origin}/auth/account/register`, { method: 'POST', headers: { 'x-aether-instance-token': token, 'content-type': 'application/json' }, body: JSON.stringify({activationCode:await fixtureEnrollment(join(fixture,'agent.db'))}) })
    const account = await accountResponse.json() as { data?: { accessToken?: string }; message?: string }
    if (!accountResponse.ok || !account.data?.accessToken) throw new Error(account.message ?? 'Could not create isolated account')
    accessToken = account.data.accessToken
    app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env: { ...cleanEnv(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_IDE_REMOTE_AUTH_URL: origin, AETHER_IDE_REMOTE_BEARER_TOKEN: accessToken, AETHER_GLOBAL_DIR: join(fixture, 'ide-global') } })
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 45_000 })
    await page.evaluate(key => {
      localStorage.setItem(key, JSON.stringify({ tasks: [], activeTaskId: null, homeDraft: '', homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] } }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'plugins', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, stateKey)
    await page.reload()
    await page.getByRole('region', { name: '插件管理', exact: true }).getByRole('button', { name: '开发模式', exact: true }).click()
    const development = page.getByRole('region', { name: '插件开发模式', exact: true })
    await development.getByRole('textbox', { name: '本地插件工程目录' }).fill(project)
    await development.getByRole('button', { name: '打开开发工程' }).click()
    const frame = page.frameLocator('iframe[title="源码质量助手"]')
    await expect(frame.getByRole('heading')).toHaveText('源码质量助手 r1')
    await frame.getByRole('button', { name: '处理输入' }).click()
    await expect(frame.locator('#result')).toContainText('SOURCE_R1_本地工程')
    await frame.getByRole('button', { name: '查看模型' }).click()
    await expect(frame.locator('#result')).toContainText('尚未获准')
    await development.getByRole('tab', { name: '权限', exact: true }).click()
    for (const name of ['查看可用模型', '读取插件设置', '修改插件设置', '使用基础 Agent 工具']) await development.getByRole('switch', { name: `开发模式允许${name}`, exact: true }).click()
    await development.locator('summary').filter({ hasText: /^Agent 工具$/ }).click()
    const agentTools = development.getByRole('region', { name: 'Agent 工具', exact: true })
    await expect(agentTools.getByRole('switch')).toHaveCount(33)
    for (const name of ['write_file', 'execute_cmd', 'ask_user', 'grep', 'subagent_start', 'list_skills'])
      await expect(agentTools.getByRole('switch', { name: `允许 Agent 工具 ${name}`, exact: true })).toBeAttached()
    for (const name of ['browser_open', 'office_document', 'workbench_context', 'report_artifacts', 'ae_settings_read', 'ae_workspace_write'])
      await expect(agentTools.getByRole('switch', { name: `允许 Agent 工具 ${name}`, exact: true })).toHaveCount(0)
    await agentTools.getByRole('searchbox', { name: '搜索 Agent 工具', exact: true }).fill('read_file')
    const readTool = agentTools.getByRole('switch', { name: '允许 Agent 工具 read_file', exact: true })
    await expect(readTool).toHaveAttribute('aria-checked', 'true')
    await readTool.click(); await expect(readTool).toHaveAttribute('aria-checked', 'false')
    await expect(agentTools.getByRole('status').filter({ hasText: '已禁用 read_file' })).toBeVisible()
    await development.getByRole('tab', { name: '界面预览' }).click()
    await frame.getByRole('button', { name: '查看模型' }).click()
    await expect(frame.locator('#result')).toHaveText('{"models":[]}')
    await frame.getByRole('button', { name: '保存设置' }).click()
    await expect(frame.locator('#result')).toHaveText('{"threshold":85}')
    await frame.getByRole('button', { name: '读取设置' }).click()
    await expect(frame.locator('#result')).toHaveText('{"threshold":85}')
    writeFileSync(join(project, 'tools/greet.mjs'), pluginSource('`SOURCE_R2_${args.name}`'))
    writeFileSync(join(project, 'ui/index.html'), ui(2))
    const updatedManifest = { ...manifest, permissions: { requested: [...manifest.permissions.requested, 'skills.read'] } }
    writeFileSync(join(project, 'aether-plugin.json'), JSON.stringify(updatedManifest))
    await frame.getByRole('button', { name: '处理输入' }).click()
    await expect(frame.locator('#result')).toContainText('源码已变化')
    await development.getByRole('button', { name: '重新读取本地插件' }).click()
    await expect(frame.getByRole('heading')).toHaveText('源码质量助手 r2')
    await frame.getByRole('button', { name: '处理输入' }).click()
    await expect(frame.locator('#result')).toContainText('SOURCE_R2_本地工程')
    await frame.getByRole('button', { name: '查看模型' }).click()
    await expect(frame.locator('#result')).toHaveText('{"models":[]}')
    await development.getByRole('tab', { name: '权限', exact: true }).click()
    await expect(development.getByRole('switch', { name: '开发模式允许查看可用模型', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(development.getByRole('switch', { name: '开发模式允许读取本地 Skills', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(development.getByRole('switch', { name: '开发模式允许读取插件设置', exact: true })).toHaveAttribute('aria-checked', 'true')
    await development.locator('summary').filter({ hasText: /^Agent 工具$/ }).click()
    await agentTools.getByRole('searchbox', { name: '搜索 Agent 工具', exact: true }).fill('read_file')
    await expect(readTool).toHaveAttribute('aria-checked', 'false')
    await readTool.click(); await expect(readTool).toHaveAttribute('aria-checked', 'true')
    await expect(agentTools.getByRole('status').filter({ hasText: '已允许 read_file' })).toBeVisible()
    await development.getByRole('switch', { name: '开发模式允许查看可用模型', exact: true }).click()
    await development.getByRole('tab', { name: '界面预览' }).click()
    await frame.getByRole('button', { name: '查看模型' }).click()
    await expect(frame.locator('#result')).toContainText('尚未获准')
    await development.getByRole('tab', { name: '权限', exact: true }).click()
    await page.screenshot({ path: info.outputPath('development-permissions-light.png'), animations: 'disabled' })
    await page.evaluate(() => document.documentElement.dataset.appearance = 'dark')
    await page.screenshot({ path: info.outputPath('development-permissions-dark.png'), animations: 'disabled' })
    writeFileSync(join(project, 'aether-plugin.json'), JSON.stringify({ ...updatedManifest, id: 'different-quality-helper' }))
    await development.getByRole('button', { name: '重新读取本地插件' }).click()
    await expect(development.getByRole('switch', { name: '开发模式允许读取插件设置', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(development.getByRole('switch', { name: '开发模式允许修改插件设置', exact: true })).toHaveAttribute('aria-checked', 'false')
    await development.getByRole('button', { name: '在浏览器中打开插件', exact: true }).click()
    const browser = page.getByRole('region', { name: '内置浏览器', exact: true })
    await expect(browser.locator('[data-plugin-browser-tab]')).toBeVisible()
    await frame.getByRole('button', { name: '处理输入' }).click()
    await expect(frame.locator('#result')).toContainText('SOURCE_R2_本地工程')
    writeFileSync(join(project, 'tools/greet.mjs'), pluginSource('`SOURCE_BROWSER_R3_${args.name}`'))
    const browserFrame = browser.locator('iframe[title="源码质量助手"]'), beforeRefresh = await browserFrame.getAttribute('src')
    await browser.getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect(browserFrame).not.toHaveAttribute('src', beforeRefresh!)
    await expect(browserFrame).toHaveAttribute('data-ready', 'true')
    await frame.getByRole('button', { name: '处理输入' }).click()
    await expect(frame.locator('#result')).toContainText('SOURCE_BROWSER_R3_本地工程')
    await page.screenshot({ path: info.outputPath('development-browser-dark.png'), animations: 'disabled' })
    expect((await api('/plugins')).plugins).toEqual([])
    expect(readdirSync(project).sort()).toEqual(['aether-plugin.json', 'examples', 'tools', 'ui'])
    await browser.getByRole('button', { name: '关闭网页 源码质量助手', exact: true }).click()
    await expect(browser.locator('[data-plugin-browser-tab]')).toHaveCount(0)
    // Exercise the new native contract end to end: disk -> real engine schema ->
    // uiDocuments -> React controlled input -> real Node child, without installing.
    writeFileSync(join(project, 'ui/native.json'), JSON.stringify({ version: 1, root: { type: 'stack', children: [
      { type: 'heading', text: '真实原生组件' },
      { type: 'input', bind: 'name', label: '原生姓名', value: '开发者' },
      { type: 'button', label: '运行原生工具', action: { tool: 'greet', args: { name: { $field: 'name' } } } }
    ] } }))
    writeFileSync(join(project, 'aether-plugin.json'), JSON.stringify({ ...updatedManifest, id: 'different-quality-helper',
      contributes: { pages: [{ id: 'native', title: '真实原生组件', kind: 'native', entry: 'ui/native.json', tools: ['greet'] }] } }))
    await page.locator('.work-navigation').getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('region', { name: '插件管理', exact: true }).getByRole('button', { name: '开发模式', exact: true }).click()
    await development.getByRole('textbox', { name: '本地插件工程目录' }).fill(project)
    await development.getByRole('button', { name: '打开开发工程' }).click()
    await expect(development.getByRole('heading', { name: '真实原生组件', exact: true })).toBeVisible()
    await development.getByRole('textbox', { name: '原生姓名', exact: true }).fill('原生真实运行')
    await development.getByRole('button', { name: '运行原生工具', exact: true }).click()
    await expect(development.getByLabel('插件操作结果')).toContainText('SOURCE_BROWSER_R3_原生真实运行')
    await page.screenshot({ path: info.outputPath('development-native-dark.png'), animations: 'disabled' })
    expect((await api('/plugins')).plugins).toEqual([])
    expect(errors).toEqual([])
  } finally {
    writeFileSync(join(fixtureRoot, 'latest-engine.log'), logs)
    await app?.close()
    if (engine && engine.exitCode === null) { engine.kill(); await new Promise<void>(done => engine!.once('exit', () => done())) }
    if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe development fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
