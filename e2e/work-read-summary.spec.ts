/** Real Work read/list/Office rows: single-line overflow, complete themed hover
 * details, pointer/keyboard disclosure, and actual receipt ranges. Isolated
 * headless React + production CSS; no Electron, IPC, engine, or model request. */
import { chromium, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')
let browser: Browser, context: BrowserContext, page: Page, bundle: string
let errors: string[] = []
const css = ['assets/tokens.css', 'assets/base.css', 'assets/components.css', 'assets/motion.css', 'contrib/work/work-inline-activity.css', 'workbench/hover-detail.css']
  .map(file => readFileSync(resolve(root, 'src/renderer/src', file), 'utf8')).join('\n')
const files = [
  { path: 'D:/fixture/README.md', label: 'README.md', range: '1–255', title: 'D:/fixture/README.md\n本次读取第 1–255 行 · 文件共 500 行' },
  { path: 'D:/fixture/engine.js', label: 'engine.js', range: '64–123', title: 'D:/fixture/engine.js\n本次读取第 64–123 行 · 文件共 400 行' },
  { path: 'D:/fixture/package.json', label: 'package.json', range: '1–32', title: 'D:/fixture/package.json\n本次读取第 1–32 行 · 文件共 32 行' }
]
const tool = { id: 'read-summary-fixture', name: 'read_file', state: 'done', args: JSON.stringify({ files: files.map(file => ({ path: file.path })) }),
  result: 'SOURCE-CONTENT-PROBE', metadata: {} }

test.beforeAll(async () => {
  const built = await build({ stdin: { sourcefile: 'read-summary-fixture.tsx', resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { AppContext } from './src/renderer/src/core/app-context'
    import { DEFAULT_SETTINGS } from './src/shared/ipc'
    import { CompactToolRow } from './src/renderer/src/contrib/chat/CompactToolRow'
    import { WorkToolActivity } from './src/renderer/src/contrib/work/WorkToolActivity'
    const root = createRoot(document.getElementById('fixture'))
    const value = { engine: { snapshot: { mode: 'local' } }, settings: DEFAULT_SETTINGS,
      userSettings: DEFAULT_SETTINGS, ready: false, settingsLoaded: true,
      updateSettings: async () => { throw new Error('Settings writes are forbidden in this fixture') } }
    window.renderFixture = ({ integration, ...props }) => root.render(
      <AppContext.Provider value={value}>
        {integration ? <WorkToolActivity {...props} /> : <CompactToolRow {...props} />}
      </AppContext.Provider>)
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfig: resolve(root, 'tsconfig.web.json'), loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
    // Vite's worker imports are dormant editor dependencies of file navigation.
    // Preserve the real read components; fail if this isolated test opens an editor.
    plugins: [{ name: 'fixture-vite-imports', setup(build) {
      build.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path, namespace: 'forbidden-worker' }))
      build.onLoad({ filter: /.*/, namespace: 'forbidden-worker' }, () => ({ contents: 'export default class { constructor() { throw new Error("Editor workers are outside this isolated read-row fixture") } }' }))
      build.onResolve({ filter: /\?(?:inline|raw)$/ }, async args => {
        const resolved = await build.resolve(args.path.replace(/\?[^?]+$/, ''), { resolveDir: args.resolveDir, kind: args.kind })
        return { path: resolved.path, namespace: 'raw-resource' }
      })
      build.onLoad({ filter: /.*/, namespace: 'raw-resource' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
    } }] })
  bundle = built.outputFiles[0].text
  const installed = [chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
  browser = await chromium.launch({ headless: true, ...(installed ? { executablePath: installed } : {}) })
})

test.afterAll(async () => { await browser?.close() })
test.beforeEach(async () => {
  errors = []
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.abort())
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<!doctype html><html data-appearance="light"><head><meta charset="utf-8"></head><body><main id="fixture" class="work-tool-activity"></main></body></html>')
  await page.addStyleTag({ content: css + '\nbody { padding:16px; overflow:auto } #fixture { width:860px; max-width:100%; }' })
  await page.addScriptTag({ content: bundle })
})
test.afterEach(async () => {
  try { expect(errors).toEqual([]) } finally { await context?.close() }
})

async function render(props: Record<string, unknown> = {}) {
  await page.evaluate(value => (window as unknown as { renderFixture: (props: unknown) => void }).renderFixture(value),
    { tool, quiet: true, defaultOpen: false, memoryKey: undefined, readFiles: files, ...props })
  await expect(page.locator('.compact-tool-row')).toBeVisible()
}

async function assertOneLine(header: Locator): Promise<void> {
  const geometry = await header.evaluate(element => {
    const box = element.getBoundingClientRect(), summary = element.querySelector('.logline__files, .logline__summary')!
    const style = getComputedStyle(summary)
    return { height: box.height, overflow: element.scrollWidth - element.clientWidth,
      whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflowX: style.overflowX,
      tops: [...element.querySelectorAll('.logline__file-name')].map(file => Math.round(file.getBoundingClientRect().top)) }
  })
  expect(geometry.height).toBeGreaterThanOrEqual(27)
  expect(geometry.height).toBeLessThanOrEqual(29)
  expect(geometry.overflow).toBeLessThanOrEqual(1)
  expect(geometry.whiteSpace).toBe('nowrap')
  expect(geometry.textOverflow).toBe('ellipsis')
  expect(geometry.overflowX).toBe('hidden')
  if (geometry.tops.length) expect(new Set(geometry.tops).size).toBe(1)
}

async function assertHoverCopy(): Promise<void> {
  const tooltip = page.getByRole('tooltip'), label = await page.locator('.compact-tool-row > button .logline__name').innerText()
  await expect(tooltip.getByText(label, { exact: true })).toHaveCount(1)
  await expect(tooltip).not.toContainText('还有更多内容')
}

async function assertHoverBounds(): Promise<void> {
  await assertHoverCopy()
  const geometry = await page.getByRole('tooltip').evaluate(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: element.scrollWidth - element.clientWidth }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  expect(geometry.overflow).toBeLessThanOrEqual(1)
}

test('collapsed header retains every file and actual range; disclosure still opens and closes', async () => {
  await render({ summary: 'README.md 等 3 个文件' })
  const header = page.locator('.compact-tool-row > button'), groups = header.locator('.logline__file')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.logline__detail')).toHaveCount(0)
  await expect(page.locator('.compact-tool-row')).toHaveClass(/compact-tool-row--files/)
  await expect(groups).toHaveCount(3)
  for (let index = 0; index < files.length; index++) {
    await expect(groups.nth(index).locator('.logline__file-name')).toHaveText(files[index].label)
    await expect(groups.nth(index).locator('.logline__file-range')).toHaveText(files[index].range)
    await expect(header).toHaveAccessibleName(new RegExp(`${files[index].label.replace('.', '\\.')} ${files[index].range}`))
  }
  await expect(header.locator('[title]')).toHaveCount(0)
  await expect(header).not.toContainText('等 3')
  await expect(header.locator('.logline__summary')).toHaveCount(0)
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.logline__detail')).toContainText('SOURCE-CONTENT-PROBE')
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.logline__detail')).toHaveCount(0)
  await expect(groups).toHaveCount(3)
})

for (const appearance of ['light', 'dark']) for (const width of [860, 320]) {
  test(`${appearance} at ${width}px keeps one line and exposes every clipped item in themed hover`, async ({}, info) => {
    await page.setViewportSize({ width: width + 32, height: 768 })
    await page.evaluate(({ appearance, width }) => {
      document.documentElement.dataset.appearance = appearance
      document.getElementById('fixture')!.style.width = `${width}px`
    }, { appearance, width })
    await render()
    const header = page.locator('.compact-tool-row > button'), tooltip = page.getByRole('tooltip')
    await assertOneLine(header)
    await expect(header.locator('.logline__file')).toHaveCount(files.length)
    if (width === 320) expect(await header.locator('.logline__files').evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(20)
    await header.hover()
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveClass(/hover-detail/)
    for (const file of files) {
      await expect(header).toHaveAccessibleName(new RegExp(file.label.replace('.', '\\.')))
      for (const line of file.title.split('\n')) await expect(tooltip).toContainText(line)
    }
    await assertHoverBounds()
    await tooltip.hover()
    await expect.poll(() => tooltip.evaluate(element => element.matches(':hover'))).toBe(true)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.logline__detail')).toHaveCount(0)
    const screenshot = info.outputPath(`${appearance}-${width}-hover.png`)
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach('single-line-and-complete-hover', { path: screenshot, contentType: 'image/png' })
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
  })
}

test('keyboard focus exposes complete detail, Escape dismisses it, and Enter only toggles the receipt', async () => {
  await render()
  const header = page.locator('.compact-tool-row > button'), tooltip = page.getByRole('tooltip')
  await page.mouse.move(1000, 740)
  await page.keyboard.press('Tab')
  await expect(header).toBeFocused()
  await expect(tooltip).toBeVisible()
  for (const file of files) await expect(tooltip).toContainText(file.path)
  await assertHoverCopy()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(header).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.logline__detail')).toContainText('SOURCE-CONTENT-PROBE')
  await page.keyboard.press('Enter')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.logline__detail')).toHaveCount(0)
})

test('long paths wrap inside a scrollable hover without clipping the last file', async () => {
  await page.setViewportSize({ width: 352, height: 420 })
  const longFiles = Array.from({ length: 16 }, (_, index) => {
    const label = `完整文件名-${index}-${'longunbrokenname'.repeat(7)}.ts`, path = `D:/fixture/${'nested/'.repeat(16)}${label}`
    return { path, label, range: `${index + 1}–${index + 2}`, title: `${path}\n本次读取第 ${index + 1}–${index + 2} 行 · 文件共 500 行` }
  })
  await render({ readFiles: longFiles })
  const header = page.locator('.compact-tool-row > button'), tooltip = page.getByRole('tooltip')
  await assertOneLine(header)
  await header.hover(); await expect(tooltip).toBeVisible()
  for (const file of longFiles) await expect(tooltip).toContainText(file.path)
  await assertHoverBounds()
  // A scrollable popup must remain open when the pointer crosses from its row
  // into the popup, so readers can reach details below the viewport.
  await tooltip.hover()
  expect(await tooltip.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100)
  await page.mouse.wheel(0, 10000)
  await expect.poll(() => tooltip.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect(tooltip).toBeVisible()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0)
})

test('real WorkToolActivity receipt projection uses actual bounds and omits failed or cancelled ranges', async () => {
  const version = { expectedHash: `sha256:${'a'.repeat(64)}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false }
  const result = JSON.stringify({ batch: true, files: [
    { path: files[0].path, success: true, output: { ...version, path: files[0].path, startLine: 1, endLine: 255, totalLines: 500, content: 'read content' } },
    { path: files[1].path, success: true, output: { ...version, path: files[1].path, startLine: 64, endLine: 123, totalLines: 400, content: 'actual page' } },
    { path: 'D:/fixture/missing.ts', success: false, error: 'FILE_READ_FAILED', output: { message: 'File missing' } },
    { path: 'D:/fixture/cancelled.ts', success: false, status: 'cancelled', error: 'FILE_BATCH_CANCELLED', output: { message: 'Cancelled' } }
  ] })
  await render({ integration: true, readFiles: undefined, fileContext: { sessionId: 'read-fixture', workspaceRoot: 'D:/fixture' },
    tool: { ...tool, state: 'error', error: 'Some reads failed', result,
      args: JSON.stringify({ files: [files[0], files[1], { path: 'D:/fixture/missing.ts' }, { path: 'D:/fixture/cancelled.ts' }]
        .map(file => ({ path: file.path, startLine: 1, endLine: 9999 })) }) } })
  const groups = page.locator('.logline__file')
  await expect(groups).toHaveCount(4)
  await expect(groups.nth(0).locator('.logline__file-range')).toHaveText('1–255')
  await expect(groups.nth(1).locator('.logline__file-range')).toHaveText('64–123')
  for (const index of [2, 3]) await expect(groups.nth(index).locator('.logline__file-range')).toHaveCount(0)
  await expect(groups.nth(2)).toContainText('missing.ts')
  await expect(groups.nth(2)).toContainText('失败')
  await expect(groups.nth(3)).toContainText('cancelled.ts')
  await expect(groups.nth(3)).toContainText('已取消')
  await expect(page.locator('.compact-tool-row > button')).not.toContainText('9999')
  await expect(page.locator('.compact-tool-row > button')).toHaveAttribute('aria-expanded', 'false')
  await page.locator('.compact-tool-row > button').hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('本次读取第 1–255 行 · 文件共 500 行')
  await expect(tooltip).toContainText('本次读取第 64–123 行 · 文件共 400 行')
  await expect(tooltip).toContainText('File missing')
  await expect(tooltip).toContainText('读取已取消')
  await expect(tooltip).not.toContainText('9999')
  await assertHoverCopy()
})

test('directory hover retains the full original path beyond the condensed target limit', async () => {
  const path = `D:/fixture/${'目录-name-without-breaks/'.repeat(14)}end-of-the-complete-directory`
  await page.setViewportSize({ width: 352, height: 420 })
  await render({ integration: true, readFiles: undefined, fileContext: { sessionId: 'directory-fixture', workspaceRoot: 'D:/fixture' },
    tool: { ...tool, id: 'directory-read', name: 'list_directory', args: JSON.stringify({ path }), result: 'DIRECTORY-RECEIPT-PROBE' } })
  const header = page.locator('.compact-tool-row > button'), tooltip = page.getByRole('tooltip')
  await assertOneLine(header)
  await expect(header.locator('[title]')).toHaveCount(0)
  await header.hover(); await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(path)
  await assertHoverBounds()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape'); await header.click()
  await expect(page.locator('.logline__detail')).toContainText('DIRECTORY-RECEIPT-PROBE')
})

test('Office batch keeps every document in the hover without fabricating read line ranges', async () => {
  const officeFiles = ['report.docx', 'budget.xlsx', 'presentation.pptx'].map(name => ({ path: `D:/fixture/业务资料/${name}` }))
  const result = JSON.stringify({ batch: true, files: officeFiles.map(file => ({ ...file, success: true, executed: true,
    output: { ...file, expectedHash: `sha256:${'c'.repeat(64)}`, content: 'OFFICE-RECEIPT-PROBE', contentIncluded: true,
      contentPage: { offset: 0, returnedChars: 20, totalPreviewChars: 20, nextOffset: null, hasMore: false, sourceTruncated: false, documentComplete: false } } })) })
  await page.setViewportSize({ width: 352, height: 420 })
  await render({ integration: true, readFiles: undefined, fileContext: { sessionId: 'office-fixture', workspaceRoot: 'D:/fixture' },
    tool: { ...tool, id: 'office-read', name: 'office_inspect', args: JSON.stringify({ files: officeFiles }), result } })
  const header = page.locator('.compact-tool-row > button'), tooltip = page.getByRole('tooltip')
  await assertOneLine(header)
  await expect(header.locator('.logline__file')).toHaveCount(3)
  await expect(header.locator('.logline__file-range')).toHaveCount(0)
  await header.hover(); await expect(tooltip).toBeVisible()
  for (const file of officeFiles) await expect(tooltip).toContainText(file.path)
  await expect(tooltip).toContainText('文档预览，不提供实读行号')
  await assertHoverBounds()
  await page.keyboard.press('Escape'); await header.click()
  await expect(page.locator('.logline__detail')).toContainText('OFFICE-RECEIPT-PROBE')
})

test('Code presentation retains its original summary when quiet mode is disabled', async () => {
  await render({ quiet: false, summary: 'legacy-summary' })
  await expect(page.locator('.logline__summary')).toHaveText('legacy-summary')
  await expect(page.locator('.logline__files')).toHaveCount(0)
  await expect(page.locator('.compact-tool-row')).not.toHaveClass(/compact-tool-row--files/)
})

test('actual successful read receipts remain collapsed in wide light and narrow dark screenshots', async () => {
  const bounds = [[1, 255, 500], [64, 123, 400], [1, 32, 32]]
  const result = JSON.stringify({ batch: true, files: files.map((file, index) => ({ path: file.path, success: true,
    output: { path: file.path, expectedHash: `sha256:${'b'.repeat(64)}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false,
      startLine: bounds[index][0], endLine: bounds[index][1], totalLines: bounds[index][2], content: 'REAL-RECEIPT-CONTENT' } })) })
  await render({ integration: true, readFiles: undefined, fileContext: { sessionId: 'successful-read-fixture', workspaceRoot: 'D:/fixture' }, tool: { ...tool, result } })
  await expect(page.locator('.logline__file-name')).toHaveText(files.map(file => file.label))
  await expect(page.locator('.logline__file-range')).toHaveText(files.map(file => file.range))
  await expect(page.locator('.compact-tool-row > button')).toHaveAttribute('aria-expanded', 'false')
  mkdirSync(resolve(root, '.e2e-tmp/work-read-summary'), { recursive: true })
  for (const [appearance, width] of [['light', 860], ['dark', 320]] as const) {
    await page.evaluate(({ appearance, width }) => {
      document.documentElement.dataset.appearance = appearance
      document.getElementById('fixture')!.style.width = `${width}px`
    }, { appearance, width })
    await page.locator('#fixture').screenshot({ path: resolve(root, `.e2e-tmp/work-read-summary/${appearance}-${width}.png`) })
  }
})
