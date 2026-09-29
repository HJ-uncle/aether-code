/** D3 real provider HTTP -> ReAct -> durable root runs -> Electron UI; no production provider.
 * Covers duplicate-text identity, pending reload/restart, approval side effects, repeat answers and interrupted recovery. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { RootRun } from '../src/shared/root-run'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'd3-local-fixture', key = 'd'.repeat(64)
let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
let requestCount = 0
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
    if (tools.length) { respond(response, body, `D3_FINISHED ${prompt}`); return }
    if (prompt.includes('[d3:ask]')) {
      respond(response,body,'',[{id:'ask-d3',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'D3 选择目标',options:[{label:'feature-a'},{label:'feature-b'}]})}}]);return
    }
    if (prompt.includes('[d3:approve]') || prompt.includes('[d3:reject]')) {
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
async function launch() {
  app=await electron.launch({args:['.',`--user-data-dir=${fixture}`],cwd:root,env:env()})
  page=await app.firstWindow()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90_000})
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
    await app?.close();for(const response of held)response.destroy();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()))
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
    await page.getByRole('button',{name:'feature-a',exact:true}).click()
    await page.locator('.pending-card').getByRole('button',{name:'提交',exact:true}).click()
    const finished=await waitRun('d3-ask','succeeded')
    expect(finished.runId).toBe(waiting.runId);expect(finished.turnId).toBe(waiting.turnId)
    expect(finished.pending[0]).toMatchObject({requestId:waiting.pending[0].requestId,status:'answered',output:'feature-a'})
    const before=requestCount;expect(await duplicateAnswer(finished,'feature-a')).toBe('done');expect(requestCount).toBe(before)
    expect((await messages('d3-ask')).filter(row=>row.role==='user')).toHaveLength(1)
    expect(await duplicateAnswer(finished,'feature-b')).toBe('error');expect(requestCount).toBe(before)
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
    await expect(page.locator('.pending-card')).toContainText('已拒绝这次操作')
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
  test('provider失败和运行中引擎重启保留真实终态，不因done显示成功或自动重试',async()=>{
    await select('d3-fail');await send('[d3:fail]');await waitRun('d3-fail','failed')
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('失败')
    await select('d3-interrupted');await send('[d3:hold]')
    await expect.poll(()=>held.size).toBe(1)
    const before=requestCount;await app!.close();await launch()
    await expect.poll(async()=>(await runs('d3-interrupted')).at(-1)?.status).toBe('interrupted')
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已中断')
    expect(requestCount).toBe(before)
  })
})
