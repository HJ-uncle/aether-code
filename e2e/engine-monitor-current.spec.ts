/**
 * Current monitor smoke: this is intentionally independent from the legacy
 * Work/E2E suites. It seeds a bounded local Work state, opens the monitor in a
 * fresh Electron profile, verifies the focused resource surface and checks that monitor timers
 * are released when the monitor page is hidden.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
const temporaryRoot = join(root, '.e2e-tmp')
const storageKey = 'aether.work.state.v1'
const now = Date.now()

let app: ElectronApplication | undefined
let page: Page
let fixture = ''

function seededTask(index: number, automation = false): Record<string, unknown> {
  const id = automation ? `work-automation-${index}` : `work-monitor-${index}`
  return {
    id,
    title: automation ? `定时回放 ${index}` : `监控任务 ${index}`,
    draft: '',
    status: index % 3 === 0 ? 'running' : index % 3 === 1 ? 'waiting' : 'done',
    createdAt: now - index * 1_000,
    updatedAt: now - index * 500,
    workspacePath: `C:/fixture/workspace-${index}`,
    modelId: 'monitor-fixture-model',
    attachments: [],
    sources: [],
    ...(automation ? { origin: { kind: 'automation', jobId: `job-${index}`, runId: id } } : {})
  }
}

function seededState(): Record<string, unknown> {
  return {
    // More than the monitor's 24-row presentation budget exercises the bound
    // without creating an unbounded renderer fixture.
    tasks: [
      ...Array.from({ length: 30 }, (_, index) => seededTask(index)),
      ...Array.from({ length: 4 }, (_, index) => seededTask(index, true))
    ],
    activeTaskId: 'work-monitor-0',
    homeDraft: '',
    homeWorkspacePath: null,
    homeAttachments: [],
    homeModelId: 'monitor-fixture-model',
    homeSessionId: null,
    homeAgentId: '',
    homeMentions: [],
    homeResources: { skills: [], mcpServers: [], knowledgeBases: [] }
  }
}

async function launch(): Promise<void> {
  mkdirSync(temporaryRoot, { recursive: true })
  fixture = mkdtempSync(join(temporaryRoot, 'engine-monitor-current-'))
  writeFileSync(
    join(fixture, 'settings.json'),
    JSON.stringify({
      engineMode: 'embedded',
      autoStartEngine: false,
      lastFolder: '',
      appearance: 'dark'
    })
  )
  app = await electron.launch({
    args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`],
    cwd: root,
    env: {
      ...process.env,
      AETHER_GLOBAL_DIR: join(fixture, 'global')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  // Work state is normally read once when Work mounts. Seed before reloading so
  // the renderer's state cache observes the same durable shape as a real user.
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), {
    key: storageKey,
    state: seededState()
  })
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toBeVisible()
}

async function openMonitor(): Promise<void> {
  const workTab = page.getByRole('tab', { name: 'Work 办公', exact: true })
  if ((await workTab.getAttribute('aria-selected')) !== 'true') await workTab.click()
  const work = page.locator('.work-view')
  await expect(work).toBeVisible()
  const monitor = work.locator('button.work-navigation__item').filter({ hasText: '引擎监控' })
  await expect(monitor).toBeVisible()
  await monitor.click()
  await expect(monitor).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.work-page--monitor')).toBeVisible()
}

async function installTimerProbe(): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & {
      __monitorTimerProbe?: { active: Set<number>; created: number; baseline: number }
    }
    if (target.__monitorTimerProbe) return
    const active = new Set<number>()
    const probe = { active, created: 0, baseline: 0 }
    const originalSet = window.setInterval.bind(window)
    const originalClear = window.clearInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = Reflect.apply(originalSet, window, [handler, timeout, ...args]) as number
      // Only the existing 30s snapshot age ticker belongs to this page.
      if (timeout === 30_000) {
        active.add(id)
        probe.created += 1
      }
      return id
    }) as typeof window.setInterval
    window.clearInterval = ((id: number | undefined) => {
      if (typeof id === 'number') active.delete(id)
      return Reflect.apply(originalClear, window, [id])
    }) as typeof window.clearInterval
    probe.baseline = active.size
    target.__monitorTimerProbe = probe
  })
}

async function timerProbe(): Promise<{ active: number; created: number; baseline: number }> {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __monitorTimerProbe?: { active: Set<number>; created: number; baseline: number }
      }
    ).__monitorTimerProbe
    if (!probe) throw new Error('monitor timer probe is not installed')
    return { active: probe.active.size, created: probe.created, baseline: probe.baseline }
  })
}

test.describe('当前引擎监控页', () => {
  test.beforeAll(async () => {
    await launch()
  })

  test.afterAll(async () => {
    try {
      await app?.close()
    } finally {
      if (fixture) rmSync(resolve(fixture), { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('只显示资源与实例信息，移除任务统计区域并在隐藏后清理计时器', async () => {
    const monitor = page.locator('.work-page--monitor')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await installTimerProbe()
    await openMonitor()

    // The resource card is a first-class monitor surface. Keep the assertions
    // on its public accessible contract so a visual refactor cannot silently
    // remove the health/usage context from keyboard and screen-reader users.
    const resource = monitor.getByRole('region', { name: '引擎资源与健康监控', exact: true })
    await expect(resource).toBeVisible()
    await expect(resource.getByRole('heading', { name: '资源与健康' })).toBeVisible()
    await expect(resource.getByLabel('健康检查采样')).toBeVisible()
    await expect(resource.getByText('最近心跳检查', { exact: true })).toBeVisible()
    await expect(resource.getByLabel('宿主容量')).toBeVisible()
    await expect(resource.getByLabel('引擎数据存储')).toBeVisible()
    await expect(resource.getByLabel('引擎进程树')).toBeVisible()
    await expect(resource.getByText('最多显示 24 项', { exact: false })).toBeVisible()
    await expect(resource.getByText('页面隐藏后暂停采样', { exact: false })).toBeVisible()

    // Verify that the Apple-style visual system is active at runtime. The
    // component must consume the shared token values rather than hard-coding
    // a second radius/font scale that would drift between themes.
    const visual = await resource.evaluate((node) => {
      const root = getComputedStyle(document.documentElement)
      const card = getComputedStyle(node)
      return {
        cardRadius: card.borderRadius,
        tokenRadius: root.getPropertyValue('--radius-xl').trim(),
        fontFamily: card.fontFamily,
        tokenFont: root.getPropertyValue('--font-ui').trim(),
        background: card.backgroundColor
      }
    })
    expect(visual.cardRadius).toBe(visual.tokenRadius)
    expect(visual.tokenFont).toContain('-apple-system')
    expect(visual.fontFamily).toContain('-apple-system')
    expect(visual.background).not.toBe('rgba(0, 0, 0, 0)')

    await expect(monitor.getByRole('region', { name: '引擎身份', exact: true })).toBeVisible()
    for (const name of ['Work 任务', '定时任务', '定时计划监控', '引擎业务统计', '客户端性能']) {
      await expect(monitor.getByRole('region', { name, exact: true })).toHaveCount(0)
    }
    await expect(monitor.getByRole('group', { name: '任务分布控制' })).toHaveCount(0)
    await expect(monitor.getByRole('button', { name: /业务统计|采集页面性能|身份详情/ })).toHaveCount(0)
    await expect(monitor.getByText('子 Agent 详情沿用任务页', { exact: false })).toHaveCount(0)

    const opened = await timerProbe()
    expect(opened.created).toBe(1)
    expect(opened.active).toBeGreaterThanOrEqual(opened.baseline)

    // Leaving the monitor must release its snapshot age timer. The page is
    // still mounted in the Work mode surface, so this catches hidden-page leaks.
    // Use the navigation title so this remains stable when the sidebar is
    // collapsed and the visible text span is clipped.
    await page.locator('button.work-navigation__item[title="工作台"]').click()
    await expect(monitor).toBeHidden()
    await expect.poll(async () => (await timerProbe()).active).toBe(opened.baseline)

    await openMonitor()
    await expect(monitor.getByRole('region', { name: '引擎身份', exact: true })).toBeVisible()
    await expect(monitor.locator('.engine-monitor__task')).toHaveCount(0)
    await expect.poll(async () => (await timerProbe()).active).toBe(opened.baseline + 1)

  })
})
