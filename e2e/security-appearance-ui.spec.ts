/** Real Electron security/appearance settings: responsive themes, session-scoped
 * mode writes, local rule filtering, policy CRUD/rollback, real settings/graphics
 * IPC persistence, recovery reset, custom color drafts and interactive previews. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AppSettings } from '../src/shared/ipc'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { resourceModel, resourceTasks, resourceToken, resourceWorkspace } from './fixtures/resource-settings'
import { SecurityAppearanceFixture, defaultSecurityPolicies, initialSecurityPolicies, securityFailure } from './fixtures/security-appearance'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/security-appearance')
const fixture = new SecurityAppearanceFixture(), errors: string[] = []
let app: ElectronApplication | undefined, page: Page, profile = ''
const recovery = { reason: 'gpu-process-failed', at: '2026-11-12T00:00:00.000Z', exitCode: 17 }
const baseAppearance = { appearance: 'light', accent: 'blue', customAccentColor: '#4b95f1', graphicsMode: 'software', visualEffects: 'auto' } as const
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const security = () => settings().locator('.settings-view--security')
const appearance = () => settings().locator('.settings-view--appearance')
const rules = () => security().getByRole('list', { name: '安全策略规则', exact: true })
const rule = (name: string) => rules().getByRole('listitem', { name, exact: true })
const mode = (name: string) => security().getByRole('radiogroup', { name: '本会话安全模式', exact: true }).getByRole('radio', { name, exact: true })
const dialog = (name: string) => page.getByRole('dialog', { name, exact: true })
const writes = () => fixture.receipts.filter(item => item.method !== 'GET')
const policyReads = () => fixture.receipts.filter(item => item.path === '/api/v1/security/policies' && item.method === 'GET')
const saved = (): AppSettings => JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as AppSettings
const savedAppearance = () => {
  const { appearance: theme, accent, customAccentColor, graphicsMode, visualEffects } = saved()
  return { appearance: theme, accent, customAccentColor, graphicsMode, visualEffects }
}

async function windowSize(width = 1320, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height) }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function openSettings(section: '安全' | '外观', theme: 'light' | 'dark' = 'light', width = 1320): Promise<void> {
  await windowSize()
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(settings()).toBeVisible()
  await settings().getByRole('tab', { name: '外观', exact: true }).click()
  await appearance().getByRole('group', { name: '主题', exact: true }).getByRole('radio', { name: theme === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)
  await selectSection(section)
  await windowSize(width)
}
async function selectSection(section: '安全' | '外观'): Promise<void> {
  await settings().getByRole('tab', { name: section, exact: true }).click()
  if (section === '安全') {
    await expect(rules().getByRole('listitem')).toHaveCount(fixture.policies.length)
    await expect(mode('安全模式')).toBeEnabled()
  } else await expect(appearance().getByRole('region', { name: '控件预览', exact: true })).toBeVisible()
}
async function choose(container: Locator, label: string, option: string): Promise<void> {
  await container.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menu', { name: label, exact: true }).getByRole('menuitem', { name: option, exact: true }).click()
}
async function menu(container: Locator, label: string): Promise<Locator> {
  await container.getByRole('button', { name: label + ' 的更多操作', exact: true }).click()
  const target = dialog(label + ' 的操作'); await expect(target).toBeVisible(); return target
}
async function beginDelete(name: string): Promise<Locator> {
  await (await menu(rule(name), '规则 ' + name)).getByRole('button', { name: '删除规则', exact: true }).click()
  const target = dialog('删除规则'); await expect(target).toBeVisible(); return target
}
async function beginReset(): Promise<Locator> {
  await (await menu(security(), '策略规则')).getByRole('button', { name: '恢复默认规则', exact: true }).click()
  const target = dialog('恢复默认策略规则'); await expect(target).toBeVisible(); return target
}
async function escape(target: Locator): Promise<void> { await page.keyboard.press('Escape'); await expect(target).toBeHidden() }
async function noOverflow(container: Locator): Promise<void> {
  expect(await container.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const bounds = await container.boundingBox(); expect(bounds).not.toBeNull()
  for (const control of await container.locator('button, input, [role="radio"], [role="switch"]').all()) {
    if (!await control.isVisible()) continue
    const box = await control.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
  }
  // A nested detail dialog correctly makes its parent inert; geometry still
  // belongs to the surrounding settings window while that dialog is open.
  const outer = await page.getByRole('dialog', { name: '设置', exact: true, includeHidden: true }).boundingBox(), viewportWidth = await page.evaluate(() => innerWidth)
  expect(outer!.x).toBeGreaterThanOrEqual(0)
  expect(outer!.x + outer!.width).toBeLessThanOrEqual(viewportWidth + 1)
}
async function shot(name: string): Promise<void> {
  const path = test.info().outputPath(name + '.png'); await page.screenshot({ path, animations: 'disabled' })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); profile = mkdtempSync(join(fixtureRoot, 'profile-')); await fixture.start()
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: fixture.origin, remoteWorkspaceRoot: resourceWorkspace,
    autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: resourceModel, thinkingMode: 'off', ...baseAppearance }))
  writeFileSync(join(profile, 'graphics-recovery.json'), JSON.stringify({ version: 1, failure: recovery }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN',
    'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN', 'AETHER_ENABLE_GPU'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = resourceToken; env.AETHER_GLOBAL_DIR = join(profile, 'global')
  // The real override makes graphics assertions independent of the host GPU and
  // verifies that restart guidance and the active startup override can coexist.
  env.AETHER_ENABLE_GPU = '0'
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1320, 900); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})

test.beforeEach(async () => {
  fixture.reset()
  const key = `aether.work.state.v1:${encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: fixture.origin }))}`
  await page.evaluate(async ({ key, tasks, model, workspace, appearance }) => {
    window.dispatchEvent(new Event('blur'))
    await window.aether.settings.update(appearance)
    for (const entry of Object.keys(localStorage)) if (entry.startsWith('aether:security-mode')) localStorage.removeItem(entry)
    localStorage.setItem(key, JSON.stringify({ tasks: tasks.map(task => ({ ...task, status: 'done', draft: '', mentions: [],
      createdAt: Date.now(), updatedAt: Date.now(), modelId: model, attachments: [], sources: [] })), activeTaskId: tasks[0].id, homeDraft: '', homeWorkspacePath: workspace }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 60 }))
  }, { key, tasks: resourceTasks, model: resourceModel, workspace: resourceWorkspace, appearance: baseAppearance })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('.work-task-heading h1')).toHaveText(resourceTasks[0].title)
  await expect(page.locator('.work-view')).toContainText('RESOURCE_SETTINGS_READY')
  await expect.poll(savedAppearance).toEqual(baseAppearance)
})

test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await shot('security-appearance-final')
  await info.attach('security-http-receipts', { body: JSON.stringify(fixture.receipts, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(fixture.errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    await fixture.close()
    if (profile) {
      const target = resolve(profile)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe fixture cleanup: ' + target)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const theme of ['light', 'dark'] as const) for (const width of [1320, 760, 520]) {
  test(`${theme} / ${width}：安全与外观布局清晰，长规则和控件不横向溢出`, async () => {
    await openSettings('外观', theme, width)
    for (const name of ['主题', '图形加速', '视觉效果']) await expect(appearance().getByRole('group', { name, exact: true })).toBeVisible()
    await expect(appearance().getByRole('radiogroup', { name: '强调色', exact: true }).getByRole('radio')).toHaveCount(7)
    await expect(appearance().locator('.appearance-render-status')).toContainText('软件渲染')
    await noOverflow(appearance()); await shot(`appearance-${theme}-${width}`)
    await selectSection('安全')
    await expect(mode('安全模式')).toBeChecked()
    expect(await rules().getByRole('listitem').evaluateAll(items => items.map(item => item.getAttribute('aria-label')))).toEqual(['只读检查', '限制外部脚本', '删除构建产物'])
    await expect(rule('限制外部脚本').getByRole('switch', { name: '限制外部脚本 启用', exact: true })).not.toBeChecked()
    await noOverflow(security()); await shot(`security-${theme}-${width}`)
    expect(writes()).toEqual([])
  })
}

test('安全模式点击与键盘切换写入当前会话，另一会话保持独立', async () => {
  await openSettings('安全')
  await mode('标准模式').click(); await expect(mode('标准模式')).toBeChecked()
  expect(writes().at(-1)).toEqual({ method: 'PUT', path: '/api/v1/security/mode', query: {}, body: { sessionId: resourceTasks[0].id, mode: 'standard' } })
  await mode('标准模式').focus(); await page.keyboard.press('End'); await expect(mode('完全访问')).toBeChecked()
  await expect(mode('完全访问')).toBeFocused()
  expect(fixture.modes).toEqual({ [resourceTasks[0].id]: 'full-access', [resourceTasks[1].id]: 'standard' })
  await mode('完全访问').focus(); await page.keyboard.press('Home'); await expect(mode('安全模式')).toBeChecked()
  await expect(mode('安全模式')).toBeFocused()
  await mode('安全模式').focus(); await page.keyboard.press('ArrowRight'); await expect(mode('标准模式')).toBeChecked()
  await expect(mode('标准模式')).toBeFocused()
  await escape(settings())
  // Reopening during the exit animation must cancel dismissal instead of
  // dropping the user's request while the old dialog is still mounted.
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(settings()).toBeVisible()
  await selectSection('安全'); await expect(mode('标准模式')).toBeChecked()
  await escape(settings())
  await page.locator(`.work-sidebar__task-row[data-task-id="${resourceTasks[1].id}"] .work-sidebar__task`).click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(resourceTasks[1].title)
  await openSettings('安全'); await expect(mode('标准模式')).toBeChecked()
  await mode('完全访问').click(); await expect(mode('完全访问')).toBeChecked()
  expect(writes().at(-1)?.body).toEqual({ sessionId: resourceTasks[1].id, mode: 'full-access' })
  expect(fixture.modes).toEqual({ [resourceTasks[0].id]: 'standard', [resourceTasks[1].id]: 'full-access' })
  expect(writes().map(item => item.body)).toEqual([
    { sessionId: resourceTasks[0].id, mode: 'standard' }, { sessionId: resourceTasks[0].id, mode: 'full-access' },
    { sessionId: resourceTasks[0].id, mode: 'safe' }, { sessionId: resourceTasks[0].id, mode: 'standard' },
    { sessionId: resourceTasks[1].id, mode: 'full-access' }
  ])
})

test('安全模式请求失败如实显示未知状态，重新读取恢复服务端模式', async () => {
  await openSettings('安全'); fixture.failNext = 'mode'
  await mode('完全访问').click()
  await expect(security().getByRole('alert')).toContainText(securityFailure)
  await expect(security().getByRole('radiogroup', { name: '本会话安全模式', exact: true }).getByRole('radio', { checked: true })).toHaveCount(0)
  expect(fixture.modes[resourceTasks[0].id]).toBe('safe')
  await security().getByRole('button', { name: '重新读取安全模式', exact: true }).click()
  await expect(mode('安全模式')).toBeChecked(); await expect(security().getByRole('alert')).toHaveCount(0)
  expect(writes()).toHaveLength(1)
})

test('规则搜索和动作筛选仅在本地完成，详情显示完整表达式并可键盘关闭', async () => {
  await openSettings('安全', 'dark', 520)
  const reads = policyReads().length, search = security().getByRole('searchbox', { name: '搜索策略规则', exact: true })
  await search.fill('GIT'); await expect(rules().getByRole('listitem')).toHaveCount(1); await expect(rule('只读检查')).toBeVisible()
  await search.fill('避免误删'); await expect(rules().getByRole('listitem')).toHaveCount(1); await expect(rule('删除构建产物')).toBeVisible()
  await search.fill(''); await choose(security(), '筛选规则动作', '拒绝')
  await expect(rules().getByRole('listitem')).toHaveCount(1); await expect(rule('限制外部脚本')).toBeVisible()
  await search.fill('不存在的规则'); await expect(rules()).toContainText('没有匹配的规则')
  await search.fill(''); await choose(security(), '筛选规则动作', '全部动作')
  await rule('删除构建产物').getByRole('button', { name: '查看规则：删除构建产物', exact: true }).click()
  const detail = dialog('规则详情')
  await expect(detail).toContainText(initialSecurityPolicies[0].argPattern!)
  await expect(detail).toContainText('所有会话')
  await expect(detail.getByRole('button', { name: '完成', exact: true })).toBeInViewport({ ratio: 1 })
  await noOverflow(detail); await shot('security-rule-detail-520'); await escape(detail)
  await expect(settings()).toBeVisible()
  expect(policyReads()).toHaveLength(reads); expect(writes()).toEqual([])
})

test('策略动作和启停只写对应字段，失败回滚并保留错误', async () => {
  await openSettings('安全')
  await choose(security(), '筛选规则动作', '放行')
  await expect(rules().getByRole('listitem')).toHaveCount(1)
  await choose(rule('只读检查'), '只读检查 的动作', '询问')
  await expect.poll(() => fixture.policies.find(item => item.id === 101)?.action).toBe('ask')
  await expect(rule('只读检查')).toHaveCount(0)
  await expect(security().getByRole('searchbox', { name: '搜索策略规则', exact: true })).toBeFocused()
  expect(writes()).toEqual([{ method: 'PUT', path: '/api/v1/security/policies/101', query: {}, body: { action: 'ask' } }])
  await choose(security(), '筛选规则动作', '全部动作')
  await expect(rule('只读检查').getByRole('button', { name: '只读检查 的动作', exact: true })).toContainText('询问')
  expect(writes().at(-1)).toEqual({ method: 'PUT', path: '/api/v1/security/policies/101', query: {}, body: { action: 'ask' } })
  await rule('只读检查').getByRole('switch', { name: '只读检查 启用', exact: true }).click()
  await expect.poll(() => fixture.policies.find(item => item.id === 101)?.enabled).toBe(false)
  expect(writes().at(-1)?.body).toEqual({ enabled: false })
  fixture.failNext = 'policy'
  await choose(rule('只读检查'), '只读检查 的动作', '拒绝')
  await expect(security().getByRole('alert')).toContainText(securityFailure)
  await expect(rule('只读检查').getByRole('button', { name: '只读检查 的动作', exact: true })).toContainText('询问')
  expect(fixture.policies.find(item => item.id === 101)?.action).toBe('ask')
  fixture.failNext = 'policy'
  await rule('只读检查').getByRole('switch', { name: '只读检查 启用', exact: true }).click()
  await expect(rule('只读检查').getByRole('switch', { name: '只读检查 启用', exact: true })).not.toBeChecked()
  await expect(security().getByRole('alert')).toContainText(securityFailure)
  expect(fixture.policies.find(item => item.id === 101)?.enabled).toBe(false)
  expect(fixture.policies.filter(item => item.id !== 101)).toEqual(initialSecurityPolicies.filter(item => item.id !== 101))
  expect(writes().map(item => item.body)).toEqual([{ action: 'ask' }, { enabled: false }, { action: 'deny' }, { enabled: true }])
})

test('删除规则取消不写入，失败保留规则，确认成功才删除对应规则', async () => {
  await openSettings('安全', 'dark', 760)
  let confirmation = await beginDelete('限制外部脚本')
  await expect(confirmation).toContainText('限制外部脚本')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).toBeHidden(); expect(writes()).toEqual([])
  fixture.failNext = 'delete'; confirmation = await beginDelete('限制外部脚本')
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
  await expect(security().getByRole('alert')).toContainText(securityFailure)
  await expect(rule('限制外部脚本')).toBeVisible(); expect(fixture.policies).toEqual(initialSecurityPolicies)
  confirmation = await beginDelete('限制外部脚本')
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
  await expect(rule('限制外部脚本')).toHaveCount(0)
  expect(fixture.policies).toEqual(initialSecurityPolicies.filter(item => item.id !== 103))
  expect(writes()).toEqual([1, 2].map(() => ({ method: 'DELETE', path: '/api/v1/security/policies/103', query: {}, body: {} })))
})

test('恢复默认规则支持取消与错误重试，成功后重新读取默认规则', async () => {
  await openSettings('安全')
  let confirmation = await beginReset(); await escape(confirmation)
  expect(writes()).toEqual([]); expect(fixture.policies).toEqual(initialSecurityPolicies)
  fixture.failNext = 'reset'; confirmation = await beginReset()
  await confirmation.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(security().getByRole('alert')).toContainText(securityFailure)
  await expect(rules().getByRole('listitem')).toHaveCount(3); expect(fixture.policies).toEqual(initialSecurityPolicies)
  confirmation = await beginReset(); await confirmation.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(rule('默认命令保护')).toBeVisible(); await expect(rules().getByRole('listitem')).toHaveCount(1)
  expect(fixture.policies).toEqual(defaultSecurityPolicies)
  expect(writes()).toEqual([1, 2].map(() => ({ method: 'POST', path: '/api/v1/security/policies/reset', query: {}, body: {} })))
  await expect(security().getByRole('alert')).toHaveCount(0)
})

test('图形配置真实持久化，当前渲染、重启提示和启动配置说明同时准确', async () => {
  await openSettings('外观')
  const graphics = appearance().getByRole('group', { name: '图形加速', exact: true })
  const initial = await page.evaluate(() => window.aether.graphics.getSnapshot())
  expect(initial).toMatchObject({ configuredMode: 'software', bootMode: 'software', hardwareAcceleration: false, environmentOverride: true, restartRequired: false })
  await graphics.getByRole('radio', { name: '启用', exact: true }).click()
  await expect.poll(() => saved().graphicsMode).toBe('enabled')
  await expect(graphics).toContainText('重启应用后生效')
  await expect(appearance().locator('.appearance-render-status')).toContainText('软件渲染')
  await expect(appearance().getByRole('region', { name: '图形与视觉效果', exact: true })).toContainText('当前渲染由启动配置指定')
  expect(await page.evaluate(() => window.aether.graphics.getSnapshot())).toMatchObject({ configuredMode: 'enabled', bootMode: 'software', hardwareAcceleration: false, environmentOverride: true, restartRequired: true })
  await shot('appearance-restart-and-override')
  await page.reload(); await openSettings('外观')
  await expect(graphics.getByRole('radio', { name: '启用', exact: true })).toBeChecked()
  await expect(graphics).toContainText('重启应用后生效')
  await graphics.getByRole('radio', { name: '软件渲染', exact: true }).click()
  await expect.poll(() => saved().graphicsMode).toBe('software')
  await expect(graphics).not.toContainText('重启应用后生效')
  expect((await page.evaluate(() => window.aether.graphics.getSnapshot())).restartRequired).toBe(false)
})

test('视觉效果保存用户选择，软件渲染实际保持实色并兼容明暗与强调色', async () => {
  await openSettings('外观')
  const effects = appearance().getByRole('group', { name: '视觉效果', exact: true })
  for (const [label, value] of [['完整', 'full'], ['精简', 'reduced'], ['实色', 'solid'], ['自动', 'auto']] as const) {
    await effects.getByRole('radio', { name: label, exact: true }).click()
    await expect.poll(() => saved().visualEffects).toBe(value)
    await expect(effects.getByRole('radio', { name: label, exact: true })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-visual-effects', 'solid')
  }
  await appearance().getByRole('group', { name: '主题', exact: true }).getByRole('radio', { name: '深色', exact: true }).click()
  await appearance().getByRole('radiogroup', { name: '强调色', exact: true }).getByRole('radio', { name: '紫色', exact: true }).click()
  await expect.poll(savedAppearance).toEqual({ ...baseAppearance, appearance: 'dark', accent: 'purple' })
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple')
  await expect(page.locator('html')).toHaveAttribute('data-visual-effects', 'solid')
  await page.reload(); await openSettings('外观', 'dark')
  await expect(appearance().getByRole('radiogroup', { name: '强调色', exact: true }).getByRole('radio', { name: '紫色', exact: true })).toBeChecked()
  await expect(effects.getByRole('radio', { name: '自动', exact: true })).toBeChecked()
})

test('控件预览可点击、切换与重置，只改变局部状态', async () => {
  await openSettings('外观', 'dark', 520)
  const preview = appearance().getByRole('region', { name: '控件预览', exact: true }), before = savedAppearance()
  const button = preview.getByRole('button', { name: '体验主要按钮', exact: true }), toggle = preview.getByRole('switch', { name: '预览开关', exact: true })
  await button.click(); await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(preview.getByRole('status')).toHaveText('已选择主要按钮')
  await toggle.click(); await expect(toggle).not.toBeChecked()
  await expect(preview.getByRole('status')).toHaveText('预览开关已关闭')
  await shot('appearance-interactive-preview-520')
  await preview.getByRole('button', { name: '重置预览', exact: true }).click()
  await expect(button).toHaveAttribute('aria-pressed', 'false'); await expect(toggle).toBeChecked()
  await expect(preview.getByRole('status')).toHaveText('已重置预览')
  expect(savedAppearance()).toEqual(before); expect(writes()).toEqual([])
})

test('自定义强调色支持预览取消、无效值反馈和保存，切换主题仍保持已保存颜色', async () => {
  await openSettings('外观', 'light', 760)
  const custom = appearance().getByRole('radio', { name: '自定义颜色', exact: true }), picker = dialog('自定义强调色')
  await custom.click()
  await picker.getByRole('textbox', { name: '自定义强调色色值', exact: true }).fill('#c24f8a')
  await picker.getByRole('textbox', { name: '自定义强调色色值', exact: true }).press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#c24f8a')
  expect(savedAppearance()).toEqual(baseAppearance)
  await escape(picker)
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue')
  expect(savedAppearance()).toEqual(baseAppearance)
  await custom.click()
  const hex = picker.getByRole('textbox', { name: '自定义强调色色值', exact: true })
  await hex.fill('#invalid'); await hex.press('Enter')
  await expect(picker.getByRole('alert')).toContainText('有效的 HEX')
  await expect(picker.getByRole('button', { name: '完成颜色选择', exact: true })).toBeDisabled()
  await hex.fill('#c24f8a'); await hex.press('Enter')
  await picker.getByRole('button', { name: '完成颜色选择', exact: true }).click()
  await expect(picker).toBeHidden()
  await expect.poll(savedAppearance).toEqual({ ...baseAppearance, accent: 'custom', customAccentColor: '#c24f8a' })
  await expect(appearance().getByRole('button', { name: '编辑自定义强调色', exact: true })).toContainText('#C24F8A')
  await appearance().getByRole('group', { name: '主题', exact: true }).getByRole('radio', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
  await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#c24f8a')
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
  await appearance().getByRole('button', { name: '编辑自定义强调色', exact: true }).click()
  await picker.getByRole('textbox', { name: '自定义强调色色值', exact: true }).fill('#176954')
  await picker.getByRole('textbox', { name: '自定义强调色色值', exact: true }).press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#176954')
  await escape(picker)
  await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#c24f8a')
  await expect.poll(savedAppearance).toEqual({ ...baseAppearance, appearance: 'dark', accent: 'custom', customAccentColor: '#c24f8a' })
})

test('清除图形回退经真实 IPC 落盘，提示成功且不改变已保存渲染配置', async () => {
  await openSettings('外观')
  const group = appearance().getByRole('group', { name: '图形回退', exact: true })
  await expect(group).toContainText('检测到图形启动异常')
  expect((await page.evaluate(() => window.aether.graphics.getSnapshot())).recovery).toEqual(recovery)
  const before = savedAppearance()
  await group.getByRole('button', { name: '清除图形回退记录', exact: true }).click()
  await expect(group).toHaveCount(0)
  await expect(appearance().getByRole('status').filter({ hasText: '已清除回退记录' })).toContainText('图形加速设置将在下次启动时应用')
  await expect.poll(() => JSON.parse(readFileSync(join(profile, 'graphics-recovery.json'), 'utf8'))).toEqual({ version: 1 })
  expect((await page.evaluate(() => window.aether.graphics.getSnapshot())).recovery).toBeNull()
  expect(savedAppearance()).toEqual(before)
})
