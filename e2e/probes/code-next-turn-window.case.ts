/** Real renderer/preload/main durable Code queue. The authenticated engine is a controlled fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'
import type { CodeQueueAction, CodeQueueDraft } from '../src/shared/code-next-turn-api'
import type { WorkQueueRead } from '../src/shared/work-next-turn-api'

const base = process.env.AETHER_QA_QUEUE_ORIGIN!, token = process.env.AETHER_QA_QUEUE_TOKEN!, profile = process.env.AETHER_QA_QUEUE_PROFILE!, model = process.env.AETHER_QA_QUEUE_MODEL!
let app: ElectronApplication, page: Page, health: ElectronHealthMonitor, serial = 0
const errors: string[] = []
async function control(body: Record<string, unknown>) {
  const response = await fetch(base + '/qa/control', { method: 'POST', headers: { 'x-aether-instance-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
}
async function audit() {
  const response = await fetch(base + '/qa/audit', { headers: { 'x-aether-instance-token': token } })
  return (await response.json()).data as { posts: { taskId: string; body: { message: string; admission: { requestKey: string } } }[]; requests: { path: string; profile: string; lifetime: string }[] }
}
async function launch() {
  const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(profile, 'global') })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY!, `--user-data-dir=${profile}`], env })
  health = await monitorElectronHealth(app, 'code-queue-' + (++serial), [token])
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  await page.evaluate(base => localStorage.setItem('aether:lastSessionId:' + encodeURIComponent('remote:' + base), 'code-owned-A'), base)
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
}
async function request(taskId: string, action: CodeQueueAction): Promise<WorkQueueRead> {
  return page.evaluate(async ({ taskId, action }) => {
    const expectedEngine = await window.aether.engine.getSnapshot()
    const result = await window.aether.codeQueue.invoke({ taskId, expectedEngine, action })
    if (!result.ok) throw new Error(result.message)
    return result.value
  }, { taskId, action })
}
async function state(taskId = 'code-owned-A') { return (await request(taskId, { kind: 'read' })).state }
const draft = (): ReturnType<Page['locator']> => page.locator('#mode-code .input-composer__input[role="textbox"]:visible').first()
// Retained chat surfaces keep hidden trays mounted. Engine readiness precedes
// the selected session's queue read, so only its visible tray is actionable.
const tray = () => page.locator('#mode-code .session-tray:visible')
const submission = (text: string): CodeQueueDraft => ({ draft: { text, mentions: [], revision: 1 }, model: { kind: 'explicit', modelId: model },
  thinking: { kind: 'on' }, resources: { skills: { kind: 'none' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'none' } }, attachments: [], code: { memoryScope: 'off' } })

test('Code queue commits UI edits, survives renderer/app restart and reconciles the original unknown admission without duplicate POST', async ({}, info) => {
  await launch()
  try {
    const delivery = page.locator('#mode-code').getByRole('button', { name: '发送方式', exact: true })
    await expect(delivery).toBeVisible()
    await delivery.click()
    await page.getByRole('menu', { name: '发送方式', exact: true }).getByRole('menuitem', { name: /^排到下一轮/ }).click()
    await expect(delivery).toContainText('排到下一轮')
    await expect(delivery).toBeFocused()
    for (const text of ['队列第一条', '队列第二条', '队列第三条']) {
      await draft().fill(text); await draft().press('Enter'); await expect(draft()).toHaveText('')
    }
    expect((await state()).entries.map(entry => entry.envelope.draft.text)).toEqual(['队列第一条', '队列第二条', '队列第三条'])
    expect((await audit()).posts).toHaveLength(0)
    await tray().getByRole('button', { name: '队列更多操作' }).click()
    await page.getByRole('menuitem', { name: /^暂停队列/ }).click()
    await expect.poll(async () => (await state()).paused).toBe(true)
    await tray().locator('.session-tray__tab--queue').click()
    await tray().getByRole('button', { name: '编辑第 1 条排队消息' }).click()
    await tray().locator('textarea').fill('修改后完整正文')
    await tray().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await state()).entries[0].envelope.draft.text).toBe('修改后完整正文')
    const before = await state()
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(tray()).toHaveCount(1)
    await expect(tray()).toContainText('已暂停')
    expect((await state()).entries).toEqual(before.entries)
    await tray().getByRole('button', { name: '队列更多操作' }).click()
    await page.getByRole('menuitem', { name: /^合并待发消息/ }).click()
    await expect.poll(async () => (await state()).entries.filter(entry => entry.phase === 'pending').length).toBe(1)
    const merged = (await state()).entries.find(entry => entry.phase === 'pending')!
    expect(merged.envelope.draft.text).toContain('修改后完整正文')
    expect(merged.envelope.draft.text).toContain('队列第二条')
    expect(merged.envelope.draft.text).toContain('队列第三条')
    await health.closeAndAssert(info); await launch()
    await expect(tray()).toHaveCount(1)
    await expect(tray()).toContainText('已暂停')
    expect((await state()).paused).toBe(true)
    expect((await state()).entries.find(entry => entry.id === merged.id)).toEqual(merged)
    expect((await audit()).posts).toHaveLength(0)
    // A background Code session loses its admission ACK; only the original frozen request may be queried.
    const current = await state('code-owned-B')
    await control({ taskId: 'code-owned-B', deny: true })
    await request('code-owned-B', { kind: 'enqueue', expectedRevision: current.revision, operationId: 'enqueue-owned-B', id: 'entry-owned-B', submission: submission('结果不明也不能重复执行') })
    await control({ taskId: 'code-owned-B', status: 'succeeded' })
    await request('code-owned-B', { kind: 'reconcile' })
    await expect.poll(async () => (await state('code-owned-B')).entries[0].phase).toBe('admission-unknown')
    const unknown = (await state('code-owned-B')).entries[0]
    expect((await audit()).posts.filter(post => post.taskId === 'code-owned-B')).toHaveLength(1)
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    expect((await state('code-owned-B')).entries[0]).toMatchObject({ id: unknown.id, phase: 'admission-unknown' })
    await control({ taskId: 'code-owned-B', deny: false })
    await request('code-owned-B', { kind: 'reconcile', retryIfAbsent: true })
    expect((await state('code-owned-B')).entries[0].phase).toBe('accepted')
    expect((await audit()).posts.filter(post => post.taskId === 'code-owned-B')).toHaveLength(1)
    // Explicit resume is the only action that releases the paused queue.
    await control({ taskId: 'code-owned-A', status: 'succeeded' })
    const paused = await state()
    await request('code-owned-A', { kind: 'mutate', expectedRevision: paused.revision, operationId: 'resume-owned-A', operation: { kind: 'resume' } })
    await expect.poll(async () => (await state()).entries.find(entry => entry.id === merged.id)?.phase).toBe('accepted')
    const final = await audit()
    expect(final.posts.filter(post => post.taskId === 'code-owned-A')).toHaveLength(1)
    expect(final.requests.filter(row => row.path === '/api/v1/chat').every(row => row.profile === 'code' && row.lifetime === 'durable')).toBe(true)
    writeFileSync(info.outputPath('durable-code-queue.json'), JSON.stringify({ first: await state(), background: await state('code-owned-B'), posts: final.posts }, null, 2))
    await page.screenshot({ path: info.outputPath('durable-code-queue.png') })
    expect(errors).toEqual([]); health.assertHealthy()
  } catch (error) {
    writeFileSync(info.outputPath('failure-details.json'), JSON.stringify({ errors, text: await page.locator('body').innerText(), queue: await state().catch(String) }, null, 2))
    await page.screenshot({ path: info.outputPath('failure.png') }); throw error
  } finally { await health.closeAndAssert(info) }
})
