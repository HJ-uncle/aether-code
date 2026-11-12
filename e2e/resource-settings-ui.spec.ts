/** Real Electron resource settings: themes/layout, skill creation and multipart
 * import, knowledge collections/documents/retrieval, memory scopes/preferences/
 * CRUD, and nested keyboard/dialog behavior. All writes target an HTTP fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { ResourceSettingsFixture, initialResourceDocuments, initialResourceMemories, initialResourceSkills,
  resourceModel, resourceTasks, resourceToken, resourceWorkspace } from './fixtures/resource-settings'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/resource-settings')
const fixture = new ResourceSettingsFixture(), errors: string[] = []
let app: ElectronApplication | undefined, page: Page, profile = ''
type Section = '技能' | '知识库' | '记忆'
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const skills = () => settings().locator('.settings-view--skills')
const knowledge = () => settings().locator('.settings-view--knowledge')
const memory = () => settings().locator('.memory-settings')
const skill = (id: string, scope = 'project') => skills().getByRole('list', { name: '已安装技能', exact: true }).locator(`[data-skill-id="${id}"][data-skill-scope="${scope}"]`)
const documentRow = (name: string) => knowledge().getByRole('region', { name: '知识库文档', exact: true }).getByRole('article', { name, exact: true })
const memoryRow = (name: string) => memory().getByRole('list', { name: '记忆列表', exact: true }).getByRole('listitem', { name, exact: true })
const dialog = (name: string) => page.getByRole('dialog', { name, exact: true })
const writes = (prefix: string) => fixture.receipts.filter(item => item.path.startsWith('/api/v1/' + prefix) && item.method !== 'GET')

async function windowSize(width = 1320, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height) }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function openSettings(section: Section, appearance: 'light' | 'dark' = 'light', width = 1320): Promise<void> {
  await windowSize(width)
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(settings()).toBeVisible()
  await settings().getByRole('tab', { name: '外观', exact: true }).click()
  await settings().getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await selectSection(section)
}
async function selectSection(section: Section): Promise<void> {
  await settings().getByRole('tab', { name: section, exact: true }).click()
  if (section === '技能') await expect(skill('project-notes')).toBeVisible()
  if (section === '知识库') await expect(documentRow('设计规范.md')).toBeVisible()
  if (section === '记忆') await expect(memoryRow('偏好简洁中文')).toBeVisible()
}
async function choose(container: Locator, name: string, option: string): Promise<void> {
  await container.getByRole('button', { name, exact: true }).click()
  await page.getByRole('menu', { name, exact: true }).getByRole('menuitem', { name: option, exact: true }).click()
}
async function menu(row: Locator, label: string): Promise<Locator> {
  await row.getByRole('button', { name: label + ' 的更多操作', exact: true }).click()
  const result = dialog(label + ' 的操作'); await expect(result).toBeVisible(); return result
}
async function escape(target: Locator): Promise<void> { await page.keyboard.press('Escape'); await expect(target).toBeHidden() }
async function noOverflow(container: Locator): Promise<void> {
  expect(await container.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const bounds = await container.boundingBox(); expect(bounds).not.toBeNull()
  for (const button of await container.getByRole('button').all()) {
    if (!await button.isVisible()) continue
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
  }
}
async function footerVisible(target: Locator, action: string): Promise<void> {
  await expect(target.locator('.modal__footer').getByRole('button', { name: action, exact: true })).toBeInViewport({ ratio: 1 })
  await noOverflow(target)
}
async function shot(name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`); await page.screenshot({ path, animations: 'disabled' })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); profile = mkdtempSync(join(fixtureRoot, 'profile-')); await fixture.start()
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: fixture.origin, remoteWorkspaceRoot: resourceWorkspace,
    autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: resourceModel, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN',
    'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = resourceToken; env.AETHER_GLOBAL_DIR = join(profile, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1320, 900); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})
test.beforeEach(async () => {
  fixture.reset()
  const key = `aether.work.state.v1:${encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: fixture.origin }))}`
  await page.evaluate(({ key, tasks, model, workspace }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks: tasks.map(task => ({ ...task, status: 'done', draft: '', mentions: [],
      createdAt: Date.now(), updatedAt: Date.now(), modelId: model, attachments: [], sources: [] })), activeTaskId: tasks[0].id, homeDraft: '', homeWorkspacePath: workspace }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 60 }))
  }, { key, tasks: resourceTasks, model: resourceModel, workspace: resourceWorkspace })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('.work-task-heading h1')).toHaveText(resourceTasks[0].title)
  await expect(page.locator('.work-view')).toContainText('RESOURCE_SETTINGS_READY')
})
test.afterEach(async ({}, info) => {
  fixture.releaseChunk(); fixture.releaseMemory()
  if (page && !page.isClosed()) await shot('resource-settings-final')
  await info.attach('resource-http-receipts', { body: JSON.stringify({ receipts: fixture.receipts,
    uploads: fixture.uploads.map(upload => ({ ...upload, bytes: upload.bytes.length, sha256: createHash('sha256').update(upload.bytes).digest('hex') })) }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(fixture.errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    await fixture.close()
    if (profile) { const target = resolve(profile)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const appearance of ['light', 'dark'] as const) for (const width of [1320, 760]) {
  test(`${appearance} / ${width}：三类资源以列表为主，隐藏创建表单且操作不溢出`, async () => {
    await openSettings('技能', appearance, width)
    await expect(skills().getByRole('listitem')).toHaveCount(2)
    await expect(skill('project-notes').getByRole('switch', { name: 'project-notes 启用', exact: true })).toBeChecked()
    await expect(skill('global-review', 'global').getByRole('switch', { name: 'global-review 启用', exact: true })).not.toBeChecked()
    for (const name of ['刷新技能', '导入技能', '创建技能']) await expect(skills().getByRole('button', { name, exact: true })).toBeVisible()
    await expect(skills().locator('textarea:visible')).toHaveCount(0); await noOverflow(skills()); await shot(`skills-${appearance}-${width}`)
    await selectSection('知识库')
    for (const name of ['刷新知识库', '新建知识库', '导入文档', '检索测试']) await expect(knowledge().getByRole('button', { name, exact: true })).toBeVisible()
    await expect(knowledge().getByRole('article')).toHaveCount(2)
    await expect(knowledge().locator('textarea:visible')).toHaveCount(0); await noOverflow(knowledge()); await shot(`knowledge-${appearance}-${width}`)
    await selectSection('记忆')
    await expect(memory().getByRole('listitem')).toHaveCount(2)
    for (const name of ['刷新记忆', '新建记忆']) await expect(memory().getByRole('button', { name, exact: true })).toBeVisible()
    await expect(memory().locator('textarea:visible')).toHaveCount(0); await noOverflow(memory()); await shot(`memory-${appearance}-${width}`)
    expect(fixture.receipts.filter(item => item.method !== 'GET')).toEqual([])
  })
}

test('技能创建保留正文与项目范围，详情、启停和删除只操作对应技能', async () => {
  await openSettings('技能', 'dark', 760)
  await skills().getByRole('button', { name: '创建技能', exact: true }).click()
  const create = dialog('创建技能')
  await create.getByRole('textbox', { name: '新技能名称', exact: true }).fill(' Release Notes ')
  await create.getByRole('textbox', { name: '新技能描述', exact: true }).fill('发布说明与变更检查')
  const content = '# 发布检查\n\n1. 检查变更。\n2. 保留来源与 Unicode 😀。'
  await create.getByRole('textbox', { name: '新技能正文', exact: true }).fill(content)
  await footerVisible(create, '创建技能'); await create.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(create).toBeHidden(); await expect(skill('release-notes')).toBeVisible()
  expect(writes('skills')[0]).toEqual({ method: 'POST', path: '/api/v1/skills', query: {},
    body: { name: 'release-notes', description: '发布说明与变更检查', content, scope: 'project', overwrite: false, projectRoot: resourceWorkspace } })
  await skill('release-notes').getByRole('button', { name: '查看技能：release-notes', exact: true }).click()
  const detail = dialog('技能详情 · release-notes'); await expect(detail).toContainText(content)
  await escape(detail)
  await skill('release-notes').getByRole('switch', { name: 'release-notes 启用', exact: true }).click()
  await expect.poll(() => fixture.skills.find(item => item.id === 'release-notes')?.enabled).toBe(false)
  expect(writes('skills').at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/skills/release-notes', query: { path: resourceWorkspace, scope: 'project' }, body: { enabled: false } })
  await (await menu(skill('release-notes'), '技能 release-notes')).getByRole('button', { name: '删除技能', exact: true }).click()
  const confirmation = dialog('删除技能？'); await expect(confirmation).toContainText('release-notes'); await escape(confirmation)
  expect(writes('skills').filter(item => item.method === 'DELETE')).toEqual([])
  await (await menu(skill('release-notes'), '技能 release-notes')).getByRole('button', { name: '删除技能', exact: true }).click()
  await confirmation.getByRole('button', { name: '删除技能', exact: true }).click()
  await expect(skill('release-notes')).toHaveCount(0)
  expect(writes('skills').at(-1)).toEqual({ method: 'DELETE', path: '/api/v1/skills/release-notes', query: { path: resourceWorkspace, scope: 'project' }, body: {} })
  expect(fixture.skills).toEqual(initialResourceSkills)
})

test('技能文件经真实 multipart 导入，保留全局层、冲突策略、字节和 SHA-256', async () => {
  await openSettings('技能')
  await skills().getByRole('button', { name: '导入技能', exact: true }).click()
  const target = dialog('导入技能')
  await choose(target, '技能导入层级', '全局层'); await choose(target, '技能冲突处理策略', '拒绝冲突')
  const bytes = Buffer.from('---\nname: imported-guide\ndescription: 导入回归\n---\n\n# 指南\r\n保留中文与末尾空格。  \r\n')
  await target.getByLabel('技能文件', { exact: true }).setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: bytes })
  await expect(target.getByRole('status')).toContainText('已导入')
  expect(fixture.uploads).toHaveLength(1)
  expect(fixture.uploads[0]).toEqual({ path: '/api/v1/skills/imports', filename: 'SKILL.md', type: 'text/markdown', bytes,
    fields: { filename: 'SKILL.md', scope: 'global', conflictStrategy: 'reject', fileSha256: createHash('sha256').update(bytes).digest('hex') } })
  await target.getByRole('button', { name: '完成', exact: true }).click()
  await expect(skill('imported-guide', 'global')).toBeVisible()
  expect(fixture.skills.find(item => item.id === 'imported-guide')?.content).toBe(bytes.toString('utf8'))
})

test('取消技能导入先等待当前分片完成，之后不上传下一片或提交合并', async () => {
  await openSettings('技能')
  await skills().getByRole('button', { name: '导入技能', exact: true }).click()
  const target = dialog('导入技能'), bytes = Buffer.alloc(6 * 1024 * 1024, 'a')
  fixture.holdChunkIndex = 1
  await target.getByLabel('技能文件', { exact: true }).setInputFiles({ name: 'large-guide.md', mimeType: 'text/markdown', buffer: bytes })
  await expect.poll(() => Boolean(fixture.heldChunk)).toBe(true)
  const importId = fixture.heldChunk!.importId
  await expect(target.getByRole('status')).toContainText('已上传分片 1/3')
  await target.getByRole('button', { name: '取消导入', exact: true }).click()
  await expect(target.getByRole('button', { name: '取消中…', exact: true })).toBeDisabled()
  expect(writes('skills').filter(item => item.method === 'DELETE')).toEqual([])
  expect(fixture.uploads.map(upload => upload.fields.chunkIndex)).toEqual(['0', '1'])
  fixture.releaseChunk()
  await expect(target.getByRole('status')).toHaveText('已取消')
  await expect(target.getByRole('button', { name: '选择文件…', exact: true })).toBeEnabled()
  expect(writes('skills').map(item => [item.method, item.path])).toEqual([
    ['POST', '/api/v1/skills/imports/chunks'], ['POST', '/api/v1/skills/imports/chunks'], ['DELETE', `/api/v1/skills/imports/${importId}`]
  ])
  expect(fixture.uploads.map(upload => upload.fields.chunkIndex)).toEqual(['0', '1'])
  for (const upload of fixture.uploads) {
    expect(upload.fields.fileSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(upload.bytes.equals(bytes.subarray(Number(upload.fields.chunkIndex) * 2 * 1024 * 1024, (Number(upload.fields.chunkIndex) + 1) * 2 * 1024 * 1024))).toBe(true)
  }
  expect(fixture.skills).toEqual(initialResourceSkills)
  expect(fixture.imports[0].status).toBe('cancelled')
  await target.getByRole('button', { name: '完成', exact: true }).click()
  const history = skills().locator('details').filter({ has: page.locator('summary').filter({ hasText: /^导入历史$/ }) })
  await history.locator('summary').click()
  await expect(history.getByRole('listitem')).toContainText('large-guide.md')
  await expect(history.getByRole('listitem')).toContainText('已取消')
  await expect(history.getByRole('button', { name: /取消导入/ })).toHaveCount(0)
})

test('知识库集合、文本上传、文档详情编辑和检索始终使用所选集合', async () => {
  await openSettings('知识库', 'dark', 760)
  await knowledge().getByRole('button', { name: '新建知识库', exact: true }).click()
  const create = dialog('新建知识库')
  await create.getByRole('textbox', { name: '知识库名称', exact: true }).fill('新建项目资料')
  await create.getByRole('textbox', { name: '知识库描述', exact: true }).fill('当前项目的验证资料')
  await footerVisible(create, '创建知识库'); await create.getByRole('button', { name: '创建知识库', exact: true }).click()
  await expect(create).toBeHidden()
  await expect.poll(() => fixture.bases.some(base => base.name === '新建项目资料')).toBe(true)
  const base = fixture.bases.find(base => base.name === '新建项目资料')!
  expect(writes('knowledge')[0]).toEqual({ method: 'POST', path: '/api/v1/knowledge/bases', query: {}, body: { name: base.name, description: '当前项目的验证资料' } })
  await expect(knowledge().getByRole('button', { name: '当前知识库', exact: true })).toContainText(base.name)
  await expect(documentRow('设计规范.md')).toHaveCount(0)
  await knowledge().getByRole('button', { name: '导入文档', exact: true }).click()
  const upload = dialog('导入文档'); await upload.getByRole('radio', { name: '文本', exact: true }).click()
  const content = '# 验证资料\n\n检索标记 ALPHA_ONLY，保留完整正文。  \n'
  await upload.getByRole('textbox', { name: '文档文件名', exact: true }).fill('验证资料.md')
  await upload.getByRole('textbox', { name: '文档内容', exact: true }).fill(content)
  await footerVisible(upload, '上传并索引'); await upload.getByRole('button', { name: '上传并索引', exact: true }).click()
  await expect(documentRow('验证资料.md')).toBeVisible()
  const stored = fixture.documents.find(document => document.filename === '验证资料.md')!
  expect(writes('knowledge').at(-1)).toEqual({ method: 'POST', path: '/api/v1/knowledge/documents', query: {}, body: { filename: '验证资料.md', content, knowledgeBaseId: base.id } })
  await (await menu(documentRow('验证资料.md'), '验证资料.md')).getByRole('button', { name: '查看详情', exact: true }).click()
  const detail = dialog('文档详情'); await expect(detail).toContainText('ALPHA_ONLY')
  const writesBeforeEdit = writes('knowledge').length
  await detail.getByRole('button', { name: '编辑文档', exact: true }).click()
  const edit = dialog('编辑文档'), updated = content + '\n追加检索证据。'
  await expect(edit).toBeVisible()
  await expect(edit.getByRole('textbox', { name: '编辑文档文件名', exact: true })).toBeEnabled()
  await expect(edit.getByRole('textbox', { name: '编辑文档内容', exact: true })).toBeEnabled()
  expect(writes('knowledge')).toHaveLength(writesBeforeEdit)
  await edit.getByRole('textbox', { name: '编辑文档文件名', exact: true }).fill('验证资料更新.md')
  await edit.getByRole('textbox', { name: '编辑文档内容', exact: true }).fill(updated)
  await shot('knowledge-document-editor-draft')
  expect(writes('knowledge')).toHaveLength(writesBeforeEdit)
  await edit.getByRole('button', { name: '保存文档', exact: true }).click()
  await expect.poll(() => fixture.documents.find(document => document.id === stored.id)?.content).toBe(updated)
  await expect(detail).toBeVisible(); await escape(detail)
  await expect(documentRow('验证资料更新.md')).toBeVisible()
  expect(writes('knowledge').slice(writesBeforeEdit)).toEqual([{ method: 'PUT', path: `/api/v1/knowledge/documents/${stored.id}`, query: {}, body: { filename: '验证资料更新.md', content: updated } }])
  await knowledge().getByRole('button', { name: '检索测试', exact: true }).click()
  const search = dialog('检索测试')
  await search.getByRole('textbox', { name: '知识库检索关键词', exact: true }).fill('ALPHA_ONLY')
  await search.getByRole('button', { name: '检索', exact: true }).click()
  await expect(search).toContainText('验证资料更新.md'); await expect(search).toContainText('追加检索证据')
  expect(writes('knowledge').at(-1)).toEqual({ method: 'POST', path: '/api/v1/knowledge/search', query: {}, body: { query: 'ALPHA_ONLY', limit: 8, knowledgeBaseIds: [base.id] } })
  await shot('knowledge-retrieval-results')
  await escape(search)
  await (await menu(documentRow('验证资料更新.md'), '验证资料更新.md')).getByRole('button', { name: '删除', exact: true }).click()
  await dialog('删除文档？').getByRole('button', { name: '删除文档', exact: true }).click()
  await expect(documentRow('验证资料更新.md')).toHaveCount(0)
  expect(fixture.documents).toEqual(initialResourceDocuments)
  await (await menu(knowledge(), base.name)).getByRole('button', { name: '编辑知识库', exact: true }).click()
  const editBase = dialog('编辑知识库')
  await editBase.getByRole('textbox', { name: '编辑知识库名称', exact: true }).fill('资料归档')
  await editBase.getByRole('textbox', { name: '编辑知识库描述', exact: true }).fill('已完成验证的项目资料')
  await editBase.getByRole('button', { name: '保存知识库', exact: true }).click()
  await expect(editBase).toBeHidden()
  expect(writes('knowledge').at(-1)).toEqual({ method: 'PUT', path: `/api/v1/knowledge/bases/${base.id}`, query: {}, body: { name: '资料归档', description: '已完成验证的项目资料' } })
  await (await menu(knowledge(), '资料归档')).getByRole('button', { name: '删除知识库', exact: true }).click()
  const deleteBase = dialog('删除知识库？'); await escape(deleteBase)
  expect(fixture.bases.some(item => item.id === base.id)).toBe(true)
  await (await menu(knowledge(), '资料归档')).getByRole('button', { name: '删除知识库', exact: true }).click()
  await deleteBase.getByRole('button', { name: '删除知识库', exact: true }).click()
  await expect.poll(() => fixture.bases.some(item => item.id === base.id)).toBe(false)
  await expect(knowledge().getByRole('button', { name: '当前知识库', exact: true })).toContainText('全部知识库')
  expect(fixture.documents).toEqual(initialResourceDocuments)
  await choose(knowledge(), '当前知识库', '团队手册')
  await expect(documentRow('团队流程.txt')).toBeVisible(); await expect(documentRow('设计规范.md')).toHaveCount(0)
  expect(fixture.receipts.filter(item => item.path === '/api/v1/knowledge/documents' && item.method === 'GET').at(-1)?.query).toEqual({ knowledgeBaseId: 'base-beta' })
})

test('知识库文件上传保留完整字节，所选集合过滤和取消操作不影响其他文档', async () => {
  await openSettings('知识库')
  await choose(knowledge(), '当前知识库', '项目资料')
  await knowledge().getByRole('button', { name: '导入文档', exact: true }).click()
  const upload = dialog('导入文档'), bytes = Buffer.from('文件导入保留 CRLF。\r\n第二行保留空格。  \r\n')
  await upload.getByLabel('选择文档文件', { exact: true }).setInputFiles({ name: 'file-import.txt', mimeType: 'text/plain', buffer: bytes })
  await upload.getByRole('button', { name: '上传并索引', exact: true }).click()
  await expect(documentRow('file-import.txt')).toBeVisible()
  expect(fixture.uploads).toEqual([{ path: '/api/v1/knowledge/documents', fields: { knowledgeBaseId: 'base-alpha' }, filename: 'file-import.txt', type: 'text/plain', bytes }])
  await (await menu(documentRow('file-import.txt'), 'file-import.txt')).getByRole('button', { name: '删除', exact: true }).click()
  await dialog('删除文档？').getByRole('button', { name: '取消', exact: true }).click()
  expect(fixture.documents.find(document => document.filename === 'file-import.txt')?.content).toBe(bytes.toString('utf8'))
  expect(writes('knowledge').filter(item => item.method === 'DELETE')).toEqual([])
})

test('记忆偏好独立保存，全局和会话开关不改变任何记忆条目', async () => {
  await openSettings('记忆')
  const global = memory().getByRole('switch', { name: '全局记忆', exact: true })
  const session = memory().getByRole('switch', { name: '默认开启会话记忆', exact: true })
  await expect(global).not.toBeChecked(); await expect(session).not.toBeChecked()
  await global.click(); await expect(global).toBeChecked()
  await session.click(); await expect(session).toBeChecked()
  await global.click(); await expect(global).not.toBeChecked()
  expect(writes('memory')).toEqual([
    { method: 'PUT', path: '/api/v1/memory/preferences', query: {}, body: { globalEnabled: true } },
    { method: 'PUT', path: '/api/v1/memory/preferences', query: {}, body: { sessionDefaultEnabled: true } },
    { method: 'PUT', path: '/api/v1/memory/preferences', query: {}, body: { globalEnabled: false } }
  ])
  expect(fixture.memories).toEqual(initialResourceMemories)
})

test('已有记忆的重要度不是 0.05 的倍数时，只改摘要仍能保存并保留原值', async () => {
  await openSettings('记忆')
  await (await menu(memoryRow('偏好简洁中文'), '偏好简洁中文')).getByRole('button', { name: '编辑', exact: true }).click()
  const edit = dialog('编辑记忆')
  await expect(edit.getByRole('spinbutton', { name: '重要度', exact: true })).toHaveValue('0.73')
  await edit.getByRole('textbox', { name: '记忆摘要', exact: true }).fill('偏好简洁中文段落')
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(edit).toBeHidden()
  await expect(memoryRow('偏好简洁中文段落')).toBeVisible()
  expect(writes('memory')).toEqual([{ method: 'PUT', path: '/api/v1/memory/memory-global', query: { scope: 'global' },
    body: { summary: '偏好简洁中文段落', type: 'preference', detail: initialResourceMemories[0].detail,
      importance: 0.73, tags: ['语言', '表达'] } }])
  expect(fixture.memories.find(item => item.id === 'memory-global')).toEqual({ ...initialResourceMemories[0], summary: '偏好简洁中文段落' })
})

test('删除末页唯一一条记忆后重新读取有效上一页并更新总数', async () => {
  for (let index = 1; index <= 19; index++) fixture.memories.push({
    id: `memory-page-${index}`, scope: 'global', type: 'fact', summary: `分页记忆 ${index}`, detail: `第 ${index} 条分页夹具`, importance: 0.5, tags: [], createdAt: 1_700_000_000 + index
  })
  await openSettings('记忆')
  await expect(memory().getByRole('listitem')).toHaveCount(20)
  const pager = memory().getByRole('navigation', { name: '记忆分页', exact: true })
  await expect(pager).toContainText('1 / 2 · 共 21 条')
  await pager.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(pager).toContainText('2 / 2 · 共 21 条')
  await expect(memory().getByRole('listitem')).toHaveCount(1)
  await expect(memoryRow('分页记忆 19')).toBeVisible()
  const readCount = fixture.receipts.filter(item => item.path === '/api/v1/memory/list').length
  await (await menu(memoryRow('分页记忆 19'), '分页记忆 19')).getByRole('button', { name: '删除', exact: true }).click()
  await dialog('删除记忆？').getByRole('button', { name: '删除记忆', exact: true }).click()
  await expect(memoryRow('偏好简洁中文')).toBeVisible()
  await expect(memory().getByRole('listitem')).toHaveCount(20)
  await expect(memoryRow('分页记忆 19')).toHaveCount(0)
  await expect(pager).toHaveCount(0)
  await expect(memory().getByRole('region', { name: '记忆条目', exact: true }).locator('.resource-header h2')).toHaveText(/记忆条目\s*20/)
  expect(fixture.memories.filter(item => item.scope === 'global')).toHaveLength(20)
  expect(fixture.receipts.filter(item => item.path === '/api/v1/memory/list').slice(readCount).map(item => item.query.current)).toEqual(['2', '1'])
  expect(writes('memory')).toEqual([{ method: 'DELETE', path: '/api/v1/memory/memory-page-19', query: { scope: 'global' }, body: {} }])
})

test('记忆创建、类型和关键词过滤、详情编辑与删除保留精确字段和全局作用域', async () => {
  await openSettings('记忆', 'dark', 760)
  await memory().getByRole('button', { name: '新建记忆', exact: true }).click()
  const create = dialog('新建记忆')
  await create.getByRole('textbox', { name: '记忆摘要', exact: true }).fill('  新增发布决定  ')
  await choose(create, '记忆类型', '决策')
  await create.getByRole('textbox', { name: '记忆详情', exact: true }).fill('  先验证界面，再发布。  ')
  await create.getByRole('spinbutton', { name: '重要度', exact: true }).fill('0.85')
  await create.getByRole('textbox', { name: '记忆标签', exact: true }).fill('发布, 界面')
  await footerVisible(create, '保存'); await create.getByRole('button', { name: '保存', exact: true }).click()
  await expect(create).toBeHidden(); await expect(memoryRow('新增发布决定')).toBeVisible()
  const created = fixture.memories.find(item => item.summary === '新增发布决定')!
  const payload = { summary: '新增发布决定', type: 'decision', detail: '先验证界面，再发布。', importance: 0.85, tags: ['发布', '界面'] }
  expect(writes('memory')[0]).toEqual({ method: 'POST', path: '/api/v1/memory/nodes', query: { scope: 'global' }, body: payload })
  await memory().getByRole('textbox', { name: '搜索记忆', exact: true }).fill('发布')
  await choose(memory(), '按类型筛选', '决策')
  await expect(memory().getByRole('listitem')).toHaveCount(1)
  expect(fixture.receipts.filter(item => item.path === '/api/v1/memory/list').at(-1)?.query).toEqual({ scope: 'global', keyword: '发布', type: 'decision', current: '1', pageSize: '20' })
  await memoryRow('新增发布决定').getByRole('button', { name: '查看记忆：新增发布决定', exact: true }).click()
  const detail = dialog('记忆详情'); await expect(detail).toContainText('先验证界面，再发布。')
  await detail.getByRole('button', { name: '编辑', exact: true }).click()
  const edit = dialog('编辑记忆')
  await edit.getByRole('textbox', { name: '记忆摘要', exact: true }).fill('更新发布决定')
  await edit.getByRole('textbox', { name: '记忆详情', exact: true }).fill('')
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(edit).toBeHidden(); await expect(memoryRow('更新发布决定')).toBeVisible()
  expect(writes('memory').at(-1)).toEqual({ method: 'PUT', path: `/api/v1/memory/${created.id}`, query: { scope: 'global' }, body: { ...payload, summary: '更新发布决定', detail: null } })
  await (await menu(memoryRow('更新发布决定'), '更新发布决定')).getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = dialog('删除记忆？'); await escape(confirmation)
  expect(writes('memory').filter(item => item.method === 'DELETE')).toEqual([])
  await (await menu(memoryRow('更新发布决定'), '更新发布决定')).getByRole('button', { name: '删除', exact: true }).click()
  await confirmation.getByRole('button', { name: '删除记忆', exact: true }).click()
  await expect(memoryRow('更新发布决定')).toHaveCount(0)
  expect(writes('memory').at(-1)).toEqual({ method: 'DELETE', path: `/api/v1/memory/${created.id}`, query: { scope: 'global' }, body: {} })
  expect(fixture.memories).toEqual(initialResourceMemories)
})

test('会话记忆选择与手填 ID 隔离存储，未选择会话时不能创建', async () => {
  await openSettings('记忆')
  await memory().getByRole('radio', { name: '会话记忆', exact: true }).click()
  await expect(memory().getByRole('button', { name: '新建记忆', exact: true })).toBeDisabled()
  await choose(memory(), '选择会话', resourceTasks[1].title)
  await expect(memoryRow('会话乙的发布决定')).toBeVisible()
  await expect(memoryRow('偏好简洁中文')).toHaveCount(0)
  await memory().getByRole('button', { name: '新建记忆', exact: true }).click()
  const create = dialog('新建记忆')
  await create.getByRole('textbox', { name: '记忆摘要', exact: true }).fill('仅属于会话乙')
  await create.getByRole('button', { name: '保存', exact: true }).click()
  await expect(memoryRow('仅属于会话乙')).toBeVisible()
  expect(writes('memory').at(-1)).toEqual({ method: 'POST', path: '/api/v1/memory/nodes', query: { scope: 'session', sessionId: resourceTasks[1].id },
    body: { summary: '仅属于会话乙', type: 'fact', detail: null, importance: 0.5, tags: [] } })
  await memory().getByRole('textbox', { name: '会话 ID', exact: true }).fill(resourceTasks[0].id)
  await expect(memoryRow('仅属于会话乙')).toHaveCount(0)
  await expect.poll(() => fixture.receipts.filter(item => item.path === '/api/v1/memory/list').at(-1)?.query.sessionId).toBe(resourceTasks[0].id)
  expect(fixture.memories.filter(item => item.scope === 'global')).toEqual(initialResourceMemories.filter(item => item.scope === 'global'))
})

test('重复点击当前记忆范围保留列表和过滤，旧详情晚返回不覆盖另一会话', async () => {
  await openSettings('记忆')
  const globalScope = memory().getByRole('radio', { name: '全局记忆', exact: true })
  await memory().getByRole('textbox', { name: '搜索记忆', exact: true }).fill('简洁')
  await expect(memory().getByRole('listitem')).toHaveCount(1)
  await globalScope.click(); await globalScope.click()
  await expect(memory().getByRole('textbox', { name: '搜索记忆', exact: true })).toHaveValue('简洁')
  await expect(memoryRow('偏好简洁中文')).toBeVisible()
  fixture.holdMemoryId = 'memory-global'
  await memoryRow('偏好简洁中文').getByRole('button', { name: '查看记忆：偏好简洁中文', exact: true }).click()
  await expect.poll(() => Boolean(fixture.heldMemory)).toBe(true)
  const sessionScope = memory().getByRole('radio', { name: '会话记忆', exact: true })
  await sessionScope.click(); await choose(memory(), '选择会话', resourceTasks[1].title)
  await expect(memoryRow('会话乙的发布决定')).toBeVisible()
  await sessionScope.click(); await sessionScope.click()
  await expect(memoryRow('会话乙的发布决定')).toBeVisible()
  fixture.releaseMemory()
  // Await another completed bridge read after releasing the older response,
  // then let its React update flush before checking for an unwanted dialog.
  const reads = fixture.receipts.filter(item => item.path === '/api/v1/memory/list').length
  await memory().getByRole('button', { name: '刷新记忆', exact: true }).click()
  await expect.poll(() => fixture.receipts.filter(item => item.path === '/api/v1/memory/list').length).toBeGreaterThan(reads)
  await expect(memory().getByRole('list', { name: '记忆列表', exact: true })).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(dialog('记忆详情')).toHaveCount(0)
  await expect(memoryRow('会话乙的发布决定')).toBeVisible()
  await memoryRow('会话乙的发布决定').getByRole('button', { name: '查看记忆：会话乙的发布决定', exact: true }).click()
  await expect(dialog('记忆详情')).toContainText('先检查文档，再发布版本。')
  await expect(dialog('记忆详情')).not.toContainText('优先使用清晰的中文段落')
  expect(fixture.memories).toEqual(initialResourceMemories)
  expect(writes('memory')).toEqual([])
})

test('资源菜单键盘与嵌套 Esc 保持焦点，520×700 编辑操作栏固定可用', async () => {
  await openSettings('记忆', 'light', 520); await windowSize(520, 700)
  const row = memoryRow('偏好简洁中文'), trigger = row.getByRole('button', { name: '偏好简洁中文 的更多操作', exact: true })
  await trigger.scrollIntoViewIfNeeded(); await trigger.focus(); await trigger.press('Enter')
  const actions = dialog('偏好简洁中文 的操作'), editAction = actions.getByRole('button', { name: '编辑', exact: true })
  await expect(actions.getByRole('button', { name: '查看详情', exact: true })).toBeFocused(); await page.keyboard.press('End')
  await expect(actions.getByRole('button', { name: '删除', exact: true })).toBeFocused()
  await page.keyboard.press('Home'); await expect(actions.getByRole('button', { name: '查看详情', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown'); await expect(editAction).toBeFocused(); await page.keyboard.press('Enter')
  const edit = dialog('编辑记忆'); await expect(edit).toBeVisible()
  const type = edit.getByRole('button', { name: '记忆类型', exact: true })
  await type.focus(); await type.press('ArrowDown')
  const options = page.getByRole('menu', { name: '记忆类型', exact: true }); await expect(options).toBeVisible()
  await escape(options); await expect(edit).toBeVisible(); await expect(type).toBeFocused()
  await edit.getByRole('textbox', { name: '记忆标签', exact: true }).scrollIntoViewIfNeeded()
  await footerVisible(edit, '保存'); await footerVisible(edit, '取消'); await shot('memory-520x700-editor')
  await escape(edit); await expect(trigger).toBeFocused(); await expect(settings()).toBeVisible()
  await selectSection('技能'); await skills().getByRole('button', { name: '创建技能', exact: true }).click()
  const create = dialog('创建技能'); await create.getByRole('textbox', { name: '新技能正文', exact: true }).scrollIntoViewIfNeeded()
  await footerVisible(create, '创建技能'); await footerVisible(create, '取消'); await shot('skills-520x700-editor'); await escape(create)
  await selectSection('知识库'); await knowledge().getByRole('button', { name: '导入文档', exact: true }).click()
  const upload = dialog('导入文档'); await upload.getByRole('radio', { name: '文本', exact: true }).click()
  await upload.getByRole('textbox', { name: '文档内容', exact: true }).scrollIntoViewIfNeeded()
  await footerVisible(upload, '上传并索引'); await shot('knowledge-520x700-import'); await escape(upload)
  expect(fixture.receipts.filter(item => item.method !== 'GET')).toEqual([])
})

test('服务端拒绝写入时三类编辑对话框保留完整草稿和原有资源', async () => {
  await openSettings('技能')
  await skills().getByRole('button', { name: '创建技能', exact: true }).click()
  const createSkill = dialog('创建技能'), skillText = '# 未保存草稿\n\n完整技能说明。'
  await createSkill.getByRole('textbox', { name: '新技能名称', exact: true }).fill('failed-draft')
  await createSkill.getByRole('textbox', { name: '新技能正文', exact: true }).fill(skillText)
  fixture.failNext = 'skill-create'
  await createSkill.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(createSkill.getByRole('alert')).toContainText('夹具校验失败')
  await expect(createSkill.getByRole('textbox', { name: '新技能正文', exact: true })).toHaveValue(skillText)
  expect(fixture.skills).toEqual(initialResourceSkills); await escape(createSkill)

  await selectSection('知识库'); await knowledge().getByRole('button', { name: '导入文档', exact: true }).click()
  const upload = dialog('导入文档'), documentText = '# 未上传资料\n\n原始正文应保留。'
  await upload.getByRole('radio', { name: '文本', exact: true }).click()
  await upload.getByRole('textbox', { name: '文档文件名', exact: true }).fill('rejected.md')
  await upload.getByRole('textbox', { name: '文档内容', exact: true }).fill(documentText)
  fixture.failNext = 'document-upload'
  await upload.getByRole('button', { name: '上传并索引', exact: true }).click()
  await expect(upload.getByRole('alert')).toContainText('夹具校验失败')
  await expect(upload.getByRole('textbox', { name: '文档内容', exact: true })).toHaveValue(documentText)
  expect(fixture.documents).toEqual(initialResourceDocuments); await escape(upload)

  await selectSection('记忆'); await memory().getByRole('button', { name: '新建记忆', exact: true }).click()
  const createMemory = dialog('新建记忆')
  await createMemory.getByRole('textbox', { name: '记忆摘要', exact: true }).fill('保存失败的记忆')
  await createMemory.getByRole('textbox', { name: '记忆详情', exact: true }).fill('需要保留的完整详情。')
  fixture.failNext = 'memory-save'
  await createMemory.getByRole('button', { name: '保存', exact: true }).click()
  await expect(createMemory.getByRole('alert')).toContainText('夹具校验失败')
  await expect(createMemory.getByRole('textbox', { name: '记忆详情', exact: true })).toHaveValue('需要保留的完整详情。')
  expect(fixture.memories).toEqual(initialResourceMemories)
  await createMemory.getByRole('button', { name: '取消', exact: true }).click()
})
