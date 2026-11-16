/** Static HTML reference in a real headless browser. No Electron, accounts or engine process. */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(__dirname, '..')
const site = path.join(root, 'docs/plugin-api/dist')
const href = (file = 'index.html') => pathToFileURL(path.join(site, file)).href
let browser: Browser
const channel = process.env.AETHER_DOCS_BROWSER_CHANNEL ?? (process.platform === 'win32' && fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'msedge' : undefined)
test.beforeAll(async () => { browser = await chromium.launch({ channel, headless: true }) })
test.afterAll(async () => { await browser?.close() })

async function open(page: Page, file = 'index.html'): Promise<void> {
  await page.goto(href(file))
  await expect(page.locator('main h1')).toBeVisible()
}

test('全部 HTML 离线可读，导航与页内链接有效，内容无需 JavaScript', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  try {
    for (const file of fs.readdirSync(site).filter(name => name.endsWith('.html'))) {
      await open(page, file)
      await expect(page.locator('main h1')).toHaveCount(1)
      await expect(page.locator('nav[aria-label="文档导航"] [aria-current="page"]')).toHaveCount(1)
      const broken = await page.locator('a[href]').evaluateAll(links => links.flatMap(node => {
        const link = node as HTMLAnchorElement
        if (link.pathname === location.pathname && link.hash && !document.getElementById(decodeURIComponent(link.hash.slice(1)))) return [link.getAttribute('href')]
        return []
      }))
      expect(broken).toEqual([])
    }
    await open(page)
    await page.getByRole('navigation', { name: '文档导航', exact: true }).getByRole('link', { name: '平台 API', exact: true }).click()
    await expect(page).toHaveURL(/platform\.html$/)
    await expect(page.locator('#agents-run')).toBeAttached()
  } finally { await context.close() }
})

test('搜索支持跨页 API、中文需求、键盘选择、空结果与关闭后恢复焦点', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await open(page)
    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: /搜索/ })
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('combobox').or(dialog.getByRole('searchbox'))
    await expect(dialog.locator('a[href]').filter({ hasText: '插件清单' }).first()).toBeVisible()
    await input.fill('agents.run')
    await expect(dialog.locator('a[href]').filter({ hasText: 'agents.run' }).first()).toBeVisible()
    await expect(dialog.locator('a[href]').first()).toHaveAttribute('href', 'platform.html#agents-run')
    await page.keyboard.press('ArrowDown')
    await expect(input).toHaveAttribute('aria-activedescendant', 'search-result-1')
    await page.keyboard.press('ArrowUp')
    await expect(input).toHaveAttribute('aria-activedescendant', 'search-result-0')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/platform\.html#agents-run$/)
    await page.locator('#search-open').click()
    await input.fill('剪贴板')
    await expect(dialog.locator('a[href]').filter({ hasText: /剪贴板|clipboard/ }).first()).toBeVisible()
    await input.fill('zzzz-no-such-reference-598231')
    await expect(dialog).toContainText(/没有|未找到/)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('#search-open')).toBeFocused()
    await expect(page.locator('body')).not.toHaveAttribute('data-search-open', 'true')
    expect(errors).toEqual([])
  } finally { await context.close() }
})

test('复制保留完整代码与特殊字符，只有成功才反馈，站点无外部请求', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const requests: string[] = []
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()) })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as Window & { copiedText?: string }).copiedText = text }
    } })
  })
  try {
    await open(page, 'manifest.html')
    const block = page.locator('.code-block').filter({ has: page.locator('code.language-html') }).first()
    const text = await block.locator('code').textContent()
    const copy = block.getByRole('button', { name: /复制/ })
    await copy.click()
    await expect.poll(() => page.evaluate(() => (window as Window & { copiedText?: string }).copiedText)).toBe(text)
    expect(text).toContain('<script>')
    expect(text).toContain('你好🍎')
    await expect(page.getByRole('status')).toContainText(/已复制|复制成功/)
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied for isolated test') } } })
      document.execCommand = () => false
    })
    await copy.click()
    await expect(page.getByRole('status')).toContainText('请手动')
    await expect(copy).toHaveAttribute('data-state', 'error')
    expect(requests).toEqual([])
  } finally { await context.close() }
})

test('HTML 中完整工程可通过引擎校验并运行真实工具子进程', async ({}, info) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const engine = path.resolve(process.env.AETHER_ENGINE_SOURCE_DIR ?? path.join(root, '../ai-agent-engine'))
  try {
    await open(page, 'manifest.html')
    const manifest = await page.locator('code.language-json').first().textContent()
    const entry = await page.locator('code.language-js').first().textContent()
    const html = await page.locator('code.language-html').first().textContent()
    if (!manifest || !entry || !html) throw new Error('完整工程的三个代码块缺失')
    const project = info.outputPath('text-counter')
    fs.mkdirSync(project, { recursive: true })
    for (const [name, content] of Object.entries({ 'aether-plugin.json': manifest, 'main.mjs': entry, 'ui.html': html })) fs.writeFileSync(path.join(project, name), content)
    const runner = info.outputPath('run-example.mjs')
    fs.writeFileSync(runner, `import assert from 'node:assert/strict';
import { readPluginProject } from ${JSON.stringify(pathToFileURL(path.join(engine, 'src/plugins/project.ts')).href)};
import { runPlugin } from ${JSON.stringify(pathToFileURL(path.join(engine, 'src/plugins/runtime.ts')).href)};
const directory = ${JSON.stringify(project)};
const input = readPluginProject(directory);
const snapshot = {...input, id:input.manifest.id, tenantId:'html-reference', revision:1, hash:'html-reference', directory};
assert.deepEqual((await runPlugin(snapshot, 'count', {text:'你好🍎'})).result, {count:3});
assert.deepEqual((await runPlugin(snapshot, 'count', {text:''})).result, {count:0});
await assert.rejects(()=>runPlugin(snapshot, 'count', {text:123}));
console.log('unicode=3; empty=0; invalid=rejected');
`)
    const engineRequire = createRequire(path.join(engine, 'package.json'))
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(engineRequire.resolve('tsx/esm')).href, runner], {
      cwd: engine, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_PATH: info.outputPath('no-env-file') }
    })
    fs.writeFileSync(info.outputPath('example-result.txt'), result.stdout + result.stderr)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('unicode=3; empty=0; invalid=rejected')
  } finally { await context.close() }
})

test('深浅主题、窄屏导航、键盘焦点与缩放保持可读，生成视觉证据', async ({}, info) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' })
  const page = await context.newPage()
  try {
    await open(page)
    await page.screenshot({ path: info.outputPath('overview-light.png'), fullPage: false })
    const theme = page.getByRole('button', { name: /主题|外观/ })
    await theme.click()
    // A menu or cycling button may expose the modes; use the explicit dark action when present.
    const dark = page.getByRole('menuitemradio', { name: /深色/ })
    if (await dark.count()) await dark.click()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain('dark')
    await page.screenshot({ path: info.outputPath('overview-dark.png'), fullPage: false })
    await open(page, 'platform.html')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain('dark')
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 375, height: 812 })
    const menu = page.getByRole('button', { name: /文档导航|打开导航|展开导航/ })
    await menu.click()
    const navigation = page.locator('#navigation-dialog').getByRole('navigation', { name: '文档导航', exact: true })
    await expect(navigation).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeFocused()
    await page.screenshot({ path: info.outputPath('platform-mobile.png'), fullPage: false })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator('.prose').evaluate(node => { (node as HTMLElement).style.fontSize = '30px' })
    await expect.poll(() => page.locator('.prose p').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(30)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  } finally { await context.close() }
})
