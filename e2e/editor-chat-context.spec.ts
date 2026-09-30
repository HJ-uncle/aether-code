/** 真机：选区、文件、目录添加到对话；隐藏面板恢复；未保存快照与草稿一致。 */
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp')
const sessionId = 'editor-context-e2e'
let fixture = ''
let workspace = ''
let app: ElectronApplication
let page: Page
const errors: string[] = []
const draftText = 'first unsaved line\nsecond unsaved line\n'

async function openFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await palette.locator('input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name)
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active')).toContainText(name)
}

test.describe.serial('编辑器添加到对话', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true })
    fixture = mkdtempSync(join(fixtures, 'editor-context-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(join(workspace, 'folder'), { recursive: true })
    mkdirSync(profile)
    writeFileSync(join(workspace, 'sample.txt'), 'saved original\n')
    writeFileSync(join(workspace, 'folder', 'other.txt'), 'other\n')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, lastSessionId: sessionId }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
    await openFile('sample.txt')
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    const child = relative(fixtures, fixture)
    if (child.startsWith('editor-context-') && !child.includes(sep)) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('选区快捷键展开隐藏对话并保留实际未保存文本及排他结束行', async () => {
    await page.getByRole('button', { name: '关闭对话面板', exact: true }).click()
    await page.locator('.monaco-editor .view-lines').first().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText(draftText)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+l')
    const input = page.locator('.mention-input')
    await expect(input).toBeVisible()
    await expect(input.locator('.mention-chip--code')).toHaveText('sample.txt:1-2')
    await expect(input).toBeFocused()
    await expect.poll(() => page.evaluate((id) => {
      const drafts = JSON.parse(localStorage.getItem('aether:chatDrafts') ?? '{}')
      return drafts[id]?.mentions?.[0]?.content
    }, sessionId)).toBe(draftText)
    expect(readFileSync(join(workspace, 'sample.txt'), 'utf8')).toBe('saved original\n')
  })

  test('文件工具栏添加未保存全文；关闭重开对话仍恢复快照 chip', async () => {
    await page.getByRole('button', { name: '将当前文件添加到对话', exact: true }).click()
    await expect(page.locator('.mention-chip--file')).toContainText('未保存')
    await page.getByRole('button', { name: '关闭对话面板', exact: true }).click()
    await page.getByRole('button', { name: '将当前文件添加到对话', exact: true }).click()
    await expect(page.locator('.mention-chip--code')).toHaveCount(1)
    await expect(page.locator('.mention-chip--file')).toHaveCount(1)
    await expect.poll(() => page.evaluate((id) => {
      const drafts = JSON.parse(localStorage.getItem('aether:chatDrafts') ?? '{}')
      return drafts[id]?.mentions?.map((mention: {content?:string}) => mention.content)
    }, sessionId)).toEqual([draftText, draftText])
  })

  test('文件标签右键可添加到对话，目录也提供同样入口', async () => {
    await openFile('other.txt')
    await page.locator('.editor-tab.is-active').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^添加到对话/ }).click()
    await expect(page.locator('.mention-chip--file').filter({ hasText: 'folder/other.txt' })).toHaveCount(1)
    const tree = page.locator('[role="treeitem"]').filter({ hasText: /^folder$/ }).first()
    await expect(tree).toBeVisible()
    await tree.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^添加到对话/ }).click()
    await expect(page.locator('.mention-chip--dir')).toContainText('folder')
  })
})
