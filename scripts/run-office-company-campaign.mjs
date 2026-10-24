/** Live office campaign controller. Real Work UI admission; read-only observers.
 * An observation failure preserves the desktop and writers for recovery. */
import { _electron as electron, expect } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readConfiguredModel } from './gomoku-model-seed.mjs'
import { createOfficeCompanyPlan } from './office-company-campaign-plan.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = value => createHash('sha256').update(value).digest('hex')
const active = value => ['preparing', 'running', 'waiting', 'cancelling'].includes(value?.run?.status)
const names = { finance: '林澄 · 财务总监', people: '周禾 · 人事总监', sales: '沈言 · 销售与客户成功总监', operations: '唐雨 · 运营采购总监', pmo: '苏晴 · PMO经营管理负责人', compliance: '顾衡 · 合规与文控负责人' }
const expertise = {
  finance: '管理会计、收入确认、资金预测、预算建模、Excel公式与交叉勾稽、管理层财务备忘录',
  people: '组织规划、人员成本、入职流程、岗位责任、培训与权限生命周期、薪资数据分级',
  sales: 'B2B客户经营、机会预测、合同范围变更、回款计划、经营演示与可编辑图表',
  operations: '资源排期、采购比较、服务运营、依赖管理、预算方案、应急回退',
  pmo: '经营分析、跨部门协调、预算取舍、决策证据、版本化治理、行动闭环',
  compliance: '文档控制、数据分级、隐私脱敏、版本审计、证据核验、问题闭环'
}

async function main(){
  let c
  try{c=await launchOfficeCampaign()}catch(error){c=globalThis.__officeCampaign;if(!c)throw error;console.error('Office setup requires recovery:',error.message)}
  console.log(JSON.stringify({root:c.state.runRoot,phase:c.state.phase,modelId:c.state.modelId}))
  const controls=join(c.state.runRoot,'commands.json')
  writeFileSync(controls,JSON.stringify({commands:[]},null,2),{flag:'wx'})
  c.state.commands=[];c.save()
  for(;;){
    if(c.page.isClosed())break
    let incoming=[]
    try{incoming=JSON.parse(readFileSync(controls,'utf8')).commands||[]}catch(error){c.log('command-read-error',{message:error.message})}
    for(const command of incoming){
      if(c.state.commands.some(x=>x.id===command.id))continue
      const record={id:command.id,action:command.action,status:'started',at:new Date().toISOString()};c.state.commands.push(record);c.save()
      try{
        if(command.action==='start-role')record.result=await c.createAndStart(command.role)
        else if(command.action==='submit-stage')record.result=await c.submit(command.role,c.plan.roles.find(r=>r.id===command.role).stages[command.stage])
        else if(command.action==='message')record.result=await c.submit(command.role,{id:command.id,kind:'repair',revision:command.revision||'review',prompt:command.text})
        else if(command.action==='publish-revision'){
          for(const [file,content]of Object.entries(c.plan.seedFiles.revision))writeFileSync(join(c.state.companyRoot,'inputs',file),content,{flag:'wx'})
          record.result='Revision inputs published'
        }else if(command.action==='snapshot'){
          for(const [id,role]of Object.entries(c.state.roles))if(role.sessionId)c.artifact(command.id+'-'+id+'-snapshot.json',await c.request('GET','/chat/snapshot',undefined,{sessionId:role.sessionId}))
          record.result='Snapshots saved'
        }else if(command.action==='ui'){
          if(command.role)await c.selectTask(command.role)
          await c.page.screenshot({path:join(c.state.evidenceRoot,command.id+'.png')})
          c.artifact(command.id+'-ui.json',{text:await c.page.locator('body').innerText(),tasks:await c.workTasks()})
          record.result='UI captured'
        }else throw new Error('Unsupported office command '+command.action)
        record.status='completed'
      }catch(error){record.status='failed';record.error=error.message;c.artifact(command.id+'-failure-ui.json',{text:await c.page.locator('body').innerText().catch(()=>''),tasks:await c.workTasks().catch(()=>[])});await c.page.screenshot({path:join(c.state.evidenceRoot,command.id+'-failure.png')}).catch(()=>{})}
      c.log('command-result',record);console.log(JSON.stringify(record))
    }
    await delay(2000)
  }
  c.stopMonitoring()
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1})

export async function launchOfficeCampaign() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const root = join(repository, '.ae', 'office-company-' + stamp)
  if (existsSync(root)) throw new Error('Office root already exists')
  const profile = join(root, 'profile'), evidenceRoot = join(root, 'evidence'), companyRoot = join(root, 'company')
  const roleWorkspaces = Object.fromEntries(Object.keys(names).map(id => [id, join(companyRoot, id)]))
  const plan = createOfficeCompanyPlan({roleWorkspaces, inputRoot: join(companyRoot, 'inputs'), publishRoot: join(companyRoot, 'published')})
  for (const path of [profile, evidenceRoot, companyRoot, join(companyRoot, 'inputs'), join(companyRoot, 'published'), ...Object.values(roleWorkspaces)]) mkdirSync(path, {recursive: true})
  for (const [file, content] of Object.entries(plan.seedFiles.baseline)) writeFileSync(join(companyRoot, 'inputs', file), content, {flag: 'wx'})
  // Only the provider model ID changes. The original DB connection is read-only.
  const original = readConfiguredModel()
  const model = {...original, modelId: 'deepseek-v4.1-flash-1017'}
  const scrub = value => String(value).split(model.apiKey).join('[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  const json = value => scrub(JSON.stringify(value, (_, v) => typeof v === 'string' ? v.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]') : v, 2))
  const state = {schemaVersion: 1, startedAt: new Date().toISOString(), runRoot: root, profile, evidenceRoot, companyRoot,
    modelId: model.modelId, sourceModelId: original.modelId, modelChange: 'modelId only; source database read-only', phase: 'setup',
    roles: Object.fromEntries(plan.roles.map(role => [role.id, {name: names[role.id], workspace: role.workspace, submissions: [], sessionId: null, agentId: null}])),
    rendererErrors: [], processErrors: [], issues: [], observations: 0, sampledSixRunningMs: 0, peakRunning: 0,
    isolation: 'Shared company workspace; per-role write ownership is prompted and audited, not OS sandbox isolation'}
  const save = () => {writeFileSync(join(root, 'state.json.tmp'), json(state)); renameSync(join(root, 'state.json.tmp'), join(root, 'state.json'))}
  const artifact = (name, value) => {const path = join(evidenceRoot, name); writeFileSync(path, json(value)); return path}
  const log = (event, details = {}) => {appendFileSync(join(evidenceRoot, 'events.jsonl'), json({at: new Date().toISOString(), event, ...details}).replace(/\n/g, '') + '\n'); save()}
  artifact('plan-private-oracle.json', plan)
  artifact('baseline-input-hashes.json', Object.fromEntries(Object.entries(plan.seedFiles.baseline).map(([file, content]) => [file, hash(content)])))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({engineMode:'embedded',autoStartEngine:true,preferredPort:12463,lastFolder:companyRoot,lastSessionId:'office-code-unused-'+randomUUID(),lastModelId:model.modelId,appearance:'light',thinkingMode:'off'}))
  const env = {...process.env, AETHER_GLOBAL_DIR:join(profile,'global'),AETHER_IDE_ENGINE_ENTRY:resolve(repository,'..','ai-agent-engine','dist','main.js'),WORKSPACE_ROOT:join(root,'scratch'),AUTH_ENABLED:'false',DEFAULT_SECURITY_MODE:'standard',OSM_MODE:'balanced',ENABLE_LONG_TERM_MEMORY:'true',AETHER_IDE_ECHO_ENGINE:'1',SKILLS_ROOT:join(profile,'skills'),MCP_CONFIG_PATH:join(profile,'mcp.json')}
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  save()
  const app = await electron.launch({args:['.','--user-data-dir='+profile],cwd:repository,env,timeout:90000})
  const capture = chunk => appendFileSync(join(evidenceRoot,'desktop.log'),scrub(chunk.toString()))
  app.process().stdout?.on('data',capture); app.process().stderr?.on('data',capture)
  app.process().on('exit',(code,signal)=>{state.phase='desktop-exited';state.processErrors.push({at:Date.now(),code,signal});save()})
  const page = await app.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror',error=>{state.rendererErrors.push({at:Date.now(),message:scrub(error.message)});save()})
  await app.evaluate(({BrowserWindow,dialog},path)=>{BrowserWindow.getAllWindows()[0]?.setSize(1600,1050);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},companyRoot)
  const request = async (method,path,body,query) => {
    const r = await page.evaluate(input=>window.aether.engine.request(input),{method,path,body,query,expectedEngine:state.engine,toolProfile:'general'})
    if(!r.ok) throw new Error(scrub(`${method} ${path}: ${r.code} ${r.message}`))
    return r.data
  }
  const workTasks = () => page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('aether.work.state.v1')).map(([,v])=>JSON.parse(v)).flatMap(v=>v.tasks.map(t=>({...t,active:v.activeTaskId===t.id}))))
  const status = id => request('GET','/chat/status',undefined,{sessionId:state.roles[id].sessionId})
  const selectWork = async()=>{await page.getByRole('tab',{name:'Work 办公',exact:true}).click();await expect(page.locator('#mode-work')).toHaveAttribute('aria-hidden','false')}
  const selectTask = async id => {
    await selectWork()
    const task = (await workTasks()).find(t=>t.id===state.roles[id].sessionId)
    if(!task) throw new Error('Missing real Work task '+id)
    const row=page.locator('#mode-work .work-sidebar__task').filter({hasText:task.title}).first()
    await row.click(); await expect.poll(async()=>(await workTasks()).find(t=>t.active)?.id).toBe(task.id)
  }
  const submit = async (id,stage) => {
    const owner=state.roles[id]
    if(owner.submissions.some(s=>s.id===stage.id)) throw new Error('Duplicate admission requires explicit reconciliation: '+stage.id)
    if(owner.sessionId) await selectTask(id)
    const prompt=stage.prompt+'\n核验定位要求：manifest claims 使用 {id,value,unit,period,basis,status,evidence:[{path,sha256,kind,sheet,cell}]}；按实际产物填写，不编造渲染或计算通过。先使用可用的内置办公skill，缺能力时尝试本会话真实可用工具并如实记录。'
    const beforeRunId=owner.sessionId?(await status(id)).run?.runId:null
    const record={id:stage.id,kind:stage.kind,revision:stage.revision,promptSha256:hash(prompt),beforeRunId,phase:'prepared',at:new Date().toISOString()}
    owner.submissions.push(record);artifact(stage.id+'-prompt.json',{text:prompt});save()
    const surface=page.locator('#mode-work'),composer=surface.locator('.input-composer__input[role="textbox"]').filter({visible:true}).first()
    await expect(composer).toBeEditable();await composer.fill(prompt)
    const send=surface.getByRole('button',{name:/^(开始任务|排到下一轮|发送)$/,exact:true}).filter({visible:true}).last()
    await expect(send).toBeEnabled();record.phase='dispatching';save();await send.click()
    await expect(composer).toHaveText('')
    if(!owner.sessionId){await expect.poll(async()=>(await workTasks()).find(t=>t.active)?.agentId).toBe(owner.agentId);owner.sessionId=(await workTasks()).find(t=>t.active).id}
    record.phase='dispatched';save()
    await expect.poll(async()=>{const run=(await status(id)).run;return Boolean(run?.runId&&run.runId!==beforeRunId)},{timeout:90000}).toBe(true)
    const value=await status(id);record.initialObservedRun=value.run;record.runId=value.run?.runId
    const task=(await workTasks()).find(t=>t.id===owner.sessionId)
    if(task.agentId!==owner.agentId||resolve(task.workspacePath)!==resolve(companyRoot)||task.modelId!==model.modelId) throw new Error('Work UI binding differs from expected '+id)
    artifact(stage.id+'-binding.json',{task,run:value.run});record.phase='admitted';log('submitted',{id,stageId:stage.id,sessionId:owner.sessionId,runId:record.runId})
    return {id,sessionId:owner.sessionId,runId:record.runId}
  }
  let busy=false,lastTick=0,lastMetric=0,previous={},timer=null
  const observe=async()=>{
    if(busy||page.isClosed())return
    busy=true
    try{
      const ids=Object.keys(state.roles).filter(id=>state.roles[id].sessionId),at=Date.now()
      const results=await Promise.allSettled(ids.map(async id=>({id,value:await status(id)})))
      const rows=[]
      for(let i=0;i<results.length;i++){
        const result=results[i]
        if(result.status==='rejected'){state.issues.push({at,kind:'observation-error',role:ids[i],message:scrub(result.reason?.message)});continue}
        const {id,value}=result.value,owner=state.roles[id];rows.push({id,run:value.run,running:value.running,finished:value.finished})
        if(previous[id]?.runId!==value.run?.runId||previous[id]?.status!==value.run?.status)log('run-transition',{id,run:value.run})
        owner.lastStatus=value
        const record=owner.submissions.find(s=>s.runId===value.run?.runId)
        if(record&&!active(value)&&value.run){record.terminalOutcome=value.run.status;record.terminalAt=value.run.completedAt||new Date().toISOString()}
      }
      const count=rows.filter(r=>r.run?.status==='running').length
      state.peakRunning=Math.max(state.peakRunning,count)
      if(count===6&&rows.every(r=>previous[r.id]?.status==='running'&&previous[r.id]?.runId===r.run.runId)&&at-lastTick<=30000)state.sampledSixRunningMs+=at-lastTick
      previous=Object.fromEntries(rows.map(r=>[r.id,r.run]));lastTick=at;state.observations++
      appendFileSync(join(evidenceRoot,'status.jsonl'),JSON.stringify({at,rows})+'\n')
      const runtime=await request('GET','/performance/runtime');appendFileSync(join(evidenceRoot,'runtime.jsonl'),json({at,runtime}).replace(/\n/g,'')+'\n')
      if(at-lastMetric>=30000){lastMetric=at;const diagnostics=await page.evaluate(()=>window.aether.engine.diagnostics({refreshStorage:false}));appendFileSync(join(evidenceRoot,'metrics.jsonl'),json({at,diagnostics}).replace(/\n/g,'')+'\n')}
      state.issues=state.issues.slice(-200);save()
    }catch(error){log('observer-failure',{message:scrub(error.message)})}finally{busy=false}
  }
  const controller={app,page,state,plan,request,artifact,log,save,submit,status,workTasks,selectTask,observe,
    startMonitoring(){if(!timer)timer=setInterval(()=>void observe(),10000)},stopMonitoring(){clearInterval(timer);timer=null},
    async createAndStart(id){
      const owner=state.roles[id],role=plan.roles.find(r=>r.id===id)
      if(owner.sessionId||owner.submissions.length)throw new Error('Existing role needs reconciliation '+id)
      await selectWork();await page.locator('#mode-work').getByRole('button',{name:'新任务',exact:true}).click()
      await page.locator('#mode-work .work-navigation').getByRole('button',{name:'Agent',exact:true}).click()
      await page.getByRole('button',{name:'使用 Agent '+owner.name,exact:true}).click()
      await page.locator('#mode-work .work-folder-button').click()
      const trigger=page.locator('#mode-work').getByRole('button',{name:'Work 使用的模型',exact:true});await expect(trigger).toBeEnabled();await trigger.click()
      await page.getByRole('menuitem').filter({hasText:model.displayName||model.modelId}).first().click()
      const security=page.locator('#mode-work').getByRole('button',{name:/^切换本会话访问权限：/});await expect(security).toBeEnabled()
      if(!(await security.innerText()).includes('完全访问')){await security.click();await page.getByRole('menuitem',{name:/^完全访问/}).click()}
      await expect(security).toContainText('完全访问')
      return submit(id,role.stages[0])
    }}
  // Expose a recoverable controller even if setup validation fails after launch.
  globalThis.__officeCampaign=controller
  try{
    await expect.poll(()=>page.evaluate(()=>window.aether.engine.getSnapshot()).then(v=>v.phase),{timeout:90000}).toBe('ready')
    const account=await page.evaluate(()=>window.aether.account.register());expect(account.status).toBe('authenticated')
    await expect.poll(()=>page.evaluate(()=>window.aether.engine.getSnapshot()).then(v=>v.accountId)).toBe(account.user.id)
    const created=await request('POST','/models',model);await request('PUT','/models/'+created.id,{isEnabled:true})
    const preflight=await request('POST','/models/'+created.id+'/test',{});artifact('model-preflight.json',{modelId:model.modelId,success:preflight.success});expect(preflight.success).toBe(true)
    const snap=await page.evaluate(()=>window.aether.engine.getSnapshot());state.engine={mode:snap.mode,baseUrl:snap.baseUrl,instanceId:snap.instanceId,accountId:snap.accountId}
    artifact('engine-identity.json',snap)
    artifact('memory-preferences.json',await request('GET','/memory/preferences'))
    // Skill administration may require a different role than normal Work use.
    try{artifact('skill-catalog.json',await request('GET','/skills'))}catch(error){log('skill-catalog-unavailable',{message:scrub(error.message)})}
    const toolCatalog=await request('GET','/tools',undefined,{pageSize:1000,path:companyRoot})
    const allowedTools=(Array.isArray(toolCatalog)?toolCatalog:toolCatalog.list||[]).map(t=>t.name)
    for(const required of ['read_file','write_file','office_document','get_skill'])if(!allowedTools.includes(required))throw new Error('Required Work tool missing: '+required)
    for(const role of plan.roles){
      const agent=await request('POST','/agents',{name:names[role.id],description:role.goal,model:model.modelId,skills:['aether-office'],allowedTools,systemPrompt:`你是${names[role.id]}，青禾智研（完全虚构公司）的专业负责人。专业能力：${expertise[role.id]}。独立执行自己的工作，同时按版本化本地协议协调。使用真实工具创建并检查办公原格式文件；不得用纯文本冒充办公文件。只写${role.workspace}和${role.publishPrefix}，公共输入与其他角色文件只读。不发真实消息、不付款或签署。产出清晰、审计可追溯，失败与缺口如实记录。`})
      state.roles[role.id].agentId=agent.id;artifact('agent-'+role.id+'.json',agent);save()
    }
    await page.reload();await expect.poll(()=>page.evaluate(()=>window.aether.engine.getSnapshot()).then(v=>v.phase),{timeout:90000}).toBe('ready')
    await selectWork();state.phase='ready-for-baselines';log('office-ready',{root,modelId:model.modelId,agents:6});controller.startMonitoring()
    return controller
  }catch(error){state.phase='setup-needs-recovery';log('setup-error',{message:scrub(error.message)});throw error}
}
