import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * LSP 诊断链路（真机）：保存文件触发引擎诊断 → 问题面板 → 点击跳转。
 *
 * 诊断经 POST /lsp/diagnose（TS adapter 传 content 即可，无需落盘文件），
 * 结果进「问题」面板并叠加 Monaco 波浪线。本文件验证诊断链路端到端可用。
 *
 * 本文件覆盖：引擎就绪、诊断产出与问题面板渲染、点击问题跳回编辑器。
 * 终端只保留本地轨（node-pty 跑在 IDE 主进程，不依赖引擎），
 * 已由 smoke.spec 覆盖，此处不再重复。
 *
 * 前置：先执行 npm run build（测试加载的是 out/ 产物，与生产一致）
 */

const APP_ROOT = resolve(__dirname, '..')
/** 作为工作区打开的目录：用项目自身 */
const WORKSPACE_DIR = APP_ROOT

/** 诊断用例夹具：内容确定，必然产生一个 TS2322（类型不匹配） */
const FIXTURE_DIR = join(APP_ROOT, '.e2e-tmp', 'lsp-diagnostics')
const BROKEN_FILE = join(FIXTURE_DIR, 'diagnostic-broken.ts')
const UNSUPPORTED_FILE = join(FIXTURE_DIR, 'diagnostic-unsupported.aetherunknown')
const BROKEN_SOURCE = "const brokenValue: number = 'not-a-number'\n"

function prepareFixtures(): void {
  if (!resolve(FIXTURE_DIR).startsWith(resolve(APP_ROOT, '.e2e-tmp') + sep)) throw new Error('Unsafe fixture directory')
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(BROKEN_FILE, BROKEN_SOURCE, 'utf-8')
  writeFileSync(UNSUPPORTED_FILE, 'plain fixture', 'utf-8')
}

function prepareUserData(): string {
  const dir = join(tmpdir(), 'aether-ide-e2e-userdata-lsp')
  if (resolve(dir) !== resolve(tmpdir(), 'aether-ide-e2e-userdata-lsp')) throw new Error('Unsafe userData fixture')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  // 独立端口：避免与开发机常驻实例或 smoke.spec 的实例（12399）互相复用引擎
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        engineMode: 'embedded',
        preferredPort: 12401,
        remoteBaseUrl: '',
        autoStartEngine: true,
        lastSessionId: '',
        lastAgentId: '',
        lastModelId: '',
        lastFolder: WORKSPACE_DIR
      },
      null,
      2
    ),
    'utf-8'
  )
  return dir
}

let app: ElectronApplication
let page: Page
/** 收集渲染进程的错误，供用例结束时断言 */
const consoleErrors: string[] = []

test.beforeAll(async () => {
  if (!existsSync(join(APP_ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('缺少构建产物，请先执行 npm run build')
  }

  const userDataDir = prepareUserData()
  prepareFixtures()

  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(APP_ROOT, '../ai-agent-engine/dist/main.js'),
      AETHER_GLOBAL_DIR: join(userDataDir, 'global'), WORKSPACE_ROOT: join(userDataDir, 'sandboxes'),
      MCP_CONFIG_PATH: join(userDataDir, 'mcp.json'), SKILLS_ROOT: join(userDataDir, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' }
  })

  page = await app.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error))
  })

  await page.waitForSelector('.workbench')
})

test.afterAll(async () => {
  await app?.close()
  // 夹具是测试自己造的，收尾删掉，避免污染仓库
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

test('引擎：自动启动并进入就绪状态', async () => {
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})

test('LSP 诊断：保存触发引擎诊断，问题面板可见且点击可跳转', async () => {
  // 快速打开夹具文件（应用启动前已落盘）。
  // 注意 Ctrl+P 的首帧可能早于文件索引构建完成：此时面板会显示
  // 「没有匹配的文件。」，回车自然什么都不会打开。所以必须先等索引就绪 ——
  // 用「填入关键字后目标条目出现」作为信号，而不是盲等固定时长。
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(palette).toBeVisible()
  await page.locator('.palette__input').fill('diagnostic-broken')
  await expect(palette.locator('.palette__item').first()).toContainText('diagnostic-broken.ts', {
    timeout: 30_000
  })
  await page.keyboard.press('Enter')

  await expect(page.locator('.editor-tab', { hasText: 'diagnostic-broken.ts' })).toBeVisible()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 })

  // Ctrl+S 只保存脏文档：在文末追加注释制造确定可观测的改动（不能只按 Enter——
  // 夹具末尾本就有换行，尾部换行会被规范化掉，导致文档不脏、保存与诊断都不触发）
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' // touched')
  await expect(page.locator('.doc-view__dirty')).toBeVisible()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.doc-view__dirty')).toBeHidden()

  // 打开底部面板（初始隐藏），再切到问题标签，等引擎诊断到达（tsc 启动可能较慢）
  await page.keyboard.press('Control+`')
  await expect(page.locator('.panel')).toBeVisible()
  await page.locator('.panel__tab', { hasText: '问题' }).click()
  await expect(page.locator('.problems-view')).toBeVisible()
  await expect(page.locator('.problems-view__file')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.problems-view__file')).toContainText('diagnostic-broken.ts', {
    timeout: 60_000
  })
  // Project tsserver codes are numeric; the former single-file tsc prefixed them with TS.
  await expect(page.locator('.problems-view__item', { hasText: /(?:TS)?2322/ }).first()).toBeVisible()
  await expect(page.locator('.problems-view__item', {
    hasText: /不能将类型“string”分配给类型“number”|Type 'string' is not assignable to type 'number'/
  })).toHaveCount(1)

  // 点击问题条目：文件标签激活 + 跳行高亮生效（与搜索跳转同一机制）
  await page.locator('.problems-view__item', { hasText: /(?:TS)?2322/ }).first().click()
  await expect(page.locator('.editor-tab.is-active')).toContainText('diagnostic-broken.ts')
  await expect(page.locator('.aether-reveal-match').first()).toBeVisible({ timeout: 15_000 })
})

test('不支持的文件不会被显示为诊断通过，关闭后清除状态', async () => {
  await page.keyboard.press('Control+p')
  const palette = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(palette).toBeVisible()
  await page.locator('.palette__input').fill('diagnostic-unsupported')
  await expect(palette.locator('.palette__item').first()).toContainText('diagnostic-unsupported.aetherunknown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active')).toContainText('diagnostic-unsupported.aetherunknown')
  await expect(palette).toBeHidden()
  await page.keyboard.press('Control+Shift+p')
  await page.getByRole('textbox', { name: '过滤命令', exact: true }).fill('诊断当前文件')
  await page.locator('.palette__item', { hasText: '诊断当前文件' }).click()
  // Project tsserver may finish before the previous file's engine diagnostics.
  // Each file owns its status; another in-flight diagnosis must not match this assertion.
  const unsupportedStatus = page.locator('.problems-view [role="status"]', {
    hasText: 'diagnostic-unsupported.aetherunknown'
  })
  await expect(unsupportedStatus).toContainText('不支持诊断')
  await page.keyboard.press('Control+w')
  await expect(unsupportedStatus).toHaveCount(0)
})

test('渲染进程无未捕获错误', async () => {
  expect(consoleErrors, `渲染进程错误：\n${consoleErrors.join('\n')}`).toEqual([])
})
