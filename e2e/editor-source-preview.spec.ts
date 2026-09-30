/** 源码预览真机闭环：未保存 Markdown、本地资源、双向滚动和 HTML 沙箱隔离。 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const APP_ROOT = resolve(__dirname, '..')
const FIXTURE_ROOT = join(APP_ROOT, '.e2e-tmp')
const MARKDOWN = '# 磁盘标题\n\n![本地图片](../assets/pixel.svg)\n\n' +
  Array.from({ length: 90 }, (_, index) => `## 第 ${index + 1} 节\n\n这是一段用于滚动验证的说明。\n\n\`source_line_${index}\`\n\n`).join('')
const HTML = '<!doctype html><html><head><link rel="stylesheet" href="../assets/preview.css"></head><body>' +
  '<h1>HTML 原稿</h1><p class="local-style">本地样式</p><img alt="HTML 本地图片" src="../assets/pixel.svg">' +
  '<script>parent.document.documentElement.dataset.previewUnsafe = "ran";</script></body></html>'
let fixture = '', markdownFile = '', profile = ''
let app: ElectronApplication | undefined
let page: Page
const errors: string[] = []

async function openFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const picker = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(picker).toBeVisible()
  await picker.locator('.palette__input').fill(name)
  await expect(picker.locator('.palette__item').first()).toContainText(name, { timeout: 30_000 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active').first()).toContainText(name)
  await expect(page.locator('.doc-view__source .monaco-editor').first()).toBeVisible()
}

test.describe.serial('源码与实时预览', () => {
  test.beforeAll(async () => {
    mkdirSync(FIXTURE_ROOT, { recursive: true })
    fixture = mkdtempSync(join(FIXTURE_ROOT, 'source-preview-'))
    const workspace = join(fixture, 'workspace')
    profile = join(fixture, 'profile')
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    mkdirSync(join(workspace, 'assets'), { recursive: true })
    mkdirSync(profile, { recursive: true })
    markdownFile = join(workspace, 'docs', 'guide.md')
    writeFileSync(markdownFile, MARKDOWN)
    writeFileSync(join(workspace, 'docs', 'page.html'), HTML)
    writeFileSync(join(workspace, 'assets', 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>')
    writeFileSync(join(workspace, 'assets', 'preview.css'), '.local-style { color: rgb(13, 124, 55); background-image: url("./pixel.svg"); }')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') console.log('[preview-console]', message.text()) })
    await expect(page.locator('.workbench')).toBeVisible()
    await openFile('guide.md')
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    const child = relative(FIXTURE_ROOT, fixture)
    if (fixture && child.startsWith('source-preview-') && !child.includes(sep)) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('Markdown 分屏使用未保存文本并加载工作区相对图片', async () => {
    await page.getByRole('button', { name: '分屏预览', exact: true }).click()
    const preview = page.frameLocator('iframe[title="Markdown 预览内容"]')
    await expect(preview.getByRole('heading', { name: '磁盘标题', exact: true })).toBeVisible()
    await expect.poll(() => preview.getByRole('img', { name: '本地图片', exact: true }).evaluate((image) =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    await page.locator('.doc-view__source .monaco-editor').first().click({ position: { x: 100, y: 20 } })
    await page.keyboard.press('Control+Home')
    await page.keyboard.insertText('# 未保存的预览标题\n\n')
    await expect(preview.getByRole('heading', { name: '未保存的预览标题', exact: true })).toBeVisible()
    await expect(page.locator('.doc-view__dirty')).toContainText('未保存')
    expect(readFileSync(markdownFile, 'utf8')).toBe(MARKDOWN)
    await page.screenshot({ path: join(FIXTURE_ROOT, 'editor-experience-preview.png') })
  })

  test('源码和预览双向滚动，预览模式切换保留缓冲区', async () => {
    const frameElement = page.locator('iframe[title="Markdown 预览内容"]')
    const frame = await frameElement.contentFrame()
    await page.locator('.doc-view__source .monaco-editor').first().click({ position: { x: 100, y: 20 } })
    await page.keyboard.press('Control+End')
    await expect.poll(async () => {
      const body = frame.locator('body')
      return body.evaluate(() => {
        const element = document.scrollingElement!
        return element.scrollTop / Math.max(1, element.scrollHeight - innerHeight)
      })
    }).toBeGreaterThan(0.9)
    await frame.locator('body').evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expect(page.locator('.doc-view__source .view-lines').first()).toContainText('未保存的预览标题')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.locator('.doc-view__source')).toBeHidden()
    await expect(frame.getByRole('heading', { name: '未保存的预览标题', exact: true })).toBeVisible()
    await page.locator('.editor-preview-modes').getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.locator('.doc-view__source')).toBeVisible()
    await expect(page.locator('.source-preview')).toHaveCount(0)
    expect(readFileSync(markdownFile, 'utf8')).toBe(MARKDOWN)
  })

  test('HTML 本地 CSS 与图片可用，预览不能访问宿主或执行文件脚本', async () => {
    await openFile('page.html')
    await page.getByRole('button', { name: '分屏预览', exact: true }).click()
    const preview = page.frameLocator('iframe[title="HTML 预览内容"]')
    await expect(preview.getByRole('heading', { name: 'HTML 原稿', exact: true })).toBeVisible()
    await expect(preview.locator('.local-style')).toHaveCSS('color', 'rgb(13, 124, 55)')
    await expect.poll(() => preview.getByRole('img', { name: 'HTML 本地图片', exact: true }).evaluate((image) =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    expect(await preview.locator('body').evaluate(() => {
      try { void parent.document.documentElement; return false } catch { return true }
    })).toBe(true)
    expect(await preview.locator('body').evaluate(() => 'aether' in window)).toBe(false)
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-preview-unsafe'))).toBe(false)
    await page.locator('.doc-view__source .monaco-editor').first().click({ position: { x: 100, y: 20 } })
    await page.keyboard.press('Control+Home')
    await page.keyboard.insertText('<h2>尚未保存的 HTML</h2>')
    await expect(preview.getByRole('heading', { name: '尚未保存的 HTML', exact: true })).toBeVisible()
  })

  test('路径面包屑显示同级文件并实际打开所选文件', async () => {
    await page.getByRole('navigation', { name: '当前文件路径' }).getByRole('button', { name: 'page.html', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '浏览文件路径' })
    await expect(picker).toBeVisible()
    await picker.getByRole('textbox', { name: '筛选同级文件' }).fill('guide.md')
    await expect(picker.getByRole('button', { name: 'guide.md', exact: true })).toBeVisible()
    await picker.getByRole('button', { name: 'guide.md', exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expect(page.locator('.editor-tab.is-active').first()).toContainText('guide.md')
    await expect(page.locator('.doc-view__source .view-lines').first()).toContainText('未保存的预览标题')
  })

  test('编辑设置改变实际排版，切文件和重启后保留', async () => {
    await page.getByRole('button', { name: '编辑器设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '编辑器设置', exact: true })
    await settings.getByRole('textbox', { name: '字体', exact: true }).fill('Consolas, monospace')
    await settings.getByRole('spinbutton', { name: '字号', exact: true }).fill('18')
    await settings.getByRole('spinbutton', { name: '行高', exact: true }).fill('28')
    await settings.getByRole('spinbutton', { name: '缩进空格数', exact: true }).fill('4')
    await settings.getByRole('switch', { name: '字体连字', exact: true }).click()
    await settings.getByRole('switch', { name: '自动换行', exact: true }).click()
    await settings.getByRole('switch', { name: '显示小地图', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await openFile('page.html')
    await expect(page.locator('.doc-view__source .view-line').first()).toHaveCSS('font-size', '18px')
    await expect(page.locator('.doc-view__source .view-line').first()).toHaveCSS('line-height', '28px')
    await expect.poll(() => page.locator('.doc-view__source .minimap').first().evaluate((element) => element.getBoundingClientRect().width)).toBe(0)
    await app?.close()
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
    await openFile('page.html')
    await expect(page.locator('.doc-view__source .view-line').first()).toHaveCSS('font-size', '18px')
    await expect(page.locator('.doc-view__source .view-line').first()).toHaveCSS('line-height', '28px')
    await page.getByRole('button', { name: '编辑器设置', exact: true }).click()
    const restored = page.getByRole('dialog', { name: '编辑器设置', exact: true })
    await expect(restored.getByRole('textbox', { name: '字体', exact: true })).toHaveValue('Consolas, monospace')
    await expect(restored.getByRole('spinbutton', { name: '缩进空格数', exact: true })).toHaveValue('4')
    await expect(restored.getByRole('switch', { name: '字体连字', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(restored.getByRole('switch', { name: '自动换行', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(restored.getByRole('switch', { name: '显示小地图', exact: true })).toHaveAttribute('aria-checked', 'false')
  })
})
