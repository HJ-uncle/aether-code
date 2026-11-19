/** Real Electron connection harness; tests opt out of captures when randomized credentials are present. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AppSettings, EngineSnapshot } from '../../src/shared/ipc'
import { EngineCandidateFixture } from './engine-candidate'
import {
  ResourceSettingsFixture,
  resourceModel,
  resourceToken,
  resourceWorkspace
} from './resource-settings'

const root = resolve(__dirname, '../..'),
  profiles = join(root, '.e2e-tmp', 'engine-connection-flow')
const onlyForA = 'advanced-fixture-key-only-for-engine-a'
let app: ElectronApplication | undefined,
  a: ResourceSettingsFixture,
  b: EngineCandidateFixture,
  page: Page,
  profile = ''
const settings = (): Locator => page.getByRole('dialog', { name: '设置', exact: true })
const draft = (): Locator => settings().getByTestId('engine-connection-draft')
const address = (): Locator => draft().getByRole('textbox', { name: '服务地址', exact: true })
const action = (): Locator => draft().getByTestId('engine-connection-primary')
const current = (): Locator => settings().getByRole('region', { name: '当前引擎连接', exact: true })
const live = (): Promise<EngineSnapshot> => page.evaluate(() => window.aether.engine.getSnapshot())
const saved = (): Promise<AppSettings> => page.evaluate(() => window.aether.settings.get())
async function open(): Promise<void> {
  await page.locator('.status-bar__engine button').click()
  await expect(draft()).toBeVisible()
}
async function advanced(): Promise<void> {
  const summary = draft()
    .locator('summary')
    .filter({ hasText: /^高级设置$/ })
  if (!(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open)))
    await summary.click()
}
async function launch(
  initial: 'a' | 'b' | 'local' = 'a',
  options: { autoStart?: boolean; engineEntry?: string; preferredPort?: number } = {}
): Promise<void> {
  const url = initial === 'a' ? a.origin : b.origin
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      engineMode: initial === 'local' ? 'embedded' : 'remote',
      remoteBaseUrl: url,
      remoteWorkspaceRoot: initial === 'local' ? '' : resourceWorkspace,
      autoStartEngine: options.autoStart ?? true,
      ...(options.preferredPort ? { preferredPort: options.preferredPort } : {}),
      lastSessionId: '',
      lastFolder: '',
      lastModelId: resourceModel,
      appearance: 'light',
      thinkingMode: 'off'
    })
  )
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).flatMap(([k, v]) =>
      v === undefined ||
      /^(?:ELECTRON_|AETHER_|OPENAI_|ANTHROPIC_|DEEPSEEK_|WORKSPACE_|SKILLS_|MCP_|MEMORY_|HISTORY_|AUTH_|ENCRYPTION_KEY$|DATA_DIR$|LLM_|QA_|OSM_|LOG_|DEFAULT_SECURITY_MODE$|ENABLE_LONG_TERM_MEMORY$)/i.test(
        k
      )
        ? []
        : [[k, v]]
    )
  )
  if (options.engineEntry) env.AETHER_IDE_ENGINE_ENTRY = options.engineEntry
  Object.assign(env, {
    WORKSPACE_ROOT: join(profile, 'workspace'),
    MEMORY_DB_PATH: join(profile, 'engine', 'state', 'memory.db'),
    SKILLS_ROOT: join(profile, 'skills'),
    MCP_CONFIG_PATH: join(profile, 'mcp.json'),
    PROGRAMDATA: join(profile, 'managed'),
    AUTH_ENABLED: 'false',
    ENABLE_LONG_TERM_MEMORY: 'false',
    HISTORY_BACKEND: 'jsonl',
    QA_LOG_ENABLED: 'false',
    QA_LOG_DIR: join(profile, 'qa')
  })
  Object.assign(env, {
    AETHER_IDE_REMOTE_INSTANCE_TOKEN: resourceToken,
    AETHER_IDE_REMOTE_INSTANCE_TOKEN_URL: a.origin,
    AETHER_IDE_REMOTE_API_KEY: onlyForA,
    AETHER_IDE_REMOTE_AUTH_URL: a.origin,
    AETHER_GLOBAL_DIR: join(profile, 'global')
  })
  app = await electron.launch({
    args: [
      process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'),
      `--user-data-dir=${profile}`
    ],
    cwd: root,
    env
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('crash', () => errors.push('Renderer crashed'))
  // Keep the physical pointer on the shared Windows desktop out of this test window.
  // Playwright still hits real renderer controls, including the modal backdrop.
  if (process.platform === 'win32')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true)
    )
  if (initial === 'a')
    await expect
      .poll(live, { timeout: 90000 })
      .toMatchObject({ phase: 'ready', baseUrl: a.origin, instanceId: 'resource-settings-fixture' })
}
async function stillA(): Promise<void> {
  await expect
    .poll(live)
    .toMatchObject({ phase: 'ready', baseUrl: a.origin, instanceId: 'resource-settings-fixture' })
  expect((await saved()).remoteBaseUrl).toBe(a.origin)
  const model = await page.evaluate(() =>
    window.aether.engine.request<Array<{ id: string }>>({ method: 'GET', path: '/models' })
  )
  expect(model.ok).toBe(true)
  expect(model.data?.some((m) => m.id === resourceModel)).toBe(true)
}
async function size(width: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(520, 600)
    win.setContentSize(w, 850)
  }, width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}
const errors: string[] = []
export {
  app,
  root,
  profile,
  a,
  b,
  page,
  settings,
  draft,
  address,
  action,
  current,
  live,
  saved,
  open,
  advanced,
  launch,
  stillA,
  size
}

function removeTestProfile(directory: string): void {
  const target = resolve(directory)
  if (dirname(target) !== profiles || !basename(target).startsWith('profile-'))
    throw new Error('Invalid fixture cleanup path')
  rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}

export function registerConnectionHarness({ captureOnFailure = true } = {}): void {
  test.beforeEach(async () => {
    mkdirSync(profiles, { recursive: true })
    profile = mkdtempSync(join(profiles, 'profile-'))
    errors.length = 0
    a = new ResourceSettingsFixture()
    b = new EngineCandidateFixture()
    await Promise.all([a.start(), b.start()])
  })
  test.afterEach(async () => {
    const info = test.info()
    try {
      if (
        info.status !== info.expectedStatus &&
        captureOnFailure &&
        app &&
        page &&
        !page.isClosed()
      )
        await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => undefined)
      expect(a.errors).toEqual([])
      expect(errors).toEqual([])
      // B must never receive A's instance token or advanced identity, even on public discovery or a failed switch.
      expect(b.requests.some((r) => r.token === resourceToken || r.apiKey === onlyForA)).toBe(false)
    } finally {
      b.release()
      try {
        await app?.close()
      } finally {
        app = undefined
        await Promise.all([a.close(), b.close()])
        removeTestProfile(profile)
      }
    }
  })
}
