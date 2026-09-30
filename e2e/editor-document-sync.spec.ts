/** 真机：外部/AI等价改盘刷新、dirty冲突保护、显式重载、草稿重启恢复、截断只读。 */
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp')
let fixture = ''
let workspace = ''
let profile = ''
let app: ElectronApplication
let page: Page
const errors: string[] = []

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env } })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(String(error)))
  await expect(page.locator('.workbench')).toBeVisible()
}
async function open(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await palette.locator('input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name)
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active')).toContainText(name)
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
}
async function replace(text: string): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
}

test.describe.serial('编辑文档同步与恢复', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true })
    fixture = mkdtempSync(join(fixtures, 'editor-sync-'))
    workspace = join(fixture, 'workspace')
    profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    writeFileSync(join(workspace, 'sync.txt'), 'initial disk content\n')
    writeFileSync(join(workspace, 'huge.txt'), 'large text line\n'.repeat(280_000) + 'KEEP_FILE_TAIL')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    await launch()
    await open('sync.txt')
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    const child = relative(fixtures, fixture)
    if (child.startsWith('editor-sync-') && !child.includes(sep)) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('未修改的打开文件自动反映外部改盘', async () => {
    writeFileSync(join(workspace, 'sync.txt'), 'external fresh content\n')
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('external fresh content')
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)
  })

  test('dirty文件保留用户输入并报告外部冲突，保存不覆盖新磁盘内容', async () => {
    await replace('user draft survives\n')
    writeFileSync(join(workspace, 'sync.txt'), 'another writer version\n')
    await expect(page.getByRole('button', { name: /重新加载磁盘版本/ })).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('user draft survives')
    await page.keyboard.press('Control+s')
    await expect(page.locator('.doc-view').getByRole('alert').first()).toContainText(/未覆盖|修改/)
    expect(readFileSync(join(workspace, 'sync.txt'), 'utf8')).toBe('another writer version\n')
    await page.getByRole('button', { name: /重新加载磁盘版本/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /重新加载|放弃.*加载/ }).click()
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('another writer version')
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)
  })

  test('重启恢复打开标签及未保存草稿，同时保留真实磁盘基线', async () => {
    await replace('recovered unsaved draft\n')
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .filter((key) => key.startsWith('aether.editor.recovery:'))
      .some((key) => localStorage.getItem(key)?.includes('recovered unsaved draft')))).toBe(true)
    await app.close()
    await launch()
    await open('sync.txt')
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('recovered unsaved draft')
    await expect(page.locator('.doc-view__dirty')).toBeVisible()
    expect(readFileSync(join(workspace, 'sync.txt'), 'utf8')).toBe('another writer version\n')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(workspace, 'sync.txt'), 'utf8')).toBe('recovered unsaved draft\n')
  })

  test('关闭动画尚未结束时重新打开 Ctrl+P，新的文件选择保持可用', async () => {
    await page.keyboard.press('Control+p')
    const palette = page.locator('.palette[aria-label="快速打开文件"]')
    await palette.locator('input').fill('sync.txt')
    await expect(palette.locator('.palette__item').first()).toContainText('sync.txt')
    await page.keyboard.press('Enter')
    // 连续键盘操作覆盖真实重开路径，不等待上一次淡出动画。
    await page.keyboard.press('Control+p')
    await expect(palette.locator('input')).toBeFocused()
    await expect(palette.locator('input')).toHaveValue('')
    await palette.locator('input').fill('huge.txt')
    await expect(palette.locator('.palette__item').first()).toContainText('huge.txt')
    await page.keyboard.press('Enter')
    await expect(page.locator('.editor-tab.is-active')).toContainText('huge.txt')
    await expect(page.locator('.doc-view__banner')).toContainText('只读')
  })

  test('截断预览只读，键盘输入和保存不会丢掉文件尾部', async () => {
    await open('huge.txt')
    await expect(page.locator('.doc-view__banner')).toContainText('只读')
    await replace('must not overwrite')
    await page.keyboard.press('Control+s')
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)
    const content = readFileSync(join(workspace, 'huge.txt'), 'utf8')
    expect(content.endsWith('KEEP_FILE_TAIL')).toBe(true)
    expect(content.length).toBeGreaterThan(4 * 1024 * 1024)
  })
})
