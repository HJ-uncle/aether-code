/** Real Electron/React/IPC: root delivery, durable queue separation, compact
 * feedback, keyboard menus and stable composer geometry in both themes/modes.
 * Model consumption is verified separately with the production engine. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const base = process.env.AETHER_QA_CONTROLLER_ORIGIN!, token = process.env.AETHER_QA_CONTROLLER_TOKEN!
const profile = process.env.AETHER_QA_CONTROLLER_PROFILE!, model = process.env.AETHER_QA_CONTROLLER_MODEL!
let app: ElectronApplication, page: Page, health: ElectronHealthMonitor
const pageErrors: string[] = []
interface Audit { posts: Array<{ rootRunId: string; query: { rootAttemptId: string; rootSessionId: string }; body: { recipientParticipantId: string; recipientInvocationRunId: string; message: string; requestKey: string } }>; continuations: unknown[]; held: string[]; requests: Array<{ method: string; path: string; profile: string }> }
async function control(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(base + '/qa/control', { method: 'POST', headers: { 'x-aether-instance-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
}
async function audit(): Promise<Audit> { const response = await fetch(base + '/qa/audit', { headers: { 'x-aether-instance-token': token } }); expect(response.status).toBe(200); return (await response.json()).data as Audit }
async function expectDraftSaved(mode: 'Work' | 'Code', text: string): Promise<void> {
  // Code edits are debounced for 400 ms. Read the actual scoped storage slot,
  // rather than reloading as soon as the contenteditable has painted its text.
  await expect.poll(() => page.evaluate(({ base, mode }) => {
    const source = encodeURIComponent('remote:' + base.replace(/\/+$/, ''))
    if (mode === 'Work') {
      const state = JSON.parse(localStorage.getItem('aether.work.state.v1:' + source) ?? '{}') as { tasks?: Array<{ id: string; draft: string }> }
      return state.tasks?.find(task => task.id === 'work-root-followup')?.draft ?? null
    }
    const sessionId = localStorage.getItem('aether:lastSessionId:' + source)
    if (!sessionId) return null
    const drafts = JSON.parse(localStorage.getItem('aether:chatDrafts:' + source) ?? '{}') as Record<string, { text: string } | string>
    const draft = drafts[sessionId]
    return typeof draft === 'string' ? draft : draft?.text ?? null
  }, { base, mode }), { message: `${mode} draft must be persisted before theme reload` }).toBe(text)
}
async function load(mode: 'Work' | 'Code'): Promise<void> {
  await control({ rootTerminal: false, mode: 'accepted' })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  await page.getByRole('tab', { name: mode === 'Work' ? 'Work 办公' : 'Code 开发', exact: true }).click()
  await expect(deliveryTrigger(mode)).toContainText('立即补充')
}
const surface = (mode: 'Work' | 'Code') => page.locator(mode === 'Work' ? '#mode-work' : '#mode-code')
const editor = (mode: 'Work' | 'Code') => surface(mode).locator('.input-composer__input[role="textbox"]:visible').first()
const send = (mode: 'Work' | 'Code') => surface(mode).getByRole('button', { name: '立即补充', exact: true })
// Retained sessions keep their now-permanent footer mounted while hidden.
const feedback = (mode: 'Work' | 'Code') => surface(mode).locator('[aria-label="当前任务补充状态"]:visible')
const deliveryTrigger = (mode: 'Work' | 'Code') => surface(mode).getByRole('button', { name: '发送方式', exact: true })
const deliveryMenu = () => page.getByRole('menu', { name: '发送方式', exact: true })
const detailsPanel = () => page.getByRole('dialog', { name: '补充详情', exact: true })
async function expectNoHistoryPopover(mode: 'Work' | 'Code'): Promise<void> {
  await expect(feedback(mode).getByRole('button', { name: /^补充记录/ })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '补充记录', exact: true })).toHaveCount(0)
}
async function expectNoRecoveryEntry(mode: 'Work' | 'Code'): Promise<void> {
  await expectNoHistoryPopover(mode)
  await expect(feedback(mode).getByRole('button', { name: '查看详情', exact: true })).toHaveCount(0)
  await expect(feedback(mode).getByRole('button', { name: '核对补充', exact: true })).toHaveCount(0)
  await expect(detailsPanel()).toHaveCount(0)
}
async function openDetails(mode: 'Work' | 'Code', pending = false): Promise<void> {
  await feedback(mode).getByRole('button', { name: pending ? '核对补充' : '查看详情', exact: true }).click()
  await expect(detailsPanel()).toBeVisible()
  await expect(detailsPanel()).toBeInViewport({ ratio: 1 })
  await expect(detailsPanel().getByRole('button', { name: '关闭补充详情', exact: true })).toBeFocused()
}
async function chooseDelivery(mode: 'Work' | 'Code', value: 'current' | 'next'): Promise<void> {
  const label = value === 'current' ? '立即补充' : '排到下一轮'
  await deliveryTrigger(mode).click()
  await expect(deliveryMenu()).toBeVisible()
  await deliveryMenu().getByRole('menuitem', { name: new RegExp('^' + label) }).click()
  await expect(deliveryMenu()).toHaveCount(0)
  await expect(deliveryTrigger(mode)).toContainText(label)
  await expect(deliveryTrigger(mode)).toBeFocused()
}

interface ComposerGeometry {
  card: { y: number; height: number }; editor: { y: number; height: number }
  toolbar: { y: number; height: number }; footer: { y: number; height: number }
}
async function composerGeometry(mode: 'Work' | 'Code'): Promise<ComposerGeometry> {
  // Layout after a state transition must have reached Chromium's painted tree.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const card = surface(mode).locator('.input-composer:visible').first()
  const footer = feedback(mode)
  await expect(footer).toBeVisible()
  expect(await footer.evaluate(element => element.closest('.input-composer') === null), 'feedback belongs outside the input card').toBe(true)
  expect(await card.evaluate(element => element.nextElementSibling?.getAttribute('aria-label')), 'feedback directly follows the input card').toBe('当前任务补充状态')
  const rect = async (locator: ReturnType<Page['locator']>) => {
    const box = await locator.boundingBox()
    if (!box) throw new Error('Missing visible composer geometry')
    return { y: box.y, height: box.height }
  }
  const geometry = {
    card: await rect(card), editor: await rect(editor(mode)),
    toolbar: await rect(card.locator('.input-composer__toolbar')), footer: await rect(footer),
  }
  expect(geometry.footer.y).toBeGreaterThanOrEqual(geometry.card.y + geometry.card.height - 1)
  expect(geometry.footer.height).toBeGreaterThanOrEqual(27)
  expect(geometry.footer.height).toBeLessThanOrEqual(29)
  return geometry
}
async function expectStableComposer(mode: 'Work' | 'Code', before: ComposerGeometry): Promise<void> {
  const after = await composerGeometry(mode)
  for (const part of ['card', 'editor', 'toolbar', 'footer'] as const) {
    expect(Math.abs(after[part].height - before[part].height), `${mode} ${part} height`).toBeLessThanOrEqual(1)
    expect(Math.abs(after[part].y - before[part].y), `${mode} ${part} vertical position`).toBeLessThanOrEqual(1)
  }
}

async function toolbarGeometry(mode: 'Work' | 'Code'): Promise<{ controls: Array<{ name: string; x: number; right: number; width: number }>; problems: string[] }> {
  return surface(mode).locator('.input-composer__toolbar:visible').first().evaluate(toolbar => {
    const bounds = toolbar.getBoundingClientRect(), problems: string[] = []
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>('button, select')).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const rect = element.getBoundingClientRect(), name = element.getAttribute('aria-label') || element.title || element.textContent || element.tagName
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) problems.push(`${name}: outside toolbar`)
      for (const span of element.querySelectorAll<HTMLElement>(name === '发送方式' ? '.select__value' : '.select__compact-value')) {
        if (!span.getClientRects().length) continue
        const range = document.createRange(); range.selectNodeContents(span); const text = range.getBoundingClientRect(), label = span.getBoundingClientRect()
        if (text.left < label.left - 1 || text.right > label.right + 1 || text.left < rect.left - 1 || text.right > rect.right + 1) problems.push(`${name}: visible text clipped`)
        const caret = element.querySelector('.select__caret')?.getBoundingClientRect()
        if (caret && name === '发送方式' && text.right > caret.left + 1) problems.push(`${name}: selected label overlaps caret`)
      }
      return { name, x: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom }
    })
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j]
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) problems.push(`${a.name} overlaps ${b.name}`)
    }
    return { controls, problems }
  })
}

test('Work and Code supplement the same root, preserve drafts and isolate next-turn/unknown/stop boundaries', async ({}, info) => {
  const env = Object.fromEntries(Object.entries({ ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(profile, 'global') }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY!, `--user-data-dir=${profile}`], env })
  health = await monitorElectronHealth(app, 'root-followup', [token]); page = await app.firstWindow()
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  page.on('pageerror', error => pageErrors.push(error.message))
  try {
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.evaluate(({ base, model }) => {
      const key = 'aether.work.state.v1:' + encodeURIComponent('remote:' + base)
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: 'work-root-followup', title: '运行中补充验收', draft: '', status: 'running', createdAt: 1, updatedAt: 2, workspacePath: null, modelId: model, attachments: [], sources: [] }], activeTaskId: 'work-root-followup', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: model, homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, { base, model })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 0); window.setContentSize(1440, 900) })
    for (const mode of ['Work', 'Code'] as const) {
      await control({ holdCapability: true })
      await load(mode)
      await editor(mode).fill('')
      const initialGeometry = await composerGeometry(mode)
      await chooseDelivery(mode, 'next')
      await expect(feedback(mode).getByRole('status')).toContainText('Enter 排到下一轮')
      await expectStableComposer(mode, initialGeometry)
      await chooseDelivery(mode, 'current')
      await expectStableComposer(mode, initialGeometry)
      let before = (await audit()).posts.length
      await editor(mode).fill(`${mode} 立即补充原任务`)
      await expect(send(mode)).toBeEnabled(); await editor(mode).press('Enter')
      await expect(surface(mode).getByRole('button', { name: '正在提交补充…', exact: true })).toBeVisible()
      await expect(editor(mode)).toHaveText(`${mode} 立即补充原任务`)
      expect((await audit()).posts).toHaveLength(before)
      await control({ release: true })
      await expect(feedback(mode).getByRole('status')).toContainText('已接纳，将在下一次模型调用前读取')
      await expect(editor(mode)).toHaveText('')
      await expectStableComposer(mode, initialGeometry)
      let post = (await audit()).posts.at(-1)!
      expect((await audit()).posts).toHaveLength(before + 1)
      expect(post.body.recipientParticipantId).toBe('root')
      expect(post.body.recipientInvocationRunId).toBe(post.rootRunId)
      expect(post.query.rootAttemptId).toContain('attempt-' + post.query.rootSessionId)
      expect((await audit()).requests.filter(item => item.method === 'POST' && item.path.endsWith('/messages')).at(-1)?.profile).toBe(mode === 'Work' ? 'general' : 'code')
      // Successful supplements live in the conversation. Their durable receipts
      // remain available to recovery without adding a second history surface.
      const longFollowup = `${mode} 长补充：${'保留原需求，检查交互、恢复状态与准确反馈。'.repeat(35)}`
      for (let index = 0; index < 4; index++) {
        await editor(mode).fill(`${longFollowup} ${index}`)
        await expect(send(mode)).toBeEnabled(); await send(mode).click()
        await expect(editor(mode)).toHaveText('')
      }
      await expectNoRecoveryEntry(mode)
      await expectStableComposer(mode, initialGeometry)
      const acceptedPosts = (await audit()).posts.slice(-5)
      const latestKey = acceptedPosts.at(-1)!.body.requestKey
      await expect.poll(() => page.evaluate(keys => {
        const records = JSON.parse(localStorage.getItem('aether.collaboration-controller-results.v1') ?? '[]') as Array<{ requestKey: string; kind: string }>
        return keys.every(key => records.some(record => record.requestKey === key && record.kind === 'accepted'))
      }, acceptedPosts.map(item => item.body.requestKey))).toBe(true)
      await control({ integrateKey: latestKey })
      await expect(feedback(mode).getByRole('status')).toContainText('已加入上下文')
      await expectNoRecoveryEntry(mode)
      await editor(mode).fill('保留这个新草稿')
      await expect(editor(mode)).toHaveText('保留这个新草稿')
      await expectDraftSaved(mode, '保留这个新草稿')
      await editor(mode).fill('')
      await expectDraftSaved(mode, '')
      for (const width of [1440, 940]) for (const appearance of ['dark', 'light'] as const) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width)
        await page.evaluate(async appearance => { await window.aether.settings.update({ appearance }) }, appearance)
        // Settings IPC persists appearance; the actual provider reads it on reload.
        await load(mode)
        await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
        await expect(editor(mode)).toHaveText('')
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await editor(mode).scrollIntoViewIfNeeded()
        await expect(deliveryTrigger(mode)).toBeInViewport({ ratio: 1 })
        expect(await surface(mode).locator('.input-composer:visible').first().evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true)
        const layout = await composerGeometry(mode)
        // Arrow navigation uses the real portalled menu; Escape returns focus
        // without changing the value or moving the editor/feedback surface.
        await deliveryTrigger(mode).focus()
        await page.keyboard.press('ArrowDown')
        await expect(deliveryMenu()).toBeVisible()
        await expect(deliveryMenu().getByRole('menuitem', { name: /^立即补充/ })).toBeFocused()
        await expect(deliveryMenu().locator('.select__item-desc')).toHaveCount(2)
        await expect(deliveryMenu()).toBeInViewport({ ratio: 1 })
        await expectStableComposer(mode, layout)
        await page.screenshot({ path: info.outputPath(`${mode}-delivery-menu-${width}-${appearance}.png`) })
        await page.keyboard.press('Escape')
        await expect(deliveryMenu()).toHaveCount(0)
        await expect(deliveryTrigger(mode)).toBeFocused()
        await expect(deliveryTrigger(mode)).toContainText('立即补充')
        await deliveryTrigger(mode).press('ArrowDown')
        await expect(deliveryMenu().getByRole('menuitem', { name: /^立即补充/ })).toBeFocused()
        await page.keyboard.press('ArrowDown')
        await expect(deliveryMenu().getByRole('menuitem', { name: /^排到下一轮/ })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(deliveryMenu()).toHaveCount(0)
        await expect(deliveryTrigger(mode)).toBeFocused()
        await expect(deliveryTrigger(mode)).toContainText('排到下一轮')
        await expectStableComposer(mode, layout)
        for (const delivery of ['current', 'next'] as const) {
          await chooseDelivery(mode, delivery)
          await expectStableComposer(mode, layout)
          const geometry = await toolbarGeometry(mode)
          await info.attach(`${mode}-toolbar-${width}-${appearance}-${delivery}`, { contentType: 'application/json', body: JSON.stringify({ ...geometry, composer: await composerGeometry(mode) }, null, 2) })
          expect(geometry.problems, `${mode} ${width} ${appearance} ${delivery} toolbar`).toEqual([])
          if (mode === 'Code') expect(geometry.controls.some(item => item.name === '停止生成')).toBe(true)
          if (mode === 'Code' && width === 940 && delivery === 'next') {
            const modelButton = surface(mode).getByRole('button', { name: '选择模型', exact: true })
            await expect(modelButton).toBeEnabled(); await modelButton.click()
            await expect(page.getByRole('menu', { name: '选择模型', exact: true })).toContainText('Owned no-provider fixture')
            await page.keyboard.press('Escape')
            await expect(page.getByRole('menu', { name: '选择模型', exact: true })).toHaveCount(0)
          }
        }
        await chooseDelivery(mode, 'current')
        await expectStableComposer(mode, layout)
        if (mode === 'Code' && width === 940) {
          const composer = surface(mode).locator('.input-composer:visible').first()
          await expect(composer.locator('.model-picker .select__compact-value')).toHaveText('模型')
          await expect(composer.locator('.model-picker .select__compact-value')).toBeVisible()
          await composer.getByRole('button', { name: '对话偏好', exact: true }).click()
          await expect(page.locator('.composer-options__model-summary')).toContainText('Owned no-provider')
          await expect(page.locator('.composer-options__popup')).toContainText('安全模式')
          await page.keyboard.press('Escape')
          await expect(page.locator('.composer-options__model-summary')).toHaveCount(0)
        }
        await page.screenshot({ path: info.outputPath(`${mode}-root-followup-${width}-${appearance}.png`) })
        await expectNoRecoveryEntry(mode)
        await expectStableComposer(mode, layout)
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))

      // A genuine double-click while discovery is held must produce one POST.
      before = (await audit()).posts.length
      await control({ holdContext: true }); await editor(mode).fill(`${mode} 双击只发送一次`)
      await send(mode).dblclick({ delay: 20 })
      await expect.poll(async () => (await audit()).held.length).toBe(1)
      await editor(mode).fill(`${mode} 发送期间新写的草稿`)
      await control({ release: true })
      await expect.poll(async () => (await audit()).posts.length).toBe(before + 1)
      await expect(feedback(mode).getByRole('status')).toContainText('已接纳')
      await expect(editor(mode)).toHaveText(`${mode} 发送期间新写的草稿`)

      // Explicit next-turn remains a separate durable queue, not a mailbox POST.
      await chooseDelivery(mode, 'next')
      await editor(mode).fill(`${mode} 明确下一轮执行`)
      await surface(mode).getByRole('button', { name: '排到下一轮', exact: true }).click()
      await expect(editor(mode)).toHaveText('')
      expect((await audit()).posts).toHaveLength(before + 1)
      if (mode === 'Work') {
        const queue = surface(mode).getByRole('region', { name: '下一轮消息队列' })
        await info.attach('work-queue-dom', { contentType: 'application/json', body: JSON.stringify(await queue.evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect(), style = getComputedStyle(element)
          const ancestors: Array<{ tag: string; id: string; className: string; hidden: boolean; ariaHidden: string | null }> = []
          for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push({ tag: parent.tagName, id: parent.id, className: parent.className, hidden: parent.hidden, ariaHidden: parent.getAttribute('aria-hidden') })
          return { html: element.outerHTML, box: { x: box.x, y: box.y, width: box.width, height: box.height }, display: style.display, visibility: style.visibility, ancestors }
        })), null, 2) })
        await page.screenshot({ path: info.outputPath('work-queue-before-assert.png') })
        await expect(queue).toHaveCount(1)
        await expect(queue).toContainText(`${mode} 明确下一轮执行`)
        const summary = queue.locator('.work-next-turn__summary')
        if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
        await queue.getByRole('button', { name: '取消这条待发消息', exact: true }).click()
      } else {
        const tray = surface(mode).locator('.session-tray:visible')
        await tray.locator('.session-tray__tab--queue').click()
        await expect(tray).toContainText(`${mode} 明确下一轮执行`)
        await tray.getByRole('button', { name: '移除第 1 条排队消息', exact: true }).click()
      }
      await chooseDelivery(mode, 'current')

      await control({ mode: 'reject' }); await editor(mode).fill(`${mode} 拒绝后保留`)
      const rejectedLayout = await composerGeometry(mode)
      await send(mode).click()
      await expect(feedback(mode).getByRole('alert')).toContainText('Owned fixture rejected')
      await expect(editor(mode)).toHaveText(`${mode} 拒绝后保留`)
      await expectNoHistoryPopover(mode)
      await expectStableComposer(mode, rejectedLayout)
      await openDetails(mode)
      await expect(detailsPanel()).toContainText('Owned fixture rejected')
      await expect(detailsPanel().getByRole('button', { name: '放回输入框', exact: true })).toBeDisabled()
      await expectStableComposer(mode, rejectedLayout)
      await page.screenshot({ path: info.outputPath(`${mode}-root-followup-error-details.png`) })
      await detailsPanel().getByRole('button', { name: '关闭补充详情', exact: true }).focus()
      await page.keyboard.press('Escape')
      await expect(detailsPanel()).toHaveCount(0)
      await expect(feedback(mode).getByRole('button', { name: '查看详情', exact: true })).toBeFocused()

      // Failed text is recoverable from the current details, including after
      // reload. Restoring never overwrites a newer draft or submits another POST.
      const postsBeforeRestore = (await audit()).posts.length
      await editor(mode).fill(`${mode} 更新后的草稿不能被覆盖`)
      await openDetails(mode)
      await detailsPanel().locator('summary').filter({ hasText: '查看待恢复原文' }).click()
      await expect(detailsPanel().locator('pre')).toHaveText(`${mode} 拒绝后保留`)
      await expect(detailsPanel().getByRole('button', { name: '放回输入框', exact: true })).toBeDisabled()
      await detailsPanel().getByRole('button', { name: '关闭补充详情', exact: true }).click()
      await expect(editor(mode)).toHaveText(`${mode} 更新后的草稿不能被覆盖`)
      await expectDraftSaved(mode, `${mode} 更新后的草稿不能被覆盖`)
      await editor(mode).fill('')
      await expectDraftSaved(mode, '')
      await load(mode)
      await expect(feedback(mode).getByRole('status')).toContainText('已恢复原文草稿')
      await expectNoHistoryPopover(mode)
      await openDetails(mode)
      await expect(detailsPanel().getByRole('button', { name: '放回输入框', exact: true })).toBeEnabled()
      await detailsPanel().getByRole('button', { name: '放回输入框', exact: true }).click()
      await expect(detailsPanel()).toHaveCount(0)
      await expect(editor(mode)).toHaveText(`${mode} 拒绝后保留`)
      await expect(editor(mode)).toBeFocused()
      expect((await audit()).posts).toHaveLength(postsBeforeRestore)
      await expectDraftSaved(mode, `${mode} 拒绝后保留`)
      await send(mode).click()
      await expect(editor(mode)).toHaveText('')
      await expect(feedback(mode).getByRole('status')).toContainText('已接纳')
      await expectNoRecoveryEntry(mode)

      await control({ mode: 'unknown' }); await editor(mode).fill(`${mode} 结果不明保留原请求`)
      const unknownLayout = await composerGeometry(mode)
      await send(mode).click()
      await expect(feedback(mode).getByRole('button', { name: '核对补充', exact: true })).toBeVisible()
      await expectStableComposer(mode, unknownLayout)
      before = (await audit()).posts.length; post = (await audit()).posts.at(-1)!
      await expect(send(mode)).toBeDisabled()
      await expect(deliveryTrigger(mode)).toBeDisabled()
      await editor(mode).press('Enter'); expect((await audit()).posts).toHaveLength(before)
      await openDetails(mode, true)
      await expect(detailsPanel().getByRole('button', { name: '放回输入框', exact: true })).toHaveCount(0)
      await detailsPanel().locator('summary').filter({ hasText: '查看待核对原文' }).click()
      await expect(detailsPanel().locator('pre')).toHaveText(`${mode} 结果不明保留原请求`)
      await expectStableComposer(mode, unknownLayout)
      await page.screenshot({ path: info.outputPath(`${mode}-root-followup-pending-details.png`) })
      await detailsPanel().getByRole('button', { name: '核对原请求', exact: true }).click()
      await expect(detailsPanel()).toHaveCount(0)
      await expect(feedback(mode).getByRole('button', { name: '核对补充', exact: true })).toBeEnabled()
      await openDetails(mode, true)
      await expect(detailsPanel().getByRole('button', { name: '重试原请求', exact: true })).toBeVisible()
      await control({ mode: 'accepted' }); await detailsPanel().getByRole('button', { name: '重试原请求', exact: true }).click()
      await expect(detailsPanel()).toHaveCount(0)
      await expect(editor(mode)).toHaveText('')
      expect((await audit()).posts).toHaveLength(before + 1)
      expect((await audit()).posts.at(-1)!.body.requestKey).toBe(post.body.requestKey)
      await expectNoRecoveryEntry(mode)

      // Forgetting an unknown local record must close this panel, preserve
      // the draft, and not retain an open flag that revives on the next error.
      await control({ mode: 'unknown' })
      const retainedUnknown = `${mode} 移除跟踪后仍保留这段原文`
      await editor(mode).fill(retainedUnknown); await send(mode).click()
      await expect(feedback(mode).getByRole('button', { name: '核对补充', exact: true })).toBeVisible()
      const beforeForget = await audit(), forgottenKey = beforeForget.posts.at(-1)!.body.requestKey
      await openDetails(mode, true)
      await detailsPanel().locator('summary').filter({ hasText: '移除本地跟踪记录' }).click()
      await detailsPanel().getByRole('button', { name: '确认移除本地记录', exact: true }).click()
      await expect(detailsPanel()).toHaveCount(0)
      await expect(editor(mode)).toBeFocused()
      await expect(editor(mode)).toHaveText(retainedUnknown)
      await expect(feedback(mode).getByRole('button', { name: '核对补充', exact: true })).toHaveCount(0)
      await expect.poll(() => page.evaluate(requestKey => {
        const records = JSON.parse(localStorage.getItem('aether.collaboration-controller-outbox.v1') ?? '[]') as Array<{ requestKey: string }>
        return records.some(record => record.requestKey === requestKey)
      }, forgottenKey)).toBe(false)
      const afterForget = await audit()
      expect(afterForget.posts).toHaveLength(beforeForget.posts.length)
      expect(afterForget.continuations).toHaveLength(beforeForget.continuations.length)
      expect(afterForget.requests.filter(item => item.path.endsWith('/chat/cancel')))
        .toHaveLength(beforeForget.requests.filter(item => item.path.endsWith('/chat/cancel')).length)
      await control({ mode: 'reject' })
      await editor(mode).fill(`${mode} 移除跟踪后的新补充`); await send(mode).click()
      await expect(feedback(mode).getByRole('alert')).toContainText('Owned fixture rejected')
      await expect(feedback(mode).getByRole('button', { name: '查看详情', exact: true })).toHaveAttribute('aria-expanded', 'false')
      await expect(detailsPanel()).toHaveCount(0)
      await page.screenshot({ path: info.outputPath(`${mode}-root-followup-after-forget.png`) })

      // A newer root returned by discovery must not receive the old composer send.
      await control({ mode: 'accepted', holdContext: true }); await editor(mode).fill(`${mode} 原轮次要求`); await send(mode).click()
      await expect.poll(async () => (await audit()).held.length).toBe(1)
      before = (await audit()).posts.length
      await control({ rotateRoot: true, release: true })
      await expect(feedback(mode).getByRole('alert')).toBeVisible()
      await expect(editor(mode)).toHaveText(`${mode} 原轮次要求`)
      expect((await audit()).posts).toHaveLength(before)

      // Stop through the product UI while discovery is pending; release cannot send.
      await load(mode)
      const retainedNext = `${mode} 停止后保留的下一轮要求`
      await chooseDelivery(mode, 'next')
      await editor(mode).fill(retainedNext); await editor(mode).press('Enter')
      await expect(editor(mode)).toHaveText('')
      await chooseDelivery(mode, 'current')
      await control({ holdContext: true }); await editor(mode).fill(`${mode} 停止边界原文`); await send(mode).click()
      await expect.poll(async () => (await audit()).held.length).toBe(1)
      before = (await audit()).posts.length
      const cancelsBefore = (await audit()).requests.filter(item => item.path.endsWith('/chat/cancel')).length
      await surface(mode).getByRole('button', { name: mode === 'Work' ? '停止任务' : '停止生成', exact: true }).first().click()
      await expect.poll(async () => (await audit()).requests.filter(item => item.path.endsWith('/chat/cancel')).length).toBe(cancelsBefore + 1)
      await control({ release: true })
      await expect(editor(mode)).toHaveText(`${mode} 停止边界原文`)
      await expect(surface(mode).getByRole('button', { name: '正在提交补充…', exact: true })).toHaveCount(0)
      expect((await audit()).posts).toHaveLength(before)
      if (mode === 'Code') {
        const tray = surface(mode).locator('.session-tray:visible')
        await tray.locator('.session-tray__tab--queue').click()
        await expect(tray).toContainText(retainedNext)
      } else await expect(surface(mode).locator('.work-next-turn')).toContainText(retainedNext)
      expect((await audit()).continuations).toHaveLength(0)
      await page.screenshot({ path: info.outputPath(`${mode}-root-followup-stopped.png`) })
    }
    expect((await audit()).continuations).toHaveLength(0)
    expect(pageErrors).toEqual([])
  } finally {
    await page.screenshot({ path: info.outputPath('final-window.png') }).catch(() => {})
    await page.context().tracing.stop({ path: info.outputPath('electron-ui-trace.zip') }).catch(() => {})
    await control({ release: true }); await health.closeAndAssert(info)
  }
})
