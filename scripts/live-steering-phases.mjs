/** Explicit real-model phases. Importing this module performs no I/O or launch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect } from '@playwright/test'

export const officeNames = ['产品需求.docx', '项目计划.xlsx', '方案评审.pptx', '用户说明.pdf']
const sha = value => createHash('sha256').update(value).digest('hex')
const active = status => status?.running || ['preparing', 'running', 'waiting', 'cancelling'].includes(status?.run?.status)
const terminal = status => !active(status) && ['succeeded', 'cancelled', 'failed', 'interrupted'].includes(status?.run?.status)
const delay = ms => new Promise(done => setTimeout(done, ms))
const turn = row => row.metadata?.turnId || row.conversationId

export function assertProbeCalls(history, expected) {
  const calls = history.filter(row => row.toolCall?.name === 'execute_cmd' && Array.isArray(row.toolCall.args?.args)
    && basename(String(row.toolCall.args.args[0]).replaceAll('\\', '/')) === 'probe.mjs')
  assert.equal(calls.length, expected.length, 'Unexpected or duplicate helper command invocation')
  for (const item of expected) {
    const matching = calls.filter(row => turn(row) === item.turnId && JSON.stringify(row.toolCall.args.args.slice(1)) === JSON.stringify(item.args))
    assert.equal(matching.length, 1, 'Missing unique real execute_cmd for ' + item.args.join(' '))
    assert.match(basename(String(matching[0].toolCall.args.command).replaceAll('\\', '/')), /^node(?:\.exe)?$/i)
  }
  return calls
}

/** "重新发送" confirms deletion from the selected user message. Old receipts
 * stay in supervisor evidence and the run ledger, never in the new model turn. */
export function assertResendBranch({ cancelledHistory, history, original, cancelled, next, prompt }) {
  assert.notEqual(next.runId, cancelled.runId)
  assert.notEqual(next.turnId, cancelled.turnId)
  assert.equal(cancelledHistory.filter(row => row.id === original.id && row.content === prompt).length, 1, 'Cancelled snapshot lost original prompt')
  const oldTurn = cancelledHistory.filter(row => turn(row) === cancelled.turnId)
  assert.ok(oldTurn.some(row => row.role === 'assistant' && row.toolCall?.name === 'execute_cmd'), 'Cancelled snapshot lost original command')
  assert.ok(oldTurn.some(row => row.role === 'tool' && row.metadata?.status === 'cancelled'), 'Cancelled snapshot lost cancellation result')
  for (const row of oldTurn) assert.ok(!history.some(item => item.id === row.id), 'Resend kept deleted old-turn context: ' + row.id)
  const resent = history.filter(row => row.role === 'user' && row.content === prompt && turn(row) === next.turnId)
  assert.equal(resent.length, 1, 'Resend must seed the exact original prompt once in the new turn')
  assert.notEqual(resent[0].id, original.id)
  assert.equal(resent[0].metadata?.rootRunId, next.runId)
  const evidence = new Map()
  for (const row of [...cancelledHistory, ...history]) {
    const previous = evidence.get(row.id)
    if (previous) assert.equal(previous.content, row.content, 'Evidence ID has conflicting content: ' + row.id)
    else evidence.set(row.id, row)
  }
  return { resent, commandEvidence: [...evidence.values()], deletedMessageIds: oldTurn.map(row => row.id) }
}

export const probeSource = String.raw`import assert from 'node:assert/strict';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const [action,role,label]=process.argv.slice(2);
assert.ok(['work','code'].includes(role));
assert.ok(/^[a-z-]+$/.test(label));
const at=()=>Date.now();
const journal=join(root,role+'.jsonl');
const log=event=>appendFileSync(journal,JSON.stringify({at:at(),pid:process.pid,role,label,event})+'\n');
mkdirSync(root,{recursive:true});
if(action==='window'){
 const retry=role==='code'&&existsSync(join(root,'code-cancellation-observed.json'));
 const name=retry?'retry':'first';
 writeFileSync(join(root,role+'-'+name+'-started.json'),JSON.stringify({at:at(),pid:process.pid}),{flag:'wx'});
 log(name+'-started');
 await new Promise(done=>setTimeout(done,retry?20000:30000));
 log(name+'-finished');
 writeFileSync(join(root,role+'-'+name+'-finished.json'),JSON.stringify({at:at()}),{flag:'wx'});
 console.log(JSON.stringify({role,window:name,completed:true}));
}else if(action==='mark'){
 writeFileSync(join(root,role+'-'+label+'.json'),JSON.stringify({at:at(),pid:process.pid}),{flag:'wx'});
 log('mark');console.log(JSON.stringify({role,label,recorded:true}));
}else throw new Error('Unknown probe action');
`

export function prepareInputs(controller, options) {
  const source = resolve(options['office-source'] || 'D:/trust-test/cooperative-acceptance-20261103/round-2/workspace/product')
  const folder = join(controller.state.workspace, 'validation')
  assert.ok(!existsSync(folder), 'Validation folder already exists')
  mkdirSync(join(folder, 'office'), { recursive: true })
  writeFileSync(join(folder, 'probe.mjs'), probeSource, { flag: 'wx' })
  const office = officeNames.map(name => {
    const from = join(source, name), path = join(folder, 'office', name), original = readFileSync(from)
    copyFileSync(from, path)
    assert.equal(sha(readFileSync(path)), sha(original))
    return { name, source: from, path, sha256: sha(original), bytes: original.length }
  })
  const manifest = { schema: 'live-steering-inputs/v1', createdAt: Date.now(), office,
    probeSha256: sha(probeSource), note: 'Supervisor-authored input fixture; no model execution or consumption claims.' }
  writeFileSync(join(controller.state.evidence, 'live-inputs.json'), JSON.stringify(manifest, null, 2))
  return { folder, manifest }
}

export function createPhases(controller, prepared, options = {}) {
  const { page, state } = controller
  const output = join(state.evidence, 'live-validation')
  mkdirSync(output, { recursive: true })
  const persist = (name, data) => { const path = join(output, name + '.json'); writeFileSync(path, JSON.stringify(data, null, 2)); return path }
  const events = []
  const event = (kind, data = {}) => { events.push({ at: Date.now(), kind, ...data }); persist('events', events) }
  const expectedEngine = () => ({ mode: state.engine.mode, baseUrl: state.engine.baseUrl, instanceId: state.engine.instanceId, accountId: state.engine.accountId })
  const read = async (role, path, query = {}) => {
    const response = await page.evaluate(input => window.aether.engine.request(input), {
      method: 'GET', path, query, expectedEngine: expectedEngine(), toolProfile: role === 'development' ? 'code' : 'general' })
    assert.ok(response.ok, `Read-only ${path} failed: ${response.code} ${response.message || ''}`)
    return response
  }
  const status = async role => (await read(role, '/chat/status', { sessionId: state.roles[role].sessionId })).data
  const wait = async (label, check, timeout = 180_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(350) }
    throw new Error('Timed out: ' + label + '; no automatic stop/retry/resend was performed')
  }
  const marker = name => join(prepared.folder, name + '.json')
  const surface = role => page.locator('#mode-' + state.roles[role].mode)
  const composer = role => surface(role).locator('.input-composer__input[role="textbox"]').filter({ visible: true }).first()
  const checkInputs = () => {
    assert.equal(sha(readFileSync(state.builds.appEntry)), state.builds.appSha256, 'Client build changed during phase')
    assert.equal(sha(readFileSync(state.builds.engineEntry)), state.builds.engineSha256, 'Engine build changed during phase')
    assert.equal(sha(readFileSync(join(prepared.folder, 'probe.mjs'))), prepared.manifest.probeSha256, 'Probe was modified')
    for (const file of prepared.manifest.office) assert.equal(sha(readFileSync(file.path)), file.sha256, 'Office input changed: ' + file.name)
  }
  const dbRead = action => {
    const db = new DatabaseSync(join(state.profile, 'engine', 'state', 'agent.db'), { readOnly: true })
    try { db.exec('PRAGMA query_only=ON'); db.exec('BEGIN'); return action(db) }
    finally { db.close() }
  }
  const rootRows = role => dbRead(db => db.prepare('SELECT run_id,turn_id,state FROM root_runs WHERE session_id=? ORDER BY rowid').all(state.roles[role].sessionId)
    .map(row => ({ runId: row.run_id, turnId: row.turn_id, state: JSON.parse(row.state) })))
  const fullArchive = async (role, name) => {
    const sessionId = state.roles[role].sessionId
    // A snapshot during streaming may change revision. Retry only this read.
    for (let attempt = 0; attempt < 4; attempt++) {
      const first = await read(role, '/conversation/archive', { sessionId, current: 1, pageSize: 100 })
      assert.ok(first.pagination && Array.isArray(first.data), 'Archive is not paginated')
      const rows = [...first.data], pages = [first], revision = first.metadata?.archiveRevision
      let stable = true
      for (let current = 2; current <= first.pagination.totalPages; current++) {
        const page = await read(role, '/conversation/archive', { sessionId, current, pageSize: 100 }); pages.push(page); rows.push(...page.data)
        if (page.metadata?.archiveRevision !== revision || page.pagination.total !== first.pagination.total) stable = false
      }
      if (stable) {
        assert.equal(rows.length, first.pagination.total)
        assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
        persist(name, { sessionId, revision, pages, rows }); return rows
      }
      await delay(200)
    }
    throw new Error('Archive kept changing; no incomplete history accepted')
  }
  const consumed = (scope, receipt) => dbRead(db => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_jsonl_deliveries'").get()
    if (!table) return null
    const rows = db.prepare(`SELECT * FROM collaboration_jsonl_deliveries WHERE root_run_id=? AND root_attempt_id=? AND message_id=? AND history_session_id=?`)
      .all(scope.rootRunId, scope.rootAttemptId, receipt.messageId, scope.rootSessionId)
    if (!rows.length || rows[0].state !== 'integrated') return null
    assert.equal(rows.length, 1, 'Duplicate delivery rows')
    const row = rows[0], payload = JSON.parse(row.encoded_row)
    assert.equal(payload.uuid, row.history_message_id)
    assert.equal(payload.sessionId, scope.rootSessionId)
    assert.equal(sha(row.encoded_row), row.row_hash, 'Encoded delivery hash differs')
    return { ...row, decoded: payload }
  })
  const sendWhileRunning = async (role, text, delivery) => {
    await controller.select(role)
    const before = await status(role)
    assert.equal(before.run?.status, 'running', 'Input window already closed')
    const select = surface(role).getByRole('combobox', { name: '发送方式', exact: true })
    await expect(select).toBeVisible(); await select.selectOption(delivery)
    await expect(composer(role)).toBeEditable(); await composer(role).fill(text)
    const label = delivery === 'current' ? '立即补充' : '排到下一轮'
    const button = surface(role).getByRole('button', { name: label, exact: true }).filter({ visible: true }).last()
    await expect(button).toBeEnabled(); await button.click(); await expect(composer(role)).toHaveText('')
    event('real-composer-click', { role, delivery, textSha256: sha(text), beforeRun: before.run })
    return before
  }
  const journal = role => readFileSync(join(prepared.folder, role + '.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  const work = async () => {
    assert.ok(!state.roles.product.sessionId, 'Work phase is single-use; inspect existing evidence instead of resending')
    checkInputs()
    const original = '这是一次真实运行交互验证，只处理 validation/。第一步必须调用 execute_cmd，command="node"，args=["validation/probe.mjs","window","work","input"]，timeoutMs=60000，background=false。该命令创建标记并等待30秒，供用户追加要求；不要自行改脚本、标记或缩短等待。命令结束后优先执行用户本轮新增要求，然后调用 execute_cmd：command="node"，args=["validation/probe.mjs","mark","work","original-complete"]。完成后简洁说明实际结果，不启动子代理、不读其它工作区。'
    persist('work-prompts', { original })
    await controller.send({ id: 'live-work-initial', role: 'product', text: original })
    await wait('Work execute_cmd input window', () => existsSync(marker('work-first-started')))
    const first = await status('product'); assert.equal(first.run.status, 'running')
    const context = (await read('product', `/collaboration/roots/${encodeURIComponent(first.run.runId)}/controller-context`, { rootSessionId: state.roles.product.sessionId })).data
    assert.equal(context.recipient.kind, 'root')
    const immediate = '本轮立即追加：等待命令结束后，先通过 execute_cmd 执行 command="node", args=["validation/probe.mjs","mark","work","steered"]，再执行原要求的 original-complete 标记。两个命令顺序执行，各一次。不要写下一轮标记，不要改脚本，也不要自行声称消息已消费。'
    const next = '这是用户明确排到下一轮的独立要求。只通过 execute_cmd 执行 command="node", args=["validation/probe.mjs","mark","work","next-turn"]，成功后回复下一轮完成；不要重跑前一轮命令。'
    persist('work-prompts', { original, immediate, next })
    await sendWhileRunning('product', immediate, 'current')
    const accepted = await wait('durable controller acceptance in real renderer', async () => {
      const rows = await page.evaluate(() => JSON.parse(localStorage.getItem('aether.collaboration-controller-results.v1') || '[]'))
      const matching = rows.filter(row => row.message === immediate && row.rootRunId === first.run.runId)
      assert.ok(matching.length <= 1, 'Duplicate immediate acceptance')
      return matching[0]?.kind === 'accepted' ? matching[0] : null
    }, 20_000)
    assert.deepEqual({ rootRunId: accepted.rootRunId, rootAttemptId: accepted.rootAttemptId, rootSessionId: accepted.rootSessionId }, context.scope)
    const afterImmediate = await status('product')
    assert.equal(afterImmediate.run.runId, first.run.runId); assert.equal(afterImmediate.run.attemptId, first.run.attemptId)
    persist('work-accepted', { context, accepted, before: first, after: afterImmediate })
    await sendWhileRunning('product', next, 'next')
    const queue = await page.evaluate(input => window.aether.workQueue.invoke(input), { taskId: state.roles.product.sessionId, expectedEngine: expectedEngine(), action: { kind: 'read' } })
    assert.equal(queue.ok, true, 'Native next-turn queue read failed')
    assert.equal(queue.value.state.entries.filter(entry => entry.envelope.draft.text === next).length, 1, 'Next-turn entry missing or duplicated')
    persist('work-next-queued', { queue, after: await status('product') })
    await controller.screenshot({ name: 'live-work-immediate-and-next' })
    const delivery = await wait('actual JSONL mailbox integration', () => consumed(context.scope, accepted.receipt))
    persist('work-integrated', delivery)
    await wait('next-turn marker and terminal root', async () => existsSync(marker('work-next-turn')) && terminal(await status('product')))
    const last = await status('product'); assert.equal(last.run.status, 'succeeded'); assert.notEqual(last.run.runId, first.run.runId)
    assert.notEqual(last.run.turnId, first.run.turnId)
    const history = await fullArchive('product', 'work-complete-archive')
    assert.equal(history.filter(row => row.id === delivery.history_message_id).length, 1, 'Integrated input absent or duplicated in history')
    const consumedInput = history.find(row => row.id === delivery.history_message_id)
    assert.ok(consumedInput.content.includes(immediate)); assert.equal(turn(consumedInput), first.run.turnId)
    const roots = rootRows('product'); assert.equal(roots.length, 2, 'Immediate supplement unexpectedly created a root or next-turn duplicated')
    assert.equal(roots.find(row => row.runId === first.run.runId)?.state.attemptId, context.scope.rootAttemptId)
    assert.equal(roots.find(row => row.runId === first.run.runId)?.state.status, 'succeeded')
    const commands = assertProbeCalls(history, [
      { turnId: first.run.turnId, args: ['window', 'work', 'input'] },
      { turnId: first.run.turnId, args: ['mark', 'work', 'steered'] },
      { turnId: first.run.turnId, args: ['mark', 'work', 'original-complete'] },
      { turnId: last.run.turnId, args: ['mark', 'work', 'next-turn'] },
    ])
    const lines = journal('work'), marks = lines.filter(row => row.event === 'mark').map(row => row.label)
    assert.deepEqual(marks, ['steered', 'original-complete', 'next-turn'])
    assert.equal(lines.filter(row => row.event === 'first-started').length, 1)
    assert.equal(lines.filter(row => row.event === 'first-finished').length, 1)
    checkInputs()
    const result = { passed: true, first: first.run, final: last.run, roots, accepted, delivery, commands, journal: lines,
      archiveMessages: history.length, snapshot: await controller.snapshot(), limits: 'Real renderer/engine evidence; no native screen claim. Integrated mailbox and ordered model command calls are separate evidence.' }
    persist('work-result', result); event('work-passed'); return result
  }
  const code = async () => {
    assert.ok(!state.roles.development.sessionId, 'Code phase is single-use; inspect existing evidence instead of resending')
    checkInputs()
    const prompt = '这是 Code 模式真实停止、原消息重试与原生办公读取验证。只访问 validation/。第一步必须调用 execute_cmd，command="node", args=["validation/probe.mjs","window","code","stop"], timeoutMs=60000, background=false。不要改 helper 或标记。首次命令等待30秒；若用户停止再从原消息重试，helper会依据监督者已记录的真实取消结果建立20秒追加要求窗口。必须按本条要求重新调用 helper，命令结束后优先完成用户本轮新增要求，然后继续下面办公读取。\n' +
      '分别使用原生只读工具 office_inspect 读取 validation/office/产品需求.docx、项目计划.xlsx、方案评审.pptx、用户说明.pdf。工具的 path 指向相应完整相对路径。按真实 contentPage.hasMore/nextOffset/expectedHash 翻页，至少读到每种格式的实质内容与 PPT 备注。必须用 office_inspect，禁止 ZIP/解压、Python、PowerShell、read_file 或自写解析器读取这些办公文件；不要安装依赖。不要修改办公源文件。\n' +
      '写 validation/office-report.md，用中文列出每份文件实际读到的内容、expectedHash、限制；PPT必须引述至少一段真实备注并标 slide/textRun、target=notes，区分正文与备注，不能只说有备注。报告中的内容只能来自本轮真实工具结果。完成后通过 execute_cmd 执行 command="node", args=["validation/probe.mjs","mark","code","complete"]，简洁汇报。'
    persist('code-prompt', { prompt })
    await controller.send({ id: 'live-code-stop-original', role: 'development', text: prompt })
    await wait('Code execute_cmd cancellation window', () => existsSync(marker('code-first-started')))
    const before = await status('development'); assert.equal(before.run.status, 'running')
    const historyBefore = await fullArchive('development', 'code-before-stop-archive')
    const original = historyBefore.find(row => row.id === before.run.userMessageId) || historyBefore.find(row => row.role === 'user' && turn(row) === before.run.turnId)
    assert.ok(original && original.content === prompt, 'Original user message was not located exactly')
    await controller.select('development')
    // Settings can remain open in the same Code surface. Its generic “停止”
    // action stops the engine, so only the conversation composer owns this click.
    const stop = surface('development').locator('.input-composer__stop').filter({ visible: true })
    await expect(stop).toHaveCount(1)
    await expect(stop).toHaveAttribute('aria-label', '停止生成')
    await expect(stop).toBeEnabled()
    const target = await stop.evaluate(element => ({ tag: element.tagName, className: element.className,
      ariaLabel: element.getAttribute('aria-label'), title: element.getAttribute('title'), insideComposer: Boolean(element.closest('.input-composer')) }))
    assert.ok(target.insideComposer, 'Stop target is outside the conversation composer')
    event('chat-stop-button-selected', { target, before: before.run })
    await stop.click(); event('real-stop-button-clicked', { target, before: before.run })
    const cancelled = await wait('actual cancelled terminal status', async () => { const value = await status('development'); return terminal(value) ? value : null }, 45_000)
    assert.equal(cancelled.run.runId, before.run.runId); assert.equal(cancelled.run.status, 'cancelled')
    assert.ok(!existsSync(marker('code-first-finished')), 'Original wait completed before cancellation')
    const cancelledHistory = await fullArchive('development', 'code-cancelled-archive')
    for (const row of historyBefore) assert.ok(cancelledHistory.some(item => item.id === row.id), 'Stop lost archive history')
    const snapshot = await controller.snapshot()
    const cancellation = { at: Date.now(), source: 'real-stop-button-and-terminal-read', sessionId: state.roles.development.sessionId,
      runId: cancelled.run.runId, turnId: cancelled.run.turnId, attemptId: cancelled.run.attemptId, status: cancelled.run.status }
    writeFileSync(marker('code-cancellation-observed'), JSON.stringify(cancellation, null, 2), { flag: 'wx' })
    persist('code-cancelled', { before, cancelled, original, snapshot, cancellation })
    await controller.screenshot({ name: 'live-code-cancelled' })
    const retry = await controller.retry({ id: 'live-code-original-retry', role: 'development', expected: {
      sessionId: state.roles.development.sessionId, runId: cancelled.run.runId, turnId: cancelled.run.turnId },
      target: { userMessageId: original.id, turnId: turn(original) } })
    persist('code-retry-accepted', retry)
    await wait('Code retry input window', () => existsSync(marker('code-retry-started')))
    const retryRunning = await status('development'); assert.equal(retryRunning.run.status, 'running')
    assert.notEqual(retryRunning.run.runId, cancelled.run.runId)
    const context = (await read('development', `/collaboration/roots/${encodeURIComponent(retryRunning.run.runId)}/controller-context`, { rootSessionId: state.roles.development.sessionId })).data
    assert.equal(context.recipient.kind, 'root')
    const immediate = '本轮立即追加：等待当前 helper 命令结束后，先用 execute_cmd 执行 command="node", args=["validation/probe.mjs","mark","code","steered"]，只执行一次，然后继续本轮四份办公文件的 office_inspect 与报告。不要重跑之前的等待命令，不要新建会话。'
    persist('code-immediate-prompt', { immediate })
    await sendWhileRunning('development', immediate, 'current')
    const accepted = await wait('Code real immediate receipt', async () => {
      const records = await page.evaluate(() => JSON.parse(localStorage.getItem('aether.collaboration-controller-results.v1') || '[]'))
      const matches = records.filter(row => row.message === immediate && row.rootRunId === retryRunning.run.runId)
      assert.ok(matches.length <= 1, 'Duplicate Code immediate acceptance')
      return matches[0]?.kind === 'accepted' ? matches[0] : null
    }, 15_000)
    assert.deepEqual({ rootRunId: accepted.rootRunId, rootAttemptId: accepted.rootAttemptId, rootSessionId: accepted.rootSessionId }, context.scope)
    const afterImmediate = await status('development')
    assert.equal(afterImmediate.run.runId, retryRunning.run.runId); assert.equal(afterImmediate.run.attemptId, retryRunning.run.attemptId)
    persist('code-accepted', { context, accepted, before: retryRunning, after: afterImmediate })
    const delivery = await wait('Code actual JSONL mailbox integration', () => consumed(context.scope, accepted.receipt))
    persist('code-integrated', delivery)
    await wait('Code retry office completion', async () => existsSync(marker('code-complete')) && terminal(await status('development')), Number(options['phase-timeout'] || 480_000))
    const last = await status('development'); assert.equal(last.run.status, 'succeeded')
    assert.notEqual(last.run.runId, cancelled.run.runId); assert.notEqual(last.run.turnId, cancelled.run.turnId)
    const history = await fullArchive('development', 'code-complete-archive')
    assert.equal(history.filter(row => row.id === delivery.history_message_id).length, 1)
    const consumedInput = history.find(row => row.id === delivery.history_message_id)
    assert.ok(consumedInput.content.includes(immediate)); assert.equal(turn(consumedInput), retryRunning.run.turnId)
    const branch = assertResendBranch({ cancelledHistory, history, original, cancelled: cancelled.run, next: last.run, prompt })
    const roots = rootRows('development'); assert.equal(roots.length, 1)
    // Confirmed truncation deletes the old root ledger entry as well. Its
    // cancellation is proved by the pre-resend snapshot/job, not current roots.
    assert.ok(!roots.some(row => row.runId === cancelled.run.runId))
    assert.equal(roots[0].runId, last.run.runId); assert.equal(roots[0].state.status, 'succeeded')
    const commands = assertProbeCalls(branch.commandEvidence, [
      { turnId: cancelled.run.turnId, args: ['window', 'code', 'stop'] },
      { turnId: last.run.turnId, args: ['window', 'code', 'stop'] },
      { turnId: last.run.turnId, args: ['mark', 'code', 'steered'] },
      { turnId: last.run.turnId, args: ['mark', 'code', 'complete'] },
    ])
    const calls = history.filter(row => row.toolCall && turn(row) === last.run.turnId)
    const office = prepared.manifest.office.map(file => {
      const matching = calls.filter(row => row.toolCall.name === 'office_inspect' && basename(row.toolCall.args.path.replaceAll('\\', '/')) === file.name)
      assert.ok(matching.length, 'No native office_inspect call: ' + file.name)
      const results = matching.map(call => ({ call, result: history.find(row => row.role === 'tool' && row.toolCallId === call.toolCall.id) }))
      assert.ok(results.every(item => item.result), 'Office call result missing')
      const content = results.map(item => item.result.content).join('\n')
      assert.ok(content.includes('sha256:' + file.sha256), 'Native inspection lacks exact input hash: ' + file.name)
      assert.ok(!/OFFICE_(?:FAILED|INVALID|FILE_MISSING|VERSION_CONFLICT)/.test(content), 'Office tool failed: ' + file.name)
      if (file.name.endsWith('.pptx')) assert.ok(content.includes('target=notes'), 'PPT native result did not expose notes')
      return { ...file, toolCalls: results }
    })
    // Command-based document parsers cannot accidentally count as native evidence.
    const otherReads = calls.filter(row => row.toolCall.name !== 'office_inspect' && /\.(?:docx|xlsx|pptx|pdf)\b/i.test(JSON.stringify(row.toolCall.args)) && row.toolCall.name !== 'write_file')
    assert.equal(otherReads.length, 0, 'An Office file was accessed through a non-native tool')
    const report = readFileSync(join(prepared.folder, 'office-report.md'), 'utf8')
    assert.ok(/target\s*=\s*notes/.test(report) && /slide\s*=|slide\s*[:：]|第\s*\d+\s*页/.test(report), 'Report lacks a located PPT note quotation')
    const lines = journal('code')
    assert.deepEqual(lines.map(row => row.event), ['first-started', 'retry-started', 'retry-finished', 'mark', 'mark'])
    assert.equal(lines.at(-2).label, 'steered')
    assert.equal(lines.at(-1).label, 'complete')
    checkInputs()
    const result = { passed: true, cancelled: cancelled.run, final: last.run, roots, retry, accepted, delivery, commands, office,
      resendContract: { deletedMessageIds: branch.deletedMessageIds, preservedIn: 'code-cancelled-archive.json', currentArchiveIncludesOldTurn: false,
        oldRootDeletedByConfirmedTruncation: true, recoveryLimit: 'Physical JSONL may retain tombstoned rows; no restore UI or API is implied.' },
      report, journal: lines, archiveMessages: history.length, snapshot: await controller.snapshot(),
      limits: 'Office native text/notes read proven by actual tool calls; report semantic accuracy still needs supervisor review.' }
    persist('code-result', result); event('code-passed'); return result
  }
  return { work, code, output, event }
}
