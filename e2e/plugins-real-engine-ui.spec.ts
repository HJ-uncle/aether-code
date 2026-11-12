/** Isolated Electron + real engine + real Node plugin processes. No model call or user data. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import type { PluginRecord } from '../src/renderer/src/core/engine/plugins'
import { newPlugin, pluginSource } from './fixtures/plugin'
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
    await expect(manager().getByLabel('官方模板',{ exact: true })).toHaveValue('json-tool')
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
    expect(rendererErrors).toEqual([])
  } finally {
    try { if (page && !page.isClosed()) await screenshot('real-plugin-final.png') } finally {
      await app?.close()
      if (runner && runner.exitCode === null) { runner.kill(); await new Promise<void>(done => runner!.once('exit',() => done())) }
      if (fixture) { if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe real plugin cleanup'); rmSync(fixture,{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  }
})
