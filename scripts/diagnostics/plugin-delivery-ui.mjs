/** Real desktop import -> publish -> custom UI -> save -> restart acceptance.
 * Usage: node scripts/diagnostics/plugin-delivery-ui.mjs <index.json>
 * index: [{id,zip,uiModule}]. All profiles/results stay under .e2e-tmp.
 * No production model, credentials or data are loaded. Native save dialogs alone
 * are redirected to the isolated export directory; file writes are real. */
import { _electron as electron, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const indexPath = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Supply the acceptance index JSON path')
const items = JSON.parse(readFileSync(indexPath, 'utf8'))
const output = join(root, '.e2e-tmp/plugin-real-world-20261112', `delivery-ui-${Date.now()}`)
const profile = join(output, 'profile'), proxyRoot = join(output, 'runtime'), workspace = join(output, 'workspace')
for (const path of [profile, workspace, join(proxyRoot, 'runtime'), join(output, 'skills')]) mkdirSync(path, { recursive: true })
const engineEntry = resolve(root, '../ai-agent-engine/dist/main.js'), proxy = join(proxyRoot, 'entry.mjs')
writeFileSync(proxy, `import ${JSON.stringify(pathToFileURL(engineEntry).href)}\n`)
copyFileSync(join(dirname(engineEntry), 'runtime/build-manifest.json'), join(proxyRoot, 'runtime/build-manifest.json'))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true,
  preferredPort: 12587, lastFolder: '', appearance: 'light', thinkingMode: 'off' }))
const env = Object.fromEntries(Object.entries(process.env).filter(([key,value]) => value !== undefined &&
  !/(?:API_KEY|TOKEN|SECRET|ENCRYPTION|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|^AETHER_|^DATA_DIR$|^MEMORY_DB_PATH$|^WORKSPACE_ROOT$|^SKILLS_ROOT$|^MCP_CONFIG_PATH$)/i.test(key)))
Object.assign(env, { AETHER_IDE_ENGINE_ENTRY: proxy, AETHER_GLOBAL_DIR: join(output, 'global'),
  MEMORY_DB_PATH: join(output, 'memory.db'), SKILLS_ROOT: join(output, 'skills'), MCP_CONFIG_PATH: join(output, 'mcp.json'),
  AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false',
  DEFAULT_SECURITY_MODE: 'standard', ENABLE_LONG_TERM_MEMORY: 'false' })
let app, page
const report = { indexPath, output, startedAt: new Date().toISOString(), host: null, plugins: [], errors: [] }
const manager = () => page.getByRole('region', { name: '插件管理', exact: true })
const nav = () => page.locator('.work-navigation')
const sessionId = 'work-plugin-delivery-validation'
async function call(method, path, body) {
  const response = await page.evaluate(input => window.aether.engine.request(input), { method, path, body, toolProfile: 'general' })
  assert.equal(response.ok, true, `${method} ${path}: ${response.message}`)
  return response.data
}
async function launch() {
  app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow()
  page.setDefaultTimeout(25000)
  page.on('pageerror', error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 980))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
}
async function theme(appearance) {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: '外观', exact: true }).click()
  await dialog.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
async function screenshot(path) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.allSettled(finite.map(animation => animation.finished))
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))))
  })
  await page.screenshot({ path, animations: 'disabled' })
}
try {
  await launch()
  report.host = await page.evaluate(() => window.aether.engine.getSnapshot())
  assert.equal(report.host.mode, 'embedded'); assert.equal(report.host.entryPath, proxy)
  assert.equal(resolve(report.host.dataDir), join(profile, 'engine/state/agent.db'))
  await call('POST', '/workspace/bind', { sessionId, workspaceRoot: workspace })
  await page.evaluate(({ sessionId, workspace }) => {
    localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: sessionId, title: '插件交付验收', status: 'done',
      draft: '', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { sessionId, workspace })
  await page.reload()
  await expect(page.locator('.work-task-heading h1')).toHaveText('插件交付验收')
  for (const item of items) {
    const evidence = { id: item.id, status: 'running', assertions: [], screenshots: [] }
    report.plugins.push(evidence)
    const itemDir = join(output, item.id), exportDir = join(itemDir, 'exports')
    mkdirSync(exportDir, { recursive: true })
    try {
      const archive = await JSZip.loadAsync(readFileSync(item.zip))
      const manifest = JSON.parse(await archive.file('aether-plugin.json').async('string'))
      assert.equal(manifest.id, item.id)
      evidence.sha256 = createHash('sha256').update(readFileSync(item.zip)).digest('hex')
      await nav().getByRole('button', { name: '插件', exact: true }).click()
      await manager().getByRole('button', { name: '导入', exact: true }).click()
      await manager().getByRole('tab', { name: 'ZIP 文件', exact: true }).click()
      await manager().locator('input[type=file]').setInputFiles(item.zip)
      await manager().getByRole('button', { name: '预览插件', exact: true }).click()
      await expect(manager().getByRole('heading', { name: manifest.name, exact: true })).toBeVisible()
      await manager().getByRole('button', { name: '安装插件', exact: true }).click()
      await expect(manager().getByRole('button', { name: `编辑插件 ${manifest.name}`, exact: true })).toBeVisible()
      const installed = (await call('GET', `/plugins/${item.id}`)).plugin
      assert.equal(installed.enabled, false)
      await manager().getByRole('button', { name: `编辑插件 ${manifest.name}`, exact: true }).click()
      await manager().getByRole('button', { name: '发布并启用', exact: true }).click()
      await expect.poll(async () => (await call('GET', `/plugins/${item.id}`)).plugin.enabled).toBe(true)
      const published = (await call('GET', `/plugins/${item.id}`)).plugin
      evidence.revision = published.publishedRevision
      evidence.assertions.push('ZIP imported and published through actual desktop controls')
      const casesFile = archive.file('examples/cases.json')
      const cases = casesFile ? JSON.parse(await casesFile.async('string')).cases : []
      evidence.exampleErrors = []
      for (const testCase of cases ?? []) {
        try {
          const result = await call('POST', `/plugins/runtime/apps/${item.id}/invoke`, { revision: published.publishedRevision, tool: testCase.tool, args: testCase.args })
          assert.deepEqual(result.result, testCase.expected, `${item.id}: ${testCase.name}`)
        } catch (error) { evidence.exampleErrors.push({ name: testCase.name, error: String(error) }) }
      }
      evidence.exampleCases = cases?.length ?? 0
      const declaration = manifest.contributes.pages.find(entry => entry.kind === 'webview')
      const navigation = manifest.contributes.navigation.find(entry => entry.page === declaration.id)
      await nav().getByRole('button', { name: navigation.title, exact: true }).click()
      const iframe = page.locator(`iframe[title=${JSON.stringify(declaration.title)}]`)
      await expect(iframe).toHaveAttribute('data-ready', 'true')
      const frame = iframe.contentFrame()
      const context = await frame.locator('body').evaluate(() => window.aetherPlugin.context())
      assert.equal(context.pluginId, item.id); assert.equal(context.sessionId, sessionId)
      assert.equal(resolve(context.workspacePath), workspace)
      await app.evaluate(({ dialog }, directory) => {
        globalThis.__pluginDeliveryCancelNextSave = false
        dialog.showSaveDialog = async (_owner, options) => {
          if (globalThis.__pluginDeliveryCancelNextSave) {
            globalThis.__pluginDeliveryCancelNextSave = false
            return { canceled: true }
          }
          return { canceled: false, filePath: directory + '/' + options.defaultPath }
        }
      }, exportDir)
      const setNextSaveCanceled = () => app.evaluate(() => { globalThis.__pluginDeliveryCancelNextSave = true })
      const scenario = await import(pathToFileURL(resolve(item.uiModule)).href)
      evidence.ui = await scenario[item.exportName ?? 'run']({ pluginId: item.id, page, frame, expect, outputDir: exportDir, workspace, call, setNextSaveCanceled })
      assert.ok(readdirSync(exportDir).length > 0, 'UI export must create actual files')
      for (const download of evidence.ui?.downloads ?? []) {
        const content = readFileSync(join(exportDir, download.fileName), 'utf8')
        if (download.content !== undefined) assert.equal(content, download.content)
        if (download.json !== undefined) assert.deepEqual(JSON.parse(content), download.json)
      }
      evidence.exports = readdirSync(exportDir, { withFileTypes: true }).filter(entry => entry.isFile()).map(({ name }) => ({ name, bytes: readFileSync(join(exportDir, name)).length,
        sha256: createHash('sha256').update(readFileSync(join(exportDir, name))).digest('hex') }))
      const themeColors = {}
      for (const appearance of ['light', 'dark']) {
        await theme(appearance)
        await expect(frame.locator('html')).toHaveCSS('color-scheme', appearance)
        if (typeof scenario.validateTheme === 'function') {
          evidence.themeChecks ??= {}
          evidence.themeChecks[appearance] = await scenario.validateTheme({ pluginId: item.id, appearance, page, frame, expect })
        }
        const path = join(itemDir, `${appearance}.png`)
        await screenshot(path); evidence.screenshots.push(path)
        themeColors[appearance] = await frame.locator('body').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, foreground: getComputedStyle(element).color }))
      }
      assert.notDeepEqual(themeColors.light, themeColors.dark, 'Plugin page must actually adapt its colors, not just expose color-scheme metadata')
      evidence.themeColors = themeColors
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 820))
      const overflow = await frame.locator('html').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }))
      assert.ok(overflow.scroll <= overflow.width + 2, `page overflows at narrow size: ${JSON.stringify(overflow)}`)
      await screenshot(join(itemDir, 'narrow.png')); evidence.screenshots.push(join(itemDir, 'narrow.png'))
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 980))
      await theme('light')
      const tab = manifest.contributes.workspaceTabs?.find(entry => entry.page === declaration.id)
      if (tab) {
        await page.locator(`[data-task-id="${sessionId}"]`).getByRole('button').first().click()
        const openWorkspace = page.getByRole('button', { name: '打开工作区', exact: true })
        if (await openWorkspace.isVisible()) await openWorkspace.click()
        await page.getByRole('button', { name: '更多工作区', exact: true }).click()
        await page.getByRole('menuitem', { name: tab.title, exact: true }).click()
        await expect(iframe).toHaveAttribute('data-ready', 'true')
        const tabContext = await frame.locator('body').evaluate(() => window.aetherPlugin.context())
        assert.equal(tabContext.sessionId, sessionId); assert.equal(resolve(tabContext.workspacePath), workspace)
        evidence.assertions.push('Current-session workspace tab opens actual plugin page with correct context')
      }
      assert.deepEqual(evidence.exampleErrors, [], 'Packaged examples must pass the actual host inputSchema and business assertions')
      evidence.status = 'passed'
    } catch (error) {
      evidence.status = 'failed'; evidence.error = error.stack || String(error)
      await page.screenshot({ path: join(itemDir, 'failure.png') }).catch(() => {})
    }
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ id: item.id, status: evidence.status, error: evidence.error, output: itemDir }))
  }
  await app.close(); app = null
  await launch()
  for (const evidence of report.plugins.filter(item => item.status === 'passed')) {
    const record = (await call('GET', `/plugins/${evidence.id}`)).plugin
    assert.equal(record.enabled, true); assert.equal(record.publishedRevision, evidence.revision)
    const application = (await call('GET', `/plugins/runtime/apps/${evidence.id}?revision=${evidence.revision}`)).application
    assert.ok(Object.keys(application.uiDocuments).length > 0)
    evidence.assertions.push('Published version and custom UI survive actual desktop restart')
  }
  assert.deepEqual(report.errors, [])
  assert.ok(report.plugins.every(item => item.status === 'passed'), 'One or more plugin scenarios failed; see report')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1
} finally {
  await app?.close().catch(error => { report.closeError = String(error) })
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }))
}
