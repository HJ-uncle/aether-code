/** Actual Work feedback components in isolated headless Chromium, including
 * synchronized status text, accessible static states and long-running elapsed clocks. */
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeRootRunActivity, type RootRun, type RootRunActivity } from '../src/shared/root-run'
import { normalizeRootRun, mergeRootRun, applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
import { sessionTaskActivityFromRun, sessionTaskRunPatch, normalizeSessionTaskActivity } from '../src/renderer/src/features/sessions/status-poller'
import { sessionDependencyProgress } from '../src/renderer/src/features/sessions/dependency-progress'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { sessionSidebarStatus } from '../src/renderer/src/features/sessions/sidebar-task'
import type { SessionTask } from '../src/renderer/src/features/sessions/state'

const activity = (): RootRunActivity => ({ phase: 'waiting_children', groups: [
  { id: 'A', label: '审阅接口', state: 'consumed', total: 1, settled: 1, failed: 0 },
  { id: 'B', label: '集成模块', state: 'waiting', total: 2, settled: 1, failed: 0 },
  { id: 'C', label: '共享同一依赖的文档', state: 'waiting', total: 2, settled: 1, failed: 0 },
] })
const root = (patch: Partial<RootRun> = {}): RootRun => ({ schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn',
  userMessageId: 'user', assistantMessageId: 'assistant', seq: 1, version: 2, status: 'running', createdAt: 100, updatedAt: 200,
  pending: [], activity: activity(), ...patch })
const task = (patch: Partial<SessionTask> = {}): SessionTask => ({ id: 'session', title: '项目任务', draft: '', status: 'running',
  createdAt: 100, updatedAt: 200, workspacePath: null, modelId: 'fixture', attachments: [], sources: [],
  activity: sessionTaskActivityFromRun({ run: root() }, 'session'), ...patch })

test('the transport keeps bounded complete progress and rejects malformed counters', () => {
  expect(normalizeRootRunActivity(activity())).toEqual(activity())
  const group = activity().groups[1]
  for (const invalid of [null, {}, { phase: 'waiting_children', groups: [] },
    { phase: 'waiting_children', groups: [group, group] },
    { phase: 'waiting_children', groups: Array.from({ length: 33 }, (_, i) => ({ ...group, id: String(i) })) },
    ...[{ label: 'x'.repeat(241) }, { total: 0 }, { settled: 3 }, { failed: 2 }, { failed: -1 }, { settled: 0.5 }]
      .map(patch => ({ phase: 'waiting_children', groups: [{ ...group, ...patch }] }))]) expect(normalizeRootRunActivity(invalid)).toBeUndefined()
  expect(normalizeRootRunActivity({ phase: 'executing', groups: [] })).toEqual({ phase: 'executing', groups: [] })
})

test('SSE and HTTP status preserve one authoritative version without adding tools or usage', () => {
  const first = normalizeRootRun(root())!
  const next = normalizeRootRun(root({ version: 3, activity: { phase: 'executing', groups: [] } }))!
  expect(mergeRootRun(first, next)).toEqual(next)
  expect(mergeRootRun(next, first)).toEqual(next)
  const messages = applyRootRun([{ id: 'assistant', role: 'assistant', content: '', thinking: '', tools: [],
    status: 'streaming', createdAt: 100, usage: { promptTokens: 9, completionTokens: 2 } }], first)
  const updated = applyRootRun(messages, next)
  expect(updated[0].tools).toEqual([])
  expect(updated[0].usage).toEqual(messages[0].usage)
  const current = task()
  expect(current.activity?.execution).toEqual(activity())
  expect(normalizeSessionTaskActivity(current.activity)?.execution).toEqual(activity())
  expect(sessionTaskRunPatch(current, { run: next }, 300)?.activity.execution?.phase).toBe('executing')
  expect(sessionTaskRunPatch({ ...current, activity: sessionTaskActivityFromRun({ run: next }, 'session') }, { run: first }, 300)).toBeUndefined()
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'waiting'] as const) {
    expect(normalizeRootRun(root({ status }))?.activity).toBeUndefined()
    expect(sessionTaskActivityFromRun({ run: root({ status }) }, 'session')?.execution).toBeUndefined()
  }
})

test('one named dependency group is shown, never summed across overlapping groups', () => {
  expect(sessionDependencyProgress(root())).toMatchObject({ groupId: 'B', label: '等待依赖 · 1/2', accessibleLabel: '集成模块，等待依赖 · 1/2' })
  expect(sessionDependencyProgress(root())?.detail).not.toContain('3/5')
  const blocked = activity(); blocked.groups[1] = { ...blocked.groups[1], state: 'blocked', failed: 1 }
  expect(sessionDependencyProgress(root({ activity: blocked }))?.accessibleLabel).toBe('集成模块，依赖受阻 · 1/2，1 项未成功')
  expect(sessionDependencyProgress(root({ status: 'succeeded' }))).toBeUndefined()
  expect(sessionDependencyProgress(root({ activity: { phase: 'executing', groups: activity().groups } }))).toBeUndefined()
})

test('sidebar remains active while question, disconnection, stop and terminal take precedence', () => {
  expect(sessionSidebarStatus(task(), true)).toEqual({ kind: 'running', active: true, label: '集成模块，等待依赖 · 1/2' })
  expect(sessionSidebarStatus(task(), true, true).kind).toBe('stopping')
  expect(sessionSidebarStatus(task(), false).kind).toBe('disconnected')
  expect(sessionSidebarStatus(task({ status: 'waiting' }), true).kind).toBe('question')
  expect(sessionSidebarStatus(task({ status: 'done' }), true).label).toBe('已完成')
})

test.describe('Work dependency feedback DOM', () => {
  const project = resolve(__dirname, '..')
  let browser: Browser, context: BrowserContext, page: Page, bundle: string, errors: string[]
  const css = ['assets/tokens.css', 'assets/base.css', 'assets/components.css', 'assets/motion.css', 'app/application.css']
    .map(file => readFileSync(resolve(project, 'src/renderer/src', file), 'utf8')).join('\n')
  test.beforeAll(async () => {
    const built = await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { AppContext } from './src/renderer/src/core/app-context'
      import { DEFAULT_SETTINGS } from './src/shared/ipc'
      import { SessionTurnFeedback, SessionRunStatus } from './src/renderer/src/features/conversation/SessionFeedback'
      const view = createRoot(document.getElementById('fixture'))
      const context = { engine:{snapshot:{mode:'local'}},settings:DEFAULT_SETTINGS,userSettings:DEFAULT_SETTINGS,ready:true,settingsLoaded:true,updateSettings:async()=>{} }
      window.stopCount = 0
      window.openedActivities = []
      window.renderDependency = ({ run, footer = false, ...overrides }) => {
        const controller = { ready:true, pending:[], streaming:true, launching:false, stopping:false, messages:[{id:'assistant',role:'assistant',status:'streaming',createdAt:Date.now(),tools:[],content:'之前的进展',thinking:'之前的分析',run}],
          activeTask:{status:'running'}, agentId:'', agentIdentity:{name:'默认助手',model:'',loading:false,error:null}, stop:async()=>{window.stopCount++}, ...overrides }
        view.render(<AppContext.Provider value={context}>{footer ? <SessionRunStatus controller={controller}/> : <SessionTurnFeedback controller={controller} announce openActivity={id=>window.openedActivities.push(id)}/>}</AppContext.Provider>)
      }
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      tsconfig: resolve(project, 'tsconfig.web.json'), loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'fixture-vite-imports', setup(build) {
        build.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path, namespace: 'blocked-worker' }))
        build.onLoad({ filter: /.*/, namespace: 'blocked-worker' }, () => ({ contents: 'export default class { constructor(){ throw Error("Editor launch forbidden") } }' }))
        build.onResolve({ filter: /\?(?:inline|raw)$/ }, async args => ({ path: (await build.resolve(args.path.replace(/\?[^?]+$/, ''), { resolveDir: args.resolveDir, kind: args.kind })).path, namespace: 'raw-resource' }))
        build.onLoad({ filter: /.*/, namespace: 'raw-resource' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
      } }] })
    bundle = built.outputFiles[0].text
    const executablePath = [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  })
  test.afterAll(async () => { await browser?.close() })
  test.beforeEach(async () => {
    errors = []; context = await browser.newContext({ viewport: { width: 375, height: 340 }, reducedMotion: 'reduce' })
    await context.route('**/*', route => route.abort())
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<html data-appearance="dark"><body><main id="fixture" class="work-view"></main></body></html>')
    await page.addStyleTag({ content: css + '\nbody{padding:12px}#fixture{width:100%;display:block;min-width:0;height:auto}' })
    await page.addScriptTag({ content: bundle })
  })
  test.afterEach(async () => { try { expect(errors).toEqual([]) } finally { await context?.close() } })
  async function render(overrides: Record<string, unknown> = {}) {
    await page.evaluate(value => (window as unknown as { renderDependency: (value: unknown) => void }).renderDependency(value), { run: root(), ...overrides })
  }
  test('renders compact, named progress with stop control and no tool cards in both themes', async ({}, info) => {
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), theme)
      await render()
      await expect(page.locator('[data-phase="waiting_children"]')).toBeVisible()
      await expect(page.getByRole('status')).toHaveText('等待依赖 · 1/2')
      await expect(page.getByRole('status')).toHaveAccessibleName('集成模块，等待依赖 · 1/2')
      await expect(page.locator('.work-turn-feedback__body > p')).toContainText('集成模块：已收取 1/2 项依赖')
      await expect(page.locator('.work-tool-activity, .compact-tool-row, .work-turn-feedback__activity')).toHaveCount(0)
      expect(await page.locator('#fixture').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`root-dependency-${theme}.png`) })
    }
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as { stopCount: number }).stopCount)).toBe(1)
    await render({ footer: true })
    await expect(page.getByRole('status')).toContainText('集成模块，等待依赖 · 1/2')
  })
  test('default feedback aligns without a name; assigned assistants and a running child remain identifiable', async () => {
    const heading = page.locator('.work-turn-feedback__heading')
    const status = heading.getByRole('status')
    await render()
    await expect(status).toHaveText('等待依赖 · 1/2')
    await expect(heading).not.toContainText('默认助手')
    const left = () => status.evaluate(el => el.getBoundingClientRect().left)
    const detailLeft = await page.locator('.work-turn-feedback__body > p').evaluate(el => el.getBoundingClientRect().left)
    expect(Math.abs(await left() - detailLeft), 'no empty name or leading gap').toBeLessThanOrEqual(1)

    // A custom assistant may deliberately use the same display name as the default.
    for (const name of ['界面审阅员', '默认助手']) {
      await render({ agentId: 'custom-reviewer', agentIdentity: { name, model: 'fixture', loading: false, error: null } })
      await expect(heading.getByText(name, { exact: true })).toBeVisible()
      await expect(status).toHaveText('等待依赖 · 1/2')
    }
    const now = Date.now(), childName = '交互测试员'
    const tool: ToolActivity = { id: 'delegate', name: 'subagent', args: '{}', result: '', state: 'running', subagent: {
      schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'session', parentSessionId: 'session',
      parentConversationId: 'turn', parentMessageId: 'assistant', parentToolCallId: 'delegate', childSessionId: 'child',
      agentId: 'custom-child', agentName: childName, task: '检查键盘导航', description: '检查导航', modelId: 'fixture',
      status: 'running', lastSeq: 1, createdAt: now, updatedAt: now, usage: {}, toolCalls: []
    } }
    await render({ messages: [{ id: 'assistant', role: 'assistant', status: 'streaming', createdAt: now, tools: [tool], content: '', thinking: '' }] })
    await expect(status).toHaveText(`${childName}…`)
    expect((await heading.innerText()).split(childName)).toHaveLength(2)
    await page.getByRole('button', { name: '查看正在执行的活动' }).click()
    expect(await page.evaluate(() => (window as unknown as { openedActivities: string[] }).openedActivities)).toEqual([tool.id])
  })
  test('one sweep crosses the status and detail together while controls remain still', async ({}, info) => {
    const now = Date.now()
    await page.clock.setFixedTime(now)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const body = page.locator('.work-turn-feedback__body')
    const assistant = { id: 'assistant', role: 'assistant', status: 'streaming', createdAt: now, content: '', thinking: '分析任务', tools: [] }
    const command = { id: 'cmd', name: 'execute_cmd', state: 'running', args: JSON.stringify({ command: 'rg', args: ['--files', 'conversation/feedback'] }) }
    for (const [theme, width, tool] of [['dark', 375, false], ['light', 740, true]] as const) {
      await page.setViewportSize({ width, height: 320 })
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), theme)
      await render({ messages: [{ ...assistant, tools: tool ? [command] : [] }] })
      const label = body.getByRole('status'), detail = body.locator(tool ? '.work-turn-feedback__activity > span' : 'p')
      await expect(label).toContainText(tool ? '执行命令' : '正在思考')
      await expect(detail).toContainText(tool ? 'rg --files' : '分析任务')
      await expect(body.getByRole('button', { name: '停止任务' })).toBeEnabled()
      // Switching themes transitions the stop button's color. Start comparisons at
      // the settled palette so theme changes cannot be mistaken for the moving light.
      await body.evaluate(el => Promise.all(el.getAnimations({ subtree: true })
        .filter(animation => animation instanceof CSSTransition).map(transition => transition.finished)).then(() => undefined))
      const [titleBox, detailBox, controlsBox] = await Promise.all([label, detail, body.locator('.work-turn-feedback__controls')].map(async item => {
        const box = await item.boundingBox(); if (!box) throw Error('Missing feedback text or controls'); return box
      }))
      // Once the light moves past the short status, only the longer description can light up.
      // Compare the same columns of both lines, and sample densely enough to see the short status crossed.
      const left = Math.max(titleBox.x, detailBox.x), right = Math.min(titleBox.x + titleBox.width, detailBox.x + detailBox.width)
      const sharedWidth = right - left
      expect(sharedWidth).toBeGreaterThan(24)
      const regions = [titleBox, detailBox].map(box => ({ ...box, x: left, width: sharedWidth })).concat(controlsBox)
      const sampleCount = 40, frames: string[] = []
      for (let i = 0; i < sampleCount; i++) {
        const clocks = await body.evaluate((el, progress) => {
          const animations = el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations === Infinity)
          for (const a of animations) { a.pause(); a.currentTime = Number(a.effect!.getComputedTiming().duration) * progress }
          return animations.length
        }, i / sampleCount)
        expect(clocks).toBe(1)
        frames.push((await page.screenshot({ scale: 'css', ...(i === 5 || i === 7 ? { path: info.outputPath(`${theme}-sweep-${i}.png`) } : {}) })).toString('base64'))
      }
      // Glyphs differ between lines. Measure the center of the pixels that actually
      // change on each line in the same screen coordinates, relative to the resting frame.
      const moments = await page.evaluate(async ({ frames, regions }) => {
        const pixels = await Promise.all(frames.map(async png => {
          const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode()
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
          const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height)
        }))
        return pixels.slice(1).map(frame => regions.map(rect => {
          let weight = 0, moment = 0
          for (let y = Math.ceil(rect.y); y < Math.floor(rect.y + rect.height); y++) for (let x = Math.ceil(rect.x); x < Math.floor(rect.x + rect.width); x++) {
            const offset = (y * frame.width + x) * 4, diff = Math.abs(frame.data[offset] - pixels[0].data[offset])
            if (diff > 10) { weight += diff; moment += x * diff }
          }
          return { weight, x: weight ? moment / weight : 0 }
        }))
      }, { frames, regions })
      const together = moments.filter(([status, detail]) => status.weight > 220 && detail.weight > 220 && Math.abs(status.x - detail.x) < sharedWidth / 3)
      expect(together.length, 'both lines illuminate in the same horizontal band').toBeGreaterThanOrEqual(2)
      for (const line of [0, 1]) {
        expect(together.at(-1)![line].x - together[0][line].x, 'the band moves right across each line').toBeGreaterThan(sharedWidth / 8)
      }
      expect(moments.every(([, , controls]) => controls.weight === 0), 'stop and elapsed time are outside the light').toBe(true)
    }
    for (const media of [{ reducedMotion: 'reduce', forcedColors: 'none' }, { reducedMotion: 'no-preference', forcedColors: 'active' }] as const) {
      await page.emulateMedia(media)
      expect(await body.evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations === Infinity).length)).toBe(0)
      for (const text of [body.getByRole('status'), body.locator('.work-turn-feedback__activity > span')]) {
        expect(await text.evaluate(el => getComputedStyle(el).webkitTextFillColor)).not.toMatch(/transparent|rgba\([^)]*, 0\)$/)
      }
    }
  })
  test('clears waiting on phase change, terminal, ask, stop and disconnection', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const feedbackText = page.locator('.work-turn-feedback__body')
    await render(); await expect(page.locator('[data-phase="waiting_children"]')).toHaveCount(1)
    await render({ run: root({ version: 3, activity: { phase: 'executing', groups: [] } }) })
    await expect(page.locator('[data-phase="waiting_children"]')).toHaveCount(0)
    await render({ pending: [{ kind: 'ask' }] }); await expect(page.getByRole('status')).toHaveText('等你补充')
    await expect(feedbackText).toHaveCSS('animation-name', 'none')
    await render({ stopping: true }); await expect(page.getByRole('status')).toHaveText('正在停止任务…')
    await expect(feedbackText).toHaveCSS('animation-name', 'none')
    await render({ ready: false }); await expect(page.locator('.work-turn-feedback')).toHaveCount(0)
    await render({ run: root({ status: 'succeeded' }) }); await expect(page.locator('.work-turn-feedback')).toHaveCount(0)
    await render({ run: root({ status: 'succeeded' }), launching: true })
    await expect(page.getByRole('status')).toHaveText('正在准备任务…')
  })
  test('long group names remain available in narrow feedback without horizontal overflow', async () => {
    const long = activity(); long.groups[1].label = 'LongDependencyName'.repeat(13)
    await render({ run: root({ activity: long }) })
    await expect(page.locator('.work-turn-feedback__body > p')).toContainText(long.groups[1].label)
    expect(await page.locator('#fixture').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await render({ run: root({ activity: long }), footer: true })
    await expect(page.getByRole('status')).toHaveAccessibleName(new RegExp(long.groups[1].label))
    await expect(page.getByRole('status')).toHaveAttribute('title', new RegExp(long.groups[1].label))
    expect(await page.locator('#fixture').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })
  test('waiting feedback and pinned status keep seconds across hour boundaries without narrow overflow', async ({}, info) => {
    const clockAt = new Date(2026, 10, 11, 12, 0, 0).getTime()
    await page.clock.install({ time: clockAt - 1000 })
    await page.clock.pauseAt(clockAt)
    for (const footer of [false, true]) {
      await page.clock.setSystemTime(clockAt)
      await render({ footer, run: root({ status: 'waiting', startedAt: clockAt - 3_599_000 }), pending: [{ kind: 'permission' }] })
      const elapsed = page.locator(footer ? '.work-run-status__elapsed' : '.work-turn-feedback__elapsed')
      await expect(elapsed).toHaveText('59 分 59 秒')
      await page.clock.runFor(1000)
      await expect(elapsed).toHaveText('1 小时 0 分 0 秒')
      await page.clock.fastForward(7_406_000)
      await expect(elapsed).toHaveText('3 小时 3 分 26 秒')
      await expect(page.getByRole('status')).toHaveText('待授权')
      expect(await page.locator('#fixture').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const path = info.outputPath(footer ? 'elapsed-hours-pinned.png' : 'elapsed-hours-feedback.png')
      await page.screenshot({ path })
      await info.attach(footer ? 'pinned elapsed time' : 'feedback elapsed time', { path, contentType: 'image/png' })
    }
  })
})
