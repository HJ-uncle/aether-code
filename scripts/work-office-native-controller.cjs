const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { _electron: electron, expect } = require('@playwright/test')

// A new workload is dispatched through Work controls; API reads only collect
// execution evidence. No external office application is part of this campaign.
exports.launch = async function (options = {}) {
  const repo = path.resolve(__dirname, '..')
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0,14)
  const root = options.resume?.root || path.join(repo, '.ae', 'work-office-native-' + stamp)
  const companyRoot = path.join(root, 'company')
  const profile = options.resume?.profile || path.join(repo, '.e2e-tmp', 'work-office-native-profile-' + stamp)
  const evidence = path.join(root, 'evidence')
  for (const dir of [companyRoot, profile, evidence]) fs.mkdirSync(dir, { recursive: true })
  const { readConfiguredModel } = await import(pathToFileURL(path.join(repo, 'scripts/gomoku-model-seed.mjs')))
  const model = { ...readConfiguredModel(), modelId: 'deepseek-v4.1-flash-1017' }
  const scrub = value => String(value).split(model.apiKey).join('[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  const safe = value => scrub(JSON.stringify(value, null, 2))
  const state = options.resume || { root, companyRoot, profile, evidence, startedAt: new Date().toISOString(), modelId: model.modelId,
    phase: 'setup', roles: {}, issues: [], pageErrors: [], observations: 0, peakRunning: 0, sixRunningSampleMs: 0 }
  const save = () => { fs.writeFileSync(path.join(root,'state.json.tmp'),safe(state));fs.renameSync(path.join(root,'state.json.tmp'),path.join(root,'state.json')) }
  const artifact = (name, data) => fs.writeFileSync(path.join(evidence,name),safe(data))
  const log = (type,data={}) => fs.appendFileSync(path.join(evidence,'events.jsonl'),scrub(JSON.stringify({at:new Date().toISOString(),type,...data}))+'\n')
  if (!options.resume) fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({engineMode:'embedded',autoStartEngine:true,preferredPort:12323,lastFolder:companyRoot,lastModelId:model.modelId,appearance:'light',thinkingMode:'off'}))
  const env = {...process.env, AETHER_GLOBAL_DIR:path.join(profile,'global'),AETHER_IDE_ENGINE_ENTRY:path.resolve(repo,'../ai-agent-engine/dist/main.js'),WORKSPACE_ROOT:companyRoot,AUTH_ENABLED:'false',DEFAULT_SECURITY_MODE:'standard',AETHER_IDE_ECHO_ENGINE:'1',SKILLS_ROOT:path.join(profile,'skills'),MCP_CONFIG_PATH:path.join(profile,'mcp.json')}
  if (options.engineEntry) env.AETHER_IDE_ENGINE_ENTRY = options.engineEntry
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({args:[options.mainEntry || '.','--user-data-dir='+profile,'--remote-debugging-port=9331'],cwd:repo,env,timeout:90000})
  options.onApp?.(app)
  const capture = chunk => fs.appendFileSync(path.join(evidence,'desktop.log'),scrub(chunk.toString()))
  app.process().stdout?.on('data',capture); app.process().stderr?.on('data',capture)
  const page=await app.firstWindow(); page.setDefaultTimeout(15000)
  await page.addInitScript(() => {
    const samples = { count: 0, totalMs: 0, maxMs: 0, recent: [] }
    globalThis.__officeUiPerf = samples
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        samples.count++; samples.totalMs += entry.duration; samples.maxMs = Math.max(samples.maxMs, entry.duration)
        samples.recent.push({ at: entry.startTime, duration: entry.duration })
      }
      if (samples.recent.length > 100) samples.recent.splice(0, samples.recent.length - 100)
    }).observe({ type: 'longtask', buffered: true })
  })
  page.on('pageerror',error=>{state.pageErrors.push(scrub(error.message));save()})
  app.process().on('exit',(code,signal)=>{state.phase='desktop-exited';log('desktop-exited',{code,signal});save()})
  await app.evaluate(({BrowserWindow,dialog},folder)=>{BrowserWindow.getAllWindows()[0].setSize(1550,1000);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},companyRoot)
  await expect.poll(()=>page.evaluate(()=>window.aether.engine.getSnapshot()).then(v=>v.phase),{timeout:90000}).toBe('ready')
  if (!options.resume) {
    const account=await page.evaluate(()=>window.aether.account.register()); expect(account.status).toBe('authenticated')
    await expect.poll(()=>page.evaluate(()=>window.aether.engine.getSnapshot()).then(v=>v.accountId)).toBe(account.user.id)
  } else {
    await expect.poll(()=>page.evaluate(()=>window.aether.engine.getSnapshot()).then(v=>v.accountId)).toBe(state.engine.accountId)
  }
  const snapshot=await page.evaluate(()=>window.aether.engine.getSnapshot())
  state.engine={mode:snapshot.mode,baseUrl:snapshot.baseUrl,instanceId:snapshot.instanceId,accountId:snapshot.accountId};state.enginePid=snapshot.pid;state.port=snapshot.port
  const request=async(method,url,body,query)=>{
    const r=await page.evaluate(input=>window.aether.engine.request(input),{method,path:url,body,query,expectedEngine:state.engine,toolProfile:'general'})
    if(!r.ok)throw new Error(scrub(`${method} ${url}: ${r.code} ${r.message}`));return r.data
  }
  if (!options.resume) {
    const created=await request('POST','/models',model);await request('PUT','/models/'+created.id,{isEnabled:true})
    const preflight=await request('POST','/models/'+created.id+'/test',{}); artifact('model-preflight.json',{modelId:model.modelId,success:preflight.success});expect(preflight.success).toBe(true)
  }
  artifact('engine-identity.json',snapshot)
  const catalog=await request('GET','/tools',undefined,{pageSize:1000,path:companyRoot});const allowedTools=(Array.isArray(catalog)?catalog:catalog.list||[]).map(x=>x.name)
  artifact('tools.json',catalog)
  const tasks=()=>page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('aether.work.state.v1')).flatMap(([,v])=>{const s=JSON.parse(v);return s.tasks.map(t=>({...t,active:s.activeTaskId===t.id}))}))
  const status=id=>request('GET','/chat/status',undefined,{sessionId:state.roles[id].sessionId})
  const selectWork=async()=>{await page.getByRole('tab',{name:'Work 办公',exact:true}).click();await expect(page.locator('#mode-work')).toHaveAttribute('aria-hidden','false')}
  const select=async id=>{
    await selectWork()
    const t=(await tasks()).find(t=>t.id===state.roles[id].sessionId)
    if(!t)throw Error('Missing task '+id)
    const recent=page.locator('#mode-work .work-sidebar__task').filter({hasText:t.title}).first()
    // Recovery tasks can push a role past the six-item recent shortcut list.
    // Use the normal searchable Work list without mutating stored selection.
    if(await recent.count()) await recent.click()
    else {
      await page.locator('#mode-work .work-navigation').getByRole('button',{name:'工作台',exact:true}).click()
      await page.getByRole('textbox',{name:'搜索 Work 任务',exact:true}).fill(t.title)
      await page.locator('#mode-work .work-task-row').filter({hasText:t.title}).click()
    }
    await expect.poll(async()=>(await tasks()).find(t=>t.active)?.id).toBe(t.id)
  }
  const submit=async(id,text,round)=>{
    const owner=state.roles[id];if(owner.sessionId)await select(id)
    const before=owner.sessionId?(await status(id)).run:null
    if(before && ['running','waiting','preparing','cancelling'].includes(before.status))throw Error('Role still active '+id)
    const composer=page.locator('#mode-work .input-composer__input[role="textbox"]').filter({visible:true}).first()
    await expect(composer).toBeEditable();await composer.fill(text)
    const send=page.locator('#mode-work').getByRole('button',{name:/^(开始任务|发送)$/}).filter({visible:true}).last();await expect(send).toBeEnabled()
    const record={round,promptSha256:crypto.createHash('sha256').update(text).digest('hex'),at:new Date().toISOString(),phase:'dispatching'}
    owner.submissions.push(record);artifact(`${id}-${round}-prompt.json`,{text});save();await send.click();await expect(composer).toHaveText('')
    if(!owner.sessionId){await expect.poll(async()=>(await tasks()).find(t=>t.active)?.agentId).toBe(owner.agentId);owner.sessionId=(await tasks()).find(t=>t.active).id}
    await expect.poll(async()=>(await status(id)).run?.runId,{timeout:90000}).not.toBe(before?.runId)
    const after=(await status(id)).run;if(!after?.runId)throw Error('No actual run '+id)
    record.runId=after.runId;record.phase='admitted';record.modelId=after.actualModelId||after.modelId
    const t=(await tasks()).find(t=>t.id===owner.sessionId);expect(t.agentId).toBe(owner.agentId);expect(t.workspacePath.replaceAll('\\','/').toLowerCase()).toBe(companyRoot.replaceAll('\\','/').toLowerCase());expect(t.modelId).toBe(model.modelId)
    artifact(`${id}-${round}-admission.json`,{task:t,run:after});save();log('admitted',{id,...record});return record
  }
  const createRoles=async scenario=>{
    for(const name of ['office_document','office_inspect','read_file','write_file','delete_file','subagent']) {
      if(!allowedTools.includes(name) || !scenario.toolPolicy.allowedTools.includes(name))throw Error('Missing native capability '+name)
    }
    for(const seed of scenario.seedFiles){const f=path.join(companyRoot,seed.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,seed.content,{flag:'wx'})}
    for(const role of scenario.roles){fs.mkdirSync(role.department,{recursive:true});const selected=role.allowedTools.filter(name=>allowedTools.includes(name));if(selected.some(name=>scenario.toolPolicy.forbiddenTools.includes(name)))throw Error('Forbidden office tool');const a=await request('POST','/agents',{name:role.name,description:role.expertise,model:model.modelId,skills:['aether-office'],mcpServers:[],knowledgeBases:[],allowedTools:selected,systemPrompt:role.builtinOnlySystemPrompt});state.roles[role.id]={name:role.name,agentId:a.id,sessionId:null,submissions:[],allowedTools:selected};save()}
    artifact('scenario.json',scenario);artifact('native-role-policy.json',scenario.toolPolicy);artifact('seed-hashes.json',Object.fromEntries(scenario.seedFiles.map(seed=>[seed.path,crypto.createHash('sha256').update(seed.content).digest('hex')])));await page.reload();await selectWork();state.phase='ready';save()
  }
  const start=async(id,prompt)=>{
    const owner=state.roles[id];await selectWork();await page.locator('#mode-work').getByRole('button',{name:'新任务',exact:true}).click()
    await page.locator('#mode-work .work-navigation').getByRole('button',{name:'Agent',exact:true}).click();await page.getByRole('button',{name:'使用 Agent '+owner.name,exact:true}).click()
    await page.locator('#mode-work .work-folder-button').click()
    await page.locator('#mode-work').getByRole('button',{name:'Work 使用的模型',exact:true}).click();await page.getByRole('menuitem').filter({hasText:model.displayName||model.modelId}).first().click()
    const security=page.locator('#mode-work').getByRole('button',{name:/^切换本会话访问权限：/});if(!(await security.innerText()).includes('完全访问')){await security.click();await page.getByRole('menuitem',{name:/^完全访问/}).click()};await expect(security).toContainText('完全访问')
    const admitted=await submit(id,prompt,'v1')
    await page.locator('#mode-work').getByRole('button',{name:'任务更多操作',exact:true}).click()
    await page.getByRole('menuitem',{name:'重命名任务',exact:true}).click()
    const title=page.locator('#mode-work').getByRole('textbox',{name:'任务名称',exact:true})
    await title.fill(owner.name+' · 原生办公验收');await title.press('Enter')
    await expect.poll(async()=>(await tasks()).find(task=>task.id===owner.sessionId)?.title).toBe(owner.name+' · 原生办公验收')
    return admitted
  }
  let busy=false,previousAt=0,previousCount=0,ticks=0
  const observe=async()=>{if(busy||page.isClosed())return;busy=true;try{
    const rows=await Promise.all(Object.entries(state.roles).filter(([,v])=>v.sessionId).map(async([id])=>({id,...await status(id)})))
    const now=Date.now(),count=rows.filter(x=>x.run?.status==='running').length;state.peakRunning=Math.max(count,state.peakRunning)
    if(count===6&&previousCount===6&&now-previousAt<20000)state.sixRunningSampleMs+=now-previousAt;previousAt=now;previousCount=count;state.observations++
    for(const row of rows){state.roles[row.id].lastRun=row.run;const r=state.roles[row.id].submissions.find(s=>s.runId===row.run?.runId);if(r&&!['preparing','running','waiting','cancelling'].includes(row.run?.status)){r.terminalStatus=row.run?.status;r.completedAt=row.run?.completedAt}}
    fs.appendFileSync(path.join(evidence,'status.jsonl'),safe({at:now,rows}).replace(/\n/g,'')+'\n')
    if(ticks++%3===0){const diagnostics=await page.evaluate(()=>window.aether.engine.diagnostics({refreshStorage:false}));const ui=await page.evaluate(()=>globalThis.__officeUiPerf??null);fs.appendFileSync(path.join(evidence,'metrics.jsonl'),safe({at:now,diagnostics,ui}).replace(/\n/g,'')+'\n')}
    save()
  }catch(error){log('observation-error',{message:scrub(error.message)})}finally{busy=false}}
  const timer=setInterval(()=>void observe(),5000);timer.unref()
  state.phase='engine-ready';save()
  return {app,page,state,request,artifact,save,log,tasks,status,select,submit,createRoles,start,observe,stopObserver:()=>clearInterval(timer)}
}
