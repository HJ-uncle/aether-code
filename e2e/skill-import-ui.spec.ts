/**
 * 真机：Skill 单文件/ZIP/大包分片导入、拖拽、详情、启停与删除。
 * Electron、文件选择、preload、HTTP bridge、真实引擎及磁盘落盘均走产品实现。
 * 使用独立 profile、全局目录和工作区，不读取或改写开发者已安装的技能。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type { AetherIdeApi } from '../src/preload'

declare global {
  interface Window {
    aether: AetherIdeApi
  }
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const engineRequire = createRequire(join(root, '..', 'ai-agent-engine', 'package.json'))
const { zipSync } = engineRequire('fflate') as {
  zipSync: (entries: Record<string, Uint8Array>, options?: { level: number }) => Uint8Array
}
const singleName = '界面单文件 v1.0'
const zipName = 'e2e-zip-ui'
const chunkName = 'e2e-chunk-ui'
let fixture = ''
let workspace = ''
let profile = ''
let app: ElectronApplication | undefined
let page: Page
const rendererErrors: string[] = []

function markdown(name: string): string {
  return `---\nname: ${name}\ndescription: Skill UI import fixture\n---\n# ${name}\n\nSKILL_UI_BODY_${name}\n`
}

function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'AUTH_ENABLED'].includes(key.toUpperCase())
    )
      env[key] = value
  }
  return {
    ...env,
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    SKILLS_ROOT: join(fixture, 'builtin-skills'),
    WORKSPACE_ROOT: workspace,
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
    ENABLE_LONG_TERM_MEMORY: 'false'
  }
}

async function openSkills(): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible()))
    await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '技能', exact: true }).click()
  await expect(page.locator('.settings-view--skills')).toBeVisible()
}

function card(name: string) {
  return page
    .locator('.skills-card')
    .filter({ has: page.locator('.skills-card__main strong', { hasText: name }) })
}

async function chooseFile(path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择文件…', exact: true }).click()
  await (await chooser).setFiles(path)
}

async function waitImported(name: string): Promise<void> {
  await expect(page.locator('.skills-import-status')).toHaveClass(/is-imported/, {
    timeout: 30_000
  })
  await expect(card(name)).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件…', exact: true })).toBeEnabled()
  await expect(page.locator('.settings-view--skills [role="alert"]')).toHaveCount(0)
}

async function listSkills(): Promise<
  Array<{ id: string; name: string; enabled: boolean; scope: string }>
> {
  const result = await page.evaluate(
    async (projectRoot) =>
      window.aether.engine.request<{
        list: Array<{ id: string; name: string; enabled: boolean; scope: string }>
      }>({ method: 'GET', path: '/skills', query: { path: projectRoot, reload: 1 } }),
    workspace
  )
  expect(result.ok).toBe(true)
  return result.data?.list ?? []
}

test.describe.serial('技能导入管理真机闭环', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'skill-import-ui-'))
    workspace = join(fixture, 'workspace')
    profile = join(fixture, 'profile')
    for (const directory of [workspace, profile, join(fixture, 'builtin-skills')])
      mkdirSync(directory, { recursive: true })
    writeFileSync(join(fixture, 'SKILL.md'), markdown(singleName))
    writeFileSync(
      join(fixture, 'zip-skill.zip'),
      zipSync({
        [`${zipName}/SKILL.md`]: Buffer.from(markdown(zipName)),
        [`${zipName}/reference.txt`]: Buffer.from('ZIP_REFERENCE_BODY')
      })
    )
    // Stored ZIP entries keep the archive itself above the 5 MiB direct-upload
    // threshold and below the 10 MiB per-entry limit without a compression bomb.
    writeFileSync(
      join(fixture, 'chunk-skill.zip'),
      zipSync(
        {
          [`${chunkName}/SKILL.md`]: Buffer.from(markdown(chunkName)),
          [`${chunkName}/reference.txt`]: Buffer.alloc(6 * 1024 * 1024, 65)
        },
        { level: 0 }
      )
    )
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({
        engineMode: 'embedded',
        preferredPort: 12483,
        autoStartEngine: true,
        lastFolder: workspace,
        lastSessionId: 'skill-import-ui-session'
      })
    )
    app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      cwd: root,
      env: launchEnvironment()
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    // The visible label is localized (e.g. `资源WORKSPACE`); the title keeps
    // the canonical absolute path and is the stable assertion for the opened
    // fixture workspace.
    await expect(page.locator('.explorer__root')).toHaveAttribute('title', workspace)
    await openSkills()
  })

  test.afterEach(() => expect(rendererErrors).toEqual([]))

  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('skill-import-ui-'))
      throw new Error('Unsafe skill import fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('真实文件选择导入 SKILL.md，中文名称详情使用稳定管理 ID', async () => {
    await chooseFile(join(fixture, 'SKILL.md'))
    await waitImported(singleName)
    const installed = join(workspace, '.ae', 'skills', 'imported-skill', 'SKILL.md')
    await expect.poll(() => existsSync(installed)).toBe(true)
    expect(readFileSync(installed, 'utf8')).toBe(markdown(singleName))
    expect(existsSync(join(workspace, '.aether', 'skills'))).toBe(false)
    expect(existsSync(join(workspace, 'SKILLs'))).toBe(false)
    const imported = (await listSkills()).find((skill) => skill.name === singleName)
    expect(imported?.id).toMatch(/^skill-[a-f0-9]{32}$/)
    expect(imported?.scope).toBe('project')
    await card(singleName).locator('.skills-card__main').click()
    await expect(page.locator('.skills-detail pre')).toContainText(`SKILL_UI_BODY_${singleName}`)
    await expect(page.locator('.skills-detail__meta')).toContainText('已启用')
    await expect(page.locator('.skills-history-row').filter({ hasText: 'SKILL.md' })).toContainText(
      '已导入'
    )
  })

  test('停用和重新启用真实落盘，刷新后管理列表保留停用项', async () => {
    const toggle = card(singleName).getByRole('switch', { name: `${singleName} 启用`, exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(
        () =>
          JSON.parse(
            readFileSync(join(workspace, '.ae', 'skills', 'skills.config.json'), 'utf8')
          ).defaults['imported-skill'].enabled
      )
      .toBe(false)
    expect((await listSkills()).find((skill) => skill.name === singleName)?.enabled).toBe(false)
    await page
      .locator('.skills-list-head')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(card(singleName)).toContainText('已停用')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect((await listSkills()).find((skill) => skill.name === singleName)?.enabled).toBe(true)
  })

  test('可以直接创建普通 Markdown 技能，不要求先准备 frontmatter 压缩包', async () => {
    await page.getByRole('button', { name: '直接创建技能', exact: true }).click()
    await page.getByLabel('新技能名称', { exact: true }).fill('Direct UI Skill')
    await page.getByLabel('新技能正文', { exact: true }).fill('# Direct UI Skill\n\nDIRECT_CREATE_MARKER')
    await page.getByRole('button', { name: '创建技能', exact: true }).click()
    await expect(card('direct-ui-skill')).toBeVisible()
    const installed = join(workspace, '.ae', 'skills', 'direct-ui-skill', 'SKILL.md')
    await expect.poll(() => existsSync(installed)).toBe(true)
    expect(readFileSync(installed, 'utf8')).toContain('DIRECT_CREATE_MARKER')
    expect((await listSkills()).find((skill) => skill.name === 'direct-ui-skill')?.enabled).toBe(true)
  })

  test('拖拽 ZIP 导入全局层并校验附带文件', async () => {
    await page.getByRole('button', { name: '技能导入层级', exact: true }).click()
    await page.getByRole('menuitem', { name: '全局层', exact: true }).click()
    const bytes = [...readFileSync(join(fixture, 'zip-skill.zip'))]
    const dataTransfer = await page.evaluateHandle(
      ({ data }) => {
        const transfer = new DataTransfer()
        transfer.items.add(
          new File([new Uint8Array(data)], 'zip-skill.zip', { type: 'application/zip' })
        )
        return transfer
      },
      { data: bytes }
    )
    try {
      await page.locator('.skills-import-drop').dispatchEvent('drop', { dataTransfer })
    } finally {
      await dataTransfer.dispose()
    }
    await waitImported(zipName)
    const installed = join(fixture, 'global', 'skills', zipName, 'reference.txt')
    await expect.poll(() => existsSync(installed)).toBe(true)
    expect(readFileSync(installed, 'utf8')).toBe('ZIP_REFERENCE_BODY')
    expect((await listSkills()).find((skill) => skill.name === zipName)?.scope).toBe('global')
    expect(existsSync(join(workspace, '.ae', 'skills', zipName))).toBe(false)
    await card(zipName).locator('.skills-card__main').click()
    await expect(page.locator('.skills-detail__meta')).toContainText('2 个文件')
    await expect(
      page.locator('.skills-history-row').filter({ hasText: 'zip-skill.zip' })
    ).toContainText('已导入')
  })

  test('大于 5 MiB 的 ZIP 自动分片、合并并完整落盘', async () => {
    await page.getByRole('button', { name: '技能导入层级', exact: true }).click()
    await page.getByRole('menuitem', { name: '项目层', exact: true }).click()
    const archive = join(fixture, 'chunk-skill.zip')
    expect(statSync(archive).size).toBeGreaterThan(5 * 1024 * 1024)
    await chooseFile(archive)
    await waitImported(chunkName)
    const reference = join(workspace, '.ae', 'skills', chunkName, 'reference.txt')
    await expect.poll(() => existsSync(reference)).toBe(true)
    expect(readFileSync(reference)).toEqual(Buffer.alloc(6 * 1024 * 1024, 65))
    const history = await page.evaluate(
      async (projectRoot) =>
        window.aether.engine.request<
          Array<{
            filename: string
            status: string
            uploadedChunks: number[]
            projectRoot?: string
          }>
        >({ method: 'GET', path: '/skills/imports', query: { scope: 'project', projectRoot } }),
      workspace
    )
    expect(history.ok).toBe(true)
    const imported = history.data?.find((item) => item.filename === 'chunk-skill.zip')
    expect(imported?.status).toBe('imported')
    expect(imported?.uploadedChunks).toEqual([0, 1, 2, 3])
    expect(imported?.projectRoot).toBe(workspace)
    await expect(
      page.locator('.skills-history-row').filter({ hasText: 'chunk-skill.zip' })
    ).toContainText('已导入')
  })

  test('从界面删除项目与全局技能，同时清除实际技能目录', async () => {
    for (const [name, directory] of [
      [singleName, join(workspace, '.ae', 'skills', 'imported-skill')],
      [zipName, join(fixture, 'global', 'skills', zipName)],
      [chunkName, join(workspace, '.ae', 'skills', chunkName)],
      ['direct-ui-skill', join(workspace, '.ae', 'skills', 'direct-ui-skill')]
    ]) {
      await card(name).getByRole('button', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '删除技能？', exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '删除技能', exact: true }).click()
      await expect(card(name)).toHaveCount(0)
      await expect.poll(() => existsSync(directory)).toBe(false)
      expect((await listSkills()).some((skill) => skill.name === name)).toBe(false)
    }
  })
})
