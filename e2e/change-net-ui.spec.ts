/** Real engine ledger + Electron + disposable Git: net rows, restart, grouped actions and absolute paths.
 * No provider requests or user repositories. Run only after both repositories have been built. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { EngineFileChange } from '../src/shared/ipc'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine')
const sessionId = 'net-file-changes'
let fixture = '', workspace = '', app: ElectronApplication | undefined, page: Page
const rows = () => page.locator('.changes-panel__item')
const row = (name: string) => rows().filter({ has: page.locator('.changes-panel__name', { hasText: name }) })
function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(fixture, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' }
  }).trim()
}
async function launch() {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: {
    ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
    AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: workspace,
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false',
    GIT_CEILING_DIRECTORIES: fixture
  } })
  page = await app.firstWindow()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('.chat-panel')).toContainText('净改动回归夹具')
}
async function ledger(): Promise<EngineFileChange[]> {
  const result = await page.evaluate(sessionId => window.aether.engine.request<EngineFileChange[]>({
    method: 'GET', path: '/changes', query: { sessionId }
  }), sessionId)
  expect(result.ok, result.message).toBe(true)
  return result.data ?? []
}
async function openTray(count: number) {
  const button = page.getByRole('button', { name: `改动 ${count}`, exact: true })
  await expect(button).toBeVisible()
  if (!(await rows().first().isVisible())) await button.click()
  await expect(rows()).toHaveCount(count)
}

test.describe.serial('净文件改动真机闭环', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'net-changes-'))
    workspace = join(fixture, 'workspace'); mkdirSync(workspace)
    writeFileSync(join(fixture, 'empty-gitconfig'), '')
    git('init'); git('config', 'user.name', 'Net Changes'); git('config', 'user.email', 'net@example.invalid')
    for (const name of ['revert.txt', 'keep.txt', 'stage[1].txt', 'delete.txt', 'different.txt', 'manual.txt']) writeFileSync(join(workspace, name), 'original\n')
    writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n')
    git('add', '.'); git('commit', '-m', 'fixture baseline')
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12447,
      autoStartEngine: true, lastSessionId: sessionId, lastFolder: workspace, thinkingMode: 'off' }))
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    const seed = join(fixture, 'seed.mjs')
    writeFileSync(seed, `
      import fs from 'node:fs'; import path from 'node:path';
      const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {ChangeStore}=await import(${JSON.stringify(url('storage/changes/index.js'))});
      const {JSONLConversationHistory}=await import(${JSON.stringify(url('storage/conversation/jsonl-history.js'))});
      const {rootRunStore}=await import(${JSON.stringify(url('storage/root-runs/index.js'))});
      await initDb(); const store=new ChangeStore(); const workspace=${JSON.stringify(workspace)}, sessionId=${JSON.stringify(sessionId)};
      const run=await rootRunStore.create('default',sessionId,'fixture',[workspace],{});
      await rootRunStore.update('default',run.runId,{status:'succeeded'});
      await new JSONLConversationHistory().append({id:run.userMessageId,role:'user',content:'净改动回归夹具',createdAt:Date.now(),conversationId:run.turnId},{tenantId:'default',sessionId});
      async function chain(name,versions) {
        for(let i=1;i<versions.length;i++) await store.record('default',{sessionId,turnId:run.turnId,runId:run.runId,path:path.join(workspace,name),kind:versions[i]===null?'delete':'write',oldContent:versions[i-1],newContent:versions[i]});
        const last=versions.at(-1); if(last===null) {if(fs.existsSync(path.join(workspace,name))) fs.unlinkSync(path.join(workspace,name));} else fs.writeFileSync(path.join(workspace,name),last);
      }
      await chain('survey.mjs',[null,'temporary\\n',null]);
      await chain('restored.txt',['same\\n',null,'same\\n']);
      await chain('undo.txt',['before\\n','middle\\n','before\\n']);
      for(const name of ['revert.txt','keep.txt','stage[1].txt']) await chain(name,['original\\n','middle\\n','final\\n']);
      await chain('different.txt',['original\\n',null,'different\\n']);
      await chain('delete.txt',['original\\n',null]);
      await chain('manual.txt',['original\\n','agent\\n','original\\n']);
      fs.writeFileSync(path.join(workspace,'manual.txt'),'HUMAN\\n');
      const emptySession='net-only-noops';
      await new JSONLConversationHistory().append({id:'empty-user',role:'user',content:'仅临时文件的会话',createdAt:Date.now(),conversationId:'empty-turn'},{tenantId:'default',sessionId:emptySession});
      await store.record('default',{sessionId:emptySession,path:path.join(workspace,'only-temp.mjs'),kind:'write',oldContent:null,newContent:'temporary'});
      await store.record('default',{sessionId:emptySession,path:path.join(workspace,'only-temp.mjs'),kind:'delete',oldContent:'temporary',newContent:null});
      getDb().close();
    `)
    execFileSync(process.execPath, [seed], { encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: { ...process.env, DATA_DIR: join(fixture, 'engine', 'state', 'agent.db') } })
    await launch()
  })
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('net-changes-')) throw new Error('unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('17条流水按净变化显示6行，新增删除/恢复原内容消失，人工编辑不隐藏；重启一致', async ({}, testInfo) => {
    expect(await ledger()).toHaveLength(17)
    await openTray(6)
    for (const name of ['survey.mjs', 'restored.txt', 'undo.txt']) await expect(row(name)).toHaveCount(0)
    expect(existsSync(join(workspace, 'survey.mjs'))).toBe(false)
    await expect(row('different.txt').locator('.changes-panel__badge')).toHaveText('M')
    await expect(row('revert.txt').locator('.changes-panel__stats')).toHaveText('+1-1')
    await expect(row('manual.txt').getByLabel('文件已被另行修改，当前展示记录中的差异')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('net-changes.png') })
    await app!.close(); await launch(); await openTray(6)
    expect(await ledger()).toHaveLength(17)
  })

  test('单行撤回整组恢复初始内容，单行保留确认整组', async () => {
    await row('revert.txt').getByRole('button', { name: '撤回 revert.txt', exact: true }).click()
    await page.getByRole('dialog', { name: '撤回改动' }).getByRole('button', { name: '撤回', exact: true }).click()
    await expect(row('revert.txt')).toHaveCount(0)
    expect(readFileSync(join(workspace, 'revert.txt'), 'utf8')).toBe('original\n')
    expect((await ledger()).filter(change => change.path.endsWith('revert.txt')).map(change => change.status)).toEqual(['reverted', 'reverted'])
    await row('keep.txt').getByRole('button', { name: '保留', exact: true }).click()
    await expect(row('keep.txt')).toHaveCount(0)
    expect((await ledger()).filter(change => change.path.endsWith('keep.txt')).map(change => change.status)).toEqual(['kept', 'kept'])
    expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('final\n')
  })

  test('绝对路径含方括号及已删除文件都可真实暂存，整组标记保留', async () => {
    await row('stage[1].txt').getByRole('button', { name: '暂存', exact: true }).click()
    await expect(row('stage[1].txt')).toHaveCount(0)
    expect(git('show', ':stage[1].txt')).toBe('final')
    expect((await ledger()).filter(change => change.path.endsWith('stage[1].txt')).map(change => change.status)).toEqual(['kept', 'kept'])
    await row('delete.txt').getByRole('button', { name: '暂存', exact: true }).click()
    await expect(row('delete.txt')).toHaveCount(0)
    expect(git('diff', '--cached', '--name-status')).toContain('D\tdelete.txt')
    expect(git('diff', '--cached', '--name-status')).toContain('M\tstage[1].txt')
  })

  test('非仓库错误如实返回；全忽略不暂存；其它文件的原暂存保留', async () => {
    writeFileSync(join(workspace, 'ignored.txt'), 'ignored')
    const ignored = await page.evaluate(workspace => window.aether.git.stageFiles(workspace, [workspace + '/ignored.txt']), workspace)
    expect(ignored).toMatchObject({ success: true, stagedPaths: [] })
    const plain = join(fixture, 'plain'); mkdirSync(plain); writeFileSync(join(plain, 'file.txt'), 'plain')
    await page.evaluate(plain => window.aether.fs.allowRoot(plain), plain)
    const failed = await page.evaluate(plain => window.aether.git.stageFiles(plain, [plain + '/file.txt']), plain)
    expect(failed.success).toBe(false)
    expect(failed.error).toBeTruthy()
    expect(git('show', ':stage[1].txt')).toBe('final')
  })

  test('全部保留包括已抵消记录，计数归零，刷新后不复现旧行', async () => {
    await expect(rows()).toHaveCount(2)
    await page.locator('.changes-panel__footer').getByRole('button', { name: '保留', exact: true }).click()
    await expect(rows()).toHaveCount(0)
    expect((await ledger()).filter(change => change.status === 'pending')).toEqual([])
    expect(readFileSync(join(workspace, 'manual.txt'), 'utf8')).toBe('HUMAN\n')
    expect(existsSync(join(workspace, 'survey.mjs'))).toBe(false)
    await page.reload()
    await expect(page.locator('.chat-panel')).toContainText('净改动回归夹具')
    await expect(page.getByRole('button', { name: /^改动 \d+$/ })).toHaveCount(0)
  })

  test('仅创建然后删除的会话不显示待确认托盘，原始历史仍存在', async () => {
    await page.evaluate(() => window.aether.settings.update({ lastSessionId: 'net-only-noops' }))
    await page.reload()
    await expect(page.locator('.chat-panel')).toContainText('仅临时文件的会话')
    const pending = await page.evaluate(() => window.aether.engine.request<EngineFileChange[]>({
      method: 'GET', path: '/changes', query: { sessionId: 'net-only-noops', status: 'pending' }
    }))
    expect(pending.ok, pending.message).toBe(true)
    expect(pending.data).toHaveLength(2)
    await expect(page.getByRole('button', { name: /^改动 \d+$/ })).toHaveCount(0)
    await expect(rows()).toHaveCount(0)
    expect(existsSync(join(workspace, 'only-temp.mjs'))).toBe(false)
  })
})
