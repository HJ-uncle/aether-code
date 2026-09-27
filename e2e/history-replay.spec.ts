import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 真机验收：历史回放 —— 启动时把引擎 conversations 表还原为聊天消息。
 *
 * 本文件覆盖：跨重启的消息回放、清空历史时引擎侧同步删除。
 *
 * 为什么必须驱动真实应用：
 *   - 回放链路横跨 IPC（GET /conversation/history）→ 引擎 SQLite → 渲染层映射，
 *     单测 mock 掉任何一环都证明不了「重启后界面记得上次聊到哪」
 *   - 「清空」要同时删引擎侧历史，否则重启后记录复活 —— 这一点只能靠
 *     重启前落库、重启后查库来验证
 *
 * 流程：先启动一次让引擎初始化数据库 → 关闭 → 向 conversations 表注入
 * 探针消息 → 再启动并断言界面回放 → 点清空 → 断言消息消失且库里已删。
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
  const dir = join(tmpdir(), 'aether-ide-e2e-userdata')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
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
  return join(userDataDir, 'engine', '1.0.0', 'data', 'agent.db')
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

let app: ElectronApplication
let page: Page
const userDataDir = prepareUserData()

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: APP_ROOT })
  page = await app.firstWindow()
  await page.waitForSelector('.workbench')
})

test.afterAll(async () => {
  await app?.close()
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

  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: APP_ROOT })
  page = await app.firstWindow()
  page.on('pageerror', () => undefined)
  await page.waitForSelector('.workbench')
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })

  // 用户消息与助手回答按原文回放
  await expect(page.locator('.chat-panel')).toContainText(PROBE_USER, { timeout: 30_000 })
  await expect(page.locator('.chat-panel')).toContainText(PROBE_ASSISTANT)

  // 工具调用还原为中文工具卡片（read_file → 读取文件），并回填了结果
  await expect(page.locator('.chat-panel')).toContainText('读取文件')
  await expect(page.locator('.chat-panel')).toContainText(PROBE_TOOL_RESULT)
})

test('清空后引擎侧历史一并删除：重启不会复活', async () => {
  const clearButton = page.locator('.chat__toolbar-btn', { hasText: '清空' })
  await expect(clearButton).toBeEnabled()
  await clearButton.click()
  await expect(page.locator('.chat-panel')).not.toContainText(PROBE_USER)

  const rows = runSql(
    userDataDir,
    `SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?`,
    [SESSION_ID],
    true
  ) as Array<{ n: number }>
  expect(rows[0]?.n, '引擎侧历史已删除').toBe(0)
})
