import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 冒烟测试：验证 P0/P1 的关键链路在真实 Electron 环境下能跑通。
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
const FIXTURE_DIR = join(APP_ROOT, '.e2e-tmp')

/**
 * 生成「按绝对路径精确匹配某一行」的 CSS 选择器。
 *
 * 必须转义反斜杠：CSS 属性选择器里的 `\` 是转义引导符，
 * 直接写 [data-path="D:\my\...\src"] 会被解析成转义序列而匹配不到任何行
 * （`\.v` 恰好等于 `v`，所以 `.vscode` 这类路径会"碰巧"命中，掩盖问题）。
 * 转义后 \\ 表示一个真实的反斜杠，选择器语义与字符串精确相等一致。
 */
function rowSelector(target: string): string {
  return `.tree-row[data-path="${target.replace(/\\/g, '\\\\')}"]`
}

/** 目录的子项计数选择器：路径分隔符同样需要转义 */
function descendantSelector(dir: string): string {
  return `.tree-row[data-path^="${dir.replace(/\\/g, '\\\\')}\\\\"]`
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
 * 确保某个目录处于展开状态。
 *
 * 点一下目录是「切换」而不是「打开」：用例之间共享同一个窗口，
 * 上一个用例可能已经把它展开过，无脑再点一次反而会折叠。
 * 这里按状态幂等，避免用例之间的执行顺序变成隐式依赖。
 */
async function ensureDirExpanded(dir: string): Promise<void> {
  const row = page.locator(rowSelector(dir))
  await expect(row).toBeVisible({ timeout: 15_000 })
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

function prepareUserData(): string {
  const dir = join(tmpdir(), 'aether-ide-e2e-userdata')
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

  await page.waitForSelector('.workbench')
})

test.afterAll(async () => {
  await app?.close()
  // 夹具是测试自己造的，收尾删掉，避免污染仓库
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

test('工作台骨架渲染：菜单栏、活动栏、侧边栏、主区、对话面板、状态栏均存在', async () => {
  await expect(page.locator('.menu-bar')).toBeVisible()
  await expect(page.locator('.activity-bar')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.editor-area')).toBeVisible()
  await expect(page.locator('.chat-panel')).toBeVisible()
  await expect(page.locator('.status-bar')).toBeVisible()

  // 主区固定视图标签（对话已移至右侧常驻面板，不再占主区标签）
  await expect(page.locator('.editor-tab', { hasText: '模型' })).toBeVisible()
  await expect(page.locator('.sec-picker__trigger')).toBeVisible()
})

test('资源管理器：恢复上次打开的文件夹并列出文件', async () => {
  await expect(page.locator('.explorer__root')).toContainText('aether-code')

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
  const modeTrigger = page.locator('.sec-picker__trigger')
  await expect(modeTrigger).toBeEnabled()
  await modeTrigger.click()
  await expect(page.locator('.sec-picker__item')).toHaveCount(3)

  // 切一次并确认状态是一致的：若 PUT 被引擎拒绝，store 会回滚成原模式
  await page.locator('.sec-picker__item', { hasText: '标准模式' }).click()
  await expect(modeTrigger).toContainText('标准模式')

  await modeTrigger.click()
  await expect(page.locator('.sec-picker__item', { hasText: '标准模式' })).toContainText('当前')
  await page.keyboard.press('Escape')
  await expect(page.locator('.sec-picker__popup')).toHaveCount(0)

  await page.locator('.editor-tab', { hasText: '安全' }).click()

  // 三种模式都要出现（缺 sessionId 时只是禁用，不应消失）
  await expect(page.locator('.mode-item')).toHaveCount(3)
  await expect(page.locator('.mode-item', { hasText: '完全访问' })).toBeVisible()

  // 安全页挂载时会重新向引擎 GET 模式，能读到刚才写入的 standard，
  // 才算证明了这一步真的落到引擎（只看界面变化不足为凭）
  await expect(page.locator('.mode-item', { hasText: '标准模式' }).locator('input')).toBeChecked()

  // 规则来自引擎，内置兜底规则必然存在
  await expect
    .poll(async () => page.locator('.policy-item').count(), { timeout: 30_000 })
    .toBeGreaterThan(0)

  // 每条规则都有动作下拉，这是「消除反复打断」的实际控制点
  await expect(page.locator('.policy-item__action').first()).toBeVisible()
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

test('资源管理器：右键新建文件后出现在树中', async () => {
  await page.locator('.tree-row', { hasText: '.e2e-tmp' }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()

  // Electron 没有 window.prompt，这里验证的是自建对话框真的接上了
  const input = page.locator('.modal--prompt input')
  await expect(input).toBeVisible()
  await input.fill('created.txt')
  await page.locator('.modal--prompt .btn--primary').click()

  await expect(page.locator('.tree-row', { hasText: 'created.txt' })).toBeVisible({
    timeout: 15_000
  })
  // 同目录的夹具文件也应可见：说明新建后目录已被展开，用户能看到结果
  await expect(page.locator('.tree-row', { hasText: 'fixture.bin' })).toBeVisible()
})

test('资源管理器：多选（Ctrl 加选、Shift 连选、Ctrl+A 全选、Esc 清除）', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
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

test('资源管理器：拖拽把多选项移入目标目录，Ctrl+Z 撤销回滚', async () => {
  await ensureExplorerVisible()
  await ensureDirExpanded(FIXTURE_DIR)

  const moveA = page.locator(rowSelector(join(FIXTURE_DIR, 'move-a.txt')))
  const moveB = page.locator(rowSelector(join(FIXTURE_DIR, 'move-b.txt')))
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
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'big', 'item-000.txt')))).toBeVisible({
    timeout: 20_000
  })
  // 末尾的行远在视口之外，绝不该被挂载
  await expect(page.locator('.tree-row[data-path*="item-399"]')).toHaveCount(0)

  // big 目录里 400 项都已加载，但 DOM 里只应有可见的那几十行
  const rendered = await page.locator('.explorer__rows .tree-row').count()
  expect(rendered).toBeLessThan(100)
  expect(rendered).toBeGreaterThan(0)

  // 滚到底部：末尾的行替代开头的行出现，证明窗口随滚动位置移动
  const tree = page.locator('.explorer__tree')
  await tree.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.locator(rowSelector(join(FIXTURE_DIR, 'big', 'item-399.txt')))).toBeVisible({
    timeout: 10_000
  })
  await expect(page.locator('.tree-row[data-path*="item-000"]')).toHaveCount(0)

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
  const bigRow = page.locator(rowSelector(join(FIXTURE_DIR, 'big')))
  await expect(bigRow).toBeVisible()
  if ((await bigRow.getAttribute('aria-expanded')) === 'true') await bigRow.click()
  await expect(bigRow).toHaveAttribute('aria-expanded', 'false')
})

test('预览：PNG 走图片预览，未知二进制走十六进制', async () => {
  await ensureExplorerVisible()

  // 图片：resources/icon.png 是稳定的真实 PNG
  await ensureDirExpanded(join(APP_ROOT, 'resources'))
  const icon = page.locator(rowSelector(join(APP_ROOT, 'resources', 'icon.png')))
  await expect(icon).toBeVisible({ timeout: 15_000 })
  await icon.click()

  const image = page.locator('.preview__image')
  await expect(image).toBeVisible({ timeout: 20_000 })
  // PNG 魔数的 base64 前缀：证明送到 <img> 的是真实图片字节，而不是占位内容
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,iVBORw0KGgo/)
  await expect(page.locator('.preview__status')).toContainText('图片预览')

  // 十六进制：.e2e-tmp/fixture.bin 内容为 0x00..0x13。
  // 直接重新点开夹具目录，不依赖它在上一个用例结束时是否展开
  await ensureDirExpanded(FIXTURE_DIR)
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
  const gitItem = page.locator('.status-bar__item[title^="打开版本控制视图"]')
  await expect(gitItem).toBeVisible({ timeout: 30_000 })

  await gitItem.click()
  await expect(page.locator('.sidebar__header', { hasText: '版本控制' })).toBeVisible()
  await expect(page.locator('.sidebar .git-view')).toBeVisible()

  // 两种情况都要能自洽：本仓库不是 git 仓库时给出说明，
  // 若将来项目本身变成仓库，则必须给出改动与最近提交两个分区。
  const label = await gitItem.innerText()
  if (label.includes('非 Git 仓库')) {
    await expect(page.locator('.git-view')).toContainText('不是 git 仓库')
  } else {
    await expect(page.locator('.git-view')).toContainText('改动')
    await expect(page.locator('.git-view')).toContainText('最近提交')
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
  // PowerShell 冷启动可能较慢，放宽 xterm 就绪时限
  await expect(page.locator('.terminal-view .xterm')).toBeVisible({ timeout: 20000 })
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
  await page.locator('.search-view__filter-input').first().fill('.e2e-tmp')
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

test('键盘快捷方式：编辑器入口、录制生效、冲突提示、清除与重置', async () => {
  // ── 入口：命令面板执行「打开键盘快捷方式」 ──
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette__input').fill('打开键盘快捷方式')
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette')).toHaveCount(0)
  await expect(page.locator('.editor-tab', { hasText: '键盘快捷方式' })).toBeVisible()
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

test('渲染进程无未捕获错误', async () => {
  expect(consoleErrors, `渲染进程错误：\n${consoleErrors.join('\n')}`).toEqual([])
})
