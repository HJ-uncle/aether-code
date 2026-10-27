/** 真机：文本暖切换复用 Monaco，独立 ViewState/Undo、共享分栏模型与保存/释放不回归。 */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication, page: Page, fixture = '', workspace = ''
const errors: string[] = []
const originalA = Array.from({ length: 120 }, (_, index) => `a-${index + 1}`).join('\n')
const originalB = 'b-first\r\nb-last'
const groups = (): Locator => page.locator('[data-editor-group]')
const left = (): Locator => groups().first()
const tab = (group: Locator, name: string): Locator => group.locator('.editor-tab').filter({ hasText: name })

async function openFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await palette.locator('.palette__input').fill(name)
  const item = palette.locator('.palette__item').filter({ hasText: name }).first()
  await expect(item).toBeVisible()
  await item.click()
  await expect(page.locator('.is-focused-group .editor-tab.is-active')).toContainText(name)
  await expect(page.locator('.is-focused-group .monaco-editor .view-lines')).toBeVisible()
}

async function lifecycle(host: Locator): Promise<{ created: number; disposed: number }> {
  return host.evaluate((element) => ({
    created: Number(element.getAttribute('data-monaco-create-count')),
    disposed: Number(element.getAttribute('data-monaco-dispose-count'))
  }))
}

test.describe.serial('Monaco 暖切换性能与编辑语义', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true })
    fixture = mkdtempSync(join(parent, 'monaco-warm-'))
    workspace = join(fixture, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), originalA)
    writeFileSync(join(workspace, 'b.txt'), originalB)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await openFile('a.txt')
  })

  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (fixture && dirname(fixture) === parent && basename(fixture).startsWith('monaco-warm-')) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('切换不重建编辑器，Undo/ViewState/保存与分栏模型保持正确', async () => {
    const host = left().locator('.monaco-host')
    const originalHandle = await host.elementHandle()
    const initial = await lifecycle(host)
    expect(initial.created).toBeGreaterThan(0)

    await left().locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+End')
    const cursor = left().locator('[data-testid="doc-cursor"]')
    await page.keyboard.insertText('\nA-EDIT')
    const aCursor = await cursor.innerText()
    await openFile('b.txt')
    expect(await lifecycle(host)).toEqual(initial)
    await left().locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\nB-EDIT')
    await tab(left(), 'a.txt').click()
    expect(await lifecycle(host)).toEqual(initial)
    expect(await originalHandle!.evaluate((element) => element.isConnected)).toBe(true)
    await expect.poll(() => cursor.innerText()).toBe(aCursor)

    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe(originalA)
    await tab(left(), 'b.txt').click()
    await expect(left().locator('.monaco-editor .view-lines')).toContainText('B-EDIT')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+Shift+z')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe(`${originalB}\r\nB-EDIT`)
    expect(await lifecycle(host)).toEqual(initial)

    await left().getByRole('button', { name: '向右拆分编辑器', exact: true }).click()
    await expect(groups()).toHaveCount(2)
    const rightHost = groups().nth(1).locator('.monaco-host')
    expect((await lifecycle(rightHost)).created).toBe(initial.created + 1)
    expect(await lifecycle(host)).toEqual(initial)
    await groups().nth(1).locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('-RIGHT')
    await expect(left().locator('.monaco-editor .view-lines')).toContainText('B-EDIT-RIGHT')
    await expect(groups().nth(1).locator('.doc-view__dirty')).toBeVisible()

    const rightHandle = await rightHost.elementHandle()
    await groups().nth(1).getByRole('button', { name: '关闭编辑组', exact: true }).click()
    await expect(groups()).toHaveCount(1)
    expect(await rightHandle!.evaluate((element) => element.isConnected)).toBe(false)
    expect(Number(await rightHandle!.evaluate((element) => element.getAttribute('data-monaco-dispose-count'))))
      .toBe(initial.disposed + 1)
    await expect(left().locator('.monaco-editor .view-lines')).toContainText('B-EDIT-RIGHT')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(workspace, 'b.txt'), 'utf8')).toContain('B-EDIT-RIGHT')
  })
})
