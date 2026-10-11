import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * 设置页真实窗口布局回归。
 *
 * 这条用例刻意把聊天面板固定在右侧，把设置正文压到 460–560px 的容器宽度。
 * 这里曾出现过两个很难靠 isVisible 发现的回归：行控件拿到 100% 宽度后仍与
 * 文本保持横排，导致长 URL/说明被挤成逐字竖排；记忆工具栏切成 column 后，
 * field__input 的 flex-basis 变成了 180px 高度。断言使用真实 Chromium 的矩形，
 * 并在三个窗口尺寸下重复，避免只在默认窗口看起来正常。
 */

const APP_ROOT = resolve(__dirname, '..')
const LAYOUT_KEY = 'aether.ide.layout'
const FIXTURE_PARENT = join(APP_ROOT, '.e2e-tmp')
const PORT = 12417

const LONG_MODEL = {
  id: 'settings-responsive-model',
  tenantId: 'default',
  provider: 'openai',
  modelId: 'settings-responsive-model',
  displayName: 'Settings responsive fixture model with a readable long name',
  apiKey: 'synthetic-settings-layout-key',
  baseUrl: 'https://gateway.example.com/v1/compatible/chat/completions/for-layout-fixture',
  isEnabled: true,
  capabilities: { contextWindow: 200000 },
  resolvedCapabilities: { contextWindow: 200000 },
  createdAt: Date.now(),
  updatedAt: Date.now()
}

function prepareFixture(): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true })
  const fixture = mkdtempSync(join(FIXTURE_PARENT, 'settings-responsive-'))
  writeFileSync(
    join(fixture, 'settings.json'),
    JSON.stringify({
      engineMode: 'embedded',
      preferredPort: PORT,
      autoStartEngine: true,
      lastFolder: APP_ROOT,
      thinkingMode: 'off',
      lastSessionId: 'settings-responsive-session'
    }),
    'utf8'
  )
  return fixture
}

async function openSettings(page: Page, section: string): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible())) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
  }
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.locator('.app-settings__nav-item', { hasText: section }).click()
  await expect(page.locator('.app-settings__nav-item[aria-selected="true"]')).toContainText(section)
}

async function setWindow(
  page: Page,
  app: ElectronApplication,
  width: number,
  height: number
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    },
    { width, height }
  )
  await page.waitForTimeout(220)
}

async function narrowSettingsBody(page: Page): Promise<number> {
  return page.evaluate(() => {
    const body = document.querySelector('.app-settings__body')
    if (!(body instanceof HTMLElement)) throw new Error('设置正文不存在')
    return body.getBoundingClientRect().width
  })
}

interface LayoutProbe {
  bodyWidth: number
  bodyOverflow: number
  row: { width: number; height: number }
  text: { width: number; height: number }
  control: { width: number; height: number }
}

async function probeRow(page: Page, selector: string, text: string): Promise<LayoutProbe> {
  return page
    .locator(selector)
    .filter({ hasText: text })
    .first()
    .evaluate((row) => {
      const body = document.querySelector('.app-settings__body')
      const textEl = row.querySelector('.sg__row-text')
      const control = row.querySelector('.sg__row-control')
      if (
        !(body instanceof HTMLElement) ||
        !(textEl instanceof HTMLElement) ||
        !(control instanceof HTMLElement)
      ) {
        throw new Error('设置行缺少正文、文字列或控件列')
      }
      const rect = (element: Element): { width: number; height: number } => {
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height }
      }
      return {
        bodyWidth: body.getBoundingClientRect().width,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        row: rect(row),
        text: rect(textEl),
        control: rect(control)
      }
    }) as Promise<LayoutProbe>
}

let app: ElectronApplication | undefined
let page: Page
let fixture = ''
let engineReady = false

test.describe.serial('设置页多尺寸布局验收', () => {
  test.beforeAll(async () => {
    fixture = prepareFixture()
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`],
      cwd: APP_ROOT,
      env: {
        ...process.env,
        AETHER_IDE_ENGINE_ENTRY: resolve(APP_ROOT, '..', 'ai-agent-engine', 'dist/main.js'),
        AUTH_ENABLED: 'false',
        AETHER_GLOBAL_DIR: join(fixture, 'global'),
        WORKSPACE_ROOT: join(fixture, 'workspace'),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
        SKILLS_ROOT: join(fixture, 'skills'),
        ENABLE_LONG_TERM_MEMORY: 'false'
      }
    })
    page = await app.firstWindow()
    // This is a renderer layout suite. The model fixture is opportunistic: a
    // missing sibling engine should skip only the long-model assertion, while
    // the memory and all-settings overflow checks remain useful offline.
    engineReady = await page
      .locator('.status-bar')
      .getByText('引擎：就绪', { exact: false })
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    // 让模型页真正渲染长文本行；不触发任何模型调用。
    if (engineReady) {
      const create = await page.evaluate(
        async (model) =>
          window.aether.engine.request({ method: 'POST', path: '/models', body: model }),
        LONG_MODEL
      )
      expect(create.ok, create.message).toBe(true)
    }

    // 右侧聊天面板只用于复现设置正文的窄容器，不改变设置功能。
    await page.evaluate(
      ([key, width]) => {
        const raw = localStorage.getItem(key)
        const next = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        next.chatPanelVisible = true
        next.chatPanelWidth = width
        localStorage.setItem(key, JSON.stringify(next))
      },
      [LAYOUT_KEY, 330] as const
    )
    await page.reload()
    await page.waitForSelector('.workbench')
    await setWindow(page, app, 940, 640)
  })

  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const resolved = resolve(fixture)
    if (
      dirname(resolved) !== resolve(FIXTURE_PARENT) ||
      !basename(resolved).startsWith('settings-responsive-')
    ) {
      throw new Error('Refusing cleanup outside settings responsive fixture')
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('模型和安全行在窄正文中保持可读，不出现纵向逐字或横向溢出', async () => {
    test.skip(!engineReady, '引擎不可用时跳过需要长模型与策略数据的布局夹具')
    await openSettings(page, '模型')
    await expect(
      page.locator('.settings-view--models .sg__row').filter({ hasText: LONG_MODEL.displayName })
    ).toBeVisible()
    const model = await probeRow(page, '.settings-view--models .sg__row', LONG_MODEL.displayName)
    expect(model.bodyWidth, '窄窗口应进入设置正文容器').toBeGreaterThan(460)
    expect(model.bodyWidth, '该回归必须落在窄正文断点').toBeLessThan(560)
    expect(model.bodyOverflow, '模型页不应出现横向溢出').toBeLessThanOrEqual(1)
    expect(model.text.width, '模型名称/URL文字列被控件挤没').toBeGreaterThan(120)
    expect(model.row.height, '模型长 URL 被逐字竖排撑高').toBeLessThan(220)

    await openSettings(page, '安全')
    const security = await probeRow(page, '.settings-view--security .sg__row', '安全模式')
    expect(security.bodyOverflow, '安全页不应出现横向溢出').toBeLessThanOrEqual(1)
    expect(security.text.width, '安全模式说明文字列被 radio 控件挤没').toBeGreaterThan(120)
    expect(security.row.height, '安全模式说明被逐字竖排撑高').toBeLessThan(180)
  })

  test('记忆工具栏控件在窄、中、宽窗口保持正常高度', async () => {
    await openSettings(page, '记忆')
    for (const size of [
      { width: 940, height: 640 },
      { width: 1280, height: 800 },
      { width: 1600, height: 1000 }
    ]) {
      await setWindow(page, app!, size.width, size.height)
      const metrics = await page
        .locator('.memory-settings__toolbar .field__input')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect()
            return { width: box.width, height: box.height }
          })
        )
      expect(metrics.length, `${size.width}px 下应有搜索框和类型筛选`).toBe(2)
      for (const [index, metric] of metrics.entries()) {
        expect(
          metric.width,
          `${size.width}px 第 ${index + 1} 个记忆筛选控件宽度异常`
        ).toBeGreaterThan(100)
        expect(
          metric.height,
          `${size.width}px 第 ${index + 1} 个记忆筛选控件被 flex-basis 撑高`
        ).toBeLessThan(60)
      }
    }
  })

  test('所有设置分区在窄、中、宽窗口都不横向溢出', async () => {
    const sections = [
      '个人账号',
      '引擎管理',
      '外观',
      '文本编辑器',
      '终端',
      '模型',
      '文件',
      '搜索',
      '键盘',
      '源代码管理',
      '工作台',
      '浏览器',
      '安全',
      '代码图',
      'MCP',
      '技能',
      '知识库',
      '记忆'
    ]
    for (const size of [
      { width: 940, height: 640 },
      { width: 1280, height: 800 },
      { width: 1600, height: 1000 }
    ]) {
      await setWindow(page, app!, size.width, size.height)
      for (const section of sections) {
        await openSettings(page, section)
        const metrics = await page.locator('.app-settings__body').evaluate((body) => {
          const bodyBox = body.getBoundingClientRect()
          const view = body.querySelector('.settings-view, .keybindings')
          const viewBox = view?.getBoundingClientRect()
          return {
            overflow: body.scrollWidth - body.clientWidth,
            viewLeft: viewBox?.left ?? bodyBox.left,
            viewRight: viewBox?.right ?? bodyBox.right,
            bodyLeft: bodyBox.left,
            bodyRight: bodyBox.right
          }
        })
        expect(
          metrics.overflow,
          `${size.width}px「${section}」设置正文横向溢出`
        ).toBeLessThanOrEqual(1)
        expect(
          metrics.viewLeft,
          `${size.width}px「${section}」内容越出左边界`
        ).toBeGreaterThanOrEqual(metrics.bodyLeft - 1)
        expect(
          metrics.viewRight,
          `${size.width}px「${section}」内容越出右边界`
        ).toBeLessThanOrEqual(metrics.bodyRight + 1)
      }
    }
  })
})
