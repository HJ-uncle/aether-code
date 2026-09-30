/** Real TS language actions: automatic imports, quickfix, standard WorkspaceEdit, command/applyEdit and unopened reference preview. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type Locator
} from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

declare global {
  interface Window {
    aether: AetherIdeApi
    __codeActionDiagnostics: Record<string, Array<number | string | undefined>>
    __codeActionApplyRequests: number
  }
}
const ROOT = resolve(__dirname, '..')
const TEMP = join(ROOT, '.e2e-tmp')
const SOURCES = {
  'helpers.ts':
    'export function friendlyAutoImport(value: number): number { return value * 2 }\nexport function missingFixtureHelper(value: number): number { return value + 3 }\nexport const unusedFixture = 1\n',
  'automatic.ts': 'export const importedValue = \n',
  'quickfix.ts': 'export const fixedValue = missingFixtureHelper(2)\n',
  'organize.ts':
    "import { unusedFixture, friendlyAutoImport } from './helpers'\nexport const organizedValue = friendlyAutoImport(1)\n",
  'refactor.ts': 'export function refactorProbe(value: number): number {\n  return value + 1\n}\n',
  'references.ts':
    "import { friendlyAutoImport } from './helpers'\nexport const referenceValue = friendlyAutoImport(5)\n"
}
let fixture = ''
let workspace = ''
let app: ElectronApplication | undefined
let page: Page
const errors: string[] = []
const disk = (name: string): string => readFileSync(join(workspace, name), 'utf8')
const tab = (name: string) => page.locator('.editor-tab', { hasText: name })

async function openFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(palette).toBeVisible()
  await palette.locator('.palette__input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name)
  await page.keyboard.press('Enter')
  await expect(tab(name)).toHaveClass(/is-active/)
}
async function moveCursor(line: number, column: number): Promise<void> {
  await page.locator('.doc-view__source .monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+Home')
  for (let index = 1; index < line; index++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  // Monaco's smart Home first visits indentation, then column 1.
  if (line > 1) await page.keyboard.press('Home')
  for (let index = 1; index < column; index++) await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('doc-cursor')).toHaveText(`行 ${line}，列 ${column}`)
}
async function runCommand(id: string, label: string): Promise<void> {
  await page.keyboard.press('Control+Shift+p')
  const palette = page.locator('.palette[aria-label="命令面板"]')
  await palette.locator('.palette__input').fill(label)
  const command = palette.locator(`.palette__item[title="aether.editor.${id}"]`)
  await expect(command).toBeEnabled()
  await command.click()
  await expect(palette).toBeHidden()
}
async function clickCodeAction(action: Locator): Promise<void> {
  await expect(action).toBeVisible()
  const box = await action.boundingBox()
  if (!box) throw new Error('代码操作没有可点击区域')
  // Monaco deliberately blocks the opening pointer until the user moves it.
  // Locator.click's actionability check runs before movement and otherwise waits forever.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await action.click()
}
async function codes(name: string): Promise<Array<string | number | undefined> | undefined> {
  return page.evaluate(
    (name) =>
      Object.entries(window.__codeActionDiagnostics).find(([uri]) =>
        decodeURIComponent(uri)
          .toLowerCase()
          .endsWith('/' + name.toLowerCase())
      )?.[1],
    name
  )
}

test.describe.serial('项目语言代码操作', () => {
  test.beforeAll(async () => {
    mkdirSync(TEMP, { recursive: true })
    fixture = mkdtempSync(join(TEMP, 'editor-code-actions-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(workspace, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true
        },
        include: ['*.ts']
      })
    )
    for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(workspace, name), text)
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({ autoStartEngine: false, lastFolder: workspace })
    )
    app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      cwd: ROOT,
      env: { ...process.env }
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.waitForFunction(() => Boolean(window.aether))
    await page.evaluate(() => {
      window.__codeActionDiagnostics = {}
      window.__codeActionApplyRequests = 0
      window.aether.lsp.onMessage((message) => {
        if (message.method === 'workspace/applyEdit') window.__codeActionApplyRequests++
        if (message.method !== 'textDocument/publishDiagnostics') return
        const params = message.params as {
          uri: string
          diagnostics: Array<{ code?: number | string }>
        }
        window.__codeActionDiagnostics[params.uri] = params.diagnostics.map((item) => item.code)
      })
    })
    await expect(page.locator('.workbench')).toBeVisible()
    await openFile('quickfix.ts')
    await expect.poll(() => codes('quickfix.ts'), { timeout: 60_000 }).toContain(2304)
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    const child = relative(TEMP, fixture)
    if (fixture && child.startsWith('editor-code-actions-') && !child.includes(sep))
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('自动导入补全将 resolve 的 import 编辑保留到显式保存', async () => {
    await openFile('automatic.ts')
    await moveCursor(1, SOURCES['automatic.ts'].trimEnd().length + 2)
    await page.keyboard.insertText('friendlyAuto')
    await page.keyboard.press('Control+Space')
    const suggestion = page
      .locator('.suggest-widget .monaco-list-row')
      .filter({ hasText: 'friendlyAutoImport' })
      .first()
    await expect(suggestion).toBeVisible({ timeout: 30_000 })
    await suggestion.click()
    await page.keyboard.press('Enter')
    await expect(page.locator('.doc-view__source .monaco-editor .view-lines')).toContainText(
      'import { friendlyAutoImport }'
    )
    await expect(tab('automatic.ts').locator('.editor-tab__dirty')).toBeVisible()
    expect(disk('automatic.ts')).toBe(SOURCES['automatic.ts'])
    await page.keyboard.press('Control+s')
    await expect
      .poll(() => disk('automatic.ts'))
      .toMatch(/import\s*\{\s*friendlyAutoImport\s*\}\s*from\s*["']\.\/helpers["']/)
    await expect
      .poll(() => disk('automatic.ts'))
      .toMatch(/export const importedValue = friendlyAutoImport/)
  })

  test('快速修复通过真实 TS codeAction 添加缺失导入', async () => {
    await openFile('quickfix.ts')
    await moveCursor(1, SOURCES['quickfix.ts'].indexOf('missingFixtureHelper') + 2)
    await runCommand('quickFix', '快速修复')
    const fix = page
      .locator('.action-widget .monaco-list-row')
      .filter({ hasText: /helpers/ })
      .first()
    await expect(fix).toBeVisible()
    await clickCodeAction(fix)
    await expect(tab('quickfix.ts').locator('.editor-tab__dirty')).toBeVisible()
    expect(disk('quickfix.ts')).toBe(SOURCES['quickfix.ts'])
    await page.keyboard.press('Control+s')
    await expect
      .poll(() => disk('quickfix.ts'))
      .toMatch(/import\s*\{\s*missingFixtureHelper\s*\}\s*from\s*["']\.\/helpers["']/)
    await expect.poll(() => codes('quickfix.ts')).not.toContain(2304)
  })

  test('整理导入接受标准 documentChanges 并可撤销', async () => {
    await openFile('organize.ts')
    await moveCursor(1, 1)
    await runCommand('organizeImports', '整理导入')
    await expect(tab('organize.ts').locator('.editor-tab__dirty')).toBeVisible()
    // TLS 6 implements organizeImports as SortAndCombine; removing unused imports
    // is a separate source action. Verify the actual sorted edit and its undo.
    await expect(page.locator('.doc-view__source .monaco-editor .view-lines')).toContainText('friendlyAutoImport, unusedFixture')
    expect(disk('organize.ts')).toBe(SOURCES['organize.ts'])
    await page.keyboard.press('Control+z')
    await expect(page.locator('.doc-view__source .monaco-editor .view-lines')).toContainText('unusedFixture, friendlyAutoImport')
    await expect(tab('organize.ts').locator('.editor-tab__dirty')).toHaveCount(0)
  })

  test('提取常量走 executeCommand 和反向 applyEdit，保存前磁盘不变', async () => {
    await openFile('refactor.ts')
    await moveCursor(2, 10)
    for (let index = 0; index < 'value + 1'.length; index++)
      await page.keyboard.press('Shift+ArrowRight')
    const before = await page.evaluate(() => window.__codeActionApplyRequests)
    await runCommand('refactor', '重构代码')
    const action = page
      .locator('.action-widget .monaco-list-row')
      .filter({ hasText: /常量|constant/i })
      .first()
    await expect(action).toBeVisible()
    await clickCodeAction(action)
    await expect
      .poll(() => page.evaluate(() => window.__codeActionApplyRequests))
      .toBeGreaterThan(before)
    await expect(tab('refactor.ts').locator('.editor-tab__dirty')).toBeVisible()
    expect(disk('refactor.ts')).toBe(SOURCES['refactor.ts'])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+s')
    await expect.poll(() => disk('refactor.ts')).toMatch(/const\s+\w+\s*=\s*value\s*\+\s*1/)
  })

  test('引用预览读取未打开的定义文件且不为每个结果创建标签', async () => {
    await openFile('references.ts')
    await expect(tab('helpers.ts')).toHaveCount(0)
    await moveCursor(2, SOURCES['references.ts'].split('\n')[1].indexOf('friendlyAutoImport') + 2)
    await page.keyboard.press('Shift+F12')
    const peek = page.locator('.peekview-widget')
    await expect(peek).toBeVisible()
    const file = peek.locator('.monaco-list-row').filter({ hasText: 'helpers.ts' }).first()
    await expect(file).toBeVisible()
    if (await file.getAttribute('aria-expanded') !== 'true') await file.click()
    // Selecting a file group only expands it; only the concrete reference opens
    // its source in the preview. Wait for that asynchronous child, then select it.
    const definition = peek.getByRole('treeitem', { name: /helpers\.ts.*function friendlyAutoImport/ })
    await expect(definition).toBeVisible()
    await definition.click()
    await expect(peek.locator('.monaco-editor .view-lines')).toContainText(
      'function friendlyAutoImport'
    )
    await expect(tab('helpers.ts')).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect(disk('helpers.ts')).toBe(SOURCES['helpers.ts'])
  })
})
