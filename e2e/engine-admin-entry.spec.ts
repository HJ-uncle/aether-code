import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, current, launch, live, open, page, profile, registerConnectionHarness, root } from './fixtures/engine-connection-harness'

registerConnectionHarness({ captureOnFailure: false })
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('旧引擎在设置里显示升级说明，不会把 401 JSON 当管理页打开', async () => {
  await launch(); await open(); await current().getByTestId('engine-open-admin').click()
  await expect(current().getByRole('alert')).toContainText(/升级实际运行的引擎/)
  expect(await app!.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('自管引擎用隔离窗口处理实例令牌，用户仍须登录，停止该测试引擎后关闭窗口', async () => {
  const temporary = createServer(); await new Promise<void>(done=>temporary.listen(0,'127.0.0.1',done)); const port = (temporary.address() as {port:number}).port
  await new Promise<void>((done,reject)=>temporary.close(error=>error?reject(error):done()))
  const engine = resolve(process.env.AETHER_ENGINE_SOURCE_DIR || join(root, '../ai-agent-engine'))
  await launch('local', { engineEntry: join(engine,'dist/main.js'), preferredPort: port }); await expect.poll(live,{timeout:90000}).toMatchObject({phase:'ready',mode:'embedded',adopted:false,port})
  const state = await live(); expect(state.dataDir).toBe(join(profile,'engine','state','agent.db'))
  const privateFile = join(profile,'private','management.key')
  await promisify(execFile)(process.execPath, [join(engine,'dist/admin-cli.js'),'admin','create','--name','桌面验收管理员','--data',state.dataDir!,'--out',privateFile],{cwd:profile, windowsHide:true})
  const key = readFileSync(privateFile,'utf8').trim(), url=state.baseUrl+'/admin/'
  const direct = await fetch(url+'me',{headers:{'X-Aether-Admin-Key':key},redirect:'error'}); expect(direct.status).toBe(401)
  await open(); await current().getByTestId('engine-open-admin').click()
  await expect.poll(() => app!.evaluate(({ BrowserWindow }, address) => BrowserWindow.getAllWindows().some(w=>w.webContents.getURL()===address),url)).toBe(true)
  const result = await app!.evaluate(async ({BrowserWindow}, detail) => {
    const panel = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===detail.url)!
    const wc=panel.webContents
    const visible = await wc.executeJavaScript("!!document.getElementById('access-form') && typeof window.aether === 'undefined' && typeof window.require === 'undefined'")
    const anon = await wc.executeJavaScript("fetch('./me').then(r=>r.status)")
    const authenticated = await wc.executeJavaScript("fetch('./me',{headers:{'X-Aether-Admin-Key':"+JSON.stringify(detail.key)+"}}).then(async r=>({status:r.status,name:(await r.json()).data?.name}))")
    return {visible,anon,authenticated}
  },{url,key})
  expect(result).toEqual({ visible:true, anon:401, authenticated:{status:200,name:'桌面验收管理员'} })
  const downloadPath = join(profile,'rules-export.json')
  const finished = await app!.evaluate(async ({BrowserWindow}, details) => {
    const wc = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === details.url)!.webContents
    const completion = new Promise<string>((done) => {
      const timeout = setTimeout(() => done('timeout'), 9000)
      wc.session.once('will-download', (_event,item) => { item.setSavePath(details.output); item.once('done',(_event,state) => {clearTimeout(timeout);done(state)}) })
    })
    await wc.executeJavaScript("(async()=>{const r=await fetch('./rules/archive',{headers:{'X-Aether-Admin-Key':"+JSON.stringify(details.key)+"}});if(!r.ok)throw Error('Archive unavailable');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify((await r.json()).data)],{type:'application/json'}));a.download='aether-monitor-rules.json';document.body.append(a);a.click();a.remove()})()",true)
    return completion
  },{url,key,output:downloadPath})
  expect(finished).toBe('completed'); expect(JSON.parse(readFileSync(downloadPath,'utf8'))).toEqual({format:'aether.monitor-rules',version:1,rules:[]})
  await page.evaluate(()=>window.aether.engine.stop())
  await expect.poll(() => app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1)
})
