/** Settings → isolated admin window, the real paired service, and policy set by a remote test service. */
import { test, expect } from '@playwright/test'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixtureRecoveryKey } from './fixtures/engine-candidate'
import {
  a,
  action,
  address,
  app,
  b,
  current,
  launch,
  live,
  open,
  page,
  profile,
  registerConnectionHarness,
  root,
  settings
} from './fixtures/engine-connection-harness'

registerConnectionHarness({ captureOnFailure: false })
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

const paired = resolve(
  process.env.AETHER_ENGINE_SOURCE_DIR || join(root, '../ai-agent-engine'),
  'dist'
)
const enter = (): Promise<void> => current().getByTestId('engine-open-admin').click()
const windowCount = (): Promise<number> =>
  app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
// The admin window deliberately disables DevTools/preload. Exercise its real controls in its own document.
function inPanel<T>(url: string, expression: string): Promise<T | null> {
  return app!.evaluate(
    async ({ BrowserWindow }, target) => {
      const wc = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === target.url
      )?.webContents
      return wc ? await wc.executeJavaScript(target.expression, true) : null
    },
    { url, expression }
  )
}
const state = (url: string): Promise<unknown> =>
  inPanel(
    url,
    `({
  overview: !!document.querySelector('#overview')?.getClientRects().length,
  login: !!document.querySelector('#access-form')?.getClientRects().length,
  viewer: document.querySelector('#viewer-name')?.textContent,
  role: document.querySelector('#viewer-role')?.textContent,
  notice: document.querySelector('#notice')?.textContent,
  isolated: typeof window.aether === 'undefined' && typeof window.require === 'undefined'
})`
  )
async function closePanel(url: string): Promise<void> {
  await inPanel(url, "document.querySelector('#disconnect')?.click()")
  await expect.poll(windowCount).toBe(1)
}

async function unusedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((done, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', done)
  })
  const address = probe.address()
  await new Promise<void>((done, reject) =>
    probe.close((error) => (error ? reject(error) : done()))
  )
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  return address.port
}

test('旧引擎在设置里显示升级说明，不会把 401 JSON 当管理页打开', async () => {
  await launch()
  await open()
  await enter()
  await expect(current().getByRole('alert')).toContainText(/升级实际运行的引擎/)
  expect(await windowCount()).toBe(1)
})

test('自管本机一次进入概览、导出规则并可关闭再打开；独立浏览器仍须登录，个人账号不继承管理员权限', async () => {
  const port = await unusedPort()
  await launch('local', { engineEntry: join(paired, 'main.js'), preferredPort: port })
  await expect
    .poll(live, { timeout: 90000 })
    .toMatchObject({ phase: 'ready', mode: 'embedded', adopted: false, port })
  const snapshot = await live(),
    url = snapshot.baseUrl + '/admin/'
  expect(snapshot.dataDir).toBe(join(profile, 'engine', 'state', 'agent.db'))
  await open()
  await enter()
  await expect
    .poll(() => state(url))
    .toMatchObject({
      overview: true,
      login: false,
      viewer: '本机桌面管理员',
      role: '主管理员',
      isolated: true
    })
  const anonymous = await app!.evaluate(async ({ BrowserWindow }, address) => {
    const guest = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: 'independent-admin-test',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    try {
      await guest.loadURL(address)
      return await guest.webContents
        .executeJavaScript(`(async () => ({ login: !!document.querySelector('#access-form')?.getClientRects().length,
        overview: !!document.querySelector('#overview')?.getClientRects().length, status: (await fetch('./me')).status }))()`)
    } finally {
      guest.destroy()
    }
  }, url)
  expect(anonymous).toEqual({ login: true, overview: false, status: 401 })
  await inPanel(url, "document.querySelector('[data-page=settings]').click()")
  await expect
    .poll(() => inPanel<string>(url, "document.getElementById('view-content').innerText"))
    .toContain('无需配置实例令牌或后台密钥')
  const instanceSettings = await inPanel<string>(
    url,
    "document.getElementById('view-content').innerText"
  )
  expect(instanceSettings).toContain('本机桌面')
  expect(instanceSettings).not.toContain('admin-cli')
  await inPanel(url, "document.querySelector('[data-page=rules]').click()")
  await expect
    .poll(() =>
      inPanel<boolean>(
        url,
        "!!Array.from(document.querySelectorAll('#view-content summary')).find(e => e.textContent === '规则备份与恢复')"
      )
    )
    .toBe(true)
  await inPanel(
    url,
    "Array.from(document.querySelectorAll('#view-content summary')).find(e => e.textContent === '规则备份与恢复').click()"
  )
  const output = join(profile, 'rules-export.json')
  const finished = await app!.evaluate(
    async ({ BrowserWindow }, detail) => {
      const wc = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === detail.url
      )!.webContents
      const completion = new Promise<string>((done) => {
        const timeout = setTimeout(() => done('timeout'), 10000)
        wc.session.once('will-download', (_event, item) => {
          item.setSavePath(detail.output)
          item.once('done', (_event, value) => {
            clearTimeout(timeout)
            done(value)
          })
        })
      })
      await wc.executeJavaScript(
        "Array.from(document.querySelectorAll('#view-content button')).find(e => e.textContent === '导出 JSON').click()",
        true
      )
      return completion
    },
    { url, output }
  )
  expect(finished).toBe('completed')
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
    format: 'aether.monitor-rules',
    version: 1,
    rules: []
  })
  await closePanel(url)
  await enter()
  await expect.poll(() => state(url)).toMatchObject({ viewer: '本机桌面管理员', overview: true })
  // Issue through the real management UI. Keep the one-use value out of assertions, traces and logs.
  await inPanel(url, "document.querySelector('[data-page=accounts]').click()")
  await expect.poll(() => inPanel(url, "!!document.getElementById('issue-activation-code')")).toBe(true)
  await inPanel(url, "document.getElementById('issue-activation-code').click()")
  await inPanel(url, "document.getElementById('dialog-accept').click()")
  await expect.poll(() => inPanel(url, "!!document.getElementById('issued-activation-code')?.value")).toBe(true)
  const code = await inPanel<string>(url, "document.getElementById('issued-activation-code').value")
  if (!code) throw new Error('Missing fixture enrollment')
  await inPanel(url, "document.getElementById('dialog-accept').click()")
  expect(await inPanel(url, "!!document.getElementById('issued-activation-code')")).toBe(false)
  const loggedIn = await page.evaluate(async activation => (await window.aether.account.register(activation)).status, { code, serviceUrl: snapshot.baseUrl })
  expect(loggedIn).toBe('authenticated')
  await expect.poll(windowCount).toBe(1)
  await enter()
  await expect
    .poll(() => state(url))
    .toMatchObject({
      login: false,
      overview: false,
      notice: expect.stringMatching(/没有.*后台权限/),
      isolated: true
    })
  await page.evaluate(() => window.aether.engine.stop())
  await expect.poll(windowCount).toBe(1)
})

test('连接其他引擎：无身份交给独立登录；账号只获得该服务授予的权限', async () => {
  // Use the paired console HTML/JS for both allowed and denied responses. The disposable B service owns its role policy.
  const ui = (await import(pathToFileURL(join(paired, 'api/http/admin/page.js')).href)) as Record<
    'ADMIN_HTML' | 'DESKTOP_ADMIN_HTML' | 'ADMIN_JS' | 'ADMIN_CSS',
    string
  >
  let permit = false
  const traffic: Array<{
    path: string
    method: string
    account: boolean
    gate: boolean
    owner: boolean
    entry: boolean
  }> = []
  b.adminHandler = (req, res, account) => {
    const path = new URL(req.url!, b.origin).pathname,
      entry = req.headers['x-aether-admin-entry'] === 'current'
    traffic.push({
      path,
      method: req.method ?? 'GET',
      account,
      gate: !!req.headers['x-aether-instance-token'],
      owner: !!req.headers['x-aether-admin-key'],
      entry
    })
    if (path === '/admin/') {
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-aether-admin-surface': '1',
          'x-aether-admin-desktop': '1'
        })
        .end(entry ? ui.DESKTOP_ADMIN_HTML : ui.ADMIN_HTML)
      return
    }
    if (path === '/admin/app.js' || path === '/admin/app.css') {
      const js = path.endsWith('.js')
      res
        .writeHead(200, { 'content-type': js ? 'text/javascript' : 'text/css' })
        .end(js ? ui.ADMIN_JS : ui.ADMIN_CSS)
      return
    }
    if (path === '/admin/icon.png') {
      res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(readFileSync(join(paired, 'api/http/admin/icon.png')))
      return
    }
    const status = !account
      ? 401
      : !permit
        ? 403
        : !['/admin/me', '/admin/status'].includes(path)
          ? 404
          : 200
    const data =
      status !== 200
        ? null
        : path.endsWith('/me')
          ? {
              id: 'viewer-b',
              name: '服务 B 的只读管理员',
              roleId: 'viewer',
              roleName: '只读管理员',
              recovery: false,
              permissions: ['status.read']
            }
          : {
              version: '2.0.0',
              instanceToken: 'not-set',
              authenticationRequired: true,
              startedAt: new Date().toISOString(),
              uptimeSeconds: 12
            }
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify({ code: status, message: 'fixture', data }))
  }
  await launch()
  await open()
  await address().fill(b.origin)
  await action().click()
  await expect.poll(live).toMatchObject({ phase: 'ready', baseUrl: b.origin, accountId: null })
  // Catch only the OS handoff; never launch the user's actual browser or expose credentials to it.
  await app!.evaluate(({ shell }) => {
    const urls: string[] = []
    Object.assign(shell, {
      adminFixtureExternal: urls,
      openExternal: async (url: string) => {
        urls.push(url)
      }
    })
  })
  const external = (): Promise<string[]> =>
    app!.evaluate(
      ({ shell }) =>
        (shell as typeof shell & { adminFixtureExternal: string[] }).adminFixtureExternal
    )
  const url = b.origin + '/admin/'
  await enter()
  await expect.poll(external).toEqual([url])
  expect(await windowCount()).toBe(1)
  expect(traffic.map((r) => [r.method, r.entry])).toEqual([['HEAD', false]])
  await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
  await expect(settings().locator('.account-service__address')).toHaveText(b.origin)
  await settings().getByRole('button', { name: '登录已有账号', exact: true }).click()
  await settings().getByLabel('恢复码', { exact: true }).fill(fixtureRecoveryKey)
  await settings().getByRole('button', { name: '登录', exact: true }).click()
  await expect
    .poll(live)
    .toMatchObject({ phase: 'ready', baseUrl: b.origin, accountId: 'fixture-account-b' })
  await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
  await enter()
  await expect
    .poll(() => state(url))
    .toMatchObject({
      login: false,
      overview: false,
      notice: expect.stringMatching(/没有.*后台权限/),
      isolated: true
    })
  expect(traffic.some((r) => r.path === '/admin/me' && r.account)).toBe(true)
  await closePanel(url)
  permit = true
  await enter()
  await expect
    .poll(() => state(url))
    .toMatchObject({
      login: false,
      overview: true,
      viewer: '服务 B 的只读管理员',
      role: '只读管理员',
      isolated: true
    })
  await expect
    .poll(() => inPanel(url, "document.querySelector('#version')?.textContent"))
    .toBe('2.0.0')
  expect(await inPanel(url, "document.querySelector('#nav-members').hidden")).toBe(true)
  expect(traffic.some((r) => r.path === '/admin/' && r.method === 'GET' && r.entry)).toBe(true)
  expect(
    traffic.filter((r) => !['/admin/me', '/admin/status'].includes(r.path)).every((r) => !r.account)
  ).toBe(true)
  expect(traffic.every((r) => !r.owner && !r.gate)).toBe(true)
  expect(await external()).toEqual([url])
  expect(url).not.toContain(a.origin)
  await page.evaluate(() => window.aether.engine.stop())
  await expect.poll(windowCount).toBe(1)
})
