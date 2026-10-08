/** Real CDP traffic and Electron UI: filter/paginate, request details, redaction, body continuation, redirects and explicit unavailable states. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserNetworkDetail, BrowserNetworkQuery } from '../src/shared/browser-network'

const root = resolve(__dirname, '..')
const longText = '分段读取中文响应。'.repeat(3500)
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', tabId = '', echoId = ''
let pendingResponse: ServerResponse | undefined
const errors: string[] = []
const received: Array<{ url: string; method: string; body: string }> = []
const html = `<!doctype html><meta charset="utf-8"><title>网络详情验收</title><style>body{font:18px sans-serif;padding:20px}</style><h1>网络详情测试</h1><p id="status">正在请求</p><script>
async function run(){
 await fetch('/echo?q='+encodeURIComponent('中文查询')+'&token=query-private-value',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-private-auth','X-Debug-Trace':'trace-中文'.replace('中文','network')},body:JSON.stringify({title:'提交的中文',password:'payload-private-value',count:2})});
 await Promise.all(Array.from({length:65},(_,i)=>fetch('/batch?i='+i)));
 await Promise.all([fetch('/failed'),fetch('/redirect'),fetch('/long'),fetch('/binary'),fetch('/empty'),fetch('/dropped').catch(()=>{})]);
 document.querySelector('#status').textContent='全部请求已完成';
} run();</script>`
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    if (url.pathname === '/page') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Set-Cookie': 'fixture_session=cookie-private-value; HttpOnly; Path=/' }).end(html); return }
    let body = ''; for await (const chunk of request) body += String(chunk)
    received.push({ url: url.pathname, method: request.method ?? '', body })
    if (url.pathname === '/echo') { response.writeHead(201, { 'Content-Type': 'application/json;charset=utf-8', 'X-Trace-Id': 'fixture-echo-trace', 'Set-Cookie': 'fixture_response=another-private-cookie; HttpOnly; Path=/' }).end(JSON.stringify({ ok: true, message: '服务端返回中文', access_token: 'response-private-token', payload: JSON.parse(body) })); return }
    if (url.pathname === '/failed') { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '可定位的接口故障' })); return }
    if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/final', 'X-Redirect-Hop': 'first' }).end(); return }
    if (url.pathname === '/final') { response.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'X-Redirect-Hop': 'last' }).end('重定向完成'); return }
    if (url.pathname === '/long') { response.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Encoding': 'gzip' }).end(gzipSync(longText)); return }
    if (url.pathname === '/binary') { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from([0, 255, 2, 17, 0, 250])); return }
    if (url.pathname === '/empty') { response.writeHead(204).end(); return }
    if (url.pathname === '/pending') { pendingResponse = response; return }
    if (url.pathname === '/dropped') { response.destroy(); return }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ index: Number(url.searchParams.get('i')) }))
  })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
async function list(query: BrowserNetworkQuery = {}) {
  return page.evaluate(({ tabId, query }) => window.aether.browser.network(tabId, query), { tabId, query })
}
async function detail(id: string, bodyOffset = 0, bodyLimit = 12000): Promise<BrowserNetworkDetail> {
  return page.evaluate(({ tabId, id, bodyOffset, bodyLimit }) => window.aether.browser.networkRequest(tabId, id, { bodyOffset, bodyLimit }), { tabId, id, bodyOffset, bodyLimit })
}
test.describe.serial('浏览器网络列表和请求详情', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp/browser-network-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: false }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(String(error)))
    await expect(page.locator('.status-bar')).toBeVisible()
    await page.keyboard.press('Control+Alt+b')
    await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: '网页地址', exact: true }).fill(`${origin}/page`)
    await page.getByRole('textbox', { name: '网页地址', exact: true }).press('Enter')
    await expect.poll(() => page.evaluate(() => window.aether.browser.list())).toContainEqual(expect.objectContaining({ title: '网络详情验收', loading: false }))
    tabId = (await page.evaluate(() => window.aether.browser.list())).find(tab => tab.url === `${origin}/page`)!.tabId
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.aether.browser.read(id, 'snapshot'), tabId)
      return JSON.stringify(result.output)
    }).toContain('全部请求已完成')
    await expect.poll(async () => (await list({ url: '/batch', limit: 100 })).entries.filter(entry => entry.finished).length).toBe(65).catch(async error => {
      const network = await list({ limit: 100 })
      console.log('NETWORK_SETUP_DIAGNOSTICS', JSON.stringify({ received: received.length, network, console: await page.evaluate(id => window.aether.browser.read(id, 'console'), tabId) }))
      throw error
    })
    echoId = (await list({ url: '/echo', method: 'POST' })).entries[0].id
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    pendingResponse?.end('finished')
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (dirname(resolve(fixture)) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('browser-network-')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('筛选在分页之前执行，列表仅返回摘要且每条请求有稳定ID', async () => {
    const first = await list({ url: '/batch', limit: 50 })
    expect(first).toMatchObject({ total: 65, offset: 0, limit: 50, hasMore: true, nextOffset: 50, dropped: 0 })
    expect(first.entries).toHaveLength(50)
    const next = await list({ url: '/batch', offset: first.nextOffset, limit: 50 })
    expect(next.entries).toHaveLength(15); expect(next.hasMore).toBe(false)
    expect(new Set([...first.entries, ...next.entries].map(entry => entry.id)).size).toBe(65)
    expect((await list({ url: '/batch', limit: 50 })).entries.map(entry => entry.id)).toEqual(first.entries.map(entry => entry.id))
    const filtered = await list({ method: 'POST', status: '2xx', resourceType: 'Fetch', url: '/echo' })
    expect(filtered.entries).toHaveLength(1); echoId = filtered.entries[0].id
    expect(filtered.entries[0]).toMatchObject({ method: 'POST', status: 201, finished: true, mimeType: 'application/json' })
    expect(JSON.stringify(filtered)).not.toContain('服务端返回中文')
    expect(JSON.stringify(filtered)).not.toContain('query-private-value')
    const failed = await list({ failedOnly: true })
    expect(failed.entries).toContainEqual(expect.objectContaining({ status: 503 }))
    expect(failed.entries.some(entry => entry.url.endsWith('/dropped') && entry.error)).toBe(true)
    expect((await list({ url: '/batch', minDurationMs: 999999 })).total).toBe(0)
  })

  test('根据ID取得真实头、查询、载荷、响应和时序，敏感值不会混入输出', async () => {
    const result = await detail(echoId)
    expect(result.entry.id).toBe(echoId)
    expect(result.request.headers).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/^x-debug-trace$/i), value: 'trace-network' }))
    expect(result.request.headers).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/^authorization$/i), redacted: true }))
    expect(result.response.headers).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/^x-trace-id$/i), value: 'fixture-echo-trace' }))
    expect(result.request.query).toContainEqual(expect.objectContaining({ name: 'q', value: '中文查询' }))
    expect(result.request.body.state).toBe('available')
    expect(JSON.parse(result.request.body.text!)).toMatchObject({ title: '提交的中文', count: 2 })
    expect(result.response.body.state).toBe('available')
    expect(JSON.parse(result.response.body.text!)).toMatchObject({ ok: true, message: '服务端返回中文' })
    expect(result.response).toMatchObject({ remoteIPAddress: '127.0.0.1', protocol: 'http/1.1' })
    expect(Object.values(result.timing).some(value => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(result.initiator?.type).toBe('script')
    expect(result.request.cookies).toContainEqual(expect.objectContaining({ name: 'fixture_session', redacted: true }))
    for (const secret of ['query-private-value','fixture-private-auth','payload-private-value','response-private-token','cookie-private-value','another-private-cookie']) expect(JSON.stringify(result)).not.toContain(secret)
    expect(received.find(request => request.url === '/echo')).toMatchObject({ method: 'POST', body: JSON.stringify({ title: '提交的中文', password: 'payload-private-value', count: 2 }) })
    const hops = (await list({ status: '3xx' })).entries
    const redirect = await detail(hops.find(entry => entry.url.endsWith('/redirect'))!.id)
    expect(redirect.nextRequestId).toBeDefined()
    const destination = await detail(redirect.nextRequestId!)
    expect(destination.entry).toMatchObject({ status: 200, url: `${origin}/final` })
    expect(destination.previousRequestId).toBe(redirect.entry.id)
    expect(destination.response.body.text).toBe('重定向完成')
  })

  test('正文可连续读取，二进制、空响应、未完成和跨标签ID均有准确结果', async () => {
    const longId = (await list({ url: '/long' })).entries[0].id
    const first = await detail(longId, 0, 4096)
    expect(first.response.body).toMatchObject({ state: 'available', offset: 0, returnedChars: 4096, hasMore: true, nextOffset: 4096 })
    let body = first.response.body.text ?? '', next = first.response.body.nextOffset
    while (next !== undefined) {
      const part = (await detail(longId, next, 4096)).response.body
      body += part.text ?? ''; next = part.nextOffset
      if (body.length > longText.length + 4096) throw new Error('Invalid body cursor')
    }
    expect(body).toBe(longText)
    const binary = await detail((await list({ url: '/binary' })).entries[0].id)
    expect(binary.response.body).toMatchObject({ state: 'binary', hasMore: false })
    const empty = await detail((await list({ url: '/empty' })).entries[0].id)
    expect(empty.response.body.state, JSON.stringify(empty)).toBe('empty')
    await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript("void fetch('/pending')"), `${origin}/page`)
    await expect.poll(async () => (await list({ url: '/pending', status: 'pending' })).total).toBe(1)
    expect((await detail((await list({ url: '/pending' })).entries[0].id)).response.body.state).toBe('pending')
    pendingResponse?.writeHead(200, { 'Content-Type': 'text/plain' }).end('pending request completed')
    const other = await page.evaluate(() => window.aether.browser.create({ url: 'about:blank' }))
    const rejected = await page.evaluate(async ({ id, requestId }) => { try { await window.aether.browser.networkRequest(id, requestId); return '' } catch(error) { return String(error) } }, { id: other.tabId, requestId: echoId })
    expect(rejected).not.toBe('')
    await page.evaluate(id => window.aether.browser.close(id), other.tabId)
  })

  test('网络面板筛选分页与请求详情真实可用，长响应可继续加载', async ({}, testInfo) => {
    await page.getByRole('button', { name: '网络', exact: true }).click()
    const panel = page.getByRole('region', { name: '浏览器网络请求', exact: true })
    await expect(panel).toBeVisible()
    await panel.getByRole('textbox', { name: '过滤网络请求', exact: true }).fill('/echo')
    await panel.getByRole('button', { name: '网络资源类型', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Fetch', exact: true }).click()
    const rows = panel.getByRole('button', { name: /^查看请求 / })
    await expect(rows).toHaveCount(1)
    const separator = panel.getByRole('separator', { name: '调整网络面板高度', exact: true })
    await separator.focus()
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp')
    await rows.first().click()
    await panel.getByRole('tab', { name: '标头', exact: true }).click()
    await expect(panel).toContainText('fixture-echo-trace')
    await panel.getByRole('tab', { name: '参数与载荷', exact: true }).click()
    await expect(panel.getByLabel('请求正文', { exact: true })).toContainText('提交的中文')
    await panel.getByRole('tab', { name: '响应', exact: true }).click()
    await expect(panel.getByLabel('响应正文', { exact: true })).toContainText('服务端返回中文')
    const beforeTheme = await page.evaluate(() => document.documentElement.dataset.appearance)
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance }, appearance)
      await panel.screenshot({ path: testInfo.outputPath(`network-details-${appearance}.png`) })
    }
    await page.evaluate(value => { if (value) document.documentElement.dataset.appearance = value }, beforeTheme)
    await panel.getByRole('textbox', { name: '过滤网络请求', exact: true }).fill('/batch')
    await expect(rows).toHaveCount(50)
    await panel.getByRole('button', { name: '下一页请求', exact: true }).click()
    await expect(rows).toHaveCount(15)
    await panel.getByRole('button', { name: '上一页请求', exact: true }).click()
    await expect(rows).toHaveCount(50)
    await panel.getByRole('textbox', { name: '过滤网络请求', exact: true }).fill('/long')
    await expect(rows).toHaveCount(1); await rows.first().click()
    await panel.getByRole('tab', { name: '响应', exact: true }).click()
    const body = panel.getByLabel('响应正文', { exact: true })
    await expect(body).toContainText('分段读取中文响应。')
    const before = (await body.textContent())!.length
    await panel.getByRole('button', { name: '加载更多响应正文', exact: true }).click()
    await expect.poll(async () => (await body.textContent())!.length).toBeGreaterThan(before)
    const accumulated = (await body.textContent())!.length
    await panel.getByRole('button', { name: '刷新网络请求', exact: true }).click()
    await expect(panel.getByRole('tab', { name: '响应', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => (await body.textContent())!.length).toBe(accumulated)
    await page.screenshot({ path: testInfo.outputPath('network-inspector.png'), fullPage: true })
    await separator.focus()
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown')
    await expect(separator).toHaveAttribute('aria-valuenow', '200')
    await panel.getByRole('tab', { name: '概览', exact: true }).click()
    await expect(panel.getByRole('tabpanel')).toContainText(`${origin}/long`)
    expect(await panel.getByRole('tabpanel').evaluate(element => element.clientHeight)).toBeGreaterThan(50)
    await panel.getByRole('textbox', { name: '过滤网络请求', exact: true }).fill('')
    await panel.getByRole('checkbox', { name: '仅失败请求', exact: true }).check()
    await expect(panel.getByRole('button', { name: new RegExp('查看请求 GET .*' + '/failed') })).toBeVisible()
    await expect(panel.getByRole('button', { name: /查看请求 GET .*\/batch/ })).toHaveCount(0)
    await panel.getByRole('button', { name: '清除网络筛选', exact: true }).click()
    await panel.getByRole('button', { name: '网络请求耗时', exact: true }).click()
    await page.getByRole('menuitem', { name: '≥ 3 秒', exact: true }).click()
    await expect(rows).toHaveCount(0)
    await expect(panel).toContainText('没有匹配的请求')
    await panel.getByRole('button', { name: '清除网络筛选', exact: true }).click()
    await expect(rows).toHaveCount(50)
  })

  test('开发者工具占用时保留已捕获详情并说明暂停，关闭后继续捕获', async () => {
    expect((await detail(echoId)).response.body.state).toBe('available')
    const uncached = (await list({ url: '/batch', limit: 1 })).entries[0].id
    await page.evaluate(id => window.aether.browser.action({ tabId: id, action: 'devtools' }), tabId)
    await expect.poll(() => app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.isDevToolsOpened(), `${origin}/page`)).toBe(true)
    expect((await list()).warnings?.join(' ')).toMatch(/暂停|开发者工具/)
    const cached = await detail(echoId)
    expect(cached.response.headers).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/^x-trace-id$/i), value: 'fixture-echo-trace' }))
    expect(cached.response.body.state).toBe('available')
    const missing = await detail(uncached)
    expect(missing.response.body.state).toBe('unavailable')
    expect(missing.response.body.reason).toMatch(/开发者工具|调试/)
    await page.evaluate(id => window.aether.browser.action({ tabId: id, action: 'devtools' }), tabId)
    await expect.poll(() => app!.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!
      return !wc.isDevToolsOpened() && wc.debugger.isAttached()
    }, `${origin}/page`)).toBe(true)
    await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript("fetch('/resumed').then(response=>response.text())"), `${origin}/page`)
    await expect.poll(async () => (await list({ url: '/resumed' })).entries).toContainEqual(expect.objectContaining({ status: 200, finished: true }))
  })
})
