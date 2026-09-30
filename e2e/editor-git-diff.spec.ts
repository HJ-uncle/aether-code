/** 真机：Git行进入双版本比较，工作区编辑可保存且与源码共享，暂存比较只读。 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp')
let fixture = ''
let workspace = ''
let app: ElectronApplication
let page: Page
const errors: string[] = []
function git(...args: string[]): string { return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }) }

test.describe.serial('编辑区Git差异', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true })
    fixture = mkdtempSync(join(fixtures, 'editor-git-diff-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    git('init'); git('config', 'user.name', 'Editor Test'); git('config', 'user.email', 'editor-test@example.invalid')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(join(workspace, 'work.txt'), 'baseline content\n')
    writeFileSync(join(workspace, 'staged.txt'), 'staged baseline\n')
    git('add', '.'); git('commit', '-m', 'fixture baseline')
    writeFileSync(join(workspace, 'work.txt'), 'worktree changed\n')
    writeFileSync(join(workspace, 'staged.txt'), 'index snapshot\n')
    git('add', 'staged.txt')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, lastSessionId: 'git-diff-e2e' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
    await page.getByRole('button', { name: '版本控制', exact: true }).click()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    const child = relative(fixtures, fixture)
    if (child.startsWith('editor-git-diff-') && !child.includes(sep)) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('点Git文件进入真正差异视图，修改侧编辑保存到目标文件', async () => {
    const row = page.locator('.git-row[title="work.txt"]')
    await expect(row).toBeVisible()
    await row.click()
    const diff = page.getByRole('region', { name: '文件差异编辑器' })
    await expect(diff).toBeVisible()
    await expect(diff.locator('.original .view-lines')).toContainText('baseline content')
    await expect(diff.locator('.modified .view-lines:not(.line-delete)')).toContainText('worktree changed')
    await diff.locator('.modified .view-lines:not(.line-delete)').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('edited from real diff\n')
    await diff.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => readFileSync(join(workspace, 'work.txt'), 'utf8')).toBe('edited from real diff\n')
    await diff.getByRole('button', { name: '行内比较', exact: true }).click()
    await expect(diff.getByRole('button', { name: '并排比较', exact: true })).toBeVisible()
    await diff.getByRole('button', { name: '打开源码', exact: true }).click()
    await expect(page.locator('.doc-view .monaco-editor .view-lines')).toContainText('edited from real diff')
  })

  test('暂存比较展示index快照且不能编辑或误保存其它文件', async () => {
    await page.locator('.git-row[title="staged.txt"]').click()
    const diff = page.getByRole('region', { name: '文件差异编辑器' })
    await expect(diff).toContainText('HEAD ↔ 暂存区（只读）')
    await expect(diff.locator('.modified .view-lines:not(.line-delete)')).toContainText('index snapshot')
    await expect(diff.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
    await diff.locator('.modified .view-lines:not(.line-delete)').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('must not change index')
    await page.keyboard.press('Control+s')
    expect(git('show', ':0:staged.txt')).toBe('index snapshot\n')
    expect(readFileSync(join(workspace, 'staged.txt'), 'utf8')).toBe('index snapshot\n')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+Shift+p')
    const commands = page.locator('.palette[aria-label="命令面板"]')
    await commands.locator('input').fill('添加选区到对话')
    await commands.locator('.palette__item[title="aether.editor.addSelectionToChat"]').click()
    await expect(page.locator('.mention-chip--code')).toContainText('staged.txt:1')
    await expect.poll(() => page.evaluate(() => {
      const drafts = JSON.parse(localStorage.getItem('aether:chatDrafts') ?? '{}')
      return drafts['git-diff-e2e']?.mentions?.[0]?.content
    })).toBe('index snapshot\n')
  })

  test('关闭共享的未保存源文件先确认，再释放差异模型且可刷新重开', async () => {
    await page.locator('.git-row[title="work.txt"]').click()
    const diff = page.getByRole('region', { name: '文件差异编辑器' })
    const modified = diff.locator('.modified .view-lines:not(.line-delete)')
    await expect(modified).toContainText('edited from real diff')
    await modified.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('unsaved diff draft\n')
    await page.getByRole('button', { name: '关闭 work.txt', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(modified).toContainText('unsaved diff draft')
    await page.getByRole('button', { name: '关闭 work.txt', exact: true }).click()
    await dialog.getByRole('button', { name: /不保存|放弃/ }).click()
    await expect(diff).toContainText('源文件已关闭')
    expect(readFileSync(join(workspace, 'work.txt'), 'utf8')).toBe('edited from real diff\n')
    await diff.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(modified).toContainText('edited from real diff')
  })
})
