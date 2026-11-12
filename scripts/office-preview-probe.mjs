/** Real local Office preview timings. Copies fixtures, freezes the build and disables
 * the engine. rAF latency is a scheduling proxy, not an INP/presented-frame claim. */
import { _electron as electron, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const source = process.env.AETHER_OFFICE_FIXTURE_ROOT || 'D:/trust-test/办公文档测试'
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'probe'
const sessionMode = process.argv.includes('--work')
const output = path.join(root, '.e2e-tmp', `office-preview-${label.replace(/[^a-z0-9-]/gi, '')}-${Date.now()}`)
const workspace = path.join(output, 'workspace'), profile = path.join(output, 'profile'), frozen = path.join(output, 'app')
await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(profile)
await fs.cp(path.join(root, 'out'), path.join(frozen, 'out'), { recursive: true })
await fs.writeFile(path.join(frozen, 'package.json'), JSON.stringify({ name: 'aether-code', version: '1.0.0', main: './out/main/index.js' }))
const names = ['01_Word_小型_会议纪要.docx', '02_Word_大型_图文报告.docx', '03_Excel_小型_任务清单.xlsx', '04_Excel_大型_12000行数据.xlsx', '05_PPT_小型_文字演示.pptx', '06_PPT_中型_图文演示.pptx', '07_PPT_大型_高清图册.pptx', '08_PDF_小型_测试说明.pdf', '09_PDF_大型_图文手册.pdf']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map()
for (const name of names) {
  const bytes = await fs.readFile(path.join(source, name)); originals.set(name, hash(bytes))
  await fs.writeFile(path.join(workspace, name), bytes)
}
await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, appearance: 'light' }))
const env = { ...process.env, AETHER_GLOBAL_DIR: path.join(output, 'global') }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ELECTRON_EXEC_PATH', 'ELECTRON_CLI_ARGS', 'NODE_ENV_ELECTRON_VITE']) delete env[key]
const rendererFiles = (await fs.readdir(path.join(frozen, 'out/renderer/assets'))).filter(name => /^(?:index-|OfficeDocumentPreview-|SpreadsheetDocumentPreview-|PdfDocumentPreview-|spreadsheet-preview\.worker-)/.test(name) && /\.(?:js|css)$/.test(name))
const rendererHashes = Object.fromEntries(await Promise.all(rendererFiles.map(async name => [name, hash(await fs.readFile(path.join(frozen, 'out/renderer/assets', name)))])))
const report = { label, mode: sessionMode ? 'work' : 'code', output, source, generatedAt: new Date().toISOString(), buildHash: hash(await fs.readFile(path.join(frozen, 'out/main/index.js'))), rendererHashes, measurements: [], errors: [], originalsUnchanged: false,
  boundary: 'Real Electron UI, copied local files, isolated profile, engine disabled. File first-content waits for decoded visible images/canvas/cells and two rAF; timing is not OS presented-frame timing.' }
let app, page
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const preview = () => page.locator('.document-preview:visible').last()
const fileTab = name => page.locator(sessionMode ? '.work-view .work-workspace__tab-button' : '.editor-tab').filter({ hasText: name }).first()
async function rendered() {
  await expect(preview()).toBeVisible({ timeout: 65000 })
  await expect.poll(() => preview().evaluate(element => {
    if (element.querySelector('[role="alert"]')) return 'error:' + element.querySelector('[role="alert"]').textContent
    const kind = element.getAttribute('data-document-preview')
    if (kind === 'xlsx') return [...element.querySelectorAll('td')].some(cell => cell.textContent.trim()) ? 'ready' : 'waiting'
    if (kind === 'pdf') return [...element.querySelectorAll('canvas[data-rendered-page]')].some(canvas => Number(canvas.dataset.renderedPage) > 0 && canvas.width > 0 && canvas.height > 0) ? 'ready' : 'waiting'
    const frame = element.querySelector('iframe'), doc = frame?.contentDocument
    if (!doc?.querySelector('section.docx, .slide-container')) return 'waiting'
    return [...doc.images].every(img => img.complete && img.naturalWidth > 0) ? 'ready' : 'waiting'
  }), { timeout: 65000 }).toBe('ready')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function open(name) {
  if (sessionMode) {
    await page.evaluate(() => { window.__officeStart = performance.now(); window.__officeLongTasks = [] })
    await page.locator('input.work-resource-tabs__file-input').setInputFiles(path.join(workspace, name))
    await rendered(); return
  }
  await page.keyboard.press('Control+p')
  const picker = page.locator('.palette[aria-label="快速打开文件"]')
  await picker.locator('.palette__input').fill(name)
  const item = picker.locator('.palette__item').filter({ hasText: name }).first()
  await expect(item).toBeVisible()
  await item.evaluate(element => element.addEventListener('click', () => { window.__officeStart = performance.now() }, { once: true, capture: true }))
  await page.evaluate(() => { window.__officeStart = performance.now(); window.__officeLongTasks = [] })
  await item.click()
  await rendered()
}
async function measure(phase, name, action) {
  try {
    await action()
    const measurement = await page.evaluate(() => ({ ms: Math.round(performance.now() - window.__officeStart), longTasks: window.__officeLongTasks,
      frames: document.querySelectorAll('.document-preview iframe').length, previews: document.querySelectorAll('.document-preview').length }))
    report.measurements.push({ phase, name, ...measurement }); console.log(JSON.stringify(report.measurements.at(-1)))
  } catch (error) {
    report.measurements.push({ phase, name, error: String(error) })
    await page.screenshot({ path: path.join(output, `failure-${report.measurements.length}.png`) }).catch(() => {})
    console.error(phase, name, String(error).slice(0, 500))
  }
  await save()
}
try {
  app = await electron.launch({ args: [frozen, `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', error => report.errors.push(error.message))
  await expect(page.locator('.workbench')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 950))
  if (sessionMode) {
    await page.evaluate(workspace => {
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: 'work-office-probe', title: '办公预览性能', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }], activeTaskId: 'work-office-probe', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, workspace)
    await page.reload(); await expect(page.locator('.work-view')).toBeVisible()
  }
  await page.evaluate(() => {
    window.__officeLongTasks = []
    new PerformanceObserver(list => window.__officeLongTasks.push(...list.getEntries().map(e => Math.round(e.duration)))).observe({ type: 'longtask' })
  })
  report.graphics = await app.evaluate(({ app }) => app.getGPUFeatureStatus())
  for (const name of names) await measure('cold', name, () => open(name))
  const tour = [names[1], names[3], names[5], names[6], names[8]]
  for (let round = 0; round < 2; round++) for (const name of tour) await measure(`switch-${round + 1}`, name, async () => {
    const tab = fileTab(name)
    await tab.evaluate(element => element.addEventListener('click', () => { window.__officeStart = performance.now() }, { once: true, capture: true }))
    await page.evaluate(() => { window.__officeStart = performance.now(); window.__officeLongTasks = [] })
    await tab.click(); await rendered()
  })
  for (const name of [names[1], names[6]]) {
    await open(name)
    const frame = preview().locator('iframe').first()
    await frame.evaluate(element => { element.contentDocument.documentElement.dataset.probeIdentity = 'original'; element.__probeLoads = 0; element.addEventListener('load', () => element.__probeLoads++) })
    await measure('resize', name, async () => {
      await page.evaluate(() => { window.__officeStart = performance.now(); window.__officeLongTasks = [] })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1260, 850))
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(1300)
      await rendered()
      // Wait beyond the documented resize debounce to observe a possible navigation.
      await page.waitForTimeout(220)
      await rendered()
    })
    report.measurements.at(-1).frame = await frame.evaluate(element => ({ loads: element.__probeLoads, sameDocument: element.contentDocument.documentElement.dataset.probeIdentity === 'original' }))
    await page.screenshot({ path: path.join(output, `${name}.png`) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 950))
  }
  await open(names[3])
  await measure('sheet-scroll-bottom', names[3], async () => {
    const body = preview().locator('.document-preview__body--sheet')
    await page.evaluate(() => { window.__officeStart = performance.now(); window.__officeLongTasks = [] })
    await body.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(preview().locator('table')).toContainText('TEST-012000')
    await rendered()
  })
  report.metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ type: item.type, memory: item.memory })))
  for (const [name, digest] of originals) if (hash(await fs.readFile(path.join(source, name))) !== digest) throw new Error(`Original changed: ${name}`)
  report.originalsUnchanged = true
} catch (error) { report.errors.push(String(error)); throw error }
finally { await save(); await app?.close(); console.log(output) }
if (report.errors.length || report.measurements.some(value => value.error)) process.exitCode = 1
