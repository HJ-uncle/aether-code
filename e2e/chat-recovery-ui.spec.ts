/** D4 actual local HTTP provider -> engine -> Electron reload/restart with no reexecution. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global { interface Window { aether: AetherIdeApi } }
const root=resolve(__dirname,'..'),engineRoot=resolve(root,'..','ai-agent-engine'),model='d4-local-fixture',key='e'.repeat(64)
let fixture='',baseUrl='',app:ElectronApplication|undefined,page:Page,requests=0
let first:ServerResponse|undefined,afterTools:ServerResponse|undefined,stopping:ServerResponse|undefined
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
    if(prompt.includes('[d4:stop]')){stopping=response;delta(response,{reasoning_content:'D4_STOP_REASON'});return}
    if(toolResults.length){afterTools=response;delta(response,{reasoning_content:'D4_AFTER_TOOLS'});return}
    first=response
    delta(response,{role:'assistant',reasoning_content:'D4_RECOVER_REASON'})
    delta(response,{tool_calls:[{index:0,id:'write-d4',type:'function',function:{name:'write_file',arguments:'{"path":"recovered.txt","data":"D4'}}]})
  })().catch(error=>{if(!response.headersSent)response.writeHead(500);response.end(String(error))})
})
function env():NodeJS.ProcessEnv{return {...process.env,AETHER_IDE_ENGINE_ENTRY:join(engineRoot,'dist/main.js'),AUTH_ENABLED:'false',HISTORY_BACKEND:'jsonl',LLM_PROVIDER:'openai',LLM_PRIMARY_MODEL:model,LLM_MODEL:model,LLM_FALLBACK_MODEL:'',OPENAI_API_KEY:'local-d4-key',OPENAI_BASE_URL:baseUrl,DEFAULT_SECURITY_MODE:'safe',OSM_MODE:'methodology',MAX_ITERATIONS:'5',ENABLE_LONG_TERM_MEMORY:'false',AETHER_GLOBAL_DIR:join(fixture,'global'),WORKSPACE_ROOT:join(fixture,'sandboxes'),MCP_CONFIG_PATH:join(fixture,'mcp.json'),SKILLS_ROOT:join(fixture,'skills')}}
async function launch(){app=await electron.launch({args:['.',`--user-data-dir=${fixture}`],cwd:root,env:env()});page=await app.firstWindow();await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90000})}
async function snapshot(sessionId='d4-recovery'){
  const response=await page.evaluate(sessionId=>window.aether.engine.request<ChatRecoverySnapshot>({method:'GET',path:'/chat/snapshot',query:{sessionId}}),sessionId)
  expect(response.ok,response.message).toBe(true);return response.data!
}
async function send(text:string){await page.locator('.chat__input').fill(text);await page.getByRole('button',{name:'发送',exact:true}).click()}
async function reload(){await page.reload();await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable','true')}
async function expectTodo(){await page.getByRole('button',{name:'任务 0/1',exact:true}).click();await expect(page.locator('.todo-tray')).toContainText('D4_DURABLE_TODO')}
test.describe.serial('D4 快照和消费游标真机验收',()=>{
  test.beforeAll(async()=>{
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
})
