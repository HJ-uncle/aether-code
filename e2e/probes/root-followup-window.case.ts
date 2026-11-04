/** Real Electron/React/IPC against an isolated synthetic root mailbox.
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
async function load(mode: 'Work' | 'Code'): Promise<void> {
  await control({ rootTerminal: false, mode: 'accepted' })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  await page.getByRole('tab', { name: mode === 'Work' ? 'Work 办公' : 'Code 开发', exact: true }).click()
  await expect(surface(mode).getByRole('combobox', { name: '发送方式' })).toHaveValue('current')
}
const surface = (mode: 'Work' | 'Code') => page.locator(mode === 'Work' ? '#mode-work' : '#mode-code')
const editor = (mode: 'Work' | 'Code') => surface(mode).locator('.input-composer__input[role="textbox"]:visible').first()
const send = (mode: 'Work' | 'Code') => surface(mode).getByRole('button', { name: '立即补充', exact: true })
const feedback = (mode: 'Work' | 'Code') => surface(mode).getByLabel('当前任务补充状态', { exact: true })

async function toolbarGeometry(mode: 'Work' | 'Code'): Promise<{ controls: Array<{ name: string; x: number; right: number; width: number }>; problems: string[] }> {
  return surface(mode).locator('.input-composer__toolbar:visible').first().evaluate(toolbar => {
    const bounds = toolbar.getBoundingClientRect(), problems: string[] = []
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>('button, select')).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const rect = element.getBoundingClientRect(), name = element.getAttribute('aria-label') || element.title || element.textContent || element.tagName
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) problems.push(`${name}: outside toolbar`)
      // Native selects do not report clipped option text via scrollWidth.
      if (element instanceof HTMLSelectElement) {
        const style = getComputedStyle(element), canvas = document.createElement('canvas'), context = canvas.getContext('2d')!
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        const required = context.measureText(element.selectedOptions[0].text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 24
        if (rect.width < required) problems.push(`${name}: selected label clipped (${rect.width} < ${required})`)
      }
      for (const span of element.querySelectorAll<HTMLElement>('.select__compact-value')) {
        if (!span.getClientRects().length) continue
        const range = document.createRange(); range.selectNodeContents(span); const text = range.getBoundingClientRect()
        if (text.left < rect.left - 1 || text.right > rect.right + 1) problems.push(`${name}: compact text clipped`)
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
      await load(mode)
      let before = (await audit()).posts.length
      await editor(mode).fill(`${mode} 立即补充原任务`)
      await expect(send(mode)).toBeEnabled(); await editor(mode).press('Enter')
      await expect(feedback(mode).getByRole('status')).toContainText('已接纳，将在下一次模型调用前读取')
      await expect(editor(mode)).toHaveText('')
      let post = (await audit()).posts.at(-1)!
      expect((await audit()).posts).toHaveLength(before + 1)
      expect(post.body.recipientParticipantId).toBe('root')
      expect(post.body.recipientInvocationRunId).toBe(post.rootRunId)
      expect(post.query.rootAttemptId).toContain('attempt-' + post.query.rootSessionId)
      expect((await audit()).requests.filter(item => item.method === 'POST' && item.path.endsWith('/messages')).at(-1)?.profile).toBe(mode === 'Work' ? 'general' : 'code')
      for (const width of [1440, 940]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width)
        await editor(mode).scrollIntoViewIfNeeded()
        await expect(surface(mode).getByRole('combobox', { name: '发送方式' })).toBeInViewport({ ratio: 1 })
        expect(await surface(mode).locator('.input-composer:visible').first().evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true)
        for (const delivery of ['current', 'next']) {
          await surface(mode).getByRole('combobox', { name: '发送方式' }).selectOption(delivery)
          const geometry = await toolbarGeometry(mode)
          await info.attach(`${mode}-toolbar-${width}-${delivery}`, { contentType: 'application/json', body: JSON.stringify(geometry, null, 2) })
          expect(geometry.problems, `${mode} ${width} ${delivery} toolbar`).toEqual([])
          expect(geometry.controls.find(item => item.name === '发送方式')?.width).toBeGreaterThanOrEqual(100)
          if (mode === 'Code') expect(geometry.controls.some(item => item.name === '停止生成')).toBe(true)
          if (mode === 'Code' && width === 940 && delivery === 'next') {
            const modelButton = surface(mode).getByRole('button', { name: '选择模型', exact: true })
            await expect(modelButton).toBeEnabled(); await modelButton.click()
            await expect(page.getByRole('menu', { name: '选择模型', exact: true })).toContainText('Owned no-provider fixture')
            await page.keyboard.press('Escape')
            await expect(page.getByRole('menu', { name: '选择模型', exact: true })).toHaveCount(0)
          }
        }
        await surface(mode).getByRole('combobox', { name: '发送方式' }).selectOption('current')
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
        await page.screenshot({ path: info.outputPath(`${mode}-root-followup-${width}.png`) })
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
      await surface(mode).getByRole('combobox', { name: '发送方式' }).selectOption('next')
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
        const tray = surface(mode).locator('.session-tray')
        await tray.locator('.session-tray__tab--queue').click()
        await expect(tray).toContainText(`${mode} 明确下一轮执行`)
        await tray.getByRole('button', { name: '移除第 1 条排队消息', exact: true }).click()
      }
      await surface(mode).getByRole('combobox', { name: '发送方式' }).selectOption('current')

      await control({ mode: 'reject' }); await editor(mode).fill(`${mode} 拒绝后保留`); await send(mode).click()
      await expect(feedback(mode).getByRole('alert')).toContainText('Owned fixture rejected')
      await expect(editor(mode)).toHaveText(`${mode} 拒绝后保留`)

      await control({ mode: 'unknown' }); await editor(mode).fill(`${mode} 结果不明保留原请求`); await send(mode).click()
      await expect(feedback(mode).getByRole('button', { name: '核对原请求' })).toBeVisible()
      before = (await audit()).posts.length; post = (await audit()).posts.at(-1)!
      await expect(send(mode)).toBeDisabled()
      await expect(surface(mode).getByRole('combobox', { name: '发送方式' })).toBeDisabled()
      await editor(mode).press('Enter'); expect((await audit()).posts).toHaveLength(before)
      await feedback(mode).getByRole('button', { name: '核对原请求' }).click()
      await expect(feedback(mode).getByRole('button', { name: '重试原请求' })).toBeVisible()
      await control({ mode: 'accepted' }); await feedback(mode).getByRole('button', { name: '重试原请求' }).click()
      await expect(editor(mode)).toHaveText('')
      expect((await audit()).posts).toHaveLength(before + 1)
      expect((await audit()).posts.at(-1)!.body.requestKey).toBe(post.body.requestKey)

      // A newer root returned by discovery must not receive the old composer send.
      await control({ holdContext: true }); await editor(mode).fill(`${mode} 原轮次要求`); await send(mode).click()
      await expect.poll(async () => (await audit()).held.length).toBe(1)
      before = (await audit()).posts.length
      await control({ rotateRoot: true, release: true })
      await expect(feedback(mode).getByRole('alert')).toBeVisible()
      await expect(editor(mode)).toHaveText(`${mode} 原轮次要求`)
      expect((await audit()).posts).toHaveLength(before)

      // Stop through the product UI while discovery is pending; release cannot send.
      await load(mode)
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
