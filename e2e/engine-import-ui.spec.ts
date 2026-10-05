/** 真机：本地引擎导入入口、原生选择取消/坏包失败、未保存设置保护与切换确认。
 * 只替换原生文件选择器；其余设置 UI、preload、IPC、目录读取和导入校验均走真实实现。
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const runtimeId = 'runtime-ui-confirm-fixture'
const buildId = `sha256:${'a'.repeat(64)}`
let fixture = ''
let profile = ''
let invalidArchive = ''
let app: ElectronApplication | undefined
let page: Page
const rendererErrors: string[] = []

function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) env[key] = value
  }
  return env
}

async function openSettings(): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible())) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Control+Shift+p')
    await page.locator('.palette__input').fill('设置')
    await page.keyboard.press('Enter')
  }
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.getByRole('tab', { name: '引擎管理', exact: true }).click()
}

async function selectArchive(filePath: string | null): Promise<void> {
  await app!.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: selectedPath === null, filePaths: selectedPath ? [selectedPath] : [] })
  }, filePath)
}

test.describe.serial('本地引擎导入设置', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'engine-import-ui-'))
    profile = join(fixture, 'profile')
    const runtimeRoot = join(profile, 'engine', 'runtimes', runtimeId)
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', autoStartEngine: false, preferredPort: 12477,
      lastFolder: '', lastSessionId: 'engine-import-settings-session'
    }))
    // Stored metadata makes the confirmation flow available without running an unvalidated fake engine.
    writeFileSync(join(runtimeRoot, 'runtime-info.json'), JSON.stringify({
      id: runtimeId, name: 'Fixture Engine', version: '2.0.0', buildId, fileName: 'fixture-engine-2.0.0.tgz', importedAt: 1_800_000_000_000
    }))
    invalidArchive = join(fixture, 'invalid-engine.tgz')
    writeFileSync(invalidArchive, 'this is not a gzip archive')
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: launchEnvironment() })
    page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await openSettings()
  })

  test.afterEach(() => expect(rendererErrors).toEqual([]))

  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('engine-import-ui-')) throw new Error('Unsafe engine import UI fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('本地内置显示导入入口、包版本及中文状态，远端模式隐藏入口', async () => {
    const importer = page.getByRole('button', { name: '导入引擎…', exact: true })
    await expect(importer).toBeVisible()
    await expect(importer).toBeEnabled()
    const selector = page.getByLabel('选择已导入的本地引擎')
    // The catalog starts on the bundled default when no active pointer exists;
    // choose the fixture explicitly before checking the package-configured name.
    await selector.click()
    await page.getByRole('menuitem', { name: '2.0.0 · Fixture Engine', exact: false }).click()
    await expect(selector).toContainText('2.0.0 · Fixture Engine')
    await expect(page.locator('.settings-view--engine .engine-status__kv-summary')).toContainText('未启动')
    const remote = page.locator('.sg__row').filter({ has: page.locator('.sg__row-label', { hasText: /^远端服务$/ }) })
    await remote.click()
    await expect(importer).toHaveCount(0)
    await page.locator('.sg__row').filter({ has: page.locator('.sg__row-label', { hasText: /^本地内置$/ }) }).click()
    await expect(importer).toBeEnabled()
  })

  test('版本选择展示包内名称与详情，统一下拉支持键盘切换', async () => {
    const selector = page.getByRole('button', { name: '选择已导入的本地引擎', exact: true })
    await expect(selector).toContainText('2.0.0 · Fixture Engine')
    const details = page.locator('details.engine-runtime__details')
    await expect(details).toBeVisible()
    await expect(details).not.toHaveAttribute('open', '')
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open', '')
    await expect(page.locator('.engine-runtime__meta')).toContainText('名称 Fixture Engine')
    await expect(page.locator('.engine-runtime__meta')).toContainText('文件 fixture-engine-2.0.0.tgz')

    // The shared Popover Select must be usable without a pointer.  Move from
    // the imported runtime to the bundled default, then restore the fixture
    // so later serial cases continue with the same catalog state.
    await selector.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(selector).toContainText('默认引擎')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)

    await selector.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(selector).toContainText('2.0.0 · Fixture Engine')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('设置页暴露 MCP、技能和知识库完整入口', async () => {
    for (const section of [
      { tab: 'MCP', marker: 'MCP 服务器' },
      { tab: '技能', marker: '导入技能' },
      { tab: '知识库', marker: '知识库' }
    ]) {
      await page.getByRole('tab', { name: section.tab, exact: true }).click()
      await expect(page.getByText(section.marker, { exact: true }).first()).toBeVisible()
    }
    await page.getByRole('tab', { name: '引擎管理', exact: true }).click()
  })

  test('取消原生文件选择保持引擎与已导入列表不变，不显示错误', async () => {
    const before = await page.evaluate(async () => ({
      snapshot: await window.aether.engine.getSnapshot(),
      catalog: await window.aether.engine.getLocalRuntimes()
    }))
    await selectArchive(null)
    await page.getByRole('button', { name: '导入引擎…', exact: true }).click()
    await expect(page.getByRole('button', { name: '导入引擎…', exact: true })).toBeEnabled()
    await expect(page.locator('.engine-runtime__progress')).toHaveCount(0)
    await expect(page.locator('.engine-runtime__error')).toHaveCount(0)
    const after = await page.evaluate(async () => ({
      snapshot: await window.aether.engine.getSnapshot(),
      catalog: await window.aether.engine.getLocalRuntimes()
    }))
    expect(after.catalog).toEqual(before.catalog)
    expect(after.snapshot).toEqual(before.snapshot)
  })

  test('不合法引擎包真实校验失败，当前引擎和目录指针不受影响', async () => {
    const before = await page.evaluate(() => window.aether.engine.getLocalRuntimes())
    await selectArchive(invalidArchive)
    await page.getByRole('button', { name: '导入引擎…', exact: true }).click()
    const error = page.locator('.engine-runtime__error[role="alert"]')
    await expect(error).toBeVisible()
    await expect(error).not.toHaveText('')
    await expect(page.getByRole('button', { name: '导入引擎…', exact: true })).toBeEnabled()
    const after = await page.evaluate(async () => ({
      snapshot: await window.aether.engine.getSnapshot(),
      catalog: await window.aether.engine.getLocalRuntimes()
    }))
    expect(after.catalog).toEqual(before)
    expect(after.snapshot.phase).toBe('idle')
    expect(existsSync(join(profile, 'engine', 'runtimes', 'active-runtime.json'))).toBe(false)
  })

  test('未保存设置阻止切换；确认取消不会重启或修改生效指针', async () => {
    const selector = page.getByRole('button', { name: '选择已导入的本地引擎', exact: true })
    await selector.click()
    await page.getByRole('menuitem', { name: '2.0.0 · Fixture Engine', exact: false }).click()
    await expect(page.locator('.engine-runtime__meta')).toContainText('版本 2.0.0')
    await expect(page.locator(`.engine-runtime__meta [title="${buildId}"]`)).toHaveAttribute('title', buildId)
    const useRuntime = page.getByRole('button', { name: '使用此引擎并重启', exact: true })
    await expect(useRuntime).toBeEnabled()
    const autoStart = page.getByRole('switch', { name: '启动应用时自动连接引擎', exact: true })
    await autoStart.click()
    await expect(useRuntime).toBeDisabled()
    await expect(page.locator('.engine-runtime__hint')).toContainText('有未保存的设置')
    await autoStart.click()
    await expect(useRuntime).toBeEnabled()
    await useRuntime.click()
    const confirmation = page.getByRole('dialog', { name: '切换本地引擎并重启？', exact: true })
    await expect(confirmation).toContainText('中断当前任务')
    await expect(confirmation).toContainText('保留会话记录和模型配置')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect((await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('idle')
    expect((await page.evaluate(() => window.aether.engine.getLocalRuntimes())).activeId).toBeNull()
    expect(existsSync(join(profile, 'engine', 'runtimes', 'active-runtime.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).lastSessionId).toBe('engine-import-settings-session')
  })

  test('可删除未启用的本地引擎版本', async () => {
    const beforeCancel = await page.evaluate(() => window.aether.engine.getLocalRuntimes())
    await page.getByRole('button', { name: '删除此版本', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '删除本地引擎？', exact: true })
    await expect(confirmation).toContainText('Fixture Engine')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect(await page.evaluate(() => window.aether.engine.getLocalRuntimes())).toEqual(beforeCancel)
    await expect(page.getByRole('button', { name: '删除此版本', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '删除此版本', exact: true }).click()
    const confirmed = page.getByRole('dialog', { name: '删除本地引擎？', exact: true })
    await expect(confirmed).toContainText('Fixture Engine')
    await confirmed.getByRole('button', { name: '删除引擎', exact: true }).click()
    await expect(page.getByLabel('选择已导入的本地引擎')).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getLocalRuntimes())).runtimes).toEqual([])
    expect(existsSync(join(profile, 'engine', 'runtimes', runtimeId))).toBe(false)
  })
})

/**
 * 可选的真实包验收：CI/开发机提供 AETHER_TEST_ENGINE_TGZ 时启用。
 * 使用独立 userData，导入的产物与开发者的引擎目录、默认设置完全隔离。
 */
test.describe.serial('真实本地引擎包导入与激活', () => {
  test.skip(!process.env.AETHER_TEST_ENGINE_TGZ, '未设置 AETHER_TEST_ENGINE_TGZ，跳过真实引擎包验收')
  let realFixture = ''
  let realApp: ElectronApplication | undefined
  let realPage: Page

  test.beforeAll(async () => {
    const archive = process.env.AETHER_TEST_ENGINE_TGZ
    if (!archive) return
    mkdirSync(fixtureRoot, { recursive: true })
    realFixture = mkdtempSync(join(fixtureRoot, 'engine-import-real-'))
    const workspace = join(realFixture, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(realFixture, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', autoStartEngine: false, preferredPort: 12479,
      lastFolder: workspace, lastSessionId: 'engine-import-real-session'
    }))
    const env = launchEnvironment()
    env.AETHER_TEST_ENGINE_TGZ = archive
    env.AETHER_GLOBAL_DIR = join(realFixture, 'global')
    env.WORKSPACE_ROOT = workspace
    env.MCP_CONFIG_PATH = join(realFixture, 'mcp.json')
    env.SKILLS_ROOT = join(realFixture, 'skills')
    env.ENABLE_LONG_TERM_MEMORY = 'false'
    realApp = await electron.launch({ args: ['.', `--user-data-dir=${realFixture}`], cwd: root, env })
    realPage = await realApp.firstWindow()
    await expect(realPage.locator('.workbench')).toBeVisible()
    if (!(await realPage.locator('.app-settings').isVisible())) {
      await realPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Control+Shift+p')
      await realPage.locator('.palette__input').fill('设置')
      await realPage.keyboard.press('Enter')
    }
    await expect(realPage.getByRole('tab', { name: '引擎管理', exact: true })).toBeVisible()
    await realPage.getByRole('tab', { name: '引擎管理', exact: true }).click()
    await expect(realPage.getByRole('button', { name: '导入引擎…', exact: true })).toBeVisible()
  })

  test.afterAll(async () => {
    await realApp?.close()
    if (!realFixture) return
    if (dirname(realFixture) !== fixtureRoot || !basename(realFixture).startsWith('engine-import-real-')) throw new Error('Unsafe real engine fixture cleanup')
    rmSync(realFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('导入用户提供的 tgz、确认激活后引擎就绪且指针持久化', async () => {
    const archive = process.env.AETHER_TEST_ENGINE_TGZ!
    await realApp!.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, archive)
    await realPage.getByRole('button', { name: '导入引擎…', exact: true }).click()
    await expect(realPage.getByRole('button', { name: '导入引擎…', exact: true })).toBeEnabled({ timeout: 120_000 })
    await expect(realPage.getByRole('status')).toContainText('已导入', { timeout: 10_000 })
    const selector = realPage.getByRole('button', { name: '选择已导入的本地引擎', exact: true })
    await selector.click()
    const importedOption = realPage.getByRole('menuitem').filter({ hasText: '2.0.0' }).first()
    await expect(importedOption).toBeVisible()
    await importedOption.click()
    await realPage.getByRole('button', { name: '使用此引擎并重启', exact: true }).click()
    const dialog = realPage.getByRole('dialog', { name: '切换本地引擎并重启？', exact: true })
    await dialog.getByRole('button', { name: '使用此引擎并重启', exact: true }).click()
    await expect.poll(async () => (await realPage.evaluate(() => window.aether.engine.getSnapshot())).phase, { timeout: 120_000 }).toBe('ready')
    const snapshot = await realPage.evaluate(() => window.aether.engine.getSnapshot())
    expect(snapshot.runtimeSource).toBe('imported')
    expect(snapshot.entryPath).toContain(join(realFixture, 'engine', 'runtimes'))
    const catalog = await realPage.evaluate(() => window.aether.engine.getLocalRuntimes())
    expect(catalog.activeId).toBeTruthy()
    expect(existsSync(join(realFixture, 'engine', 'runtimes', 'active-runtime.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(realFixture, 'engine', 'runtimes', 'active-runtime.json'), 'utf8')).id).toBe(catalog.activeId)
  })

  test('恢复默认引擎清除活动指针并重新要求确认', async () => {
    await realPage.getByRole('button', { name: '恢复默认引擎', exact: true }).click()
    const dialog = realPage.getByRole('dialog', { name: '切换本地引擎并重启？', exact: true })
    await expect(dialog).toContainText('保留会话记录和模型配置')
    await dialog.getByRole('button', { name: '恢复默认引擎并重启', exact: true }).click()
    await expect.poll(async () => (await realPage.evaluate(() => window.aether.engine.getLocalRuntimes())).activeId, { timeout: 30_000 }).toBeNull()
    expect(existsSync(join(realFixture, 'engine', 'runtimes', 'active-runtime.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(realFixture, 'engine', 'runtimes', 'active-runtime.json'), 'utf8')).id).toBeNull()
  })
})
