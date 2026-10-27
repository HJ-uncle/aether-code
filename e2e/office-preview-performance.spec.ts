/** Opt-in real Office acceptance: bounded preparation, immediate errors and
 * stable-width repaint. Set AETHER_OFFICE_FIXTURE_ROOT and AETHER_E2E_MAIN. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = process.env.AETHER_OFFICE_FIXTURE_ROOT
const PARENT = join(ROOT, '.e2e-tmp')
let app: ElectronApplication | undefined, page: Page, fixture = ''

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RENDERER_URL', 'ELECTRON_EXEC_PATH', 'ELECTRON_CLI_ARGS', 'NODE_ENV_ELECTRON_VITE']) delete env[key]
  return env
}

async function open(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const picker = page.locator('.palette[aria-label="快速打开文件"]')
  await picker.locator('.palette__input').fill(name)
  await expect(picker.locator('.palette__item').first()).toContainText(name, { timeout: 30_000 })
  await page.keyboard.press('Enter')
}

test.beforeAll(async () => {
  test.skip(!FIXTURES, '未提供 AETHER_OFFICE_FIXTURE_ROOT')
  mkdirSync(PARENT, { recursive: true })
  fixture = mkdtempSync(join(PARENT, 'office-preview-performance-'))
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace); mkdirSync(profile)
  for (const name of ['02_Word_大型_图文报告.docx', '04_Excel_大型_12000行数据.xlsx', '06_PPT_中型_图文演示.pptx', '07_PPT_大型_高清图册.pptx', '08_PDF_小型_测试说明.pdf']) {
    copyFileSync(join(FIXTURES!, name), join(workspace, name))
  }
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
  app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: ROOT, env: cleanEnv() })
  page = await app.firstWindow()
  await expect(page.locator('.workbench')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 950))
})

test.afterAll(async () => {
  await app?.close()
  if (fixture && dirname(fixture) === PARENT && basename(fixture).startsWith('office-preview-performance-')) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
})

test('真实 12000 行 XLSX 在后台解析，首末行可见且结构错误不会出现', async () => {
  test.setTimeout(120_000)
  await open('04_Excel_大型_12000行数据.xlsx')
  const preview = page.locator('[data-document-preview="xlsx"]')
  await expect(preview.locator('table, [role="alert"]')).toBeVisible({ timeout: 60_000 })
  await expect(preview.getByRole('alert')).toHaveCount(0)
  await expect(preview.locator('table')).toContainText('TEST-')
  const started = Date.now()
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette[aria-label="快速打开文件"]')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  expect(Date.now() - started).toBeLessThan(5000)
  await preview.locator('.document-preview__table-nav input').fill('121')
  await expect(preview.locator('table')).toContainText('TEST-012000')
  await expect(preview.locator('.document-preview__body--sheet')).toHaveAttribute('data-document-row-start', '12001')
})

for (const [name, kind, marker] of [
  ['02_Word_大型_图文报告.docx', 'docx', 'section.docx'],
  ['06_PPT_中型_图文演示.pptx', 'pptx', 'slide-container'],
  ['07_PPT_大型_高清图册.pptx', 'pptx', 'slide-container'],
] as const) {
  test(`真实 ${name} 可显示首屏，容器 resize 不重建 iframe`, async () => {
    test.setTimeout(120_000)
    await open(name)
    const preview = page.locator(`[data-document-preview="${kind}"]`)
    await expect(preview.locator('iframe, [role="alert"]')).toBeVisible({ timeout: 60_000 })
    await expect(preview.getByRole('alert')).toHaveCount(0)
    const frame = preview.locator('iframe')
    await expect(frame).toHaveAttribute('srcdoc', new RegExp(marker.replace('.', '\\.')))
    const original = await frame.getAttribute('srcdoc')
    await frame.evaluate(element => Object.assign(element, { officePreviewMarker: 'same-frame' }))
    await preview.evaluate(element => { element.style.flex = 'none'; element.style.width = '640px' })
    expect(await frame.evaluate(element => Reflect.get(element, 'officePreviewMarker'))).toBe('same-frame')
    await expect.poll(() => frame.getAttribute('srcdoc'), { timeout: 5000 }).not.toBe(original)
    expect(await frame.evaluate(element => Reflect.get(element, 'officePreviewMarker'))).toBe('same-frame')
    await expect(frame).toHaveAttribute('srcdoc', new RegExp(marker.replace('.', '\\.')))
    await preview.evaluate(element => { element.style.width = '720px' })
    expect(await frame.evaluate(element => Reflect.get(element, 'officePreviewMarker'))).toBe('same-frame')
  })
}

test('PDF resize 保留画布，并在稳定后重新绘制', async () => {
  test.setTimeout(120_000)
  await open('08_PDF_小型_测试说明.pdf')
  const preview = page.locator('[data-document-preview="pdf"]')
  await expect(preview.locator('canvas, [role="alert"]')).toBeVisible({ timeout: 60_000 })
  await expect(preview.getByRole('alert')).toHaveCount(0)
  const canvas = preview.locator('canvas')
  await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
  const original = await canvas.evaluate(element => element.width)
  await canvas.evaluate(element => Object.assign(element, { pdfPreviewMarker: 'same-canvas' }))
  await preview.evaluate(element => { element.style.flex = 'none'; element.style.width = '640px' })
  expect(await canvas.evaluate(element => Reflect.get(element, 'pdfPreviewMarker'))).toBe('same-canvas')
  expect(await canvas.evaluate(element => element.width)).toBeGreaterThan(0)
  await expect.poll(() => canvas.evaluate(element => element.width), { timeout: 30_000 }).not.toBe(original)
  await expect(canvas).toHaveAttribute('data-rendered-page', '1')
  expect(await canvas.evaluate(element => element.width)).toBeGreaterThan(0)
  expect(await canvas.evaluate(element => Reflect.get(element, 'pdfPreviewMarker'))).toBe('same-canvas')
})
