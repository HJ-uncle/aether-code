/** D4 actual local HTTP provider -> engine -> Electron reload/restart with no reexecution. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global { interface Window { aether: AetherIdeApi } }
const root=resolve(__dirname,'..'),requestedEngineRoot=process.env.AETHER_TEST_ENGINE_ROOT?.trim(),model='d4-local-fixture',key='e'.repeat(64)
if(requestedEngineRoot&&!isAbsolute(requestedEngineRoot))throw new Error('AETHER_TEST_ENGINE_ROOT must be an absolute path to the built engine candidate')
const engineRoot=requestedEngineRoot?resolve(requestedEngineRoot):resolve(root,'..','ai-agent-engine'),engineEntry=join(engineRoot,'dist','main.js')
function assertEngineCandidate(){
  if(!existsSync(engineEntry)||!statSync(engineEntry).isFile())throw new Error(`Missing built engine candidate: ${engineEntry}`)
}
// An explicit candidate must never silently fall back to the sibling repository's old dist.
if(requestedEngineRoot)assertEngineCandidate()
let fixture='',baseUrl='',app:ElectronApplication|undefined,page:Page,requests=0
let first:ServerResponse|undefined,afterTools:ServerResponse|undefined,stopping:ServerResponse|undefined,external:ServerResponse|undefined
function delta(response:ServerResponse,value:Record<string,unknown>,finish:string|null=null){
  response.write(`data: ${JSON.stringify({id:'d4',model,choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`)
}
function finish(response:ServerResponse,reason:string){delta(response,{},reason);response.end('data: [DONE]\n\n')}
const provider=createServer((incoming,response)=>{
  void(async()=>{
    let raw='';for await(const chunk of incoming)raw+=chunk.toString()
    const body=JSON.parse(raw) as {messages:Array<{role:string;content?:unknown}>}
    requests++
    const index=body.messages.findLastIndex(message=>message.role==='user')
    const prompt=JSON.stringify(body.messages[index]?.content)
    const toolResults=body.messages.slice(index+1).filter(message=>message.role==='tool')
    response.writeHead(200,{'Content-Type':'text/event-stream'})
    if(prompt.includes('[d4:external]')){external=response;delta(response,{role:'assistant',content:'D4_EXTERNAL_RUNNING'});return}
    if(prompt.includes('[d4:stop]')){stopping=response;delta(response,{reasoning_content:'D4_STOP_REASON'});return}
    if(toolResults.length){afterTools=response;delta(response,{reasoning_content:'D4_AFTER_TOOLS'});return}
    first=response
    delta(response,{role:'assistant',reasoning_content:'D4_RECOVER_REASON'})
    delta(response,{tool_calls:[{index:0,id:'write-d4',type:'function',function:{name:'write_file',arguments:'{"path":"recovered.txt","data":"D4'}}]})
  })().catch(error=>{if(!response.headersSent)response.writeHead(500);response.end(String(error))})
})
function env():NodeJS.ProcessEnv{return {...process.env,AETHER_IDE_ENGINE_ENTRY:engineEntry,AUTH_ENABLED:'false',HISTORY_BACKEND:'jsonl',LLM_PROVIDER:'openai',LLM_PRIMARY_MODEL:model,LLM_MODEL:model,LLM_FALLBACK_MODEL:'',OPENAI_API_KEY:'local-d4-key',OPENAI_BASE_URL:baseUrl,DEFAULT_SECURITY_MODE:'safe',OSM_MODE:'methodology',MAX_ITERATIONS:'5',ENABLE_LONG_TERM_MEMORY:'false',AETHER_GLOBAL_DIR:join(fixture,'global'),WORKSPACE_ROOT:join(fixture,'sandboxes'),MCP_CONFIG_PATH:join(fixture,'mcp.json'),SKILLS_ROOT:join(fixture,'skills')}}
async function launch(){app=await electron.launch({args:[process.env.AETHER_E2E_APP_ENTRY||'.',`--user-data-dir=${fixture}`],cwd:root,env:env()});page=await app.firstWindow();await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90000})}
async function snapshot(sessionId='d4-recovery'){
  const response=await page.evaluate(sessionId=>window.aether.engine.request<ChatRecoverySnapshot>({method:'GET',path:'/chat/snapshot',query:{sessionId}}),sessionId)
  expect(response.ok,response.message).toBe(true);return response.data!
}
async function send(text:string){await page.locator('.chat__input').fill(text);await page.getByRole('button',{name:'发送',exact:true}).click()}
async function reload(){await page.reload();await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable','true')}
async function expectTodo(){await page.getByRole('button',{name:'任务 0/1',exact:true}).click();await expect(page.locator('.todo-tray')).toContainText('D4_DURABLE_TODO')}
interface MutationGateState { holding:boolean; startedAt:number; mutations:number; status:number; snapshots:number; afterStatus:number }
async function holdMutation(method:'DELETE'|'POST',path:string){
  await app!.evaluate((_electron,{method,path})=>{
    const original=globalThis.fetch
    let resume!:()=>void
    const pending=new Promise<void>(resolve=>{resume=resolve})
    const state:MutationGateState={holding:false,startedAt:0,mutations:0,status:0,snapshots:0,afterStatus:0}
    Reflect.set(globalThis,'__d4MutationGate',{original,state,release:()=>{state.holding=false;resume()}})
    // Delay only the owned mutation's dispatch. Every HTTP response still comes
    // from the real engine; no historical data or success result is fabricated.
    globalThis.fetch=async(input,init)=>{
      const value=typeof input==='string'?input:input instanceof URL?input.href:input.url
      const url=new URL(value)
      if(url.pathname===`/api/v1${path}`&&init?.method===method){
        state.mutations++;state.holding=true;state.startedAt=Date.now();await pending
      }
      if(url.searchParams.get('sessionId')==='d4-recovery'){
        if(url.pathname==='/api/v1/chat/status'){
          if(state.holding)state.status++;else if(state.startedAt)state.afterStatus++
        }
        if(url.pathname==='/api/v1/chat/snapshot'&&state.holding)state.snapshots++
      }
      return original.call(globalThis,input,init)
    }
  },{method,path})
}
async function mutationState(){return app!.evaluate(()=>({...Reflect.get(globalThis,'__d4MutationGate').state}) as MutationGateState)}
async function expectMutationReadSilence(){
  await expect.poll(async()=>(await mutationState()).holding).toBe(true)
  // The observation interval intentionally spans two 2.5s discovery ticks;
  // readiness itself is the held dispatch signal above, not this elapsed time.
  await expect.poll(async()=>{
    const state=await mutationState();return Date.now()-state.startedAt
  },{timeout:10000}).toBeGreaterThanOrEqual(5500)
  expect(await mutationState()).toMatchObject({holding:true,mutations:1,status:0,snapshots:0})
}
async function releaseMutation(){await app!.evaluate(()=>Reflect.get(globalThis,'__d4MutationGate')?.release())}
async function restoreMutationFetch(){
  await app!.evaluate(()=>{
    const gate=Reflect.get(globalThis,'__d4MutationGate') as {original:typeof fetch;release:()=>void}|undefined
    gate?.release();if(gate)globalThis.fetch=gate.original
    Reflect.deleteProperty(globalThis,'__d4MutationGate')
  })
}
test.describe.serial('D4 快照和消费游标真机验收',()=>{
  test.beforeAll(async()=>{
    assertEngineCandidate()
    await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();if(!address||typeof address==='string')throw new Error('missing local provider address');baseUrl=`http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root,'.e2e-tmp'),{recursive:true});fixture=mkdtempSync(join(root,'.e2e-tmp','d4-recovery-ui-'))
    mkdirSync(join(fixture,'workspace'),{recursive:true});mkdirSync(join(fixture,'engine','secrets'),{recursive:true})
    writeFileSync(join(fixture,'note.txt'),'D4 attachment reference')
    writeFileSync(join(fixture,'engine','secrets','engine-secrets.json'),JSON.stringify({encrypted:false,encryptionKey:key}))
    writeFileSync(join(fixture,'settings.json'),JSON.stringify({engineMode:'embedded',preferredPort:12421,autoStartEngine:true,lastSessionId:'d4-recovery',lastModelId:model,lastFolder:join(fixture,'workspace'),thinkingMode:'high'}))
    const url=(file:string)=>pathToFileURL(join(engineRoot,'dist',file)).href
    const config=Object.fromEntries(Object.entries(env()).filter(([name])=>['LLM_PRIMARY_MODEL','LLM_MODEL','LLM_PROVIDER','LLM_FALLBACK_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','DEFAULT_SECURITY_MODE','OSM_MODE','MAX_ITERATIONS','HISTORY_BACKEND'].includes(name)))
    const seed=`const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});await initDb();await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'local-d4-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'D4 local fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,thinking:true,contextWindow:128000}});for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');getDb().close();`
    execFileSync(process.execPath,['--input-type=module','-e',seed],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...env(),DATA_DIR:join(fixture,'engine','state','agent.db'),ENCRYPTION_KEY:key}})
    await launch()
  })
  test.afterAll(async()=>{
    await app?.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()))
    if(!fixture)return;const absolute=resolve(fixture);if(dirname(absolute)!==resolve(root,'.e2e-tmp')||!basename(absolute).startsWith('d4-recovery-ui-'))throw new Error('unsafe cleanup')
    rmSync(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  })
  test('部分思考和工具参数刷新恢复，工具执行后再刷新不会重发或重复写入',async()=>{
    // The engine status can precede the renderer's model/session hydration.
    // A real user enters through this enabled action; setting a hidden input
    // before it is enabled intentionally gets ignored by the composer.
    await expect(page.getByRole('button',{name:'添加附件或引用',exact:true})).toBeEnabled()
    await page.locator('input[type=file]').setInputFiles(join(fixture,'note.txt'))
    await expect(page.locator('.attach-chip')).toContainText('note.txt')
    await send('[d4:recover]')
    await expect(page.locator('.message--assistant')).toContainText('D4_RECOVER_REASON')
    await expect.poll(async()=>(await snapshot()).projection.some(item=>Boolean(item.toolArgs))).toBe(true)
    expect(requests).toBe(1);expect(existsSync(join(fixture,'workspace','recovered.txt'))).toBe(false)
    await reload()
    await expect(page.locator('.message--assistant')).toContainText('D4_RECOVER_REASON')
    await expect(page.locator('.message--user .message__attachments')).toContainText('note.txt')
    await expect(page.locator('.message--assistant')).toHaveCount(1)
    // The localized name may differ; the raw partial argument remains a visible summary.
    await expect(page.locator('.message--assistant')).toContainText('recovered.txt')
    expect(requests).toBe(1)
    delta(first!,{tool_calls:[{index:0,function:{arguments:'_WRITTEN"}'}},{index:1,id:'todo-d4',type:'function',function:{name:'todo_create',arguments:'{"title":"D4_DURABLE_TODO"}'}}]});finish(first!,'tool_calls')
    await expect.poll(()=>Boolean(afterTools)).toBe(true)
    await expect.poll(()=>existsSync(join(fixture,'workspace','recovered.txt'))).toBe(true)
    expect(readFileSync(join(fixture,'workspace','recovered.txt'),'utf8')).toBe('D4_WRITTEN')
    await expect(page.locator('.diff-card')).toHaveCount(1)
    await expectTodo()
    const before=await snapshot();expect(before.changes).toHaveLength(1);expect(before.todos).toHaveLength(1)
    await reload();await expect(page.locator('.diff-card')).toHaveCount(1);await expectTodo()
    await expect(page.locator('.message--assistant')).toContainText('D4_AFTER_TOOLS')
    expect(requests).toBe(2);expect((await snapshot()).changes).toHaveLength(1)
    delta(afterTools!,{content:'D4_FINAL_OUTPUT'});finish(afterTools!,'stop')
    await expect.poll(async()=>(await snapshot()).run?.status).toBe('succeeded')
    await expect(page.locator('.message--assistant')).toContainText('D4_FINAL_OUTPUT')
    await reload();await expect(page.locator('.message--assistant')).toHaveCount(1);await expect(page.locator('.diff-card')).toHaveCount(1)
    expect(requests).toBe(2)
  })
  test('结束后重启从持久化快照恢复附件待办和改动，过期游标透传恢复信号',async()=>{
    await app!.close();await launch()
    await expect(page.locator('.message--user .message__attachments')).toContainText('note.txt')
    await expectTodo()
    await expect(page.locator('.diff-card')).toHaveCount(1)
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已完成')
    const persisted=await snapshot();expect(persisted.source).toBe('persisted');expect(persisted.eventId).toBeNull();expect(persisted.changes).toHaveLength(1)
    const signal=await page.evaluate(async()=>{
      const id='d4-expired-cursor'
      const received=new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('missing snapshot-required'))},10000);const off=window.aether.engine.onStreamEvent(event=>{if(event.streamId!==id)return;clearTimeout(timer);off();resolve(event.type)})})
      await window.aether.engine.stream.start({streamId:id,path:'/chat/stream',method:'GET',query:{sessionId:'d4-recovery',lastEventId:'expired:1'},body:undefined});return received
    })
    expect(signal).toBe('snapshot-required');expect(requests).toBe(2)
  })
  test('停止先取消引擎运行，重开保持cancelled且不创建新请求',async()=>{
    await page.evaluate(()=>window.aether.settings.update({lastSessionId:'d4-stop'}));await reload();await send('[d4:stop]')
    await expect(page.locator('.message--assistant')).toContainText('D4_STOP_REASON');expect(stopping).toBeDefined()
    await page.getByRole('button',{name:'停止生成',exact:true}).click()
    await expect.poll(async()=>(await snapshot('d4-stop')).run?.status).toBe('cancelled')
    await expect(page.getByRole('button',{name:'停止生成',exact:true})).toBeHidden()
    const before=requests;await reload();await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已取消');expect(requests).toBe(before)
  })
  test('已打开的 Code 终态会话发现外部下一轮，精确恢复消息和模型且不重发任务',async()=>{
    await page.evaluate(()=>window.aether.settings.update({lastSessionId:'d4-recovery'}));await reload()
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('已完成')
    const before=await snapshot(),beforeRequests=requests
    // A separate transport starts a server-owned run while the already selected
    // Code view has no active stream. No settings change or reload follows it.
    await page.evaluate(({model,workspace})=>{
      void window.aether.engine.stream.start({streamId:'d4-external-'+crypto.randomUUID(),path:'/chat',body:{sessionId:'d4-recovery',message:'[d4:external] second task',model,thinkingMode:false,memoryScope:'off',workspacePaths:[workspace]}}).catch(()=>{})
    },{model,workspace:join(fixture,'workspace')})
    try {
      await expect.poll(async()=>(await snapshot()).run?.runId,{timeout:15000}).not.toBe(before.run?.runId)
      const next=await snapshot();expect(next.run?.status).toBe('running');expect(next.run?.modelId).toBe(model)
      expect(next.run?.userMessageId).toBeTruthy();expect(external).toBeDefined()
      await expect(page.locator(`.message--user[data-message-id="${next.run!.userMessageId}"]`)).toContainText('[d4:external] second task',{timeout:15000})
      await expect(page.locator(`.message--assistant[data-message-id="${next.run!.assistantMessageId}"]`)).toContainText('D4_EXTERNAL_RUNNING')
      await expect(page.locator('.mode-surface[data-mode="code"] .model-picker .select__trigger')).toHaveAttribute('title',`当前模型：${model}`)
      expect(requests).toBe(beforeRequests+1)
      delta(external!,{content:'D4_EXTERNAL_FINAL'});finish(external!,'stop')
      await expect.poll(async()=>(await snapshot()).run?.status).toBe('succeeded')
      await expect(page.locator(`.message--assistant[data-message-id="${next.run!.assistantMessageId}"]`)).toContainText('D4_EXTERNAL_FINAL')
      await expect(page.locator(`.mode-surface[data-mode="code"] .message--assistant[data-message-id="${next.run!.assistantMessageId}"]`).getByRole('status',{name:'运行状态'})).toHaveText('已完成')
      expect((await snapshot()).runs).toHaveLength(before.runs.length+1);expect(requests).toBe(beforeRequests+1)
    } finally {if(external&&!external.writableEnded)finish(external,'stop')}
  })
  test('慢速截断期间不提前读旧快照，重试精确替换旧消息并只发一次新任务',async()=>{
    const before=await snapshot(),target=before.run!,beforeRequests=requests
    const oldUser=page.locator(`.mode-surface[data-mode="code"] .message--user[data-message-id="${target.userMessageId}"]`)
    await expect(oldUser).toContainText('[d4:external] second task')
    await holdMutation('POST','/conversation/truncate')
    try{
      await oldUser.hover();await oldUser.getByRole('button',{name:'重新发送',exact:true}).click()
      await page.getByRole('dialog',{name:'重新发送',exact:true}).getByRole('button',{name:'确定',exact:true}).click()
      await expectMutationReadSilence()
      expect(requests).toBe(beforeRequests)
      await expect(oldUser).toHaveCount(1)
      await releaseMutation()
      await expect.poll(async()=>{
        const run=(await snapshot()).run;return Boolean(run&&run.runId!==target.runId&&run.status==='running')
      }).toBe(true)
      const retried=await snapshot();expect(retried.run?.status).toBe('running')
      expect(retried.run?.userMessageId).not.toBe(target.userMessageId)
      expect(retried.run?.assistantMessageId).not.toBe(target.assistantMessageId)
      expect(retried.history.some(row=>row.id===target.userMessageId||row.id===target.assistantMessageId)).toBe(false)
      await expect(oldUser).toHaveCount(0)
      await expect(page.locator(`.mode-surface[data-mode="code"] .message--assistant[data-message-id="${retried.run!.assistantMessageId}"]`)).toContainText('D4_EXTERNAL_RUNNING')
      expect(requests).toBe(beforeRequests+1)
      delta(external!,{content:'D4_RETRIED_FINAL'});finish(external!,'stop')
      await expect.poll(async()=>(await snapshot()).run?.status).toBe('succeeded')
      await expect(page.locator(`.mode-surface[data-mode="code"] .message--assistant[data-message-id="${retried.run!.assistantMessageId}"]`)).toContainText('D4_RETRIED_FINAL')
      await expect.poll(async()=>(await mutationState()).afterStatus,{timeout:10000}).toBeGreaterThan(0)
      expect(requests).toBe(beforeRequests+1)
      await expect(page.getByRole('dialog',{name:'操作失败',exact:true})).toHaveCount(0)
    }finally{
      await restoreMutationFetch()
      if(external&&!external.writableEnded)finish(external,'stop')
    }
  })
  test('慢速删除期间不读旧快照，删除后精确消息保持消失且恢复后台发现',async()=>{
    const before=await snapshot(),target=before.run!,beforeRequests=requests
    const user=page.locator(`.mode-surface[data-mode="code"] .message--user[data-message-id="${target.userMessageId}"]`)
    const assistant=page.locator(`.mode-surface[data-mode="code"] .message--assistant[data-message-id="${target.assistantMessageId}"]`)
    await expect(assistant).toContainText('D4_RETRIED_FINAL')
    await holdMutation('DELETE',`/conversation/turns/${encodeURIComponent(target.turnId)}`)
    try{
      await user.hover();await user.getByRole('button',{name:'删除本轮',exact:true}).click()
      await page.getByRole('dialog',{name:'删除本轮',exact:true}).getByRole('button',{name:'删除',exact:true}).click()
      await expectMutationReadSilence()
      await expect(user).toHaveCount(1);await expect(assistant).toHaveCount(1)
      await releaseMutation()
      await expect(user).toHaveCount(0);await expect(assistant).toHaveCount(0)
      const deleted=await snapshot()
      expect(deleted.history.some(row=>row.id===target.userMessageId||row.id===target.assistantMessageId||row.conversationId===target.turnId)).toBe(false)
      expect(deleted.runs.some(run=>run.runId===target.runId)).toBe(false)
      await expect.poll(async()=>(await mutationState()).afterStatus,{timeout:10000}).toBeGreaterThan(0)
      await expect(user).toHaveCount(0);await expect(assistant).toHaveCount(0)
      expect(requests).toBe(beforeRequests)
      await expect(page.getByRole('dialog',{name:'操作失败',exact:true})).toHaveCount(0)
      await reload();await expect(user).toHaveCount(0);await expect(assistant).toHaveCount(0)
      expect((await snapshot()).history.some(row=>row.id===target.userMessageId||row.id===target.assistantMessageId)).toBe(false)
      expect(requests).toBe(beforeRequests)
    }finally{await restoreMutationFetch()}
  })
})
