/** True Electron UI/preload/IPC/React with a synthetic authenticated controller
 * service. Does not certify real engine dispatch or task/model execution. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const base = process.env.AETHER_QA_CONTROLLER_ORIGIN!, token = process.env.AETHER_QA_CONTROLLER_TOKEN!
const profile = process.env.AETHER_QA_CONTROLLER_PROFILE!, model = process.env.AETHER_QA_CONTROLLER_MODEL!
const outboxKey = 'aether.collaboration-controller-outbox.v1'
let app: ElectronApplication, page: Page, health: ElectronHealthMonitor, serial = 0
const errors: string[] = []
async function control(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(base + '/qa/control', { method: 'POST', headers: { 'x-aether-instance-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
}
interface Audit { posts: Array<{ rootRunId: string; query: { rootAttemptId: string; rootSessionId: string }; body: { recipientParticipantId: string; recipientInvocationRunId: string; message: string; requestKey: string } }>; continuations: Array<{ message: string; sessionId: string; collaborators: Array<{ resumeRunId: string }> }>; held: string[]; requests: Array<{ method: string; path: string; profile: string }> }
async function audit(): Promise<Audit> { const response = await fetch(base + '/qa/audit', { headers: { 'x-aether-instance-token': token } }); expect(response.status).toBe(200); return (await response.json()).data as Audit }
async function launch(): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(profile, 'global') }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY!, `--user-data-dir=${profile}`], env })
  health = await monitorElectronHealth(app, 'controller-window-' + (++serial), [token])
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 0); window.setContentSize(1440, 900) })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
}
async function seed(): Promise<void> {
  await page.evaluate(({ base, model }) => {
    const key = 'aether.work.state.v1:' + encodeURIComponent('remote:' + base)
    localStorage.setItem(key, JSON.stringify({ tasks: ['A', 'B'].map(name => ({ id: 'work-owned-' + name, title: '隔离任务 ' + name, draft: '', status: 'running', createdAt: 1, updatedAt: 2, workspacePath: null, modelId: model, attachments: [], sources: [] })), activeTaskId: 'work-owned-A', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: model, homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
  }, { base, model })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
}
const panel = () => page.getByRole('region', { name: '协作代理', exact: true })
const toggle = () => panel().locator('.work-subagents__followup-toggle')
const editor = () => panel().locator('.work-subagents__composer textarea')
async function openPanel(): Promise<void> {
  // Work restores its selected workspace tab across a restart.
  if (!await panel().isVisible()) await page.getByRole('button', { name: '子代理', exact: true }).click()
  await expect(panel()).toBeVisible()
}
async function child(index = 1): Promise<void> {
  const back = panel().getByRole('button', { name: '返回子代理列表', exact: true })
  if (await back.isVisible()) await back.click()
  await panel().getByRole('button', { name: `查看 协作工程师 ${index} 子代理详情`, exact: true }).click()
  await expect(toggle()).toBeVisible()
}
async function expand(): Promise<void> { if (await toggle().getAttribute('aria-expanded') !== 'true') await toggle().click(); await expect(editor()).toBeVisible() }
async function send(text: string): Promise<void> {
  await expand(); await editor().fill(text); const button = panel().getByRole('button', { name: '发送补充要求', exact: true }); await expect(button).toBeEnabled(); await button.click()
}
async function journal(): Promise<Array<{ requestKey: string; message: string; recipientInvocationRunId: string; expectedEngine: { instanceId: string } }>> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), outboxKey)
}
async function setAppearance(value: 'light' | 'dark'): Promise<void> {
  // The main settings bridge persists values but does not update AppProvider's
  // React state. Reload reads the persisted setting through the real provider.
  await page.evaluate(async appearance => window.aether.settings.update({ appearance }), value)
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('html')).toHaveAttribute('data-appearance', value)
}
const codeForm = () => page.locator('.chat .subagent-card').first().getByRole('region', { name: '补充要求给 协作工程师 1', exact: true })
async function openCode(): Promise<void> {
  await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
  const group = page.locator('.chat .subagent-group__head').first()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await expect(codeForm()).toBeVisible()
  const disclosure = codeForm().locator('.subagent-followup__toggle')
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
}
async function verifyCode(info: TestInfo): Promise<void> {
  await openCode()
  const codeEditor = () => codeForm().locator('textarea'), count = (await audit()).posts.length
  const runId = await page.locator('.chat .subagent-card').first().getAttribute('data-run-id')
  await codeEditor().fill('Code 同一个活跃代理直接补充')
  await expect(codeForm().getByRole('button', { name: '发送补充要求', exact: true })).toBeEnabled()
  await control({ mode: 'accepted' }); await codeEditor().press('Control+Enter')
  await expect(codeForm().getByRole('status')).toContainText('补充要求已排队；可查看此代理的后续进展')
  await expect(codeEditor()).toHaveValue('')
  const post = (await audit()).posts.at(-1)!
  expect(post.body.recipientInvocationRunId).toBe(runId)
  expect(post.body.message).toBe('Code 同一个活跃代理直接补充')
  expect((await audit()).posts).toHaveLength(count + 1)
  expect((await audit()).requests.filter(item => item.method === 'POST' && item.path.endsWith('/messages')).at(-1)?.profile).toBe('code')
  for (const [width, height, appearance] of [[1440, 900, 'light'], [940, 680, 'dark'], [760, 520, 'light']] as const) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
    await setAppearance(appearance); await openCode()
    await codeEditor().fill('Code 缩放保留草稿'); await codeEditor().scrollIntoViewIfNeeded()
    await expect(codeEditor()).toBeInViewport({ ratio: 1 })
    await codeForm().getByRole('button', { name: '发送补充要求', exact: true }).scrollIntoViewIfNeeded()
    await expect(codeForm().getByRole('button', { name: '发送补充要求', exact: true })).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
    await codeEditor().press('Escape'); await expect(codeForm().locator('.subagent-followup__toggle')).toBeFocused()
    await page.keyboard.press('Enter'); await expect(codeEditor()).toHaveValue('Code 缩放保留草稿')
    await page.screenshot({ path: info.outputPath(`code-controller-${width}-${height}-${appearance}.png`) })
  }
  await control({ mode: 'reject' }); await codeEditor().fill('Code 拒绝保留原文'); await codeForm().getByRole('button', { name: '发送补充要求', exact: true }).click()
  await expect(codeForm().getByRole('alert')).toContainText('Owned fixture rejected'); await expect(codeEditor()).toHaveValue('Code 拒绝保留原文')
  await codeEditor().press('Escape'); await expect(codeForm().getByRole('alert')).toBeVisible()
  await codeForm().locator('.subagent-followup__toggle').click()
  await control({ mode: 'unknown' }); await codeEditor().fill('Code 本轮结束但尚未读取的原要求'); await codeForm().getByRole('button', { name: '发送补充要求', exact: true }).click()
  await expect(codeEditor()).toHaveAttribute('readonly', ''); await expect.poll(async () => (await journal()).length).toBe(1)
  const unresolved = (await journal())[0], beforeRestart = (await audit()).posts.length
  await health.closeAndAssert(info); await launch(); await openCode()
  await expect(codeEditor()).toHaveValue(unresolved.message); await expect(codeEditor()).toHaveAttribute('readonly', '')
  await control({ acceptKey: unresolved.requestKey, receiptState: 'interrupted' })
  await codeForm().getByRole('button', { name: '核对排队结果', exact: true }).click()
  await expect(codeForm().getByRole('status')).toContainText('此代理本轮已结束，补充要求未读取；原文已保留')
  await expect.poll(async () => (await journal()).length).toBe(0)
  await expect(codeEditor()).not.toHaveAttribute('readonly', '')
  await expect(codeEditor()).toHaveValue(unresolved.message)
  expect((await audit()).posts).toHaveLength(beforeRestart)
  await health.closeAndAssert(info); await launch(); await openCode()
  await expect(codeEditor()).toHaveValue(unresolved.message); await expect(codeEditor()).not.toHaveAttribute('readonly', '')
  await expect(codeForm().getByRole('status')).toContainText('已恢复原文草稿；不会自动重发')
  expect((await audit()).posts).toHaveLength(beforeRestart)
  await codeForm().getByRole('button', { name: '清除已结束的草稿', exact: true }).click(); await expect(codeEditor()).toHaveValue('')
  expect((await audit()).posts).toHaveLength(beforeRestart)
  await control({ mode: 'unknown' }); await codeEditor().fill('明确移除仅限本地跟踪的原文'); await codeForm().getByRole('button', { name: '发送补充要求', exact: true }).click()
  await expect(codeEditor()).toHaveAttribute('readonly', ''); const beforeForget = (await audit()).posts.length
  await codeForm().getByText('移除本地跟踪记录', { exact: true }).click()
  await expect(codeForm().getByText(/不会取消原请求，也不会重新发送/)).toBeVisible()
  await codeForm().getByRole('button', { name: '复制原文', exact: true }).click()
  await expect(codeForm().getByRole('status').filter({ hasText: '原文已复制' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('明确移除仅限本地跟踪的原文')
  await codeForm().getByRole('button', { name: '确认移除本地记录', exact: true }).click()
  await expect.poll(async () => (await journal()).length).toBe(0); await expect(codeEditor()).toHaveValue('明确移除仅限本地跟踪的原文')
  await expect(codeForm().getByRole('status')).toContainText('原请求未被取消，也没有重发')
  expect((await audit()).posts).toHaveLength(beforeForget)
  expect((await audit()).requests.filter(item => item.method === 'POST' && item.path === '/api/v1/chat')).toHaveLength(0)
}

async function verifyModernCode(info: TestInfo): Promise<void> {
  await health.closeAndAssert(info); await control({ modern: true, mode: 'accepted' }); await launch()
  const reveal = async (): Promise<void> => {
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    const group = page.locator('.chat .subagent-group__head').first()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await expect(page.locator('.chat .subagent-card--published')).toHaveCount(2)
  }
  await reveal()
  const current = () => page.getByRole('region', { name: '当前代理 协作工程师 1', exact: true })
  const form = () => current().getByRole('region', { name: '补充要求给 协作工程师 1', exact: true })
  const historical = () => page.locator('.chat .subagent-card').first()
  const before = (await audit()).posts.length
  await expect(historical()).toHaveAttribute('data-published-seq', '4')
  await current().getByRole('button', { name: '查看当前代理', exact: true }).click()
  await expect(current()).toContainText('当前代理 · 正在运行')
  await form().locator('.subagent-followup__toggle').click(); await form().locator('textarea').fill('现代恢复仍补充给原exact invocation')
  await expect(form().getByRole('button', { name: '发送补充要求', exact: true })).toBeEnabled()
  await form().getByRole('button', { name: '发送补充要求', exact: true }).click(); await expect(form().getByRole('status')).toContainText('补充要求已排队')
  const posted = (await audit()).posts.at(-1)!
  expect(posted.body.recipientInvocationRunId).toBe('child-run-' + posted.query.rootSessionId + '-1'); expect((await audit()).posts).toHaveLength(before + 1)
  await expect(historical()).toHaveAttribute('data-published-seq', '4'); await expect(page.locator('.chat .subagent-card--published')).toHaveCount(2)
  await historical().getByRole('button', { name: '查看 协作工程师 1 的已发布记录', exact: true }).click()
  await expect(historical()).toContainText('已发布固定正文 #4'); await expect(historical()).toHaveAttribute('data-published-seq', '4')
  await expect(historical()).not.toContainText('当前可变正文 #9')
  expect((await audit()).requests.filter(item => item.path.endsWith('/' + posted.body.recipientInvocationRunId)).length).toBeGreaterThanOrEqual(2)
  await control({ wrongInvocation: true }); await form().locator('textarea').fill('现代引用过期不得转发新invocation')
  await form().getByRole('button', { name: '发送补充要求', exact: true }).click()
  await expect(form().getByRole('alert')).toContainText('切换工作轮次'); await expect(form().locator('textarea')).toHaveValue('现代引用过期不得转发新invocation')
  expect((await audit()).posts).toHaveLength(before + 1); await expect.poll(async () => (await journal()).length).toBe(0)
  await control({ wrongInvocation: false }); await page.screenshot({ path: info.outputPath('modern-published-current-separate.png') })
  await health.closeAndAssert(info); await launch(); await reveal()
  await expect(historical()).toHaveAttribute('data-published-seq', '4')
  await current().getByRole('button', { name: '查看当前代理', exact: true }).click(); await expect(form()).toBeVisible()
  await form().locator('.subagent-followup__toggle').click(); await form().locator('textarea').fill('现代恢复第二次重启后仍可补充')
  await expect(form().getByRole('button', { name: '发送补充要求', exact: true })).toBeEnabled()
  await form().getByRole('button', { name: '发送补充要求', exact: true }).click(); await expect(form().getByRole('status')).toContainText('补充要求已排队')
  expect((await audit()).posts).toHaveLength(before + 2); await expect(historical()).toHaveAttribute('data-published-seq', '4')
}
async function verifyKnownHistory(info: TestInfo): Promise<void> {
  await health.closeAndAssert(info); await control({ modern: false, mode: 'accepted' }); await launch()
  for (const mode of ['Work', 'Code'] as const) {
    const open = async (): Promise<void> => {
      if (mode === 'Work') { await page.getByRole('tab', { name: 'Work 办公', exact: true }).click(); await openPanel(); await child(1); await expand() }
      else await openCode()
    }
    await open()
    const host = () => mode === 'Work' ? panel() : codeForm()
    const input = () => mode === 'Work' ? editor() : codeForm().locator('textarea')
    const history = () => host().locator('.subagent-receipt-history')
    const revealHistory = async (key: string): Promise<ReturnType<Page['locator']>> => {
      if (!await history().evaluate(element => (element as HTMLDetailsElement).open)) await history().locator('> summary').click()
      const record = history().locator(`article[data-request-key="${key}"]`)
      const details = record.locator('details')
      if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('> summary').click()
      return record
    }
    const text = `${mode} 已接纳原要求重启后仍可查询终态`
    await control({ mode: 'accepted' }); await input().fill(text); await host().getByRole('button', { name: '发送补充要求', exact: true }).click()
    await expect(input()).toHaveValue(''); await expect.poll(async () => (await journal()).length).toBe(0)
    const sent = (await audit()).posts.at(-1)!, before = (await audit()).posts.length
    await health.closeAndAssert(info); await launch(); await open()
    const record = await revealHistory(sent.body.requestKey)
    await expect(record).toContainText('已接纳（不代表已执行）'); await expect(record.locator('pre')).toHaveText(text)
    await control({ acceptKey: sent.body.requestKey, receiptState: 'interrupted' })
    await record.getByRole('button', { name: '查询原回执', exact: true }).click()
    await expect(record).toContainText('本轮结束前未读取，原文已保留'); await expect(input()).toHaveValue(text)
    expect((await audit()).posts).toHaveLength(before)
    if (mode === 'Work') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 520))
      await record.getByRole('button', { name: '复制原文', exact: true }).scrollIntoViewIfNeeded()
      await expect(record.getByRole('button', { name: '复制原文', exact: true })).toBeInViewport({ ratio: 1 })
      expect(await panel().locator('.work-subagents__detail').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(100)
      await page.screenshot({ path: info.outputPath('work-known-history-760-520.png') })
    }
    await record.getByRole('button', { name: '复制原文', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text)
    await health.closeAndAssert(info); await launch(); await open()
    await expect(input()).toHaveValue(text)
    const restoredRecord = await revealHistory(sent.body.requestKey)
    await expect(restoredRecord).toContainText('本轮结束前未读取')
    await restoredRecord.getByRole('button', { name: '移除此本地记录', exact: true }).click()
    await restoredRecord.getByRole('button', { name: '确认移除记录', exact: true }).click(); await expect(restoredRecord).toHaveCount(0)
    expect((await audit()).posts).toHaveLength(before)
    const refusal = `${mode} 明确拒绝原文重启后保留`
    await control({ mode: 'reject' }); await input().fill(refusal); await host().getByRole('button', { name: '发送补充要求', exact: true }).click()
    await expect(host().getByRole('alert')).toContainText('Owned fixture rejected'); await expect.poll(async () => (await journal()).length).toBe(0)
    const refusedKey = (await audit()).posts.at(-1)!.body.requestKey, afterRefusal = (await audit()).posts.length
    await health.closeAndAssert(info); await launch(); await open()
    await expect(input()).toHaveValue(refusal)
    const rejectedRecord = await revealHistory(refusedKey)
    await expect(rejectedRecord).toContainText('未被接纳，原文已保留'); await expect(rejectedRecord.locator('pre')).toHaveText(refusal)
    await expect(rejectedRecord.getByRole('button', { name: '查询原回执', exact: true })).toHaveCount(0)
    await host().getByRole('button', { name: '清除已结束的草稿', exact: true }).click(); await expect(input()).toHaveValue('')
    await expect(rejectedRecord.locator('pre')).toHaveText(refusal)
    expect((await audit()).posts).toHaveLength(afterRefusal)
  }
  // Prove a restored visible Work draft reaches the continuation transport
  // without requiring a keystroke. The synthetic gateway deliberately refuses
  // /chat, so this covers the UI request boundary, not engine continuation.
  await control({ mode: 'reject' }); await page.getByRole('tab', { name: 'Work 办公', exact: true }).click(); await openPanel(); await child(1); await expand()
  const continuationText = 'Work 恢复后无需编辑直接继续的原文'
  await editor().fill(continuationText); await panel().getByRole('button', { name: '发送补充要求', exact: true }).click()
  await expect(panel().getByRole('alert')).toContainText('Owned fixture rejected'); await expect.poll(async () => (await journal()).length).toBe(0)
  await health.closeAndAssert(info); await control({ childTerminal: true, rootTerminal: true }); await launch(); await openPanel(); await child(1); await expand()
  await expect(editor()).toHaveValue(continuationText)
  await expect(panel().getByRole('button', { name: '继续执行', exact: true })).toBeEnabled()
  await panel().getByRole('button', { name: '继续执行', exact: true }).click()
  await expect.poll(async () => (await audit()).continuations.length).toBe(1)
  expect((await audit()).continuations[0]).toMatchObject({ message: continuationText, sessionId: 'work-owned-A', collaborators: [{ resumeRunId: 'child-run-work-owned-A-1' }] })
}
async function layout(info: TestInfo, width: number, height: number, appearance: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
  await setAppearance(appearance); await page.getByRole('tab', { name: 'Work 办公', exact: true }).click(); await openPanel(); await child()
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
  await expect(toggle()).toBeInViewport({ ratio: 1 }); await expand()
  await editor().fill('窗口调整仍保留的补充草稿'); await expect(editor()).toBeInViewport({ ratio: 1 })
  await expect(panel().getByRole('button', { name: '发送补充要求', exact: true })).toBeInViewport({ ratio: 1 })
  const observation = await panel().evaluate(element => {
    const area = element.getBoundingClientRect(), form = element.querySelector<HTMLElement>('.work-subagents__composer')!, scroll = element.querySelector<HTMLElement>('.work-subagents__detail')!
    return { panel: area.toJSON(), form: form.getBoundingClientRect().toJSON(), bodyHeight: scroll.clientHeight, bodyWidth: scroll.clientWidth, bodyScrollWidth: scroll.scrollWidth, documentWidth: document.documentElement.clientWidth, documentScrollWidth: document.documentElement.scrollWidth }
  })
  expect(observation.panel.x).toBeGreaterThanOrEqual(0); expect(observation.panel.right).toBeLessThanOrEqual(width + 1)
  expect(observation.panel.bottom).toBeLessThanOrEqual(height + 1); expect(observation.form.bottom).toBeLessThanOrEqual(height + 1)
  expect(observation.bodyHeight).toBeGreaterThanOrEqual(100); expect(observation.bodyScrollWidth).toBeLessThanOrEqual(observation.bodyWidth + 1)
  expect(observation.documentScrollWidth).toBeLessThanOrEqual(observation.documentWidth + 1)
  await editor().press('Escape'); await expect(toggle()).toBeFocused(); await expect(editor()).toBeHidden()
  await page.keyboard.press('Enter'); await expect(editor()).toBeVisible(); await expect(editor()).toHaveValue('窗口调整仍保留的补充草稿')
  await editor().fill(''); await page.screenshot({ path: info.outputPath(`controller-${width}-${height}-${appearance}.png`) })
  writeFileSync(info.outputPath(`controller-${width}-${height}-${appearance}.json`), JSON.stringify(observation, null, 2))
}

test('live child supplement: exact invocation, queued feedback, failures, selection, recovery and viewports', async ({}, info) => {
  await launch()
  try {
    await seed(); await openPanel(); await child()
    await expand(); await editor().fill('同一个子代理补充要求：保留标点 "A" 和换行\n第二行')
    await expect(panel().getByRole('button', { name: '发送补充要求', exact: true })).toBeEnabled()
    await editor().press('Control+Enter')
    await expect(panel().getByRole('status').filter({ hasText: '补充要求已排队；可查看此代理的后续进展' })).toBeVisible()
    await expect(editor()).toHaveValue('')
    const first = (await audit()).posts
    expect(first).toHaveLength(1); expect(first[0].rootRunId).toBe('root-work-owned-A')
    expect(first[0].query).toEqual({ rootAttemptId: 'attempt-work-owned-A', rootSessionId: 'work-owned-A' })
    expect(first[0].body).toMatchObject({ recipientParticipantId: 'child:child-context-work-owned-A-1', recipientInvocationRunId: 'child-run-work-owned-A-1', message: '同一个子代理补充要求：保留标点 "A" 和换行\n第二行' })
    expect((await audit()).requests.filter(item => item.method === 'POST' && item.path === '/api/v1/chat')).toHaveLength(0)
    await control({ holdContext: true }); await send('选择切换时必须保留的草稿')
    await expect.poll(async () => (await audit()).held.length).toBe(1)
    await child(2); await expand(); await editor().fill('第二个代理独立草稿'); await control({ release: true })
    await expect(editor()).toHaveValue('第二个代理独立草稿'); await child(1); await expand(); await expect(editor()).toHaveValue('选择切换时必须保留的草稿')
    expect((await audit()).posts).toHaveLength(1); expect(await journal()).toEqual([])
    await control({ mode: 'reject' }); await send('拒绝后保留原文')
    await expect(panel().getByRole('alert')).toContainText('Owned fixture rejected'); await expect(editor()).toHaveValue('拒绝后保留原文')
    await editor().press('Escape'); await expect(panel().getByRole('alert')).toBeVisible(); await expand()
    await control({ mode: 'accepted' }); await send('拒绝后修正并重新提交')
    await expect(editor()).toHaveValue(''); expect((await audit()).posts).toHaveLength(3)
    for (const [width, height, appearance] of [[1440, 900, 'dark'], [940, 680, 'light'], [760, 520, 'dark']] as const) await layout(info, width, height, appearance)
    await control({ mode: 'unknown' }); await send('重启后必须核对原 key 的要求')
    await expect(panel().getByRole('button', { name: '核对排队结果', exact: true })).toBeVisible()
    await expect(editor()).toHaveAttribute('readonly', '')
    const saved = (await journal())[0]; expect(saved.message).toBe('重启后必须核对原 key 的要求'); expect(saved.recipientInvocationRunId).toBe('child-run-work-owned-A-1')
    await health.closeAndAssert(info); await launch(); await openPanel(); await child(1); await expand()
    await expect(editor()).toHaveValue(saved.message); expect((await audit()).posts).toHaveLength(4)
    await panel().getByRole('button', { name: '核对排队结果', exact: true }).click()
    await expect(panel().getByRole('button', { name: '重试原请求', exact: true })).toBeVisible()
    await control({ mode: 'accepted' }); await panel().getByRole('button', { name: '重试原请求', exact: true }).click()
    await expect.poll(async () => (await journal()).length).toBe(0)
    const retried = (await audit()).posts.at(-1)!; expect(retried.body.requestKey).toBe(saved.requestKey); expect(retried.body.message).toBe(saved.message)
    await control({ mode: 'malformed' }); await send('正文 hash 不符时保留并核对')
    await expect(panel().getByRole('alert')).toContainText('正文校验不符'); await expect(editor()).toHaveValue('正文 hash 不符时保留并核对')
    await panel().getByRole('button', { name: '核对排队结果', exact: true }).click(); await expect.poll(async () => (await journal()).length).toBe(0)
    await control({ capability: false }); await panel().getByRole('button', { name: '刷新子代理状态', exact: true }).click(); await editor().fill('能力未启用不能发送')
    await expect(panel().getByRole('button', { name: '发送补充要求', exact: true })).toBeDisabled()
    await control({ capability: true }); await panel().getByRole('button', { name: '刷新子代理状态', exact: true }).click()
    await control({ mode: 'unknown' }); await send('实例切换后只能核对不能重发')
    await expect(editor()).toHaveAttribute('readonly', '')
    await expect.poll(async () => (await journal()).length).toBe(1)
    const unresolved = (await journal())[0], postsBeforeRestart = (await audit()).posts.length
    await health.closeAndAssert(info); await control({ instanceId: 'new-owned-controller-instance' }); await launch(); await openPanel(); await child(1); await expand()
    await expect(editor()).toHaveValue(unresolved.message); await expect(panel().locator('.work-subagents__followup-notice')).toContainText('实例已变化')
    await panel().getByRole('button', { name: '核对排队结果', exact: true }).click()
    await expect(panel().getByRole('button', { name: '重试原请求', exact: true })).toHaveCount(0); expect((await audit()).posts).toHaveLength(postsBeforeRestart)
    const stale = await page.evaluate(async () => { const expectedEngine = await window.aether.engine.getSnapshot(); return window.aether.engine.request({ method: 'GET', path: '/collaboration/capabilities', expectedEngine: { ...expectedEngine, accountId: 'other-account' } }) })
    expect(stale.ok).toBe(false); expect(stale.code).toBe(409)
    await control({ acceptKey: unresolved.requestKey }); await panel().getByRole('button', { name: '核对排队结果', exact: true }).click(); await expect.poll(async () => (await journal()).length).toBe(0)
    await control({ mode: 'unknown' }); await send('Work 重启后终态回执必须恢复原文')
    await expect(editor()).toHaveAttribute('readonly', ''); await expect.poll(async () => (await journal()).length).toBe(1)
    const interrupted = (await journal())[0], beforeInterrupted = (await audit()).posts.length
    await health.closeAndAssert(info); await launch(); await openPanel(); await child(1); await expand()
    await control({ acceptKey: interrupted.requestKey, receiptState: 'interrupted' })
    await panel().getByRole('button', { name: '核对排队结果', exact: true }).click()
    await expect(panel().getByRole('status').filter({ hasText: '补充要求未读取' })).toContainText('此代理本轮已结束')
    await expect(editor()).not.toHaveAttribute('readonly', ''); await expect(editor()).toHaveValue(interrupted.message)
    expect((await audit()).posts).toHaveLength(beforeInterrupted); await expect.poll(async () => (await journal()).length).toBe(0)
    await health.closeAndAssert(info); await launch(); await openPanel(); await child(1); await expand()
    await expect(editor()).toHaveValue(interrupted.message); await expect(editor()).not.toHaveAttribute('readonly', '')
    await expect(panel().getByRole('status').filter({ hasText: '已恢复原文草稿；不会自动重发' })).toBeVisible()
    expect((await audit()).posts).toHaveLength(beforeInterrupted)
    await panel().getByRole('button', { name: '清除已结束的草稿', exact: true }).click(); await expect(editor()).toHaveValue('')
    await verifyCode(info)
    await verifyModernCode(info)
    await verifyKnownHistory(info)
    expect(errors).toEqual([]); health.assertHealthy()
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure.png') })
    writeFileSync(info.outputPath('failure-details.json'), JSON.stringify({ errors, body: await page.locator('body').innerText(), journal: await journal(), audit: await audit() }, null, 2)); throw error
  } finally { await health?.closeAndAssert(info) }
})
