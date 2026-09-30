/** Native editor LSP: TSX/JSX parsing, React types, relative imports, paths and live diagnostics. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

interface ObservedDiagnostic { code?: number | string; message: string }
declare global {
  interface Window {
    aether: AetherIdeApi
    __projectLanguageDiagnostics: Record<string, ObservedDiagnostic[]>
  }
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const tsxSource = [
  "import { useState } from 'react'",
  "import { formatMessage } from './message'",
  "import { label } from '@fixture/model'",
  "const initialCount: number = 'not-a-number'",
  'export function ProjectComponent() {',
  '  const [count] = useState(initialCount)',
  '  return <section>{formatMessage(label)}: {count}</section>',
  '}',
  ''
].join('\n')
const jsxSource = [
  "import { formatMessage } from './message'",
  '/** @type {number} */',
  "const count = 'not-a-number'",
  'export function ProjectView() {',
  "  return <article>{formatMessage('Ready')}: {count}</article>",
  '}',
  ''
].join('\n')

let app: ElectronApplication | undefined
let page: Page
let fixture: string
const pageErrors: string[] = []

async function openFile(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(palette).toBeVisible()
  await palette.locator('.palette__input').fill(name)
  await expect(palette.locator('.palette__item').first()).toContainText(name, { timeout: 30_000 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active')).toContainText(name)
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
}

async function diagnosticCodes(name: string): Promise<Array<number | string | undefined> | null> {
  return page.evaluate((name) => {
    const entry = Object.entries(window.__projectLanguageDiagnostics)
      .find(([uri]) => decodeURIComponent(uri).toLowerCase().endsWith(`/src/${name.toLowerCase()}`))
    return entry ? entry[1].map((diagnostic) => diagnostic.code) : null
  }, name)
}

async function replaceEditorContent(content: string): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(content)
}

test.describe.serial('编辑器项目语言服务', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'editor-project-language-'))
    const workspace = join(fixture, 'workspace')
    const userData = join(fixture, 'profile')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(workspace, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx',
        strict: true, skipLibCheck: true, allowJs: true, checkJs: true, noEmit: true,
        baseUrl: '.', paths: { '@fixture/*': ['src/*'] }
      },
      include: ['src/**/*']
    }, null, 2))
    writeFileSync(join(workspace, 'src/message.ts'), 'export function formatMessage(value: string): string { return value.toUpperCase() }\n')
    writeFileSync(join(workspace, 'src/model.ts'), "export const label = 'Ready'\n")
    writeFileSync(join(workspace, 'src/ProjectComponent.tsx'), tsxSource)
    writeFileSync(join(workspace, 'src/ProjectView.jsx'), jsxSource)
    // Native editor LSP must understand the project independently of the AI engine.
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env: { ...process.env } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.waitForFunction(() => Boolean(window.aether))
    // Observe the real server messages before creating editor models. A known error
    // below proves the service is ready, so an empty panel cannot pass by accident.
    await page.evaluate(() => {
      window.__projectLanguageDiagnostics = {}
      window.aether.lsp.onMessage((message) => {
        if (message.method !== 'textDocument/publishDiagnostics') return
        const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined
        if (typeof params?.uri === 'string' && Array.isArray(params.diagnostics)) {
          window.__projectLanguageDiagnostics[params.uri] = params.diagnostics as ObservedDiagnostic[]
        }
      })
    })
    await expect(page.locator('.workbench')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    if (fixture && resolve(fixture).startsWith(resolve(fixtureRoot) + sep)) {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('TSX uses project JSX, React, relative imports and paths while retaining real type diagnostics', async () => {
    await openFile('ProjectComponent.tsx')
    await expect.poll(() => diagnosticCodes('ProjectComponent.tsx'), { timeout: 60_000 }).toEqual([2322])
    await page.keyboard.press('Control+`')
    await expect(page.locator('.panel')).toBeVisible()
    await page.locator('.panel__tab', { hasText: '问题' }).click()
    await expect(page.locator('.problems-view__item')).toHaveCount(1)
    await expect(page.locator('.problems-view__item')).toContainText('不能将类型“string”分配给类型“number”。')
    await expect(page.locator('.problems-view__item')).toContainText('2322')

    await replaceEditorContent(tsxSource.replace("'not-a-number'", '1'))
    await expect.poll(() => diagnosticCodes('ProjectComponent.tsx')).toEqual([])
    await expect(page.locator('.problems-view__item')).toHaveCount(0)
  })

  test('JSX retains project checking and clears diagnostics after an unsaved correction', async () => {
    await openFile('ProjectView.jsx')
    await expect.poll(() => diagnosticCodes('ProjectView.jsx'), { timeout: 60_000 }).toEqual([2322])
    await expect(page.locator('.problems-view__item')).toHaveCount(1)
    await expect(page.locator('.problems-view__item')).toContainText('2322')

    await replaceEditorContent(jsxSource.replace("'not-a-number'", '1'))
    await expect.poll(() => diagnosticCodes('ProjectView.jsx')).toEqual([])
    await expect(page.locator('.problems-view__item')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })
})
