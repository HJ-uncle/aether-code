/** D3 real provider HTTP -> ReAct -> durable root runs -> Electron UI; no production provider.
 * Covers duplicate-text identity, pending reload/restart, approval side effects, repeat answers and interrupted recovery. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'd3-local-fixture', key = 'd'.repeat(64)
let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
let requestCount = 0
let remoteEngine: ChildProcess | undefined
let remoteEngineClosed: Promise<void> | undefined
const held = new Set<ServerResponse>()
const heldBodies = new Map<ServerResponse, ProviderBody>()
type ProviderBody = { stream?: boolean; messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }
function respond(response: ServerResponse, body: ProviderBody, content: string, calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []) {
  const finish = calls.length ? 'tool_calls' : 'stop'
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'd3', model, choices: [{ index: 0, delta: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'd3', model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  } else {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id:'d3',model,choices:[{ index:0,message:{ role:'assistant',content,...(calls.length?{tool_calls:calls}:{}) },finish_reason:finish }],usage:{prompt_tokens:20,completion_tokens:8,total_tokens:28} }))
  }
}
const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''; for await (const chunk of incoming) raw += chunk.toString()
    const body = JSON.parse(raw) as ProviderBody
    requestCount++
    const index = body.messages.findLastIndex(message => message.role === 'user')
    const prompt = String(body.messages[index]?.content ?? '')
    const tools = body.messages.slice(index + 1).filter(message => message.role === 'tool')
    if (prompt.includes('[d3:hold]')) { held.add(response); heldBodies.set(response,body); response.on('close',()=>{held.delete(response);heldBodies.delete(response)}); return }
    if (prompt.includes('[d3:fail]')) { response.writeHead(400, { 'Content-Type':'application/json' }).end(JSON.stringify({error:{message:'D3_PROVIDER_FAILED'}})); return }
    if (prompt.includes('[d3:ask-multi]') && tools.length === 0) {
      respond(response,body,'',[{id:'ask-multi-d3',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'D3 选择开发目标',options:[{label:'feature-multi'},{label:'feature-next'}],questions:[
        {question:'D3 选择开发目标',options:[{label:'feature-multi'},{label:'feature-next'}]},
        {question:'D3 补充验收要求',options:[],allowInput:true}
      ]})}}]);return
    }
    if (prompt.includes('[d3:ask]') && tools.length === 0) {
      respond(response,body,'',[{id:'ask-d3',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'D3 选择目标',options:[{label:'feature-a'},{label:'feature-b'}]})}}]);return
    }
    if (prompt.includes('[d3:approve-twice]')) {
      // Keep the two approvals in one durable run. The second tool call is
      // emitted only after the first tool response so the UI must archive the
      // first interaction before presenting the next actionable card.
      const remote = prompt.includes('[d3:remote]')
      const cancelled = prompt.includes('[d3:cancel-pending]')
      const filePrefix = remote ? 'remote-' : cancelled ? 'cancelled-' : ''
      const marker = remote ? 'D3_APPROVED_WRITE_REMOTE' : cancelled ? 'D3_APPROVED_WRITE_CANCELLED' : 'D3_APPROVED_WRITE'
      const firstAnswered = tools.some(message => message.tool_call_id === 'cmd-approved-twice-a') || tools.length >= 1
      const secondAnswered = tools.some(message => message.tool_call_id === 'cmd-approved-twice-b') || tools.length >= 2
      if (!firstAnswered) {
        respond(response,body,'',[{id:'cmd-approved-twice-a',type:'function',function:{name:'execute_cmd',arguments:JSON.stringify({command:process.execPath,args:['-e',`require('node:fs').writeFileSync('${filePrefix}approved-twice-a.txt','${marker}_A')`],timeoutMs:10000})}}]);return
      }
      if (!secondAnswered) {
        respond(response,body,'',[{id:'cmd-approved-twice-b',type:'function',function:{name:'execute_cmd',arguments:JSON.stringify({command:process.execPath,args:['-e',`require('node:fs').writeFileSync('${filePrefix}approved-twice-b.txt','${marker}_B')`],timeoutMs:10000})}}]);return
      }
      respond(response,body,`D3_FINISHED ${prompt}`);return
    }
    if (tools.length) { respond(response, body, `D3_FINISHED ${prompt}`); return }
    if ((prompt.includes('[d3:approve]') || prompt.includes('[d3:reject]')) && tools.length === 0) {
      const filename = prompt.includes('[d3:reject]') ? 'rejected.txt' : 'approved.txt'
      respond(response,body,'',[{id:`cmd-${filename}`,type:'function',function:{name:'execute_cmd',arguments:JSON.stringify({command:process.execPath,args:['-e',`require('node:fs').writeFileSync('${filename}','D3_APPROVED_WRITE')`],timeoutMs:10000})}}]);return
    }
    respond(response,body,`D3_ECHO ${prompt}`)
  })().catch(error => { if(!response.headersSent)response.writeHead(500);response.end(String(error)) })
})

function env(): NodeJS.ProcessEnv {
  return { ...process.env, AETHER_IDE_ENGINE_ENTRY:join(engineRoot,'dist/main.js'),AUTH_ENABLED:'false',HISTORY_BACKEND:'jsonl',
    LLM_PROVIDER:'openai',LLM_PRIMARY_MODEL:model,LLM_MODEL:model,LLM_FALLBACK_MODEL:'',OPENAI_API_KEY:'local-d3-key',OPENAI_BASE_URL:baseUrl,
    DEFAULT_SECURITY_MODE:'safe',OSM_MODE:'methodology',MAX_ITERATIONS:'5',ENABLE_LONG_TERM_MEMORY:'false',
    AETHER_GLOBAL_DIR:join(fixture,'global'),WORKSPACE_ROOT:join(fixture,'sandboxes'),MCP_CONFIG_PATH:join(fixture,'mcp.json'),SKILLS_ROOT:join(fixture,'skills') }
}
async function launch(overrides: NodeJS.ProcessEnv = {}) {
  app=await electron.launch({args:['.',`--user-data-dir=${fixture}`],cwd:root,env:{...env(),...overrides}})
  page=await app.firstWindow()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90_000}).catch(async error => {
    console.error('D3_ENGINE_STARTUP_FAILURE', JSON.stringify(await page.evaluate(() => window.aether.engine.getSnapshot())))
    throw error
  })
}
async function select(sessionId: string) {
  await page.evaluate(sessionId=>window.aether.settings.update({lastSessionId:sessionId}),sessionId)
  await page.reload()
  await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable','true')
}
async function send(text: string) {
  await page.locator('.chat__input').fill(text)
  await page.getByRole('button',{name:'发送',exact:true}).click()
}
async function captureApprovalScreens(testInfo: TestInfo) {
  const settings = await page.evaluate(() => window.aether.settings.get())
  const resolvedAppearance = await page.locator('html').getAttribute('data-appearance')
  const originalViewport = page.viewportSize()
  const initial = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    layout: localStorage.getItem('aether.ide.layout')
  }))
  try {
    await page.evaluate(async () => { await window.aether.settings.update({appearance:'dark'}) })
    await page.reload()
    await expect.poll(() => page.locator('html').getAttribute('data-appearance')).toBe('dark')
    await expect(page.locator('details.interaction-history').first()).toBeVisible()
    await page.screenshot({path:testInfo.outputPath('approval-history-dark.png'),fullPage:true})
    await page.evaluate(async () => { await window.aether.settings.update({appearance:'light'}) })
    await page.reload()
    await expect.poll(() => page.locator('html').getAttribute('data-appearance')).toBe('light')
    await expect(page.locator('details.interaction-history').first()).toBeVisible()
    await page.screenshot({path:testInfo.outputPath('approval-history-light.png'),fullPage:true})

    // Exercise the actual resizable chat panel, without making the entire IDE
    // smaller than its native minimum window size or hiding other sidebars.
    await page.evaluate(() => {
      const raw = localStorage.getItem('aether.ide.layout')
      const layout = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      localStorage.setItem('aether.ide.layout', JSON.stringify({...layout,chatPanelWidth:280,chatPanelVisible:true}))
    })
    await page.reload()
    const chatPanel = page.locator('.workbench__chat')
    await expect.poll(() => chatPanel.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(279)
    await expect.poll(() => chatPanel.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(281)
    const history = page.locator('details.interaction-history').first()
    const summary = history.locator('summary')
    await expect(history).toHaveJSProperty('open', false)
    await summary.focus()
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(history).toHaveJSProperty('open', true)
    const questions = history.locator('.pending-card__history-question')
    await expect(questions.first()).toBeVisible()
    const readability = await questions.evaluateAll(nodes => nodes.map(node => {
      const el = node as HTMLElement
      const style = getComputedStyle(el)
      return {text:(el.textContent??'').trim(),whiteSpace:style.whiteSpace,overflowX:el.scrollWidth-el.clientWidth,overflowY:el.scrollHeight-el.clientHeight}
    }))
    expect(readability.length).toBeGreaterThan(0)
    for (const question of readability) {
      expect(question.text.length).toBeGreaterThan(0)
      expect(question.whiteSpace).not.toBe('nowrap')
      expect(question.overflowX).toBeLessThanOrEqual(1)
      expect(question.overflowY).toBeLessThanOrEqual(1)
    }
    await page.screenshot({path:testInfo.outputPath('approval-history-narrow.png'),fullPage:true})
    await summary.focus()
    await page.keyboard.press('Space')
    await expect(history).toHaveJSProperty('open', false)
  } finally {
    // Electron normally reports a null viewport. Restore the measured content
    // dimensions, never an invented 1280px width that crosses layout breakpoints.
    const currentSize = await page.evaluate(() => ({width:window.innerWidth,height:window.innerHeight}))
    if (currentSize.width !== initial.width || currentSize.height !== initial.height) {
      await page.setViewportSize(originalViewport ?? {width:initial.width,height:initial.height})
    }
    await page.evaluate(async ({appearance,layout}) => {
      if (layout === null) localStorage.removeItem('aether.ide.layout')
      else localStorage.setItem('aether.ide.layout',layout)
      await window.aether.settings.update({appearance})
    }, {appearance:settings.appearance,layout:initial.layout})
    await page.reload()
    await expect.poll(() => page.locator('html').getAttribute('data-appearance')).toBe(resolvedAppearance)
    await expect.poll(() => page.evaluate(() => ({width:window.innerWidth,height:window.innerHeight}))).toEqual({width:initial.width,height:initial.height})
  }
}
async function runs(sessionId: string): Promise<RootRun[]> {
  const result=await page.evaluate(sessionId=>window.aether.engine.request<{runs:RootRun[]}>({method:'GET',path:'/chat/runs',query:{sessionId}}),sessionId)
  expect(result.ok,result.message).toBe(true); return result.data?.runs??[]
}
async function waitRun(sessionId: string,status:RootRun['status']): Promise<RootRun> {
  await expect.poll(async()=>(await runs(sessionId)).at(-1)?.status,{timeout:45_000}).toBe(status)
  await expect(page.getByRole('button',{name:'停止生成',exact:true})).toBeHidden()
  return (await runs(sessionId)).at(-1)!
}
async function messages(sessionId:string) {
  const result=await page.evaluate(sessionId=>window.aether.engine.request<Array<{id:string;role:string;conversationId:string}>>({method:'GET',path:'/conversation/history',query:{sessionId}}),sessionId)
  expect(result.ok,result.message).toBe(true);return result.data??[]
}
async function duplicateAnswer(run:RootRun,output:string) {
  const pending=run.pending[0]
  return page.evaluate(async({run,pending,output})=>{
    const streamId='d3-duplicate-'+crypto.randomUUID()
    const result=new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>{off();reject(new Error('duplicate response timeout'))},15000)
      const off=window.aether.engine.onStreamEvent(event=>{
        if(event.streamId!==streamId)return
        if(event.type==='done'||event.type==='error'){clearTimeout(timer);off();resolve(event.type)}
      })
    })
    await window.aether.engine.stream.start({streamId,path:'/chat',body:{sessionId:run.sessionId,runId:run.runId,toolResponse:{requestId:pending.requestId,runId:run.runId,toolCallId:pending.toolCallId,name:pending.toolName,output}}})
    return result
  },{run,pending,output})
}

async function stopRemoteEngine(): Promise<void> {
  const child = remoteEngine
  const closed = remoteEngineClosed
  if (!child || !closed) return
  await new Promise<void>((resolve, reject) => {
    const hardStop = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 8_000)
    const deadline = setTimeout(() => { cleanup(); reject(new Error('Owned remote engine did not close')) }, 15_000)
    const cleanup = (): void => { clearTimeout(hardStop); clearTimeout(deadline); child.off('error',failed) }
    const done = (): void => { cleanup(); resolve() }
    const failed = (error: Error): void => { cleanup(); reject(error) }
    // `exit` precedes stdio/native-handle cleanup. The fixture is the child's
    // cwd on Windows, so deleting it must wait for `close`, even when exitCode
    // is already set. The promise is registered at spawn to avoid missing it.
    void closed.then(done,failed)
    child.once('error',failed)
    // Stop only the child handle created by this fixture; never enumerate or
    // terminate another developer engine, Electron instance, or process tree.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  remoteEngine = undefined
  remoteEngineClosed = undefined
}
test.describe.serial('D3 根运行与审批真机验收',()=>{
  test.beforeAll(async()=>{
    await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve))
    const address=provider.address(); if(!address||typeof address==='string')throw new Error('Provider address missing')
    baseUrl=`http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root,'.e2e-tmp'),{recursive:true});fixture=mkdtempSync(join(root,'.e2e-tmp','d3-root-ui-'))
    mkdirSync(join(fixture,'workspace'),{recursive:true});mkdirSync(join(fixture,'engine','secrets'),{recursive:true})
    writeFileSync(join(fixture,'engine','secrets','engine-secrets.json'),JSON.stringify({encrypted:false,encryptionKey:key}))
    writeFileSync(join(fixture,'settings.json'),JSON.stringify({engineMode:'embedded',preferredPort:12419,autoStartEngine:true,lastSessionId:'d3-identical',lastModelId:model,lastFolder:join(fixture,'workspace'),thinkingMode:'off'}))
    const url=(file:string)=>pathToFileURL(join(engineRoot,'dist',file)).href
    const config=Object.fromEntries(Object.entries(env()).filter(([name])=>['LLM_PRIMARY_MODEL','LLM_MODEL','LLM_PROVIDER','LLM_FALLBACK_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','DEFAULT_SECURITY_MODE','OSM_MODE','MAX_ITERATIONS','HISTORY_BACKEND'].includes(name)))
    const seed=`const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});
      const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});
      const {policyEngine}=await import(${JSON.stringify(url('security/policy-engine.js'))});
      await initDb();await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'local-d3-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'D3 local fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});
      await policyEngine.listRules();await policyEngine.upsertRule({name:'d3-fixture-command-approval',command:'*',argPattern:'D3_APPROVED_WRITE',action:'ask',priority:1,enabled:true,description:'D3 synthetic command marker requires one approval'});
      for(const [name,value] of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');getDb().close();`
    execFileSync(process.execPath,['--input-type=module','-e',seed],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...env(),DATA_DIR:join(fixture,'engine','state','agent.db'),ENCRYPTION_KEY:key}})
    await launch()
  })
  test.afterAll(async()=>{
    try { await app?.close() } finally { await stopRemoteEngine() }
    for(const response of held)response.destroy();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()))
    if(!fixture)return;const resolved=resolve(fixture)
    if(dirname(resolved)!==resolve(root,'.e2e-tmp')||!basename(resolved).startsWith('d3-root-ui-'))throw new Error('Unsafe D3 fixture cleanup')
    rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  })
  test('两条继续使用不同稳定ID，实时删除第二轮只删除指定轮次',async()=>{
    await send('继续');const first=await waitRun('d3-identical','succeeded')
    await send('继续');await expect.poll(async()=>(await runs('d3-identical')).length).toBe(2)
    const second=await waitRun('d3-identical','succeeded')
    expect(first.userMessageId).not.toBe(second.userMessageId)
    await expect(page.locator('.message--user')).toHaveCount(2)
    const secondBubble=page.locator('.message--user').nth(1)
    await expect(secondBubble).toHaveAttribute('data-message-id',second.userMessageId)
    await expect(secondBubble).toHaveAttribute('data-turn-id',second.turnId)
    await secondBubble.hover()
    await secondBubble.getByRole('button',{name:'删除本轮',exact:true}).click()
    await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click()
    await expect.poll(async()=>(await messages('d3-identical')).filter(row=>row.role==='user').map(row=>row.id)).toEqual([first.userMessageId])
    await expect(page.locator('.message--user')).toHaveCount(1)
  })
  test('待提问刷新及引擎重启后仍可按requestId应答，相同回答不重复执行',async()=>{
    await select('d3-ask');await send('[d3:ask]');const waiting=await waitRun('d3-ask','waiting')
    expect(waiting.pending).toHaveLength(1)
    await page.reload();await expect(page.locator('.pending-card')).toContainText('D3 选择目标')
    await app!.close();await launch()
    await expect(page.locator('.pending-card')).toContainText('D3 选择目标')
    const choice = page.getByRole('button',{name:'feature-a',exact:true})
    await expect(choice).toHaveAttribute('aria-pressed','false')
    await choice.focus()
    await page.keyboard.press('Space')
    await expect(choice).toHaveAttribute('aria-pressed','true')
    const submit = page.locator('.pending-card').getByRole('button',{name:'提交',exact:true})
    await submit.focus()
    await page.keyboard.press('Enter')
    const finished=await waitRun('d3-ask','succeeded')
    expect(finished.runId).toBe(waiting.runId);expect(finished.turnId).toBe(waiting.turnId)
    expect(finished.pending[0]).toMatchObject({requestId:waiting.pending[0].requestId,status:'answered',output:'feature-a'})
    await expect(page.locator('.pending-card')).toHaveCount(0)
    const askHistory=page.locator('details.interaction-history').first()
    await expect(askHistory).toBeVisible()
    await expect(askHistory.locator('.interaction-history__result')).toContainText('已应答')
    await expect(askHistory).toHaveJSProperty('open', false)
    const before=requestCount;expect(await duplicateAnswer(finished,'feature-a')).toBe('done');expect(requestCount).toBe(before)
    expect((await messages('d3-ask')).filter(row=>row.role==='user')).toHaveLength(1)
    expect(await duplicateAnswer(finished,'feature-b')).toBe('error');expect(requestCount).toBe(before)
  })
  test('多问题应答历史保留完整问题与用户原文，刷新后仍然可读',async()=>{
    const answer = '英文逗号,中文逗号，原样保留'
    await select('d3-ask-multi');await send('[d3:ask-multi]')
    await waitRun('d3-ask-multi','waiting')
    await page.getByRole('button',{name:'feature-multi',exact:true}).click()
    await page.getByRole('textbox',{name:'D3 补充验收要求',exact:true}).fill(answer)
    await page.locator('.pending-card').getByRole('button',{name:'提交',exact:true}).click()
    const finished = await waitRun('d3-ask-multi','succeeded')
    expect(finished.pending[0].output).toBe(`feature-multi,${answer}`)
    await page.reload()
    await expect(page.locator('.pending-card')).toHaveCount(0)
    const history = page.locator('details.interaction-history')
    await expect(history).toHaveJSProperty('open',false)
    await history.locator('summary').click()
    await expect(history.locator('.pending-card__history-question')).toHaveText('1. D3 选择开发目标\n2. D3 补充验收要求')
    await expect(history.locator('.interaction-history__result .pending-card__summary-choice')).toHaveText(`feature-multi,${answer}`)
  })
  test('safe命令批准前无副作用、批准后写入；拒绝保留磁盘',async()=>{
    await select('d3-approve');await send('[d3:approve]');await waitRun('d3-approve','waiting')
    expect(existsSync(join(fixture,'workspace','approved.txt'))).toBe(false)
    await page.getByRole('button',{name:'允许执行',exact:true}).click()
    await waitRun('d3-approve','succeeded')
    expect(readFileSync(join(fixture,'workspace','approved.txt'),'utf8')).toBe('D3_APPROVED_WRITE')
    await select('d3-reject');await send('[d3:reject]');await waitRun('d3-reject','waiting')
    await page.getByRole('button',{name:'拒绝',exact:true}).click();await waitRun('d3-reject','succeeded')
    expect(existsSync(join(fixture,'workspace','rejected.txt'))).toBe(false)
    // Answered interactions are archived in a collapsed history record. They
    // must not remain actionable cards after the run has finished.
    await expect(page.locator('.pending-card')).toHaveCount(0)
    const rejectionHistory = page.locator('details.interaction-history').first()
    await expect(rejectionHistory).toBeVisible()
    await expect(rejectionHistory.locator('summary')).toContainText('确认记录')
    await expect(rejectionHistory.locator('.interaction-history__result')).toContainText('已拒绝')
    await expect(rejectionHistory.locator('[data-request-id]')).toHaveCount(1)
    await expect(rejectionHistory).toHaveJSProperty('open', false)
    await rejectionHistory.locator('summary').click()
    await expect(rejectionHistory.locator('.interaction-history__result')).toContainText('已拒绝')
    await page.reload()
    await expect(page.locator('.pending-card')).toHaveCount(0)
    const rejectionAfterReload = page.locator('details.interaction-history').first()
    await expect(rejectionAfterReload).toBeVisible()
    await expect(rejectionAfterReload).toHaveJSProperty('open', false)
  })
  test('同一运行连续两次批准后只保留折叠记录，刷新后不再出现可操作卡片',async({},testInfo)=>{
    await select('d3-approve-twice');await send('[d3:approve-twice]')
    const firstWaiting=await waitRun('d3-approve-twice','waiting')
    const firstPending=firstWaiting.pending.find(item=>item.status==='pending') ?? firstWaiting.pending[0]
    expect(firstPending?.requestId).toBeTruthy()
    await expect(page.locator('.pending-card')).toContainText('允许这次操作？')
    await expect(page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true})).toBeVisible()
    await page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true}).click()
    await expect.poll(async()=>((await runs('d3-approve-twice')).at(-1)?.pending??[]).filter(item=>item.status==='pending').length,{timeout:45_000}).toBe(1)
    const secondRun=(await runs('d3-approve-twice')).at(-1)!
    const secondPending=secondRun.pending.find(item=>item.status==='pending')!
    expect(secondPending.requestId).toBeTruthy()
    expect(secondPending.requestId).not.toBe(firstPending?.requestId)
    await expect(page.locator('.pending-card')).toHaveCount(1)
    await expect(page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true})).toBeVisible()
    await page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true}).click()
    await waitRun('d3-approve-twice','succeeded')
    expect(readFileSync(join(fixture,'workspace','approved-twice-a.txt'),'utf8')).toBe('D3_APPROVED_WRITE_A')
    expect(readFileSync(join(fixture,'workspace','approved-twice-b.txt'),'utf8')).toBe('D3_APPROVED_WRITE_B')
    await expect(page.locator('.pending-card')).toHaveCount(0)
    const histories=page.locator('details.interaction-history')
    await expect.poll(()=>histories.count(),{timeout:15_000}).toBeGreaterThan(0)
    await expect.poll(()=>page.locator('details.interaction-history [data-request-id]').count(),{timeout:15_000}).toBeGreaterThanOrEqual(2)
    const historyState=await histories.evaluateAll(nodes=>({
      open:nodes.filter(node=>(node as HTMLDetailsElement).open).length,
      summaries:nodes.map(node=>node.querySelector('summary')?.textContent??''),
      results:nodes.flatMap(node=>Array.from(node.querySelectorAll('.interaction-history__result')).map(result=>result.textContent??''))
    }))
    expect(historyState.open).toBe(0)
    expect(historyState.summaries.every(text=>text.includes('确认记录'))).toBe(true)
    expect(historyState.results.filter(text=>text.includes('已允许')).length).toBeGreaterThanOrEqual(2)
    const historyIds=await page.locator('details.interaction-history [data-request-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-request-id')).filter((id):id is string=>Boolean(id)))
    expect(new Set(historyIds).size).toBeGreaterThanOrEqual(2)
    await page.reload()
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect.poll(()=>page.locator('details.interaction-history').count(),{timeout:15_000}).toBeGreaterThan(0)
    await expect.poll(()=>page.locator('details.interaction-history [data-request-id]').count(),{timeout:15_000}).toBeGreaterThanOrEqual(2)
    const reloadedHistory=await page.locator('details.interaction-history').evaluateAll(nodes=>({
      open:nodes.filter(node=>(node as HTMLDetailsElement).open).length,
      results:nodes.flatMap(node=>Array.from(node.querySelectorAll('.interaction-history__result')).map(result=>result.textContent??''))
    }))
    expect(reloadedHistory.open).toBe(0)
    expect(reloadedHistory.results.filter(text=>text.includes('已允许')).length).toBeGreaterThanOrEqual(2)
    await captureApprovalScreens(testInfo)
  })
  test('A运行时切到B，A迟到的正文和终态不写入B界面',async()=>{
    await select('d3-switch-a');await send('[d3:hold] switching')
    await expect.poll(()=>held.size).toBe(1)
    await page.getByRole('button',{name:'会话历史',exact:true}).click()
    await page.getByRole('button',{name:'刷新会话列表',exact:true}).click()
    const target=page.locator('.history-view__item').filter({hasText:'继续'}).first()
    await expect(target).toBeVisible();await target.click()
    await expect(page.locator('.chat-panel')).toContainText('D3_ECHO 继续')
    await expect(page.locator('.chat-panel')).not.toContainText('[d3:hold] switching')
    for(const response of [...held])respond(response,heldBodies.get(response)!,'D3_LATE_A_OUTPUT')
    await expect.poll(async()=>(await runs('d3-switch-a')).at(-1)?.status).toBe('succeeded')
    await expect(page.locator('.chat-panel')).not.toContainText('D3_LATE_A_OUTPUT')
    await expect(page.locator('.message--user')).toHaveCount(1)
  })
  test('provider失败、用户取消和运行中引擎重启保留真实终态，不因done显示成功或自动重试',async()=>{
    await select('d3-fail');await send('[d3:fail]');await waitRun('d3-fail','failed')
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('失败')
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect(page.locator('.pending-card button')).toHaveCount(0)
    await select('d3-cancel');await send('[d3:hold]')
    await expect.poll(()=>held.size).toBe(1)
    await page.getByRole('button',{name:'停止生成',exact:true}).click()
    await waitRun('d3-cancel','cancelled')
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已取消')
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect(page.locator('.pending-card button')).toHaveCount(0)
    await select('d3-interrupted');await send('[d3:hold]')
    await expect.poll(()=>held.size).toBe(1)
    const before=requestCount;await app!.close();await launch()
    await expect.poll(async()=>(await runs('d3-interrupted')).at(-1)?.status).toBe('interrupted')
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已中断')
    expect(requestCount).toBe(before)
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect(page.locator('.pending-card button')).toHaveCount(0)
  })
  test('待审批被外部取消后旧按钮应答冲突自动同步，刷新保留未执行历史',async()=>{
    const sessionId = 'd3-pending-cancelled'
    const firstFile = join(fixture,'workspace','cancelled-approved-twice-a.txt')
    const secondFile = join(fixture,'workspace','cancelled-approved-twice-b.txt')
    await select(sessionId)
    await send('[d3:approve-twice] [d3:cancel-pending]')
    const waiting = await waitRun(sessionId,'waiting')
    expect(waiting.pending.filter(item => item.status === 'pending')).toHaveLength(1)
    await expect(page.locator('.pending-card')).toHaveCount(1)
    await expect(page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true})).toBeEnabled()
    expect(existsSync(firstFile)).toBe(false)
    expect(existsSync(secondFile)).toBe(false)
    const beforeCancel = requestCount
    // This models cancellation by the service/another client. The current UI
    // offers decline for waiting approvals; it does not expose a cancel button.
    const cancelled = await page.evaluate(sessionId => window.aether.engine.request<{cancelled:boolean}>({method:'POST',path:'/chat/cancel',body:{sessionId}}),sessionId)
    expect(cancelled.ok,cancelled.message).toBe(true)
    expect(cancelled.data?.cancelled).toBe(true)
    await waitRun(sessionId,'cancelled')
    // Another client can cancel while this client still shows the waiting card.
    // A stale answer must refresh the authoritative state without a manual reload.
    await page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true}).click()
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已取消')
    await page.reload()
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已取消')
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect(page.getByRole('button',{name:'允许执行',exact:true})).toHaveCount(0)
    await expect(page.getByRole('button',{name:'拒绝',exact:true})).toHaveCount(0)
    const history = page.locator('details.interaction-history')
    await expect(history).toHaveCount(1)
    await expect(history).toHaveJSProperty('open',false)
    await expect(history.locator('[data-request-id]')).toHaveCount(1)
    await expect(history.locator('.interaction-history__result')).toContainText('未执行')
    expect(existsSync(firstFile)).toBe(false)
    expect(existsSync(secondFile)).toBe(false)
    expect(requestCount).toBe(beforeCancel)
  })
  test('远端独立引擎连续审批、未决刷新与客户端重开保留真实状态和折叠记录',async({},testInfo)=>{
    const settings = await page.evaluate(() => window.aether.settings.get())
    await app!.close()
    app = undefined
    const portProbe = createServer()
    await new Promise<void>((resolve,reject) => { portProbe.once('error',reject); portProbe.listen(0,'127.0.0.1',resolve) })
    const address = portProbe.address()
    if (!address || typeof address === 'string') throw new Error('Remote fixture port unavailable')
    const port = address.port
    await new Promise<void>((resolve,reject) => portProbe.close(error => error ? reject(error) : resolve()))
    const remoteUrl = `http://127.0.0.1:${port}`
    const token = 'd3-remote-approval-fixture-instance-token'
    let remoteLaunchError: Error | undefined
    let remoteStartupLog = ''
    remoteEngine = spawn(process.execPath,[join(engineRoot,'dist/main.js')],{
      cwd:fixture,
      windowsHide:true,
      stdio:['ignore','pipe','pipe'],
      env:{...env(),PORT:String(port),HOST:'127.0.0.1',DATA_DIR:join(fixture,'engine','state','agent.db'),ENCRYPTION_KEY:key,AETHER_INSTANCE_TOKEN:token}
    })
    remoteEngineClosed = new Promise<void>(resolveClose => remoteEngine!.once('close',() => resolveClose()))
    remoteEngine.on('error',error => { remoteLaunchError = error })
    const rememberStartup = (chunk: Buffer): void => { remoteStartupLog = (remoteStartupLog + chunk.toString()).slice(-4000) }
    remoteEngine.stdout?.on('data',rememberStartup)
    remoteEngine.stderr?.on('data',rememberStartup)
    await expect.poll(async()=>{
      if (remoteLaunchError) throw remoteLaunchError
      if (remoteEngine?.exitCode !== null) throw new Error(`Remote fixture exited: ${remoteEngine?.exitCode}\n${remoteStartupLog.replaceAll(token,'[fixture token]').replaceAll(key,'[fixture key]')}`)
      try { return (await fetch(`${remoteUrl}/health`,{signal:AbortSignal.timeout(2_000)})).status } catch { return 0 }
    },{timeout:90_000}).toBe(200)
    expect([401,403]).toContain((await fetch(`${remoteUrl}/api/v1/tools`,{signal:AbortSignal.timeout(5_000)})).status)
    const workspace = join(fixture,'workspace')
    const firstFile = join(workspace,'remote-approved-twice-a.txt')
    const secondFile = join(workspace,'remote-approved-twice-b.txt')
    writeFileSync(join(fixture,'settings.json'),JSON.stringify({...settings,engineMode:'remote',remoteBaseUrl:remoteUrl,remoteWorkspaceRoot:workspace,autoStartEngine:true}))
    const remoteEnvironment = {AETHER_IDE_REMOTE_INSTANCE_TOKEN:token}
    await launch(remoteEnvironment)
    expect(await page.evaluate(() => window.aether.engine.getSnapshot())).toMatchObject({mode:'remote',phase:'ready',baseUrl:remoteUrl,pid:null})
    expect(await page.evaluate(() => window.aether.settings.remoteTokenStatus())).toMatchObject({configured:true,source:'environment'})
    // Remote selection is persisted per endpoint, independently of the local
    // lastSessionId in settings.json. Read the same key as AppProvider uses.
    const remoteSessionKey = sessionStorageKey('aether:lastSessionId', engineStorageKey({mode:'remote',baseUrl:remoteUrl}))
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key)?.trim() ?? '',remoteSessionKey)).not.toBe('')
    const sessionId = await page.evaluate(key => localStorage.getItem(key)?.trim() ?? '',remoteSessionKey)
    expect(sessionId).not.toBe('')
    expect(existsSync(firstFile)).toBe(false)
    expect(existsSync(secondFile)).toBe(false)
    await send('[d3:approve-twice] [d3:remote]')
    const firstRun = await waitRun(sessionId,'waiting')
    expect(firstRun.sessionId).toBe(sessionId)
    const firstRequest = firstRun.pending.find(item => item.status === 'pending')!
    expect(firstRequest).toBeDefined()
    const activeCard = page.locator('.pending-card')
    const allow = activeCard.getByRole('button',{name:'允许执行',exact:true})
    const decline = activeCard.getByRole('button',{name:'拒绝',exact:true})
    await expect(activeCard).toBeVisible()
    await activeCard.scrollIntoViewIfNeeded()
    await expect(allow).toBeVisible()
    await expect(decline).toBeVisible()
    await expect(allow).toBeEnabled()
    await expect(decline).toBeEnabled()
    await allow.focus()
    await expect(allow).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(decline).toBeFocused()
    const activeGeometry = await activeCard.evaluate(node => {
      const card = node as HTMLElement
      const box = card.getBoundingClientRect()
      const buttons = Array.from(card.querySelectorAll('.pending-card__options button')).map(button => {
        const rect = button.getBoundingClientRect()
        return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}
      })
      return {overflowX:card.scrollWidth-card.clientWidth,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},buttons}
    })
    expect(activeGeometry.overflowX).toBeLessThanOrEqual(1)
    expect(activeGeometry.buttons).toHaveLength(2)
    for (const button of activeGeometry.buttons) {
      expect(button.width).toBeGreaterThan(1)
      expect(button.height).toBeGreaterThan(1)
      expect(button.left).toBeGreaterThanOrEqual(activeGeometry.box.left-1)
      expect(button.right).toBeLessThanOrEqual(activeGeometry.box.right+1)
      expect(button.top).toBeGreaterThanOrEqual(activeGeometry.box.top-1)
      expect(button.bottom).toBeLessThanOrEqual(activeGeometry.box.bottom+1)
    }
    await page.screenshot({path:testInfo.outputPath('active-remote-approval.png'),fullPage:true})
    expect((await runs(sessionId)).at(-1)?.status).toBe('waiting')
    await expect(page.locator('.pending-card')).toHaveCount(1)
    await expect(page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true})).toBeEnabled()
    expect(existsSync(firstFile)).toBe(false)
    expect(existsSync(secondFile)).toBe(false)
    await page.reload()
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key),remoteSessionKey)).toBe(sessionId)
    await expect(page.locator('.pending-card')).toHaveCount(1)
    expect((await runs(sessionId)).at(-1)?.pending.find(item => item.status === 'pending')?.requestId).toBe(firstRequest.requestId)
    await page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true}).click()
    await expect.poll(async()=>{
      const current = (await runs(sessionId)).at(-1)
      const next = current?.pending.find(item => item.status === 'pending')
      return current?.status === 'waiting' && next?.requestId !== firstRequest.requestId && Boolean(next)
    },{timeout:45_000}).toBe(true)
    const secondRun = (await runs(sessionId)).at(-1)!
    const secondRequest = secondRun.pending.find(item => item.status === 'pending')!
    expect(secondRun.runId).toBe(firstRun.runId)
    expect(readFileSync(firstFile,'utf8')).toBe('D3_APPROVED_WRITE_REMOTE_A')
    expect(existsSync(secondFile)).toBe(false)
    await expect(page.locator('.pending-card')).toHaveCount(1)
    await expect(page.locator('details.interaction-history [data-request-id]')).toHaveCount(1)
    await page.reload()
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key),remoteSessionKey)).toBe(sessionId)
    await expect(page.locator('.pending-card')).toHaveCount(1)
    expect((await runs(sessionId)).at(-1)?.pending.find(item => item.status === 'pending')?.requestId).toBe(secondRequest.requestId)
    expect(existsSync(secondFile)).toBe(false)
    await page.locator('.pending-card').getByRole('button',{name:'允许执行',exact:true}).click()
    const finished = await waitRun(sessionId,'succeeded')
    expect(finished.pending.filter(item => item.status === 'answered')).toHaveLength(2)
    expect(readFileSync(secondFile,'utf8')).toBe('D3_APPROVED_WRITE_REMOTE_B')
    await expect(page.locator('.pending-card')).toHaveCount(0)
    await expect(page.locator('details.interaction-history')).toHaveCount(1)
    await expect(page.locator('details.interaction-history')).toHaveJSProperty('open',false)
    await expect(page.locator('details.interaction-history [data-request-id]')).toHaveCount(2)
    await expect(page.locator('.interaction-history__result')).toHaveText([/已允许/,/已允许/])
    const beforeReopen = requestCount
    await app!.close()
    app = undefined
    expect(remoteEngine.exitCode).toBeNull()
    expect((await fetch(`${remoteUrl}/health`,{signal:AbortSignal.timeout(5_000)})).status).toBe(200)
    await launch(remoteEnvironment)
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key),remoteSessionKey)).toBe(sessionId)
    await expect(page.locator('details.interaction-history [data-request-id]')).toHaveCount(2)
    await expect(page.locator('details.interaction-history')).toHaveJSProperty('open',false)
    await expect(page.locator('.pending-card')).toHaveCount(0)
    expect((await runs(sessionId)).at(-1)?.status).toBe('succeeded')
    expect(requestCount).toBe(beforeReopen)
    expect(readFileSync(firstFile,'utf8')).toBe('D3_APPROVED_WRITE_REMOTE_A')
    expect(readFileSync(secondFile,'utf8')).toBe('D3_APPROVED_WRITE_REMOTE_B')
  })
})
