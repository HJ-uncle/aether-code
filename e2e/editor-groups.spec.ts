/** 真机编辑组：共享dirty模型、独立标签/光标、焦点保存与格式化、最后视图关闭及批量保存失败保护。 */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const original = 'one\ntwo\nthree\n'
let fixture = ''
let workspace = ''
let profile = ''
let app: ElectronApplication | undefined
let page: Page
const errors: string[] = []
const groups = (): Locator => page.locator('[data-editor-group]')
const left = (): Locator => groups().first()
const right = (): Locator => groups().nth(1)
const tab = (group: Locator, name: string): Locator => group.locator('.editor-tab').filter({ has: page.locator('.editor-tab__label', { hasText: name }) })

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

async function replaceText(group: Locator, content: string): Promise<void> {
  const instance = app!
  const previousClipboard = await instance.evaluate(({ clipboard }) => clipboard.readText())
  await instance.evaluate(({ clipboard }, text) => clipboard.writeText(text), content)
  try {
    await group.locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+a')
    // insertText 属于键入，Monaco会逐字符自动闭合；整段源码替换应验证真正的粘贴路径。
    await page.keyboard.press('Control+v')
    await expect(group.locator('.monaco-editor .view-line')).toHaveText(content.split(/\r?\n/))
  } finally {
    await instance.evaluate(({ clipboard }, values) => {
      if (clipboard.readText() === values.inserted) clipboard.writeText(values.previous)
    }, { inserted: content, previous: previousClipboard })
  }
  await expect(group.locator('.doc-view__dirty')).toBeVisible()
}

async function closeAllFromMenu(group: Locator): Promise<void> {
  await group.locator('.editor-tab.is-active').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^全部关闭(?:\s|$)/ }).click()
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env } })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(String(error)))
  await expect(page.locator('.workbench')).toBeVisible()
}

test.describe.serial('独立左右编辑组', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'editor-groups-'))
    workspace = join(fixture, 'workspace')
    profile = join(fixture, 'profile')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(workspace, 'left.txt'), original)
    writeFileSync(join(workspace, 'right.json'), '{"right":0}')
    writeFileSync(join(workspace, 'spare.txt'), 'spare disk\n')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    await launch()
    await openFile('left.txt')
  })

  test.afterEach(() => expect(errors).toEqual([]))

  test.afterAll(async () => {
    await app?.close()
    const child = relative(fixtureRoot, fixture)
    if (fixture && child.startsWith('editor-groups-') && !child.includes(sep)) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('拆分共享未保存模型，关闭一侧不丢稿，最后一个视图仍确认', async () => {
    await replaceText(left(), 'unsaved left\n')
    await left().getByRole('button', { name: '向右拆分编辑器', exact: true }).click()
    await expect(groups()).toHaveCount(2)
    await expect(right().locator('.monaco-editor .view-lines')).toContainText('unsaved left')
    await expect(page.locator('.doc-view__dirty')).toHaveCount(2)
    expect(readFileSync(join(workspace, 'left.txt'), 'utf8')).toBe(original)

    await right().getByRole('button', { name: '关闭 left.txt', exact: true }).click()
    await expect(right().locator('.editor-tab')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(left().locator('.monaco-editor .view-lines')).toContainText('unsaved left')
    await right().getByRole('button', { name: '关闭编辑组', exact: true }).click()
    await expect(groups()).toHaveCount(1)

    await left().locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+w')
    const dialog = page.getByRole('dialog', { name: '关闭未保存的文件' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(tab(left(), 'left.txt')).toBeVisible()
  })

  test('两组标签独立，右组保存和命令面板格式化不作用到左组', async () => {
    await left().getByRole('button', { name: '向右拆分编辑器', exact: true }).click()
    await expect(groups()).toHaveCount(2)
    await openFile('right.json')
    await expect(tab(left(), 'right.json')).toHaveCount(0)
    await expect(tab(right(), 'right.json')).toBeVisible()
    await replaceText(right(), '{"right":7,"nested":{"enabled":true}}')
    await page.keyboard.press('Control+Shift+p')
    const palette = page.locator('.palette[aria-label="命令面板"]')
    await palette.locator('.palette__input').fill('格式化文档')
    await palette.locator('.palette__item[title="aether.editor.formatDocument"]').click()
    await expect.poll(() => right().locator('.monaco-editor .view-line').count()).toBeGreaterThan(1)
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(workspace, 'right.json'), 'utf8').replace(/\r\n/g, '\n').trimEnd())
      .toBe(JSON.stringify({ right: 7, nested: { enabled: true } }, null, 2))
    expect(readFileSync(join(workspace, 'left.txt'), 'utf8')).toBe(original)
    await expect(left().locator('.doc-view__dirty')).toBeVisible()
  })

  test('同一文件的左右光标和切标签视图记忆独立', async () => {
    const sharedSource = 'first\nsecond\nthird\n'
    await replaceText(left(), sharedSource)
    await tab(right(), 'left.txt').click()
    await right().locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+End')
    await tab(right(), 'right.json').click()
    await left().locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Control+Home')
    await tab(right(), 'left.txt').click()
    await page.keyboard.insertText('RIGHT')
    await tab(left(), 'left.txt').click()
    await page.keyboard.insertText('LEFT')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(workspace, 'left.txt'), 'utf8')).toBe(`LEFT${sharedSource}RIGHT`)
    await expect(right().locator('.monaco-editor .view-lines')).toContainText('LEFTfirst')
    await right().getByRole('button', { name: '关闭编辑组', exact: true }).click()
    await expect(groups()).toHaveCount(1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('批量关闭取消不丢稿，任意保存冲突时整批标签保留', async () => {
    await left().locator('.monaco-editor .view-lines').click()
    await openFile('spare.txt')
    await replaceText(left(), 'spare edited\n')
    await tab(left(), 'left.txt').click()
    await replaceText(left(), 'left batch saved\n')
    await closeAllFromMenu(left())
    const firstDialog = page.getByRole('dialog', { name: '关闭 2 个未保存的文件' })
    await expect(firstDialog).toBeVisible()
    await firstDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(tab(left(), 'left.txt')).toBeVisible()
    await expect(tab(left(), 'spare.txt')).toBeVisible()

    writeFileSync(join(workspace, 'spare.txt'), 'external version\n')
    await closeAllFromMenu(left())
    await page.getByRole('dialog').getByRole('button', { name: '全部保存并关闭', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('保存失败，文件均未关闭', { exact: true })).toBeVisible()
    await expect(tab(left(), 'left.txt')).toBeVisible()
    await expect(tab(left(), 'spare.txt')).toBeVisible()
    await expect.poll(() => readFileSync(join(workspace, 'left.txt'), 'utf8')).toBe('left batch saved\n')
    expect(readFileSync(join(workspace, 'spare.txt'), 'utf8')).toBe('external version\n')
    await tab(left(), 'spare.txt').click()
    await expect(left().locator('.monaco-editor .view-lines')).toContainText('spare edited')
  })

  test('重启恢复两个组的独立标签、活动项、焦点与未保存草稿', async () => {
    await left().getByRole('button', { name: '向右拆分编辑器', exact: true }).click()
    await expect(groups()).toHaveCount(2)
    await openFile('left.txt')
    await replaceText(right(), 'recovered right draft\n')
    await expect.poll(() => page.evaluate(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith('aether.editor.recovery:'))
      return key ? JSON.parse(localStorage.getItem(key)!).groups?.groups.length : 0
    })).toBe(2)
    await app!.close()
    await launch()
    await expect(groups()).toHaveCount(2)
    await expect(left().locator('.editor-tab.is-active')).toContainText('spare.txt')
    await expect(right().locator('.editor-tab.is-active')).toContainText('left.txt')
    await expect(right()).toHaveClass(/is-focused-group/)
    await expect(left().locator('.monaco-editor .view-lines')).toContainText('spare edited')
    await expect(right().locator('.monaco-editor .view-lines')).toContainText('recovered right draft')
    await expect(tab(right(), 'spare.txt')).toBeVisible()
    expect(readFileSync(join(workspace, 'spare.txt'), 'utf8')).toBe('external version\n')
    expect(readFileSync(join(workspace, 'left.txt'), 'utf8')).toBe('left batch saved\n')
  })

  test('重命名共享文档后两个组仍保留各自标签和未保存内容', async () => {
    await tab(right(), 'spare.txt').click()
    const entry = page.locator('.tree-row').filter({ has: page.locator('.tree-row__name', { hasText: 'spare.txt' }) }).first()
    await expect(entry).toBeVisible()
    await entry.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^重命名(?:\s|$)/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').fill('renamed-spare.txt')
    await dialog.getByRole('button', { name: '重命名', exact: true }).click()
    await expect.poll(() => existsSync(join(workspace, 'renamed-spare.txt'))).toBe(true)
    expect(existsSync(join(workspace, 'spare.txt'))).toBe(false)
    for (const group of [left(), right()]) {
      await expect(group.locator('.editor-tab.is-active')).toContainText('renamed-spare.txt')
      await expect(group.locator('.monaco-editor .view-lines')).toContainText('spare edited')
      await expect(group.locator('.doc-view__dirty')).toBeVisible()
    }
    expect(readFileSync(join(workspace, 'renamed-spare.txt'), 'utf8')).toBe('external version\n')
  })
})
