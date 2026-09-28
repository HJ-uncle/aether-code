# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> 工作台骨架渲染：菜单栏、活动栏、侧边栏、主区、对话面板、状态栏均存在
- Location: e2e\smoke.spec.ts:257:5

# Error details

```
TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('.workbench') to be visible

```

# Test source

```ts
  144 |  * 不直接用 fs.renameSync 还原：测试里绕过应用动磁盘后，工作区缓存并不知情，
  145 |  * 「刷新」按钮又只重读根目录（refreshDirectory 只重读已缓存的目录）——
  146 |  * 于是还原回来的文件在树里永远不出现。走应用自己的键位则缓存 / 选区 / 树
  147 |  * 都会跟着更新。
  148 |  *
  149 |  * F2 只能"原地改名"，搬不动目录层级，所以这里用剪切 + 粘贴回根目录。
  150 |  */
  151 | async function restoreFixtureViaApp(opts: {
  152 |   /** 需要搬回根目录的源路径（当前所在位置） */
  153 |   from: string
  154 |   /** 根目录路径（粘贴落点） */
  155 |   root: string
  156 |   /** 要删掉的残留（副本等）；不传则只做搬移 */
  157 |   removePaths?: string[]
  158 | }): Promise<void> {
  159 |   const tree = page.locator('.explorer__tree')
  160 | 
  161 |   for (const path of opts.removePaths ?? []) {
  162 |     const row = page.locator(rowSelector(path))
  163 |     await expect(row).toBeVisible({ timeout: 15_000 })
  164 |     await row.click()
  165 |     await tree.press('Delete')
  166 |     await expect(row).toHaveCount(0, { timeout: 15_000 })
  167 |   }
  168 | 
  169 |   const source = page.locator(rowSelector(opts.from))
  170 |   await expect(source).toBeVisible({ timeout: 15_000 })
  171 |   await source.click()
  172 |   await tree.press('Control+x')
  173 |   await expect(source).toHaveClass(/is-cut/)
  174 | 
  175 |   // 落点：根目录那一行。点它把它设为光标行，粘贴才会落在根目录下
  176 |   const rootRow = page.locator(rowSelector(opts.root))
  177 |   await expect(rootRow).toBeVisible({ timeout: 15_000 })
  178 |   await rootRow.click()
  179 |   await tree.press('Control+v')
  180 | 
  181 |   await expect(page.locator(rowSelector(join(opts.root, 'move-a.txt')))).toBeVisible({
  182 |     timeout: 15_000
  183 |   })
  184 | }
  185 | 
  186 | function prepareUserData(): string {
  187 |   const dir = join(tmpdir(), 'aether-ide-e2e-userdata')
  188 |   rmSync(dir, { recursive: true, force: true })
  189 |   mkdirSync(dir, { recursive: true })
  190 | 
  191 |   // 预置 lastFolder：应用启动时会自动恢复并授权该目录。
  192 |   // 不能靠测试点击「打开文件夹」——那会弹出系统对话框，测试环境下无法交互。
  193 |   writeFileSync(
  194 |     join(dir, 'settings.json'),
  195 |     JSON.stringify(
  196 |       {
  197 |         engineMode: 'embedded',
  198 |         // 用独立端口：开发机常驻的 IDE 实例占着默认端口 12323，
  199 |         // 测试实例会探测到并复用其引擎（不启动新进程、无「已启动」日志）
  200 |         preferredPort: 12399,
  201 |         remoteBaseUrl: '',
  202 |         autoStartEngine: true,
  203 |         lastSessionId: '',
  204 |         lastAgentId: '',
  205 |         lastModelId: '',
  206 |         lastFolder: WORKSPACE_DIR
  207 |       },
  208 |       null,
  209 |       2
  210 |     ),
  211 |     'utf-8'
  212 |   )
  213 |   return dir
  214 | }
  215 | 
  216 | let app: ElectronApplication
  217 | let page: Page
  218 | /** 收集渲染进程的错误，供用例结束时断言 */
  219 | const consoleErrors: string[] = []
  220 | 
  221 | test.beforeAll(async () => {
  222 |   if (!existsSync(join(APP_ROOT, 'out', 'main', 'index.js'))) {
  223 |     throw new Error('缺少构建产物，请先执行 npm run build')
  224 |   }
  225 | 
  226 |   const userDataDir = prepareUserData()
  227 |   prepareFixtures()
  228 |   prepareBigDir()
  229 | 
  230 |   app = await electron.launch({
  231 |     args: ['.', `--user-data-dir=${userDataDir}`],
  232 |     cwd: APP_ROOT
  233 |   })
  234 | 
  235 |   page = await app.firstWindow()
  236 |   page.on('console', (message) => {
  237 |     if (message.type() === 'error') consoleErrors.push(message.text())
  238 |   })
  239 |   page.on('pageerror', (error) => consoleErrors.push(String(error)))
  240 |   // 删除（移入回收站）会弹 window.confirm。Playwright 默认不理会，页面会一直
  241 |   // 挂在这个同步对话框上 —— Delete 键看起来"按了没反应"。这里自动确认。
  242 |   page.on('dialog', (dialog) => void dialog.accept())
  243 | 
> 244 |   await page.waitForSelector('.workbench')
      |              ^ TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
  245 | })
  246 | 
  247 | test.afterAll(async () => {
  248 |   await app?.close()
  249 |   // 夹具是测试自己造的，收尾删掉，避免污染仓库
  250 |   rmSync(FIXTURE_DIR, { recursive: true, force: true })
  251 |   // 用例会经 settings:update 写盘（文件排除规则必然要落盘才谈得上"生效"），
  252 |   // 关掉应用后再清掉这份配置，否则下一次运行会带着上一次的规则启动。
  253 |   // 不放在用例内部兜底：规则要留到「关窗 → 重开」的用例里验证真的持久化了。
  254 |   rmSync(join(tmpdir(), 'aether-ide-e2e-userdata'), { recursive: true, force: true })
  255 | })
  256 | 
  257 | test('工作台骨架渲染：菜单栏、活动栏、侧边栏、主区、对话面板、状态栏均存在', async () => {
  258 |   await expect(page.locator('.menu-bar')).toBeVisible()
  259 |   await expect(page.locator('.activity-bar')).toBeVisible()
  260 |   await expect(page.locator('.sidebar')).toBeVisible()
  261 |   await expect(page.locator('.editor-area')).toBeVisible()
  262 |   await expect(page.locator('.chat-panel')).toBeVisible()
  263 |   await expect(page.locator('.status-bar')).toBeVisible()
  264 | 
  265 |   // 主区的默认视图是对话面板。注意不能断言「模型」「安全」这类标签存在：
  266 |   // 它们曾经是主区固定标签，现已并入 AppSettingsView 的侧边分区
  267 |   // （见 contrib/settings/app-settings-navigation.ts），不再是主区标签。
  268 |   await expect(page.locator('.chat-panel')).toBeVisible()
  269 | })
  270 | 
  271 | test('资源管理器：恢复上次打开的文件夹并列出文件', async () => {
  272 |   await expect(page.locator('.explorer__root')).toContainText('aether-code')
  273 | 
  274 |   // 根目录条目应该被加载出来（package.json 必然存在）
  275 |   const packageRow = page.locator('.tree-row[title$="package.json"]')
  276 |   await expect(packageRow).toBeVisible()
  277 |   await expect(page.locator('.tree-row').first()).toBeVisible()
  278 | })
  279 | 
  280 | test('资源管理器：点击目录可展开', async () => {
  281 |   // 计数只看目标目录的子项，不能用整棵树的行数：
  282 |   // 虚拟滚动下 DOM 里始终只有可见的几十行，展开后总数可能反而不变
  283 |   const children = page.locator(descendantSelector(join(APP_ROOT, 'src')))
  284 | 
  285 |   // src 是项目里必然存在的目录。注意不能只写 hasText: 'src'：
  286 |   // 那会同时匹配到 src-runner 之类的兄弟目录，展开的却是另一个
  287 |   const src = page.locator(rowSelector(join(APP_ROOT, 'src')))
  288 |   await expect(src).toBeVisible()
  289 |   await src.click()
  290 | 
  291 |   // 展开后它的子项出现（src 下必然有文件，否则这个仓库根本无法构建）
  292 |   await expect.poll(async () => children.count(), { timeout: 15_000 }).toBeGreaterThan(0)
  293 | 
  294 |   // 再点一次收起，子项消失
  295 |   await src.click()
  296 |   await expect.poll(async () => children.count(), { timeout: 15_000 }).toBe(0)
  297 | })
  298 | 
  299 | test('编辑器：打开文件后 Monaco 挂载并显示内容', async () => {
  300 |   // 侧边栏可能停在上个用例切过去的视图上，先确保资源管理器可见
  301 |   await ensureExplorerVisible()
  302 | 
  303 |   const packageRow = page.locator(rowSelector(join(APP_ROOT, 'package.json')))
  304 |   await expect(packageRow).toBeVisible({ timeout: 15_000 })
  305 |   await packageRow.click()
  306 | 
  307 |   // 新标签出现
  308 |   const tab = page.locator('.editor-tab', { hasText: 'package.json' })
  309 |   await expect(tab).toBeVisible()
  310 | 
  311 |   // Monaco 真正初始化（worker 与 CSP 有问题时这一步会失败）
  312 |   await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 })
  313 | 
  314 |   // 内容渲染出来：Monaco 的 view-lines 里应出现文件内容特征串
  315 |   await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('aether-code', {
  316 |     timeout: 20_000
  317 |   })
  318 | 
  319 |   // 状态栏显示字符数与保存状态
  320 |   await expect(page.locator('.doc-view__status')).toContainText('已保存')
  321 | })
  322 | 
  323 | test('引擎：自动启动并进入就绪状态', async () => {
  324 |   await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  325 | })
  326 | 
  327 | test('安全视图：渲染三种会话模式与引擎侧策略规则', async () => {
  328 |   // 对话右面板常驻，底部就能切模式：被拦时用户正盯着输入框，不该被迫切页
  329 |   const modeTrigger = page.locator('.sec-picker__trigger')
  330 |   await expect(modeTrigger).toBeEnabled()
  331 |   await modeTrigger.click()
  332 |   await expect(page.locator('.sec-picker__item')).toHaveCount(3)
  333 | 
  334 |   // 切一次并确认状态是一致的：若 PUT 被引擎拒绝，store 会回滚成原模式
  335 |   await page.locator('.sec-picker__item', { hasText: '标准模式' }).click()
  336 |   await expect(modeTrigger).toContainText('标准模式')
  337 | 
  338 |   await modeTrigger.click()
  339 |   await expect(page.locator('.sec-picker__item', { hasText: '标准模式' })).toContainText('当前')
  340 |   await page.keyboard.press('Escape')
  341 |   await expect(page.locator('.sec-picker__popup')).toHaveCount(0)
  342 | 
  343 |   // 打开设置并定位到「安全」分区。
  344 |   // 「安全」不再是主区固定标签，而是设置视图内的 role=tab 分区，
```