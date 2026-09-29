/** D6 local provider -> exact read hashes -> edits -> live/restarted diffs -> real UI rollback.
 * Stale and ambiguous edits must leave exact disk bytes and the change ledger untouched. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global { interface Window { aether: AetherIdeApi } }
type Scenario = 'success' | 'stale' | 'ambiguous'
type ToolMessage = { role: string; tool_call_id?: string; content?: unknown }
type ToolSchema = { type: string; function: { name: string; parameters: { required?: string[]; properties?: Record<string, { enum?: string[] }> } } }
type ExactRead = { path: string; expectedHash: string; content: string; utf8Bom: boolean; lineEnding: string }
const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'd6-edit-local-fixture', key = '6'.repeat(64)
const originals: Record<string, string> = {
  'first.ts': '\ufeffconst heading = "before";\r\nconst limit = 1;\r\n',
  'second.txt': '标题：旧版本\nkeep this line\n',
  'stale.txt': 'original heading\noriginal tail\n',
  'ambiguous.txt': 'unique heading\nduplicate token\nduplicate token\n'
}
let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
const requests: Array<{ scenario: Scenario; schemas: ToolSchema[]; toolResults: ToolMessage[] }> = []
const exactReads = new Map<Scenario, ExactRead[]>()
const held = new Map<Scenario, ServerResponse>()
const providerErrors: string[] = []
function delta(response: ServerResponse, value: Record<string, unknown>, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'd6', model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`)
}
function finish(response: ServerResponse, reason: string) { delta(response, {}, reason); response.end('data: [DONE]\n\n') }
function calls(response: ServerResponse, entries: Array<{ id: string; name: string; args: unknown }>) {
  delta(response, { tool_calls: entries.map((entry, index) => ({ index, id: entry.id, type: 'function', function: { name: entry.name, arguments: JSON.stringify(entry.args) } })) })
  finish(response, 'tool_calls')
}
function edits(scenario: Scenario, response: ServerResponse) {
  const reads = exactReads.get(scenario)!
  calls(response, reads.map((read, index) => ({
    id: `edit-${scenario}-${index}`, name: 'edit_file', args: { path: read.path, expectedHash: read.expectedHash,
      edits: scenario === 'success' ? index === 0 ? [{ oldText: '"before"', newText: '"after"' }, { oldText: 'limit = 1', newText: 'limit = 2' }] : [{ oldText: '旧版本', newText: '新版本' }]
        : scenario === 'stale' ? [{ oldText: 'original heading', newText: 'agent heading' }]
          : [{ oldText: 'unique heading', newText: 'must not apply' }, { oldText: 'duplicate token', newText: 'must not apply either' }]
    }
  })))
}
const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''; for await (const chunk of incoming) raw += chunk.toString()
    const body = JSON.parse(raw) as { messages: ToolMessage[]; tools: ToolSchema[] }
    const index = body.messages.findLastIndex(message => message.role === 'user')
    const scenario = JSON.stringify(body.messages[index]?.content).match(/\[d6:(success|stale|ambiguous)\]/)?.[1] as Scenario | undefined
    if (!scenario) throw new Error('unexpected D6 provider scenario')
    const toolResults = body.messages.slice(index + 1).filter(message => message.role === 'tool')
    requests.push({ scenario, schemas: body.tools, toolResults })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (toolResults.some(message => message.tool_call_id?.startsWith('edit-'))) {
      if (scenario === 'success') { held.set(scenario, response); delta(response, { role: 'assistant', content: 'D6_EDITED_TWO_FILES' }); return }
      delta(response, { role: 'assistant', content: `D6_${scenario.toUpperCase()}_REJECTED` }); finish(response, 'stop'); return
    }
    if (toolResults.length) {
      // Hashes used in edit_file come only from the actual model-visible read result.
      const reads = toolResults.map(message => JSON.parse(String(message.content)) as ExactRead)
      if (reads.some(read => !/^sha256:[a-f0-9]{64}$/.test(read.expectedHash) || !read.path || typeof read.content !== 'string')) throw new Error('read_file exact contract missing')
      exactReads.set(scenario, reads)
      if (scenario === 'stale') { held.set(scenario, response); delta(response, { role: 'assistant', content: 'D6_VERSION_READ' }); return }
      edits(scenario, response); return
    }
    const paths = scenario === 'success' ? ['first.ts', 'second.txt'] : [`${scenario}.txt`]
    calls(response, paths.map((path, index) => ({ id: `read-${scenario}-${index}`, name: 'read_file', args: { path, mode: 'exact' } })))
  })().catch(error => { providerErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
function env(): NodeJS.ProcessEnv { return { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '', OPENAI_API_KEY: 'local-d6-key', OPENAI_BASE_URL: baseUrl, DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'methodology', MAX_ITERATIONS: '5', ENABLE_LONG_TERM_MEMORY: 'false', AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') } }
async function launch() { app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: env() }); page = await app.firstWindow(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 }) }
async function snapshot(scenario: Scenario) {
  const response = await page.evaluate(sessionId => window.aether.engine.request<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', query: { sessionId } }), `d6-${scenario}`)
  expect(response.ok, response.message).toBe(true); return response.data!
}
async function select(scenario: Scenario) { await page.evaluate(sessionId => window.aether.settings.update({ lastSessionId: sessionId }), `d6-${scenario}`); await page.reload(); await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true') }
async function send(scenario: Scenario) { await page.locator('.chat__input').fill(`[d6:${scenario}]`); await page.getByRole('button', { name: '发送', exact: true }).click() }
async function completed(scenario: Scenario) { await expect.poll(async () => (await snapshot(scenario)).run?.status).toBe('succeeded'); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeHidden(); expect(providerErrors).toEqual([]) }
function bytes(name: string) { return readFileSync(join(fixture, 'workspace', name)) }
function requestCount(scenario: Scenario) { return requests.filter(item => item.scenario === scenario).length }
async function showFailedEdit() {
  const summary = page.locator('.process__summary').filter({ hasText: '1 失败' })
  await expect(summary).toBeVisible()
  if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
  await expect(page.locator('.logline__name--error')).toHaveText('编辑文件')
}
async function rejected(scenario: 'stale' | 'ambiguous', expectedContent: string, code: string) {
  await completed(scenario)
  expect(bytes(`${scenario}.txt`)).toEqual(Buffer.from(expectedContent))
  expect((await snapshot(scenario)).changes).toHaveLength(0)
  await expect(page.locator('.diff-card')).toHaveCount(0)
  await showFailedEdit()
  const results = requests.filter(item => item.scenario === scenario).at(-1)!.toolResults.filter(message => message.tool_call_id?.startsWith('edit-'))
  expect(JSON.stringify(results)).toContain(code)
  await page.reload()
  await showFailedEdit()
  expect((await snapshot(scenario)).changes).toHaveLength(0)
  expect(bytes(`${scenario}.txt`)).toEqual(Buffer.from(expectedContent))
  expect(requestCount(scenario)).toBe(3)
}
test.describe.serial('D6 精确编辑真机闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); if (!address || typeof address === 'string') throw new Error('missing provider address'); baseUrl = `http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'd6-edit-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true }); mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    for (const [name, value] of Object.entries(originals)) writeFileSync(join(fixture, 'workspace', name), value)
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12425, autoStartEngine: true, lastSessionId: 'd6-success', lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off' }))
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    const config = Object.fromEntries(Object.entries(env()).filter(([name]) => ['LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'].includes(name)))
    const seed = `const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});await initDb();await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'local-d6-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'D6 edit fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key } })
    await launch()
  })
  test.afterAll(async () => {
    await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    if (!fixture) return; const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('d6-edit-ui-')) throw new Error('unsafe D6 fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('实际工具schema与精确读取版本驱动两文件编辑，live/刷新/重启diff和路径跳转一致，UI撤回恢复字节', async () => {
    await send('success')
    await expect(page.locator('.message__content')).toHaveText('D6_EDITED_TWO_FILES')
    expect(providerErrors).toEqual([])
    const schemas = requests[0].schemas
    expect(schemas.find(item => item.function.name === 'edit_file')?.function.parameters.required).toEqual(expect.arrayContaining(['path', 'expectedHash', 'edits']))
    expect(schemas.find(item => item.function.name === 'read_file')?.function.parameters.properties?.mode.enum).toContain('exact')
    for (const read of exactReads.get('success')!) {
      const original = originals[basename(read.path)]
      expect(read.content).toBe(original)
      expect(read.expectedHash).toBe(`sha256:${createHash('sha256').update(Buffer.from(original)).digest('hex')}`)
    }
    expect(exactReads.get('success')![0]).toMatchObject({ utf8Bom: true, lineEnding: 'CRLF' })
    expect(bytes('first.ts')).toEqual(Buffer.from(originals['first.ts'].replace('"before"', '"after"').replace('limit = 1', 'limit = 2')))
    expect(bytes('second.txt')).toEqual(Buffer.from(originals['second.txt'].replace('旧版本', '新版本')))
    await expect(page.locator('.diff-card')).toHaveCount(2)
    await expect(page.locator('.diff-card__title')).toHaveText(['编辑文件', '编辑文件'])
    await expect(page.locator('.diff-row--add')).toContainText(['const heading = "after";', 'const limit = 2;', '标题：新版本'])
    const live = await snapshot('success')
    expect(live.changes).toHaveLength(2)
    for (const change of live.changes) expect(change).toMatchObject({ runId: live.run!.runId, turnId: live.run!.turnId, oldHash: expect.stringMatching(/^sha256:/), newHash: expect.stringMatching(/^sha256:/) })
    await page.locator('.diff-card__path').filter({ hasText: 'first.ts' }).click()
    await expect(page.locator('.editor-tab.is-active')).toContainText('first.ts')
    await page.reload(); await expect(page.locator('.diff-card')).toHaveCount(2)
    expect(requestCount('success')).toBe(3); expect((await snapshot('success')).changes).toHaveLength(2)
    finish(held.get('success')!, 'stop'); await completed('success')
    await app!.close(); await launch()
    await expect(page.locator('.diff-card')).toHaveCount(2)
    expect((await snapshot('success')).source).toBe('persisted'); expect(requestCount('success')).toBe(3)
    await page.getByRole('button', { name: '改动 2', exact: true }).click()
    await page.locator('.changes-panel__footer').getByRole('button', { name: '撤回', exact: true }).click()
    await page.getByRole('dialog', { name: '撤回改动' }).getByRole('button', { name: '撤回', exact: true }).click()
    await expect(page.getByRole('region', { name: '文件回退结果' })).toContainText('已撤回 2 个文件（2 处改动）')
    for (const name of ['first.ts', 'second.txt']) expect(bytes(name)).toEqual(Buffer.from(originals[name]))
    await expect(page.locator('.diff-card__hint')).toHaveText(['已撤回', '已撤回'])
    await page.reload(); await expect(page.locator('.diff-card__hint')).toHaveText(['已撤回', '已撤回'])
    expect((await snapshot('success')).changes.map(change => change.status)).toEqual(['reverted', 'reverted'])
    expect(requestCount('success')).toBe(3)
  })
  test('读取后人工修改导致版本冲突，拒绝写入且刷新保持失败和人工内容', async () => {
    await select('stale'); await send('stale')
    await expect(page.locator('.message__content')).toHaveText('D6_VERSION_READ')
    const manual = 'HUMAN_CHANGED_AFTER_READ\r\n'
    writeFileSync(join(fixture, 'workspace', 'stale.txt'), manual)
    edits('stale', held.get('stale')!)
    await rejected('stale', manual, 'EDIT_VERSION_CONFLICT')
  })
  test('同一原文重复匹配拒绝整批编辑，之前的唯一匹配也不写入或生成改动', async () => {
    await select('ambiguous'); await send('ambiguous')
    await rejected('ambiguous', originals['ambiguous.txt'], 'EDIT_AMBIGUOUS_MATCH')
  })
})
