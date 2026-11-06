/** Real Electron with its engine disabled: clearing the home workspace changes
 * only the saved selection, survives reload, supports keyboard/reselection, and
 * never exposes a reset for existing tasks or drafts that already have files. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { WorkState } from '../src/renderer/src/contrib/work/work-state'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const stateKey = 'aether.work.state.v1', clearLabel = '清除工作区选择，使用默认工作区'
const marker = 'WORKSPACE_CLEAR_MUST_PRESERVE_FILES\n'
const errors: string[] = []
let fixture = '', workspacePath = '', alternatePath = '', otherPath = ''
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page

const work = () => page.locator('.work-view')
const clear = () => work().getByRole('button', { name: clearLabel, exact: true })
const picker = () => work().getByRole('button', { name: '选择工作区', exact: true })
const draft = () => work().getByRole('textbox', { name: '任务目标', exact: true })
const stored = (): Promise<WorkState> => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), stateKey)

function initialState(): WorkState {
  const now = Date.now()
  const source = { path: join(otherPath, 'keep.txt'), name: 'keep.txt', type: 'text/plain', size: Buffer.byteLength(marker) }
  return {
    tasks: [
      { id: 'work-clear-existing-draft', title: '保留既有草稿', draft: 'OTHER_DRAFT', status: 'draft',
        createdAt: now, updatedAt: now, workspacePath: otherPath, modelId: 'other-model', attachments: [], sources: [source],
        agentId: 'other-agent', resources: { skills: ['other-skill'], mcpServers: [], knowledgeBases: [] } },
      { id: 'work-clear-existing-done', title: '保留已运行任务', draft: 'DONE_FOLLOWUP', status: 'done',
        createdAt: now - 1000, updatedAt: now, workspacePath: otherPath, modelId: 'done-model', attachments: [], sources: [], agentLocked: true }
    ],
    activeTaskId: null, homeDraft: 'HOME_DRAFT', homeWorkspacePath: workspacePath, homeAttachments: [],
    homeModelId: 'home-model', homeSessionId: 'work-home-workspace-clear', homeAgentId: 'home-agent', homeMentions: [],
    homeResources: { skills: ['home-skill'], mcpServers: ['home-mcp'], knowledgeBases: ['home-kb'] }
  }
}

async function seed(state: WorkState): Promise<void> {
  await page.evaluate(({ key, state }) => {
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem(key, JSON.stringify(state))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
  }, { key: stateKey, state })
  await page.reload()
  if (state.activeTaskId) {
    await expect(work().getByRole('heading', { name: state.tasks.find(task => task.id === state.activeTaskId)!.title, exact: true })).toBeVisible()
  } else await expect(draft()).toHaveText(state.homeDraft)
}

function expectFilesPreserved(): void {
  for (const directory of [workspacePath, alternatePath, otherPath]) {
    expect(existsSync(directory)).toBe(true)
    expect(readFileSync(join(directory, 'keep.txt'), 'utf8')).toBe(marker)
  }
}

async function chooseFolder(path: string | null): Promise<void> {
  await app!.evaluate(({ dialog }, selected) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original
      return { canceled: selected === null, filePaths: selected ? [selected] : [] }
    }
  }, path)
  await picker().click()
  await expect(picker()).toBeEnabled()
}

test.describe.serial('Work 首页清除工作区选择', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'work-workspace-clear-'))
    workspacePath = join(fixture, 'selected-workspace'); alternatePath = join(fixture, 'reselected-workspace'); otherPath = join(fixture, 'other-task-workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(profile)
    for (const directory of [workspacePath, alternatePath, otherPath]) {
      mkdirSync(directory); writeFileSync(join(directory, 'keep.txt'), marker)
    }
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspacePath, appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-workspace-clear')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    expect(await page.evaluate(() => window.aether.engine.getSnapshot())).toMatchObject({ phase: 'idle', pid: null })
  })

  test.afterEach(async () => {
    expect(errors).toEqual([]); health?.assertHealthy(); expectFilesPreserved()
    expect(await page.evaluate(() => window.aether.engine.getSnapshot())).toMatchObject({ phase: 'idle', pid: null })
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      if (!fixture) return
      const owned = resolve(fixture)
      if (dirname(owned) !== parent || !basename(owned).startsWith('work-workspace-clear-')) throw new Error(`Unsafe workspace-clear cleanup: ${owned}`)
      rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('首页清除保留草稿、选项、其他任务与文件，刷新、重选、取消和键盘操作有效', async ({}, info) => {
    await seed(initialState())
    await expect(picker()).toHaveAttribute('title', workspacePath)
    await expect(clear()).toHaveAttribute('title', clearLabel)
    await page.screenshot({ path: info.outputPath('home-selected-workspace.png'), animations: 'disabled' })
    const before = await stored(), latestDraft = 'HOME_DRAFT_UPDATED_IMMEDIATELY_BEFORE_CLEAR'
    await draft().fill(latestDraft)
    await clear().click()
    const expected = { ...before, homeDraft: latestDraft, homeWorkspacePath: null }
    await expect.poll(stored).toEqual(expected)
    await expect(picker()).toHaveText('默认工作区')
    await expect(picker()).toHaveAttribute('title', /每个任务使用独立沙箱/)
    await expect(picker()).toBeFocused()
    await expect(clear()).toHaveCount(0)
    await expect(draft()).toHaveText(latestDraft)
    await page.screenshot({ path: info.outputPath('home-default-workspace.png'), animations: 'disabled' })
    expectFilesPreserved()
    await page.reload()
    await expect(picker()).toHaveText('默认工作区')
    await expect(clear()).toHaveCount(0)
    await expect(draft()).toHaveText(latestDraft)
    expect(await stored()).toEqual(expected)
    await chooseFolder(alternatePath)
    const selected = { ...expected, homeWorkspacePath: alternatePath }
    await expect.poll(stored).toEqual(selected)
    await expect(picker()).toHaveAttribute('title', alternatePath)
    await expect(clear()).toBeVisible()
    await chooseFolder(null)
    await expect(picker()).toHaveAttribute('title', alternatePath)
    expect(await stored()).toEqual(selected)
    await clear().focus(); await page.keyboard.press('Enter')
    await expect.poll(stored).toEqual(expected)
    await expect(picker()).toHaveText('默认工作区')
    await expect(picker()).toBeFocused()
    await expect(clear()).toHaveCount(0)
  })

  test('既有草稿、已运行任务及首页已有资料时不提供清除入口', async () => {
    for (const taskId of ['work-clear-existing-draft', 'work-clear-existing-done']) {
      const state = initialState(); state.activeTaskId = taskId
      await seed(state)
      await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText(state.tasks.find(task => task.id === taskId)!.draft)
      await expect(clear()).toHaveCount(0)
      expect(await stored()).toEqual(state)
    }
    const state = initialState()
    state.homeAttachments = [{ path: join(workspacePath, 'keep.txt'), name: 'keep.txt', type: 'text/plain', size: Buffer.byteLength(marker) }]
    await seed(state)
    await expect(work().locator('.work-attachments')).toContainText('keep.txt')
    await expect(clear()).toHaveCount(0)
    await expect(picker()).toHaveCount(0)
    expect(await stored()).toEqual(state)
  })
})
