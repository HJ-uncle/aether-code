/** Source negative: unmodified product must fail the changed-draft retry contract after INVALID. */
import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { monitorElectronHealth } from './helpers/electron-health'
const base=process.env.AETHER_QA_QUEUE_ORIGIN!,token=process.env.AETHER_QA_QUEUE_TOKEN!,profile=process.env.AETHER_QA_QUEUE_PROFILE!,model=process.env.AETHER_QA_QUEUE_MODEL!
async function control(body:Record<string,unknown>){const response=await fetch(base+'/qa/control',{method:'POST',headers:{'x-aether-instance-token':token,'content-type':'application/json'},body:JSON.stringify(body)});expect(response.status).toBe(200)}
test('changed draft can be queued after a real main INVALID rejection',async({},info)=>{
 const env:Record<string,string>=Object.fromEntries(Object.entries({...process.env,AETHER_IDE_REMOTE_INSTANCE_TOKEN:token,AETHER_GLOBAL_DIR:join(profile,'global')}).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));delete env.ELECTRON_RUN_AS_NODE
 const app=await electron.launch({args:[process.env.AETHER_E2E_APP_ENTRY!,`--user-data-dir=${profile}`],env}),health=await monitorElectronHealth(app,'queue-invalid-negative',[token]),page=await app.firstWindow(),errors:string[]=[]
 page.on('pageerror',error=>errors.push(error.message))
 try{
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{timeout:90000});await page.getByRole('tab',{name:'Work 办公',exact:true}).click()
  await page.evaluate(({base,model})=>{localStorage.setItem('aether.work.state.v1:'+encodeURIComponent('remote:'+base),JSON.stringify({tasks:[{id:'work-owned-A',title:'INVALID 用户流程负控',draft:'',status:'running',createdAt:Date.now(),updatedAt:Date.now(),workspacePath:null,modelId:model,attachments:[],sources:[]}],activeTaskId:'work-owned-A'}))},{base,model});await page.reload();await expect(page.locator('.status-bar')).toContainText('引擎：就绪');await page.getByRole('tab',{name:'Work 办公',exact:true}).click()
  const draft=page.getByRole('textbox',{name:'继续对话',exact:true}),send=page.getByRole('button',{name:'排到下一轮',exact:true})
  await control({taskId:'work-owned-A',workspacePaths:['x'.repeat(4097)]});await draft.fill('INVALID 原草稿');await expect(send).toBeEnabled();await send.click();await expect(page.locator('.work-next-turn__error')).toContainText('workspace identity');await expect(draft).toHaveText('INVALID 原草稿')
  await control({taskId:'work-owned-A',workspacePaths:[]});await draft.fill('纠正后的新草稿');await expect(send).toBeEnabled();await send.click()
  await expect(draft).toHaveText('');await page.getByRole('region',{name:'下一轮消息队列',exact:true}).getByRole('button',{name:/下一轮/}).click();await expect(page.locator('.work-next-turn__text')).toHaveText('纠正后的新草稿');expect(errors).toEqual([])
 }catch(error){writeFileSync(info.outputPath('negative-observation.json'),JSON.stringify({errors,text:await page.locator('body').innerText()},null,2));await page.screenshot({path:info.outputPath('negative-failure.png')});throw error}finally{await health.closeAndAssert(info)}
})
