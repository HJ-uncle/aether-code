/** Isolated Electron + real engine + real Node plugin processes. No model call or user data. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import type { PluginRecord } from '../src/renderer/src/core/engine/plugins'
import { newPlugin, pluginSource, pluginArchive } from './fixtures/plugin'
import { selectOption, expectSelectedOption } from './fixtures/select'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugins'), engineEntry = resolve(root, '../ai-agent-engine/dist/main.js')
const origin = 'http://127.0.0.1:12541', token = 'real-plugin-ui-disposable-token'
const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
let app: ElectronApplication | undefined, runner: ChildProcess | undefined, page: Page, fixture = '', logs = ''
const rendererErrors: string[] = []
const manager = () => page.getByRole('region', { name: '插件管理', exact: true })
async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}/api/v1${path}`, { headers: { 'x-aether-instance-token': token, 'x-aether-tool-profile': 'general' } })
  const body = await response.json() as { code: number; message: string; data: T }
  if (!response.ok || body.code !== 200) throw new Error(`${path}: ${body.message}`)
  return body.data
}
async function apiMutation<T>(method: 'PATCH' | 'DELETE', path: string, input?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${origin}/api/v1${path}`, { method,
    headers: { 'x-aether-instance-token': token, 'x-aether-tool-profile': 'general', 'content-type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}) })
  const body = await response.json() as { code: number; message: string; data: T }
  if (!response.ok || body.code !== 200) throw new Error(`${method} ${path}: ${body.message}`)
  return body.data
}
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).flatMap(([key,value]) => value === undefined || /(?:API_KEY|TOKEN|SECRET|ENCRYPTION|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|^AETHER_|^DATA_DIR$|^WORKSPACE_ROOT$|^SKILLS_ROOT$|^MCP_CONFIG_PATH$)/i.test(key) ? [] : [[key,value]]))
}
async function screenshot(name: string): Promise<void> {
  await page.evaluate(async () => {
    for (let pass = 0; pass < 5; pass++) {
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      const animations = document.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') && Number.isFinite(animation.effect?.getComputedTiming().endTime))
      if (!animations.length) return
      await Promise.allSettled(animations.map(animation => animation.finished))
    }
  })
  await page.screenshot({ path: test.info().outputPath(name) })
}

test('真实引擎完成插件编辑、子进程测试、版本固定、导入与AI草稿', async () => {
  test.setTimeout(240_000)
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'real-'))
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace); mkdirSync(profile); mkdirSync(join(fixture, 'skills'))
  const env = { ...cleanEnv(), AUTH_ENABLED: 'false', DATA_DIR: join(fixture, 'agent.db'), MEMORY_DB_PATH: join(fixture, 'memory.db'), WORKSPACE_ROOT: workspace,
    AETHER_GLOBAL_DIR: join(fixture, 'global'), SKILLS_ROOT: join(fixture, 'skills'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AETHER_INSTANCE_TOKEN: token, AETHER_ENGINE_PORT: '12541', AETHER_ENGINE_HOST: '127.0.0.1', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', LOG_LEVEL: 'warn',
    QA_LOG_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard', ENABLE_LONG_TERM_MEMORY: 'false' }
  try {
    runner = spawn(process.execPath, [engineEntry], { cwd: fixture, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    runner.stdout?.on('data', chunk => { logs = (logs + String(chunk)).slice(-30_000) }); runner.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-30_000) })
    await expect.poll(async () => { if (runner?.exitCode !== null) throw new Error(`Engine exited: ${logs}`); try { return (await fetch(`${origin}/health`)).ok } catch { return false } }, { timeout: 45_000 }).toBe(true)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: workspace, lastFolder: '', appearance: 'light', thinkingMode: 'off' }))
    app = await electron.launch({ args: [join(root,'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root,
      env: { ...cleanEnv(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture,'ide-global') } })
    page = await app.firstWindow(); page.on('pageerror', error => rendererErrors.push(error.message))
    await app.evaluate(({ BrowserWindow },directory) => BrowserWindow.getAllWindows()[0].webContents.session.on('will-download',(_event,item) => item.setSavePath(`${directory}/${item.getFilename()}`)),fixture)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320,900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 45_000 })
    await page.evaluate(key => {
      localStorage.setItem(key, JSON.stringify({ tasks: [], activeTaskId: null, homeDraft: '', homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] } }))
      localStorage.setItem('aether.app.mode','work'); localStorage.setItem('aether.work.view.v1',JSON.stringify({ page: 'plugins', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, stateKey)
    await page.reload()
    await manager().getByRole('button',{ name: '新建插件', exact: true }).click()
    await expectSelectedOption(manager().getByLabel('官方模板',{ exact: true }), 'json-tool', '基础 JSON 工具')
    await manager().getByLabel('名称',{ exact: true }).fill('真实问候助手')
    await manager().getByLabel('标识',{ exact: true }).fill('real-greeting')
    await manager().getByRole('tab',{ name: '源文件', exact: true }).click()
    await manager().getByRole('textbox',{ name: '源文件 main.mjs' }).fill(pluginSource('`REAL_HELLO_${args.text}`'))
    await manager().getByRole('button',{ name: '保存草稿', exact: true }).click()
    await expect(manager().getByRole('status')).toContainText('草稿已保存')
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.revision).toBe(1)
    const saved = (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin
    expect(Object.keys(saved.files!)).toEqual(expect.arrayContaining(['aether-plugin.json','main.mjs','README.md','examples/cases.json']))
    expect(JSON.parse(saved.files!['aether-plugin.json'])).toEqual(saved.manifest)
    await manager().getByRole('button',{ name:'导出插件 ZIP',exact:true }).click()
    const archivePath = join(fixture,'real-greeting-r1.zip')
    await expect.poll(() => { try { return readFileSync(archivePath).length } catch { return 0 } }).toBeGreaterThan(100)
    const exported = await JSZip.loadAsync(readFileSync(archivePath))
    expect(JSON.parse(await exported.file('aether-plugin.json')!.async('string'))).toEqual(saved.manifest)
    expect(await exported.file('main.mjs')!.async('string')).toBe(saved.files!['main.mjs'])
    await manager().getByRole('tab',{ name: '测试', exact: true }).click()
    await expect(manager().getByRole('textbox',{ name: '测试参数 JSON' })).toHaveValue(/Hello/)
    await manager().getByRole('textbox',{ name: '测试参数 JSON' }).fill('{"text":"Aether"}')
    await manager().getByRole('button',{ name: '运行测试', exact: true }).click()
    await expect(manager().getByLabel('插件测试结果')).toContainText('REAL_HELLO_Aether')
    await screenshot('real-plugin-test-light.png')
    await manager().getByRole('button',{ name: '发布并启用', exact: true }).click()
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.publishedRevision).toBe(1)
    await manager().getByRole('tab',{ name: '概览', exact: true }).click()
    await manager().getByRole('textbox',{ name: '用途', exact: true }).fill('r2草稿不会覆盖已发布版本')
    await manager().getByRole('button',{ name: '保存草稿', exact: true }).click()
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.revision).toBe(2)
    expect((await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.publishedRevision).toBe(1)
    await manager().getByRole('button',{ name: '返回插件列表', exact: true }).click()
    await manager().getByRole('switch',{ name: '启用插件 真实问候助手', exact: true }).click()
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.enabled).toBe(false)
    await manager().getByRole('switch',{ name: '启用插件 真实问候助手', exact: true }).click()
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.enabled).toBe(true)
    for (const kind of ['directory','archive'] as const) {
      const template = newPlugin(), manifest = { ...template.manifest, id: `real-${kind}`, name: `真实导入 ${kind}` }
      const files = { 'aether-plugin.json': JSON.stringify(manifest), ...template.files }
      await manager().getByRole('button',{ name: '导入', exact: true }).click()
      await manager().getByRole('tab',{ name: kind === 'directory' ? '本地目录' : 'ZIP 文件', exact: true }).click()
      if (kind === 'directory') {
        const directory = join(fixture,'native-plugin'); mkdirSync(join(directory,'tools'),{ recursive: true })
        for (const [name,content] of Object.entries(files)) writeFileSync(join(directory,name),content)
        await manager().getByLabel('引擎所在电脑的目录',{ exact: true }).fill(directory)
      } else {
        const zip = new JSZip(); for (const [name,content] of Object.entries(files)) zip.file(name,content)
        await manager().locator('input[type=file]').setInputFiles({ name: 'real-plugin.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) })
      }
      await manager().getByRole('button',{ name: '预览插件', exact: true }).click()
      await expect(manager().getByRole('heading',{ name: manifest.name, exact: true })).toBeVisible()
      await manager().getByRole('button',{ name: '安装插件', exact: true }).click()
      await expect(manager().getByRole('button',{ name: `打开插件 ${manifest.name}`, exact: true })).toBeVisible()
      expect((await api<{ plugin: PluginRecord }>(`/plugins/${manifest.id}`)).plugin.enabled).toBe(false)
    }
    await screenshot('real-plugin-list-light.png')
    await page.evaluate(() => document.documentElement.dataset.appearance = 'dark')
    await screenshot('real-plugin-list-dark.png')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860,760))
    expect(await manager().evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await screenshot('real-plugin-list-narrow.png')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320,900))
    await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
    await manager().getByRole('button',{ name: 'AI 创建', exact: true }).click()
    const input = page.locator('.work-view [contenteditable=true][role=textbox]:visible')
    await expect(input.locator('.mention-chip--toolkit')).toHaveText('插件管理')
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @真实问候')
    await page.locator('.mention-ref-picker:visible [data-toolkit-id="plugin-real-greeting--r1"]').click()
    await expect(input.locator('.mention-chip--toolkit')).toHaveCount(2)
    await page.getByRole('navigation').getByRole('button',{ name: '插件', exact: true }).click()
    await manager().getByRole('button',{ name: '编辑插件 真实问候助手', exact: true }).click()
    await manager().getByRole('button',{ name: '发布并启用', exact: true }).click()
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-greeting')).plugin.publishedRevision).toBe(2)
    await page.getByRole('navigation').getByRole('button',{ name: '工作台', exact: true }).click()
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @真实问候')
    await page.locator('.mention-ref-picker:visible [data-toolkit-id="plugin-real-greeting--r2"]').click()
    await expect(input.locator('.mention-chip--toolkit')).toHaveCount(2)
    await expect.poll(async () => (await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'),stateKey)).homeResources.toolkits).toEqual(['plugin-management','plugin-real-greeting--r2'])
    await expect(page.locator('.mention-ref-picker:visible')).toHaveCount(0)
    await screenshot('real-plugin-ai-draft.png')

    // Follow the official template through the actual management HTTP API, sealed HTML
    // loader, sandbox bridge and Node tool; no engine/application result is mocked here.
    await page.getByRole('navigation').getByRole('button',{ name: '插件', exact: true }).click()
    await manager().getByRole('button',{ name: '新建插件', exact: true }).click()
    await selectOption(manager().getByLabel('官方模板',{ exact: true }), 'desktop-timer', '桌面计时器')
    await expectSelectedOption(manager().getByLabel('官方模板',{ exact: true }), 'desktop-timer', '桌面计时器')
    await expect(manager().getByLabel('名称',{ exact: true })).toHaveValue('计时器')
    await manager().getByLabel('名称',{ exact: true }).fill('真实桌面计时器')
    await manager().getByLabel('标识',{ exact: true }).fill('real-desktop-timer')
    await manager().getByRole('button',{ name: '保存草稿', exact: true }).click()
    await expect(manager().getByRole('status')).toContainText('草稿已保存')
    const timerRecord = (await api<{ plugin: PluginRecord }>('/plugins/real-desktop-timer')).plugin
    expect(timerRecord.manifest.contributes?.pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'timer', kind: 'webview', entry: 'ui/index.html' })]))
    expect(timerRecord.files?.['ui/index.html']).toContain('aetherPlugin.services.start')
    await manager().getByRole('button',{ name: '发布并启用', exact: true }).click()
    await expect.poll(async () => (await api<{ plugin: PluginRecord }>('/plugins/real-desktop-timer')).plugin.publishedRevision).toBe(1)
    const timerNavigation = page.locator('.work-navigation').getByRole('button',{ name: '计时器', exact: true })
    await expect(timerNavigation).toBeVisible()
    await timerNavigation.click()
    const timerFrame = page.frameLocator('iframe[title="计时器"]')
    await expect(page.locator('iframe[title="计时器"]')).toHaveAttribute('src', /^aether-plugin-ui:\/\/document\//)
    await expect(timerFrame.getByRole('heading',{ name: '计时器', exact: true })).toBeVisible()
    await timerFrame.getByRole('spinbutton',{ name: '秒数', exact: true }).fill('5')
    await timerFrame.getByRole('button',{ name: '开始', exact: true }).click()
    await expect(timerFrame.locator('#state')).toHaveText('计时中')
    await expect(timerFrame.locator('#detail')).toHaveText('5 秒倒计时')
    await page.getByRole('navigation').getByRole('button',{ name: '插件', exact: true }).click()
    await expect(page.locator('iframe[title="计时器"]')).toHaveCount(0)
    await page.locator('.service-tray__button').click()
    const servicePanel = page.locator('.service-tray__panel')
    await servicePanel.getByRole('tab',{ name: '服务', exact: true }).click()
    const timerService = servicePanel.locator('.service-tray__row').filter({ hasText: '计时器' })
    await expect(timerService).toContainText('运行中')
    await expect(timerService).toContainText('已完成',{ timeout: 12_000 })
    await servicePanel.getByRole('tab',{ name: /^通知/ }).click()
    await expect(timerService).toContainText('已完成')
    await expect(timerService).toHaveAttribute('data-unread','true')
    await timerService.getByRole('button',{ name: '更多操作：计时器', exact: true }).click()
    await page.getByRole('menuitem',{ name: '打开服务', exact: true }).click()
    await expect(servicePanel).toBeHidden()
    await expect(timerFrame.getByRole('heading',{ name: '计时器', exact: true })).toBeVisible()
    await expect(timerFrame.locator('#state')).toHaveText('时间到')
    await expect(timerFrame.locator('#detail')).toHaveText('已完成')
    await screenshot('real-plugin-timer-completed.png')

    // Mutate through the real engine from outside the renderer. The management page
    // is unmounted, so only the catalogue stream can update these contribution slots.
    await page.getByRole('navigation').getByRole('button', { name: '工作台', exact: true }).click()
    await expect(manager()).toHaveCount(0)
    await page.evaluate(() => { document.body.dataset.realPluginLifecycle = 'same-document' })
    const disabledTimer = await apiMutation<{ plugin: PluginRecord }>('PATCH', '/plugins/real-desktop-timer', { enabled: false })
    expect(disabledTimer.plugin.enabled).toBe(false)
    await expect(timerNavigation).toHaveCount(0)
    await page.locator('.service-tray__button').click()
    await servicePanel.getByRole('tab', { name: '服务', exact: true }).click()
    await expect(timerService).toHaveCount(0)
    const enabledTimer = await apiMutation<{ plugin: PluginRecord }>('PATCH', '/plugins/real-desktop-timer', { enabled: true })
    expect(enabledTimer.plugin.enabled).toBe(true)
    expect(enabledTimer.plugin.publishedRevision).toBe(1)
    await expect(timerNavigation).toBeVisible()
    await expect(timerService).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(servicePanel).toBeHidden()
    await timerNavigation.click()
    await expect(timerFrame.getByRole('heading', { name: '计时器', exact: true })).toBeVisible()
    await expect(timerFrame.locator('#state')).toHaveText('就绪')
    await timerFrame.getByRole('spinbutton', { name: '秒数', exact: true }).fill('30')
    await timerFrame.getByRole('button', { name: '开始', exact: true }).click()
    await expect(timerFrame.locator('#state')).toHaveText('计时中')
    await expect(timerFrame.locator('#detail')).toHaveText('30 秒倒计时')
    await timerFrame.getByRole('button', { name: '停止', exact: true }).click()
    await expect(timerFrame.locator('#state')).toHaveText('已停止')
    await page.getByRole('navigation').getByRole('button', { name: '工作台', exact: true }).click()
    await apiMutation('DELETE', '/plugins/real-desktop-timer', { expectedRevision: 1 })
    await expect(timerNavigation).toHaveCount(0)
    await expect(page.locator('iframe[title="计时器"]')).toHaveCount(0)
    await page.locator('.service-tray__button').click()
    await servicePanel.getByRole('tab', { name: '服务', exact: true }).click()
    await expect(timerService).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect((await api<{ plugins: PluginRecord[] }>('/plugins')).plugins.some(plugin => plugin.id === 'real-desktop-timer')).toBe(false)
    await expect(page.locator('body')).toHaveAttribute('data-real-plugin-lifecycle', 'same-document')
    await screenshot('real-plugin-background-lifecycle.png')
    expect(rendererErrors).toEqual([])
  } finally {
    try { if (page && !page.isClosed()) await screenshot('real-plugin-final.png') } finally {
      await app?.close()
      if (runner && runner.exitCode === null) { runner.kill(); await new Promise<void>(done => runner!.once('exit',() => done())) }
      if (fixture) { if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe real plugin cleanup'); rmSync(fixture,{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  }
})

test('真实引擎批量导入混合ZIP与交付总包，勾选决定安装且已安装标识不会覆盖', async () => {
  test.setTimeout(240_000)
  mkdirSync(fixtureRoot,{ recursive: true })
  const owned = mkdtempSync(join(fixtureRoot,'real-batch-')), workspace = join(owned,'workspace'), profile = join(owned,'profile')
  mkdirSync(workspace); mkdirSync(profile); mkdirSync(join(owned,'skills'))
  let engine: ChildProcess | undefined, desktop: ElectronApplication | undefined, window: Page | undefined, engineLogs = ''
  const errors: string[] = []
  const env = { ...cleanEnv(), AUTH_ENABLED: 'false', DATA_DIR: join(owned,'agent.db'), MEMORY_DB_PATH: join(owned,'memory.db'), WORKSPACE_ROOT: workspace,
    AETHER_GLOBAL_DIR: join(owned,'global'), SKILLS_ROOT: join(owned,'skills'), MCP_CONFIG_PATH: join(owned,'mcp.json'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AETHER_INSTANCE_TOKEN: token, AETHER_ENGINE_PORT: '12541', AETHER_ENGINE_HOST: '127.0.0.1', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', LOG_LEVEL: 'warn',
    QA_LOG_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard', ENABLE_LONG_TERM_MEMORY: 'false' }
  try {
    engine = spawn(process.execPath,[engineEntry],{ cwd: owned, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    engine.stdout?.on('data',chunk => { engineLogs = (engineLogs + String(chunk)).slice(-30_000) }); engine.stderr?.on('data',chunk => { engineLogs = (engineLogs + String(chunk)).slice(-30_000) })
    await expect.poll(async () => { if (engine?.exitCode !== null) throw new Error(`Engine exited: ${engineLogs}`); try { return (await fetch(`${origin}/health`)).ok } catch { return false } },{ timeout: 45_000 }).toBe(true)
    writeFileSync(join(profile,'settings.json'),JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: workspace, lastFolder: '', appearance: 'light', thinkingMode: 'off' }))
    desktop = await electron.launch({ args: [join(root,'out/main/index.js'),`--user-data-dir=${profile}`], cwd: root,
      env: { ...cleanEnv(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(owned,'ide-global') } })
    window = await desktop.firstWindow(); window.on('pageerror',error => errors.push(error.message))
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320,900))
    await expect(window.locator('.status-bar')).toContainText('引擎：就绪',{ timeout: 45_000 })
    await window.evaluate(key => {
      localStorage.setItem(key,JSON.stringify({ tasks: [], activeTaskId: null, homeDraft: '', homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] } }))
      localStorage.setItem('aether.work.view.v1',JSON.stringify({ page: 'plugins', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    },stateKey)
    await window.reload()
    const view = window.getByRole('region',{ name: '插件管理', exact: true })
    const openImport = async () => { await view.getByRole('button',{ name: '导入', exact: true }).click(); await view.getByRole('tab',{ name: 'ZIP 文件', exact: true }).click() }
    await openImport()
    await view.locator('input[type=file]').setInputFiles([
      { name: 'selected.zip', mimeType: 'application/zip', buffer: await pluginArchive('real-batch-selected','真实批量选择') },
      { name: 'unselected.zip', mimeType: 'application/zip', buffer: await pluginArchive('real-batch-unselected','真实取消选择') },
      { name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('deliberately invalid ZIP fixture') }
    ])
    await view.getByRole('button',{ name: '预览插件', exact: true }).click()
    let list = view.getByRole('list',{ name: '待导入插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect(list.getByRole('listitem').filter({ hasText: 'broken.zip' })).toContainText(/无法读取|失败/)
    await list.getByRole('checkbox',{ name: '选择 真实取消选择', exact: true }).uncheck()
    await view.getByRole('button',{ name: '导入所选（1）', exact: true }).click()
    await expect(list.locator('[data-plugin-id="real-batch-selected"]')).toContainText('已导入')
    expect((await api<{ plugins: PluginRecord[] }>('/plugins')).plugins.map(plugin => plugin.id)).toEqual(['real-batch-selected'])
    await view.getByRole('button',{ name: '完成', exact: true }).click()

    // An explicit delivery ZIP exercises the exact artifact shipped to the user. When
    // absent in a fresh checkout, retain a self-contained nested-bundle regression.
    const deliveredPath = process.env.AETHER_PLUGIN_DELIVERY_BUNDLE ?? resolve(root,'../ai-agent-engine/.e2e-tmp/plugin-real-world-20261112/delivery/release-2/aether-real-world-plugins.zip')
    let bundleBytes: Buffer
    if (process.env.AETHER_PLUGIN_DELIVERY_BUNDLE || existsSync(deliveredPath)) bundleBytes = readFileSync(deliveredPath)
    else {
      const fallback = new JSZip()
      fallback.file('fixture/plugins/bundle-one.zip',await pluginArchive('bundle-one','总包插件一'))
      fallback.file('fixture/plugins/bundle-two.zip',await pluginArchive('bundle-two','总包插件二'))
      fallback.file('fixture/README.md','# Import bundle fixture')
      bundleBytes = await fallback.generateAsync({ type: 'nodebuffer' })
    }
    const bundle = await JSZip.loadAsync(bundleBytes), sourcePlugins: Array<{ manifest: PluginRecord['manifest']; entry: string }> = []
    for (const entry of Object.values(bundle.files).filter(entry => !entry.dir && /(?:^|\/)plugins\/[^/]+\.zip$/.test(entry.name))) {
      const nested = await JSZip.loadAsync(await entry.async('nodebuffer'))
      const manifestFile = nested.file('aether-plugin.json')
      expect(manifestFile,entry.name).not.toBeNull()
      const manifest = JSON.parse(await manifestFile!.async('string')) as PluginRecord['manifest']
      const toolFile = nested.file(manifest.tools[0].entry)
      expect(toolFile,manifest.tools[0].entry).not.toBeNull()
      sourcePlugins.push({ manifest, entry: await toolFile!.async('string') })
    }
    expect(sourcePlugins.length).toBeGreaterThanOrEqual(2)
    if (process.env.AETHER_PLUGIN_DELIVERY_BUNDLE || existsSync(deliveredPath)) expect(sourcePlugins).toHaveLength(10)
    await openImport()
    await view.locator('input[type=file]').setInputFiles({ name: 'aether-real-world-plugins.zip', mimeType: 'application/zip', buffer: bundleBytes })
    await view.getByRole('button',{ name: '预览插件', exact: true }).click()
    list = view.getByRole('list',{ name: '待导入插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(sourcePlugins.length)
    for (const { manifest } of sourcePlugins) await expect(list.locator(`[data-plugin-id="${manifest.id}"]`).getByRole('checkbox')).toBeChecked()
    await window.screenshot({ path: test.info().outputPath('real-delivery-bundle-preview-light.png'), animations: 'disabled' })
    await window.evaluate(() => document.documentElement.dataset.appearance = 'dark')
    await window.screenshot({ path: test.info().outputPath('real-delivery-bundle-preview-dark.png'), animations: 'disabled' })
    writeFileSync(test.info().outputPath('real-batch-dark-button-colors.json'), JSON.stringify(await list.locator('button').evaluateAll(buttons => buttons.map(button => ({ label: button.getAttribute('aria-label'), disabled: (button as HTMLButtonElement).disabled, color: getComputedStyle(button).color, opacity: getComputedStyle(button).opacity, svgColor: getComputedStyle(button.querySelector('svg') ?? button).color }))), null, 2))
    await window.evaluate(() => document.documentElement.dataset.appearance = 'light')
    expect((await api<{ plugins: PluginRecord[] }>('/plugins')).plugins).toHaveLength(1)
    await view.getByRole('checkbox',{ name: '全选可导入插件', exact: true }).uncheck()
    for (const { manifest } of sourcePlugins.slice(0,2)) await list.locator(`[data-plugin-id="${manifest.id}"]`).getByRole('checkbox').check()
    await view.getByRole('button',{ name: '导入所选（2）', exact: true }).click()
    await expect.poll(async () => (await api<{ plugins: PluginRecord[] }>('/plugins')).plugins.length).toBe(3)
    for (const { manifest } of sourcePlugins.slice(0,2)) await expect(list.locator(`[data-plugin-id="${manifest.id}"]`)).toContainText('已导入')
    if (sourcePlugins.length > 2) {
      await view.getByRole('checkbox',{ name: '全选可导入插件', exact: true }).check()
      await view.getByRole('button',{ name: `导入所选（${sourcePlugins.length - 2}）`, exact: true }).click()
    }
    for (const { manifest, entry } of sourcePlugins) {
      await expect(list.locator(`[data-plugin-id="${manifest.id}"]`)).toContainText('已导入')
      const installed = (await api<{ plugin: PluginRecord }>(`/plugins/${manifest.id}`)).plugin
      expect(installed.manifest).toEqual(manifest)
      expect(installed.files?.[manifest.tools[0].entry]).toBe(entry)
      expect(installed.revision).toBe(1); expect(installed.enabled).toBe(false); expect(installed.publishedRevision).toBeUndefined()
    }
    expect((await api<{ plugins: PluginRecord[] }>('/plugins')).plugins).toHaveLength(sourcePlugins.length + 1)
    await window.screenshot({ path: test.info().outputPath('real-batch-imported.png') })
    await view.getByRole('button',{ name: '完成', exact: true }).click()
    await openImport()
    await view.locator('input[type=file]').setInputFiles({ name: 'same-bundle.zip', mimeType: 'application/zip', buffer: bundleBytes })
    await view.getByRole('button',{ name: '预览插件', exact: true }).click()
    list = view.getByRole('list',{ name: '待导入插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(sourcePlugins.length)
    for (const { manifest } of sourcePlugins) await expect(list.locator(`[data-plugin-id="${manifest.id}"]`).getByRole('checkbox')).toBeDisabled()
    await expect(view.getByRole('button',{ name: '导入所选（0）', exact: true })).toBeDisabled()
    expect((await api<{ plugins: PluginRecord[] }>('/plugins')).plugins.every(plugin => plugin.revision === 1)).toBe(true)
    await window.screenshot({ path: test.info().outputPath('real-batch-duplicate-blocked.png') })
    expect(errors).toEqual([])
  } finally {
    try { if (window && !window.isClosed()) await window.screenshot({ path: test.info().outputPath('real-batch-final.png') }) } finally {
      await desktop?.close()
      if (engine && engine.exitCode === null) { engine.kill(); await new Promise<void>(done => engine!.once('exit',() => done())) }
      if (dirname(resolve(owned)) !== fixtureRoot) throw new Error('Unsafe real batch plugin cleanup')
      rmSync(owned,{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
