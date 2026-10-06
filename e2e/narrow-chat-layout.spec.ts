import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 真机验收：对话面板变窄时，顶栏内容不被裁切。
 *
 * 背景（真机 bug）：顶部会话信息条与输入框工具条曾经共用 `.chat__toolbar`，
 * 顶栏继承了工具条的 `flex-wrap: wrap`，自身却写死 `height: 30px`。
 * 面板变窄后「用量 / 新建 / 多选 / 清空」换到第二行，第二行被面板的
 * `overflow: hidden` 连高度一起裁掉 —— 按钮看不见也点不到。
 *
 * 为什么必须驱动真实应用：
 *   这是纯布局问题，jsdom 不算布局、单测拿不到 boundingBox。
 *   只有真实 Chromium 的 flex 排版才能回答「按钮的矩形是否落在顶栏矩形之内」。
 *
 * 断言方式刻意用「矩形包含」而不是「可见」：Playwright 的 isVisible 只要求
 * 元素有非空盒子，被祖先 overflow 裁掉的按钮依然是"可见"的 —— 用可见性断言
 * 这个 bug 根本抓不住。矩形越界才是被裁掉的证据。
 */

const APP_ROOT = resolve(__dirname, '..')

/** 窗口最小尺寸，见 src/main/index.ts 的 BrowserWindow minWidth/minHeight */
const MIN_WINDOW = { width: 940, height: 640 }

/** 对话面板最小宽度，见 core/platform/layout-state.ts 的 LAYOUT_LIMITS.chatPanelMin */
const MIN_PANEL_WIDTH = 280

/** 布局状态在渲染进程的 localStorage 键，见 core/platform/layout-state.ts */
const LAYOUT_KEY = 'aether.ide.layout'

function prepareUserData(): string {
  const dir = join(tmpdir(), 'aether-ide-e2e-narrow-userdata')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // 不启动引擎：本用例只关心 CSS 排版，不依赖引擎就绪，省掉一段启动等待。
  // 顶栏按钮的渲染也不依赖会话历史（仅有消息时才出现的用量胶囊除外）。
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        engineMode: 'embedded',
        preferredPort: 12401,
        remoteBaseUrl: '',
        autoStartEngine: false,
        lastSessionId: '',
        lastAgentId: '',
        lastModelId: '',
        lastFolder: APP_ROOT
      },
      null,
      2
    ),
    'utf-8'
  )
  return dir
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

interface TopbarProbe {
  bar: Rect
  /** 顶栏内横向溢出量（>0 说明内容被挤出可视区） */
  overflowX: number
  itemCount: number
  items: Array<{ label: string; visible: boolean } & Rect>
  messages: Rect
  composer: Rect
  /** 面板体内纵向溢出量（>0 说明有一部分内容被 overflow:hidden 裁掉） */
  bodyOverflowY: number
}

async function probeTopbar(page: Page): Promise<TopbarProbe> {
  return page.evaluate(() => {
    const box = (el: Element | null): Rect => {
      if (!el) throw new Error('探针元素不存在')
      const r = el.getBoundingClientRect()
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height
      }
    }
    const bar = document.querySelector('.chat__topbar')
    if (!(bar instanceof HTMLElement)) throw new Error('顶栏 .chat__topbar 不存在')
    const body = document.querySelector('.chat-panel__body')
    if (!(body instanceof HTMLElement)) throw new Error('对话面板主体 .chat-panel__body 不存在')

    const nodes = Array.from(
      bar.querySelectorAll('.chat__toolbar-btn, .usage-meter')
    ) as HTMLElement[]

    return {
      bar: box(bar),
      overflowX: bar.scrollWidth - bar.clientWidth,
      itemCount: nodes.length,
      items: nodes.map((el) => ({
        label: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        visible:
          el.getClientRects().length > 0 &&
          getComputedStyle(el).display !== 'none' &&
          getComputedStyle(el).visibility !== 'hidden',
        ...box(el)
      })),
      messages: box(document.querySelector('.chat__messages')),
      composer: box(document.querySelector('.chat__composer')),
      bodyOverflowY: body.scrollHeight - body.clientHeight
    }
  })
}

/** 顶栏的每个按钮都必须完整落在顶栏矩形内，且顶栏自身不横向溢出 */
function expectTopbarIntact(probe: TopbarProbe, context: string): void {
  expect(probe.itemCount, `${context}：顶栏应有新建和多选两个按钮`).toBe(2)
  expect(
    probe.items.map((item) => item.label).sort(),
    `${context}：顶栏按钮应分别是新建和多选`
  ).toEqual(['多选', '新建'])

  for (const item of probe.items) {
    expect(item.visible, `${context}：按钮「${item.label}」不可见`).toBe(true)
    // 矩形的上下边界是最关键的断言：旧实现里第二行按钮的 bottom 会越过
    // 30px 固定高度，正是被裁掉的那一行
    expect(item.height, `${context}：按钮「${item.label}」高度异常`).toBeGreaterThan(1)
    expect(item.width, `${context}：按钮「${item.label}」宽度异常`).toBeGreaterThan(1)
    expect(item.top, `${context}：按钮「${item.label}」越出顶栏上边界`).toBeGreaterThanOrEqual(
      probe.bar.top - 0.5
    )
    expect(
      item.bottom,
      `${context}：按钮「${item.label}」越出顶栏下边界（被裁掉）`
    ).toBeLessThanOrEqual(probe.bar.bottom + 0.5)
    expect(item.left, `${context}：按钮「${item.label}」越出顶栏左边界`).toBeGreaterThanOrEqual(
      probe.bar.left - 0.5
    )
    expect(item.right, `${context}：按钮「${item.label}」越出顶栏右边界`).toBeLessThanOrEqual(
      probe.bar.right + 0.5
    )
  }

  // 顶栏自身不允许横向滚动（内容一律换行，不外溢）
  expect(probe.overflowX, `${context}：顶栏出现横向溢出`).toBeLessThanOrEqual(1)
  // 面板体不允许纵向裁切：顶栏变高时必须由消息区让位，而不是被裁掉
  expect(probe.bodyOverflowY, `${context}：对话面板内容被纵向裁切`).toBeLessThanOrEqual(1)
  // 消息区与输入区仍要留得下（顶栏吃掉全部高度就说明布局塌了）
  expect(probe.messages.height, `${context}：消息区高度异常`).toBeGreaterThan(0)
  expect(probe.composer.height, `${context}：输入区高度异常`).toBeGreaterThan(0)
}

/** 把面板宽度写进布局状态并重载，让 React 按新宽度重排 */
async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      const raw = localStorage.getItem(key)
      const next = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      next.chatPanelWidth = value
      next.chatPanelVisible = true
      localStorage.setItem(key, JSON.stringify(next))
    },
    [LAYOUT_KEY, width] as const
  )
  await page.reload()
  await page.waitForSelector('.chat__topbar')
}

let app: ElectronApplication
let page: Page
const userDataDir = prepareUserData()

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: APP_ROOT })
  page = await app.firstWindow()
  await page.waitForSelector('.workbench')
  await page.waitForSelector('.chat__topbar')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

test('默认宽度下顶栏按钮完整可见', async () => {
  await expect(page.locator('.chat__topbar')).toBeVisible()
  expectTopbarIntact(await probeTopbar(page), '默认宽度')
})

test('面板压到最小宽度（280）后顶栏按钮不被裁掉', async () => {
  await setPanelWidth(page, MIN_PANEL_WIDTH)

  // 防御：确认面板真的被压窄了，否则断言会在"宽面板"上白跑一遍
  const panelWidth = await page
    .locator('.workbench__chat')
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(panelWidth, '对话面板应已压到最小宽度').toBeLessThanOrEqual(MIN_PANEL_WIDTH + 1)

  const probe = await probeTopbar(page)
  expectTopbarIntact(probe, '最小宽度面板')
  // 当前顶栏只有两个紧凑按钮，280px 下无需换行；保持固定高度且不裁切即可。
  expect(probe.bar.height, '最小宽度下顶栏高度应有效').toBeGreaterThanOrEqual(30)
})

test('窗口缩到最小尺寸时顶栏按钮依然完整', async () => {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(size.width, size.height)
  }, MIN_WINDOW)

  // 窗口尺寸变化后等一帧再量，避免量到重排前的旧几何
  await page.waitForTimeout(300)

  const probe = await probeTopbar(page)
  expectTopbarIntact(probe, '最小窗口')

  // 最小窗口下布局层可能按比例重算面板宽度，显式把面板钉回最小宽度，
  // 保证这条用例确实跑在「按钮必须换行」的窄布局里，而不是在宽面板上白跑
  await setPanelWidth(page, MIN_PANEL_WIDTH)
  const panelWidth = await page
    .locator('.workbench__chat')
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(panelWidth, '最小窗口下对话面板应仍被压到最小宽度').toBeLessThanOrEqual(
    MIN_PANEL_WIDTH + 1
  )

  const narrowProbe = await probeTopbar(page)
  expectTopbarIntact(narrowProbe, '最小窗口 + 最小宽度面板')
  expect(narrowProbe.bar.height, '最小窗口下顶栏高度应有效').toBeGreaterThanOrEqual(30)
})

test('最小窗口打开设置时让正文获得可读宽度', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.app-settings')).toBeVisible()

  const geometry = await page.evaluate(() => {
    const rect = (selector: string): DOMRect => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) throw new Error(`缺少探针元素：${selector}`)
      return element.getBoundingClientRect()
    }
    const body = document.querySelector('.app-settings__body')
    if (!(body instanceof HTMLElement)) throw new Error('设置正文不存在')
    return {
      navWidth: rect('.app-settings__nav').width,
      bodyWidth: rect('.app-settings__body').width,
      sidebarDisplay: getComputedStyle(document.querySelector('.workbench__sidebar') as Element).display,
      horizontalOverflow: body.scrollWidth - body.clientWidth
    }
  })

  expect(geometry.sidebarDisplay, '设置页小屏应收起资源管理器').toBe('none')
  expect(geometry.navWidth, '设置导航应切成紧凑图标栏').toBeGreaterThanOrEqual(48)
  expect(geometry.navWidth, '设置导航不应挤占正文').toBeLessThanOrEqual(64)
  expect(geometry.bodyWidth, '设置正文应保留可读宽度').toBeGreaterThan(360)
  expect(geometry.horizontalOverflow, '设置正文不应出现横向溢出').toBeLessThanOrEqual(1)
  await expect(page.getByRole('tab', { name: '引擎管理', exact: true })).toBeVisible()
})
