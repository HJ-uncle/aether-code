/**
 * 浏览器导航生命周期回归：主文档刷新/跳转时，控制台和网络记录必须切换到
 * 新文档；同文档 hash/history 与 iframe 导航不能误清空主文档记录。
 *
 * 这些用例使用真实 Electron WebContentsView 和本地 HTTP 服务，避免把导航
 * 清理逻辑误测成 renderer 的轮询时序问题。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserConsoleEntry, BrowserTabState } from '../src/shared/browser'
import type { BrowserNetworkList, BrowserNetworkQuery } from '../src/shared/browser-network'

const root = resolve(__dirname, '..')
let app: ElectronApplication | undefined
let page: Page
let fixture = ''
let origin = ''
let tabId = ''
let documentLoads = 0
let failedResponse: ServerResponse | undefined
const pageErrors: string[] = []

function documentHtml(id: number, title: string, includeBulk = true): string {
  const bulk = includeBulk
    ? `Promise.all(Array.from({length:55},(_,i)=>fetch('/bulk?load=${id}&i='+i))).then(()=>console.info('BULK_DONE_${id}'));`
    : ''
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title>
    <h1 id="title">${title}</h1><p id="load">文档 ${id}</p>
    <iframe title="测试子帧" src="/frame?load=${id}"></iframe>
    <script>
      console.info('DOCUMENT_${id}');
      fetch('/probe?load=${id}').then(() => console.info('PROBE_DONE_${id}'));
      ${bulk}
    </script></html>`
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    if (url.pathname === '/load') {
      const id = ++documentLoads
      response.writeHead(200, {
        'Content-Type': 'text/html;charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(documentHtml(id, `测试文档 ${id}`))
      return
    }
    if (url.pathname === '/redirect') {
      const id = ++documentLoads
      response
        .writeHead(302, { Location: `/final?document=${id}`, 'Cache-Control': 'no-store' })
        .end()
      return
    }
    if (url.pathname === '/final') {
      const id = Number(url.searchParams.get('document')) || ++documentLoads
      response.writeHead(200, {
        'Content-Type': 'text/html;charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(documentHtml(id, `重定向完成 ${id}`, false))
      return
    }
    if (url.pathname === '/frame') {
      const id = url.searchParams.get('load') ?? 'unknown'
      response.writeHead(200, {
        'Content-Type': 'text/html;charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(
        `<!doctype html><meta charset="utf-8"><script>console.info('IFRAME_${id}')</script><p>子帧 ${id}</p>`
      )
      return
    }
    if (url.pathname === '/bulk') {
      response
        .writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' })
        .end('bulk')
      return
    }
    if (url.pathname === '/probe') {
      response
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end('{"ok":true}')
      return
    }
    if (url.pathname === '/failure') {
      // A reset exercises the did-fail-load path, unlike an ordinary HTTP 404.
      failedResponse = response
      response.destroy()
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
  })().catch((error) => {
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})

async function tabs(): Promise<BrowserTabState[]> {
  return page.evaluate(() => window.aether.browser.list())
}

async function tab(): Promise<BrowserTabState> {
  const item = (await tabs()).find((entry) => entry.tabId === tabId)
  if (!item) throw new Error(`Browser tab ${tabId} not found`)
  return item
}

async function consoleEntries(): Promise<BrowserConsoleEntry[]> {
  const result = await page.evaluate((id) => window.aether.browser.read(id, 'console'), tabId)
  if (!result.success) throw new Error(result.error ?? '读取控制台失败')
  const output = result.output as { entries?: BrowserConsoleEntry[] } | undefined
  return output?.entries ?? []
}

async function networkList(query: BrowserNetworkQuery = {}): Promise<BrowserNetworkList> {
  const result = await page.evaluate(({ id, query }) => window.aether.browser.network(id, query), {
    id: tabId,
    query
  })
  return result
}

async function waitForDocument(id: number): Promise<void> {
  await expect
    .poll(async () => (await tabs()).find((entry) => entry.tabId === tabId)?.title)
    .toBe(`测试文档 ${id}`)
  await expect
    .poll(async () => (await consoleEntries()).some((entry) => entry.message === `DOCUMENT_${id}`))
    .toBe(true)
  await expect
    .poll(async () =>
      (await networkList({ url: `/probe?load=${id}` })).entries.length > 0
    )
    .toBe(true)
  await expect
    .poll(async () => (await networkList({ url: `/bulk?load=${id}`, limit: 100 })).total)
    .toBe(55)
}

async function navigate(url: string): Promise<void> {
  await page.evaluate(
    async ({ id, url }) => {
      try {
        await window.aether.browser.action({ tabId: id, action: 'navigate', url })
      } catch {
        /* failure is asserted through tab.error */
      }
    },
    { id: tabId, url }
  )
}

test.describe.serial('浏览器主文档刷新与调试记录生命周期', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-navigation-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({ engineMode: 'embedded', autoStartEngine: false })
    )
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`],
      cwd: root,
      env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await expect(page.locator('.status-bar')).toBeVisible()
    await page.keyboard.press('Control+Alt+b')
    await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    await page.locator('.browser-address').fill(`${origin}/load`)
    await page.locator('.browser-address').press('Enter')
    await expect
      .poll(async () => (await tabs()).some((entry) => entry.url.includes('/load')))
      .toBe(true)
    tabId = (await tabs()).find((entry) => entry.url.includes('/load'))!.tabId
    await waitForDocument(1)
  })

  test.afterEach(() => expect(pageErrors).toEqual([]))

  test.afterAll(async () => {
    failedResponse?.destroy()
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const absolute = resolve(fixture)
    if (
      dirname(absolute) !== join(root, '.e2e-tmp') ||
      !basename(absolute).startsWith('browser-navigation-')
    )
      throw new Error('Unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('刷新按钮重新加载主文档，控制台与网络记录只保留新加载', async () => {
    const oldRequest = '/probe?load=1'
    const oldLogs = await consoleEntries()
    const oldLogIds = new Set(oldLogs.map((entry) => entry.id))
    const oldNetwork = await networkList({ limit: 100 })
    const oldNetworkIds = new Set(oldNetwork.entries.map((entry) => entry.id))
    expect(oldLogs.some((entry) => entry.message === 'DOCUMENT_1')).toBe(true)
    expect(oldNetwork.entries.some((entry) => entry.url.includes(oldRequest))).toBe(true)
    const beforeNavigation = (await tab()).navigationId

    await page.getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect.poll(async () => (await tab()).navigationId).toBeGreaterThan(beforeNavigation)
    // Chromium may reuse the same cached document bytes during a reload. The
    // navigation is still a new capture epoch, so the previous request IDs and
    // console log IDs must disappear even when no new subresource is emitted.
    await expect
      .poll(async () => (await networkList({ limit: 100 })).entries.every((entry) => !oldNetworkIds.has(entry.id)))
      .toBe(true)
    const logs = await consoleEntries()
    const network = await networkList()
    expect(logs.some((entry) => oldLogIds.has(entry.id))).toBe(false)
    expect(network.entries.some((entry) => oldNetworkIds.has(entry.id))).toBe(false)
  })

  test('同文档 hash/history 与 iframe 导航不清空主文档记录，跨文档重定向会清理', async () => {
    const before = await tab()
    await page.evaluate(
      ({ id, url }) => window.aether.browser.action({ tabId: id, action: 'navigate', url }),
      { id: tabId, url: `${origin}/load` }
    )
    const currentDocument = documentLoads
    await waitForDocument(currentDocument)
    const oldMessage = `DOCUMENT_${currentDocument}`
    const stable = await tab()
    const stableNavigation = stable.navigationId
    await app!.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))
      if (!wc) throw new Error('Browser guest not found')
      return wc.executeJavaScript(
        "console.info('SAME_DOCUMENT_BEFORE'); history.pushState({}, '', location.pathname + '#hash-test'); location.hash = 'second'; console.info('SAME_DOCUMENT_AFTER')"
      )
    }, origin)
    await expect
      .poll(async () =>
        (await consoleEntries()).some((entry) => entry.message === 'SAME_DOCUMENT_AFTER')
      )
      .toBe(true)
    expect((await tab()).navigationId).toBe(stableNavigation)
    expect((await consoleEntries()).some((entry) => entry.message === 'SAME_DOCUMENT_BEFORE')).toBe(
      true
    )
    await app!.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))
      if (!wc) throw new Error('Browser guest not found')
      return wc.executeJavaScript(
        "const frame = document.querySelector('iframe'); if (!frame) throw new Error('fixture iframe missing'); frame.src = '/frame?load=iframe-next';"
      )
    }, origin)
    await expect
      .poll(async () =>
        app!.evaluate(({ webContents }, url) => {
          const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))
          if (!wc) throw new Error('Browser guest not found')
          return wc.executeJavaScript(
            "document.querySelector('iframe')?.contentWindow?.location.href || ''"
          )
        }, origin)
      )
      .toContain('/frame?load=iframe-next')
    expect((await consoleEntries()).some((entry) => entry.message === oldMessage)).toBe(true)

    await navigate(`${origin}/redirect`)
    await expect.poll(async () => (await tab()).url).toContain('/final')
    await expect
      .poll(async () =>
        (await consoleEntries()).some((entry) => entry.message.startsWith('DOCUMENT_'))
      )
      .toBe(true)
    const redirectedLogs = await consoleEntries()
    expect(redirectedLogs.some((entry) => entry.message === 'SAME_DOCUMENT_AFTER')).toBe(false)
    expect((await networkList()).entries.some((entry) => entry.url.includes('/redirect'))).toBe(
      true
    )
    expect(
      (await networkList()).entries.some((entry) =>
        entry.url.includes(`/final?document=${documentLoads}`)
      )
    ).toBe(true)
    expect(
      (await networkList()).entries.some((entry) =>
        entry.url.includes(`/probe?load=${currentDocument}`)
      )
    ).toBe(false)
    expect((await tab()).navigationId).toBeGreaterThan(before.navigationId)
  })

  test('跨文档失败连接不会残留旧日志，恢复成功后网络面板保留筛选但回到第一页并取消详情', async () => {
    await navigate(`${origin}/load`)
    await waitForDocument(documentLoads)
    const panel = page.getByRole('region', { name: '浏览器网络请求', exact: true })
    await page.getByRole('button', { name: '网络', exact: true }).click()
    await expect(panel).toBeVisible()
    await panel.getByRole('textbox', { name: '过滤网络请求', exact: true }).fill('/bulk')
    const rows = panel.getByRole('button', { name: /^查看请求 / })
    await expect(rows).toHaveCount(50)
    await panel.getByRole('button', { name: '下一页请求', exact: true }).click()
    await expect(rows).toHaveCount(5)
    await rows.first().click()
    await expect(panel.getByRole('region', { name: '网络请求详情', exact: true })).toBeVisible()
    const oldMessage = `DOCUMENT_${documentLoads}`

    await navigate(`${origin}/failure`)
    await expect
      .poll(async () => (await tab()).error ?? '')
      .toMatch(/网页加载失败|ERR_EMPTY_RESPONSE/)
    expect((await consoleEntries()).some((entry) => entry.message === oldMessage)).toBe(false)
    expect(
      (await networkList()).entries.some((entry) =>
        entry.url.includes(`/bulk?load=${documentLoads}`)
      )
    ).toBe(false)

    await navigate(`${origin}/load`)
    await waitForDocument(documentLoads)
    await expect(panel.getByRole('textbox', { name: '过滤网络请求', exact: true })).toHaveValue(
      '/bulk'
    )
    await expect(rows).toHaveCount(50)
    await expect(panel.getByRole('button', { name: '上一页请求', exact: true })).toBeDisabled()
    await expect(panel.getByRole('region', { name: '网络请求详情', exact: true })).toHaveCount(0)
  })
})
