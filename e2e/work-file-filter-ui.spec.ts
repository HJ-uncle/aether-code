/** Fresh isolated Electron acceptance of the actual WorkspacePanel and
 * fs-client: deep Chinese name filtering, cached enumeration, temporary
 * expansion, refresh, failed directories and late-session response isolation.
 * The HTTP fixture supplies directory metadata only; no model, old E2E,
 * production profile or export UI is involved. Build the app before running. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { FsEntry } from '../src/shared/ipc'

const root = resolve(__dirname, '..'), temp = join(root, '.e2e-tmp')
const token = 'work-filter-disposable-token'
interface Workspace { sessionId: string; root: string; files: Set<string>; failures: Set<string> }
interface Read { sessionId: string; path: string }
interface Held { response: ServerResponse; data: unknown }
interface Harness {
  open(sessionId: string, root: string): void
  memory(): { expanded: string[]; filter: string }
  opened: string[]
}
type HarnessWindow = Window & { filterHarness: Harness }
const workspaces = new Map<string, Workspace>(), reads: Read[] = [], forbidden: string[] = [], errors: string[] = []
const held = new Map<string, Held[]>(), holdKeys = new Set<string>()
let app: ElectronApplication | undefined, page: Page, server: Server | undefined, fixture = '', url = '', counter = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const identity = (sessionId: string, path: string): string => JSON.stringify([sessionId, path])

function entries(workspace: Workspace, directory: string): FsEntry[] {
  const result = new Map<string, FsEntry>(), prefix = directory ? `${directory}/` : ''
  for (const file of workspace.files) {
    if (!file.startsWith(prefix)) continue
    const tail = file.slice(prefix.length), name = tail.split('/')[0]
    if (!name) continue
    const path = prefix + name
    result.set(path, { name, path, isDirectory: tail.includes('/'), size: tail.includes('/') ? 0 : 9, mtimeMs: 1 })
  }
  return [...result.values()]
}

function release(key: string): void {
  holdKeys.delete(key)
  for (const item of held.get(key) ?? []) if (!item.response.destroyed) item.response.end(envelope(item.data))
  held.delete(key)
}

function createWorkspace(files: string[], prefix = 'project'): Workspace {
  const sessionId = `work-file-filter-${++counter}`
  const workspace = { sessionId, root: `/remote/${prefix}/${sessionId}`, files: new Set(files), failures: new Set<string>() }
  workspaces.set(sessionId, workspace)
  return workspace
}

async function open(workspace: Workspace): Promise<void> {
  await page.evaluate(({ sessionId, root }) => (window as HarnessWindow).filterHarness.open(sessionId, root), workspace)
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
  await expect(row(workspace.root)).toBeVisible()
}

function row(path: string) { return page.getByRole('tree').locator(`[role="treeitem"][data-path=${JSON.stringify(path)}]`) }
const filter = () => page.getByRole('textbox', { name: '筛选文件', exact: true })
const sessionReads = (workspace: Workspace): Read[] => reads.filter(read => read.sessionId === workspace.sessionId)
const visibleFiles = () => page.getByRole('tree').locator('[role="treeitem"][data-parent-dir]').evaluateAll(rows => rows.map(row => row.getAttribute('data-path')).sort())

test.beforeAll(async () => {
  if (!existsSync(join(root, 'out/renderer/index.html'))) throw new Error('Build the current application before this fresh E2E.')
  mkdirSync(temp, { recursive: true }); fixture = mkdtempSync(join(temp, 'work-file-filter-native-'))
  const staticRoot = join(fixture, 'web'); mkdirSync(staticRoot)
  server = createServer((request, response) => { void (async () => {
    const parsed = new URL(request.url ?? '/', 'http://fixture'), pathname = parsed.pathname
    if (!pathname.startsWith('/api/')) {
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1)
      const candidate = resolve(staticRoot, filename)
      if (dirname(candidate) !== staticRoot || !existsSync(candidate)) { response.writeHead(404).end(); return }
      const mime = extname(candidate) === '.js' ? 'text/javascript' : extname(candidate) === '.css' ? 'text/css' : 'text/html'
      response.setHeader('Content-Type', mime); response.end(readFileSync(candidate)); return
    }
    response.setHeader('Content-Type', 'application/json')
    if (request.headers['x-aether-instance-token'] !== token) throw new Error('Fixture request has no owned token')
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
    const sessionId = parsed.searchParams.get('sessionId') ?? String(body.sessionId ?? '')
    const workspace = workspaces.get(sessionId)
    if (!workspace) throw new Error(`Unexpected session: ${sessionId}`)
    if (pathname === '/api/workspace/bind') {
      if (body.workspaceRoot !== workspace.root) throw new Error('Unexpected workspace binding')
      response.end(envelope({ workspaceRoot: workspace.root, bindingEpoch: `epoch-${sessionId}`, contractVersion: 2 })); return
    }
    if (pathname === '/api/workspace/directory') {
      const path = parsed.searchParams.get('path') ?? '.', relative = path === '.' ? '' : path
      if (relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('Directory request escaped its session')
      reads.push({ sessionId, path: relative })
      if (workspace.failures.has(relative)) { response.end(JSON.stringify({ code: 40300, message: 'EACCES: 测试目录不可读', data: null })); return }
      const data = { root: workspace.root, bindingEpoch: `epoch-${sessionId}`, contractVersion: 2, entries: entries(workspace, relative) }
      const key = identity(sessionId, relative)
      if (holdKeys.has(key)) { held.set(key, [...held.get(key) ?? [], { response, data }]); return }
      response.end(envelope(data)); return
    }
    if (pathname === '/api/git/binding') { response.end(envelope({ root: workspace.root, epoch: `epoch-${sessionId}`, contractVersion: 2, mutationRequiresBinding: true })); return }
    if (pathname === '/api/git/status') { response.end(envelope({ success: true, isRepo: false, files: [] })); return }
    forbidden.push(`${request.method} ${pathname}`)
    response.writeHead(404).end(JSON.stringify({ code: 40400, message: 'Unexpected fixture endpoint', data: null }))
  })().catch(error => { errors.push(String(error)); response.writeHead(500).end(String(error)) }) })
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  url = `http://127.0.0.1:${address.port}`
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html data-appearance="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>')
  await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkspacePanel} from './src/renderer/src/features/workspace/WorkspacePanel';
    import {publishEngineSource,engineStorageKey,getExpectedEngine} from './src/renderer/src/core/engine/source';
    import {createFileTreeScope,readFileTreeMemory} from './src/renderer/src/core/workspace/file-tree-memory';
    import './src/renderer/src/assets/tokens.css'; import './src/renderer/src/assets/components.css';
    publishEngineSource({mode:'remote',baseUrl:${JSON.stringify(url)},instanceId:'filter-instance',phase:'ready'});
    const root=createRoot(document.getElementById('root'));let sessionId='',workspaceRoot='';
    const opened=[];
    function open(id,path){sessionId=id;workspaceRoot=path;opened.length=0;root.render(<WorkspacePanel sessionId={id} workspaceRoot={path} onOpenFile={path=>opened.push(path)}/>)}
    function memory(){return readFileTreeMemory(createFileTreeScope('work',engineStorageKey(getExpectedEngine()),sessionId,workspaceRoot))}
    window.filterHarness={open,memory,opened};
  `, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(staticRoot, 'entry.js'), platform: 'browser', format: 'iife',
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, tsconfig: join(root, 'tsconfig.web.json'),
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' }, logLevel: 'silent',
    // The panel imports its optional search subtree, whose editor imports
    // Vite's worker syntax. Compile those real workers rather than stubbing
    // editor modules or replacing any production file-tree behavior.
    plugins: [{ name: 'native-worker-imports', setup(builder) {
      builder.onResolve({ filter: /\?worker$/ }, async args => {
        const result = await builder.resolve(args.path.replace(/\?worker$/, ''), { resolveDir: args.resolveDir, kind: 'import-statement' })
        if (result.errors.length) return { errors: result.errors }
        return { path: result.path, namespace: 'filter-worker' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'filter-worker' }, async args => {
        const filename = basename(args.path).replace(/\.js$/, '') + '.bundle.js'
        await build({ entryPoints: [args.path], bundle: true, format: 'iife', platform: 'browser', outfile: join(staticRoot, filename), logLevel: 'silent' })
        return { contents: `export default class extends Worker { constructor(options){super(${JSON.stringify('/' + filename)},options)} }`, loader: 'js' }
      })
    } }] })
  const css = join(staticRoot, 'entry.css')
  writeFileSync(css, readFileSync(css, 'utf8') + '\nhtml,body,#root{margin:0;height:100%;overflow:hidden}#root{width:540px;height:850px}*{animation:none!important;transition:none!important}')
  const preload = join(fixture, 'preload.cjs'), main = join(fixture, 'main.cjs')
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('aether',{engine:{request:input=>ipcRenderer.invoke('filter-request',input)}});`)
  writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(join(fixture, 'profile'))});
    ipcMain.handle('filter-request',async(_event,input)=>{if(input.expectedEngine?.baseUrl!==${JSON.stringify(url)}||input.toolProfile!=='general')throw new Error('Wrong engine identity');
    const u=new URL('/api'+input.path,${JSON.stringify(url)});for(const [key,value] of Object.entries(input.query??{})){if(value!==undefined)u.searchParams.set(key,String(value))}
    const r=await fetch(u,{method:input.method??'GET',headers:{'x-aether-instance-token':${JSON.stringify(token)},'content-type':'application/json'},...(input.body?{body:JSON.stringify(input.body)}:{})});const b=await r.json();return {ok:b.code===200,code:b.code,message:b.message,data:b.data}});
    app.whenReady().then(()=>{const w=new BrowserWindow({width:540,height:850,useContentSize:true,show:false,webPreferences:{preload:${JSON.stringify(preload)},backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)})});app.on('window-all-closed',()=>app.quit());`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [main], cwd: root, env }); page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean((window as HarnessWindow).filterHarness))
})

test.afterEach(() => { expect(errors).toEqual([]); expect(forbidden).toEqual([]) })
test.afterAll(async () => {
  for (const key of held.keys()) release(key)
  try { await app?.close() } finally {
    await new Promise<void>(done => server?.close(() => done()) ?? done())
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== temp || !basename(target).startsWith('work-file-filter-native-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('未展开的多级中文文件全部命中；输入变化复用缓存，清除恢复原展开并可打开文件', async ({}, info) => {
  const workspace = createWorkspace(['README.md', '交付/第1轮/围棋-说明.docx', '交付/第2轮/深层/围棋-说明.docx',
    '档案/多级/更深/围棋-台账.xlsx', '档案/多级/更深/其他.txt'])
  await open(workspace)
  expect(sessionReads(workspace).every(read => read.path === '')).toBe(true)
  await row(`${workspace.root}/交付`).click()
  await expect(row(`${workspace.root}/交付/第1轮`)).toBeVisible()
  const original = await page.evaluate(() => (window as HarnessWindow).filterHarness.memory().expanded)
  await filter().fill('围棋')
  await expect.poll(visibleFiles).toEqual(['交付/第1轮/围棋-说明.docx', '交付/第2轮/深层/围棋-说明.docx', '档案/多级/更深/围棋-台账.xlsx'].map(path => `${workspace.root}/${path}`).sort())
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
  const afterScan = sessionReads(workspace).length
  await page.screenshot({ path: info.outputPath('deep-chinese-matches.png') })
  await row(`${workspace.root}/交付/第2轮/深层/围棋-说明.docx`).click()
  await expect.poll(() => page.evaluate(() => (window as HarnessWindow).filterHarness.opened)).toEqual([`${workspace.root}/交付/第2轮/深层/围棋-说明.docx`])
  await filter().fill('台账')
  await expect.poll(visibleFiles).toEqual([`${workspace.root}/档案/多级/更深/围棋-台账.xlsx`])
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
  expect(sessionReads(workspace)).toHaveLength(afterScan)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await expect(filter()).toHaveValue('')
  expect(await page.evaluate(() => (window as HarnessWindow).filterHarness.memory().expanded)).toEqual(original)
  await expect(row(`${workspace.root}/交付`)).toHaveAttribute('aria-expanded', 'true')
  await expect(row(`${workspace.root}/交付/第1轮`)).toHaveAttribute('aria-expanded', 'false')
  await expect(row(`${workspace.root}/档案/多级/更深/围棋-台账.xlsx`)).toHaveCount(0)
})

test('深层读取失败有明确反馈，不能把未读目录说成没有匹配', async ({}, info) => {
  const workspace = createWorkspace(['正常/普通.txt', '受限/深层/围棋-隐藏.pptx'])
  workspace.failures.add('受限/深层')
  await open(workspace); await filter().fill('围棋')
  await expect.poll(() => sessionReads(workspace).some(read => read.path === '受限/深层')).toBe(true)
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByText(/没有匹配的文件/)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('incomplete-directory-feedback.png') })
})

test('刷新使折叠分支缓存失效，筛选反映磁盘新增和删除', async () => {
  const workspace = createWorkspace(['一层/二层/围棋-旧版.txt', '另一层/围棋-保留.txt'])
  await open(workspace); await filter().fill('围棋')
  await expect.poll(visibleFiles).toEqual(['一层/二层/围棋-旧版.txt', '另一层/围棋-保留.txt'].map(path => `${workspace.root}/${path}`).sort())
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
  workspace.files.delete('一层/二层/围棋-旧版.txt'); workspace.files.add('一层/二层/围棋-新版.txt')
  const readsBefore = sessionReads(workspace).filter(read => read.path === '一层/二层').length
  await page.getByRole('button', { name: '刷新工作区文件', exact: true }).click()
  await expect.poll(visibleFiles).toEqual(['一层/二层/围棋-新版.txt', '另一层/围棋-保留.txt'].map(path => `${workspace.root}/${path}`).sort())
  expect(sessionReads(workspace).filter(read => read.path === '一层/二层')).toHaveLength(readsBefore + 1)
})

test('等待深层目录时显示忙碌，切换会话后旧响应不污染新工作区', async () => {
  const old = createWorkspace(['慢目录/深层/围棋-旧会话.txt'], 'old'), next = createWorkspace(['新目录/围棋-新会话.txt'], 'next')
  const key = identity(old.sessionId, '慢目录'); holdKeys.add(key)
  await open(old); await filter().fill('围棋')
  await expect.poll(() => held.has(key)).toBe(true)
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.work-workspace-panel__filter-status[role="status"]')).toBeVisible()
  await open(next); await filter().fill('围棋')
  await expect.poll(visibleFiles).toEqual([`${next.root}/新目录/围棋-新会话.txt`])
  release(key)
  await expect.poll(() => held.has(key)).toBe(false)
  await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
  await expect.poll(visibleFiles).toEqual([`${next.root}/新目录/围棋-新会话.txt`])
  expect(sessionReads(old).some(read => read.path === '慢目录/深层')).toBe(false)
})
