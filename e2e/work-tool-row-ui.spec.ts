/** Real Electron Work receipts: one-line read/list/Office/command summaries, complete
 * themed hover details, keyboard disclosure, and unchanged per-file sources/stats. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'tool-row-fixture-token', sessionId = 'work-tool-rows', modelId = 'tool-row-model'
const title = '读取范围与行交互核对', now = Date.now() - 10_000, remoteRoot = '/remote/tool-rows'
const sourcePath = `${remoteRoot}/example.ts`, firstSource = '1 | const first = 1;\n2 | const second = 2;'
const secondSource = '3 | const third = 3;\n4 | const fourth = 4;'
const batchPaths = ['engineering/architecture-overview-and-current-decisions.md', 'frontend/long-unbroken-component-name-with-complete-implementation-notes.tsx',
  'backend/service-contracts-and-integration-configuration.json', 'quality/complete-regression-checklist-for-next-release.md'].map(path => `${remoteRoot}/${path}`)
const batchRanges = [[1, 255, 500], [64, 123, 400], [2, 8, 80], [21, 25, 60]] as const
const directoryPath = `${remoteRoot}/${'cross-team-delivery-and-review-materials/'.repeat(7)}complete-directory-end`
const officePaths = ['quarterly-business-report-with-appendices.docx', 'annual-budget-and-forecast-workbook.xlsx', 'product-delivery-review-presentation.pptx']
  .map(name => `${remoteRoot}/business/documents/${name}`)
const commands = [
  { id: 'command-success', script: `npm test -- ${'--project=command-summary-check '.repeat(9)}SUCCESS_COMMAND_TAIL`, success: true,
    output: 'COMMAND_SUCCESS_OUTPUT：fixture summary verified' },
  { id: 'command-failure', script: `npm run verify -- ${'--workspace=complete-command-receipt '.repeat(9)}FAILED_COMMAND_TAIL`, success: false,
    output: 'COMMAND_FAILURE_OUTPUT：fixture assertion failed' }
]
const invocation = (script: string): string => `cmd.exe /d /s /c ${JSON.stringify(script)}`
const run: RootRun = { schemaVersion: 1, runId: 'tool-row-run', sessionId, turnId: 'tool-row-turn',
  userMessageId: 'tool-row-user', assistantMessageId: 'tool-row-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now + 17, finishedAt: now + 17 }
const change: EngineFileChange = { id: 'tool-row-change', sessionId, turnId: run.turnId, runId: run.runId,
  path: `${remoteRoot}/changed.ts`, kind: 'write', oldContent: 'const value = 1;\n', newContent: 'const value = 2;\n',
  truncated: false, status: 'pending', createdAt: now + 6, toolCallId: 'write-change' }
const metadata = { rootRunId: run.runId, turnId: run.turnId }
const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function receipt(startLine: number, endLine: number, numberedContent: string) {
  const hasMore = endLine < 4
  return { path: sourcePath, expectedHash: `sha256:${'a'.repeat(64)}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false,
    byteLength: 74, totalLines: 4, requestedEndLine: 4, startLine, startColumn: 1, endLine, endColumn: 17,
    columnUnit: 'utf16', partialLine: false, hasMore, nextStartLine: hasMore ? endLine + 1 : null,
    nextStartColumn: hasMore ? 1 : null, rangeIsComplete: !hasMore, contentIsComplete: false, numberedContent }
}
function history(id: string): EngineHistoryRow[] {
  if (id !== sessionId) return []
  const rows: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: title,
    createdAt: now, conversationId: run.turnId, metadata }]
  for (const [index, toolId, start, end, source] of [
    [1, 'read-first', 1, 2, firstSource], [3, 'read-second', 3, 4, secondSource]
  ] as const) {
    rows.push({ id: `call-${toolId}`, role: 'assistant', content: '', createdAt: now + index,
      conversationId: run.turnId, metadata, toolCall: { id: toolId, name: 'read_file', args: { path: sourcePath, start_line: start, end_line: 4 } } },
    { id: `result-${toolId}`, role: 'tool', toolCallId: toolId, content: JSON.stringify(receipt(start, end, source)),
      success: true, createdAt: now + index + 1, conversationId: run.turnId, metadata: { ...metadata, success: true } })
  }
  rows.push({ id: 'call-write', role: 'assistant', content: '', createdAt: now + 5, conversationId: run.turnId, metadata,
    toolCall: { id: 'write-change', name: 'write_file', args: { path: change.path, content: change.newContent } } },
  { id: 'result-write', role: 'tool', toolCallId: 'write-change', content: '文件已更新', success: true,
    createdAt: now + 6, conversationId: run.turnId, metadata: { ...metadata, success: true, change } })
  const officeContent = 'OFFICE-BATCH-CONTENT-PROBE'
  const additions = [
    { id: 'read-batch', name: 'read_file', args: { files: batchPaths.map(path => ({ path, end_line: 9999 })) }, result: {
      batch: true, files: batchPaths.map((path, index) => ({ path, success: true, output: {
        path, expectedHash: `sha256:${'b'.repeat(64)}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false,
        startLine: batchRanges[index][0], endLine: batchRanges[index][1], totalLines: batchRanges[index][2], content: `BATCH-SOURCE-PROBE-${index}`
      } })) } },
    { id: 'list-directory', name: 'list_directory', args: { path: directoryPath }, result: { entries: ['DIRECTORY-CONTENT-PROBE'] } },
    { id: 'inspect-office', name: 'office_inspect', args: { files: officePaths.map(path => ({ path })) }, result: {
      batch: true, files: officePaths.map(path => ({ path, success: true, executed: true, output: {
        path, expectedHash: `sha256:${'c'.repeat(64)}`, content: officeContent, contentIncluded: true,
        contentPage: { offset: 0, returnedChars: officeContent.length, totalPreviewChars: officeContent.length,
          nextOffset: null, hasMore: false, sourceTruncated: false, documentComplete: false }
      } })) } }
  ]
  for (const [index, tool] of additions.entries()) rows.push(
    { id: `call-${tool.id}`, role: 'assistant', content: '', createdAt: now + 7 + index * 2, conversationId: run.turnId,
      metadata, toolCall: { id: tool.id, name: tool.name, args: tool.args } },
    { id: `result-${tool.id}`, role: 'tool', toolCallId: tool.id, content: JSON.stringify(tool.result), success: true,
      createdAt: now + 8 + index * 2, conversationId: run.turnId, metadata: { ...metadata, success: true } })
  for (const [index, command] of commands.entries()) rows.push(
    { id: `call-${command.id}`, role: 'assistant', content: '', createdAt: now + 13 + index * 2, conversationId: run.turnId,
      metadata, toolCall: { id: command.id, name: 'execute_cmd', args: { command: 'cmd.exe', args: ['/d', '/s', '/c', command.script] } } },
    { id: `result-${command.id}`, role: 'tool', toolCallId: command.id, content: command.output, success: command.success,
      createdAt: now + 14 + index * 2, conversationId: run.turnId, metadata: { ...metadata, success: command.success } })
  rows.push({ id: run.assistantMessageId, role: 'assistant', content: '已读取源码、目录和办公文档，并核对命令记录。', createdAt: now + 17,
    conversationId: run.turnId, metadata })
  return rows
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (path === '/api/v1/workspace/file/content') throw new Error('Receipt hover and disclosure must not open workspace files')
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Reading receipts must not mutate: ${path}`)
  }
  const rows = history(id), matching = id === sessionId ? run : undefined
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: 'tool-row-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'tool-row-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '工具行核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: matching ? [change] : [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 18 }]
    : path === '/api/v1/changes' ? matching ? [change] : []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'tool-row-fixture', sessionId: id,
      namespace: { id: 'tool-row-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: remoteRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

async function screenshot(name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}

async function assertSingleLine(header: Locator): Promise<void> {
  const box = await header.evaluate(element => ({ height: element.getBoundingClientRect().height,
    overflow: element.scrollWidth - element.clientWidth,
    tops: [...element.querySelectorAll('.logline__file-name')].map(file => Math.round(file.getBoundingClientRect().top)) }))
  expect(box.height).toBeGreaterThanOrEqual(27); expect(box.height).toBeLessThanOrEqual(29)
  expect(box.overflow).toBeLessThanOrEqual(1)
  if (box.tops.length) expect(new Set(box.tops).size).toBe(1)
}

async function collapseToolRows(): Promise<void> {
  const process = page.locator('.work-message__process-toggle')
  if (await process.getAttribute('aria-expanded') !== 'true') await process.click()
  await page.keyboard.press('Escape')
  for (const header of await page.locator('[data-work-tool-id] button.logline').all()) {
    if (await header.getAttribute('aria-expanded') === 'true') await header.click()
  }
  await page.mouse.move(4, 4); await page.keyboard.press('Escape')
}

async function expectHoverText(header: Locator, texts: readonly string[]): Promise<Locator> {
  await header.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible(); await expect(tooltip).toHaveClass(/hover-detail/)
  await expect(tooltip.getByText(await header.locator('.logline__name').innerText(), { exact: true })).toHaveCount(1)
  await expect(tooltip).not.toContainText('还有更多内容')
  for (const text of texts) await expect(tooltip).toContainText(text)
  await expect(header.locator('[title]')).toHaveCount(0)
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  return tooltip
}
test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'tool-row-profile-'))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: remoteRoot, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await screenshot('tool-row-failure', info)
  await info.attach('app-errors', { body: JSON.stringify({ errors, mutations }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('tool-row-profile-')) throw new Error('Unsafe tool row fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('读取范围常显，折叠箭头随行交互显示，展开后保持可见且保留改动统计', async ({}, info) => {
  const process = page.locator('.work-message__process-toggle')
  await expect(process).toHaveAttribute('aria-expanded', 'false'); await process.click()
  const first = page.locator('[data-work-tool-id="read-first"]'), second = page.locator('[data-work-tool-id="read-second"]')
  const firstButton = first.locator('button.logline'), secondButton = second.locator('button.logline')
  const firstArrow = first.locator('.logline__chevron'), secondArrow = second.locator('.logline__chevron')
  const file = page.locator('[data-work-tool-id="write-change"] .work-file-change-row')
  const fileArrow = file.locator('.work-file-change-row__chevron'), stats = file.locator('.work-file-change-row__stats')
  for (const [row, button, range] of [[first, firstButton, '1–2'], [second, secondButton, '3–4']] as const) {
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(row.locator('.logline__file-range')).toHaveText(range)
    await expect(row.locator('.logline__file-range')).toBeVisible()
    await expect(button).toHaveAccessibleName(new RegExp(range))
    await expect(row.locator('.logline__detail')).toHaveCount(0)
  }
  await expectHoverText(firstButton, [sourcePath, '本次读取第 1–2 行 · 文件共 4 行'])
  await page.keyboard.press('Escape')
  await expectHoverText(secondButton, [sourcePath, '本次读取第 3–4 行 · 文件共 4 行'])
  await page.keyboard.press('Escape')
  await expect(stats).toHaveAttribute('aria-label', '新增 1 行，删除 1 行')
  await expect(file.locator('.work-file-change-row__added')).toHaveText('+1')
  await expect(file.locator('.work-file-change-row__removed')).toHaveText('-1')
  await page.mouse.move(4, 4)
  for (const arrow of [firstArrow, secondArrow, fileArrow]) await expect(arrow).toHaveCSS('opacity', '0')
  await expect(stats).toBeVisible(); await screenshot('tool-rows-collapsed', info)
  await firstButton.hover()
  await expect(firstArrow).toHaveCSS('opacity', '0.6'); await expect(secondArrow).toHaveCSS('opacity', '0')
  await expect(fileArrow).toHaveCSS('opacity', '0')
  await page.mouse.move(4, 4); await expect(firstArrow).toHaveCSS('opacity', '0')
  await file.hover(); await expect(fileArrow).toHaveCSS('opacity', '0.6'); await expect(stats).toBeVisible()
  await page.mouse.move(4, 4); await expect(fileArrow).toHaveCSS('opacity', '0'); await expect(stats).toBeVisible()

  // Tab produces native :focus-visible, independently of pointer hover.
  await firstButton.focus(); await page.keyboard.press('Tab')
  await expect(secondButton).toBeFocused()
  await expect.poll(() => secondButton.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect(secondArrow).toHaveCSS('opacity', '0.6'); await expect(firstArrow).toHaveCSS('opacity', '0')
  await page.keyboard.press('Tab'); await expect(file).toBeFocused()
  await expect.poll(() => file.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect(fileArrow).toHaveCSS('opacity', '0.6'); await expect(secondArrow).toHaveCSS('opacity', '0')
  await expect(stats).toBeVisible()

  await firstButton.click(); await expect(firstButton).toHaveAttribute('aria-expanded', 'true')
  await expect(first.locator('.logline__detail')).toContainText(firstSource)
  await expect(first.locator('.logline__detail')).not.toContainText('const third')
  await expect(second.locator('.logline__detail')).toHaveCount(0)
  await page.mouse.move(4, 4)
  await expect.poll(() => firstButton.evaluate(element => element.matches(':focus-visible'))).toBe(false)
  await expect(firstArrow).toHaveCSS('opacity', '0.6'); await expect(secondArrow).toHaveCSS('opacity', '0')
  await secondButton.click(); await expect(secondButton).toHaveAttribute('aria-expanded', 'true')
  await expect(second.locator('.logline__detail')).toContainText(secondSource)
  await expect(second.locator('.logline__detail')).not.toContainText('const first')
  await page.mouse.move(4, 4)
  for (const arrow of [firstArrow, secondArrow]) await expect(arrow).toHaveCSS('opacity', '0.6')
  await expect(fileArrow).toHaveCSS('opacity', '0'); await expect(stats).toBeVisible()
  await expect(first.locator('.logline__file-range')).toBeVisible(); await expect(second.locator('.logline__file-range')).toBeVisible()
  await screenshot('tool-rows-expanded', info)
})

test('批量读取、目录和办公文档保持单行，悬浮完整内容与键盘展开互不干扰', async ({}, info) => {
  await collapseToolRows()
  const batch = page.locator('[data-work-tool-id="read-batch"]'), directory = page.locator('[data-work-tool-id="list-directory"]')
  const office = page.locator('[data-work-tool-id="inspect-office"]')
  const batchHeader = batch.locator('button.logline'), directoryHeader = directory.locator('button.logline'), officeHeader = office.locator('button.logline')
  for (const header of [batchHeader, directoryHeader, officeHeader]) await assertSingleLine(header)
  await expect(batch.locator('.logline__file')).toHaveCount(batchPaths.length)
  await expect(batch.locator('.logline__file-range')).toHaveText(batchRanges.map(([start, end]) => `${start}–${end}`))
  await expect(office.locator('.logline__file')).toHaveCount(officePaths.length)
  await expect(office.locator('.logline__file-range')).toHaveCount(0)
  for (const path of batchPaths) await expect(batchHeader).toHaveAccessibleName(new RegExp(path.split('/').at(-1)!.replaceAll('.', '\\.')))

  const batchTooltip = await expectHoverText(batchHeader, [...batchPaths, ...batchRanges.map(([start, end, total]) => `本次读取第 ${start}–${end} 行 · 文件共 ${total} 行`)])
  await expect(batchTooltip).not.toContainText('9999')
  await batchTooltip.hover()
  await expect.poll(() => batchTooltip.evaluate(element => element.matches(':hover'))).toBe(true)
  await expect(batch.locator('.logline__detail')).toHaveCount(0)
  await screenshot('batch-read-complete-hover', info)
  await page.keyboard.press('Escape'); await expect(batchTooltip).toHaveCount(0)
  await expect(batchHeader).toHaveAttribute('aria-expanded', 'false')

  await expectHoverText(directoryHeader, [directoryPath]); await page.keyboard.press('Escape')
  await expectHoverText(officeHeader, [...officePaths, '文档预览，不提供实读行号']); await page.keyboard.press('Escape')
  await page.mouse.move(4, 4)
  // Starting from the preceding receipt exercises actual Tab focus rather than
  // synthesizing a focus-visible state on the new Office row.
  await directoryHeader.focus(); await page.keyboard.press('Tab')
  await expect(officeHeader).toBeFocused()
  const focusedTooltip = page.getByRole('tooltip')
  await expect(focusedTooltip).toBeVisible()
  await expect(focusedTooltip.getByText(await officeHeader.locator('.logline__name').innerText(), { exact: true })).toHaveCount(1)
  await expect(focusedTooltip).not.toContainText('还有更多内容')
  for (const path of officePaths) await expect(focusedTooltip).toContainText(path)
  await expect(officeHeader).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape'); await expect(focusedTooltip).toHaveCount(0)
  await expect(officeHeader).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(officeHeader).toHaveAttribute('aria-expanded', 'true')
  await expect(office.locator('.logline__detail')).toContainText('OFFICE-BATCH-CONTENT-PROBE')
  await expect(batch.locator('.logline__detail')).toHaveCount(0)
  await expect(directory.locator('.logline__detail')).toHaveCount(0)
  await page.keyboard.press('Enter'); await expect(officeHeader).toHaveAttribute('aria-expanded', 'false')

  await batchHeader.click()
  for (let index = 0; index < batchPaths.length; index++) await expect(batch.locator('.logline__detail')).toContainText(`BATCH-SOURCE-PROBE-${index}`)
  await batchHeader.click()
  await directoryHeader.click(); await expect(directory.locator('.logline__detail')).toContainText('DIRECTORY-CONTENT-PROBE')
  await directoryHeader.click()
  await expect(page.locator('.work-final-result')).toHaveCount(0)
  await expect(page.locator('.image-preview-modal')).toHaveCount(0)
})

test('窄窗浅深主题省略长摘要，完整悬浮层留在窗口内且无横向溢出', async ({}, info) => {
  await collapseToolRows()
  const colors: string[] = []
  for (const appearance of ['light', 'dark']) {
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(760, 820) })
    await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
    const header = page.locator('[data-work-tool-id="read-batch"] button.logline')
    await header.scrollIntoViewIfNeeded()
    for (const id of ['read-batch', 'list-directory', 'inspect-office']) await assertSingleLine(page.locator(`[data-work-tool-id="${id}"] button.logline`))
    expect(await header.locator('.logline__files').evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(20)
    const tooltip = await expectHoverText(header, batchPaths)
    const bounds = await tooltip.evaluate(element => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight,
        overflow: element.scrollWidth - element.clientWidth, background: getComputedStyle(element).backgroundColor }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1)
    expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1)
    expect(bounds.overflow).toBeLessThanOrEqual(1)
    colors.push(bounds.background)
    await screenshot(`narrow-${appearance}-read-hover`, info)
    await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0)

    const directoryHeader = page.locator('[data-work-tool-id="list-directory"] button.logline')
    const directoryTooltip = await expectHoverText(directoryHeader, [directoryPath])
    expect(await directoryTooltip.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await screenshot(`narrow-${appearance}-directory-hover`, info)
    await page.keyboard.press('Escape')
  }
  expect(colors[0]).not.toBe(colors[1])
  await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 900) })
  await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
})

test('成功和失败命令保留cmd参数，窄窗单行省略且悬浮显示完整尾部', async ({}, info) => {
  await collapseToolRows()
  await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(760, 900) })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(760)
  for (const appearance of ['light', 'dark']) {
    await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), appearance)
    for (const command of commands) {
      const row = page.locator(`[data-work-tool-id="${command.id}"]`), header = row.locator('button.logline')
      const full = invocation(command.script), compact = full.slice(0, 177) + '…'
      await expect(header.locator('.logline__summary')).toHaveText(compact)
      await expect(row.locator('.compact-tool-row')).toHaveAttribute('data-tool-state', command.success ? 'done' : 'error')
      await header.scrollIntoViewIfNeeded(); await assertSingleLine(header)
      const summary = header.locator('.logline__summary')
      await expect(summary).toHaveCSS('white-space', 'nowrap')
      await expect(summary).toHaveCSS('text-overflow', 'ellipsis')
      await expect(summary).toHaveCSS('overflow-x', 'hidden')
      expect(await summary.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(20)
      await expectHoverText(header, [full])
      await screenshot(`command-${command.success ? 'success' : 'failure'}-${appearance}`, info)
      await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0)
      await header.focus(); await page.keyboard.press('Enter')
      await expect(header).toHaveAttribute('aria-expanded', 'true')
      await expect(row.locator('.logline__detail')).toContainText(command.output)
      await page.keyboard.press('Enter'); await expect(header).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('Escape'); await page.mouse.move(4, 4)
    }
  }
  await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 900) })
  await page.locator('html').evaluate(element => element.setAttribute('data-appearance', 'light'))
})
