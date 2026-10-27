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

/** gitignored 夹具不出现在 Ctrl+P，但仍可从资源管理器显式打开。 */
async function openFixtureFromExplorer(filePath: string): Promise<void> {
  if (!await page.locator('.explorer__tree').isVisible()) {
    await page.locator('.activity-bar button[title="资源管理器"]').click()
  }
  await expect(page.locator('.explorer__tree')).toBeVisible()
  const revealRow = async (paths: string[]): Promise<void> => {
    await expect.poll(async () => page.locator('.explorer__tree').evaluate((element, targetPaths) => {
      const row = [...element.querySelectorAll<HTMLElement>('.tree-row')].find(item => targetPaths.includes(item.dataset.path ?? ''))
      if (row) { row.scrollIntoView({ block: 'center' }); return true }
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
      element.scrollTop = Math.min(bottom, element.scrollTop + Math.max(1, element.clientHeight * 0.8))
      return false
    }, paths)).toBe(true)
  }
  await page.locator('.explorer__tree').evaluate(element => { element.scrollTop = 0 })
  const parentPath = FIXTURE_DIR.slice(0, FIXTURE_DIR.lastIndexOf(sep))
  // 单子目录链可以只显示末端目录；只有父目录有独立行时才需要先展开它。
  try {
    await expect.poll(async () => page.locator('.tree-row').evaluateAll((rows, path) =>
      rows.some(row => row.getAttribute('data-path') === path), parentPath), { timeout: 1500 }).toBe(true)
    await revealRow([parentPath])
    const parentRow = page.locator(`.tree-row[data-path="${parentPath.replace(/\\/g, '\\\\')}"]`)
    if (await parentRow.getAttribute('aria-expanded') !== 'true') await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-expanded', 'true')
  } catch {
    await page.locator('.explorer__tree').evaluate(element => { element.scrollTop = 0 })
  }
  await revealRow([FIXTURE_DIR])
  const fixtureRow = page.locator(`.tree-row[data-path="${FIXTURE_DIR.replace(/\\/g, '\\\\')}"]`)
  await expect(fixtureRow).toBeVisible()
  if (await fixtureRow.getAttribute('aria-expanded') !== 'true') await fixtureRow.click()
  await expect(fixtureRow).toHaveAttribute('aria-expanded', 'true')
  const fileRow = page.locator(`.tree-row[data-path="${filePath.replace(/\\/g, '\\\\')}"]`)
  await expect(fileRow).toBeVisible()
  // 后台目录刷新可能短暂替换虚拟行，让点击在新的稳定节点上重试。
  await fileRow.click({ timeout: 60_000 })
  await expect(page.locator('.is-focused-group .editor-tab.is-active')).toContainText(filePath.slice(filePath.lastIndexOf(sep) + 1))
}

test.beforeAll(async () => {
  if (!existsSync(join(APP_ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('缺少构建产物，请先执行 npm run build')
  }

  const userDataDir = prepareUserData()
  prepareFixtures()

  app = await electron.launch({
    args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${userDataDir}`],
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

test('快速打开索引跳过 gitignored 产物但保留有效点目录', async () => {
  const files = await page.evaluate(root => window.aether.fs.listAll(root), APP_ROOT)
  expect(files).toContain('.vscode/settings.json')
  expect(files.some(file => file.startsWith('.e2e-tmp/'))).toBe(false)
  expect(files.some(file => file.startsWith('node_modules/'))).toBe(false)
})

test('LSP 诊断：保存触发引擎诊断，问题面板可见且点击可跳转', async () => {
  await openFixtureFromExplorer(BROKEN_FILE)

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
  await openFixtureFromExplorer(UNSUPPORTED_FILE)
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
