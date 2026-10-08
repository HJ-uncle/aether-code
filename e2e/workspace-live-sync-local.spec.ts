/** Real Electron filesystem fallback: external writes appear in an initially empty local tree and expanded Windows directories. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
let fixture = '', workspace = '', app: ElectronApplication | undefined, page: Page
const errors: string[] = []

function row(name: string) {
  return page.locator('.explorer__tree .tree-row').filter({ has: page.locator('.tree-row__name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
}

test.describe.serial('本地资源树自动同步外部文件', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'workspace-live-sync-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace)
    mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: false, lastFolder: workspace }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    await expect(page.locator('.explorer__tree')).toBeVisible()
    await expect(page.locator('.explorer__hint')).toHaveText('目录为空')
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('workspace-live-sync-')) throw new Error('Unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('空根目录在进程外真实写入后自动显示文件，无需刷新或引擎事件', async ({}, testInfo) => {
    // Bypass both renderer file-ops and engine streams, as terminal/subagent writes do.
    writeFileSync(join(workspace, 'index.html'), '<h1>五子棋：来自外部写入</h1>')
    await expect(row('index.html')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.explorer__hint')).toHaveCount(0)
    await row('index.html').click()
    await expect(page.locator('.editor-tab.is-active').first()).toContainText('index.html')
    await expect(page.locator('.doc-view__source .view-lines')).toContainText('五子棋：来自外部写入')
    await page.screenshot({ path: testInfo.outputPath('external-write-visible.png'), fullPage: true })
  })

  test('已展开的 Windows 子目录检测外部创建和删除，侧栏重新显示时立即同步', async () => {
    const folder = join(workspace, 'generated')
    mkdirSync(folder)
    await expect(row('generated')).toBeVisible({ timeout: 15_000 })
    if (await row('generated').getAttribute('aria-expanded') !== 'true') await row('generated').click()
    await expect(row('generated')).toHaveAttribute('aria-expanded', 'true')
    writeFileSync(join(folder, 'nested.txt'), '外部创建的子目录文件')
    await expect(row('nested.txt')).toBeVisible({ timeout: 15_000 })
    unlinkSync(join(folder, 'nested.txt'))
    await expect(row('nested.txt')).toHaveCount(0, { timeout: 15_000 })

    await page.keyboard.press('Control+b')
    await expect(page.locator('.sidebar')).toBeHidden()
    writeFileSync(join(workspace, 'while-hidden.txt'), '侧栏重新显示时同步')
    await page.keyboard.press('Control+b')
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(row('while-hidden.txt')).toBeVisible({ timeout: 10_000 })
  })
})
