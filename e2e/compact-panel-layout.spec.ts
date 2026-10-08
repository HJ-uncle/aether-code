import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 真机窄窗口回归：
 * - 文件/搜索排除规则的文本框、开关、删除按钮保持同一行且垂直居中；
 * - 排除规则的新增、切换、删除仍然写入 settings.json；
 * - 终端只有一个会话时，标签栏不会占满整个面板高度，正文获得主要空间。
 *
 * 这些断言必须在 Chromium 中运行：CSS 容器查询和 flex 的最终几何无法由
 * jsdom 计算。PTY 不可用时仍验证产品把失败原因如实呈现给用户。
 */

const APP_ROOT = resolve(__dirname, '..')
const USER_DATA_DIR = join(tmpdir(), 'aether-ide-e2e-compact-panel-userdata')

function prepareUserData(): void {
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
  mkdirSync(USER_DATA_DIR, { recursive: true })
  writeFileSync(
    join(USER_DATA_DIR, 'settings.json'),
    JSON.stringify(
      {
        engineMode: 'embedded',
        preferredPort: 12407,
        remoteBaseUrl: '',
        autoStartEngine: false,
        lastSessionId: '',
        lastAgentId: '',
        lastModelId: '',
        subagentModelId: '',
        utilityModelId: '',
        thinkingMode: 'high',
        lastFolder: APP_ROOT,
        appearance: 'system',
        accent: 'blue',
        filesExclude: {
          '**/.git': true,
          '**/.svn': true,
          '**/.hg': true,
          '**/.jj': true,
          '**/.DS_Store': true,
          '**/Thumbs.db': true
        },
        searchExclude: {
          '**/node_modules': true,
          '**/bower_components': true,
          '**/*.code-search': true
        }
      },
      null,
      2
    ),
    'utf-8'
  )
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.keyboard.press('Control+Shift+p')
  const palette = page.locator('.palette')
  await expect(palette).toBeVisible()
  await palette.locator('.palette__input').fill('设置')
  await page.keyboard.press('Enter')
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.locator('.app-settings__nav-item', { hasText: section }).click()
  await expect(page.locator(`.app-settings__nav-item[aria-selected="true"]`)).toContainText(section)
}

interface RowGeometry {
  row: { top: number; bottom: number; height: number }
  input: { top: number; bottom: number; width: number }
  control: { top: number; bottom: number; width: number }
  remove: { top: number; bottom: number; width: number }
}

async function inspectExcludeRows(page: Page, rootClass: string): Promise<RowGeometry[]> {
  return page.locator(`${rootClass} .sg__row`).evaluateAll((rows) => {
    const rect = (
      element: Element
    ): { top: number; bottom: number; width: number; height?: number } => {
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, width: box.width, height: box.height }
    }
    return rows.map((row) => {
      const input = row.querySelector('.exclude-row__pattern')
      const control = row.querySelector('.sg__row-control')
      const remove = row.querySelector('.exclude-row__remove')
      if (
        !(input instanceof HTMLElement) ||
        !(control instanceof HTMLElement) ||
        !(remove instanceof HTMLElement)
      ) {
        throw new Error('排除规则行缺少输入框、控件槽或删除按钮')
      }
      return {
        row: rect(row),
        input: rect(input),
        control: rect(control),
        remove: rect(remove)
      }
    })
  }) as Promise<RowGeometry[]>
}

function expectSingleLineRows(rows: RowGeometry[], context: string): void {
  expect(rows.length, `${context}：至少应显示一条规则`).toBeGreaterThan(0)
  for (const [index, row] of rows.entries()) {
    const rowCenter = (row.row.top + row.row.bottom) / 2
    const inputCenter = (row.input.top + row.input.bottom) / 2
    const controlCenter = (row.control.top + row.control.bottom) / 2
    const removeCenter = (row.remove.top + row.remove.bottom) / 2
    expect(
      Math.abs(inputCenter - controlCenter),
      `${context} 第 ${index + 1} 行：输入框与开关掉行`
    ).toBeLessThanOrEqual(3)
    expect(
      Math.abs(controlCenter - removeCenter),
      `${context} 第 ${index + 1} 行：开关与删除按钮掉行`
    ).toBeLessThanOrEqual(3)
    expect(
      Math.abs(rowCenter - inputCenter),
      `${context} 第 ${index + 1} 行：控件未垂直居中`
    ).toBeLessThanOrEqual(8)
    expect(row.input.width, `${context} 第 ${index + 1} 行：输入框没有可用宽度`).toBeGreaterThan(
      100
    )
    expect(row.control.width, `${context} 第 ${index + 1} 行：控件槽没有可用宽度`).toBeGreaterThan(
      40
    )
    expect(row.input.top, `${context} 第 ${index + 1} 行：输入框越出行顶部`).toBeGreaterThanOrEqual(
      row.row.top - 1
    )
    expect(
      row.remove.bottom,
      `${context} 第 ${index + 1} 行：删除按钮越出行底部`
    ).toBeLessThanOrEqual(row.row.bottom + 1)
  }
}

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  prepareUserData()
  app = await electron.launch({ args: ['.', `--user-data-dir=${USER_DATA_DIR}`], cwd: APP_ROOT })
  page = await app.firstWindow()
  await page.waitForSelector('.workbench')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(940, 640)
  })
  await page.waitForTimeout(250)
})

test.afterAll(async () => {
  await app?.close()
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

test('窄窗口下文件和搜索排除规则保持单行对齐，并正确增删写盘', async () => {
  await openSettings(page, '文件')
  const files = page.locator('.settings-view--files-exclude')
  await expect(files).toBeVisible()
  expectSingleLineRows(await inspectExcludeRows(page, '.settings-view--files-exclude'), '文件排除')

  const add = files.locator('.settings-view__actions .btn', { hasText: '添加规则' })
  await add.click()
  const newRow = files.locator('.sg__row').last()
  const newInput = newRow.locator('.exclude-row__pattern')
  await newInput.fill('**/.compact-e2e')
  await expect
    .poll(() => {
      const settings = JSON.parse(readFileSync(join(USER_DATA_DIR, 'settings.json'), 'utf-8')) as {
        filesExclude?: Record<string, boolean>
      }
      return settings.filesExclude?.['**/.compact-e2e']
    })
    .toBe(true)

  await newRow.getByRole('switch').click()
  await expect(newRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(() => {
      const settings = JSON.parse(readFileSync(join(USER_DATA_DIR, 'settings.json'), 'utf-8')) as {
        filesExclude?: Record<string, boolean>
      }
      return settings.filesExclude?.['**/.compact-e2e']
    })
    .toBe(false)

  await newRow.getByRole('button', { name: '删除该规则' }).click()
  await expect(files.locator('input[value="**/.compact-e2e"]')).toHaveCount(0)
  await expect
    .poll(() => {
      const settings = JSON.parse(readFileSync(join(USER_DATA_DIR, 'settings.json'), 'utf-8')) as {
        filesExclude?: Record<string, boolean>
      }
      return (
        settings.filesExclude &&
        Object.prototype.hasOwnProperty.call(settings.filesExclude, '**/.compact-e2e')
      )
    })
    .toBe(false)

  await openSettings(page, '搜索')
  const search = page.locator('.settings-view--search-exclude')
  await expect(search).toBeVisible()
  expectSingleLineRows(await inspectExcludeRows(page, '.settings-view--search-exclude'), '搜索排除')
})

test('窄窗口终端标签栏保持紧凑，PTY 不可用时明确提示原因', async () => {
  await page.keyboard.press('Control+`')
  await expect(page.locator('.terminal-view')).toBeVisible()
  const errorBox = page.locator('.terminal-view__error')
  const xterm = page.locator('.terminal-view .xterm')
  const outcome = await Promise.race([
    xterm.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'ok' as const),
    errorBox.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'failed' as const)
  ]).catch(() => 'timeout' as const)

  if (outcome === 'failed') {
    await expect(errorBox).toHaveAttribute('role', 'alert')
    await expect(page.locator('.terminal-view__error-detail')).toContainText('conpty')
    await expect(page.locator('.terminal-view__error-retry')).toBeVisible()
    return
  }
  expect(outcome).toBe('ok')

  const geometry = await page.evaluate(() => {
    const terminal = document.querySelector('.terminal-view')
    const main = document.querySelector('.terminal-view__main')
    const side = document.querySelector('.terminal-view__side')
    if (
      !(terminal instanceof HTMLElement) ||
      !(main instanceof HTMLElement) ||
      !(side instanceof HTMLElement)
    ) {
      throw new Error('终端布局节点缺失')
    }
    const terminalBox = terminal.getBoundingClientRect()
    const mainBox = main.getBoundingClientRect()
    const sideBox = side.getBoundingClientRect()
    return {
      terminalWidth: terminalBox.width,
      terminalHeight: terminalBox.height,
      mainWidth: mainBox.width,
      sideWidth: sideBox.width,
      sideHeight: sideBox.height,
      tabs: document.querySelectorAll('.terminal-view__item').length
    }
  })
  expect(geometry.tabs, '终端应有一个初始会话').toBe(1)
  // 标签栏位于顶部时会横向铺满容器；正文应获得几乎完整的宽度。
  expect(geometry.mainWidth, '终端正文应保留主要横向空间').toBeGreaterThan(
    geometry.terminalWidth * 0.9
  )
  expect(geometry.sideHeight, '单标签栏不应占据整个终端高度').toBeLessThan(
    geometry.terminalHeight * 0.55
  )
})
