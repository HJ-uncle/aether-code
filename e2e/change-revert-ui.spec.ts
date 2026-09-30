/** D2 real Electron + engine ChangeStore/JSONL fixtures: >200 operations, ordering, conflicts,
 * unavailable snapshots, partial history preservation, kept-file rollback and idempotence. No LLM calls. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { RevertReport } from '../src/renderer/src/core/engine/change-revert'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const partialSession = 'd2-partial-history'
const successSession = 'd2-success-history'
const partialMessage = 'D2 保留部分回退的对话'
const successMessage = 'D2 完整回退已保留改动'
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let keptId = ''

async function history(sessionId: string) {
  const result = await page.evaluate((sessionId) => window.aether.engine.request<Array<{ id: string; content: string }>>({
    method: 'GET', path: '/conversation/history', query: { sessionId }
  }), sessionId)
  expect(result.ok, result.message).toBe(true)
  return result.data ?? []
}

test.describe.serial('D2 文件回退真机闭环', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'd2-revert-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12417, autoStartEngine: true,
      lastSessionId: partialSession, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off'
    }))
    const seedPath = join(fixture, 'seed.mjs')
    writeFileSync(seedPath, `
      import fs from 'node:fs';
      import path from 'node:path';
      const { initDb, getDb } = await import(${JSON.stringify(pathToFileURL(join(engineRoot, 'dist/storage/sqlite/db.js')).href)});
      const { ChangeStore } = await import(${JSON.stringify(pathToFileURL(join(engineRoot, 'dist/storage/changes/index.js')).href)});
      const { JSONLConversationHistory } = await import(${JSON.stringify(pathToFileURL(join(engineRoot, 'dist/storage/conversation/jsonl-history.js')).href)});
      const { rootRunStore } = await import(${JSON.stringify(pathToFileURL(join(engineRoot, 'dist/storage/root-runs/index.js')).href)});
      await initDb();
      const store = new ChangeStore();
      const history = new JSONLConversationHistory();
      const fixture = ${JSON.stringify(fixture)};
      const partial = ${JSON.stringify(partialSession)}, success = ${JSON.stringify(successSession)};
      const stamp = Date.now();
      const runs = new Map();
      for (const [sessionId, content] of [[partial, ${JSON.stringify(partialMessage)}], [success, ${JSON.stringify(successMessage)}]]) {
        const run = await rootRunStore.create('default', sessionId, 'fixture', [path.join(fixture, 'workspace')], {});
        runs.set(sessionId, run);
        await rootRunStore.update('default', run.runId, {status: 'succeeded'});
        await history.append({id: run.userMessageId, role: 'user', content, createdAt: stamp - 10, conversationId: run.turnId}, {tenantId: 'default', sessionId});
        await history.append({id: run.assistantMessageId, role: 'assistant', content: 'D2 fixture finished', createdAt: stamp + 10, conversationId: run.turnId}, {tenantId: 'default', sessionId});
      }
      async function record(name, before, after, extra = {}) {
        const run = runs.get(extra.sessionId || partial);
        return store.record('default', {sessionId: partial, turnId: run.turnId, runId: run.runId, path: path.join(fixture, 'workspace', name), kind: 'write', oldContent: before, newContent: after, ...extra});
      }
      await record('chain.txt', 'A', 'B');
      await record('chain.txt', 'B', 'C');
      fs.writeFileSync(path.join(fixture, 'workspace', 'chain.txt'), 'C');
      for (let i = 0; i < 201; i++) await record('bulk.txt', 'f' + i, 'f' + (i + 1));
      fs.writeFileSync(path.join(fixture, 'workspace', 'bulk.txt'), 'f201');
      await record('manual.txt', 'original', 'agent');
      fs.writeFileSync(path.join(fixture, 'workspace', 'manual.txt'), 'HUMAN');
      await record('unavailable.txt', null, null, {truncated: true});
      fs.writeFileSync(path.join(fixture, 'workspace', 'unavailable.txt'), 'UNARCHIVED');
      const kept = await record('kept.txt', 'before-kept', 'after-kept', {sessionId: success});
      await store.markStatus(kept.id, 'default', 'kept');
      fs.writeFileSync(path.join(fixture, 'workspace', 'kept.txt'), 'after-kept');
      // Equal millisecond timestamps must still be ordered by the durable operation sequence.
      await getDb().execute({sql: 'UPDATE file_changes SET created_at=?', args: [stamp]});
      console.log('D2_SEEDED ' + JSON.stringify({keptId: kept.id}));
      getDb().close();
    `)
    const output = execFileSync(process.execPath, [seedPath], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, DATA_DIR: join(fixture, 'engine', 'state', 'agent.db') }
    })
    const seeded = output.split(/\r?\n/).find(line => line.startsWith('D2_SEEDED '))
    if (!seeded) throw new Error(`D2 seed failed: ${output}`)
    keptId = JSON.parse(seeded.slice('D2_SEEDED '.length)).keptId
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: {
        ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
        AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false'
      }
    })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await expect(page.locator('.chat-panel')).toContainText(partialMessage)
  })
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const resolved = resolve(fixture)
    if (dirname(resolved) !== resolve(root, '.e2e-tmp') || !basename(resolved).startsWith('d2-revert-ui-')) {
      throw new Error('Refusing cleanup outside this D2 fixture')
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('205条操作汇总为4个文件；一次撤回仍覆盖全部操作并保护人工修改', async () => {
    const ledger = await page.evaluate(sessionId => window.aether.engine.request<unknown[]>({
      method: 'GET', path: '/changes', query: { sessionId, status: 'pending' }
    }), partialSession)
    expect(ledger.ok, ledger.message).toBe(true)
    expect(ledger.data).toHaveLength(205)
    await expect(page.getByRole('button', { name: '改动 4', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '改动 4', exact: true }).click()
    await expect(page.locator('.changes-panel__item')).toHaveCount(4)
    await page.locator('.changes-panel__footer').getByRole('button', { name: '撤回', exact: true }).click()
    await page.getByRole('dialog', { name: '撤回改动' }).getByRole('button', { name: '撤回', exact: true }).click()
    const report = page.getByRole('region', { name: '文件回退结果' })
    await expect(report).toContainText('已撤回 2 个文件（203 处改动）')
    await expect(report).toContainText('版本冲突 1 处')
    await expect(report).toContainText('不可自动回退 1 处')
    expect(readFileSync(join(fixture, 'workspace', 'chain.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(fixture, 'workspace', 'bulk.txt'), 'utf8')).toBe('f0')
    expect(readFileSync(join(fixture, 'workspace', 'manual.txt'), 'utf8')).toBe('HUMAN')
    expect(readFileSync(join(fixture, 'workspace', 'unavailable.txt'), 'utf8')).toBe('UNARCHIVED')
    await expect(page.locator('.changes-panel__item')).toHaveCount(2)
  })

  test('消息回退有冲突或缺失快照时，真实历史及消息仍保留', async () => {
    const before = await history(partialSession)
    expect(before).toHaveLength(2)
    await page.getByRole('button', { name: '回退到此处', exact: true }).click()
    await page.getByRole('dialog', { name: '回退到此处' }).getByRole('button', { name: '回退', exact: true }).click()
    await expect(page.getByRole('region', { name: '文件回退结果' })).toContainText('此前已撤回 203 处')
    await expect(page.locator('.chat-panel')).toContainText(partialMessage)
    expect(await history(partialSession)).toEqual(before)
    expect(readFileSync(join(fixture, 'workspace', 'manual.txt'), 'utf8')).toBe('HUMAN')
  })

  test('消息回退包含已保留改动；完全成功才删历史；零待确认仍能查看结果', async () => {
    await page.evaluate(sessionId => window.aether.settings.update({ lastSessionId: sessionId }), successSession)
    await page.reload()
    await expect(page.locator('.chat-panel')).toContainText(successMessage)
    expect(await history(successSession)).toHaveLength(2)
    await page.getByRole('button', { name: '回退到此处', exact: true }).click()
    await page.getByRole('dialog', { name: '回退到此处' }).getByRole('button', { name: '回退', exact: true }).click()
    await expect.poll(async () => (await history(successSession)).length).toBe(0)
    expect(readFileSync(join(fixture, 'workspace', 'kept.txt'), 'utf8')).toBe('before-kept')
    await page.getByRole('button', { name: '改动 0', exact: true }).click()
    await expect(page.getByRole('region', { name: '文件回退结果' })).toContainText('已撤回 1 个文件（1 处改动）')
    const retry = await page.evaluate(({ sessionId, id }) => window.aether.engine.request<RevertReport>({
      method: 'POST', path: '/changes/revert-batch', body: { sessionId, ids: [id], scope: 'all' }
    }), { sessionId: successSession, id: keptId })
    expect(retry.ok, retry.message).toBe(true)
    expect(retry.data?.results.map(item => item.status)).toEqual(['already_reverted'])
    expect(readFileSync(join(fixture, 'workspace', 'kept.txt'), 'utf8')).toBe('before-kept')
  })
})
