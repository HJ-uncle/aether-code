/** D7 real local provider -> policy-controlled engine child processes -> Electron job cards.
 * Covers incremental stdout/stderr, completed parent, navigation/reload, cancellation, failure,
 * timeout, child-owned jobs, engine crash recovery and genuine missing-job cancellation errors. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global { interface Window { aether: AetherIdeApi } }
type Body = { stream?: boolean; tools?: Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>; messages: Array<{ role: string; content?: unknown }> }
const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine'), model = 'd7-command-fixture', key = '7'.repeat(64)
let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
const requests: Array<{ scenario: string; body: Body }> = [], errors: string[] = []
function respond(response: ServerResponse, body: Body, content: string, calls: Array<{ name: string; args: unknown }> = []) {
  const tool_calls = calls.map((call, index) => ({ id: `d7-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
  const finish = calls.length ? 'tool_calls' : 'stop'
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'd7', model, choices: [{ index: 0, delta: { role: 'assistant', content, ...(calls.length ? { tool_calls: tool_calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'd7', model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  } else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'd7', model, choices: [{ index: 0, message: { role: 'assistant', content, ...(calls.length ? { tool_calls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }))
}
function command(scenario: string, timeoutMs = 60000, background = true) { return { name: 'execute_cmd', args: { command: process.execPath, args: ['d7-worker.cjs', scenario], timeoutMs, background } } }
const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''; for await (const chunk of incoming) raw += chunk.toString()
    const body = JSON.parse(raw) as Body, index = body.messages.findLastIndex(message => message.role === 'user')
    const scenario = JSON.stringify(body.messages[index]?.content).match(/\[d7:(\w+)\]/)?.[1]
    if (!scenario) throw new Error('D7 missing provider scenario')
    requests.push({ scenario, body })
    if (body.messages.slice(index + 1).some(message => message.role === 'tool')) { respond(response, body, `D7_PARENT_FINISHED_${scenario}`); return }
    if (scenario === 'child') { respond(response, body, '', [{ name: 'subagent', args: { task: '[d7:childworker] Launch the fixture background worker and return immediately.', description: 'D7 child background job', role: 'implementer', access: 'inherit', maxSteps: 4 } }]); return }
    if (scenario === 'failures') { respond(response, body, '', [command('failure'), command('timeout', 900), command('foreground', 10000, false)]); return }
    respond(response, body, '', [command(scenario)])
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const worker = `const fs=require('node:fs'); const name=process.argv[2];
fs.appendFileSync('launch-'+name+'.txt','launch\\n');
process.stdout.write('D7_START_'+name+'\\n'); process.stderr.write('D7_STDERR_'+name+'\\n');
if(name==='failure'){process.stderr.write('D7_FAILURE_REASON\\n');process.exit(7)}
if(name==='foreground'){process.stdout.write('D7_FOREGROUND_DONE\\n');process.exit(0)}
let progressed=false;
const timer=setInterval(()=>{
 if(!progressed&&fs.existsSync('progress-'+name)){progressed=true;process.stdout.write('D7_PROGRESS_'+name+'\\n');process.stderr.write('D7_MORE_STDERR_'+name+'\\n')}
 if(fs.existsSync('release-'+name)){clearInterval(timer);fs.writeFileSync('finished-'+name,'done');process.stdout.write('D7_END_'+name+'\\n');process.exit(0)}
},30);
setTimeout(()=>process.exit(9),60000).unref();`
function env(): NodeJS.ProcessEnv { return { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '', OPENAI_API_KEY: 'd7-local-key', OPENAI_BASE_URL: baseUrl, DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'methodology', MAX_ITERATIONS: '6', ENABLE_LONG_TERM_MEMORY: 'false', AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') } }
async function launch() { app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: env() }); page = await app.firstWindow(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 }) }
async function select(scenario: string) { await page.evaluate(lastSessionId => window.aether.settings.update({ lastSessionId }), `d7-${scenario}`); await page.reload(); await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true') }
async function send(scenario: string) { await page.locator('.chat__input').fill(`[d7:${scenario}]`); await page.getByRole('button', { name: '发送', exact: true }).click() }
async function snapshot(scenario: string) { const response = await page.evaluate(sessionId => window.aether.engine.request<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', query: { sessionId } }), `d7-${scenario}`); expect(response.ok, response.message).toBe(true); return response.data! }
async function finished(scenario: string) { await expect.poll(async () => (await snapshot(scenario)).run?.status).toBe('succeeded'); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeHidden(); expect(errors).toEqual([]) }
async function jobs(scenario: string): Promise<CommandJobSnapshot[]> { const response = await page.evaluate(sessionId => window.aether.engine.request<{ jobs: CommandJobSnapshot[] }>({ method: 'GET', path: '/command-jobs', query: { sessionId } }), `d7-${scenario}`); expect(response.ok, response.message).toBe(true); return response.data!.jobs }
function card(id: string): Locator { return page.locator(`.command-job-card[data-job-id="${id}"]`) }
function marker(name: string) { return join(fixture, 'workspace', name) }
function callCount(scenario: string) { return requests.filter(request => request.scenario === scenario).length }
function once(text: string | null, value: string) { expect((text ?? '').split(value)).toHaveLength(2) }

test.describe.serial('D7 后台命令真实进程闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); if (!address || typeof address === 'string') throw new Error('missing provider'); baseUrl = `http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'd7-command-ui-')); mkdirSync(join(fixture, 'workspace'), { recursive: true }); mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(marker('d7-worker.cjs'), worker)
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12427, autoStartEngine: true, lastSessionId: 'd7-success', lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off' }))
    const url = (name: string) => pathToFileURL(join(engineRoot, 'dist', name)).href
    const config = Object.fromEntries(Object.entries(env()).filter(([name]) => ['LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'].includes(name)))
    const seed = `const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});const {policyEngine}=await import(${JSON.stringify(url('security/policy-engine.js'))});await initDb();await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'d7-local-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'D7 local fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});await policyEngine.listRules();await policyEngine.upsertRule({name:'allow-d7-fixture',command:'*',argPattern:'d7-worker\\\\.cjs',action:'allow',priority:1,enabled:true});for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');
const {rootRunStore}=await import(${JSON.stringify(url('storage/root-runs/index.js'))});const {JSONLConversationHistory}=await import(${JSON.stringify(url('storage/conversation/jsonl-history.js'))});const run=await rootRunStore.create('default','d7-expired',${JSON.stringify(model)},[${JSON.stringify(join(fixture, 'workspace'))}],{});await rootRunStore.update('default',run.runId,{status:'succeeded'});const history=new JSONLConversationHistory();const job={schemaVersion:1,jobId:'expired-d7-job',sessionId:'d7-expired',ownerSessionId:'d7-expired',runId:run.runId,turnId:run.turnId,toolCallId:'expired-cmd',version:1,status:'running',command:'node',args:['expired-worker.cjs'],cwd:${JSON.stringify(join(fixture, 'workspace'))},background:true,createdAt:1,updatedAt:1,exitCode:null,signal:null,cursor:0,earliestCursor:0};for(const row of [{id:run.userMessageId,role:'user',content:'D7_EXPIRED_HISTORY'},{id:run.assistantMessageId,role:'assistant',content:'',toolCall:{id:'expired-cmd',name:'execute_cmd',args:{background:true}}},{role:'tool',toolCallId:'expired-cmd',content:'Previously launched',metadata:{success:true,commandJob:job}}])await history.append({...row,conversationId:run.turnId,createdAt:Date.now()},{tenantId:'default',sessionId:'d7-expired'});getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key } })
    await launch()
  })
  test.afterAll(async () => {
    // Release any fixture orphan after an intentionally killed engine before safe cleanup.
    if (fixture) for (const name of ['success', 'cancel', 'timeout', 'childworker', 'restart']) writeFileSync(marker(`release-${name}`), '')
    await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    if (!fixture) return; const absolute = resolve(fixture); if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('d7-command-ui-')) throw new Error('Unsafe D7 fixture cleanup'); rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('父回复结束后stdout/stderr持续增量，刷新与切换会话保持同一任务且完成不重跑', async () => {
    await send('success'); await finished('success')
    const job = (await jobs('success'))[0]; expect(job.status).toBe('running'); expect(job.background).toBe(true)
    const schema = requests[0].body.tools!; expect(schema.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['execute_cmd', 'command_output', 'cancel_command'])); expect(schema.find(tool => tool.function.name === 'execute_cmd')?.function.parameters.properties).toHaveProperty('background')
    await expect(card(job.jobId)).toHaveAttribute('data-status', 'running'); await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_START_success'); await expect(card(job.jobId).locator('[data-stream=stderr]')).toContainText('D7_STDERR_success')
    writeFileSync(marker('progress-success'), ''); await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_PROGRESS_success')
    await page.reload(); await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_PROGRESS_success'); once(await card(job.jobId).getByLabel('命令输出').textContent(), 'D7_START_success')
    await select('other'); await expect(page.locator('.command-job-card')).toHaveCount(0)
    const wrong = await page.evaluate(jobId => window.aether.engine.request({ method: 'GET', path: `/command-jobs/${jobId}`, query: { sessionId: 'd7-other' } }), job.jobId); expect(wrong.ok).toBe(false); expect(wrong.code).toBe(404)
    writeFileSync(marker('release-success'), ''); await expect.poll(() => existsSync(marker('finished-success'))).toBe(true)
    await select('success'); await expect(card(job.jobId)).toHaveAttribute('data-status', 'succeeded'); await expect(card(job.jobId)).toContainText('退出码 0'); await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_END_success')
    once(await card(job.jobId).getByLabel('命令输出').textContent(), 'D7_PROGRESS_success'); expect(readFileSync(marker('launch-success.txt'), 'utf8')).toBe('launch\n'); expect(callCount('success')).toBe(2)
  })
  test('停止命令等待真实退出，刷新保留已取消且不执行后续文件副作用', async () => {
    await select('cancel'); await send('cancel'); await finished('cancel'); const job = (await jobs('cancel'))[0]
    await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_START_cancel'); await card(job.jobId).getByRole('button', { name: '停止命令', exact: true }).click()
    await expect(card(job.jobId)).toHaveAttribute('data-status', 'cancelled'); expect((await jobs('cancel'))[0].status).toBe('cancelled')
    writeFileSync(marker('release-cancel'), ''); await page.reload(); await expect(card(job.jobId)).toHaveAttribute('data-status', 'cancelled'); await expect(card(job.jobId).getByRole('button', { name: '停止命令', exact: true })).toBeHidden()
    expect(existsSync(marker('finished-cancel'))).toBe(false); expect(callCount('cancel')).toBe(2)
  })
  test('非零退出和超时保留各自终态/退出码/stderr，前台命令维持普通工具展示', async () => {
    await select('failures'); await send('failures'); await finished('failures')
    const all = await jobs('failures'), failed = all.find(job => job.args.includes('failure'))!, timed = all.find(job => job.args.includes('timeout'))!, foreground = all.find(job => job.args.includes('foreground'))!
    await expect(page.locator('.command-job-card')).toHaveCount(2); await expect(card(failed.jobId)).toHaveAttribute('data-status', 'failed'); await expect(card(failed.jobId)).toContainText('退出码 7'); await expect(card(failed.jobId).getByLabel('命令输出')).toContainText('D7_FAILURE_REASON')
    await expect(card(timed.jobId)).toHaveAttribute('data-status', 'timed_out'); await expect(card(timed.jobId)).toContainText('COMMAND_TIMEOUT')
    expect(foreground).toMatchObject({ background: false, status: 'succeeded', exitCode: 0 }); await page.reload(); await expect(card(failed.jobId)).toHaveAttribute('data-status', 'failed'); await expect(card(timed.jobId)).toHaveAttribute('data-status', 'timed_out'); expect(callCount('failures')).toBe(2)
  })
  test('子代理派发后父/子结束仍能发现后台命令，归属恢复且可单独停止', async () => {
    await select('child'); await send('child'); await finished('child')
    const job = (await jobs('child'))[0]; expect(job.ownerSessionId).not.toBe(job.sessionId); expect(job.ownerRunId).toBeTruthy(); expect(job.status).toBe('running')
    const panel = page.getByRole('region', { name: '子代理后台命令' }); await expect(panel.locator('.command-job-card')).toHaveCount(1); await expect(card(job.jobId)).toContainText(job.ownerRunId!); await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_START_childworker')
    await page.reload(); await expect(panel.locator('.command-job-card')).toHaveCount(1); await card(job.jobId).getByRole('button', { name: '停止命令', exact: true }).click(); await expect(card(job.jobId)).toHaveAttribute('data-status', 'cancelled')
    expect(callCount('child')).toBe(2); expect(callCount('childworker')).toBe(2)
    expect(job.turnId).toBeTruthy()
    const removed = await page.evaluate(({ turnId, sessionId }) => window.aether.engine.request({ method: 'DELETE', path: '/conversation/turns/' + encodeURIComponent(turnId!), query: { sessionId } }), { turnId: job.turnId, sessionId: job.sessionId })
    expect(removed.ok, removed.message).toBe(true)
    expect((await jobs('child')).some(retained => retained.jobId === job.jobId)).toBe(true)
    await page.reload()
    await expect(page.getByRole('region', { name: '子代理后台命令' })).toHaveCount(0)
    await expect(card(job.jobId)).toHaveCount(0)
    expect((await snapshot('child')).history).toHaveLength(0)
    expect(callCount('child')).toBe(2); expect(callCount('childworker')).toBe(2)
  })
  test('引擎进程意外退出后任务恢复为中断且不自动重新执行', async () => {
    await select('restart'); await send('restart'); await finished('restart'); const job = (await jobs('restart'))[0]
    await expect(card(job.jobId).getByLabel('命令输出')).toContainText('D7_START_restart')
    const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(engine.entryPath).toBe(join(engineRoot, 'dist/main.js')); expect(engine.dataDir).toBe(join(fixture, 'engine/state/agent.db')); expect(engine.pid).toBeGreaterThan(0)
    process.kill(engine.pid!, 'SIGKILL')
    // The host may also reap descendants on engine exit. Release any surviving fixture worker
    // without assuming that a killed process can execute a final side effect.
    writeFileSync(marker('release-restart'), '')
    await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase).not.toBe('ready')
    await page.evaluate(() => window.aether.engine.start()); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 }); await page.reload()
    await expect(card(job.jobId)).toHaveAttribute('data-status', 'interrupted'); await expect(card(job.jobId)).toContainText('未自动重新执行')
    expect(readFileSync(marker('launch-restart.txt'), 'utf8')).toBe('launch\n'); expect(callCount('restart')).toBe(2)
  })
  test('过期历史任务真实404显示输出和停止失败，不能伪装为已取消或重新派发', async () => {
    await select('expired'); const expired = card('expired-d7-job')
    await expect(expired).toContainText('输出更新失败：任务已过期或不存在'); await expired.getByRole('button', { name: '停止命令', exact: true }).click()
    await expect(expired).toContainText('停止失败：任务已过期或不存在'); await expect(expired).toHaveAttribute('data-status', 'running'); expect(callCount('expired')).toBe(0)
  })
})
