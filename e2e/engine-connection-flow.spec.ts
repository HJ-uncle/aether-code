/** Real renderer, preload, IPC and host against two disposable loopback engines. */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixtureRecoveryKey } from './fixtures/engine-candidate'
import { resourceWorkspace } from './fixtures/resource-settings'
import { root, profile, a, b, page, settings, draft, address, action, current, live, saved, open, advanced, accountAdvanced, launch, stillA, size, registerConnectionHarness } from './fixtures/engine-connection-harness'

registerConnectionHarness()

test('连接失败保留可用的 A，账号入口不会提交引擎地址草稿', async () => {
  await launch(); await open(); await address().fill(b.origin)
  await expect(draft().getByRole('button', { name: '管理个人账号', exact: true })).toHaveCount(0)
  await expect(action()).toHaveText('应用并连接')
  await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
  await expect(settings().locator('.account-service__address')).toHaveText(a.origin)
  expect(b.requests).toHaveLength(0)
  await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
  await expect(address()).toHaveValue(b.origin)
  b.behavior = 'incompatible'; await action().click()
  await expect(draft().getByRole('alert')).toBeVisible(); await expect(current()).toContainText(a.origin)
  await expect(address()).toHaveValue(b.origin); await stillA()
  b.behavior = 'token'; await action().click()
  await expect(draft().getByRole('alert')).toContainText(/令牌/)
  await expect.poll(() => b.requests.filter(r => r.path === '/api/v1/tools').length).toBeGreaterThan(0)
  await expect(action()).toHaveText('应用并连接'); await stillA()
  const scoped = await page.evaluate(async ([urlA,urlB]) => Promise.all([window.aether.settings.remoteTokenStatus(urlA),window.aether.settings.remoteTokenStatus(urlB),window.aether.settings.remoteAuthStatus(urlB)]),[a.origin,b.origin])
  expect(scoped.map(status => status.source)).toEqual(['environment','none','none'])
  await settings().getByRole('textbox', { name: '搜索设置', exact: true }).fill('JWT')
  const matches = settings().getByRole('listbox', { name: '设置搜索结果', exact: true })
  await expect(matches.getByRole('option', { name: /引擎管理/ })).toHaveCount(0)
  await matches.getByRole('option', { name: /个人账号与登录/ }).click()
  await expect(settings().getByRole('tab', { name: '个人账号', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(settings().locator('.account-service__address')).toHaveText(a.origin)
})

test('应用 B 后停留在引擎页；按需前往个人账号，登录后以 B 的身份自动连接', async () => {
  b.behavior = 'login'; await launch(); await open(); await address().fill(b.origin)
  await expect(action()).toHaveText('应用并连接'); await action().click()
  await expect(action()).toHaveText('前往登录')
  await expect(settings().getByRole('tab', { name: '引擎管理', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await saved()).remoteBaseUrl).toBe(b.origin)
  expect(await live()).toMatchObject({ phase: 'error', connectionIssue: 'authentication-required' })
  await action().click()
  await expect(settings().getByRole('tab', { name: '个人账号', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(settings().locator('.account-service__address')).toHaveText(b.origin)
  await settings().getByRole('button', { name: '登录已有账号', exact: true }).click()
  await settings().getByLabel('恢复码', { exact: true }).fill(fixtureRecoveryKey)
  await settings().getByRole('button', { name: '登录', exact: true }).click()
  await expect(settings().getByRole('region', { name: '账号概览' })).toContainText('服务 B 的测试账号')
  await expect.poll(live).toMatchObject({ phase: 'ready', baseUrl: b.origin, instanceId: 'fixture-engine-b', accountId: 'fixture-account-b' })
  expect(b.requests.filter(r => r.path === '/auth/account/login')).toHaveLength(1)
  expect(b.requests.some(r => r.path === '/api/v1/tools' && r.bearer.startsWith('Bearer '))).toBe(true)
  await accountAdvanced()
  await expect(settings().getByLabel('远端用户认证凭据', { exact: true })).toBeDisabled()
  await expect(settings().getByRole('button', { name: '远端认证方式', exact: true })).toBeDisabled()
  await expect(settings().getByRole('button', { name: /(?:生成|复制).*API Key/i })).toHaveCount(0)
  await settings().getByRole('tab', { name: '引擎管理', exact: true }).click(); await advanced()
  await expect(draft().getByLabel('远端用户认证凭据', { exact: true })).toHaveCount(0)
  await expect(draft().getByRole('button', { name: '远端认证方式', exact: true })).toHaveCount(0)
  await expect(draft().getByRole('button', { name: /生成.*实例令牌/ })).toBeEnabled()
})

async function installSentinelRuntime(): Promise<{ id: string; runtimes: string; marker: string }> {
  const { constants, copyFileSync, linkSync } = await import('node:fs')
  const id = 'runtime-' + 'c'.repeat(32), name = '本机选择验证包', version = '2.0.9', buildId = 'sha256:' + 'c'.repeat(64)
  const runtimes = join(profile, 'engine', 'runtimes'), installed = join(runtimes, id)
  const entry = join(installed, 'dist', 'main.js'), marker = join(installed, 'unexpected-launch'), binary = join(installed, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  mkdirSync(join(installed, 'dist', 'runtime'), { recursive: true }); mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(join(installed, 'runtime-info.json'), JSON.stringify({ id, name, version, buildId, fileName: 'runtime-fixture.tgz', importedAt: 1_700_000_000_000 }))
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'local-choice-fixture', version, type: 'commonjs' }))
  writeFileSync(join(installed, 'dist', 'runtime', 'build-manifest.json'), JSON.stringify({ version, buildId, protocolVersion: 1, subagentSchemaVersion: 1, toolProfiles: ['general'] }))
  // A real executable and a sentinel entry distinguish selection from accidentally launching a local process.
  try { linkSync(process.execPath, binary) } catch { copyFileSync(process.execPath, binary, constants.COPYFILE_FICLONE) }
  writeFileSync(entry, "require('node:fs').writeFileSync(require('node:path').join(__dirname,'..','unexpected-launch'),'started'); process.exitCode = 74\n")
  mkdirSync(join(installed, 'SKILLs'), { recursive: true })
  return { id, runtimes, marker }
}

test('远端工作时预选本机版本不中断请求，应用后本机启动失败则恢复原服务', async () => {
  const { existsSync, readFileSync } = await import('node:fs')
  const { id, runtimes, marker } = await installSentinelRuntime()
  await launch()
  await open()
  await draft().getByRole('radio', { name: '本机引擎（推荐）', exact: true }).check(); await advanced()
  const pick = draft().getByRole('button', { name: '选择已导入的本地引擎', exact: true })
  await pick.click()
  const choices = page.getByRole('menu', { name: '选择已导入的本地引擎', exact: true })
  await expect(choices).not.toContainText('runtime-fixture.tgz')
  await choices.getByRole('menuitem', { name: '2.0.9 · 本机选择验证包', exact: true }).click()
  const archiveName = draft().getByText('runtime-fixture.tgz', { exact: true })
  await expect(archiveName).toBeHidden(); await draft().locator('summary').filter({ hasText: /^版本信息$/ }).click(); await expect(archiveName).toBeVisible()
  expect(await page.evaluate(() => window.aether.engine.getLocalRuntimes())).toMatchObject({ activeId: null, runtimes: [expect.objectContaining({ id })] })
  const before = await live()
  a.holdMemoryId = 'memory-global'
  const pending = page.evaluate(expectedEngine => window.aether.engine.request<{ id: string }>({ method: 'GET', path: '/memory/memory-global', query: { scope: 'global' }, expectedEngine }), before)
  try {
    await expect.poll(() => a.heldMemory?.record.id).toBe('memory-global')
    await draft().getByRole('button', { name: '选用此版本', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getLocalRuntimes())).activeId).toBe(id)
    expect(JSON.parse(readFileSync(join(runtimes, 'active-runtime.json'), 'utf8'))).toEqual({ id })
    await expect(action()).toHaveText('应用并启动'); await expect(current()).toContainText(a.origin)
    expect(await saved()).toMatchObject({ engineMode: 'remote', remoteBaseUrl: a.origin })
    expect(await live()).toMatchObject({ mode: 'remote', phase: 'ready', baseUrl: a.origin, accountId: before.accountId, instanceId: before.instanceId })
    expect(a.heldMemory?.response.destroyed).toBe(false); expect(existsSync(marker)).toBe(false)
  } finally {
    a.releaseMemory()
    await expect(pending).resolves.toMatchObject({ ok: true, data: { id: 'memory-global' } })
  }
  await stillA()
  await action().click()
  await expect.poll(() => existsSync(marker), { timeout: 15000 }).toBe(true)
  await expect(draft().getByRole('alert')).toBeVisible({ timeout: 30000 })
  await stillA()
  expect((await saved()).remoteWorkspaceRoot).toBe(resourceWorkspace)
  await expect(draft().getByRole('radio', { name: '本机引擎（推荐）', exact: true })).toBeChecked()
})

test('取消 B 的检查不会断开 A，也不会在迟到响应后切换', async () => {
  b.behavior='hold'; await launch(); await open(); await address().fill(b.origin); await action().click()
  await expect.poll(() => b.activeProbes()).toBe(1); await expect(action()).toHaveText('取消连接')
  expect(await live()).toMatchObject({phase:'ready',baseUrl:a.origin}); await action().click()
  await expect.poll(() => b.activeProbes()).toBe(0); b.release()
  await expect(action()).not.toHaveText('取消连接'); await expect(address()).toHaveValue(b.origin); await stillA()
  expect(b.requests.some(r=>r.path==='/api/v1/tools')).toBe(false)
})

test('应用启动时的第一次连接可以取消，之后可以手动重试', async () => {
  b.behavior='hold'; await launch('b'); await open(); await expect(action()).toHaveText('取消连接'); await action().click()
  await expect.poll(live).toMatchObject({phase:'idle'}); await expect.poll(() => b.activeProbes()).toBe(0); b.release()
  await expect(action()).toHaveText('连接引擎'); await action().click()
  await expect.poll(live).toMatchObject({phase:'ready',baseUrl:b.origin,instanceId:'fixture-engine-b'})
})

test('来源、草稿和高级选项在键盘、浅深色与窄窗中可用', async () => {
  const info = test.info()
  await launch(); await open(); const local=draft().getByRole('radio',{name:'本机引擎（推荐）',exact:true}), remote=draft().getByRole('radio',{name:'连接其他引擎',exact:true})
  await expect(remote).toBeChecked(); await local.focus(); await local.press('Space'); await expect(local).toBeChecked(); await expect(address()).toHaveCount(0)
  await local.press('ArrowRight'); await expect(remote).toBeChecked(); await expect(address()).toBeVisible()
  await expect(draft().getByLabel('实例令牌',{exact:true})).toBeHidden(); await advanced()
  await draft().getByLabel('实例令牌',{exact:true}).fill('unsaved-a-token'); await address().fill(b.origin); await expect(draft().getByLabel('实例令牌',{exact:true})).toHaveValue('')
  await draft().getByLabel('实例令牌',{exact:true}).fill('unsaved-b-token'); await settings().getByRole('tab',{name:'外观',exact:true}).click()
  await settings().getByRole('tab',{name:'引擎管理',exact:true}).click(); await expect(address()).toHaveValue(b.origin); await advanced()
  await expect(draft().getByLabel('实例令牌',{exact:true})).toHaveValue(''); await expect(draft().getByRole('button',{name:'保存',exact:true})).toHaveCount(0)
  await expect(draft().getByRole('textbox',{name:'远端工作目录'})).toHaveCount(0); await stillA()
  for (const mode of ['light','dark']) for (const width of [1200,620]) {
    await page.evaluate(mode=>{document.documentElement.dataset.appearance=mode},mode); await size(width); await action().scrollIntoViewIfNeeded()
    await expect(action()).toBeInViewport(); expect(await draft().evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1)
    const capture=info.outputPath(`connection-${mode}-${width}.png`); await page.screenshot({path:capture,animations:'disabled'}); await info.attach(`connection-${mode}-${width}`,{path:capture,contentType:'image/png'})
  }
  await page.keyboard.press('Escape'); await expect(settings()).toHaveCount(0)
  await open()
  await page.locator('.modal-overlay').click({ position: { x: 4, y: 4 } }); await expect(settings()).toHaveCount(0)
})

test('已保存的远端启动时暂时不可用，恢复后自行就绪', async () => {
  b.behavior = 'unavailable'; await launch('b')
  await expect.poll(async () => {
    const state = await live()
    return state.phase === 'starting' && (state.reconnectAttempt ?? 0) > 0
  }, { timeout: 20000 }).toBe(true)
  b.behavior = 'ready'
  await expect.poll(live, { timeout: 20000 }).toMatchObject({ phase: 'ready', baseUrl: b.origin, reconnectAttempt: 0 })
  expect(b.requests.filter(r => r.path === '/health').length).toBeGreaterThanOrEqual(2)
  expect(b.requests.filter(r => r.path === '/api/v1/tools')).toHaveLength(1)
})

test('切换成功只验证一次，IPC 回执已就绪，只改启动偏好不会重连', async () => {
  await launch()
  const receipt = await page.evaluate(async url => {
    const before = await window.aether.settings.get()
    return window.aether.engine.applyConnection({ engineMode: 'remote', preferredPort: before.preferredPort,
      remoteBaseUrl: url, remoteWorkspaceRoot: '', autoStartEngine: true, instanceToken: 'instance-only-for-b' })
  }, b.origin)
  expect(receipt).toMatchObject({ phase: 'ready', baseUrl: b.origin, instanceId: 'fixture-engine-b', checkingConnection: false })
  expect(await live()).toEqual(receipt)
  expect(b.requests.filter(r => r.path === '/api/v1/tools')).toHaveLength(1)
  expect(b.requests.find(r => r.path === '/api/v1/tools')).toMatchObject({ token: 'instance-only-for-b' })
  expect(b.requests.filter(r => r.path === '/health' || r.path === '/meta').every(r => !r.token && !r.apiKey && !r.bearer)).toBe(true)
  const preference = await page.evaluate(async () => {
    const saved = await window.aether.settings.get()
    const phases: string[] = []
    const off = window.aether.engine.onSnapshot(s => phases.push(s.phase))
    try {
      const snapshot = await window.aether.engine.applyConnection({ engineMode: 'remote', preferredPort: saved.preferredPort,
        remoteBaseUrl: saved.remoteBaseUrl, remoteWorkspaceRoot: saved.remoteWorkspaceRoot, autoStartEngine: false })
      return { snapshot, phases, autoStart: (await window.aether.settings.get()).autoStartEngine }
    } finally { off() }
  })
  expect(preference).toMatchObject({ snapshot: receipt, phases: [], autoStart: false })
  expect(b.requests.filter(r => r.path === '/api/v1/tools')).toHaveLength(1)
})

test('远端监控分开显示连接时间和资源采样，不把本机当作服务端', async () => {
  await launch('b')
  await expect.poll(live).toMatchObject({ phase: 'ready', baseUrl: b.origin })
  await page.getByRole('complementary', { name: '应用导航', exact: true }).getByRole('button', { name: '引擎监控', exact: true }).click()
  await expect(page.getByRole('region', { name: '引擎概览' })).toContainText('服务端进程不可见')
  const identity = page.getByRole('region', { name: '引擎身份' })
  await expect(identity).toContainText('数据库文件服务端未提供')
  const changed = identity.getByText('连接状态更新时间', { exact: true }).locator('..').locator('strong')
  await expect(changed).not.toHaveText('—')
  const before = await changed.textContent()
  const refresh = page.getByRole('button', { name: '刷新监控数据', exact: true })
  await expect(refresh).toBeEnabled(); await refresh.click()
  await expect(page.locator('.engine-resource__footer')).toContainText('资源采样 暂无样本')
  await expect(refresh).toBeEnabled(); await expect(changed).toHaveText(before!)
})

test('切到 B 不发送 A 的旧目录，切回 A 后项目技能仍使用原目录', async () => {
  await launch(); await open(); await address().fill(b.origin); await action().click()
  await expect(current()).toContainText(b.origin)
  expect((await saved()).remoteWorkspaceRoot).toBe('')
  await settings().getByRole('tab', { name: '代码图', exact: true }).click()
  await expect.poll(() => b.graphQueries.length).toBeGreaterThan(0)
  expect(b.graphQueries.every(query => query.root === null && !!query.sessionId)).toBe(true)
  expect(b.workspaceBinds).not.toContain(resourceWorkspace)
  await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
  await address().fill(a.origin); await action().click(); await expect(current()).toContainText(a.origin)
  expect((await saved()).remoteWorkspaceRoot).toBe(resourceWorkspace)
  const before = a.receipts.length
  await settings().getByRole('tab', { name: '技能', exact: true }).click()
  await expect.poll(() => a.receipts.slice(before).some(r => r.path === '/api/v1/skills' && r.query.path === resourceWorkspace)).toBe(true)
  await stillA()
})

for (const autoStart of [false, true]) {
  const phase = autoStart ? 'error' : 'idle'
  test('本机' + (autoStart ? '启动失败' : '已停止') + '时只保存启动偏好，不重启或重复报错', async () => {
    await launch('local', { autoStart, engineEntry: join(profile, 'no-runtime', 'main.js') })
    await expect.poll(live).toMatchObject({ phase, mode: 'embedded' })
    const before = await live()
    await open(); await advanced()
    await draft().getByRole('switch', { name: '启动应用时自动连接引擎' }).click()
    await expect(action()).toHaveText('应用设置'); await action().click()
    await expect.poll(async () => (await saved()).autoStartEngine).toBe(!autoStart)
    await expect(action()).toHaveText('启动引擎')
    await expect(draft().getByRole('alert')).toHaveCount(0)
    expect(await live()).toEqual(before)
  })
}

test('新用户从本机启动实际配套引擎，能访问模型并停止', async () => {
  const { copyFileSync, existsSync } = await import('node:fs')
  const built = resolve(root, '../ai-agent-engine/dist'), entry = join(profile, 'paired', 'main.mjs')
  expect(existsSync(join(built, 'main.js')), '先构建配套引擎').toBe(true)
  mkdirSync(join(dirname(entry), 'runtime'), { recursive: true })
  copyFileSync(join(built, 'runtime/build-manifest.json'), join(dirname(entry), 'runtime/build-manifest.json'))
  writeFileSync(entry, 'await import(' + JSON.stringify(pathToFileURL(join(built, 'main.js')).href) + ')\n')
  await launch('local', { autoStart: false, engineEntry: entry })
  await open(); await expect(action()).toHaveText('启动引擎'); await action().click()
  await expect.poll(live, { timeout: 90000 }).toMatchObject({ phase: 'ready', mode: 'embedded', runtimeSource: 'env' })
  const connected = await live()
  expect(connected.dataDir).toBe(join(profile, 'engine', 'state', 'agent.db'))
  expect(existsSync(connected.dataDir!)).toBe(true)
  await expect(current()).toContainText('已连接')
  const models = await page.evaluate(() => window.aether.engine.request({ method: 'GET', path: '/models' }))
  expect(models.ok).toBe(true)
  await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
  await expect(settings().getByRole('region', { name: '账号概览' })).toBeVisible()
  await expect(settings().getByText('服务访问凭据', { exact: true })).toHaveCount(0)
  await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
  await expect(action()).toHaveText('停止引擎'); await action().click()
  await expect.poll(live).toMatchObject({ phase: 'idle', pid: null })
  await expect(action()).toHaveText('启动引擎')
})

test('本机已停止时可预选版本，修改启动偏好也不会启动它', async () => {
  const { existsSync } = await import('node:fs')
  const { id, marker, runtimes } = await installSentinelRuntime()
  // Older imports can use their archive filename as the fallback name.
  const legacyId = 'runtime-' + 'e'.repeat(32), legacyFile = 'legacy-runtime-fixture.tgz'
  mkdirSync(join(runtimes, legacyId)); writeFileSync(join(runtimes, legacyId, 'runtime-info.json'), JSON.stringify({
    id: legacyId, version: '2.0.7', buildId: 'sha256:' + 'e'.repeat(64), fileName: legacyFile, importedAt: 1_650_000_000_000 }))
  await launch('local', { autoStart: false })
  await open(); await advanced()
  await draft().getByRole('switch', { name: '启动应用时自动连接引擎' }).click()
  const pick = draft().getByRole('button', { name: '选择已导入的本地引擎' })
  await pick.click()
  const choices = page.getByRole('menu', { name: '选择已导入的本地引擎', exact: true })
  await expect(choices).not.toContainText(legacyFile)
  await choices.getByRole('menuitem', { name: '2.0.7', exact: true }).click()
  await draft().locator('summary').filter({ hasText: /^版本信息$/ }).click(); await expect(draft().getByText(legacyFile, { exact: true })).toBeVisible()
  await draft().getByRole('button', { name: '删除此版本', exact: true }).click()
  const removal = page.getByRole('dialog', { name: '删除本地引擎包？', exact: true })
  await expect(removal).toBeVisible()
  expect(existsSync(join(runtimes, legacyId))).toBe(true)
  await removal.getByRole('button', { name: '删除引擎包', exact: true }).click()
  await expect.poll(() => existsSync(join(runtimes, legacyId))).toBe(false)
  await expect(pick).toHaveText('默认引擎')
  expect((await page.evaluate(() => window.aether.engine.getLocalRuntimes())).activeId).toBeNull()
  expect(existsSync(join(runtimes, id, 'runtime-info.json'))).toBe(true)
  await pick.click()
  await expect(choices.getByRole('menuitem', { name: '2.0.7', exact: true })).toHaveCount(0)
  await expect(choices.getByRole('menuitem', { name: '默认引擎', exact: true })).toBeVisible()
  await choices.getByRole('menuitem', { name: '2.0.9 · 本机选择验证包', exact: true }).click()
  await draft().getByRole('button', { name: '选用此版本', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getLocalRuntimes())).activeId).toBe(id)
  await expect(action()).toHaveText('应用设置'); await action().click()
  await expect.poll(async () => (await saved()).autoStartEngine).toBe(true)
  await expect(action()).toHaveText('启动引擎')
  expect(await live()).toMatchObject({ phase: 'idle', pid: null })
  expect(existsSync(marker)).toBe(false)
})
