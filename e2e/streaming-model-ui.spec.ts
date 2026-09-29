/** D5 real provider deferrals prove body timing, tool chronology, actual model and safe fallback. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global { interface Window { aether: AetherIdeApi } }
const root=resolve(__dirname,'..'),engineRoot=resolve(root,'..','ai-agent-engine'),primary='d5-primary',fallback='d5-fallback',key='f'.repeat(64)
let fixture='',baseUrl='',app:ElectronApplication|undefined,page:Page
const requests:Array<{scenario:string;model:string}>=[]
const held=new Map<string,ServerResponse>()
function delta(response:ServerResponse,model:string,value:Record<string,unknown>,finish:string|null=null){response.write(`data: ${JSON.stringify({id:'d5',model,choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`)}
function finish(response:ServerResponse,model:string,reason:string,prompt:number,completion:number){
  delta(response,model,{},reason)
  response.write(`data: ${JSON.stringify({id:'d5',model,choices:[],usage:{prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion}})}\n\n`)
  response.end('data: [DONE]\n\n')
}
const provider=createServer((incoming,response)=>{
  void(async()=>{
    let raw='';for await(const chunk of incoming)raw+=chunk.toString()
    const body=JSON.parse(raw) as {model:string;messages:Array<{role:string;content?:unknown}>}
    const index=body.messages.findLastIndex(message=>message.role==='user'),prompt=JSON.stringify(body.messages[index]?.content)
    const scenario=prompt.match(/\[d5:(\w+)\]/)?.[1]??'unknown'
    requests.push({scenario,model:body.model})
    if(scenario==='fallback'&&body.model===primary){response.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'D5_PRIMARY_UNAVAILABLE'}}));return}
    response.writeHead(200,{'Content-Type':'text/event-stream'})
    if(scenario==='tool'&&!body.messages.slice(index+1).some(message=>message.role==='tool')){
      delta(response,body.model,{role:'assistant',content:'D5_BEFORE_TOOL'})
      delta(response,body.model,{tool_calls:[{index:0,id:'read-d5',type:'function',function:{name:'read_file',arguments:'{"path":"fixture.txt"}'}}]})
      finish(response,body.model,'tool_calls',20,5);return
    }
    held.set(scenario,response)
    const content=scenario==='first'?'D5_FIRST':scenario==='tool'?'D5_AFTER_TOOL':scenario==='fallback'?'D5_FALLBACK_PARTIAL':'D5_PARTIAL_FAILURE'
    delta(response,body.model,{role:'assistant',content})
  })().catch(error=>{if(!response.headersSent)response.writeHead(500);response.end(String(error))})
})
function env():NodeJS.ProcessEnv{return {...process.env,AETHER_IDE_ENGINE_ENTRY:join(engineRoot,'dist/main.js'),AUTH_ENABLED:'false',HISTORY_BACKEND:'jsonl',LLM_PROVIDER:'openai',LLM_PRIMARY_MODEL:primary,LLM_MODEL:primary,LLM_FALLBACK_MODEL:fallback,OPENAI_API_KEY:'local-d5-key',OPENAI_BASE_URL:baseUrl,DEFAULT_SECURITY_MODE:'safe',OSM_MODE:'methodology',MAX_ITERATIONS:'5',ENABLE_LONG_TERM_MEMORY:'false',AETHER_GLOBAL_DIR:join(fixture,'global'),WORKSPACE_ROOT:join(fixture,'sandboxes'),MCP_CONFIG_PATH:join(fixture,'mcp.json'),SKILLS_ROOT:join(fixture,'skills')}}
async function launch(){app=await electron.launch({args:['.',`--user-data-dir=${fixture}`],cwd:root,env:env()});page=await app.firstWindow();await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90000})}
async function snapshot(sessionId:string){const response=await page.evaluate(sessionId=>window.aether.engine.request<ChatRecoverySnapshot>({method:'GET',path:'/chat/snapshot',query:{sessionId}}),sessionId);expect(response.ok,response.message).toBe(true);return response.data!}
async function select(sessionId:string){await page.evaluate(sessionId=>window.aether.settings.update({lastSessionId:sessionId}),sessionId);await page.reload();await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable','true')}
async function send(text:string){await page.locator('.chat__input').fill(text);await page.getByRole('button',{name:'发送',exact:true}).click()}
async function completed(sessionId:string){await expect.poll(async()=>(await snapshot(sessionId)).run?.status).toBe('succeeded');await expect(page.getByRole('button',{name:'停止生成',exact:true})).toBeHidden()}
async function chronology(){return page.locator('.message--assistant').evaluate(element=>[...element.children].filter(child=>child.classList.contains('message__content')||child.classList.contains('process')).map(child=>child.classList.contains('process')?'tool':child.textContent))}
test.describe.serial('D5 真流式与模型切换真机验收',()=>{
  test.beforeAll(async()=>{
    await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();if(!address||typeof address==='string')throw new Error('missing provider');baseUrl=`http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root,'.e2e-tmp'),{recursive:true});fixture=mkdtempSync(join(root,'.e2e-tmp','d5-stream-ui-'));mkdirSync(join(fixture,'workspace'),{recursive:true});mkdirSync(join(fixture,'engine','secrets'),{recursive:true})
    writeFileSync(join(fixture,'workspace','fixture.txt'),'D5_TOOL_RESULT')
    writeFileSync(join(fixture,'engine','secrets','engine-secrets.json'),JSON.stringify({encrypted:false,encryptionKey:key}))
    writeFileSync(join(fixture,'settings.json'),JSON.stringify({engineMode:'embedded',preferredPort:12423,autoStartEngine:true,lastSessionId:'d5-first',lastModelId:primary,lastFolder:join(fixture,'workspace'),thinkingMode:'off'}))
    const url=(file:string)=>pathToFileURL(join(engineRoot,'dist',file)).href
    const config=Object.fromEntries(Object.entries(env()).filter(([name])=>['LLM_PRIMARY_MODEL','LLM_MODEL','LLM_PROVIDER','LLM_FALLBACK_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','DEFAULT_SECURITY_MODE','OSM_MODE','MAX_ITERATIONS','HISTORY_BACKEND'].includes(name)))
    const seed=`const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});await initDb();for(const modelId of ${JSON.stringify([primary,fallback])})await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId,apiKey:'local-d5-key',baseUrl:${JSON.stringify(baseUrl)},displayName:modelId,isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');getDb().close();`
    execFileSync(process.execPath,['--input-type=module','-e',seed],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...env(),DATA_DIR:join(fixture,'engine','state','agent.db'),ENCRYPTION_KEY:key}})
    await launch()
  })
  test.afterAll(async()=>{await app?.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));if(!fixture)return;const absolute=resolve(fixture);if(dirname(absolute)!==resolve(root,'.e2e-tmp')||!basename(absolute).startsWith('d5-stream-ui-'))throw new Error('unsafe cleanup');rmSync(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  test('首段正文在provider结束前显示，刷新接续不重复且用量live/history一致',async()=>{
    await send('[d5:first]');await expect(page.locator('.message__content')).toHaveText('D5_FIRST')
    expect(held.get('first')?.writableEnded).toBe(false);expect((await snapshot('d5-first')).run?.status).toBe('running')
    await page.reload();await expect(page.locator('.message__content')).toHaveText('D5_FIRST');expect(requests.filter(item=>item.scenario==='first')).toHaveLength(1)
    delta(held.get('first')!,primary,{content:'_SECOND'});finish(held.get('first')!,primary,'stop',20,4)
    await completed('d5-first');await expect(page.locator('.message__content')).toHaveText('D5_FIRST_SECOND');await expect(page.locator('.turn-usage__value')).toHaveText('24')
    await page.reload();await expect(page.locator('.message__content')).toHaveText('D5_FIRST_SECOND');await expect(page.locator('.turn-usage__value')).toHaveText('24')
  })
  test('工具前正文保持原位且只出现一次，后续正文与调用用量正确累计',async()=>{
    await select('d5-tool');await send('[d5:tool]');await expect(page.locator('.message__content')).toHaveText(['D5_BEFORE_TOOL','D5_AFTER_TOOL'])
    expect(held.get('tool')?.writableEnded).toBe(false);expect(await chronology()).toEqual(['D5_BEFORE_TOOL','tool','D5_AFTER_TOOL'])
    await expect(page.locator('.turn-usage__value')).toHaveText('25')
    finish(held.get('tool')!,primary,'stop',30,4);await completed('d5-tool');await expect(page.locator('.turn-usage__value')).toHaveText('59')
    await app!.close();await launch();await expect(page.locator('.message__content')).toHaveText(['D5_BEFORE_TOOL','D5_AFTER_TOOL']);expect(await chronology()).toEqual(['D5_BEFORE_TOOL','tool','D5_AFTER_TOOL']);await expect(page.locator('.turn-usage__value')).toHaveText('59')
    expect(requests.filter(item=>item.scenario==='tool')).toHaveLength(2)
  })
  test('交付前503允许fallback，实际模型在正文结束前和重启历史中一致',async()=>{
    await select('d5-fallback');await send('[d5:fallback]')
    await expect(page.locator('.message__content')).toHaveText('D5_FALLBACK_PARTIAL',{timeout:45000})
    expect(held.get('fallback')?.writableEnded).toBe(false)
    await expect(page.locator('.turn-usage__model')).toHaveText(fallback)
    expect((await snapshot('d5-fallback')).run?.actualModelId).toBe(fallback)
    const calls=requests.filter(item=>item.scenario==='fallback');expect(calls.some(item=>item.model===primary)).toBe(true);expect(calls.filter(item=>item.model===fallback)).toHaveLength(1)
    finish(held.get('fallback')!,fallback,'stop',11,3);await completed('d5-fallback');await expect(page.locator('.turn-usage__value')).toHaveText('14')
    await app!.close();await launch();await expect(page.locator('.turn-usage__model')).toHaveText(fallback);await expect(page.locator('.turn-usage__value')).toHaveText('14');expect(requests.filter(item=>item.scenario==='fallback')).toHaveLength(calls.length)
  })
  test('已有正文后断开不切备用模型，保留部分输出和实际模型并标失败',async()=>{
    await select('d5-failure');await send('[d5:failure]');await expect(page.locator('.message__content')).toContainText('D5_PARTIAL_FAILURE')
    held.get('failure')!.destroy();await expect.poll(async()=>(await snapshot('d5-failure')).run?.status).toBe('failed')
    await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('失败');await expect(page.locator('.message__content')).toContainText('D5_PARTIAL_FAILURE');await expect(page.locator('.turn-usage__model')).toHaveText(primary)
    expect(requests.filter(item=>item.scenario==='failure')).toEqual([{scenario:'failure',model:primary}])
    const usage=await page.locator('.turn-usage__value').textContent();await app!.close();await launch();await expect(page.locator('.message__content')).toContainText('D5_PARTIAL_FAILURE');await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('失败');await expect(page.locator('.turn-usage__model')).toHaveText(primary);await expect(page.locator('.turn-usage__value')).toHaveText(usage!)
    expect(requests.filter(item=>item.scenario==='failure')).toHaveLength(1)
    expect(((await page.locator('.message__content').textContent())??'').match(/D5_PARTIAL_FAILURE/g)).toHaveLength(1)
  })
})
