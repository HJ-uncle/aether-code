/** Real Electron + authenticated history/SSE: each prose-delimited tool batch
 * folds above three displayed activities (including a command's file receipts)
 * and scrolls independently when opened.
 * Reasoning visibility is a local session preference; only the latest reasoning
 * item opens automatically. Tool details stay collapsed until clicked or located.
 * Navigation and final answers remain usable with folded batches. Build first. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload, EngineFileChange } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp', 'thinking-only-disclosure')
const token = 'process-layout-token', model = 'process-layout-model', now = Date.now() - 60_000
const settled = 'work-process-layout-settled', live = 'work-process-layout-live', paged = 'work-process-layout-paged', threshold = 'work-process-layout-threshold', thinkingOnly = 'work-process-layout-thinking-only', workspaceRoot = '/remote/process-layout'
const titles = new Map([[settled, '核对完整文档处理过程'], [live, '继续检查文档处理过程'], [paged, '核对长过程的分页阅读'], [threshold, '核对三步与四步的边界'], [thinkingOnly, '只含思考和最终回复']])
const bulk = 'work-process-layout-bulk-live'
titles.set(bulk, '核对单次命令的批量文件记录')
const finalText = 'PROCESS_LAYOUT_FINAL：文档检查已完成。\n\n所有页面均已核对，正文只保留交付结论。'
const noteText = 'PROCESS_LAYOUT_NOTE：正在核对页面尺寸和内容层次，下一步检查实际画面。'
const errors: string[] = [], mutations: string[] = [], streams = new Map<string, ServerResponse>()
const projections: ChatSsePayload[] = []
const bulkProjections: ChatSsePayload[] = []
const isLive = (id: string): boolean => id === live || id === bulk
let app: ElectronApplication | undefined, page: Page, fixture = '', imageDataUrl = '', source = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const toolId = (sessionId: string, index: number): string => `${sessionId}-step-${index.toString().padStart(2, '0')}`
const ownedRun = (id: string): RootRun | undefined => titles.has(id) ? {
  schemaVersion: 1, runId: `${id}-root`, sessionId: id, turnId: `${id}-turn`, userMessageId: `${id}-user`,
  assistantMessageId: `${id}-answer`, seq: id === live ? 2 : 1, version: isLive(id) ? 1 : 2, status: isLive(id) ? 'running' : 'succeeded',
  pending: [], modelId: model, workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now + 38_000,
  startedAt: now, ...(isLive(id) ? {} : { finishedAt: now + 38_000 })
} : undefined
const previousRun = (): RootRun => ({ ...ownedRun(live)!, runId: `${live}-previous-root`, turnId: `${live}-previous-turn`,
  userMessageId: `${live}-previous-user`, assistantMessageId: `${live}-previous-answer`, seq: 1, version: 2,
  status: 'succeeded', createdAt: now - 600_000, startedAt: now - 600_000, updatedAt: now - 570_000, finishedAt: now - 570_000 })
const bulkChanges: EngineFileChange[] = Array.from({ length: 150 }, (_, index) => ({
  id: `bulk-change-${index}`, sessionId: bulk, runId: `${bulk}-root`, turnId: `${bulk}-turn`,
  toolCallId: toolId(bulk, 0), path: `${workspaceRoot}/runtime/package-${index}/LICENSE`,
  kind: 'write', oldContent: null, newContent: `Package ${index} license\n`, isNew: true,
  oldHash: 'missing', status: 'pending', truncated: false, createdAt: now + 3
}))

function history(id: string): EngineHistoryRow[] {
  const run = ownedRun(id)
  if (!run) return []
  const metadata = { rootRunId: run.runId, turnId: run.turnId }
  const row = (suffix: string, role: string, content: unknown, offset: number): EngineHistoryRow => ({
    id: `${id}-${suffix}`, role, content, createdAt: now + offset, conversationId: run.turnId, metadata
  })
  const rows: EngineHistoryRow[] = []
  if (id === bulk) return [row('user', 'user', titles.get(id), 0),
    { ...row('call-0', 'assistant', '', 2), toolCall: { id: toolId(id, 0), name: 'execute_cmd', args: { command: 'npm install' } } },
    { ...row('result-0', 'tool', '已安装运行依赖。', 3), toolCallId: toolId(id, 0), success: true,
      metadata: { ...metadata, success: true, changes: bulkChanges } }
  ]
  if (id === live) {
    const previous = previousRun(), earlier = { rootRunId: previous.runId, turnId: previous.turnId }
    rows.push({ id: previous.userMessageId, role: 'user', content: '先保留完整的既有审阅记录。', createdAt: previous.createdAt,
      conversationId: previous.turnId, metadata: earlier },
    { id: previous.assistantMessageId, role: 'assistant', content: Array.from({ length: 32 }, (_, index) =>
      `EARLIER_REVIEW_${index}：既有检查记录保持完整，向上阅读时运行状态应只固定显示一份。`).join('\n\n'),
    createdAt: previous.finishedAt, conversationId: previous.turnId, metadata: earlier })
  }
  rows.push(row('user', 'user', titles.get(id), 0))
  for (let index = 0; index < (id === paged ? 105 : id === threshold ? 7 : id === thinkingOnly ? 0 : 38); index++) {
    if (index === 0 || (id === threshold ? index === 3 : id !== paged && (index === 13 || index === (id === live ? 33 : 36)))) rows.push({
      ...row(`note-${index}`, 'assistant', `${noteText}（阶段 ${index + 1}）`, index * 1000 + 1),
      ...(index === 0 ? { reasoningContent: 'PROCESS_LAYOUT_THINKING：先验证边界，再检查每个原始步骤。' } : {})
    })
    if (id === threshold && index === 3) rows.push({ ...row('section-reasoning', 'assistant', '', index * 1000 + 1.5),
      reasoningContent: 'SECTION_REASONING：第四次工具调用到来后，将这一段完整收进同一过程。' })
    const wait = id !== paged && id !== threshold && (index >= 1 && index <= 6 || index >= 36)
    const office = id !== paged && id !== threshold && index >= 7 && index <= 12
    const image = id !== paged && id !== threshold && index === 35
    const name = wait ? 'browser_wait' : office ? 'office_inspect' : image ? 'workbench_render' : 'read_file'
    const args = wait ? { url: 'https://example.test/review', timeout_ms: 1000 }
      : office ? { path: `${workspaceRoot}/delivery-review.docx` }
        : image ? { path: `${workspaceRoot}/delivery-review.pptx`, slide: 1 }
          : { path: `${workspaceRoot}/source-${index}.txt` }
    rows.push({ ...row(`call-${index}`, 'assistant', '', index * 1000 + 2), toolCall: { id: toolId(id, index), name, args } })
    if (id === live && index === 37) continue
    const success = id !== settled || index !== 34
    const output = image ? JSON.stringify({ type: 'image', mimeType: 'image/png', title: '文档检查完整画面', data: imageDataUrl.replace(/^data:image\/png;base64,/, '') })
      : id === paged && index === 104 ? Array.from({ length: 28 }, (_, line) => `PROCESS_RECEIPT_104_${line}：保留完整原始记录，展开后需要滚动阅读。`).join('\n')
        : `PROCESS_RECEIPT_${index.toString().padStart(2, '0')}：${success ? '已完成该步骤' : '首次读取未通过，后续步骤继续核对'}，原始结果完整保留。`
    rows.push({ ...row(`result-${index}`, 'tool', output, index * 1000 + 3), toolCallId: toolId(id, index), success,
      metadata: { ...metadata, success } })
  }
  if (id === threshold) rows.push(
    row('epilogue', 'assistant', 'THRESHOLD_EPILOGUE：工具执行完毕，整理最终结论。', 7_001),
    { ...row('trailing-reasoning', 'assistant', '', 7_002), reasoningContent: 'TRAILING_REASONING：这段纯思考保留在最后一个工具组之后。' }
  )
  if (id === thinkingOnly) rows.push({ ...row('reasoning-only', 'assistant', '', 1),
    reasoningContent: 'THINKING_ONLY：这一轮无需工具，保留思考记录并直接给出最终结论。' })
  if (id !== live) rows.push({ ...row('answer', 'assistant', finalText, 38_000),
    metadata: { ...metadata, finalResult: { schemaVersion: 1, sessionId: id, turnId: run.turnId, runId: run.runId,
      assistantMessageId: run.assistantMessageId, text: finalText, publishedAt: now + 38_000, items: [] } } })
  return rows
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Process reading must not mutate: ${path}`)
  }
  const run = ownedRun(id), rows = history(id)
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-layout-v1`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (isLive(id)) {
      streams.set(id, response); response.flushHeaders()
      response.once('close', () => { if (streams.get(id) === response) streams.delete(id) })
    } else response.end('data: [DONE]\n\n')
    return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'9'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'process-layout-fixture' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '过程布局测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: isLive(id) ? 'live' : 'persisted',
      eventId: isLive(id) ? `${run!.runId}:${id === bulk ? bulkProjections.length : projections.length}` : null, finished: !isLive(id), history: rows,
      projection: id === bulk ? bulkProjections : id === live ? projections : [], run, runs: run ? id === live ? [previousRun(), run] : [run] : [], subagentRuns: [], todos: [], changes: id === bulk ? bulkChanges : [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: isLive(id), finished: !isLive(id), run, lastEventId: isLive(id) ? `${run!.runId}:${id === bulk ? bulkProjections.length : projections.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: run ? id === live ? [previousRun(), run] : [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: history(sessionId).length }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'process-layout-tenant', sessionId: id,
      namespace: { id: 'process-layout-db', generation: 'one' }, transport: {
        toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(run), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: `binding-${id}`, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const message = (): Locator => conversation().locator('.work-message--assistant[data-process-view="focused"]').filter({ has: page.locator('.work-message__process-toggle') })
const toggle = (): Locator => message().locator('.work-message__process-toggle')
const viewport = (): Locator => message().getByRole('region', { name: '执行过程', exact: true })
const receipt = (id: string, index: number): Locator => message().locator(`[data-work-tool-id="${toolId(id, index)}"]`)
const toolSections = (): Locator => viewport().locator('.work-process-section:not([data-tool-count="0"])')
const sectionWithCount = (count: number): Locator => viewport().locator(`.work-process-section[data-tool-count="${count}"]`)

async function setSectionOpen(section: Locator, open: boolean): Promise<void> {
  const button = section.locator(':scope > .work-process-section__toggle')
  if (await button.getAttribute('aria-expanded') !== String(open)) await button.click()
  await expect(button).toHaveAttribute('aria-expanded', String(open))
  if (open) await expect(section.locator('.work-process-section__viewport')).toBeVisible()
  else await expect(section.locator('.work-process-section__viewport')).toHaveCount(0)
  await waitForProcessLayout()
}

async function selectTask(id: string): Promise<void> {
  await work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  if (await page.locator('html').getAttribute('data-appearance') === appearance) return
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '设置', exact: true, includeHidden: true })).toHaveCount(0)
}
async function expectContainedReceipt(target: Locator): Promise<void> {
  await expect(target).toBeVisible()
  const bounds = await target.evaluate(element => {
    const row = element.getBoundingClientRect(), frames: Array<{ top: number; bottom: number; height: number }> = []
    for (let node = element.parentElement; node; node = node.parentElement) if (node.hasAttribute('data-process-scroll')) {
      const scroll = node.getBoundingClientRect()
      frames.push({ top: row.top - scroll.top, bottom: row.top + Math.min(row.height, 28) - scroll.top, height: scroll.height })
    }
    return frames
  })
  expect(bounds.length).toBeGreaterThan(0)
  for (const frame of bounds) {
    expect(frame.top).toBeGreaterThanOrEqual(-1)
    expect(frame.bottom).toBeLessThanOrEqual(frame.height + 1)
  }
}

async function expectScrollEdges(edges: 'top' | 'bottom' | 'both' | null, target = viewport()): Promise<void> {
  await expect.poll(() => target.getAttribute('data-scroll-edges')).toBe(edges)
  const appearance = await target.evaluate(element => ({ mask: getComputedStyle(element).maskImage,
    outer: element.classList.contains('work-message__process-viewport') }))
  if (appearance.outer && edges) expect(appearance.mask).toContain('linear-gradient')
  else expect(appearance.mask).toBe('none')
}

async function waitForProcessLayout(): Promise<void> {
  await message().evaluate(element => new Promise<void>((resolve, reject) => {
    let previous = '', stable = 0
    const deadline = performance.now() + 5000
    const sample = (): void => {
      const viewport = element.querySelector('.work-message__process-viewport')!
      const content = element.querySelector('.work-message__process-content')!
      const process = element.querySelector('.work-message__process')!
      const rect = process.getBoundingClientRect()
      const geometry = JSON.stringify([rect.x, rect.y, rect.width, rect.height, viewport.clientHeight,
        viewport.scrollHeight, viewport.scrollTop, content.getBoundingClientRect().height])
      const moving = element.getAnimations({ subtree: true }).some(animation =>
        (animation.pending || animation.playState === 'running') && Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
      stable = !moving && geometry === previous ? stable + 1 : 0
      previous = geometry
      if (stable >= 4) resolve()
      else if (performance.now() >= deadline) reject(new Error(`Process layout did not settle: ${geometry}; finite animations running: ${moving}`))
      else requestAnimationFrame(sample)
    }
    // "open" starts the grid transition. Nested disclosures can start theirs
    // on the following frame, so neither DOM presence nor that state is ready.
    requestAnimationFrame(() => requestAnimationFrame(sample))
  }))
}

async function expectProcessHeaderLayout(expanded: boolean, hasAnswer = true): Promise<void> {
  await expect(toggle()).toHaveAttribute('aria-expanded', String(expanded))
  await expect(message().locator('.work-message__body')).toHaveCount(0)
  await expect(message().locator('.work-message__answer')).toHaveCount(hasAnswer ? 1 : 0)
  const divider = message().locator('.work-message__process-divider')
  await expect(divider).toHaveCount(hasAnswer ? 1 : 0)
  if (hasAnswer) await expect(divider).toHaveJSProperty('tagName', 'HR')
  if (expanded) {
    await expect(message().locator('.work-message__process')).toHaveAttribute('data-motion-state', 'open')
    await waitForProcessLayout()
  }
  else await expect(message().locator('.work-message__process-viewport')).toHaveCount(0)
  const layout = await message().evaluate(element => {
    const button = element.querySelector('.work-message__process-toggle')!
    const chevron = button.querySelector('.work-message__process-chevron')!
    const labels = [...button.querySelectorAll(':scope > span, :scope > small')].map(label => {
      const range = document.createRange(); range.selectNodeContents(label)
      return range.getBoundingClientRect().toJSON()
    })
    const divider = element.querySelector('.work-message__process-divider')
    const separator = divider?.getBoundingClientRect(), dividerStyle = divider ? getComputedStyle(divider) : null
    const blocks = [...element.querySelectorAll('.work-message__answer')]
    const content = blocks.map(block => {
      const paragraph = block.querySelector('.md > :first-child')
      if (!paragraph) throw new Error('Missing first body paragraph in process-layout fixture')
      return { block: block.getBoundingClientRect().toJSON(), paragraph: paragraph.getBoundingClientRect().toJSON() }
    })
    const process = element.querySelector('.work-message__process') ?? element.querySelector('.work-message__process-bar')!
    return { labels, chevron: chevron.getBoundingClientRect().toJSON(), trailingChevron: button.lastElementChild === chevron,
      contentLeft: element.querySelector('.work-message__timeline')!.getBoundingClientRect().left,
      separator: separator?.toJSON(), border: dividerStyle ? parseFloat(dividerStyle.borderTopWidth) : 0, style: dividerStyle?.borderTopStyle,
      content, processBottom: process.getBoundingClientRect().bottom,
      followsProcess: Boolean(divider && process.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING),
      precedesContent: Boolean(divider && blocks[0] && divider.compareDocumentPosition(blocks[0]) & Node.DOCUMENT_POSITION_FOLLOWING) }
  })
  expect(Math.abs(layout.labels[0].left - layout.contentLeft)).toBeLessThanOrEqual(1)
  expect(layout.content).toHaveLength(hasAnswer ? 1 : 0)
  for (const content of layout.content) {
    expect(Math.abs(layout.labels[0].left - content.paragraph.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.separator.left - content.block.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.separator.width - content.block.width)).toBeLessThanOrEqual(1)
  }
  expect(layout.trailingChevron).toBe(true)
  expect(layout.chevron.left).toBeGreaterThanOrEqual(Math.max(...layout.labels.map(label => label.right)))
  if (hasAnswer) {
    expect(layout.border).toBeGreaterThan(0); expect(layout.border).toBeLessThanOrEqual(2)
    expect(layout.style).toBe('solid')
    expect(layout.followsProcess).toBe(true); expect(layout.precedesContent).toBe(true)
    expect(layout.separator.top).toBeGreaterThanOrEqual(layout.processBottom - 1)
    expect(layout.separator.bottom).toBeLessThanOrEqual(layout.content[0].paragraph.top + 1)
  }
}

async function expectProcessToggleFeedback(): Promise<void> {
  await expect.poll(() => toggle().evaluate(element => {
    const color = getComputedStyle(element).color
    return [...element.querySelectorAll('small')].every(label => getComputedStyle(label).color === color)
  })).toBe(true)
  const feedback = await toggle().evaluate(element => {
    return { content: getComputedStyle(element, '::after').content,
      decorations: [element, ...element.querySelectorAll('span, small')].map(label => getComputedStyle(label).textDecorationLine) }
  })
  expect(feedback.content).toBe('none')
  for (const decoration of feedback.decorations) expect(decoration).toBe('none')
}

async function expectWholeProcessToggle(): Promise<void> {
  await expect(toggle()).toHaveJSProperty('tagName', 'BUTTON')
  await expect(toggle().locator('button, a, input, select, textarea, [role="button"], [tabindex]')).toHaveCount(0)
  await expect(toggle().locator('.work-message__process-failures')).toHaveText('1 步未通过')
  await toggle().locator(':scope > small').first().hover()
  await expectProcessToggleFeedback()
  const targets = [
    toggle().locator(':scope > span'),
    toggle().locator(':scope > small:not(.work-message__process-failures)'),
    toggle().locator('.work-message__process-failures'),
    toggle().locator('.work-message__process-chevron')
  ]
  for (const target of targets) {
    await target.click(); await expectProcessHeaderLayout(true)
    await target.click(); await expectProcessHeaderLayout(false)
  }
  const gap = await toggle().evaluate(element => {
    const button = element.getBoundingClientRect(), label = element.querySelector(':scope > span')!.getBoundingClientRect()
    const count = element.querySelector(':scope > small')!.getBoundingClientRect()
    if (count.left <= label.right) throw new Error('Missing process-button text gap')
    return { x: (label.right + count.left) / 2 - button.left, y: button.height / 2 }
  })
  await toggle().click({ position: gap }); await expectProcessHeaderLayout(true)
  await toggle().click({ position: gap }); await expectProcessHeaderLayout(false)
}

test.describe.serial('Work 展开过程阅读', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'process-layout-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    imageDataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 1440
      const context = canvas.getContext('2d'); if (!context) throw new Error('Fixture canvas unavailable')
      context.fillStyle = '#faf8f3'; context.fillRect(0, 0, 960, 1440)
      context.fillStyle = '#24344b'; context.font = '36px sans-serif'; context.fillText('DOCUMENT PREVIEW · 960 × 1440', 48, 90)
      context.fillStyle = '#ced7e4'; for (let index = 0; index < 12; index++) context.fillRect(48, 150 + index * 95, 864, 40)
      return canvas.toDataURL('image/png')
    })
    // A live snapshot replays the exact projection. History alone intentionally
    // marks unmatched calls unknown, so persist all real start/end frames here.
    const names = new Map<string, string>()
    for (const row of history(live).filter(row => row.metadata?.rootRunId === ownedRun(live)!.runId)) {
      if (row.role === 'user') projections.push({ userMessage: row })
      else if (row.role === 'assistant') {
        if (typeof row.reasoningContent === 'string') projections.push({ thinking: row.reasoningContent })
        if (typeof row.content === 'string' && row.content) projections.push({ content: row.content })
        if (row.toolCall?.id && row.toolCall.name) { names.set(row.toolCall.id, row.toolCall.name); projections.push({ toolStart: row.toolCall }) }
      } else if (typeof row.toolCallId === 'string') projections.push({ toolEnd: {
        id: row.toolCallId, name: names.get(row.toolCallId), output: row.content, success: row.success, finishedAt: row.createdAt
      } })
    }
    bulkProjections.push({ userMessage: history(bulk)[0] },
      { toolStart: { id: toolId(bulk, 0), name: 'execute_cmd', args: { command: 'npm install' } } },
      { toolEnd: { id: toolId(bulk, 0), name: 'execute_cmd', output: '已安装运行依赖。', success: true,
        finishedAt: now + 3, metadata: { changes: bulkChanges } } })
    await page.evaluate(({ key, entries, selected, model, timestamp }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: entries.map(([id, title]) => ({ id, title, status: id.endsWith('-live') ? 'running' : 'done',
        draft: '', mentions: [], createdAt: timestamp, updatedAt: timestamp, workspacePath: '/remote/process-layout', modelId: model, attachments: [], sources: [] })), activeTaskId: selected }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), entries: [...titles], selected: settled, model, timestamp: now })
    await page.reload()
    await expect(work().getByRole('heading', { name: titles.get(settled)!, exact: true })).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('work-process-layout-failure.png'); await page.screenshot({ path })
      await info.attach('展开过程失败窗口', { path, contentType: 'image/png' })
    }
    await info.attach('process-layout-fixture', { body: JSON.stringify({ errors, mutations, projections }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    for (const stream of streams.values()) stream.end('data: [DONE]\n\n')
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('process-layout-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('正文分段保留顺序，超过三步默认折叠且展开组独立滚动', async ({}, info) => {
    await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle()).toContainText('38 步')
    await expect(message().locator('.work-message__process-viewport')).toHaveCount(0)
    await expect(message()).not.toContainText('PROCESS_LAYOUT_NOTE')
    await expect(message().locator('.work-message__answer .md > p')).toHaveText(finalText.split('\n\n'))
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await toggle().scrollIntoViewIfNeeded()
      await expectProcessHeaderLayout(false)
      await expectWholeProcessToggle()
      await toggle().locator(':scope > small').first().hover()
      await expectProcessToggleFeedback()
      await page.mouse.move(0, 0)
      await toggle().focus(); await page.keyboard.press('Enter')
      await expect(viewport()).toBeVisible()
      await expectProcessHeaderLayout(true)
      await expect(toggle()).toBeFocused()
      expect(await toggle().evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await expect(message().locator('.work-message__thinking-toggle, .work-activity-group')).toHaveCount(0)
      await expect(viewport()).not.toContainText('PROCESS_LAYOUT_THINKING')
      await expect(toolSections()).toHaveCount(3)
      expect(await toolSections().evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-tool-count'))))).toEqual([13, 23, 2])
      for (const count of [13, 23]) {
        await expect(sectionWithCount(count).locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'false')
        await expect(sectionWithCount(count).locator('[data-work-tool-id]')).toHaveCount(0)
      }
      await expect(sectionWithCount(2).locator('.work-process-section__toggle')).toHaveCount(0)
      await expect(sectionWithCount(2).locator('[data-work-tool-id]')).toHaveCount(2)
      await expect(viewport().locator('.work-message__process-note')).toHaveText([0, 13, 36].map(index => `${noteText}（阶段 ${index + 1}）`))
      const compactPath = info.outputPath(`work-process-sections-${appearance}.png`)
      await page.screenshot({ path: compactPath, animations: 'disabled' })
      await info.attach(`分段收起 ${appearance}`, { path: compactPath, contentType: 'image/png' })

      for (const count of [13, 23]) await setSectionOpen(sectionWithCount(count), true)
      await expect(viewport().locator('[data-work-tool-id]')).toHaveCount(38)
      const ordered = await viewport().locator('.work-message__process-note, [data-work-tool-id]').evaluateAll(elements =>
        elements.map(element => element.getAttribute('data-work-tool-id') ?? element.textContent?.trim()))
      expect(ordered).toEqual(Array.from({ length: 38 }, (_, index) =>
        [0, 13, 36].includes(index) ? [`${noteText}（阶段 ${index + 1}）`, toolId(settled, index)] : [toolId(settled, index)]).flat())
      await expect(viewport()).not.toContainText('PROCESS_LAYOUT_FINAL')
      await expect(message().getByText('PROCESS_LAYOUT_FINAL：文档检查已完成。', { exact: true })).toHaveCount(1)
      await expect(viewport().locator('.work-message__body, .work-message__answer, img')).toHaveCount(0)
      await expect(viewport()).toHaveCSS('scrollbar-width', 'none')
      const firstReader = sectionWithCount(13).locator('.work-process-section__viewport')
      await expect(firstReader).toHaveCSS('scrollbar-width', 'auto')
      expect(await firstReader.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').width)).toBe('6px')
      await firstReader.scrollIntoViewIfNeeded()
      await firstReader.evaluate(element => { element.scrollTop = 0 })
      await waitForProcessLayout()
      const before = await firstReader.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight,
        maximum: element.scrollHeight - element.clientHeight, outerTop: element.closest('.work-message__process-viewport')!.scrollTop,
        conversationTop: element.closest('.work-conversation__scroll')!.scrollTop }))
      expect(before.maximum).toBeGreaterThan(30)
      expect(before.height).toBeLessThanOrEqual(320)
      await firstReader.hover(); await page.mouse.wheel(0, 60)
      await expect.poll(() => firstReader.evaluate(element => element.scrollTop)).toBeGreaterThan(10)
      await waitForProcessLayout()
      const after = await firstReader.evaluate(element => ({ top: element.scrollTop,
        outerTop: element.closest('.work-message__process-viewport')!.scrollTop,
        conversationTop: element.closest('.work-conversation__scroll')!.scrollTop }))
      expect(Math.abs(after.outerTop - before.outerTop)).toBeLessThanOrEqual(1)
      expect(Math.abs(after.conversationTop - before.conversationTop)).toBeLessThanOrEqual(1)
      await toggle().focus(); await page.keyboard.press('Space')
      await expect(message().locator('.work-message__process-viewport')).toHaveCount(0)
      await expectProcessHeaderLayout(false)
      await expect(message()).not.toContainText('PROCESS_LAYOUT_NOTE')
      await toggle().click(); await expectProcessHeaderLayout(true)
      await expect(sectionWithCount(13).locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect.poll(() => firstReader.evaluate((element, saved) => Math.abs(element.scrollTop - saved), after.top)).toBeLessThanOrEqual(1)
      await expect(viewport().locator('[data-work-tool-id]')).toHaveCount(38)

      await message().getByRole('button', { name: '查看最新步骤', exact: true }).click()
      await expectContainedReceipt(receipt(settled, 37))
      const lastReceipt = receipt(settled, 37).locator('button.logline')
      // The newest receipt is readable immediately; older receipts stay compact.
      if (await lastReceipt.getAttribute('aria-expanded') !== 'true') await lastReceipt.click()
      await expect(lastReceipt).toHaveAttribute('aria-expanded', 'true')
      await expect(receipt(settled, 37)).toContainText('PROCESS_RECEIPT_37')
      await lastReceipt.click(); await expect(lastReceipt).toHaveAttribute('aria-expanded', 'false')
      const preview = receipt(settled, 35), previewButton = preview.locator('button.logline')
      await expect(previewButton.locator('.logline__name')).toHaveText('检查幻灯片实际画面')
      await expect(previewButton).toHaveAttribute('aria-expanded', 'false')
      await previewButton.click()
      await expect.poll(() => preview.locator('img').evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth)).toBe(960)
      await expect(preview.locator('img')).toHaveCSS('max-height', '160px')
      await preview.getByRole('button', { name: '放大查看 文档检查完整画面', exact: true }).click()
      const viewer = page.getByRole('dialog', { name: '文档检查完整画面', exact: true })
      await expect(viewer).toBeVisible()
      await expect.poll(() => viewer.locator('.image-editor__surface > img').evaluate(image => image.getBoundingClientRect().height)).toBeGreaterThan(160)
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(viewer).toHaveCount(0)
      await previewButton.click(); await expect(preview.locator('img')).toHaveCount(0)
      await firstReader.evaluate(element => { element.scrollTop = 0 })
      await firstReader.scrollIntoViewIfNeeded()
      const path = info.outputPath(`work-process-focused-${appearance}.png`)
      await page.screenshot({ path, animations: 'disabled' }); await info.attach(`展开过程 ${appearance}`, { path, contentType: 'image/png' })
      for (const count of [13, 23]) await setSectionOpen(sectionWithCount(count), false)
      await toggle().click(); await expectProcessHeaderLayout(false)
      await expect(message().locator('.work-message__answer')).toContainText('正文只保留交付结论')
    }
  })

  test('首尾图标打开折叠组，分页与组内阅读位置可用键盘恢复', async () => {
    await selectTask(paged)
    await toggle().click(); await expectProcessHeaderLayout(true)
    const section = sectionWithCount(105), reader = section.locator('.work-process-section__viewport')
    await expect(section.locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(reader).toBeVisible()
    const pages = section.getByRole('navigation', { name: '活动分页', exact: true })
    await expect(pages).toContainText('101–105 / 105')
    const first = message().getByRole('button', { name: '查看最早步骤', exact: true })
    const latest = message().getByRole('button', { name: '查看最新步骤', exact: true })
    for (const [button, label] of [[first, '查看最早步骤'], [latest, '查看最新步骤']] as const) {
      await expect(button).toBeVisible(); await expect(button).toHaveText('')
      await expect(button).toHaveAttribute('title', label); await expect(button.locator('svg')).toHaveCount(1)
    }
    await first.focus(); await page.keyboard.press('Enter')
    await expect(section.locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(pages).toContainText('1–100 / 105')
    await waitForProcessLayout(); await expectContainedReceipt(receipt(paged, 0))
    await expectScrollEdges('bottom', reader)
    await reader.hover(); await page.mouse.wheel(0, 300)
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await expectScrollEdges('both', reader)
    await waitForProcessLayout()
    const top = await reader.evaluate(element => element.scrollTop)
    await toggle().click(); await expectProcessHeaderLayout(false)
    await toggle().click(); await expectProcessHeaderLayout(true)
    await expect(pages).toContainText('1–100 / 105')
    await expect.poll(() => reader.evaluate((element, saved) => Math.abs(element.scrollTop - saved), top)).toBeLessThanOrEqual(1)
    await latest.click(); await expect(pages).toContainText('101–105 / 105')
    await waitForProcessLayout(); await expectContainedReceipt(receipt(paged, 104))
    const longReceipt = receipt(paged, 104).locator('button.logline')
    if (await longReceipt.getAttribute('aria-expanded') !== 'true') await longReceipt.click()
    await expect(longReceipt).toHaveAttribute('aria-expanded', 'true')
    await waitForProcessLayout()
    expect(await reader.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100)
    await reader.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expectScrollEdges('top', reader)
    await longReceipt.click(); await expect(longReceipt).toHaveAttribute('aria-expanded', 'false')
    await waitForProcessLayout()
    await setSectionOpen(section, false)
    await latest.click()
    await expect(section.locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(pages).toContainText('101–105 / 105')
    await waitForProcessLayout(); await expectContainedReceipt(receipt(paged, 104))
    await first.focus(); await page.keyboard.press('Enter')
    await expect(pages).toContainText('1–100 / 105')
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1)
    await waitForProcessLayout(); await expectContainedReceipt(receipt(paged, 0))
    await toggle().click(); await expectProcessHeaderLayout(false)
  })

  test('运行中的最新阶段保留摘要，工具详情默认收起且支持手动与活动定位展开', async ({}, info) => {
    await selectTask(live)
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await expectProcessHeaderLayout(true, false)
    await expect(viewport().locator('.work-message__process-note')).toHaveText([0, 13, 33].map(index => `${noteText}（阶段 ${index + 1}）`))
    await expect(sectionWithCount(5).locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(receipt(live, 37)).toHaveCount(1)
    const runningTool = receipt(live, 37).locator('button.logline')
    await expect(runningTool).toHaveAttribute('aria-expanded', 'false')
    await expect(runningTool).toBeDisabled() // This in-flight call has no output yet.
    const completedTool = receipt(live, 36).locator('button.logline')
    await expect(completedTool).toHaveAttribute('aria-expanded', 'false')
    await completedTool.click(); await expect(completedTool).toHaveAttribute('aria-expanded', 'true')
    await expect(receipt(live, 36).locator('.logline__detail')).toContainText('PROCESS_RECEIPT_36')
    await completedTool.click(); await expect(completedTool).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => streams.has(live)).toBe(true)
    const outer = conversation().locator('.work-conversation__scroll'), feedback = conversation().locator('.work-turn-feedback')
    await outer.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(feedback).toHaveAttribute('data-current-run-feedback', 'true')
    await expect(conversation().locator('.work-run-status')).toHaveCount(0)
    await expect(feedback.getByRole('button', { name: '停止任务', exact: true })).toBeEnabled()
    await expect(feedback.locator('.work-turn-feedback__elapsed')).toContainText(/秒|分/)
    await outer.hover({ position: { x: 8, y: 32 } }); await page.mouse.wheel(0, -5000)
    await expect.poll(() => outer.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1)
    const earlierAnswer = conversation().locator('.work-message--assistant').filter({ hasText: 'EARLIER_REVIEW_0' })
    await expect(earlierAnswer).toContainText('EARLIER_REVIEW_31')
    await expect(earlierAnswer.locator('.work-message__process-toggle')).toHaveCount(0)
    await expect(conversation().locator('.work-run-status')).toHaveCount(1)
    await expect(conversation().locator('[data-current-run-feedback="true"]')).toHaveCount(1)
    await conversation().getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(feedback).toHaveAttribute('data-current-run-feedback', 'true')
    await expect(conversation().locator('.work-run-status')).toHaveCount(0)
    await setSectionOpen(sectionWithCount(5), true)
    const preview = receipt(live, 35), previewButton = preview.locator('button.logline')
    await expect(previewButton).toHaveAttribute('aria-expanded', 'false')
    await expect(preview.locator('img')).toHaveCount(0)
    await previewButton.click(); await expect(preview.locator('img')).toHaveCount(1)
    await previewButton.click(); await expect(preview.locator('img')).toHaveCount(0)
    for (let attempt = 0; attempt < 2; attempt++) {
      await setSectionOpen(sectionWithCount(5), false)
      await toggle().click(); await expectProcessHeaderLayout(false, false)
      await expect(message()).not.toContainText('PROCESS_LAYOUT_NOTE')
      await conversation().getByRole('button', { name: '查看正在执行的活动', exact: true }).click()
      await expectProcessHeaderLayout(true, false)
      await expect(sectionWithCount(5).locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(receipt(live, 37)).toBeFocused()
      await expect(runningTool).toHaveAttribute('aria-expanded', 'true')
      await expectContainedReceipt(receipt(live, 37))
    }
    await toggle().click(); await expectProcessHeaderLayout(false, false)
    for (const payload of [
      { content: 'PROCESS_STREAM_TICK：仍在等待页面状态。' },
      { toolStart: { id: toolId(live, 37), name: 'browser_wait', args: { url: 'https://process-stream-tick.example.test/review', timeout_ms: 1000 } } }
    ] satisfies ChatSsePayload[]) {
      projections.push(payload)
      streams.get(live)!.write(`id: ${ownedRun(live)!.runId}:${projections.length}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    await expect(conversation().getByRole('button', { name: '查看正在执行的活动', exact: true })).toContainText('process-stream-tick.example.test')
    await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await expect(message().locator('.work-message__body, .work-message__answer, .work-message__process-note')).toHaveCount(0)
    await toggle().click(); await expectProcessHeaderLayout(true, false)
    await expect(viewport().locator('.work-message__process-note').last()).toContainText('PROCESS_STREAM_TICK')
    await expect(viewport().getByText('PROCESS_STREAM_TICK：仍在等待页面状态。', { exact: true })).toHaveCount(1)
    await expect(previewButton).toHaveAttribute('aria-expanded', 'false')
    const path = info.outputPath('work-process-focused-running.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('运行中的过程阅读', { path, contentType: 'image/png' })
  })

  test('只自动展开最新思考，后续工具收起旧思考，手动选择持续保留', async ({}, info) => {
    await selectTask(live)
    if (await toggle().getAttribute('aria-expanded') !== 'true') await toggle().click()
    const preferences = page.getByRole('dialog', { name: '对话偏好', exact: true })
    await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
    const visibility = preferences.getByRole('switch', { name: '显示思考', exact: true })
    if (!await visibility.isChecked()) await visibility.click()
    await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
    await expect.poll(() => streams.has(live)).toBe(true)
    const publish = (payload: ChatSsePayload): void => {
      projections.push(payload)
      streams.get(live)!.write(`id: ${ownedRun(live)!.runId}:${projections.length}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    const thought = (marker: string): Locator => viewport().locator('.work-message__thinking').filter({ hasText: marker })
    publish({ thinking: 'LATEST_THOUGHT_A：先核对输入，再读取文件。' })
    const first = thought('LATEST_THOUGHT_A'), firstButton = first.locator('button.logline')
    await expect(firstButton).toHaveAttribute('aria-expanded', 'true')
    await expect(first.locator('.logline__detail--thinking')).toBeVisible()

    publish({ toolStart: { id: toolId(live, 38), name: 'read_file', args: { path: `${workspaceRoot}/latest-thought.txt` } } })
    const tool = receipt(live, 38), toolButton = tool.locator('button.logline')
    await expect(toolButton).toHaveAttribute('aria-expanded', 'false')
    await expect(firstButton).toHaveAttribute('aria-expanded', 'false')
    await expect(first.locator('.logline__detail--thinking')).toHaveCount(0)
    publish({ toolEnd: { id: toolId(live, 38), name: 'read_file', output: 'THOUGHT_TOOL_RESULT：读取完成。', success: true } })
    await expect(toolButton).toHaveAttribute('aria-expanded', 'false')
    await expect(tool.locator('.logline__detail')).toHaveCount(0)
    publish({ thinking: 'LATEST_THOUGHT_B：已有读取结果，继续核对结论。' })
    const latest = thought('LATEST_THOUGHT_B'), latestButton = latest.locator('button.logline')
    await expect(latestButton).toHaveAttribute('aria-expanded', 'true')
    await expect(firstButton).toHaveAttribute('aria-expanded', 'false')
    await expect(toolButton).toHaveAttribute('aria-expanded', 'false')

    await firstButton.click(); await expect(firstButton).toHaveAttribute('aria-expanded', 'true')
    await latestButton.click(); await expect(latestButton).toHaveAttribute('aria-expanded', 'false')
    publish({ thinking: ' THOUGHT_CONTINUED：补齐检查说明。' })
    await expect(latest).toContainText('THOUGHT_CONTINUED')
    await expect(latestButton).toHaveAttribute('aria-expanded', 'false')
    publish({ toolStart: { id: toolId(live, 39), name: 'read_file', args: { path: `${workspaceRoot}/next-thought.txt` } } })
    await expect(receipt(live, 39).locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(firstButton).toHaveAttribute('aria-expanded', 'true')
    await expect(latestButton).toHaveAttribute('aria-expanded', 'false')
    const path = info.outputPath('latest-thinking-only.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('最新思考与收起的工具详情', { path, contentType: 'image/png' })
  })

  test('单次命令的 150 条文件记录进入工具列表，新正文自动收起并可完整重开', async ({}, info) => {
    await selectTask(bulk)
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle()).toContainText('1 步')
    const group = viewport().locator(`[data-process-section="tool:${toolId(bulk, 0)}"]`)
    const button = group.locator(':scope > .work-process-section__toggle')
    const files = group.locator('.work-file-change-row')
    await expect(group).toHaveAttribute('data-tool-count', '1')
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(button).toContainText('工具调用 1')
    await expect(button).toContainText('文件变更 150')
    await expect(files).toHaveCount(150)
    const naturalFlow = await viewport().evaluate(element => ({ maxHeight: getComputedStyle(element).maxHeight,
      overflowY: getComputedStyle(element).overflowY }))
    expect(naturalFlow).toEqual({ maxHeight: 'none', overflowY: 'visible' })
    await expect.poll(() => streams.has(bulk)).toBe(true)
    const publish = (payload: ChatSsePayload): void => {
      bulkProjections.push(payload)
      streams.get(bulk)!.write(`id: ${ownedRun(bulk)!.runId}:${bulkProjections.length}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    publish({ content: 'BULK_NEXT_NOTE：缓存文件已生成，继续检查运行环境。' })
    await expect(viewport().locator('.work-message__process-note')).toContainText('BULK_NEXT_NOTE')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(files).toHaveCount(0)
    publish({ toolStart: { id: toolId(bulk, 1), name: 'execute_cmd', args: { command: 'mh doctor' } } })
    await expect(receipt(bulk, 1).locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(button).toHaveAttribute('aria-expanded', 'false')

    await setSectionOpen(group, true)
    await expect(files).toHaveCount(150)
    expect(await files.evaluateAll(elements => elements.map(element => element.getAttribute('data-change-id'))))
      .toEqual(bulkChanges.map(change => change.id))
    const reader = group.getByRole('region', { name: '阶段过程', exact: true })
    const first = group.locator('[data-change-id="bulk-change-0"]'), last = group.locator('[data-change-id="bulk-change-149"]')
    await reader.evaluate(element => { element.dispatchEvent(new Event('work-process-first')) })
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1)
    await expectContainedReceipt(first); await expect(first).toBeEnabled()
    await reader.evaluate(element => { element.dispatchEvent(new Event('work-process-latest')) })
    await expect.poll(() => reader.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1)
    await expectContainedReceipt(last); await expect(last).toBeEnabled()
    publish({ toolEnd: { id: toolId(bulk, 1), name: 'execute_cmd', output: 'Environment healthy', success: true } })
    publish({ content: 'BULK_FINAL_NOTE：环境检查完成。' })
    await expect(viewport()).toContainText('BULK_FINAL_NOTE')
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(group).toHaveAttribute('data-tool-count', '1')
    await expect(button).toContainText('工具调用 1')
    const path = info.outputPath('bulk-file-receipts.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('批量文件回执', { path, contentType: 'image/png' })
  })

  test('三步直接显示、四步折叠；思考偏好默认隐藏且按会话保留', async ({}, info) => {
    await selectTask(threshold)
    await toggle().click(); await expectProcessHeaderLayout(true)
    const three = sectionWithCount(3), four = sectionWithCount(4)
    await expect(three.locator('.work-process-section__toggle, .work-process-section__viewport')).toHaveCount(0)
    await expect(three.locator('[data-work-tool-id]')).toHaveCount(3)
    await expect(four).toHaveAttribute('data-thinking-count', '1')
    await expect(four.locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(four.locator('[data-work-tool-id]')).toHaveCount(0)
    await expect(message()).not.toContainText('SECTION_REASONING')
    const preferences = page.getByRole('dialog', { name: '对话偏好', exact: true })
    await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
    const visibility = preferences.getByRole('switch', { name: '显示思考', exact: true })
    await expect(visibility).not.toBeChecked()
    const effort = preferences.getByRole('button', { name: /^思考档位：/ })
    const originalEffort = await effort.innerText()
    await visibility.click(); await expect(visibility).toBeChecked()
    await expect(effort).toHaveText(originalEffort)
    for (const appearance of ['light', 'dark'] as const) {
      await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
      await expect(page.locator('.composer-options-panel')).toHaveCount(0)
      await setAppearance(appearance)
      await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
      await expect(visibility).toBeChecked()
      const geometry = await preferences.locator('.composer-options__row').evaluateAll(rows => rows.map(row => {
        const title = row.querySelector('.composer-options__title')?.getBoundingClientRect()
        const summary = row.querySelector('.composer-options__summary')?.getBoundingClientRect()
        return title && summary ? summary.top - title.bottom : null
      }))
      for (const gap of geometry) if (gap !== null) { expect(gap).toBeGreaterThanOrEqual(0); expect(gap).toBeLessThanOrEqual(10) }
      const path = info.outputPath(`conversation-preferences-${appearance}.png`)
      await page.screenshot({ path, animations: 'disabled' }); await info.attach(`对话偏好 ${appearance}`, { path, contentType: 'image/png' })
    }
    await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
    await expect(viewport().locator('.work-process-section[data-tool-count="0"]')).toHaveCount(2)
    const sectionCounts = await viewport().locator('.work-process-section').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-tool-count'))))
    expect(sectionCounts).toEqual([0, 3, 4, 0])
    // Reasoning-only prelude/epilogue must not consume execution navigation.
    await expect(four.locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'false')
    await message().getByRole('button', { name: '查看最新步骤', exact: true }).click()
    await expect(four.locator('.work-process-section__toggle')).toHaveAttribute('aria-expanded', 'true')
    await waitForProcessLayout(); await expectContainedReceipt(receipt(threshold, 6))
    await expect(four.locator('[data-work-tool-id]')).toHaveCount(4)
    await expect(four).toContainText('SECTION_REASONING')
    await message().getByRole('button', { name: '查看最早步骤', exact: true }).click()
    await waitForProcessLayout(); await expectContainedReceipt(receipt(threshold, 0))
    await page.reload()
    await expect(work().getByRole('heading', { name: titles.get(threshold)!, exact: true })).toBeVisible()
    if (await toggle().getAttribute('aria-expanded') !== 'true') await toggle().click()
    await expectProcessHeaderLayout(true)
    await setSectionOpen(sectionWithCount(4), true)
    await expect(sectionWithCount(4)).toContainText('SECTION_REASONING')
    await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(visibility).toBeChecked(); await expect(effort).toHaveText(originalEffort)
    await visibility.click(); await expect(visibility).not.toBeChecked()
    await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
    await expect(message()).not.toContainText('SECTION_REASONING')
    await expect(sectionWithCount(4).locator('[data-work-tool-id]')).toHaveCount(4)
    await selectTask(settled)
    await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
    await expect(visibility).not.toBeChecked()
    await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
  })

  test('只有思考和最终回复时，默认不留空过程入口，显示偏好即时控制入口与内容', async () => {
    await selectTask(thinkingOnly)
    const answer = conversation().locator('.work-message--assistant[data-process-view="focused"]')
    await expect(answer).toHaveCount(1)
    await expect(answer.locator('.work-message__answer .md > p')).toHaveText(finalText.split('\n\n'))
    await expect(answer.locator('.work-message__process-toggle, .work-message__process-viewport, .work-message__process-divider')).toHaveCount(0)
    await expect(answer).not.toContainText('THINKING_ONLY')
    const preferences = page.getByRole('dialog', { name: '对话偏好', exact: true })
    await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
    const visibility = preferences.getByRole('switch', { name: '显示思考', exact: true })
    await expect(visibility).not.toBeChecked()
    await visibility.click(); await expect(visibility).toBeChecked()
    await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
    await expect(answer.locator('.work-message__process-toggle')).toHaveCount(1)
    await toggle().click(); await expectProcessHeaderLayout(true)
    await expect(viewport()).toContainText('THINKING_ONLY')
    await expect(viewport().locator('[data-work-tool-id]')).toHaveCount(0)
    await conversation().getByRole('button', { name: '对话偏好', exact: true }).click()
    await visibility.click(); await expect(visibility).not.toBeChecked()
    await preferences.getByRole('button', { name: '关闭对话偏好', exact: true }).click()
    await expect(answer.locator('.work-message__process-toggle, .work-message__process-viewport, .work-message__process-divider')).toHaveCount(0)
    await expect(answer).not.toContainText('THINKING_ONLY')
    await expect(answer.locator('.work-message__answer .md > p')).toHaveText(finalText.split('\n\n'))
  })
})
