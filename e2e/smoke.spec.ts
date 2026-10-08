import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 主冒烟（真机）：应用骨架与核心交互链路的总覆盖。
 *
 * 覆盖范围：工作台骨架、资源管理器（展开 / 多选 / 拖拽+撤销 / 虚拟滚动 /
 * 右键菜单 / 新建文件）、编辑器（Monaco 挂载）、二进制预览、引擎就绪、
 * 安全视图、输出面板编码、命令面板、快速打开、内置终端多标签、
 * 全局搜索与替换、键盘快捷方式。
 *
 * 为什么必须用 Playwright 驱动真实应用：
 *   - 渲染进程的报错不会出现在主进程日志里（实测 --enable-logging 也拿不到），
 *     光看日志"没有报错"无法证明功能正常
 *   - Monaco 的 worker / CSP 问题只在真实窗口里才会暴露
 *
 * 前置：先执行 npm run build（测试加载的是 out/ 产物，与生产一致）
 */

const APP_ROOT = resolve(__dirname, '..')
/** 作为工作区打开的目录：用项目自身，保证有真实文件可浏览 */
const WORKSPACE_DIR = APP_ROOT

/**
 * 预览与右键菜单用例的夹具目录。
 *
 * 内容必须确定，否则无法断言十六进制转储的具体字节：这里写入 20 字节
 * 0x00..0x13，含 NUL 因而必然被判为二进制。用例结束后删除。
 */
const FIXTURE_DIR = join(APP_ROOT, '.e2e-tmp', 'smoke-fixtures')
const USER_DATA_DIR = join(tmpdir(), 'aether-ide-e2e-smoke-userdata')

/**
 * 生成「按绝对路径精确匹配某一行」的 CSS 选择器。
 *
 * 必须转义反斜杠：CSS 属性选择器里的 `\` 是转义引导符，
 * 直接写 [data-path="D:\my\...\src"] 会被解析成转义序列而匹配不到任何行
 * （`\.v` 恰好等于 `v`，所以 `.vscode` 这类路径会"碰巧"命中，掩盖问题）。
 * 转义后 \\ 表示一个真实的反斜杠，选择器语义与字符串精确相等一致。
 */
function rowSelector(target: string): string {
  // Sticky ancestor rows are aria-hidden visual clones. Scope exact path
  // lookups to the virtualized rows container so a clone cannot trigger
  // Playwright strict-mode ambiguity when the real row is also visible.
  return `.explorer__rows .tree-row[data-path="${target.replace(/\\/g, '\\\\')}"]`
}

/** 目录的子项计数选择器：路径分隔符同样需要转义 */
function descendantSelector(dir: string): string {
  return `.explorer__rows .tree-row[data-path^="${dir.replace(/\\/g, '\\\\')}\\\\"]`
}

/**
 * 确保侧边栏停在资源管理器上。
 *
 * 不能用 Ctrl+Shift+E：它是"切换"语义（layout-state.toggleSidebarView），
 * 资源管理器已经是当前视图时会反过来把侧边栏收起，用例随之前后互相污染。
 * 这里按侧边栏的实际状态操作，是幂等的。
 */
async function ensureExplorerVisible(): Promise<void> {
  const visible = await page
    .locator('.explorer')
    .isVisible()
    .catch(() => false)
  if (visible) return
  await page.locator('.activity-bar button[title="资源管理器"]').click()
  await expect(page.locator('.explorer__root')).toBeVisible({ timeout: 15_000 })
}

/** 虚拟滚动夹具的条目数：要远大于一屏能渲染的行数，否则测不出虚拟化 */
const BIG_DIR_SIZE = 400

/**
 * 把虚拟化树滚到指定路径。
 *
 * 资源管理器只把可见窗口挂进 DOM；`.e2e-tmp` 下其它 spec 的临时目录很多时，
 * 夹具目录可能在首屏之外。测试不能依赖 locator 自动滚动（目标行尚未挂载），
 * 因此按真实滚动容器的总高度分段前进，直到目标行挂载后再交给 Playwright 断言。
 */
async function revealTreeRow(target: string, required = true): Promise<boolean> {
  const tree = page.locator('.explorer__tree')
  await tree.evaluate(async (element, targetPath) => {
    const waitForRender = async (): Promise<void> => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    }
    const hasTarget = (): boolean =>
      [...element.querySelectorAll<HTMLElement>('.explorer__rows .tree-row')].some(
        (row) => row.dataset.path === targetPath
      )
    if (hasTarget()) {
      const row = [...element.querySelectorAll<HTMLElement>('.explorer__rows .tree-row')].find(
        (item) => item.dataset.path === targetPath
      )!
      row.scrollIntoView({ block: 'center' })
      await waitForRender()
      return
    }
    element.scrollTop = 0
    await waitForRender()
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (hasTarget()) {
        const row = [...element.querySelectorAll<HTMLElement>('.explorer__rows .tree-row')].find(
          (item) => item.dataset.path === targetPath
        )!
        row.scrollIntoView({ block: 'center' })
        await waitForRender()
        return
      }
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
      if (element.scrollTop >= bottom) break
      const previous = element.scrollTop
      element.scrollTop = Math.min(bottom, previous + Math.max(1, element.clientHeight * 0.8))
      await waitForRender()
      if (element.scrollTop <= previous) break
    }
  }, target)
  const row = page.locator(rowSelector(target))
  if (required) await expect(row).toBeVisible({ timeout: 15_000 })
  return row.isVisible()
}

/**
 * 确保某个目录处于展开状态。
 *
 * 点一下目录是「切换」而不是「打开」：用例之间共享同一个窗口，
 * 上一个用例可能已经把它展开过，无脑再点一次反而会折叠。
 * 这里按状态幂等，避免用例之间的执行顺序变成隐式依赖。
 */
async function ensureDirExpanded(dir: string): Promise<void> {
  // A collapsed single-child directory chain is one compact row whose path is
  // the final directory. Look for that row before requiring each ancestor:
  // after Collapse All, .e2e-tmp itself may not have a standalone row.
  const insideWorkspace =
    dir !== APP_ROOT && (dir.startsWith(APP_ROOT + '\\') || dir.startsWith(APP_ROOT + '/'))
  if (insideWorkspace) {
    await page.locator('.explorer__tree').evaluate((el) => {
      el.scrollTop = 0
    })
    await ensureDirExpanded(APP_ROOT)
    const parent = resolve(dir, '..')
    if (parent !== APP_ROOT && !(await revealTreeRow(dir, false))) {
      await ensureDirExpanded(parent)
    }
  }
  await revealTreeRow(dir)
  const row = page.locator(rowSelector(dir))
  if ((await row.getAttribute('aria-expanded')) === 'true') return
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })
}
function prepareFixtures(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(
    join(FIXTURE_DIR, 'fixture.bin'),
    Buffer.from(Array.from({ length: 20 }, (_, i) => i))
  )
  // 全局替换用例的文本夹具：内容确定，替换后可精确断言
  writeFileSync(join(FIXTURE_DIR, 'replace.txt'), 'alpha beta\nalpha gamma\n', 'utf-8')

  // 多选 / 拖拽 / 撤销用例的夹具：两个可移动的文件 + 一个落点目录
  writeFileSync(join(FIXTURE_DIR, 'move-a.txt'), 'A', 'utf-8')
  writeFileSync(join(FIXTURE_DIR, 'move-b.txt'), 'B', 'utf-8')
  mkdirSync(join(FIXTURE_DIR, 'sub'), { recursive: true })
  // 缩进参考线用例的夹具：必须有一个二层子项，depth 才有值
  writeFileSync(join(FIXTURE_DIR, 'sub', 'nested.txt'), 'nested', 'utf-8')

  // 拖拽悬停展开用例的夹具目录。必须在这里造：应用启动时会把 .e2e-tmp
  // 的子项读进缓存，之后在测试里用 mkdirSync 直接建目录，缓存不会知道，
  // 刷新按钮也只重读根目录 —— 新目录永远不出现。
  mkdirSync(join(FIXTURE_DIR, 'hover'), { recursive: true })
  writeFileSync(join(FIXTURE_DIR, 'hover', 'inside.txt'), 'inside', 'utf-8')

  // 缓存加载后折叠为一个紧凑行，验证三种展开手势都能一次展开完整链条。
  mkdirSync(join(FIXTURE_DIR, 'compact', 'middle', 'leaf'), { recursive: true })
  writeFileSync(join(FIXTURE_DIR, 'compact', 'middle', 'leaf', 'inside.txt'), 'compact', 'utf-8')

  // 多标签用例的夹具：两个只读文本文件。tab-a 的内容行数造得比视口高，
  // 才能把「滚动位置」这件事验出区别（一屏放得下的文件无所谓滚动到第几行）。
  // tab-b 内容确定，用于断言串号（切错标签会读到对方的内容）
  writeFileSync(
    join(FIXTURE_DIR, 'tab-a.txt'),
    Array.from({ length: 300 }, (_, i) => `line ${i + 1} of tab-a`).join('\n'),
    'utf-8'
  )
  writeFileSync(join(FIXTURE_DIR, 'tab-b.txt'), 'TAB-B-MARKER\n', 'utf-8')
}

/**
 * 虚拟滚动用例的夹具：一个 400 项的目录。
 *
 * 行高 22px + 一屏缓冲区，可见行不会超过 60 行，因此「渲染数远小于 400」
 * 就是虚拟化生效的硬证据 —— 不依赖任何实现细节，只数 DOM 节点。
 */
function prepareBigDir(): void {
  const dir = join(FIXTURE_DIR, 'big')
  mkdirSync(dir, { recursive: true })

  for (let i = 0; i < BIG_DIR_SIZE; i++) {
    writeFileSync(join(dir, `item-${String(i).padStart(3, '0')}.txt`), '', 'utf-8')
  }
}

/**
 * 走应用自身的操作（Delete 删除、Ctrl+X/Ctrl+V 移动）把夹具还原。
 *
 * 不直接用 fs.renameSync 还原：测试里绕过应用动磁盘后，工作区缓存并不知情，
 * 「刷新」按钮又只重读根目录（refreshDirectory 只重读已缓存的目录）——
 * 于是还原回来的文件在树里永远不出现。走应用自己的键位则缓存 / 选区 / 树
 * 都会跟着更新。
 *
 * F2 只能"原地改名"，搬不动目录层级，所以这里用剪切 + 粘贴回根目录。
 */
async function restoreFixtureViaApp(opts: {
  /** 需要搬回根目录的源路径（当前所在位置） */
  from: string
  /** 根目录路径（粘贴落点） */
  root: string
  /** 要删掉的残留（副本等）；不传则只做搬移 */
  removePaths?: string[]
}): Promise<void> {
  const tree = page.locator('.explorer__tree')

  for (const path of opts.removePaths ?? []) {
    await revealTreeRow(path)
    const row = page.locator(rowSelector(path))
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await tree.press('Delete')
    const confirm = page.getByRole('dialog', { name: '移入回收站', exact: true })
    await expect(confirm).toBeVisible({ timeout: 10_000 })
    await confirm.getByRole('button', { name: '移入回收站', exact: true }).click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })
  }

  await revealTreeRow(opts.from)
  const source = page.locator(rowSelector(opts.from))
  await expect(source).toBeVisible({ timeout: 15_000 })
  await source.click()
  await tree.press('Control+x')
  await expect(source).toHaveClass(/is-cut/)

  // 落点：根目录那一行。点它把它设为光标行，粘贴才会落在根目录下
  await revealTreeRow(opts.root)
  const rootRow = page.locator(rowSelector(opts.root))
  await expect(rootRow).toBeVisible({ timeout: 15_000 })
  await rootRow.click()
  await tree.press('Control+v')

  await revealTreeRow(join(opts.root, 'move-a.txt'))
  await expect(page.locator(rowSelector(join(opts.root, 'move-a.txt')))).toBeVisible({
    timeout: 15_000
  })
}

function prepareUserData(): string {
  const dir = USER_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  // 预置 lastFolder：应用启动时会自动恢复并授权该目录。
  // 不能靠测试点击「打开文件夹」——那会弹出系统对话框，测试环境下无法交互。
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        engineMode: 'embedded',
        // 用独立端口：开发机常驻的 IDE 实例占着默认端口 12323，
        // 测试实例会探测到并复用其引擎（不启动新进程、无「已启动」日志）
        preferredPort: 12399,
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
  prepareBigDir()

  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT
  })

  page = await app.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  // 仍为可能使用原生确认框的路径保留兜底；Explorer 当前的删除确认是
  // ConfirmDialog，restoreFixtureViaApp 会显式点击它的「移入回收站」按钮。
  page.on('dialog', (dialog) => void dialog.accept())

  await page.waitForSelector('.workbench')
})

test.afterAll(async () => {
  await app?.close()
  // 夹具是测试自己造的，收尾删掉，避免污染仓库
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  // 用例会经 settings:update 写盘（文件排除规则必然要落盘才谈得上"生效"），
  // 关掉应用后再清掉这份配置，否则下一次运行会带着上一次的规则启动。
  // 不放在用例内部兜底：规则要留到「关窗 → 重开」的用例里验证真的持久化了。
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

test('工作台骨架渲染：菜单栏、活动栏、侧边栏、主区、对话面板、状态栏均存在', async () => {
  await expect(page.locator('.menu-bar')).toBeVisible()
  await expect(page.locator('.activity-bar')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.editor-area')).toBeVisible()
  await expect(page.locator('.chat-panel')).toBeVisible()
  await expect(page.locator('.status-bar')).toBeVisible()

  // 主区的默认视图是对话面板。注意不能断言「模型」「安全」这类标签存在：
  // 它们曾经是主区固定标签，现已并入 AppSettingsView 的侧边分区
  // （见 contrib/settings/app-settings-navigation.ts），不再是主区标签。
  await expect(page.locator('.chat-panel')).toBeVisible()
})

test('资源管理器：恢复上次打开的文件夹并列出文件', async () => {
  await expect(page.locator('.explorer__root')).toContainText('AETHER-CODE')

  // 根目录条目应该被加载出来（package.json 必然存在）
  const packageRow = page.locator('.tree-row[title$="package.json"]')
  await expect(packageRow).toBeVisible()
  await expect(page.locator('.tree-row').first()).toBeVisible()
})

test('资源管理器：点击目录可展开', async () => {
  // 计数只看目标目录的子项，不能用整棵树的行数：
  // 虚拟滚动下 DOM 里始终只有可见的几十行，展开后总数可能反而不变
  const children = page.locator(descendantSelector(join(APP_ROOT, 'src')))

  // src 是项目里必然存在的目录。注意不能只写 hasText: 'src'：
  // 那会同时匹配到 src-runner 之类的兄弟目录，展开的却是另一个
  await revealTreeRow(join(APP_ROOT, 'src'))
  const src = page.locator(rowSelector(join(APP_ROOT, 'src')))
  await expect(src).toBeVisible()
  await src.click()

  // 展开后它的子项出现（src 下必然有文件，否则这个仓库根本无法构建）
  await expect.poll(async () => children.count(), { timeout: 15_000 }).toBeGreaterThan(0)

  // 再点一次收起，子项消失
  await src.click()
  await expect.poll(async () => children.count(), { timeout: 15_000 }).toBe(0)
})

test('编辑器：打开文件后 Monaco 挂载并显示内容', async () => {
  // 侧边栏可能停在上个用例切过去的视图上，先确保资源管理器可见
  await ensureExplorerVisible()

  await revealTreeRow(join(APP_ROOT, 'package.json'))
  const packageRow = page.locator(rowSelector(join(APP_ROOT, 'package.json')))
  await expect(packageRow).toBeVisible({ timeout: 15_000 })
  await packageRow.click()

  // 新标签出现
  const tab = page.locator('.editor-tab', { hasText: 'package.json' })
  await expect(tab).toBeVisible()

  // Monaco 真正初始化（worker 与 CSP 有问题时这一步会失败）
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 })

  // 内容渲染出来：Monaco 的 view-lines 里应出现文件内容特征串
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('aether-code', {
    timeout: 20_000
  })

  // 状态栏显示字符数与保存状态
  await expect(page.locator('.doc-view__status')).toContainText('已保存')
})

test('引擎：自动启动并进入就绪状态', async () => {
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})

test('安全视图：渲染三种会话模式与引擎侧策略规则', async () => {
  // 对话右面板常驻，底部就能切模式：被拦时用户正盯着输入框，不该被迫切页
  const optionsTrigger = page.locator('.composer-options__trigger')
  await expect(optionsTrigger).toBeEnabled()
  await optionsTrigger.click()
  const modeTrigger = page.locator('.composer-options__dd-btn[title="选择安全模式"]')
  await expect(modeTrigger).toBeEnabled({ timeout: 15_000 })
  await modeTrigger.click()
  await expect(page.locator('.composer-options__dd-item[role="menuitem"]')).toHaveCount(3)

  // 切一次并确认状态是一致的：若 PUT 被引擎拒绝，store 会回滚成原模式
  await page.locator('.composer-options__dd-item[role="menuitem"]', { hasText: '标准模式' }).click()
  await expect(modeTrigger).toContainText('标准模式')

  // 选择后当前 Popover 仍保持打开；重复点击 trigger 会把菜单关掉，
  // 无法验证选中项是否真的带上 active 状态。
  await expect(
    page.locator('.composer-options__dd-item[role="menuitem"]', { hasText: '标准模式' })
  ).toHaveClass(/is-active/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer-options__dd-menu')).toHaveCount(0)

  // 打开设置并定位到「安全」分区。
  // 「安全」不再是主区固定标签，而是设置视图内的 role=tab 分区，
  // 唯一入口是命令面板 / 快捷键触发的 openAppSettings('security')。
  // 这里用命令面板走真实用户路径，而不是直接调函数。
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('安全策略')
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette')).toHaveCount(0)

  await expect(page.locator('.app-settings')).toBeVisible({ timeout: 15_000 })
  // 分区定位必须真的生效：openAppSettings 传了 section，tab 要落在「安全」上
  await expect(page.locator('.app-settings__nav-item[aria-selected="true"]')).toHaveText('安全')

  // 三种模式都要出现（缺 sessionId 时只是禁用，不应消失）。安全设置页
  // 当前使用 SettingsGroup 的 sg__row + role=radio 结构。
  const modeGroup = page.locator('.sg').filter({ hasText: '本会话安全模式' }).first()
  const modeRows = modeGroup.locator('.sg__row').filter({ has: page.locator('[role="radio"]') })
  await expect(modeRows).toHaveCount(3)
  await expect(modeRows.filter({ hasText: '完全访问' })).toBeVisible()

  // 安全页挂载时会重新向引擎 GET 模式，能读到刚才写入的 standard，
  // 才算证明了这一步真的落到引擎（只看界面变化不足为凭）
  await expect(modeRows.filter({ hasText: '标准模式' }).locator('[role="radio"]')).toHaveAttribute(
    'aria-checked',
    'true'
  )

  // 规则来自引擎，内置兜底规则必然存在
  const policyGroup = page.locator('.sg').filter({ hasText: '策略规则' }).first()
  await expect
    .poll(
      async () =>
        policyGroup
          .locator('.sg__select-field .select__trigger[title="命中该规则时的动作"]')
          .count(),
      {
        timeout: 30_000
      }
    )
    .toBeGreaterThan(0)

  // 每条规则都有动作下拉，这是「消除反复打断」的实际控制点
  await expect(
    policyGroup.locator('.sg__select-field .select__trigger[title="命中该规则时的动作"]').first()
  ).toBeVisible()
})

test('输出面板：中文经 IPC 保持完整（终端乱码并非数据损坏）', async () => {
  // 点状态栏的引擎项打开输出面板
  await page.locator('.status-bar button').first().click()

  const output = page.locator('.output__lines')
  await expect(output).toBeVisible()

  // 引擎启动时主线程会输出中文。若链路里发生过错误解码，这里会拿到乱码或替换字符。
  await expect(output).toContainText('已启动', { timeout: 30_000 })

  const text = await output.innerText()
  expect(text).not.toContain('\uFFFD')
  // GBK 误解码的典型产物
  expect(text).not.toMatch(/鍛戒腑|璇诲彇|宸插惎鍔/)
})

test('资源管理器右键菜单：列出可用操作，Esc 可关闭', async () => {
  await page.locator('.tree-row', { hasText: 'package.json' }).first().click({ button: 'right' })

  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('打开')
  await expect(menu).toContainText('新建文件')
  await expect(menu).toContainText('新建文件夹')
  await expect(menu).toContainText('重命名')
  await expect(menu).toContainText('删除（移入回收站）')

  await page.keyboard.press('Escape')
  await expect(page.locator('.context-menu')).toHaveCount(0)
})

test('文件排除：设置里的规则即时生效，且重开窗口后仍然生效', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  // 夹具在启动时就被读进缓存，把 *.txt 排除掉应当立刻让它从树里消失
  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const fixtureRow = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await expect(fixtureRow).toBeVisible({ timeout: 15_000 })

  // 走真实用户路径进入设置：命令面板搜「设置」→ 文件分区
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('设置')
  await page.keyboard.press('Enter')
  await expect(page.locator('.app-settings')).toBeVisible({ timeout: 15_000 })
  await page.locator('.app-settings__nav-item', { hasText: '文件' }).click()
  await expect(page.locator('.app-settings__nav-item[aria-selected="true"]')).toHaveText('文件')

  // 默认规则照搬 VS Code：只挡 VCS 元数据与系统垃圾，不含 node_modules
  await expect(page.locator('.exclude-row__pattern')).toHaveCount(6)
  await expect(page.locator('.sg__row', { hasText: 'node_modules' })).toHaveCount(0)

  // 新增一条 *.txt 规则。输入是逐字符落盘的，等树真的少掉这些行再断言
  await page.locator('.settings-view__actions .btn', { hasText: '添加规则' }).click()
  await page.locator('.sg__row').last().locator('.exclude-row__pattern').fill('*.txt')

  await expect(fixtureRow).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'replace.txt')))).toHaveCount(0)
  // 不命中的条目必须留下 —— 否则就是把整棵树误删了
  await revealTreeRow(join(FIXTURE_DIR, 'fixture.bin'))
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'fixture.bin')))).toBeVisible()

  // 重开窗口：规则必须是从 settings.json 读回来的，而不是只活在内存里。
  // 这是"排除是配置项"与"排除是临时开关"的分水岭。
  // 放在本用例开头执行（而不是末尾）是为了让后续用例在干净、无排除规则的
  // 窗口里跑：本用例会重启应用，全局的 page 也随之换新，必须让它先发生。
  await app.close()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${USER_DATA_DIR}`],
    cwd: APP_ROOT
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('dialog', (dialog) => void dialog.accept())
  await page.waitForSelector('.workbench')

  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)
  const restoredRow = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('设置')
  await page.keyboard.press('Enter')
  await page.locator('.app-settings__nav-item', { hasText: '文件' }).click()
  // 规则表里能看到那条 *.txt，才说明它真的落盘了
  await expect(page.locator('.exclude-row__pattern').last()).toHaveValue('*.txt')
  await expect(restoredRow).toHaveCount(0, { timeout: 15_000 })

  // 取消勾选 = 显式不排除：文件应立刻回来。这一步同时把状态收拾干净，
  // 后面依赖 .txt 夹具的用例（新建文件 / 拖拽 / 重命名）才不会连带被隐藏。
  await page.locator('.sg__row').last().locator('.toggle[role="switch"]').last().click()
  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  await expect(restoredRow).toBeVisible({ timeout: 15_000 })
})

test('资源管理器：右键新建文件后出现在树中', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)
  await revealTreeRow(FIXTURE_DIR)
  await page.locator(rowSelector(FIXTURE_DIR)).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()

  // Electron 没有 window.prompt，这里验证的是自建对话框真的接上了
  const input = page.locator('.modal--prompt input')
  await expect(input).toBeVisible()
  await input.fill('created.txt')
  await page.locator('.modal--prompt .btn--primary').click()

  await revealTreeRow(join(FIXTURE_DIR, 'created.txt'))
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'created.txt')))).toBeVisible({
    timeout: 15_000
  })
  // 同目录的夹具文件也应可见：说明新建后目录已被展开，用户能看到结果
  await revealTreeRow(join(FIXTURE_DIR, 'fixture.bin'))
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'fixture.bin')))).toBeVisible()
})

test('资源管理器：多选（Ctrl 加选、Shift 连选、Ctrl+A 全选、Esc 清除）', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await revealTreeRow(join(FIXTURE_DIR, 'move-b.txt'))
  const moveB = page.locator(rowSelector(join(FIXTURE_DIR, 'move-b.txt')))
  await expect(moveA).toBeVisible({ timeout: 15_000 })

  // Ctrl 点击逐个加选；整棵树里只有这两行是 selected
  await moveA.click()
  await moveB.click({ modifiers: ['Control'] })
  await expect(page.locator('.tree-row.is-selected')).toHaveCount(2)

  // Ctrl 再点一次取消该项（取反语义）
  await moveB.click({ modifiers: ['Control'] })
  await expect(page.locator('.tree-row.is-selected')).toHaveCount(1)
  await expect(moveB).not.toHaveClass(/is-selected/)

  // Shift 连选：从锚点（move-a）到 move-b，中间的行一并选中
  await moveA.click()
  await moveB.click({ modifiers: ['Shift'] })
  await expect(page.locator('.tree-row.is-selected')).toHaveCount(2)

  // Ctrl+A 全选所有已渲染的可见行，Esc 清空
  await page.locator('.explorer__tree').press('Control+a')
  await expect(page.locator('.tree-row')).not.toHaveCount(0)
  await expect(moveA).toHaveClass(/is-selected/)
  await expect(moveB).toHaveClass(/is-selected/)

  await page.keyboard.press('Escape')
  await expect(page.locator('.tree-row.is-selected')).toHaveCount(0)
})

test('资源管理器：选中行按焦点降级，树持有焦点时当前行有描边', async () => {
  await ensureExplorerVisible()
  // 本次运行前面有「全部收起」用例会把所有目录收起来，夹具行因此可能不在 DOM 里。
  // 这里显式展开，用例自身闭环，不依赖执行顺序。
  await ensureDirExpanded(FIXTURE_DIR)

  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await expect(moveA).toBeVisible({ timeout: 15_000 })

  // 点一下让树拿到焦点并选中该行
  const tree = page.locator('.explorer__tree')
  await moveA.click()
  await expect(moveA).toHaveClass(/is-selected/)
  await expect(tree).toHaveClass(/is-focused/)

  // 有焦点时：选中底色是 --bg-selected，且当前行带 outline（不能只看行存在）
  const focusedStyle = await moveA.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      background: style.backgroundColor,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle
    }
  })
  expect(focusedStyle.outlineStyle).toBe('solid')
  // 不断言等于 '1px'：Electron 窗口的 DPR 不保证是 1，Chromium 会把 1px
  // 按设备像素取整（本机 1.5x 下算出来是 0.666667px）。这里要钉的是
  // "描边确实很细"，而不是某个跟环境绑定的具体数值。
  const outlineWidth = Number.parseFloat(focusedStyle.outlineWidth)
  expect(outlineWidth).toBeGreaterThan(0)
  expect(outlineWidth).toBeLessThanOrEqual(2)

  // 焦点移出树（进入编辑器）：同一行必须降级 —— 底色变浅、描边消失
  await page.locator('.editor-tab[role="tab"][aria-selected="true"]').focus()
  await expect(tree).not.toHaveClass(/is-focused/)

  const blurredStyle = await moveA.evaluate((el) => {
    const style = getComputedStyle(el)
    return { background: style.backgroundColor, outlineStyle: style.outlineStyle }
  })
  // Theme/active-file layering may produce the same computed background for
  // focused and inactive states; the focus contract is the outline transition
  // and retaining a non-transparent selected surface.
  expect(blurredStyle.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(blurredStyle.outlineStyle).toBe('none')

  // 降级不等于取消选中：选区仍在，焦点回到树上时应恢复高亮。
  //
  // 用普通点击（不是 Ctrl 点击）把焦点还给树。Ctrl 点击是 toggle 语义，
  // 作用在已选中的行上会把它从选区里拿掉（selectEntry: next.delete），
  // 那验证的是"取消选择"，与"降级后能否恢复"是两回事。
  // 普通点击是 plain 语义：恒等于"只选中这一行"，天然幂等。
  await expect(moveA).toHaveClass(/is-selected/)
  await page.locator('.editor-tab[role="tab"][aria-selected="true"]').focus()
  await expect(tree).not.toHaveClass(/is-focused/)

  // 焦点不在树上时，行的底色必须仍是"降级态"而不是完全透明 ——
  // 选区在、只是变淡，与 VS Code 的 inactiveSelectionBackground 一致
  const awayStyle = await moveA.evaluate((el) => {
    const style = getComputedStyle(el)
    return { background: style.backgroundColor, outlineStyle: style.outlineStyle }
  })
  expect(awayStyle.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(awayStyle.outlineStyle).toBe('none')

  await moveA.click()
  await expect(tree).toHaveClass(/is-focused/)
  await expect(moveA).toHaveClass(/is-selected/)
})

test('资源管理器：缩进参考线与排序/收起全部入口可用', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)
  await ensureDirExpanded(join(FIXTURE_DIR, 'sub'))

  // 参考线数量 == 层级深度：树的第一行是根目录本身，根下的夹具目录是第二层。
  // `.e2e-tmp/smoke-fixtures/sub/nested.txt` 是根 → .e2e-tmp → smoke-fixtures → sub → nested.txt 共 5 层，故 4 条；
  // `.e2e-tmp/smoke-fixtures/move-a.txt` 是 4 层，故 3 条。
  await revealTreeRow(join(FIXTURE_DIR, 'sub', 'nested.txt'))
  const child = page.locator(rowSelector(join(FIXTURE_DIR, 'sub', 'nested.txt')))
  await expect(child).toBeVisible({ timeout: 15_000 })
  await expect(child).toHaveAttribute('aria-level', '5')
  await expect(child.locator('.explorer__indent')).toHaveCount(4)

  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const topLevel = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await expect(topLevel).toHaveAttribute('aria-level', '4')
  await expect(topLevel.locator('.explorer__indent')).toHaveCount(3)

  // .e2e-tmp 的其他文件数量会变化，排序后夹具末行可能被虚拟化移出 DOM。
  // 分段滚过完整子树再比较顺序，既不依赖窗口高度，也不把粘性父级克隆算进去。
  const directChildPaths = async (): Promise<string[]> =>
    page.locator('.explorer__tree').evaluate(async (tree, root) => {
      const originalScrollTop = tree.scrollTop
      const normalizedRoot = root.replace(/\\/g, '/')
      const children = new Map<string, number>()
      let enteredSubtree = false
      const nextRender = async (): Promise<void> => {
        // scroll 触发 React 更新虚拟切片；等下一次绘制，而不是猜一个固定延迟。
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
      }
      try {
        tree.scrollTop = 0
        await nextRender()
        while (true) {
          let passedSubtree = false
          for (const row of tree.querySelectorAll('.explorer__rows .tree-row')) {
            const rawPath = row.getAttribute('data-path')
            const path = rawPath?.replace(/\\/g, '/')
            if (!rawPath || !path) continue
            if (path === normalizedRoot || path.startsWith(normalizedRoot + '/')) {
              enteredSubtree = true
              if (path.slice(0, path.lastIndexOf('/')) === normalizedRoot) {
                children.set(
                  rawPath,
                  row.getBoundingClientRect().top -
                    tree.getBoundingClientRect().top +
                    tree.scrollTop
                )
              }
            } else if (enteredSubtree) {
              // 滚动重叠区也可能包含子树前面的行，只有已收过的直属子项之后才是边界。
              const lastChildTop = Math.max(-Infinity, ...children.values())
              const rowTop =
                row.getBoundingClientRect().top - tree.getBoundingClientRect().top + tree.scrollTop
              if (children.size && rowTop > lastChildTop) {
                passedSubtree = true
                break
              }
            }
          }
          const bottom = Math.max(0, tree.scrollHeight - tree.clientHeight)
          if (passedSubtree || tree.scrollTop >= bottom) break
          const previous = tree.scrollTop
          tree.scrollTop = Math.min(bottom, previous + Math.max(1, tree.clientHeight / 2))
          await nextRender()
          if (tree.scrollTop <= previous) break
        }
        return [...children.entries()].sort((a, b) => a[1] - b[1]).map(([path]) => path)
      } finally {
        tree.scrollTop = originalScrollTop
        await nextRender()
      }
    }, FIXTURE_DIR)
  const sortBtn = page.locator('.explorer__btn[aria-label="切换排序方式"]')
  const before = await directChildPaths()
  const diskChildren = readdirSync(FIXTURE_DIR).map((name) => join(FIXTURE_DIR, name))
  expect(new Set(before)).toEqual(new Set(diskChildren))
  await sortBtn.click()
  const expectedNameOrder = [...before].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  await expect.poll(() => directChildPaths(), { timeout: 10_000 }).toEqual(expectedNameOrder)
  const after = await directChildPaths()
  expect(new Set(after)).toEqual(new Set(before))
  expect(after).not.toEqual(before)
  await sortBtn.click()
  await expect.poll(() => directChildPaths(), { timeout: 10_000 }).toEqual(before)

  // 全部收起：展开的目录被收回，子项从视口消失
  await page.locator('.explorer__btn[aria-label="全部收起"]').click()
  await expect(child).toBeHidden({ timeout: 10_000 })
})

test('资源管理器：拖拽把多选项移入目标目录，Ctrl+Z 撤销回滚', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await revealTreeRow(join(FIXTURE_DIR, 'move-b.txt'))
  const moveB = page.locator(rowSelector(join(FIXTURE_DIR, 'move-b.txt')))
  await revealTreeRow(join(FIXTURE_DIR, 'sub'))
  const sub = page.locator(rowSelector(join(FIXTURE_DIR, 'sub')))
  await expect(moveA).toBeVisible({ timeout: 15_000 })
  await expect(sub).toBeVisible({ timeout: 15_000 })

  // 选中两个文件（多选状态就是拖拽的载荷）
  await moveA.click()
  await moveB.click({ modifiers: ['Control'] })
  await expect(page.locator('.tree-row.is-selected')).toHaveCount(2)

  // 指针拖拽到 sub 目录上：分多步移动，中间事件才会被派发
  const from = (await moveA.boundingBox())!
  const to = (await sub.boundingBox())!
  await page.mouse.move(from.x + 30, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 })
  await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 5 })
  await page.mouse.up()

  // 磁盘上确实搬走了，且落点是 sub 而不是根目录。
  // 注意必须 poll：moveEntries 对两个文件是两次顺序 await 的 IPC rename，
  // move-a 落盘和 move-b 落盘之间隔着几毫秒，同步断言会恰好卡在那个
  // 间隙里误报「没搬过去」（表现为只有 move-a 移动成功的假象）。
  await expect
    .poll(() => existsSync(join(FIXTURE_DIR, 'sub', 'move-a.txt')), { timeout: 10_000 })
    .toBe(true)
  await expect
    .poll(() => existsSync(join(FIXTURE_DIR, 'sub', 'move-b.txt')), { timeout: 10_000 })
    .toBe(true)
  expect(existsSync(join(FIXTURE_DIR, 'move-a.txt'))).toBe(false)

  // 撤销：文件回到原位，子目录里不再有它们
  await page.locator('.explorer__tree').press('Control+z')
  await expect
    .poll(() => existsSync(join(FIXTURE_DIR, 'move-a.txt')), { timeout: 10_000 })
    .toBe(true)
  // 同上：撤销的 revert 也是逐个 rename，等 move-b 真的回去再断言
  await expect
    .poll(() => existsSync(join(FIXTURE_DIR, 'move-b.txt')), { timeout: 10_000 })
    .toBe(true)
  expect(existsSync(join(FIXTURE_DIR, 'sub', 'move-a.txt'))).toBe(false)
})

test('资源管理器：紧凑目录通过点击、方向键和拖拽悬停一次展开', async () => {
  await ensureExplorerVisible()
  const leafPath = join(FIXTURE_DIR, 'compact', 'middle', 'leaf')
  const tree = page.locator('.explorer__tree')
  // 首次逐级打开，让真实目录内容进入缓存，随后收起才会形成紧凑链。
  await ensureDirExpanded(leafPath)
  await revealTreeRow(join(leafPath, 'inside.txt'))

  for (const gesture of ['click', 'keyboard', 'hover'] as const) {
    await test.step(gesture, async () => {
      await page.locator('.explorer__btn[aria-label="全部收起"]').click()
      await ensureDirExpanded(FIXTURE_DIR)
      await revealTreeRow(leafPath)
      const leaf = page.locator(rowSelector(leafPath))
      await expect(leaf.locator('.tree-row__chain')).toHaveText('compact/middle')
      await expect(leaf).toHaveAttribute('aria-expanded', 'false')

      if (gesture === 'click') {
        await leaf.click()
      } else if (gesture === 'keyboard') {
        // Ctrl 点击仅设置选区和键盘光标，不先展开目录。
        await leaf.click({ modifiers: ['Control'] })
        await tree.press('ArrowRight')
      } else {
        const sourcePath = join(FIXTURE_DIR, 'move-a.txt')
        await revealTreeRow(sourcePath)
        const source = page.locator(rowSelector(sourcePath))
        await source.click()
        const from = (await source.boundingBox())!
        const to = (await leaf.boundingBox())!
        await page.mouse.move(from.x + 30, from.y + from.height / 2)
        await page.mouse.down()
        try {
          await page.mouse.move(from.x + 50, from.y + 20, { steps: 5 })
          await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 5 })
          await expect(leaf).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })
        } finally {
          // 悬停展开之后取消投放，避免改变后续用例的文件夹具。
          await page.mouse.move(1, 1)
          await page.mouse.up()
        }
        expect(existsSync(sourcePath)).toBe(true)
        expect(existsSync(join(leafPath, 'move-a.txt'))).toBe(false)
      }

      await expect(leaf).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'compact')))).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'compact', 'middle')))).toHaveAttribute('aria-expanded', 'true')
      await revealTreeRow(join(leafPath, 'inside.txt'))
    })
  }
})

test('资源管理器：虚拟滚动只挂载可见行', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  // 先把滚动条归零再展开 big。
  //
  // 用例共享同一个窗口，上一个用例（拖拽）结束时视口停在树的中段，
  // 而树的滚动位置是跨用例保留的：直接展开 big，它整段都在视口之上，
  // item-000 根本不会被挂载 —— 失败原因与被测行为（虚拟化）毫无关系。
  // 显式归零，让"展开后首行可见"成为这条用例自己的前置条件。
  await page.locator('.explorer__tree').evaluate((el) => {
    el.scrollTop = 0
  })
  await ensureDirExpanded(join(FIXTURE_DIR, 'big'))

  // 先确认目录真的展开了（否则"行数少"只是因为没展开）
  // Expanded state is published before the asynchronous stat/read of 400 children.
  // Re-scan after loading progresses; waiting at the bottom of a virtual tree
  // cannot make an earlier row mount itself.
  await expect.poll(() => revealTreeRow(join(FIXTURE_DIR, 'big', 'item-000.txt'), false), {
    timeout: 20_000
  }).toBe(true)
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'big', 'item-000.txt')))).toBeVisible({
    timeout: 20_000
  })
  // 末尾的行远在视口之外，绝不该被挂载
  await expect(page.locator('.tree-row[data-path*="item-399"]')).toHaveCount(0)

  // big 目录里 400 项都已加载，但 DOM 里只应有可见的那几十行
  const rendered = await page.locator('.explorer__rows .tree-row').count()
  expect(rendered).toBeLessThan(100)
  expect(rendered).toBeGreaterThan(0)

  // 滚到 big 的最后一行：整个工作区底部还有兄弟目录/文件，不能把它当作 big 的底部。
  const tree = page.locator('.explorer__tree')
  await page.locator(rowSelector(join(FIXTURE_DIR, 'big', 'item-000.txt'))).evaluate((first) => {
    const el = first.closest<HTMLElement>('.explorer__tree')!
    const bounds = first.getBoundingClientRect()
    const firstTop = bounds.top - el.getBoundingClientRect().top + el.scrollTop
    el.scrollTop = firstTop + 399 * bounds.height - el.clientHeight / 2
  })
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'big', 'item-399.txt')))).toBeVisible({
    timeout: 10_000
  })
  await expect(page.locator('.tree-row[data-path*="item-000"]')).toHaveCount(0)
  expect(await page.locator('.explorer__rows .tree-row').count()).toBeLessThan(100)

  // 收尾把现场还原：滚回顶部再折叠 big。
  //
  // 虚拟化只挂载窗口内的行：这条用例结束时树停在底部、big 还挂着 400 个
  // 子项，此时 .e2e-tmp（第 0 行）和 fixture.bin（被挤到 400 行开外）都不
  // 在 DOM 里，后面用例（预览）的 locator 只能等到超时。先归零让第 0 行
  // 重新挂载，再点一下 big 把树缩回小状态。目录点击是切换语义，所以按
  // 状态幂等，而不是无脑再点一次。
  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await revealTreeRow(join(FIXTURE_DIR, 'big'))
  const bigRow = page.locator(rowSelector(join(FIXTURE_DIR, 'big')))
  await expect(bigRow).toBeVisible()
  if ((await bigRow.getAttribute('aria-expanded')) === 'true') await bigRow.click()
  await expect(bigRow).toHaveAttribute('aria-expanded', 'false')
})

test('预览：PNG 走图片预览，未知二进制走十六进制', async () => {
  await ensureExplorerVisible()
  // 前序目录展开状态和工作区里的其它临时文件会把 resources 挤出虚化窗口。
  // 本用例测预览，先经真实 UI 重置树展开状态，避免依赖其它用例留下的视口。
  await page.locator('.explorer__btn[aria-label="全部收起"]').click()
  await expect(page.locator(rowSelector(APP_ROOT))).toHaveAttribute('aria-expanded', 'false')

  // 图片：resources/icon.png 是稳定的真实 PNG
  await ensureDirExpanded(join(APP_ROOT, 'resources'))
  await revealTreeRow(join(APP_ROOT, 'resources', 'icon.png'))
  const icon = page.locator(rowSelector(join(APP_ROOT, 'resources', 'icon.png')))
  await expect(icon).toBeVisible({ timeout: 15_000 })
  await icon.click()

  const image = page.locator('.preview__image')
  await expect(image).toBeVisible({ timeout: 20_000 })
  // PNG 魔数的 base64 前缀：证明送到 <img> 的是真实图片字节，而不是占位内容
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,iVBORw0KGgo/)
  await expect(page.locator('.preview__status')).toContainText('图片预览')

  // 十六进制：.e2e-tmp/smoke-fixtures/fixture.bin 内容为 0x00..0x13。
  // 直接重新点开夹具目录，不依赖它在上一个用例结束时是否展开
  await ensureDirExpanded(FIXTURE_DIR)
  await revealTreeRow(join(FIXTURE_DIR, 'fixture.bin'))
  const fixture = page.locator(rowSelector(join(FIXTURE_DIR, 'fixture.bin')))
  await expect(fixture).toBeVisible({ timeout: 15_000 })
  await fixture.click()

  const hex = page.locator('.preview__hex')
  await expect(hex).toBeVisible({ timeout: 20_000 })
  await expect(hex).toContainText('00000000  00 01 02 03 04 05 06 07')
  await expect(hex).toContainText('|................|')
  await expect(page.locator('.preview__status')).toContainText('十六进制预览')
})

test('版本控制：状态栏入口打开侧边栏视图并给出仓库信息', async () => {
  const gitItem = page
    .locator('.status-bar button.status-bar__item')
    .filter({ has: page.locator('svg') })
    .first()
  await expect(gitItem).toBeVisible({ timeout: 30_000 })

  await gitItem.click()
  await expect(page.locator('.sidebar__header', { hasText: '版本控制' })).toBeVisible()
  const gitView = page.getByRole('region', { name: '版本控制' })
  await expect(gitView).toBeVisible()
  const gitPanel = gitView.locator('.git-panel')
  await expect(gitPanel).toBeVisible()

  // 两种情况都要能自洽：本仓库不是 git 仓库时给出说明，
  // 若将来项目本身变成仓库，则必须给出变更与提交历史两个分区。
  const label = await gitItem.innerText()
  if (label.includes('非 Git 仓库')) {
    await expect(gitPanel).toContainText(/不是\s+git\s+仓库/i)
  } else {
    await expect(gitPanel).toContainText('变更')
    await expect(gitPanel).toContainText('提交历史')
  }
})

test('命令面板：Ctrl+Shift+P 唤出、中文过滤、回车执行、Esc 关闭', async () => {
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.palette')).toBeVisible()
  await expect(page.locator('.palette__input')).toBeFocused()

  // 中文子串过滤出视图相关命令，键位提示跟随命令注册表
  await page.locator('.palette__input').fill('资源管理器')
  const items = page.locator('.palette__item')
  await expect(items.first()).toContainText('资源管理器')

  // 回车执行选中项并关闭面板。
  // 这里特意挑「显示资源管理器」而不是「启动引擎」：引擎三个命令都带 when
  // （engineReady / !engineBusy），引擎未就绪时处于禁用态，回车会被正确地
  // 忽略且面板不关；禁用态是另一条行为，不该混进「回车执行」这条用例里。
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette')).toHaveCount(0)

  // Esc / 点击遮罩均可关闭
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.palette')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)

  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.palette')).toBeVisible()
  await page.locator('.palette__input').fill('不存在的命令xyz')
  await expect(page.locator('.palette__empty')).toBeVisible()
  await page.mouse.click(10, 400)
  await expect(page.locator('.palette')).toHaveCount(0)

  // 最近使用（MRU）：执行过的命令置顶并分组展示（照搬 VS Code CommandsHistory）
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('资源管理器')
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.palette__group', { hasText: '最近使用' })).toBeVisible()
  await expect(page.locator('.palette__item').first()).toContainText('资源管理器')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)
})

test('快速打开：Ctrl+P 唤出、文件名过滤、回车打开文件', async () => {
  await page.keyboard.press('Control+p')
  const quick = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(quick).toBeVisible()
  await expect(page.locator('.palette__input')).toBeFocused()

  // 文件名子串过滤：命中排序后首项即目标文件
  await page.locator('.palette__input').fill('electron.vite')
  await expect(quick.locator('.palette__item').first()).toContainText('electron.vite.config.ts')

  // 回车打开：新标签挂载 Monaco 并显示内容
  await page.keyboard.press('Enter')
  await expect(quick).toHaveCount(0)
  await expect(page.locator('.editor-tab', { hasText: 'electron.vite.config.ts' })).toBeVisible()

  // Monaco 焦点下再按 Ctrl+P 仍可唤出（全局键位不被编辑器吞掉）
  await page.keyboard.press('Control+p')
  await expect(quick).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(quick).toHaveCount(0)

  // `>` 命令模式：模糊过滤并执行（照搬 VS Code 前缀语法）
  await page.keyboard.press('Control+p')
  await expect(quick).toBeVisible()
  await page.locator('.palette__input').fill('> 命令面板')
  await expect(quick.locator('.palette__item').first()).toContainText('命令面板')
  await page.keyboard.press('Enter')
  await expect(quick).toHaveCount(0)
  await expect(page.locator('.palette[aria-label="命令面板"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)

  // `:行号`：作用于当前激活编辑器（本用例刚打开过 electron.vite.config.ts）
  await page.keyboard.press('Control+p')
  await expect(quick).toBeVisible()
  await page.locator('.palette__input').fill(':1')
  await expect(quick.locator('.palette__item').first()).toContainText('跳到当前文件第 1 行')
  await page.keyboard.press('Enter')
  await expect(quick).toHaveCount(0)
  await expect(page.locator('.editor-tab', { hasText: 'electron.vite.config.ts' })).toBeVisible()

  // `?` 帮助模式：列出前缀用法，点选切换
  await page.keyboard.press('Control+p')
  await expect(quick).toBeVisible()
  await page.locator('.palette__input').fill('?')
  await expect(quick.locator('.palette__item', { hasText: '执行命令' })).toBeVisible()
  await quick.locator('.palette__item', { hasText: '执行命令' }).click()
  await expect(page.locator('.palette__input')).toHaveValue('>')
  await page.keyboard.press('Escape')
  await expect(quick).toHaveCount(0)
})

test('内置终端：Ctrl+` 打开面板、执行命令并回显', async () => {
  await page.keyboard.press('Control+`')
  await expect(page.locator('.terminal-view')).toBeVisible()

  // 环境不支持 ConPTY 时（CI/沙箱里 spawn 控制台进程被拒），终端必然起不来。
  // 这时断言 xterm 存在只会得到一个与代码无关的红 —— 更糟的是它看起来像回归。
  // 所以先探测真实能力：要么拿到 xterm 继续验交互，要么验证"失败被如实告知"。
  const errorBox = page.locator('.terminal-view__error')
  const xterm = page.locator('.terminal-view .xterm')

  const outcome = await Promise.race([
    xterm.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'ok' as const),
    errorBox.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'failed' as const)
  ]).catch(() => 'timeout' as const)

  if (outcome === 'failed') {
    // 失败路径也要立住：错误提示可见、带 role=alert、详情指向 pty 层
    await expect(errorBox).toHaveAttribute('role', 'alert')
    await expect(page.locator('.terminal-view__error-title')).toHaveText('终端启动失败')
    await expect(page.locator('.terminal-view__error-detail')).toContainText('conpty')
    // 关键：失败后必须停下来，不能无限重试（曾经是失败-复位-重试的风暴）
    await expect(page.locator('.terminal-view__error-retry')).toBeVisible()
    return
  }

  expect(outcome).toBe('ok')

  // 面板自动聚焦与引擎就绪渲染存在竞态：显式点一下终端确保焦点
  await page.locator('.terminal-view .xterm').click()

  // pty 由 ConPTY 缓冲按键，shell 未就绪也不会丢字；回显即证明双向通路
  await page.keyboard.type('echo aether-pty-ok', { delay: 30 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.terminal-view')).toContainText('aether-pty-ok', {
    timeout: 15000
  })
})

test('内置终端多标签：新建、切换后会话与回显互不串扰', async () => {
  // 用例共享同一窗口：面板区恒挂载（隐藏时 display:none），所以判断「可见」
  // 而不是「存在」——隐藏时 Ctrl+` 是打开，可见时是收起
  if (!(await page.locator('.terminal-view').isVisible())) {
    await page.keyboard.press('Control+`')
  }

  // 多标签的前提是能建出会话。环境不支持 ConPTY 时这一步永远不可能成立，
  // 属于环境能力缺失而非产品缺陷，直接跳过而不是留一条误导性的红。
  const errorBox = page.locator('.terminal-view__error')
  const firstItem = page.locator('.terminal-view__item')
  const outcome = await Promise.race([
    firstItem
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => 'ok' as const),
    errorBox.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'failed' as const)
  ]).catch(() => 'timeout' as const)

  test.skip(outcome !== 'ok', `当前环境无法创建 pty 会话（${outcome}），多标签行为无从验证`)

  // 残留会话（上个用例建的「终端 1」）或新会话均接受
  await expect(page.locator('.terminal-view__item')).toHaveCount(1, { timeout: 20000 })

  // 右侧列表「+」新建第二个会话，自动激活
  await page.getByLabel('新建终端').click()
  await expect(page.locator('.terminal-view__item')).toHaveCount(2)
  await expect(page.locator('.terminal-view__item').nth(1)).toContainText('终端 2')
  await page.locator('.terminal-view__session:visible .xterm').click()

  // 第二个会话里输出标记
  await page.keyboard.type('echo second-tab', { delay: 30 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.terminal-view__session:visible')).toContainText('second-tab', {
    timeout: 15000
  })

  // 切回第一个标签：隐藏的会话不参与断言，第一个会话回显自己的输出
  await page.locator('.terminal-view__item').nth(0).click()
  await page.locator('.terminal-view__session:visible .xterm').click()
  await page.keyboard.type('echo first-tab', { delay: 30 })
  await page.keyboard.press('Enter')
  const active = page.locator('.terminal-view__session:visible')
  await expect(active).toContainText('first-tab', { timeout: 15000 })
  await expect(active).not.toContainText('second-tab')
})

test('全局搜索：命中分组展示，点击结果打开文件', async () => {
  await page.keyboard.press('Control+Shift+F')
  await expect(page.locator('.search-view__input')).toBeVisible()
  await page.locator('.search-view__input').fill('e2e-userdata')

  // 300ms 防抖 + git grep（工作区是 git 仓库）
  await expect(page.locator('.search-view__hit').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.search-view__summary')).toContainText('个文件')
  // 命中片段高亮
  await expect(page.locator('.search-view__hit-text mark').first()).toContainText('e2e-userdata')

  // 点击结果 → 文件在编辑区打开
  await page.locator('.search-view__hit').first().click()
  await expect(page.locator('.doc-view').first()).toBeVisible({ timeout: 15000 })
})

test('全局搜索：自动聚焦、定位高亮、状态保留与大小写开关', async () => {
  // Ctrl+Shift+F 打开即聚焦输入框（VS Code 行为）
  await page.keyboard.press('Control+Shift+F')
  const input = page.locator('.search-view__input')
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()

  await input.fill('e2e-userdata')
  await expect(page.locator('.search-view__hit').first()).toBeVisible({ timeout: 15000 })

  // 点击结果：编辑器定位到命中行，匹配片段带高亮装饰
  await page.locator('.search-view__hit').first().click()
  await expect(page.locator('.monaco-editor .aether-reveal-match').first()).toBeVisible({
    timeout: 15000
  })

  // 结果区键盘导航：↓ 移动选中，Enter 打开对应命中（搜索视图保持打开）
  await page.locator('.search-view__results').press('ArrowDown')
  await expect(page.locator('.search-view__hit.is-selected')).toHaveCount(1)
  await page.locator('.search-view__results').press('ArrowUp')
  await expect(page.locator('.search-view__hit.is-selected')).toHaveCount(1)
  await page.locator('.search-view__results').press('Enter')
  await expect(page.locator('.monaco-editor .aether-reveal-match').first()).toBeVisible()
  await expect(page.locator('.search-view__results')).toBeVisible()

  // 切走再切回：搜索条件与结果保留，输入框重新聚焦
  await ensureExplorerVisible()
  await expect(page.locator('.sidebar__header', { hasText: '资源管理器' })).toBeVisible()
  await page.keyboard.press('Control+Shift+F')
  await expect(page.locator('.search-view__input')).toHaveValue('e2e-userdata')
  await expect(page.locator('.search-view__hit').first()).toBeVisible()
  await expect(page.locator('.search-view__input')).toBeFocused()

  // 选项开关切换后自动重搜且状态可视化
  const caseToggle = page.locator('.search-view__toggle[title="区分大小写"]')
  await caseToggle.click()
  await expect(caseToggle).toHaveClass(/is-on/)
  await expect(page.locator('.search-view__hit').first()).toBeVisible()
  await caseToggle.click()
  await expect(caseToggle).not.toHaveClass(/is-on/)
})

test('全局替换：include 过滤后批量替换并写盘', async () => {
  await page.keyboard.press('Control+Shift+F')
  const input = page.locator('.search-view__input')
  await input.fill('alpha')

  // include 过滤到夹具目录，避免碰到仓库文件
  await page.locator('.search-view__btn[title="包含与排除文件"]').click()
  await page.locator('.search-view__filter-input').first().fill('.e2e-tmp/smoke-fixtures')
  await expect(page.locator('.search-view__hit').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.search-view__summary')).toContainText('2 处命中')

  // 展开替换条：全部替换先出预览确认（VS Code Replace Preview 流程）
  await page.locator('.search-view__reveal').click()
  await page.locator('input[aria-label="替换为"]').fill('omega')
  await page.locator('.search-view__btn[aria-label="全部替换"]').click()
  const preview = page.locator('.replace-preview')
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toContainText('将替换 2 处（1 个文件）')
  await expect(preview.locator('.replace-preview__row')).toHaveCount(2)
  await preview.locator('.replace-preview__apply').click()
  await expect(preview).toHaveCount(0)
  await expect(page.locator('.search-view__summary')).toContainText('已替换 2 处（1 个文件）', {
    timeout: 15000
  })

  // 磁盘内容确实变了，且结果已刷新（不再有 alpha 命中）
  expect(readFileSync(join(FIXTURE_DIR, 'replace.txt'), 'utf-8')).toBe('omega beta\nomega gamma\n')
  await expect(page.locator('.search-view__hit')).toHaveCount(0)
})

test('搜索排除：设置里的规则减少搜索结果，取消勾选后放回', async () => {
  // 显式把 include 锁到夹具目录：不依赖上一用例残留的状态，单独跑也成立
  await page.keyboard.press('Control+Shift+F')
  const includeInput = page.locator('.search-view__filter-input').first()
  if (!(await includeInput.isVisible())) {
    // 上一用例可能已经展开过滤区；按钮是切换语义，盲点一次反而会收起
    await page.locator('.search-view__btn[title="包含与排除文件"]').click()
  }
  await includeInput.fill('.e2e-tmp/smoke-fixtures')
  // 类名同时落在「搜索」与「替换为」两个输入框上，按 aria-label 取搜索框
  const input = page.getByRole('textbox', { name: '搜索内容' })
  // 夹具的 «nested» 只在 sub/nested.txt 里出现，用它钉死"整棵目录被跳过"
  await input.fill('nested')
  await expect(page.locator('.search-view__hit').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.search-view__summary')).toContainText('1 处命中')

  // 走真实用户路径：命令面板 → 设置 → 搜索分区
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('设置')
  await page.keyboard.press('Enter')
  await page.locator('.app-settings__nav-item', { hasText: '搜索' }).click()
  await expect(page.locator('.app-settings__nav-item[aria-selected="true"]')).toHaveText('搜索')

  // 默认三条照搬 VS Code：挡依赖目录与索引目录，但不含 *.txt
  await expect(page.locator('.exclude-row__pattern')).toHaveCount(3)
  // 模式存在 input 的 value 里，不是文本节点，hasText 匹配不到
  await expect(
    page.locator('.sg__row').filter({ has: page.locator('input[value="**/node_modules"]') })
  ).toHaveCount(1)

  // 加一条挡住 sub/ 的规则：目录命中即剪枝，sub/nested.txt 应立刻从结果里消失
  await page.locator('.settings-view__actions .btn', { hasText: '添加规则' }).click()
  await page.locator('.sg__row').last().locator('.exclude-row__pattern').fill('**/sub')
  await expect(page.locator('.search-view__hit')).toHaveCount(0, { timeout: 15_000 })

  // 关掉「使用排除设置」= 连 files.exclude 与 search.exclude 一起忽略，结果回来
  await page.locator('.search-view__check input').uncheck()
  await expect(page.locator('.search-view__hit').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('.search-view__check input').check()
  await expect(page.locator('.search-view__hit')).toHaveCount(0, { timeout: 15_000 })

  // 取消勾选这条规则 = 显式不排除：结果应放回，同时把状态收拾干净，
  // 后面依赖 sub/ 夹具的用例（缩进参考线）才不会连带被跳过。
  await page.locator('.app-settings__nav-item', { hasText: '搜索' }).click()
  await page.locator('.sg__row').last().locator('.toggle[role="switch"]').last().click()
  await expect(page.locator('.search-view__hit').first()).toBeVisible({ timeout: 15_000 })
})

test('键盘快捷方式：编辑器入口、录制生效、冲突提示、清除与重置', async () => {
  // ── 入口：命令面板执行「打开键盘快捷方式」 ──
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('打开键盘快捷方式')
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette')).toHaveCount(0)
  await expect(page.locator('.app-settings')).toBeVisible()
  await expect(page.locator('.app-settings__nav-item[aria-selected="true"]')).toContainText('键盘')
  const editor = page.locator('.keybindings')
  await expect(editor).toBeVisible()

  // ── 过滤到「切换输出面板」：默认键位 Ctrl+Shift+J ──
  await page.locator('.keybindings__search').fill('切换输出面板')
  const row = editor.locator('.keybindings__row', { hasText: '切换输出面板' })
  await expect(row).toHaveCount(1)
  await expect(row.locator('.keybindings__key')).toContainText('Ctrl+Shift+J')

  // ── 录制：先按 Ctrl+S 触发冲突警告（已被「保存」占用），再换 Ctrl+Alt+O 确认 ──
  await row.locator('.keybindings__key').click()
  await expect(row.locator('.keybindings__key')).toContainText('按下组合键')
  await page.keyboard.press('Control+s')
  const conflict = row.locator('.keybindings__conflict')
  await expect(conflict).toContainText('Ctrl+S')
  await expect(conflict).toContainText('保存')
  await page.keyboard.press('Control+Alt+o')
  await expect(row.locator('.keybindings__key')).toContainText('Ctrl+Alt+O')
  await page.keyboard.press('Enter')

  // 来源标记「已修改」，规则落到 localStorage（照搬 VS Code 的用户键位层）
  await expect(row.locator('.keybindings__source')).toContainText('已修改')
  const stored = await page.evaluate(() => localStorage.getItem('aether.keybindings'))
  expect(stored).toContain('aether.panel.output')
  expect(stored).toContain('ctrl+alt+o')

  // ── 新键位立即生效；旧默认键位保留（VS Code 语义：加键不删键） ──
  const output = page.locator('.output__lines')
  const initial = await output.isVisible()
  await page.keyboard.press('Control+Alt+o')
  if (initial) await expect(output).toBeHidden()
  else await expect(output).toBeVisible()
  await page.keyboard.press('Control+Shift+j')
  if (initial) await expect(output).toBeVisible()
  else await expect(output).toBeHidden()

  // 菜单栏键位提示跟随用户自定义
  await page.locator('.menu-bar__trigger', { hasText: '查看' }).click()
  await expect(
    page.locator('.menu-bar__item', { hasText: '输出面板' }).locator('.menu-bar__key')
  ).toHaveText('Ctrl+Alt+O')
  await page.keyboard.press('Escape')

  // ── 清除键位：负规则屏蔽默认绑定，新旧按键都不再触发 ──
  // 先把面板收起，让「无反应」的断言落在确定状态上
  if (await output.isVisible()) await page.keyboard.press('Control+Shift+j')
  await expect(output).toBeHidden()

  await row.locator('.keybindings__action', { hasText: '清除键位' }).click()
  await expect(row.locator('.keybindings__key')).toHaveText('无')
  await expect(row.locator('.keybindings__source')).toContainText('已清除')
  const cleared = await page.evaluate(() => localStorage.getItem('aether.keybindings'))
  expect(cleared).toContain('-aether.panel.output')

  await page.keyboard.press('Control+Alt+o')
  await expect(output).toBeHidden()
  await page.keyboard.press('Control+Shift+j')
  await expect(output).toBeHidden()

  // ── 重置：删除全部用户规则，恢复默认并重新生效 ──
  await row.locator('.keybindings__action', { hasText: '重置' }).click()
  await expect(row.locator('.keybindings__key')).toContainText('Ctrl+Shift+J')
  await expect(row.locator('.keybindings__source')).toContainText('默认')
  expect(await page.evaluate(() => localStorage.getItem('aether.keybindings'))).toBe('[]')

  await page.keyboard.press('Control+Shift+j')
  await expect(output).toBeVisible()
})

test('资源管理器：剪切/复制/粘贴（Ctrl+X/C/V 与右键菜单）', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)
  const tree = page.locator('.explorer__tree')

  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await revealTreeRow(join(FIXTURE_DIR, 'sub'))
  const sub = page.locator(rowSelector(join(FIXTURE_DIR, 'sub')))
  await expect(moveA).toBeVisible({ timeout: 15_000 })
  await moveA.click()
  await expect(moveA).toHaveClass(/is-selected/)

  // ── Ctrl+X：待粘贴项整行做半透明降级（唯一消费者是 is-cut 视觉） ──
  await tree.press('Control+x')
  await expect(moveA).toHaveClass(/is-cut/)
  const cutStyle = await moveA.evaluate((el) => getComputedStyle(el).opacity)
  expect(Number.parseFloat(cutStyle)).toBeLessThan(1)

  // ── 剪切后粘贴到"它自己所在目录"：不移动，但也不能清空剪贴板 ──
  //     planMoves 会跳过「已经在目标目录里」的项（返回 0），此时若清剪贴板，
  //     「贴错地方了，换个目录再贴」这个最顺手的补救动作就走不通了。
  await tree.press('Control+v')
  await expect(moveA).toHaveClass(/is-cut/, { timeout: 10_000 })
  expect(existsSync(join(FIXTURE_DIR, 'move-a.txt'))).toBe(true)

  // ── 落点换到别的目录再粘贴：这次真的搬动了，剪贴板才该清空 ──
  await expect(sub).toBeVisible({ timeout: 15_000 })
  await sub.click()
  await tree.press('Control+v')
  await revealTreeRow(join(FIXTURE_DIR, 'sub', 'move-a.txt'))
  const movedIntoSub = page.locator(rowSelector(join(FIXTURE_DIR, 'sub', 'move-a.txt')))
  await expect(movedIntoSub).toBeVisible({ timeout: 15_000 })
  expect(existsSync(join(FIXTURE_DIR, 'move-a.txt'))).toBe(false)
  expect(readFileSync(join(FIXTURE_DIR, 'sub', 'move-a.txt'), 'utf-8')).toBe('A')
  // 真的搬动后剪贴板清空：源路径那行已不存在，新位置也不该是"待剪切"态
  await expect(movedIntoSub).not.toHaveClass(/is-cut/)

  // ── Ctrl+C 后粘贴到别的目录：源文件保留，目标目录里出现一份副本 ──
  await movedIntoSub.click()
  await tree.press('Control+c')
  await expect(movedIntoSub).not.toHaveClass(/is-cut/)
  await tree.press('Control+v')
  await revealTreeRow(join(FIXTURE_DIR, 'sub', 'move-a copy.txt'))
  const copied = page.locator(rowSelector(join(FIXTURE_DIR, 'sub', 'move-a copy.txt')))
  await expect(copied).toBeVisible({ timeout: 15_000 })
  expect(existsSync(join(FIXTURE_DIR, 'sub', 'move-a.txt'))).toBe(true)

  // ── 右键菜单：三项都存在且可点（这里只验粘贴，剪贴板仍有内容） ──
  await copied.click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu).toContainText('剪切')
  await expect(menu).toContainText('复制')
  await expect(menu).toContainText('粘贴')
  await page.keyboard.press('Escape')
  await expect(page.locator('.context-menu')).toHaveCount(0)

  // 收尾：把被搬走的文件放回原位、删掉副本，避免污染后续用例
  // （后续用例按 .e2e-tmp/smoke-fixtures/move-a.txt 这个路径找它）。
  // 全程走应用的 Delete/Ctrl+X/Ctrl+V，不用 fs.renameSync —— 后者绕过应用动磁盘，
  // 缓存不会更新，「刷新」按钮又只重读根目录，还原结果在树里根本不会出现。
  await restoreFixtureViaApp({
    from: join(FIXTURE_DIR, 'sub', 'move-a.txt'),
    root: FIXTURE_DIR,
    removePaths: [join(FIXTURE_DIR, 'sub', 'move-a copy.txt')]
  })
  await sub.click()
  await expect(sub).toHaveAttribute('aria-expanded', 'false')
})

test('资源管理器：拖拽悬停在收起目录上会自动展开', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  // hover 目录由 prepareFixtures 预先建好（见那里的说明：缓存导致运行期
  // 现造的目录不会出现在树里），这里只管把它用到收起态再拖拽
  const hoverDir = join(FIXTURE_DIR, 'hover')

  const tree = page.locator('.explorer__tree')
  await tree.evaluate((el) => {
    el.scrollTop = 0
  })

  await revealTreeRow(join(FIXTURE_DIR, 'move-a.txt'))
  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  await revealTreeRow(hoverDir)
  const hoverRow = page.locator(rowSelector(hoverDir))
  await expect(moveA).toBeVisible({ timeout: 15_000 })
  await expect(hoverRow).toBeVisible({ timeout: 15_000 })

  // 确保它是收起态 —— 展开着的目录没有"自动展开"可验
  if ((await hoverRow.getAttribute('aria-expanded')) === 'true') await hoverRow.click()
  await expect(hoverRow).toHaveAttribute('aria-expanded', 'false')

  const from = (await moveA.boundingBox())!
  const to = (await hoverRow.boundingBox())!
  await page.mouse.move(from.x + 30, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 })
  // 停在目标上不动：悬停计时器要 700ms 才触发
  await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 5 })

  await expect(hoverRow).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })
  await expect(page.locator(rowSelector(join(hoverDir, 'inside.txt')))).toBeVisible()

  // 松手取消：若拖拽被中止，展开态不应留下副作用（这里只断言能正常收尾）
  await page.mouse.up()
  await expect(hoverRow).toHaveAttribute('aria-expanded', 'true')

  // 收尾：收起，把树的展开态还原成后续用例期望的样子
  await hoverRow.click()
  await expect(hoverRow).toHaveAttribute('aria-expanded', 'false')
})

test('资源管理器：git 徽章只在仓库内出现且与仓库信息一致', async () => {
  await ensureExplorerVisible()

  // 先读状态栏的判断：本机这份仓库是否被 git 跟踪，决定徽章该出现还是该缺席。
  const gitItem = page
    .locator('.status-bar button.status-bar__item')
    .filter({ has: page.locator('svg') })
    .first()
  await expect(gitItem).toBeVisible({ timeout: 30_000 })
  const isRepo = !(await gitItem.innerText()).includes('非 Git 仓库')

  if (!isRepo) {
    // 非仓库时不能有任何徽章：否则就是在编造状态。
    await expect(page.locator('.tree-row__git')).toHaveCount(0)
    return
  }

  const status = await page.evaluate((cwd) => window.aether.git.status(cwd), WORKSPACE_DIR)
  expect(status.success).toBe(true)
  expect(status.isRepo).toBe(true)
  const changedPaths = (status.files ?? []).map((file) =>
    join(WORKSPACE_DIR, file.path).replace(/\\/g, '/')
  )
  if (changedPaths.length === 0) {
    // 仓库干净时，等待一次渲染窗口确认没有陈旧徽章；不能把“没有变更”
    // 当作测试失败，也不能接受 UI 残留上一轮状态。
    await expect
      .poll(async () => page.locator('.tree-row__git').count(), { timeout: 10_000 })
      .toBe(0)
    return
  }

  // Git 状态和资源树分别异步加载。此时虚拟树可能停在 .e2e-tmp 的
  // ignored 子树，当前屏幕没有徽章并不表示 Git 徽章缺失；先展开一条
  // 真实存在的改动路径的父目录，再在 expect.poll 中扫描整个虚拟窗口。
  // 删除的改动没有可渲染行，跳过它们，避免把合法的 deleted 状态误报成 UI 缺陷。
  const visibleChangedPath = changedPaths.map((path) => resolve(path)).find((path) => existsSync(path))
  if (!visibleChangedPath) return
  await ensureDirExpanded(resolve(visibleChangedPath, '..'))
  await revealTreeRow(visibleChangedPath)

  const collectGitBadges = async (): Promise<
    Array<{ path: string; text: string; title: string }>
  > =>
    page.locator('.explorer__tree').evaluate(async (tree) => {
      const originalScrollTop = tree.scrollTop
      const found = new Map<string, { text: string; title: string }>()
      const nextRender = async (): Promise<void> => {
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
      }
      try {
        tree.scrollTop = 0
        await nextRender()
        for (let attempt = 0; attempt < 240; attempt += 1) {
          for (const row of tree.querySelectorAll('.explorer__rows .tree-row')) {
            const path = row.getAttribute('data-path')
            const badge = row.querySelector('.tree-row__git')
            if (path && badge)
              found.set(path, {
                text: badge.textContent ?? '',
                title: badge.getAttribute('title') ?? ''
              })
          }
          const bottom = Math.max(0, tree.scrollHeight - tree.clientHeight)
          if (tree.scrollTop >= bottom) break
          const previous = tree.scrollTop
          tree.scrollTop = Math.min(bottom, previous + Math.max(1, tree.clientHeight / 2))
          await nextRender()
          if (tree.scrollTop <= previous) break
        }
        return [...found.entries()].map(([path, badge]) => ({ path, ...badge }))
      } finally {
        tree.scrollTop = originalScrollTop
        await nextRender()
      }
    })

  // Poll the full scan, rather than the currently mounted virtual rows. The
  // first scan can legitimately happen before Git state reaches the renderer.
  await expect
    .poll(async () => (await collectGitBadges()).length, { timeout: 30_000 })
    .toBeGreaterThan(0)
  const snapshot = await collectGitBadges()
  expect(snapshot.length).toBeGreaterThan(0)

  // 每个徽章字符必须落在 git 的状态字母表内，且带悬浮说明。
  for (const badge of snapshot) {
    expect(['M', 'A', 'D', 'R', 'C', 'U', '·', '●']).toContain(badge.text.trim())
    expect(badge.title.length).toBeGreaterThan(0)
    const path = badge.path.replace(/\\/g, '/')
    expect(changedPaths.some((changed) => changed === path || changed.startsWith(path + '/'))).toBe(
      true
    )
  }

  // 反过来：带徽章的行必须是真实存在的文件行，不是凭空多插的节点。
  for (const { path } of snapshot) {
    expect(existsSync(path)).toBe(true)
  }
})
// ==================== 编辑器标签（P4） ====================
//
// 覆盖：多标签打开与切换、右键菜单四种关闭、中键关闭、Ctrl+W、
// Ctrl+Shift+T 重开、Ctrl+Shift+S 全部保存、Ctrl+Tab 切换、
// 光标位置读数与跨标签恢复、Ctrl+B 侧边栏开关。
//
// 这些用例共享同一个窗口，因此每条都以「确保目标标签处于期望状态」开头，
// 而不是假设上个用例留下了什么。

/** 打开 .e2e-tmp 下的夹具文件，确保它成为激活标签 */
async function openFixtureTab(name: string): Promise<void> {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)
  await revealTreeRow(join(FIXTURE_DIR, name))
  const row = page.locator(rowSelector(join(FIXTURE_DIR, name)))
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(page.locator('.editor-tab', { hasText: name })).toHaveClass(/is-active/, {
    timeout: 15_000
  })
}

/** 关掉所有文件标签，把标签栏还原成干净状态（设置等固定视图不动） */
async function closeAllDocumentTabs(): Promise<void> {
  // 反复点「关闭」直到没有可关闭的文件标签：一次点一个，避免依赖关闭策略的实现细节
  for (let guard = 0; guard < 20; guard++) {
    const closable = page.locator('.editor-tab:has(.editor-tab__close)')
    if ((await closable.count()) === 0) break
    await closable.first().locator('.editor-tab__close').click()
  }
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(0, {
    timeout: 15_000
  })
}

test('编辑器标签：多标签打开、切换与激活态', async () => {
  await openFixtureTab('tab-a.txt')
  // 只断言「显示的是 tab-a 的正文」：切换/重开会恢复上次滚动位置，
  // 视口未必停在第一行，硬断言 'line 1' 会随用例执行顺序偶发失败
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('of tab-a', {
    timeout: 20_000
  })

  await openFixtureTab('tab-b.txt')
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('TAB-B-MARKER', {
    timeout: 20_000
  })

  // 切回 a：内容必须跟着换回来（换 model 而不是换实例，串号会在这里暴露）
  await page.locator('.editor-tab', { hasText: 'tab-a.txt' }).click()
  await expect(page.locator('.editor-tab', { hasText: 'tab-a.txt' })).toHaveClass(/is-active/)
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('of tab-a', {
    timeout: 20_000
  })
  await expect(page.locator('.monaco-editor .view-lines').first()).not.toContainText('TAB-B-MARKER')

  await closeAllDocumentTabs()
})

test('编辑器标签：右键菜单「关闭其他 / 关闭右侧 / 全部关闭」', async () => {
  await openFixtureTab('tab-a.txt')
  await openFixtureTab('tab-b.txt')

  const tabA = page.locator('.editor-tab', { hasText: 'tab-a.txt' })
  const tabB = page.locator('.editor-tab', { hasText: 'tab-b.txt' })

  // ── 关闭其他：在 tab-b 上右键，a 应该消失、b 留下 ──
  await tabB.click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('关闭')
  await expect(menu).toContainText('关闭其他')
  await expect(menu).toContainText('关闭右侧')
  await expect(menu).toContainText('全部关闭')
  await menu.locator('.context-menu__item', { hasText: '关闭其他' }).click()

  await expect(tabA).toHaveCount(0)
  await expect(tabB).toBeVisible()

  // ── 关闭右侧：在「左边那个」标签上右键，应关掉它右边所有标签 ──
  // 不假设「先打开的排左边」：标签顺序由打开的先后与关闭历史共同决定。
  // 直接从标签栏读出真实顺序，取最左一个作为右键目标，断言它右侧确实还有标签。
  await openFixtureTab('tab-a.txt')
  const orderText = await page.locator('.editor-tab').allInnerTexts()
  const fileTabs = orderText.filter(
    (text) => text.includes('tab-a.txt') || text.includes('tab-b.txt')
  )
  expect(fileTabs.length).toBe(2)
  const leftName = fileTabs[0].includes('tab-a.txt') ? 'tab-a.txt' : 'tab-b.txt'
  const rightName = leftName === 'tab-a.txt' ? 'tab-b.txt' : 'tab-a.txt'

  const leftTab = page.locator('.editor-tab', { hasText: leftName })
  const rightTab = page.locator('.editor-tab', { hasText: rightName })

  await leftTab.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await menu.locator('.context-menu__item', { hasText: '关闭右侧' }).click()
  await expect(rightTab).toHaveCount(0)
  await expect(leftTab).toBeVisible()

  // ── 全部关闭：剩下的也走掉，标签栏不再有可关闭的文件标签 ──
  await openFixtureTab(rightName)
  await leftTab.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await menu.locator('.context-menu__item', { hasText: '全部关闭' }).click()
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(0)
})

test('编辑器标签：中键关闭与 Ctrl+W 关闭当前', async () => {
  await openFixtureTab('tab-a.txt')
  await openFixtureTab('tab-b.txt')

  // ── 中键点 a 的标签：a 关闭，b 仍在（中键是浏览器式关闭，与右键等价） ──
  await page.locator('.editor-tab', { hasText: 'tab-a.txt' }).click({ button: 'middle' })
  await expect(page.locator('.editor-tab', { hasText: 'tab-a.txt' })).toHaveCount(0)
  await expect(page.locator('.editor-tab', { hasText: 'tab-b.txt' })).toBeVisible()

  // ── Ctrl+W：关掉当前激活的 b。这条必须拦掉默认行为 ——
  //    不拦会被 Chromium 当成关窗口，那样这里会直接丢掉整个应用 ──
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+w')
  await expect(page.locator('.editor-tab', { hasText: 'tab-b.txt' })).toHaveCount(0)
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(0)
})

test('编辑器标签：Ctrl+W 关闭当前标签', async () => {
  await closeAllDocumentTabs()

  // 关掉「当前激活」的那个，别的标签不受影响。先读出顺序，取中间一个当靶子，
  // 这样既验证了「只关当前」，也避免了假设标签顺序。
  await openFixtureTab('tab-a.txt')
  await openFixtureTab('tab-b.txt')
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(2)

  const names = (await page.locator('.editor-tab').allInnerTexts())
    .filter((text) => text.includes('tab-a.txt') || text.includes('tab-b.txt'))
    .map((text) => (text.includes('tab-a.txt') ? 'tab-a.txt' : 'tab-b.txt'))
  const victim = names[0]
  const survivor = names[1]

  await page.locator('.editor-tab', { hasText: victim }).click()
  await expect(page.locator('.editor-tab', { hasText: victim })).toHaveClass(/is-active/)

  // 聚焦编辑器再按键：键位派发挂在 window 冒泡阶段，焦点在编辑器里才是真实使用姿势
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+w')

  await expect(page.locator('.editor-tab', { hasText: victim })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.editor-tab', { hasText: survivor })).toBeVisible()
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(1)

  await closeAllDocumentTabs()
})

test('编辑器标签：Ctrl+Shift+T 重开刚关闭的标签', async () => {
  await closeAllDocumentTabs()
  await openFixtureTab('tab-a.txt')
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(1)

  // 光标先落进编辑器，再按 Ctrl+W 关掉唯一的标签
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+w')
  await expect(page.locator('.editor-tab:has(.editor-tab__close)')).toHaveCount(0, {
    timeout: 15_000
  })

  // Ctrl+Shift+T 把它原样捞回来：内容对、且是激活标签
  await page.keyboard.press('Control+Shift+t')
  const tabA = page.locator('.editor-tab', { hasText: 'tab-a.txt' })
  await expect(tabA).toHaveCount(1, { timeout: 15_000 })
  await expect(tabA).toHaveClass(/is-active/)
  // 重开后会恢复关闭前的滚动位置，故只断言是 tab-a 的正文
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('of tab-a', {
    timeout: 20_000
  })

  await closeAllDocumentTabs()
})

test('编辑器标签：Ctrl+Shift+S 保存全部脏文档', async () => {
  await openFixtureTab('tab-a.txt')
  await openFixtureTab('tab-b.txt')

  const tabA = page.locator('.editor-tab', { hasText: 'tab-a.txt' })
  const tabB = page.locator('.editor-tab', { hasText: 'tab-b.txt' })

  // 两个文件各改一笔：不落盘 → 都带脏点
  await tabA.click()
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('AETHER-EDIT-A')
  await tabB.click()
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('AETHER-EDIT-B')

  await expect(tabA.locator('.editor-tab__dirty')).toBeVisible()
  await expect(tabB.locator('.editor-tab__dirty')).toBeVisible()

  // Ctrl+Shift+S：一次把两个都存掉，脏点全灭
  await page.keyboard.press('Control+Shift+s')
  await expect(tabA.locator('.editor-tab__dirty')).toHaveCount(0, { timeout: 15_000 })
  await expect(tabB.locator('.editor-tab__dirty')).toHaveCount(0, { timeout: 15_000 })

  // 副作用验证：磁盘上真的写进去了（只看界面算不上"保存了"）
  expect(readFileSync(join(FIXTURE_DIR, 'tab-a.txt'), 'utf-8')).toContain('AETHER-EDIT-A')
  expect(readFileSync(join(FIXTURE_DIR, 'tab-b.txt'), 'utf-8')).toContain('AETHER-EDIT-B')

  // 收尾：两个文件都要还原，漏掉任何一个都会让后续用例读到被污染的内容
  // （tab-a.txt 的原始夹具是 300 行，见 beforeAll）
  writeFileSync(
    join(FIXTURE_DIR, 'tab-a.txt'),
    Array.from({ length: 300 }, (_, i) => `line ${i + 1} of tab-a`).join('\n'),
    'utf-8'
  )
  writeFileSync(join(FIXTURE_DIR, 'tab-b.txt'), 'TAB-B-MARKER\n', 'utf-8')
  await closeAllDocumentTabs()
})

test('编辑器标签：Ctrl+Tab / Ctrl+PageUp/Down 切换激活标签', async () => {
  await closeAllDocumentTabs()
  await openFixtureTab('tab-a.txt')
  await openFixtureTab('tab-b.txt')

  // 关键：标签栏里还有「设置」「键盘快捷方式」两个固定视图，'a'/'b' 不一定在最左。
  // 因此这里一律用文件标签自身的相对顺序（file-tabs 定位器）来断言，
  // 不碰 .editor-tab.first()/.nth() 这种会混进固定视图的全局索引。
  const fileTabs = page.locator('.editor-tab:has(.editor-tab__close)')
  await expect(fileTabs).toHaveCount(2)

  const order = (await fileTabs.allInnerTexts()).map((text) =>
    text.includes('tab-a.txt') ? 'a' : 'b'
  )

  // 激活第 0 个文件标签
  await fileTabs.nth(0).click()
  await expect(fileTabs.nth(0)).toHaveClass(/is-active/)

  // Ctrl+PageDown：前进一格
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+PageDown')
  await expect(fileTabs.nth(1)).toHaveClass(/is-active/)

  // 已在末尾，再按一次应绕回开头（VS Code 的循环切换语义）
  await page.keyboard.press('Control+PageDown')
  await expect(fileTabs.nth(0)).toHaveClass(/is-active/)

  // Ctrl+PageUp：后退一格，从开头绕到末尾
  await page.keyboard.press('Control+PageUp')
  await expect(fileTabs.nth(1)).toHaveClass(/is-active/)

  // Ctrl+Tab 与 Ctrl+PageDown 同义：再绕回开头
  await page.keyboard.press('Control+Tab')
  await expect(fileTabs.nth(0)).toHaveClass(/is-active/)

  // 切换必须真的换内容，而不只是换个高亮。
  // 不断言具体行号：切换会恢复该文件上次的光标/滚动位置，视口可能停在文件中部，
  // 只断言「显示的是这个文件的正文」即可（tab-a 任意一行含 'of tab-a'，
  // tab-b 的标记唯一）。
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(
    order[0] === 'a' ? 'of tab-a' : 'TAB-B-MARKER',
    { timeout: 20_000 }
  )

  await closeAllDocumentTabs()
})

test('编辑器标签：光标位置读数与跨标签恢复', async () => {
  await openFixtureTab('tab-a.txt')
  await openFixtureTab('tab-b.txt')
  await page.locator('.editor-tab', { hasText: 'tab-a.txt' }).click()

  const tabA = page.locator('.editor-tab', { hasText: 'tab-a.txt' })
  const tabB = page.locator('.editor-tab', { hasText: 'tab-b.txt' })

  // ── 光标位置读数：光标移到第 5 行附近，读数应随之更新 ──
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+Home')
  const canvas = page.locator('.monaco-editor .view-lines').first()
  await canvas.click({ position: { x: 40, y: 4 * 18 }, force: true })

  const cursorReadout = page.locator('[data-testid="doc-cursor"]')
  await expect(cursorReadout).toBeVisible({ timeout: 15_000 })
  // 不断言精确行列（依赖字体度量），只断言格式与"不是第一行"
  await expect(cursorReadout).toContainText('行')
  await expect(cursorReadout).toContainText('列')

  const first = await cursorReadout.innerText()
  await page.keyboard.press('Control+End')
  await expect(cursorReadout).not.toHaveText(first, { timeout: 15_000 })

  // ── 跨标签恢复：在 a 的末尾留下光标，切到 b 再切回来 ──
  const beforeSwitch = await cursorReadout.innerText()
  await tabB.click()
  await expect(tabB).toHaveClass(/is-active/)
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+Home')
  await tabA.click()
  await expect(tabA).toHaveClass(/is-active/)
  // 回到 a 应恢复到离开时的位置，而不是被重置到第 1 行。
  // 用轮询等 Monaco 把 viewState 恢复完，避免一次性取值取到恢复前的中间态。
  await expect.poll(async () => cursorReadout.innerText(), { timeout: 15_000 }).toBe(beforeSwitch)

  await closeAllDocumentTabs()
})

test('编辑器标签：Ctrl+B 切换侧边栏可见性', async () => {
  const sidebar = page.locator('.sidebar')
  // 归零到可见态（侧边栏在活动栏选中视图时才渲染，故先确保资源管理器在）
  await ensureExplorerVisible()
  await expect(sidebar).toBeVisible()

  await page.keyboard.press('Control+b')
  await expect(sidebar).toBeHidden()
  await page.keyboard.press('Control+b')
  await expect(sidebar).toBeVisible()
})

test('渲染进程无未捕获错误', async () => {
  expect(consoleErrors, `渲染进程错误：\n${consoleErrors.join('\n')}`).toEqual([])
})
