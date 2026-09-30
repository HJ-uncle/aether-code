import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 真机验收：历史回放 —— 启动时把引擎 conversations 表还原为聊天消息。
 *
 * 本文件覆盖：跨重启的消息回放、从会话历史删除后引擎侧同步删除。
 *
 * 为什么必须驱动真实应用：
 *   - 回放链路横跨 IPC（GET /conversation/history）→ 引擎 SQLite → 渲染层映射，
 *     单测 mock 掉任何一环都证明不了「重启后界面记得上次聊到哪」
 *   - 「删除会话」要同时删引擎侧历史，否则重启后记录复活 —— 这一点只能靠
 *     重启前落库、重启后查库来验证
 *
 * 流程：先启动一次让引擎初始化数据库 → 关闭 → 向 conversations 表注入
 * 探针消息 → 再启动并断言界面回放 → 从会话历史删除 → 重启并断言消息不复活。
 */

const APP_ROOT = resolve(__dirname, '..')
const WORKSPACE_DIR = APP_ROOT

/** 开发期引擎仓库的 node_modules（dev-sibling 布局：仓库同级），借它的 @libsql/client 造数据 */
const ENGINE_NODE_MODULES = resolve(APP_ROOT, '..', 'ai-agent-engine', 'node_modules')

const SESSION_ID = 'e2e-replay-session'
const PROBE_USER = 'E2E历史回放探针-用户消息'
const PROBE_ASSISTANT = 'E2E历史回放探针-助手回答'
const PROBE_TOOL_RESULT = 'E2E历史回放探针-工具结果'

function prepareUserData(): string {
  // 每次运行都使用独立目录，避免上一次失败留下的 JSONL/迁移 marker
  // 改变本次用例要验证的「SQLite → JSONL 懒迁移」路径。
  const dir = mkdtempSync(join(tmpdir(), 'aether-ide-e2e-replay-'))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        engineMode: 'embedded',
        preferredPort: 12399,
        remoteBaseUrl: '',
        autoStartEngine: true,
        // 会话 ID 预先固定：注入的历史挂在它名下，启动回放才有意义
        lastSessionId: SESSION_ID,
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

/** embedded 引擎的数据文件：<userData>/engine/<version>/data/agent.db */
function engineDbPath(userDataDir: string): string {
  return join(userDataDir, 'engine', 'state', 'agent.db')
}

/** 借引擎仓库的 @libsql/client 执行 SQL（IDE 自身不依赖 libsql，spec 无法直接 import） */
function runSql(
  userDataDir: string,
  sql: string,
  params: unknown[],
  expectRows: boolean
): unknown[] {
  const dbPath = engineDbPath(userDataDir)
  // Windows 绝对路径的标准 file URL：file:///C:/...（少一个斜杠 libsql 会解析失败或写偏）
  const fileUrl = 'file:///' + dbPath.replace(/\\/g, '/')
  const script = `
    const { createClient } = require(${JSON.stringify(join(ENGINE_NODE_MODULES, '@libsql\\client').replace(/\\/g, '/'))});
    (async () => {
      const db = createClient({ url: ${JSON.stringify(fileUrl)} });
      const result = await db.execute({ sql: ${JSON.stringify(sql)}, args: ${JSON.stringify(params)} });
      const rows = ${expectRows} ? result.rows : [];
      console.log('SQL_DONE ' + JSON.stringify(rows));
    })().catch((e) => { console.error('SQL_FAIL ' + e.message); process.exit(1); });
  `
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 20_000 })
  const line = out.split('\n').find((l) => l.startsWith('SQL_DONE'))
  if (!line) throw new Error(`SQL 执行无结果：${out}`)
  return JSON.parse(line.slice('SQL_DONE '.length)) as unknown[]
}

/** 注入一轮完整的对话历史：用户提问 + 助手回答（含思考与工具调用）+ 工具结果 */
function insertProbeHistory(userDataDir: string): void {
  const now = Math.floor(Date.now() / 1000)
  const statements: Array<[string, unknown[]]> = [
    [
      `INSERT INTO conversations (tenant_id, session_id, role, content, tokens, created_at)
       VALUES ('default', ?, 'user', ?, 10, ?)`,
      [SESSION_ID, PROBE_USER, now - 60]
    ],
    [
      `INSERT INTO conversations (tenant_id, session_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_args, tokens, created_at)
       VALUES ('default', ?, 'assistant', ?, '回放思考过程', 'call_e2e_replay_1', 'read_file', ?, 20, ?)`,
      [SESSION_ID, PROBE_ASSISTANT, JSON.stringify({ path: 'e2e-probe.txt' }), now - 50]
    ],
    [
      `INSERT INTO conversations (tenant_id, session_id, role, content, tool_call_id, tool_name, tokens, created_at)
       VALUES ('default', ?, 'tool', ?, 'call_e2e_replay_1', 'read_file', 5, ?)`,
      [SESSION_ID, PROBE_TOOL_RESULT, now - 40]
    ]
  ]
  for (const [sql, params] of statements) runSql(userDataDir, sql, params, false)
}

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const userDataDir = prepareUserData()

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    // 明确走 JSONL 后端，验证旧 SQLite 行在首次读取时能迁移到 JSONL。
    env: { ...process.env, HISTORY_BACKEND: 'jsonl' }
  })
  page = await app.firstWindow()
  page.on('pageerror', () => undefined)
  await page.waitForSelector('.workbench')
}

async function requestHistory(sessionId: string): Promise<{
  ok: boolean
  data: unknown
}> {
  return page.evaluate(
    async (id) =>
      window.aether.engine.request({
        method: 'GET',
        path: '/conversation/history',
        query: { sessionId: id }
      }),
    sessionId
  )
}

async function requestSnapshot(sessionId: string): Promise<{
  ok: boolean
  data: unknown
}> {
  return page.evaluate(
    async (id) =>
      window.aether.engine.request({
        method: 'GET',
        path: '/chat/snapshot',
        query: { sessionId: id }
      }),
    sessionId
  )
}

async function openHistoryView(): Promise<void> {
  const button = page.getByRole('button', { name: '会话历史', exact: true })
  // 活动栏状态会随 renderer 的 localStorage 跨重启保留；只有在未激活时才点击，
  // 否则第二次打开测试会把已经可见的历史侧栏关掉。
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
  await expect(page.locator('.history-view')).toBeVisible()
}

test.beforeAll(async () => {
  await launchApp()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

test('首次启动：引擎就绪并完成数据库初始化', async () => {
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  const dbPath = engineDbPath(userDataDir)
  await expect
    .poll(() => existsSync(dbPath), { timeout: 30_000, message: '引擎数据库尚未创建' })
    .toBe(true)
})

test('重启后回放引擎历史：消息、思考、工具调用逐项还原', async () => {
  await app.close()

  // 引擎可能还占着文件句柄（Windows 文件锁），插入失败就等一拍重试
  let inserted = false
  for (let attempt = 0; attempt < 10 && !inserted; attempt++) {
    try {
      insertProbeHistory(userDataDir)
      inserted = true
    } catch {
      execFileSync(process.platform === 'win32' ? 'ping' : 'sleep', ['127.0.0.1', '-n', '2'], {
        stdio: 'ignore'
      })
    }
  }
  expect(inserted, '探针历史注入成功').toBe(true)

  // 防御：确认探针行真的落在引擎数据文件里 —— file URL 解析错误会悄悄写到别处
  const probeRows = runSql(
    userDataDir,
    `SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?`,
    [SESSION_ID],
    true
  ) as Array<{ n: number }>
  expect(probeRows[0]?.n, '探针行已写入引擎数据库').toBe(3)

  await launchApp()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })

  // 用户消息与助手回答按原文回放
  await expect(page.locator('.chat-panel')).toContainText(PROBE_USER, { timeout: 30_000 })
  await expect(page.locator('.chat-panel')).toContainText(PROBE_ASSISTANT)

  // 过程组默认收起；先展开过程，再分别展开思考行和工具行，验证完整明细。
  const thinkingSummary = page.locator('.process__summary').filter({ hasText: '思考 1 段' }).first()
  await expect(thinkingSummary).toHaveAttribute('aria-expanded', 'false')
  await thinkingSummary.click()
  const thinkingBody = thinkingSummary.locator('xpath=following-sibling::div[contains(@class,"process__body")]')
  await expect(thinkingBody).toBeVisible()

  const thinkingRow = thinkingBody.locator('.logline').filter({ hasText: '回放思考过程' }).first()
  await expect(thinkingRow).toBeVisible()
  await thinkingRow.click()
  await expect(thinkingBody.locator('.logline__detail').first()).toContainText('回放思考过程')

  const toolSummary = page.locator('.process__summary').filter({ hasText: '工具调用 1' }).first()
  await expect(toolSummary).toHaveAttribute('aria-expanded', 'false')
  await toolSummary.click()
  const toolBody = toolSummary.locator('xpath=following-sibling::div[contains(@class,"process__body")]')
  await expect(toolBody).toBeVisible()
  const toolRow = toolBody.locator('.logline').filter({ hasText: '读取文件' }).first()
  await expect(toolRow).toBeVisible()
  // 文件路径摘要是可点击的「打开文件」链接，会阻止展开；点工具名区域展开详情。
  await toolRow.locator('.logline__name').click()
  // read_file → 读取文件，同时确认工具结果没有只停留在 SQLite/迁移层。
  await expect(toolBody).toContainText(PROBE_TOOL_RESULT)
})

test('从会话历史删除后引擎侧历史一并删除：重启不会复活', async () => {
  // 清除入口是活动栏里的会话历史 → 会话右键菜单，而不是已移除的 ChatView「清空」按钮。
  await openHistoryView()
  const refreshButton = page.getByRole('button', { name: '刷新会话列表', exact: true })
  await expect(refreshButton).toBeEnabled()
  await refreshButton.click()

  const targetRow = page.locator('button.history-view__item').filter({ hasText: PROBE_USER })
  await expect(targetRow).toHaveCount(1, { timeout: 30_000 })
  await targetRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '删除会话', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(targetRow).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.chat-panel')).not.toContainText(PROBE_USER)

  // DELETE /sessions/:id 已落到当前 JSONL 后端，直接查引擎 API，避免只凭 UI 列表判断。
  const afterDelete = await requestHistory(SESSION_ID)
  expect(afterDelete.ok, '删除后历史 API 请求成功').toBe(true)
  expect(afterDelete.data, '删除后目标会话历史为空').toEqual([])

  await app.close()
  await launchApp()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })

  // 重启后再查同一 sessionId；即使当前设置已切换到新会话，目标会话也不能被旧 SQLite 行复活。
  const afterRestart = await requestHistory(SESSION_ID)
  expect(afterRestart.ok, '重启后历史 API 请求成功').toBe(true)
  expect(afterRestart.data, '重启后目标会话历史仍为空').toEqual([])
  const snapshot = await requestSnapshot(SESSION_ID)
  expect(snapshot.ok, '重启后快照 API 请求成功').toBe(true)
  expect((snapshot.data as { history?: unknown[] }).history ?? [], '重启后快照无历史').toEqual([])

  // UI 侧栏也不得重新出现已删会话。
  await openHistoryView()
  const postRestartRefresh = page.getByRole('button', { name: '刷新会话列表', exact: true })
  await expect(postRestartRefresh).toBeEnabled()
  await postRestartRefresh.click()
  await expect(
    page.locator('button.history-view__item').filter({ hasText: PROBE_USER })
  ).toHaveCount(0)
})
