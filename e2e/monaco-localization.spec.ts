/** 原生编辑器：官方中文菜单、查找替换、真实编辑落盘，以及外部修改的保存冲突保护。 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const APP_ROOT = resolve(__dirname, '..')
const FIXTURE_ROOT = join(APP_ROOT, '.e2e-tmp')
const ORIGINAL_SOURCE = 'first localization_probe\nsecond localization_probe\n'
let fixture = ''
let file = ''
let app: ElectronApplication | undefined
let page: Page
const pageErrors: string[] = []

test.describe.serial('Monaco 中文本地化', () => {
  test.beforeAll(async () => {
    mkdirSync(FIXTURE_ROOT, { recursive: true })
    fixture = mkdtempSync(join(FIXTURE_ROOT, 'monaco-localization-'))
    const workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    file = join(workspace, 'localization.txt')
    writeFileSync(file, ORIGINAL_SOURCE, 'utf8')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      autoStartEngine: false,
      lastFolder: workspace
    }), 'utf8')

    app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      cwd: APP_ROOT,
      env: { ...process.env }
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
    await page.keyboard.press('Control+p')
    const palette = page.locator('.palette[aria-label="快速打开文件"]')
    await expect(palette).toBeVisible()
    await palette.locator('.palette__input').fill('localization.txt')
    await expect(palette.locator('.palette__item').first()).toContainText('localization.txt')
    await page.keyboard.press('Enter')
    await expect(page.locator('.editor-tab.is-active')).toContainText('localization.txt')
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    const child = relative(FIXTURE_ROOT, fixture)
    if (fixture && child.startsWith('monaco-localization-') && !child.includes(sep)) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('首次右键菜单和 Monaco 命令面板使用官方中文标签', async () => {
    await expect(page.getByRole('button', { name: 'Code OSS', exact: true })).toHaveCount(0)
    await expect(page.locator('.editor-area')).toBeVisible()
    await expect(page.locator('.chat__input')).toBeVisible()
    expect(app?.windows()).toHaveLength(1)
    await page.locator('.monaco-editor .view-lines').first().click({ button: 'right' })
    const commands = page.getByRole('menuitem', { name: /^命令面板/ })
    await expect(commands).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^复制(?:\s|$)/ }).first()).toBeVisible()
    // Monaco deliberately attaches menu mouseup handlers after 100 ms to avoid
    // the opening right-click selecting an item; keep the real pointer path.
    await commands.click({ delay: 150 })
    await expect(commands).toBeHidden()
    const input = page.locator('.quick-input-widget input').first()
    await expect(input).toBeVisible()
    await input.fill('>查找下一个')
    await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText('查找下一个')
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
  })

  test('中文查找替换控件执行全部替换并保存真实文件', async () => {
    await page.locator('.monaco-editor .view-lines').first().click()
    await page.keyboard.press('Control+h')
    const find = page.locator('.monaco-editor .find-widget').first()
    await expect(find).toBeVisible()
    await expect(find).toHaveAttribute('aria-label', '查找/替换')
    await find.getByPlaceholder('查找', { exact: true }).fill('localization_probe')
    await find.getByPlaceholder('替换', { exact: true }).fill('已本地化')
    await find.getByRole('button', { name: /^全部替换/ }).click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(file, 'utf8')).toBe('first 已本地化\nsecond 已本地化\n')
    expect(pageErrors).toEqual([])
  })

  test('磁盘被其他工具更新时保留原生编辑器的未保存内容', async () => {
    await page.locator('.monaco-editor .view-lines').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('保留这段未保存的修改\n')
    await expect(page.locator('.doc-view__dirty')).toBeVisible()
    writeFileSync(file, '来自其他工具的新内容\n', 'utf8')
    await page.keyboard.press('Control+s')
    await expect(page.locator('.notice--error[role="alert"]')).toContainText('未覆盖磁盘内容')
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('保留这段未保存的修改')
    await expect(page.locator('.doc-view__dirty')).toBeVisible()
    expect(readFileSync(file, 'utf8')).toBe('来自其他工具的新内容\n')
    expect(pageErrors).toEqual([])
  })
})
