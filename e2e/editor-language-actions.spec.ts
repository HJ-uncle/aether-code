/** Native TS LSP: cross-file definition, rename with dirty/unopened files, and formatting before explicit save. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

interface DiagnosticSnapshot { codes: Array<number | string | undefined>; revision: number }
declare global {
  interface Window {
    aether: AetherIdeApi
    __languageActionDiagnostics: Record<string, DiagnosticSnapshot>
  }
}

const APP_ROOT = resolve(__dirname, '..')
const FIXTURE_ROOT = join(APP_ROOT, '.e2e-tmp')
const ORIGINAL_NAME = 'calculateTotal'
const RENAMED_NAME = 'sumProjectValues'
const DIRTY_NOTE = '// Keep this unsaved consumer note.\n'
const LIBRARY_DIRTY_NOTE = '// Keep this unsaved library note.\n'
const LIBRARY_SOURCE = [
  '// The definition starts in an unopened file.',
  `export function ${ORIGINAL_NAME}(left: number, right: number): number {`,
  '  return left + right',
  '}',
  ''
].join('\n')
const CONSUMER_SOURCE = [
  `import { ${ORIGINAL_NAME} } from './library'`,
  `export const amount = ${ORIGINAL_NAME}(2, 3)`,
  "export const readinessProbe: number = 'not-a-number'",
  ''
].join('\n')
const UNOPENED_SOURCE = [
  `import { ${ORIGINAL_NAME} } from './library'`,
  `export const otherAmount = ${ORIGINAL_NAME}(5, 7)`,
  ''
].join('\n')
const UNFORMATTED_SOURCE = 'export function formatProbe(value:number){\nreturn{value:value*2}\n}\n'
const FORMATTED_SOURCE = 'export function formatProbe(value: number) {\n  return { value: value * 2 }\n}\n'

let fixture = ''
let workspace = ''
let app: ElectronApplication | undefined
let page: Page
const pageErrors: string[] = []

function tab(name: string) {
  return page.locator('.editor-tab', { hasText: name })
}

function diskSource(name: string): string {
  return readFileSync(join(workspace, 'src', name), 'utf8')
}

async function openFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(palette).toBeVisible()
  await palette.locator('.palette__input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name, { timeout: 30_000 })
  await page.keyboard.press('Enter')
  await expect(tab(name)).toHaveClass(/is-active/)
  await expect(page.locator('.monaco-editor .view-lines').first()).toBeVisible()
}

async function moveCursor(line: number, column: number): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+Home')
  for (let row = 1; row < line; row += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  for (let col = 1; col < column; col += 1) await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('doc-cursor')).toHaveText(`行 ${line}，列 ${column}`)
}

async function diagnostics(name: string): Promise<DiagnosticSnapshot | null> {
  return page.evaluate((name) => {
    const entry = Object.entries(window.__languageActionDiagnostics)
      .find(([uri]) => decodeURIComponent(uri).toLowerCase().endsWith(`/src/${name.toLowerCase()}`))
    return entry?.[1] ?? null
  }, name)
}

test.describe.serial('原生编辑器跨文件语言操作', () => {
  test.beforeAll(async () => {
    mkdirSync(FIXTURE_ROOT, { recursive: true })
    fixture = mkdtempSync(join(FIXTURE_ROOT, 'editor-language-actions-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(workspace, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, skipLibCheck: true, noEmit: true
      },
      include: ['src/**/*.ts']
    }, null, 2), 'utf8')
    for (const [name, source] of Object.entries({
      'library.ts': LIBRARY_SOURCE,
      'consumer.ts': CONSUMER_SOURCE,
      'unopened.ts': UNOPENED_SOURCE,
      'formatting.ts': UNFORMATTED_SOURCE
    })) writeFileSync(join(workspace, 'src', name), source, 'utf8')
    // These actions use the project's real TS server independently of an AI engine.
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      autoStartEngine: false, lastFolder: workspace
    }), 'utf8')
    app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: { ...process.env }
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.waitForFunction(() => Boolean(window.aether))
    await page.evaluate(() => {
      window.__languageActionDiagnostics = {}
      window.aether.lsp.onMessage((message) => {
        if (message.method !== 'textDocument/publishDiagnostics') return
        const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined
        if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return
        const previous = window.__languageActionDiagnostics[params.uri]
        window.__languageActionDiagnostics[params.uri] = {
          codes: (params.diagnostics as Array<{ code?: number | string }>).map((item) => item.code),
          revision: (previous?.revision ?? 0) + 1
        }
      })
    })
    await expect(page.locator('.workbench')).toBeVisible()
    await openFile('consumer.ts')
    // A positive diagnostic proves that the project LSP is ready; no English text dependency.
    await expect.poll(async () => (await diagnostics('consumer.ts'))?.codes, {
      timeout: 60_000
    }).toEqual([2322])
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  test.afterAll(async () => {
    await app?.close()
    const child = relative(FIXTURE_ROOT, fixture)
    if (fixture && child.startsWith('editor-language-actions-') && !child.includes(sep)) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('F12 打开未打开的定义文件并定位到定义符号', async () => {
    await expect(tab('library.ts')).toHaveCount(0)
    const usageColumn = CONSUMER_SOURCE.split('\n')[1].indexOf(ORIGINAL_NAME) + 2
    await moveCursor(2, usageColumn)
    await page.keyboard.press('F12')
    await expect(tab('library.ts')).toHaveClass(/is-active/)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(`function ${ORIGINAL_NAME}`)
    await expect(page.locator('.aether-reveal-match').first()).toBeVisible()

    const startColumn = LIBRARY_SOURCE.split('\n')[1].indexOf(ORIGINAL_NAME) + 1
    // Monaco navigation collapses the target range to its start; Aether highlights
    // that character. Collapse this highlight to verify the exact symbol location.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('doc-cursor')).toHaveText(`行 2，列 ${startColumn}`)
    expect(diskSource('library.ts')).toBe(LIBRARY_SOURCE)
    // LSP opens a lowercase drive URI; Quick Open later returns the explorer's
    // original casing. Both routes must preserve this same unsaved document.
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(LIBRARY_DIRTY_NOTE)
    await expect(tab('library.ts').locator('.editor-tab__dirty')).toBeVisible()
  })

  test('F2 同时重命名当前文件、后台脏文件和未打开文件，全部保存后才写盘', async () => {
    await openFile('consumer.ts')
    const previousRevision = (await diagnostics('consumer.ts'))?.revision ?? 0
    await page.locator('.monaco-editor .view-lines').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(DIRTY_NOTE)
    await expect(tab('consumer.ts').locator('.editor-tab__dirty')).toBeVisible()
    // Wait for didChange to reach the server before switching away from the dirty buffer.
    await expect.poll(async () => (await diagnostics('consumer.ts'))?.revision ?? 0)
      .toBeGreaterThan(previousRevision)
    await openFile('library.ts')
    await expect(tab('library.ts')).toHaveCount(1)
    await expect(tab('library.ts').locator('.editor-tab__dirty')).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(LIBRARY_DIRTY_NOTE.trim())
    await expect(tab('unopened.ts')).toHaveCount(0)
    const declarationColumn = LIBRARY_SOURCE.split('\n')[1].indexOf(ORIGINAL_NAME) + 2
    await moveCursor(2, declarationColumn)
    await page.keyboard.press('F2')
    const rename = page.locator('.rename-box .rename-input')
    await expect(rename).toBeVisible()
    await expect(rename).toHaveValue(ORIGINAL_NAME)
    await rename.fill(RENAMED_NAME)
    await page.keyboard.press('Enter')
    await expect(rename).toBeHidden()

    for (const name of ['library.ts', 'consumer.ts', 'unopened.ts']) {
      await expect(tab(name).locator('.editor-tab__dirty')).toBeVisible()
    }
    expect(diskSource('library.ts')).toBe(LIBRARY_SOURCE)
    expect(diskSource('consumer.ts')).toBe(CONSUMER_SOURCE)
    expect(diskSource('unopened.ts')).toBe(UNOPENED_SOURCE)

    // Reactivating the background model must not reset it from stale document state.
    await tab('consumer.ts').click()
    await expect(tab('consumer.ts')).toHaveClass(/is-active/)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(RENAMED_NAME)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(DIRTY_NOTE.trim())
    await page.keyboard.press('Control+Shift+s')
    const expectedFiles = {
      'library.ts': LIBRARY_SOURCE.replaceAll(ORIGINAL_NAME, RENAMED_NAME) + LIBRARY_DIRTY_NOTE,
      'consumer.ts': CONSUMER_SOURCE.replaceAll(ORIGINAL_NAME, RENAMED_NAME) + DIRTY_NOTE,
      'unopened.ts': UNOPENED_SOURCE.replaceAll(ORIGINAL_NAME, RENAMED_NAME)
    }
    for (const [name, source] of Object.entries(expectedFiles)) {
      await expect.poll(() => diskSource(name)).toBe(source)
      await expect(tab(name).locator('.editor-tab__dirty')).toHaveCount(0)
    }
  })

  test('Shift+Alt+F 格式化 TypeScript 内容并在显式保存后写盘', async () => {
    await openFile('formatting.ts')
    await expect.poll(async () => (await diagnostics('formatting.ts'))?.codes).toEqual([])
    await moveCursor(1, 1)
    await page.keyboard.press('Shift+Alt+f')
    await expect(tab('formatting.ts').locator('.editor-tab__dirty')).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('formatProbe(value: number) {')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('return { value: value * 2 }')
    expect(diskSource('formatting.ts')).toBe(UNFORMATTED_SOURCE)
    await page.keyboard.press('Control+s')
    await expect.poll(() => diskSource('formatting.ts')).toBe(FORMATTED_SOURCE)
    await expect(tab('formatting.ts').locator('.editor-tab__dirty')).toHaveCount(0)
  })
})
