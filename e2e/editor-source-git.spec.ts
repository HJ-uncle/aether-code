/** Real source editor: HEAD gutter, live unsaved hunks, buffer-only undo, conflict actions,
 * blame line mapping and horizontal wheel routing inside Monaco overlay toolbars. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp')
const original = 'first line\nsecond original\nthird unchanged\nfourth unchanged\nfifth original\nlast unchanged\n'
const worktree = original.replace('second original', 'second modified').replace('fifth original', 'fifth modified')
const conflict = 'before\n<<<<<<< HEAD\ncurrent choice\n=======\nincoming choice\n>>>>>>> feature\nafter\n'
let fixture = ''
let workspace = ''
let app: ElectronApplication
let page: Page
const errors: string[] = []
const disk = (file: string): string => readFileSync(join(workspace, file), 'utf8')
function git(...args: string[]): string { return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }) }
async function open(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await palette.locator('.palette__input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name)
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active')).toContainText(name)
  await expect(page.locator('.doc-view .monaco-editor .view-lines').first()).toBeVisible()
}
const source = () => page.locator('.doc-view .monaco-editor .view-lines').first()

async function expectToolbarHorizontalWheel(toolbar: Locator): Promise<void> {
  const originalSize = await toolbar.evaluate(element => {
    const node = element as HTMLElement
    const original = { width: node.style.width, maxWidth: node.style.maxWidth }
    node.style.width = '240px'; node.style.maxWidth = '240px'; node.scrollLeft = 0
    return original
  })
  try {
    await expect(toolbar).toHaveAttribute('data-scroll-axis', 'x')
    await expect.poll(() => toolbar.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
    const styles = await toolbar.evaluate(element => {
      const style = getComputedStyle(element), node = element as HTMLElement
      return { overflowY: style.overflowY, width: style.scrollbarWidth,
        reserved: node.offsetHeight - node.clientHeight,
        borders: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) }
    })
    expect(styles).toMatchObject({ overflowY: 'hidden', width: 'none' })
    expect(Math.abs(styles.reserved - styles.borders)).toBeLessThanOrEqual(1)
    const verticalPosition = () => toolbar.evaluate(element => {
      const lines = element.closest('.monaco-editor')?.querySelector<HTMLElement>('.lines-content')
      if (!lines) throw new Error('Expected toolbar inside the source editor')
      return { toolbar: element.scrollTop, linesTop: getComputedStyle(lines).top, linesTransform: getComputedStyle(lines).transform }
    })
    await toolbar.hover()
    const overlay = page.locator('.horizontal-scrollbar')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute('role', 'scrollbar')
    await expect(overlay).toHaveAttribute('aria-orientation', 'horizontal')
    await expect.poll(async () => {
      const track = await overlay.boundingBox(), bounds = await toolbar.boundingBox()
      return track && bounds ? Math.abs(track.y + track.height - bounds.y - bounds.height) : Infinity
    }).toBeLessThanOrEqual(2)
    expect((await overlay.boundingBox())!.height).toBeLessThanOrEqual(8)
    const paintedHeight = await overlay.locator('.horizontal-scrollbar__thumb').evaluate(element => parseFloat(getComputedStyle(element, '::after').height))
    expect(paintedHeight).toBeGreaterThan(0); expect(paintedHeight).toBeLessThanOrEqual(2)
    const before = await verticalPosition()
    await page.mouse.wheel(0, 90)
    await expect.poll(() => toolbar.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    expect(await verticalPosition()).toEqual(before)
  } finally {
    await toolbar.evaluate((element, originalSize) => {
      const node = element as HTMLElement
      node.style.width = originalSize.width; node.style.maxWidth = originalSize.maxWidth; node.scrollLeft = 0
    }, originalSize)
  }
}

test.describe.serial('源码Git交互', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true })
    fixture = mkdtempSync(join(fixtures, 'source-git-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    git('init'); git('config', 'user.name', 'Source Git Test'); git('config', 'user.email', 'source-git@example.invalid'); git('config', 'core.autocrlf', 'false')
    writeFileSync(join(workspace, 'changes.txt'), original)
    writeFileSync(join(workspace, 'blame.txt'), original)
    writeFileSync(join(workspace, 'conflict.txt'), 'before\nresolved\nafter\n')
    git('add', '.'); git('commit', '-m', 'source fixture baseline')
    writeFileSync(join(workspace, 'changes.txt'), worktree)
    writeFileSync(join(workspace, 'conflict.txt'), conflict)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    const env: Record<string, string> = { AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'AETHER_GLOBAL_DIR') env[name] = value
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      const gitReceipt = await page.evaluate(async workspace => ({
        head: await window.aether.git.headFile(workspace, 'changes.txt'),
        blame: await window.aether.git.blame(workspace, 'changes.txt'),
        editors: document.querySelectorAll('.monaco-editor').length,
        gutter: document.querySelectorAll('.source-git-gutter').length,
        conflicts: document.querySelectorAll('.source-conflict-actions').length
      }), workspace)
      await info.attach('source-git-receipt', { body: JSON.stringify(gitReceipt), contentType: 'application/json' })
    }
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    await app?.close()
    const child = relative(fixtures, fixture)
    if (child.startsWith('source-git-') && !child.includes(sep)) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('源码gutter通过F7打开双版本块，回滚只改buffer且Ctrl+Z恢复', async () => {
    await open('changes.txt')
    await expect(page.locator('.doc-view .source-git-gutter-modified').first()).toBeVisible()
    await source().click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('F7')
    const preview = page.getByRole('region', { name: '当前更改块' })
    await expect(preview).toContainText('second original')
    await expect(preview).toContainText('second modified')
    await expectToolbarHorizontalWheel(preview.locator('.source-git-preview-header'))
    await preview.getByRole('button', { name: '撤销此处更改', exact: true }).click()
    await expect(source()).toContainText('second original')
    expect(disk('changes.txt')).toBe(worktree)
    await expect(page.locator('.doc-view__dirty')).toContainText('未保存')
    await page.keyboard.press('Control+z')
    await expect(source()).toContainText('second modified')
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)
  })

  test('未保存新增行即时出现gutter，blame保持正确HEAD行归属', async () => {
    await open('blame.txt')
    await source().click()
    await page.keyboard.press('Control+Home')
    await expect(page.locator('.editor-blame-status')).toContainText('Source Git Test')
    await page.keyboard.type('unsaved inserted line')
    await page.keyboard.press('Enter')
    await expect(page.locator('.doc-view .source-git-gutter-added').first()).toBeVisible()
    await page.keyboard.press('Control+Home')
    await expect(page.locator('.editor-blame-status')).toHaveText('尚未提交的更改')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.editor-blame-status')).toContainText('Source Git Test')
    expect(disk('blame.txt')).toBe(original)
    // Enter is its own undo group. Verify both user operations rather than
    // assuming multiline CDP insertText creates a single paste transaction.
    await page.keyboard.press('Control+z')
    await expect(page.locator('.doc-view__status')).toContainText(`${original.length + 'unsaved inserted line'.length} 字符`)
    await page.keyboard.press('Control+z')
    await expect(source()).not.toContainText('unsaved inserted line')
  })

  test('合并冲突接受传入内容可撤销，保存才改变磁盘', async () => {
    await open('conflict.txt')
    const actions = page.locator('.source-conflict-actions')
    await expect(actions).toBeVisible()
    await expectToolbarHorizontalWheel(actions)
    await actions.getByRole('button', { name: '采用传入更改', exact: true }).click()
    await expect(source()).toContainText('incoming choice')
    await expect(source()).not.toContainText('current choice')
    await expect(actions).toHaveCount(0)
    expect(disk('conflict.txt')).toBe(conflict)
    await page.keyboard.press('Control+z')
    await expect(actions).toBeVisible()
    await actions.getByRole('button', { name: '保留双方更改', exact: true }).click()
    await expect(source()).toContainText('current choice')
    await expect(source()).toContainText('incoming choice')
    await page.keyboard.press('Control+s')
    await expect.poll(() => disk('conflict.txt')).toBe('before\ncurrent choice\nincoming choice\nafter\n')
  })
})
