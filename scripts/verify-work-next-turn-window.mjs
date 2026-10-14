import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
// Run after building this source tree. A second argument can select a frozen private source/output tree.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), source=process.argv[2]?path.resolve(process.argv[2]):repo
fs.mkdirSync(path.join(repo,'.e2e-tmp'),{recursive:true})
const qa=fs.mkdtempSync(path.join(repo,'.e2e-tmp/work-next-turn-window-')),tests=path.join(qa,'tests'),profile=path.join(qa,'profile')
fs.mkdirSync(path.join(tests,'e2e/helpers'),{recursive:true});fs.mkdirSync(profile,{recursive:true})
fs.symlinkSync(path.join(repo,'node_modules'),path.join(tests,'node_modules'),'junction');fs.symlinkSync(path.join(source,'src'),path.join(tests,'src'),'junction')
fs.copyFileSync(path.join(source,'e2e/helpers/electron-health.ts'),path.join(tests,'e2e/helpers/electron-health.ts'))
fs.copyFileSync(path.join(repo,'e2e/probes/'+(process.argv[3]==='negative'?'work-next-turn-invalid-retry.case.ts':'work-next-turn-window.case.ts')),path.join(tests,'e2e/work-queue-live.spec.ts'))
const fingerprint=directory=>{const files=[];const walk=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(item.isFile())files.push([path.relative(directory,file).replaceAll('\\','/'),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])}};walk(directory);return {count:files.length,digest:crypto.createHash('sha256').update(JSON.stringify(files.sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex')}}
const before=fingerprint(path.join(source,'out')),sourceBefore=fingerprint(path.join(source,'src')), token='owned-next-turn-fixture-token',model='owned-no-provider-model'
const roots=new Map(),receipts=new Map(),posts=[],requests=[],streams=new Set(),deny=new Set(),namespaces=new Map(),holdNext=new Set(),holdSkip=new Map(),held=new Map()
const rootFor=sessionId=>{let root=roots.get(sessionId);if(!root){root={schemaVersion:1,runId:'initial-'+sessionId,attemptId:'attempt-'+sessionId,sessionId,turnId:'turn-'+sessionId,userMessageId:'user-'+sessionId,assistantMessageId:'assistant-'+sessionId,version:1,seq:1,status:'running',workspacePaths:[],modelId:model,createdAt:Date.now()-1000,updatedAt:Date.now(),pending:[],requestConfig:{thinkingMode:false,memoryScope:'off'}};roots.set(sessionId,root)}return root}
const namespaceFor=sessionId=>({id:'owned-db',generation:namespaces.get(sessionId)??'one'})
const send=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({code:status===200?200:status*100,message:status===200?'OK':'Owned fixture rejected',data}))}
const readBody=async req=>{let chunks=[];for await(const c of req)chunks.push(c);return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{}}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost'),route=url.pathname,body=req.method==='POST'?await readBody(req):{},sessionId=url.searchParams.get('sessionId')??body.sessionId??''
 requests.push({method:req.method,path:route,sessionId,profile:req.headers['x-aether-tool-profile'],lifetime:req.headers['x-aether-run-lifetime'],protocol:req.headers['x-aether-subagent-protocol']})
 if((route.startsWith('/api/')||route.startsWith('/qa/'))&&req.headers['x-aether-instance-token']!==token)return send(res,null,401)
 if(route==='/health')return send(res,{status:'ok'})
 if(route==='/meta')return send(res,{version:'2.0.0',buildId:'sha256:'+'f'.repeat(64),protocolVersion:1,toolProfiles:['code','general'],subagentSchemaVersion:1,instanceId:path.basename(qa)})
 if(route==='/qa/audit')return send(res,{posts,requests,roots:[...roots],receipts:[...receipts],held:[...held.keys()]})
 if(route==='/qa/control'){if(body.status)Object.assign(rootFor(body.taskId),{status:body.status,version:rootFor(body.taskId).version+1});if(body.deny===true)deny.add(body.taskId);if(body.deny===false)deny.delete(body.taskId);if(body.namespace)namespaces.set(body.taskId,body.namespace);if(body.workspacePaths)rootFor(body.taskId).workspacePaths=body.workspacePaths;if(body.holdNext){holdNext.add(body.taskId);holdSkip.set(body.taskId,body.skip??0)}if(body.release){held.get(body.taskId)?.();held.delete(body.taskId)}return send(res,{ok:true})}
 if(route==='/api/v1/subagent/capabilities')return send(res,null,404)
 if(route==='/api/v1/models')return send(res,[{id:model,modelId:model,provider:'openai',displayName:'Owned no-provider fixture',isEnabled:true,capabilities:{toolCalling:true,contextWindow:200000}}])
 if(route==='/api/v1/chat/admission/context'){if(holdNext.has(sessionId)){if(holdSkip.get(sessionId)>0)holdSkip.set(sessionId,holdSkip.get(sessionId)-1);else {holdNext.delete(sessionId);await new Promise(resolve=>held.set(sessionId,resolve))}}const root=rootFor(sessionId);return send(res,{protocolVersion:1,tenantId:'owned-tenant',sessionId,namespace:namespaceFor(sessionId),transport:{toolProfile:'general',runLifetime:'durable',subagentProtocol:2},root,predecessor:{runId:root.runId,attemptId:root.attemptId,version:root.version}})}
 if(route==='/api/v1/chat/admission/receipt')return send(res,deny.has(sessionId)?{protocolVersion:1,status:'absent',namespace:body.namespace,sessionId,requestKey:body.requestKey}:receipts.get(body.requestKey)??{protocolVersion:1,status:'absent',namespace:body.namespace,sessionId,requestKey:body.requestKey})
 if(route==='/api/v1/chat'&&req.method==='POST'){
  if(!body.admission)return send(res,{error:'No regular chat/model dispatch permitted'},500)
  posts.push({taskId:sessionId,body,wire:JSON.stringify(body)});const n=posts.length,run={...rootFor(sessionId),runId:'accepted-'+sessionId+'-'+n,attemptId:'accepted-attempt-'+n,version:1,status:'running',turnId:'accepted-turn-'+n,userMessageId:'accepted-user-'+n,assistantMessageId:'accepted-anchor-'+n};roots.set(sessionId,run)
  receipts.set(body.admission.requestKey,{protocolVersion:1,status:'accepted',receipt:{...body.admission,sessionId,rootRunId:run.runId,turnId:run.turnId,userMessageId:run.userMessageId,assistantMessageId:run.assistantMessageId},run,projection:{rootVersion:1,rootAttemptId:run.attemptId,user:{messageId:run.userMessageId,state:'projected'},assistant:{anchorMessageId:run.assistantMessageId,state:'unwritten'}}})
  res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end(': owned admission only\n\n')
 }
 if(route==='/api/v1/chat/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': owned stream\n\n');streams.add(res);const timer=setInterval(()=>res.write(': keepalive\n\n'),10000);res.on('close',()=>{clearInterval(timer);streams.delete(res)});return}
 if(route==='/api/v1/chat/snapshot'){const root=rootFor(sessionId);return send(res,{schemaVersion:1,sessionId,source:root.status==='running'?'live':'persisted',eventId:root.runId+':1',finished:root.status!=='running',projection:[],history:[],run:root,runs:[root],todos:[],changes:[],commandJobs:[]})}
 if(route==='/api/v1/chat/status'){const run=rootFor(sessionId);return send(res,{running:run.status==='running',run})}
 if(route==='/api/v1/chat/runs')return send(res,{runs:[rootFor(sessionId)]})
 if(route==='/api/v1/security/mode')return send(res,{mode:'safe',sessionId})
 if(route==='/api/v1/memory/settings')return send(res,{memoryScope:'off',effectiveScope:'off',enabled:false,sessionId})
 if(route==='/api/v1/workspace/directory')return send(res,{root:'',entries:[]})
 return send(res,[])
}catch(error){console.error('FIXTURE',error);send(res,{error:String(error)},500)}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port
fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({engineMode:'remote',remoteBaseUrl:base,autoStartEngine:true,lastSessionId:'',lastModelId:model,thinkingMode:'off',appearance:'dark',graphicsMode:'software',lastFolder:''}))
fs.writeFileSync(path.join(tests,'playwright.config.ts'),`import {defineConfig} from '@playwright/test'\nexport default defineConfig({testDir:'./e2e',testMatch:'work-queue-live.spec.ts',workers:1,fullyParallel:false,retries:0,timeout:240000,expect:{timeout:20000},reporter:[['list'],['json',{outputFile:${JSON.stringify(path.join(qa,'report.json'))}}]],outputDir:${JSON.stringify(path.join(qa,'artifacts'))},use:{trace:'retain-on-failure'}})\n`)
fs.writeFileSync(path.join(tests,'tsconfig.live.json'),JSON.stringify({extends:path.join(source,'tsconfig.web.json'),include:['e2e/**/*.ts',path.join(source,'src/preload/index.d.ts')],compilerOptions:{strict:true,noEmit:true,composite:false,noUnusedLocals:false,noUnusedParameters:false,types:['node','electron-vite/node']}},null,2))
const env={...process.env,AETHER_E2E_APP_ENTRY:path.join(source,'out/main/index.js'),AETHER_QA_QUEUE_ORIGIN:base,AETHER_QA_QUEUE_TOKEN:token,AETHER_QA_QUEUE_PROFILE:profile,AETHER_QA_QUEUE_ROOT:qa,AETHER_QA_QUEUE_MODEL:model}
for(const key of Object.keys(env))if(['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AETHER_IDE_REMOTE_AUTH_URL','AETHER_IDE_REMOTE_API_KEY','AETHER_IDE_REMOTE_BEARER_TOKEN','AETHER_NEXT_TURN_BACKEND'].includes(key.toUpperCase()))delete env[key]
const stdout=fs.createWriteStream(path.join(qa,'stdout.log')),stderr=fs.createWriteStream(path.join(qa,'stderr.log'));let exit,typecheckExit
async function run(args){const child=spawn(process.execPath,args,{cwd:tests,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(stdout,{end:false});child.stderr.pipe(stderr,{end:false});return new Promise(resolve=>{child.once('error',error=>resolve({error:error.message}));child.once('close',(code,signal)=>resolve({code,signal}))})}
try {typecheckExit=await run([path.join(repo,'node_modules/typescript/bin/tsc'),'--noEmit','-p',path.join(tests,'tsconfig.live.json')]);exit=typecheckExit.code===0?await run([path.join(repo,'node_modules/@playwright/test/cli.js'),'test','--workers=1']):typecheckExit}
finally {for(const release of held.values())release();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));await Promise.all([new Promise(resolve=>stdout.end(resolve)),new Promise(resolve=>stderr.end(resolve))])}
const after=fingerprint(path.join(source,'out')),sourceAfter=fingerprint(path.join(source,'src')),stable=JSON.stringify(before)===JSON.stringify(after)&&JSON.stringify(sourceBefore)===JSON.stringify(sourceAfter),receipt={at:new Date().toISOString(),qa,source,exit,typecheckExit,stable,before,after,sourceBefore,sourceAfter,models:0,posts,requests,passed:exit?.code===0&&!exit.signal&&!exit.error&&typecheckExit?.code===0&&stable,scope:'Actual unmodified private production Electron BrowserWindow/preload/ipcMain/owner/gateway/JSON store and Work React components; authenticated loopback admission/discovery/stream fixture. No real model or engine admission implementation, no soak, no actual account login switch.'}
fs.writeFileSync(path.join(qa,'result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({qa,passed:receipt.passed,exit,stable,posts:posts.length}));if(!receipt.passed)process.exitCode=1
