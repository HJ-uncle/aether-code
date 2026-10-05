/** Aether 中文编辑命令：焦点恢复、替换/格式化落盘、跳行、跨标签显示选项、不可用操作反馈。 */
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
const FILE_NAME = 'commands.txt'
const SECOND_FILE_NAME = 'commands-secondary.txt'
const SECOND_SOURCE = ['secondary file', 'wrap-secondary '.repeat(80), ''].join('\n')
const JSON_FILE_NAME = 'format.json'
const JSON_SOURCE = '{"probe":1,"nested":{"enabled":true}}'
// A line much wider than the editor makes wrapping observable without reading
// Monaco internals or assuming a particular font size, window width, or DPR.
const ORIGINAL_SOURCE = [
  'first command_probe',
  'second command_probe',
  'wrap-visible '.repeat(80),
  ''
].join('\n')
let fixture = ''
let file = ''
let secondFile = ''
let jsonFile = ''
let app: ElectronApplication | undefined
let page: Page
const pageErrors: string[] = []

async function openTextFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(palette).toBeVisible()
  await palette.locator('.palette__input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name, { timeout: 30_000 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active')).toContainText(name)
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
}

async function runEditorCommand(id: string, title: string): Promise<void> {
  await page.keyboard.press('Control+Shift+p')
  const palette = page.locator('.palette[aria-label="命令面板"]')
  await expect(palette).toBeVisible()
  const input = palette.locator('.palette__input')
  await input.fill(title)
  await expect(input).toBeFocused()
  const command = palette.locator(`.palette__item[title="aether.editor.${id}"]`)
  await expect(command).toContainText(`编辑器: ${title}`)
  await expect(command).toBeEnabled()
  // The palette has taken focus. Do not refocus Monaco here: dispatch must
  // retain the most recently active editor while this overlay is open.
  await command.click()
  await expect(palette).toBeHidden()
}

test.describe.serial('Aether 编辑器命令', () => {
  test.beforeAll(async () => {
    mkdirSync(FIXTURE_ROOT, { recursive: true })
    fixture = mkdtempSync(join(FIXTURE_ROOT, 'editor-commands-'))
    const workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    file = join(workspace, FILE_NAME)
    writeFileSync(file, ORIGINAL_SOURCE, 'utf8')
    secondFile = join(workspace, SECOND_FILE_NAME)
    writeFileSync(secondFile, SECOND_SOURCE, 'utf8')
    jsonFile = join(workspace, JSON_FILE_NAME)
    writeFileSync(jsonFile, JSON_SOURCE, 'utf8')
    // These commands belong to the native editor and must work without an AI
    // engine, a provider account, or an external language server.
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({
        autoStartEngine: false,
        lastFolder: workspace
      }),
      'utf8'
    )

    app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      cwd: APP_ROOT,
      env: { ...process.env }
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
    await openTextFile(FILE_NAME)
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('command_probe')
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  test.afterAll(async () => {
    await app?.close()
    const child = relative(FIXTURE_ROOT, fixture)
    if (fixture && child.startsWith('editor-commands-') && !child.includes(sep)) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('命令面板获得焦点后，替换仍作用于上一个编辑器并保存到磁盘', async () => {
    await page.locator('.monaco-editor .view-lines').first().click()
    await runEditorCommand('replace', '替换')
    const find = page.locator('.monaco-editor .find-widget').first()
    await expect(find).toBeVisible()
    await expect(find).toHaveAttribute('aria-label', '查找/替换')
    await find.getByPlaceholder('查找', { exact: true }).fill('command_probe')
    await find.getByPlaceholder('替换', { exact: true }).fill('已执行命令')
    await find.getByRole('button', { name: /^全部替换/ }).click()
    await page.keyboard.press('Escape')
    // Monaco keeps the find widget mounted and moves it outside the editor.
    await expect(find).toHaveAttribute('aria-hidden', 'true')
    await page.keyboard.press('Control+s')
    await expect
      .poll(() => readFileSync(file, 'utf8'))
      .toBe(ORIGINAL_SOURCE.replaceAll('command_probe', '已执行命令'))
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)
  })

  test('中文自动换行命令改变长行的实际排版并可恢复', async () => {
    await page.locator('.monaco-editor .view-lines').first().click()
    await page.keyboard.press('Control+Home')
    const visualLines = page.locator('.monaco-editor .view-lines .view-line')
    await expect(visualLines).toHaveCount(4)
    const unwrappedCount = await visualLines.count()
    await runEditorCommand('toggleWordWrap', '切换自动换行')
    await expect.poll(() => visualLines.count()).toBeGreaterThan(unwrappedCount)
    await runEditorCommand('toggleWordWrap', '切换自动换行')
    await expect(visualLines).toHaveCount(unwrappedCount)
    expect(readFileSync(file, 'utf8')).toBe(
      ORIGINAL_SOURCE.replaceAll('command_probe', '已执行命令')
    )
  })

  test('中文小地图命令隐藏并恢复实际小地图区域', async () => {
    const minimap = page.locator('.monaco-editor .minimap').first()
    const width = (): Promise<number> =>
      minimap.evaluate((element) => element.getBoundingClientRect().width)
    await expect.poll(width).toBeGreaterThan(0)
    await runEditorCommand('toggleMinimap', '切换小地图')
    await expect.poll(width).toBe(0)
    await runEditorCommand('toggleMinimap', '切换小地图')
    await expect.poll(width).toBeGreaterThan(0)
  })

  test('自动换行和小地图选择在打开另一文件并切回后仍保持', async () => {
    await expect(page.locator('.editor-tab.is-active')).toContainText(FILE_NAME)
    await page.locator('.monaco-editor .view-lines').first().click()
    await page.keyboard.press('Control+Home')
    const visualLines = page.locator('.monaco-editor .view-lines .view-line')
    const minimap = page.locator('.monaco-editor .minimap').first()
    const width = (): Promise<number> =>
      minimap.evaluate((element) => element.getBoundingClientRect().width)
    await expect(visualLines).toHaveCount(4)
    await expect.poll(width).toBeGreaterThan(0)

    await runEditorCommand('toggleWordWrap', '切换自动换行')
    await runEditorCommand('toggleMinimap', '切换小地图')
    await expect.poll(() => visualLines.count()).toBeGreaterThan(4)
    await expect.poll(width).toBe(0)

    // A newly mounted editor must inherit the user's display choices. The
    // rendered line count and minimap width also catch options lost on remount.
    await openTextFile(SECOND_FILE_NAME)
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('secondary file')
    await expect.poll(() => visualLines.count()).toBeGreaterThan(3)
    await expect.poll(width).toBe(0)

    await page.locator('.editor-tab', { hasText: FILE_NAME }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText(FILE_NAME)
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('first 已执行命令')
    await expect.poll(() => visualLines.count()).toBeGreaterThan(4)
    await expect.poll(width).toBe(0)

    // The shared window's later cases expect the original display options and
    // one text tab, so restore both through the same user-facing commands.
    await runEditorCommand('toggleWordWrap', '切换自动换行')
    await runEditorCommand('toggleMinimap', '切换小地图')
    await expect(visualLines).toHaveCount(4)
    await expect.poll(width).toBeGreaterThan(0)
    await page.getByRole('button', { name: `关闭 ${SECOND_FILE_NAME}`, exact: true }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText(FILE_NAME)
    expect(readFileSync(secondFile, 'utf8')).toBe(SECOND_SOURCE)
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL_SOURCE.replaceAll('command_probe', '已执行命令'))
  })

  test('从命令面板转到行后，原生跳转输入框定位原文件光标', async () => {
    await runEditorCommand('goToLine', '转到行')
    const input = page.locator('.quick-input-widget input').first()
    await expect(input).toBeVisible()
    await input.fill(':2:3')
    await page.keyboard.press('Enter')
    await expect(input).toBeHidden()
    await expect(page.locator('[data-testid="doc-cursor"]')).toHaveText('行 2，列 3')
    await expect(page.locator('.editor-tab.is-active')).toContainText(FILE_NAME)
  })

  test('JSON 文档格式化实际修改缓冲并可保存，符号快捷键不打开安全设置', async () => {
    await openTextFile(JSON_FILE_NAME)
    // JSON worker/provider 懒加载；等真实格式化产生脏缓冲，避免固定延时。
    await expect(async () => {
      await runEditorCommand('formatDocument', '格式化文档')
      await expect(page.locator('.doc-view__dirty')).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1000] })
    expect(readFileSync(jsonFile, 'utf8')).toBe(JSON_SOURCE)
    await page.keyboard.press('Control+s')
    // 只把完整且可解析的 JSON 视为保存完成，避免文件观察器或平台
    // 写入窗口把中间内容误判成最终结果。
    await expect
      .poll(() => {
        const candidate = readFileSync(jsonFile, 'utf8')
        if (candidate === JSON_SOURCE || !candidate.includes('\n')) return null
        try {
          return JSON.parse(candidate) as unknown
        } catch {
          return null
        }
      })
      .toEqual(JSON.parse(JSON_SOURCE))
    const formatted = readFileSync(jsonFile, 'utf8')
    expect(formatted).toContain('\n')
    expect(JSON.parse(formatted)).toEqual(JSON.parse(JSON_SOURCE))
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)

    await page.keyboard.press('Control+Shift+o')
    const symbols = page.locator('.quick-input-widget input').first()
    await expect(symbols).toBeVisible()
    await expect(symbols).toHaveValue(/^@/)
    await expect(page.locator('.editor-tab.is-active')).toContainText(JSON_FILE_NAME)
    await expect(page.locator('.app-settings')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(symbols).toBeHidden()
    await page.getByRole('button', { name: `关闭 ${JSON_FILE_NAME}`, exact: true }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText(FILE_NAME)
  })

  test('纯文本没有格式化服务时提供中文反馈且不改变文件', async () => {
    const saved = readFileSync(file, 'utf8')
    await runEditorCommand('formatDocument', '格式化文档')
    await expect(
      page.locator('.toast-host__text', {
        hasText: '当前文件没有可用的文档格式化服务。'
      })
    ).toBeVisible()
    await expect(page.locator('.doc-view__dirty')).toHaveCount(0)
    expect(readFileSync(file, 'utf8')).toBe(saved)
  })

  test('关闭文本编辑器后执行命令给出中文提示且不访问已释放实例', async () => {
    await page.getByRole('button', { name: `关闭 ${FILE_NAME}`, exact: true }).click()
    await expect(page.locator('.monaco-editor')).toHaveCount(0)
    await runEditorCommand('find', '查找')
    await expect(
      page.locator('.toast-host__text', {
        hasText: '请先打开并聚焦一个文本文件。'
      })
    ).toBeVisible()
    await expect(page.locator('.monaco-editor')).toHaveCount(0)
    await expect(page.locator('.find-widget')).toHaveCount(0)
  })
})
