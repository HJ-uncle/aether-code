/** Wait target projection and actual React headers in an isolated headless page.
 * No Electron, engine, model requests or user profile is started. */
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { subagentWaitSummary } from '../src/renderer/src/features/conversation/shared/subagent-wait-summary'

test('single and batch waits count only complete, distinct targets', () => {
  expect(subagentWaitSummary('{"runId":"legacy-run","timeoutMs":0}')).toBe('1 个任务')
  for (let count = 1; count <= 8; count++) {
    expect(subagentWaitSummary(JSON.stringify({ runIds: Array.from({ length: count }, (_, index) => `run-${index}`) }))).toBe(`${count} 个任务`)
  }
  for (const args of [{}, { runIds: [] }, { runIds: ['one', 'one'] }, { runIds: ['one', ' one '] }, { runIds: ['one', 2] },
    { runIds: ['', 'two'] }, { runIds: ['one'], runId: 'two' }, { runIds: 'one' }, { runId: null }, { runId: '  ' },
    { runIds: Array.from({ length: 9 }, (_, index) => `run-${index}`) }, null, []]) {
    expect(subagentWaitSummary(JSON.stringify(args)), JSON.stringify(args)).toBe('')
  }
  for (const args of ['', '{', '{"runIds":["opaque-id",']) expect(subagentWaitSummary(args)).toBe('')
})

test.describe('wait header DOM', () => {
  const root = resolve(__dirname, '..')
  let browser: Browser, context: BrowserContext, page: Page, bundle: string
  let errors: string[]
  const css = ['assets/tokens.css', 'assets/base.css', 'assets/components.css', 'assets/motion.css',
    'features/conversation/inline-activity.css', 'ui/hover-detail.css']
    .map(file => readFileSync(resolve(root, 'src/renderer/src', file), 'utf8')).join('\n')

  test.beforeAll(async () => {
    const result = await build({ stdin: { loader: 'tsx', resolveDir: root, contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { AppContext } from './src/renderer/src/core/app-context'
      import { DEFAULT_SETTINGS } from './src/shared/ipc'
      import { CompactToolRow } from './src/renderer/src/features/conversation/shared/CompactToolRow'
      import { ToolActivity } from './src/renderer/src/features/conversation/ToolActivity'
      import { serializeMessages } from './src/renderer/src/features/conversation/shared/message-export'
      const root = createRoot(document.getElementById('fixture'))
      const context = { engine: { snapshot: { mode: 'local' } }, settings: DEFAULT_SETTINGS, userSettings: DEFAULT_SETTINGS,
        ready: false, settingsLoaded: true, updateSettings: async () => { throw Error('No settings writes') } }
      window.renderWait = ({ mode = 'work', ...tool }) => root.render(<AppContext.Provider value={context}>
        {mode === 'work' ? <ToolActivity tool={tool} fileContext={{sessionId:'wait-fixture',workspaceRoot:'D:/fixture'}} defaultOpen={false} />
          : <CompactToolRow tool={tool} defaultOpen={false} />}
      </AppContext.Provider>)
      window.exportWait = tool => serializeMessages([{ id:'message',role:'assistant',content:'',thinking:'',tools:[tool],items:[],status:'done',createdAt:0 }])
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      tsconfig: resolve(root, 'tsconfig.web.json'), loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'fixture-vite-imports', setup(build) {
        build.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path, namespace: 'blocked-worker' }))
        build.onLoad({ filter: /.*/, namespace: 'blocked-worker' }, () => ({ contents: 'export default class { constructor() { throw Error("Editor launch forbidden") } }' }))
        build.onResolve({ filter: /\?(?:inline|raw)$/ }, async args => ({ path: (await build.resolve(args.path.replace(/\?[^?]+$/, ''), { resolveDir: args.resolveDir, kind: args.kind })).path, namespace: 'raw-resource' }))
        build.onLoad({ filter: /.*/, namespace: 'raw-resource' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
      } }] })
    bundle = result.outputFiles[0].text
    const executablePath = [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  })
  test.afterAll(async () => { await browser?.close() })
  test.beforeEach(async () => {
    errors = []
    context = await browser.newContext({ viewport: { width: 380, height: 300 }, reducedMotion: 'reduce' })
    await context.route('**/*', route => route.abort())
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<html data-appearance="dark"><body><main id="fixture"></main></body></html>')
    await page.addStyleTag({ content: css + '\nbody{padding:16px}#fixture{width:320px;max-width:100%}' })
    await page.addScriptTag({ content: bundle })
  })
  test.afterEach(async () => { try { expect(errors).toEqual([]) } finally { await context?.close() } })
  const base = { id: 'wait-one', name: 'subagent_wait', state: 'running', args: '{"runIds":["child-a","child-b","child-c","child-d"]}', result: '' }
  const render = async (overrides: Record<string, unknown> = {}) => {
    await page.evaluate(value => (window as unknown as { renderWait: (tool: unknown) => void }).renderWait(value), { ...base, ...overrides })
    await expect(page.locator('.compact-tool-row')).toBeVisible()
  }

  test('one Work row identifies all targets before results arrive, retaining the count through settlement', async () => {
    await render()
    const header = page.locator('.compact-tool-row > button')
    await expect(page.locator('.compact-tool-row')).toHaveCount(1)
    await expect(header.locator('.logline__name')).toHaveText('等待子代理')
    await expect(header.locator('.logline__summary')).toHaveText('4 个任务')
    await expect(header).not.toContainText('child-')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(header).toHaveAccessibleName(/等待子代理.*4 个任务/)
    await expect(header).toBeDisabled()
    const geometry = await header.evaluate(element => ({ height: element.getBoundingClientRect().height, overflow: element.scrollWidth - element.clientWidth }))
    expect(geometry.height).toBeLessThanOrEqual(29)
    expect(geometry.overflow).toBeLessThanOrEqual(1)
    for (const state of ['pending', 'completed']) {
      await render({ state: 'done', result: JSON.stringify({ state, runs: [{ runId: 'child-a', state }], note: 'batch wait receipt' }) })
      await expect(header.locator('.logline__summary')).toHaveText('4 个任务')
      await expect(header).toBeEnabled()
    }
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  test('legacy single waits remain readable in Work and exported transcript', async () => {
    for (const mode of ['work']) {
      await render({ mode, args: '{"runId":"legacy-child","timeoutMs":1000}', state: 'done', result: 'completed' })
      await expect(page.locator('.logline__summary')).toHaveText('1 个任务')
      await expect(page.locator('.logline__name')).toHaveText('等待子代理')
    }
    const exported = await page.evaluate(value => (window as unknown as { exportWait: (tool: unknown) => string }).exportWait(value), base)
    expect(exported).toContain('等待子代理：4 个任务')
  })

  test('partial arguments show neither a fabricated count nor opaque JSON identifiers', async () => {
    for (const mode of ['work']) {
      await render({ mode, args: '{"runIds":["private-child-id",' })
      await expect(page.locator('.logline__summary')).toHaveCount(0)
      await expect(page.locator('.compact-tool-row > button')).not.toContainText('private-child-id')
    }
  })
})
