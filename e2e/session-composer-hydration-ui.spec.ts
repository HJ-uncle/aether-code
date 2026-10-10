/** Real Electron against a controlled authenticated remote HTTP endpoint.
 * Delays snapshot recovery to prove a fast Enter cannot use another session's default model. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { RootRunRequestConfig } from '../src/shared/root-run'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

declare global { interface Window { aether: AetherIdeApi } }
const root=resolve(__dirname,'..'),token='session-composer-hydration-fixture-token',target='composer-delayed-session'
const requested='qwen-hydration-fixture',other='deepseek-hydration-fixture'
let fixture='',secondaryOrigin='',app:ElectronApplication|undefined,page:Page
const held:ServerResponse[]=[],captured:Record<string,unknown>[]=[],errors:string[]=[]
const run={schemaVersion:1 as const,runId:'hydration-root',sessionId:target,turnId:'hydration-turn',userMessageId:'hydration-user',assistantMessageId:'hydration-assistant',version:1,seq:1,status:'succeeded' as const,modelId:requested,actualModelId:other,createdAt:1,updatedAt:2,finishedAt:2,pending:[]}
const restored:ChatRecoverySnapshot={schemaVersion:1,source:'persisted',sessionId:target,eventId:null,finished:true,projection:[],run,runs:[run],history:[{id:run.userMessageId,role:'user',content:'Delayed model restoration',conversationId:run.turnId},{id:run.assistantMessageId,role:'assistant',content:'Persisted fallback reply',conversationId:run.turnId,modelId:other}],todos:[],changes:[],commandJobs:[]}
let holdSnapshots=true,snapshotModel=requested,disableRequested=false,remainingSnapshotFailures=0,targetSnapshotRequests=0
let snapshotConfig:RootRunRequestConfig|undefined,snapshotRunId=run.runId,fixtureMemoryScope:'off'|'global'|'session'='global'
const snapshotData=():ChatRecoverySnapshot=>({...restored,run:{...run,runId:snapshotRunId,modelId:snapshotModel,requestConfig:snapshotConfig},runs:[{...run,runId:snapshotRunId,modelId:snapshotModel,requestConfig:snapshotConfig}]})
const envelope=(data:unknown)=>JSON.stringify({code:200,message:'ok',data})
const server=createServer((request,response)=>{
 void(async()=>{
  const url=new URL(request.url??'/','http://127.0.0.1'),path=url.pathname
  if(path.startsWith('/api/')&&request.headers['x-aether-instance-token']!==token){response.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({code:401,message:'Invalid fixture token'}));return}
  let raw='';for await(const chunk of request)raw+=chunk.toString()
  if(path==='/api/v1/chat'&&request.method==='POST'){
   captured.push(JSON.parse(raw) as Record<string,unknown>)
   response.writeHead(200,{'content-type':'text/event-stream'})
   response.write('data: '+JSON.stringify({content:'HYDRATED_REQUEST_ACCEPTED'})+'\n\n')
   response.end('data: [DONE]\n\n');return
  }
  response.setHeader('content-type','application/json')
  if(path==='/api/v1/chat/snapshot'){
   const sessionId=url.searchParams.get('sessionId')??''
   if(sessionId===target){
    targetSnapshotRequests++
    if(remainingSnapshotFailures>0){remainingSnapshotFailures--;response.writeHead(503).end(JSON.stringify({code:503,message:'Injected transient snapshot unavailability'}));return}
    if(holdSnapshots)held.push(response);else response.end(envelope(snapshotData()));return
   }
   if(sessionId==='hydration-other-session'){
    const otherRun={...run,sessionId,runId:'other-session-run',turnId:'other-turn',userMessageId:'other-user',assistantMessageId:'other-assistant',modelId:other,requestConfig:{thinkingMode:false,subagentModel:'other-session-sub',utilityModel:'other-session-utility'}};response.end(envelope({schemaVersion:1,source:'persisted',sessionId,eventId:null,finished:true,projection:[],run:otherRun,runs:[otherRun],history:[{id:'other-user',role:'user',content:'OTHER_SESSION_HISTORY',conversationId:'other-turn'}],todos:[],changes:[],commandJobs:[]}));return
   }
   response.end(envelope({schemaVersion:1,source:'persisted',sessionId,eventId:null,finished:true,projection:[],runs:[],history:[],todos:[],changes:[],commandJobs:[]}));return
  }
  if(path==='/api/v1/memory/settings'){if(request.method==='PUT')fixtureMemoryScope=JSON.parse(raw).memoryScope;response.end(envelope({sessionId:url.searchParams.get('sessionId')??target,memoryScope:fixtureMemoryScope,effectiveScope:fixtureMemoryScope,enabled:true}));return}
  const data=path==='/health'?{status:'ok'}
   :path==='/meta'?{version:'2.0.0',buildId:'sha256:'+'c'.repeat(64),protocolVersion:1,toolProfiles:['code'],subagentSchemaVersion:1,instanceId:'composer-hydration-fixture'}
   :path==='/api/v1/models'?[other,requested,'user-chosen-sub','user-chosen-utility'].map((modelId,index)=>({id:'fixture-'+index,modelId,provider:'openai',displayName:modelId,isEnabled:!(disableRequested&&modelId===requested),capabilities:{toolCalling:true,thinking:true}}))
   :path==='/api/v1/chat/runs'?{runs:[]}
   :path==='/api/v1/conversation/sessions'?[{sessionId:target,title:'Delayed model restoration',lastAt:2,messageCount:2},{sessionId:'hydration-other-session',title:'OTHER_SESSION_HISTORY',lastAt:3,messageCount:1}]
   :path==='/api/v1/workspace/directory'?{root:'/remote/hydration',entries:[]}
   :[]
  response.end(envelope(data))
 })().catch(error=>{errors.push(String(error));if(!response.headersSent)response.writeHead(500);response.end(String(error))})
})

const secondaryServer=createServer((request,response)=>{
 const url=new URL(request.url??'/','http://127.0.0.1')
 if(url.pathname==='/api/v1/chat/snapshot'){
  if(request.headers['x-aether-instance-token']!==token){response.writeHead(401).end();return}
  const snapshot=snapshotData(),sourceRun={...snapshot.run!,runId:'source-B-run',requestConfig:{thinkingMode:'low' as const,subagentModel:'source-B-sub',utilityModel:'source-B-utility'}}
  response.setHeader('content-type','application/json');response.end(envelope({...snapshot,run:sourceRun,runs:[sourceRun]}));return
 }
 server.emit('request',request,response)
})

async function selectSession(title:string):Promise<void>{
 if(!await page.locator('.history-view').isVisible())await page.getByRole('button',{name:'会话历史',exact:true}).click()
 await page.locator('.history-view__item').filter({hasText:title}).click()
}

async function chooseAssignedModel(title:string,model:string):Promise<void>{
 if(!await page.locator('.app-settings').isVisible())await page.getByRole('button',{name:'设置',exact:true}).click()
 await page.getByRole('tab',{name:'模型',exact:true}).click()
 await page.getByRole('button',{name:title,exact:true}).click()
 await page.getByRole('menuitem',{name:model,exact:true}).click()
 await expect(page.getByRole('button',{name:title,exact:true})).toContainText(model)
}

test.describe.serial('会话配置延迟恢复的快速发送',()=>{
 test.beforeAll(async()=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing fixture port')
  const origin='http://127.0.0.1:'+address.port
  await new Promise<void>(done=>secondaryServer.listen(0,'127.0.0.1',done));const secondaryAddress=secondaryServer.address();if(!secondaryAddress||typeof secondaryAddress==='string')throw new Error('Missing secondary fixture port');secondaryOrigin='http://127.0.0.1:'+secondaryAddress.port
  mkdirSync(join(root,'.e2e-tmp'),{recursive:true});fixture=mkdtempSync(join(root,'.e2e-tmp','composer-hydration-ui-'))
  writeFileSync(join(fixture,'settings.json'),JSON.stringify({engineMode:'remote',remoteBaseUrl:origin,autoStartEngine:true,lastSessionId:'',lastModelId:other,thinkingMode:'off'}))
  app=await electron.launch({args:['.','--user-data-dir='+fixture],cwd:root,env:{...process.env,AETHER_IDE_REMOTE_INSTANCE_TOKEN:token,AETHER_GLOBAL_DIR:join(fixture,'global')}})
  page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90000})
  const key=sessionStorageKey('aether:lastSessionId',engineStorageKey({mode:'remote',baseUrl:origin}))
  await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key)??'',key)).not.toBe('')
  await page.evaluate(({key,id})=>localStorage.setItem(key,id),{key,id:target});await page.reload()
  await expect.poll(()=>held.filter(response=>!response.destroyed&&!response.writableEnded).length).toBeGreaterThan(0)
 })
 test.afterAll(async()=>{
  for(const response of held)response.destroy()
  await app?.close();server.closeAllConnections();secondaryServer.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await new Promise<void>(done=>secondaryServer.close(()=>done()))
  if(!fixture)return;const absolute=resolve(fixture)
  if(dirname(absolute)!==join(root,'.e2e-tmp')||!basename(absolute).startsWith('composer-hydration-ui-'))throw new Error('Unsafe fixture cleanup')
  rmSync(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100})
 })
 test('权威requested模型到达前禁止快速Enter，恢复后实际HTTP请求使用本会话模型',async()=>{
  await page.locator('.chat__input').fill('QUICK_SEND_GUARD')
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled()
  await expect(page.locator('.model-picker__trigger')).toBeDisabled()
  await page.locator('.chat__input').press('Enter')
  await expect(page.locator('.chat__input')).toHaveText('QUICK_SEND_GUARD')
  expect(captured).toEqual([])
  holdSnapshots=false
  for(const response of held)if(!response.destroyed&&!response.writableEnded)response.end(envelope(snapshotData()))
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  await expect(page.locator('.turn-usage__model')).toHaveText(other)
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(1)
  expect(captured[0]).toMatchObject({sessionId:target,model:requested,message:'QUICK_SEND_GUARD',thinkingMode:false})
  expect(errors).toEqual([])
 })
 test('引擎持续就绪时自动重试失败快照，恢复前不能发送且恢复后使用权威会话模型',async()=>{
  snapshotModel=requested;remainingSnapshotFailures=2
  const beforeRequests=targetSnapshotRequests,beforeChats=captured.length
  await page.reload()
  await expect.poll(()=>targetSnapshotRequests).toBeGreaterThan(beforeRequests)
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await page.locator('.chat__input').fill('RECOVER_TRANSIENT_SNAPSHOT')
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled()
  await page.locator('.chat__input').press('Enter')
  expect(captured.length).toBe(beforeChats)
  await expect.poll(()=>targetSnapshotRequests,{timeout:15000}).toBeGreaterThanOrEqual(beforeRequests+3)
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  await expect(page.locator('.message--user')).toContainText('Delayed model restoration')
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(beforeChats+1)
  expect(captured.at(-1)).toMatchObject({sessionId:target,model:requested,message:'RECOVER_TRANSIENT_SNAPSHOT'})
  expect(errors).toEqual([])
 })
 test('切换会话取消旧会话的快照重试，不能把旧模型或历史覆盖到新会话',async()=>{
  remainingSnapshotFailures=20
  const before=targetSnapshotRequests
  await page.reload()
  await expect.poll(()=>targetSnapshotRequests).toBeGreaterThan(before)
  await selectSession('OTHER_SESSION_HISTORY')
  await expect(page.locator('.message--user')).toContainText('OTHER_SESSION_HISTORY')
  await expect(page.locator('.message--user')).not.toContainText('Delayed model restoration')
  const stopped=targetSnapshotRequests
  // Observe beyond the first retry deadline; this interval tests cancellation, not readiness.
  await new Promise<void>(resolveTimer=>setTimeout(resolveTimer,1600))
  expect(targetSnapshotRequests).toBe(stopped)
  await expect(page.locator('.message--user')).toContainText('OTHER_SESSION_HISTORY')
  remainingSnapshotFailures=0
  await selectSession('Delayed model restoration')
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  expect(errors).toEqual([])
 })
 test('列表缺少旧会话模型时保留原ID，真实发送不静默换为首模型',async()=>{
  snapshotModel='removed-or-environment-only-model';await page.reload()
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+snapshotModel)
  await expect(page.locator('.chat__notice')).toContainText('继续发送将使用会话原模型')
  await page.locator('.chat__input').fill('PRESERVE_UNKNOWN_REQUESTED')
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
  const before=captured.length;await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(before+1)
  expect(captured.at(-1)).toMatchObject({sessionId:target,model:snapshotModel,message:'PRESERVE_UNKNOWN_REQUESTED'})
 })
 test('disabled列表条目保持当前引擎既有调用语义，不新增客户端单方限制',async()=>{
  snapshotModel=requested;disableRequested=true;await page.reload()
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  await page.locator('.chat__input').fill('PRESERVE_DISABLED_SEMANTICS')
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
  const before=captured.length;await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(before+1)
  expect(captured.at(-1)).toMatchObject({sessionId:target,model:requested,message:'PRESERVE_DISABLED_SEMANTICS'})
 })
 test('引擎默认占位及空模型恢复时省略model字段，不猜测为列表或全局模型',async()=>{
  disableRequested=false
  for(const defaultModel of ['当前配置 of AI','']){
   snapshotModel=defaultModel;await page.reload()
   await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','未指定模型，将使用引擎默认配置')
   await expect(page.locator('.model-picker__trigger')).toBeEnabled()
   await page.locator('.chat__input').fill('PRESERVE_ENGINE_DEFAULT')
   const before=captured.length;await page.getByRole('button',{name:'发送',exact:true}).click()
   await expect.poll(()=>captured.length).toBe(before+1)
   expect(captured.at(-1)).toMatchObject({sessionId:target,message:'PRESERVE_ENGINE_DEFAULT'})
   expect(captured.at(-1)).not.toHaveProperty('model')
  }
  expect(errors).toEqual([])
 })
 test('回读外部run的全部安全请求参数，不能用全局默认覆盖medium或资源',async()=>{
  snapshotModel=requested;snapshotRunId='config-run-A';fixtureMemoryScope='session'
  snapshotConfig={agentId:'external-agent',thinkingMode:'medium',subagentModel:'MiniMax-M2.5',utilityModel:'glm-5.3',skills:['restored-skill'],mcpServers:['restored-mcp'],knowledgeBases:['restored-kb'],memoryScope:'session'}
  await page.evaluate(()=>window.aether.settings.update({lastAgentId:'global-agent',subagentModelId:'global-sub',utilityModelId:'global-utility',thinkingMode:'off'}));await page.reload()
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  await expect(page.getByRole('button',{name:'移除技能 restored-skill',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'移除 MCP restored-mcp',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'移除知识库 restored-kb',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'对话偏好',exact:true}).click()
  await expect(page.locator('[title="选择思考档位"]')).toHaveText('Medium⌄')
  await page.keyboard.press('Escape')
  const before=captured.length;await page.locator('.chat__input').fill('EXACT_RESTORED_CONFIG');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(before+1)
  expect(captured.at(-1)).toMatchObject({sessionId:target,model:requested,...snapshotConfig})
  expect(errors).toEqual([])
 })
 test('手选只覆盖本字段，空资源及Auto跨重载保留，外部新run替换旧手选',async()=>{
  await page.getByRole('button',{name:'移除技能 restored-skill',exact:true}).click()
  await page.getByRole('button',{name:'对话偏好',exact:true}).click();await page.locator('[title="选择思考档位"]').click()
  await page.getByRole('menuitem',{name:/^High/}).click();await page.keyboard.press('Escape');await page.reload()
  await expect(page.getByRole('button',{name:'移除技能 restored-skill',exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'移除 MCP restored-mcp',exact:true})).toBeVisible()
  const before=captured.length;await page.locator('.chat__input').fill('LOCAL_EMPTY_AND_AUTO');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(before+1)
  expect(captured.at(-1)).toMatchObject({skills:[],mcpServers:['restored-mcp'],subagentModel:'MiniMax-M2.5',utilityModel:'glm-5.3',memoryScope:'session'})
  expect(captured.at(-1)).not.toHaveProperty('thinkingMode')
  snapshotRunId='config-run-B';snapshotConfig={...snapshotConfig,thinkingMode:true,skills:['external-new-skill']};await page.reload()
  await expect(page.getByRole('button',{name:'移除技能 external-new-skill',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'对话偏好',exact:true}).click();await expect(page.locator('[title="选择思考档位"]')).toHaveText('On⌄');await page.keyboard.press('Escape')
  const next=captured.length;await page.locator('.chat__input').fill('EXTERNAL_NEW_CONFIG');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(next+1);expect(captured.at(-1)).toMatchObject({thinkingMode:true,skills:['external-new-skill']})
 })
 test('权威配置缺省字段保持省略；用户后改记忆设置立即用于下一请求',async()=>{
  snapshotRunId='config-run-C';snapshotConfig={};await page.reload()
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  const before=captured.length;await page.locator('.chat__input').fill('NO_INVENTED_DEFAULTS');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(before+1)
  for(const key of ['agentId','thinkingMode','subagentModel','utilityModel','skills','mcpServers','knowledgeBases'])expect(captured.at(-1)).not.toHaveProperty(key)
  snapshotConfig={memoryScope:'session'};snapshotRunId='config-run-D';await page.reload()
  await page.getByRole('button',{name:'对话偏好',exact:true}).click();await page.locator('[title="选择长期记忆范围"]').click()
  await page.getByRole('menuitem',{name:/^关闭/}).click();await page.keyboard.press('Escape')
  const next=captured.length;await page.locator('.chat__input').fill('CONFIRMED_MEMORY_EDIT');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(next+1);expect(captured.at(-1)).toHaveProperty('memoryScope','off')
  expect(errors).toEqual([])
 })

 test('恢复后显式修改用途模型用于当前请求，换会话或远端不能串用覆盖',async()=>{
  snapshotModel=requested;snapshotRunId='assigned-edit-run';snapshotConfig={thinkingMode:false,subagentModel:'restored-old-sub',utilityModel:'restored-old-utility'};await page.reload()
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  await expect(page.locator('.model-picker__trigger')).toBeEnabled()
  await chooseAssignedModel('子代理使用的模型','user-chosen-sub')
  await chooseAssignedModel('轻任务使用的模型','user-chosen-utility')
  const before=captured.length;await page.locator('.chat__input').fill('EXPLICIT_ASSIGNMENT_EDIT');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(before+1);expect(captured.at(-1)).toMatchObject({subagentModel:'user-chosen-sub',utilityModel:'user-chosen-utility'})
  await selectSession('OTHER_SESSION_HISTORY')
  await expect(page.locator('.message--user')).toContainText('OTHER_SESSION_HISTORY')
  const otherBefore=captured.length;await page.locator('.chat__input').fill('OTHER_SESSION_ASSIGNMENT');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(otherBefore+1);expect(captured.at(-1)).toMatchObject({sessionId:'hydration-other-session',subagentModel:'other-session-sub',utilityModel:'other-session-utility'})
  await page.evaluate(({origin,id,key})=>{localStorage.setItem(key,id);return window.aether.settings.update({remoteBaseUrl:origin})},{origin:secondaryOrigin,id:target,key:sessionStorageKey('aether:lastSessionId',engineStorageKey({mode:'remote',baseUrl:secondaryOrigin}))})
  await page.evaluate(()=>window.aether.engine.restart())
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:30000})
  await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title','当前模型：'+requested)
  const sourceBefore=captured.length;await page.locator('.chat__input').fill('OTHER_SOURCE_ASSIGNMENT');await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(()=>captured.length).toBe(sourceBefore+1);expect(captured.at(-1)).toMatchObject({sessionId:target,thinkingMode:'low',subagentModel:'source-B-sub',utilityModel:'source-B-utility'})
  expect(errors).toEqual([])
 })

})
