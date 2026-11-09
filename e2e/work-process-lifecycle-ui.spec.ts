/** Real Electron + authenticated HTTP/SSE: a root turn's running process and
 * thinking choices must not pin its completed process open. Covers waiting,
 * repeated activity reveal, complete command argv, failed receipts, settled reading, later turns and
 * offscreen completion, contextual thinking controls and the compact answer
 * footer. Build first; this owns a profile and ephemeral port and
 * must run with workers: 1 because Electron holds a single-instance lock. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'process-lifecycle-token', modelId = 'process-lifecycle-model', workspaceRoot = '/remote/process-lifecycle'
const prompts = ['核对过程完成后的折叠', '核对失败工具和旧轮次', '核对离开任务期间完成', '核对离页取消活动定位']
const errors: string[] = [], chats: Record<string, unknown>[] = [], history: EngineHistoryRow[] = []
const truncateCalls: Array<{ sessionId: string; messageId: string; removedIds: string[] }> = [], fileReverts: string[] = []
const originalAttachment = { name: 'lifecycle-original.txt', type: 'text/plain', size: 24 }
const roots: RootRun[] = [], projection: ChatSsePayload[] = [], events: Array<{ runId: string; payload: ChatSsePayload }> = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
type FooterRect = { x: number; y: number; width: number; height: number; opacity: number }
type FooterGeometry = Record<'row' | 'usage' | 'copy' | 'regenerate' | 'body' | 'composer', FooterRect>
const footerGeometry: Array<{ label: string; frames: FooterGeometry[] }> = []
let current: RootRun | undefined, activeStream: ServerResponse | undefined
let nextRun = 0, mutationRevision = 0
let app: ElectronApplication | undefined, page: Page, fixture = ''
let originalClipboard: { text: string; html: string; rtf: string; imageDataUrl: string } | undefined
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const toolId = (ordinal: number): string => `lifecycle-read-${ordinal}`
const finalText = (ordinal: number): string => `LIFECYCLE_FINAL_${ordinal}：这一轮已完成，最终回复应始终可见。`
const commandScript = `npm test -- ${'--project=running-command-evidence '.repeat(10)}LIFECYCLE_COMMAND_TAIL`
const commandInvocation = `cmd.exe /d /s /c ${JSON.stringify(commandScript)}`
const toolName = (ordinal: number): string => ordinal === 2 ? 'execute_cmd' : 'read_file'

function publish(payload: ChatSsePayload): void {
  if (!current) throw new Error('Missing owned root run')
  projection.push(payload); events.push({ runId: current.runId, payload })
  // Execution persists when its view unsubscribes; a returning client reads the snapshot.
  if (activeStream && !activeStream.destroyed && !activeStream.writableEnded)
    activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function updateRun(patch: Partial<RootRun>): RootRun {
  if (!current) throw new Error('Missing owned root run')
  current = { ...current, ...patch, version: current.version + 1, updatedAt: Date.now() }
  roots[roots.findIndex(run => run.runId === current!.runId)] = current
  return current
}
function finishStream(): void {
  activeStream?.end('data: [DONE]\n\n'); activeStream = undefined
}
function archiveAssistant(id: string, fields: Partial<EngineHistoryRow>): void {
  if (!current) throw new Error('Missing owned root run')
  history.push({ id, role: 'assistant', content: '', conversationId: current.turnId, createdAt: Date.now(),
    metadata: { rootRunId: current.runId, turnId: current.turnId }, ...fields })
}
function finishTool(success: boolean): void {
  if (!current) throw new Error('Missing owned root run')
  const id = toolId(current.seq), output = success ? `LIFECYCLE_READ_${current.seq}_OK` : 'LIFECYCLE_FAILED_RECEIPT：fixture command returned exit code 1'
  history.push({ id: `result-${id}`, role: 'tool', toolCallId: id, content: output, success,
    conversationId: current.turnId, createdAt: Date.now(), metadata: { rootRunId: current.runId, turnId: current.turnId, success } })
  publish({ toolEnd: { id, name: toolName(current.seq), output, success, finishedAt: Date.now() } })
}
function complete(): void {
  if (!current || current.status !== 'running') throw new Error('Only a running root may finish')
  const text = finalText(current.seq), now = Date.now()
  const finalResult = { schemaVersion: 1 as const, sessionId: current.sessionId, turnId: current.turnId,
    runId: current.runId, assistantMessageId: current.assistantMessageId, text, publishedAt: now, items: [] }
  const usage = { promptTokens: 1_400_000, completionTokens: 100_000, totalTokens: 1_500_000, modelId }
  archiveAssistant(current.assistantMessageId, { content: text, usage, modelId, metadata: { rootRunId: current.runId, turnId: current.turnId, finalResult } })
  publish({ content: text }); publish({ usage }); publish({ finalResult })
  publish({ run: updateRun({ status: 'succeeded', finishedAt: now }) }); finishStream()
}
function requestPermission(): void {
  if (!current || current.status !== 'running') throw new Error('Expected a running root before permission')
  const description = 'LIFECYCLE_PERMISSION：请拒绝这次测试操作，然后继续核对过程；fixture 不执行命令。'
  publish({ ask_user: { toolCallId: 'lifecycle-permission-tool', question: description, options: ['approved', 'rejected'] } })
  publish({ permissionRequest: { requestId: 'lifecycle-permission-tool', toolName: 'execute_command', args: { command: 'fixture-only' }, description } })
  publish({ run: updateRun({ status: 'waiting', pending: [{ requestId: 'lifecycle-permission', toolCallId: 'lifecycle-permission-tool',
    toolName: 'execute_command', kind: 'permission', args: { command: 'fixture-only' }, description, status: 'pending' }] }) })
  finishStream()
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const parsed: unknown = raw ? JSON.parse(raw) : {}, input = record(parsed) ? parsed : {}
  if (path.includes('/revert')) {
    fileReverts.push(`${request.method} ${path}`)
    throw new Error('Regeneration must not request any file rollback')
  }
  if (path === '/api/v1/conversation/truncate' && request.method === 'POST') {
    if (!current || current.sessionId !== input.sessionId || ['running', 'waiting'].includes(current.status)) throw new Error('Invalid truncate ownership or active root')
    const index = history.findIndex(row => row.role === 'user' && row.id === input.messageId)
    if (index < 0) throw new Error('Truncate must use an existing original user message ID')
    const removed = history.splice(index)
    truncateCalls.push({ sessionId: String(input.sessionId), messageId: String(input.messageId), removedIds: removed.flatMap(row => row.id ? [row.id] : []) })
    const removedRuns = new Set(removed.map(row => row.metadata?.rootRunId))
    roots.splice(0, roots.length, ...roots.filter(run => !removedRuns.has(run.runId)))
    current = roots.at(-1); projection.length = 0; mutationRevision++
    response.end(envelope({ success: true })); return
  }
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'lifecycle-tenant', sessionId,
      namespace: { id: 'lifecycle-db', generation: 'one' }, transport: {
        toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: matching, predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission,
      sessionId: accepted.run.sessionId, rootRunId: accepted.run.runId, turnId: accepted.run.turnId,
      userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId }, run: accepted.run,
      projection: { rootVersion: accepted.run.version, rootAttemptId: `attempt-${accepted.run.runId}`,
        user: { messageId: accepted.run.userMessageId, state: 'projected' },
        assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    chats.push(input)
    if (activeStream && !activeStream.destroyed && !activeStream.writableEnded) throw new Error('Unexpected overlapping chat stream')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    activeStream = response
    response.once('close', () => { if (activeStream === response) activeStream = undefined })
    if (record(input.toolResponse)) {
      if (!current || current.status !== 'waiting' || input.sessionId !== current.sessionId || input.runId !== current.runId ||
        input.toolResponse.requestId !== 'lifecycle-permission' || input.toolResponse.output !== 'rejected') throw new Error('Unexpected permission response')
      publish({ run: updateRun({ status: 'running', pending: current.pending.map(item => ({ ...item, status: 'answered', output: 'rejected' })) }) })
      const resumed = 'LIFECYCLE_RESUMED：已收到选择，原轮次继续执行。'
      archiveAssistant(`resumed-${current.runId}`, { content: resumed }); publish({ content: resumed })
      return
    }
    if (current && ['running', 'waiting'].includes(current.status)) throw new Error('A new root cannot replace active work')
    const ordinal = ++nextRun, now = Date.now(), id = String(input.sessionId)
    current = { schemaVersion: 1, runId: `lifecycle-run-${ordinal}`, sessionId: id, turnId: `lifecycle-turn-${ordinal}`,
      userMessageId: `lifecycle-user-${ordinal}`, assistantMessageId: `lifecycle-assistant-${ordinal}`,
      seq: ordinal, version: 1, status: 'running', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    roots.push(current); projection.length = 0
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: String(input.message), createdAt: now,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId,
        ...(ordinal === 3 ? { attachments: [originalAttachment] } : Array.isArray(input.attachments) ? { attachments: input.attachments } : {}) } }
    history.push(user); publish({ run: current }); publish({ userMessage: user })
    const thinking = `LIFECYCLE_THINKING_${ordinal}：先核对输入，再读取文件并汇总结果。`
    const content = `LIFECYCLE_PROCESS_${ordinal}：正在读取参考资料。`
    const tool = { id: toolId(ordinal), name: toolName(ordinal), args: ordinal === 2
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', commandScript] }
      : { path: `${workspaceRoot}/input-${ordinal}.txt` } }
    archiveAssistant(`lifecycle-step-${ordinal}`, { reasoningContent: thinking, content, toolCall: tool })
    publish({ thinking }); publish({ content }); publish({ toolStart: tool })
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (current?.sessionId === sessionId && current.status === 'running') {
      if (activeStream && !activeStream.destroyed && !activeStream.writableEnded) throw new Error('Unexpected duplicate subscription')
      activeStream = response; response.once('close', () => { if (activeStream === response) activeStream = undefined })
    } else response.end('data: [DONE]\n\n')
    return
  }
  const matching = current?.sessionId === sessionId ? current : undefined, rows = matching ? history : []
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `lifecycle-${rows.length}-${matching?.version ?? 0}`,
      mutationRevision: `lifecycle-mutation-${mutationRevision}`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected fixture mutation ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'lifecycle-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '过程状态测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: matching && projection.length ? 'live' : 'persisted',
      eventId: matching && projection.length ? `${matching.runId}:${projection.length}` : null, finished: matching?.status !== 'running',
      projection: matching ? projection : [], history: rows, run: matching, runs: matching ? roots : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: matching?.status === 'running', finished: matching?.status !== 'running', run: matching,
      lastEventId: matching && projection.length ? `${matching.runId}:${projection.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? roots : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? current ? [{ sessionId: current.sessionId, title: prompts[0], lastAt: current.updatedAt, messageCount: history.length }] : []
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(matching), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const turn = (ordinal: number): Locator => conversation().locator('.work-conversation-turn').filter({ hasText: prompts[ordinal - 1] })
const toggle = (ordinal: number): Locator => turn(ordinal).locator('.work-message__process-toggle')
const thinking = (ordinal: number): Locator => turn(ordinal).locator('.work-message__thinking-toggle')
const receipt = (ordinal: number): Locator => turn(ordinal).locator(`[data-work-tool-id="${toolId(ordinal)}"]`)
async function expectProcess(ordinal: number, open: boolean): Promise<void> {
  await expect(toggle(ordinal)).toHaveCount(1)
  await expect(toggle(ordinal)).toHaveAttribute('aria-expanded', String(open))
  if (open) {
    await expect(receipt(ordinal)).toBeVisible()
    await expect(thinking(ordinal)).toBeVisible()
    const positions = await turn(ordinal).locator('.work-message__process-bar').evaluate(bar => {
      const process = bar.querySelector('.work-message__process-toggle')!.getBoundingClientRect()
      const thinking = bar.querySelector('.work-message__thinking-toggle')!.getBoundingClientRect()
      return { gap: thinking.left - process.right, centerDelta: Math.abs(thinking.top + thinking.height / 2 - process.top - process.height / 2) }
    })
    expect(positions.gap).toBeGreaterThanOrEqual(0)
    expect(positions.gap).toBeLessThanOrEqual(16)
    expect(positions.centerDelta).toBeLessThanOrEqual(2)
  } else {
    await expect(receipt(ordinal)).toBeHidden()
    // The process is collapsed, but the thinking switch remains available so
    // users can reveal the process directly from the same toolbar.
    await expect(thinking(ordinal)).toBeVisible()
  }
}
async function sendNext(ordinal: number): Promise<void> {
  const composer = conversation().getByRole('textbox', { name: '继续对话', exact: true })
  await composer.fill(prompts[ordinal - 1]); await composer.press('Enter')
  await expect.poll(() => roots.length).toBe(ordinal)
  await expectProcess(ordinal, true)
}
async function switchMode(mode: 'code' | 'work'): Promise<void> {
  await page.getByRole('tab', { name: mode === 'code' ? 'Code 开发' : 'Work 办公', exact: true }).click()
  if (mode === 'work') await expect(conversation()).toBeVisible()
  else await expect(work()).toBeHidden()
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  if (await page.locator('html').getAttribute('data-appearance') === appearance) return
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.modal-overlay:has([role="dialog"][aria-label="设置"])')).toHaveCount(0)
}
async function sampleFooterGeometry(footer: Locator, label: string): Promise<FooterGeometry[]> {
  const frames = await footer.evaluate(element => new Promise<FooterGeometry[]>((resolve, reject) => {
    const answer = element.closest('.work-message--assistant')
    const elements = {
      row: element,
      usage: element.querySelector('.turn-usage__trigger'),
      copy: element.querySelector('.message__action[aria-label$="复制回复"]'),
      regenerate: element.querySelector('[aria-label="重新生成"]'),
      body: answer ? Array.from(answer.querySelectorAll('.work-assistant-content')).at(-1) : undefined,
      composer: document.querySelector('.work-view [aria-label="继续对话"]')
    }
    if (Object.values(elements).some(value => !value)) { reject(new Error('Missing footer geometry target')); return }
    const samples: FooterGeometry[] = []
    let stable = 0
    const next = (): void => {
      const geometry = Object.fromEntries(Object.entries(elements).map(([key, target]) => {
        const rect = target!.getBoundingClientRect()
        let opacity = 1
        for (let node: Element | null = target!; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
        return [key, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity }]
      })) as FooterGeometry
      const previous = samples.at(-1)
      stable = previous && Object.keys(geometry).every(key => {
        const name = key as keyof FooterGeometry
        return (['x', 'y', 'width', 'height'] as const).every(field => Math.abs(geometry[name][field] - previous[name][field]) <= 0.01)
      }) ? stable + 1 : 0
      samples.push(geometry)
      // Keep intermediate animation frames as evidence, then wait for stable
      // layout instead of assuming a CSS duration or checking computed styles.
      if (samples.length >= 18 && stable >= 6) resolve(samples)
      else if (samples.length >= 120) reject(new Error('Footer geometry did not settle'))
      else requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
  }))
  footerGeometry.push({ label, frames })
  return frames
}
async function expectFooterStable(ordinal: number, size: 'wide' | 'narrow'): Promise<void> {
  const answer = turn(ordinal).locator('.work-message--assistant').filter({ has: page.getByText(finalText(ordinal), { exact: true }) })
  const footer = answer.locator('.work-message__reply-actions')
  const usage = footer.locator('.turn-usage__trigger'), copy = footer.locator('.message__action[aria-label$="复制回复"]')
  const regenerate = footer.getByRole('button', { name: '重新生成', exact: true })
  const controls = footer.getByRole('group', { name: '回复操作', exact: true })
  const composer = conversation().getByRole('textbox', { name: '继续对话', exact: true })
  await expect(regenerate).toBeEnabled()
  for (const appearance of ['light', 'dark'] as const) {
    await setAppearance(appearance)
    await footer.scrollIntoViewIfNeeded()
    await composer.focus(); await composer.hover()
    const baselineFrames = await sampleFooterGeometry(footer, `${size}-${appearance}-before`)
    const baseline = baselineFrames.at(-1)!
    await expect(controls).toHaveCSS('opacity', '0')
    expect(baseline.usage.opacity).toBe(1)
    expect(baseline.copy.opacity).toBe(0); expect(baseline.regenerate.opacity).toBe(0)
    const check = async (phase: string, revealed: boolean): Promise<void> => {
      const frames = await sampleFooterGeometry(footer, `${size}-${appearance}-${phase}`)
      for (const name of ['row', 'usage', 'copy', 'regenerate', 'body', 'composer'] as const) {
        for (const field of ['x', 'y', 'width', 'height'] as const) {
          const delta = Math.max(...frames.map(frame => Math.abs(frame[name][field] - baseline[name][field])))
          // Half a CSS pixel tolerates DPR rounding but still rejects the 2px hover shift.
          expect(delta, `${size}/${appearance}/${phase}: ${name}.${field} moved`).toBeLessThanOrEqual(0.5)
        }
      }
      expect(frames.every(frame => frame.usage.opacity === 1), `${phase}: usage must remain visible`).toBe(true)
      expect(frames.every(frame => frame.copy.opacity === Number(revealed) && frame.regenerate.opacity === Number(revealed)),
        `${phase}: reply controls must switch immediately without fading`).toBe(true)
      await expect(controls).toHaveCSS('opacity', revealed ? '1' : '0')
    }
    await answer.getByText(finalText(ordinal), { exact: true }).hover(); await check('hover-reply', true)
    await usage.hover(); await check('hover-usage', true)
    await copy.hover(); await check('hover-copy', true)
    await regenerate.hover(); await check('hover-regenerate', true)
    await composer.hover(); await check('after-hover', false)
    // The collapsed process toggle and the thinking switch precede the footer
    // in the actual tab order. Enter both footer controls with Tab, leaving the
    // pointer outside.
    await toggle(ordinal).focus(); await page.keyboard.press('Tab')
    await expect(thinking(ordinal)).toBeFocused(); await page.keyboard.press('Tab')
    await expect(usage).toBeFocused(); await check('keyboard-usage', true)
    await page.keyboard.press('Tab')
    await expect(copy).toBeFocused(); await check('keyboard-copy', true)
    await page.keyboard.press('Tab')
    await expect(regenerate).toBeFocused(); await check('keyboard-regenerate', true)
    await composer.focus(); await check('after-focus', false)
  }
  await setAppearance('light')
}

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-process-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
    remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  originalClipboard = await app.evaluate(({ clipboard }) => {
    const image = clipboard.readImage()
    return { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), imageDataUrl: image.isEmpty() ? '' : image.toDataURL() }
  })
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed() && info.status !== info.expectedStatus) {
    const path = info.outputPath('work-process-failure.png')
    await page.screenshot({ path }); await info.attach('过程状态失败窗口', { path, contentType: 'image/png' })
  }
  const path = info.outputPath('work-process-receipts.json')
  writeFileSync(path, JSON.stringify({ chats, roots, events, truncateCalls, fileReverts, footerGeometry, errors }, null, 2))
  await info.attach('轮次状态与真实传输记录', { path, contentType: 'application/json' })
  expect(errors).toEqual([])
})
test.afterAll(async () => {
  try {
    try {
      if (app && originalClipboard) await app.evaluate(({ clipboard, nativeImage }, saved) => {
        clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
          ...(saved.imageDataUrl ? { image: nativeImage.createFromDataURL(saved.imageDataUrl) } : {}) })
      }, originalClipboard)
    } finally { await app?.close() }
  }
  finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-process-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('Work process folds on completion and preserves only the current phase’s reading choices', async ({}, info) => {
  await test.step('running choices survive waiting and repeated explicit activity reveal', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompts[0])
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => roots.length).toBe(1)
    await expectProcess(1, true)
    await toggle(1).click(); await expectProcess(1, false)
    await thinking(1).click(); await expectProcess(1, true)
    await expect(thinking(1)).toHaveAttribute('aria-pressed', 'true')
    await turn(1).locator('.work-message__thinking .logline').click()
    await expect(turn(1).locator('.logline__detail--thinking')).toContainText('LIFECYCLE_THINKING_1')

    requestPermission()
    const pending = conversation().locator('.work-pending')
    await expect(pending).toContainText('LIFECYCLE_PERMISSION')
    await expectProcess(1, true); await expect(thinking(1)).toHaveAttribute('aria-pressed', 'true')
    await pending.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => chats.length).toBe(2)
    expect(chats[1].toolResponse).toMatchObject({ requestId: 'lifecycle-permission', output: 'rejected' })
    await expect(pending).toHaveCount(0)
    await expect(turn(1)).toContainText('LIFECYCLE_RESUMED')
    await expectProcess(1, true); await expect(thinking(1)).toHaveAttribute('aria-pressed', 'true')
    for (let request = 0; request < 2; request++) {
      await toggle(1).click(); await expectProcess(1, false)
      await conversation().getByRole('button', { name: '查看正在执行的活动', exact: true }).click()
      await expectProcess(1, true); await expect(receipt(1)).toBeFocused()
    }
  })

  await test.step('completion closes live inspection; settled manual choices survive Code/Work', async () => {
    finishTool(true); complete()
    await expectProcess(1, false)
    await expect(turn(1).getByText(finalText(1), { exact: true })).toBeVisible()
    await expect(conversation().getByRole('button', { name: '查看正在执行的活动', exact: true })).toHaveCount(0)
    const path = info.outputPath('work-process-completed-collapsed.png')
    await page.screenshot({ path }); await info.attach('本轮完成后过程收起', { path, contentType: 'image/png' })
    const answer = turn(1).locator('.work-message--assistant').filter({ has: page.getByText(finalText(1), { exact: true }) })
    const footer = answer.locator('.work-message__reply-actions')
    await expect(turn(1).locator('.turn-usage')).toHaveCount(1)
    await expect(footer.locator('.turn-usage')).toHaveCount(1)
    await expect(footer.locator('.turn-usage__value')).toHaveText('1.5M')
    await expect(footer.locator('.turn-usage__model')).toHaveText(modelId)
    const metadataLines = await footer.locator('.turn-usage__text > span').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
    expect(Math.max(...metadataLines) - Math.min(...metadataLines)).toBeLessThanOrEqual(2)
    const copy = footer.getByRole('button', { name: '复制回复', exact: true })
    await expect(copy).toBeVisible()
    const placement = await footer.evaluate(element => {
      const usage = element.querySelector('.turn-usage')!.getBoundingClientRect()
      const copy = element.querySelector('.message__action')!.getBoundingClientRect()
      const row = element.getBoundingClientRect()
      return { gap: copy.left - usage.right, centerDelta: Math.abs(copy.top + copy.height / 2 - usage.top - usage.height / 2),
        usageInset: usage.left - row.left, trailingSpace: row.right - copy.right }
    })
    expect(placement.gap).toBeGreaterThanOrEqual(4)
    expect(placement.gap).toBeLessThanOrEqual(16)
    expect(placement.centerDelta).toBeLessThanOrEqual(2)
    expect(placement.usageInset).toBeLessThanOrEqual(4)
    expect(placement.trailingSpace).toBeGreaterThan(100)
    await expectFooterStable(1, 'wide')
    await answer.hover()
    await copy.click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))).toBe(finalText(1))
    await expect(footer.getByRole('button', { name: '已复制回复', exact: true })).toBeVisible()
    const widePath = info.outputPath('work-reply-footer-wide.png')
    await page.screenshot({ path: widePath }); await info.attach('回复底部用量与复制同行', { path: widePath, contentType: 'image/png' })
    await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(600, 600); window.setContentSize(760, 900) })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(760)
    await footer.scrollIntoViewIfNeeded()
    const narrow = await footer.evaluate(element => {
      const row = element.getBoundingClientRect()
      const controls = Array.from(element.querySelectorAll('.turn-usage, .message__action')).map(control => control.getBoundingClientRect())
      const scroll = element.closest('.work-conversation__scroll')!
      return { rowWidth: row.width, overflow: element.scrollWidth - element.clientWidth, conversationOverflow: scroll.scrollWidth - scroll.clientWidth,
        controlsInside: controls.every(control => control.left >= row.left - 1 && control.right <= row.right + 1 && control.bottom <= row.bottom + 1) }
    })
    expect(narrow.rowWidth).toBeGreaterThan(0)
    expect(narrow.overflow).toBeLessThanOrEqual(1)
    expect(narrow.conversationOverflow).toBeLessThanOrEqual(1)
    expect(narrow.controlsInside).toBe(true)
    await expectFooterStable(1, 'narrow')
    const narrowPath = info.outputPath('work-reply-footer-narrow.png')
    await page.screenshot({ path: narrowPath }); await info.attach('窄窗口回复底部无溢出', { path: narrowPath, contentType: 'image/png' })
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000))
    await toggle(1).click(); await expectProcess(1, true)
    await expect(thinking(1)).toHaveAttribute('aria-pressed', 'false')
    await thinking(1).click(); await expect(thinking(1)).toHaveAttribute('aria-pressed', 'true')
    await switchMode('code'); await switchMode('work')
    await expectProcess(1, true); await expect(thinking(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(turn(1).getByText(finalText(1), { exact: true })).toBeVisible()
  })

  await test.step('failed receipts add a badge without opening process or changing older turns', async () => {
    await sendNext(2)
    await expectProcess(1, true)
    await toggle(2).click(); await expectProcess(2, false)
    const activity = conversation().getByRole('button', { name: '查看正在执行的活动', exact: true })
    await expect(activity.locator('span')).toHaveText(commandInvocation.slice(0, 177) + '…')
    await expect(activity.locator('span')).toHaveCSS('white-space', 'nowrap')
    await expect(activity.locator('span')).toHaveCSS('text-overflow', 'ellipsis')
    await activity.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText(commandInvocation)
    await expect(tooltip).toContainText('LIFECYCLE_COMMAND_TAIL')
    await expectProcess(2, false)
    const path = info.outputPath('work-running-command-full-arguments.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('运行命令完整参数', { path, contentType: 'image/png' })
    await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0)
    await activity.click(); await expectProcess(2, true); await expect(receipt(2)).toBeFocused()
    await expect(receipt(2).locator('.logline__summary')).toHaveText(commandInvocation.slice(0, 177) + '…')
    await toggle(2).click(); await expectProcess(2, false)
    finishTool(false)
    await expect(toggle(2)).toContainText('1 步未通过')
    await expectProcess(2, false)
    complete()
    await expectProcess(2, false); await expect(toggle(2)).toContainText('1 步未通过')
    await expect(turn(2).getByText(finalText(2), { exact: true })).toBeVisible()
    await expectProcess(1, true); await expect(thinking(1)).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('completion while the task is unmounted also starts settled process closed', async () => {
    await sendNext(3)
    await toggle(3).click(); await expectProcess(3, false)
    await toggle(3).click(); await expectProcess(3, true)
    await thinking(3).click(); await expect(thinking(3)).toHaveAttribute('aria-pressed', 'true')
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toBeVisible()
    await expect(turn(3)).toHaveCount(0)
    finishTool(true); complete()
    await work().locator('.work-sidebar__task').filter({ hasText: prompts[0] }).click()
    await expect(turn(3).getByText(finalText(3), { exact: true })).toBeVisible()
    await expectProcess(3, false)
    await toggle(3).click(); await expectProcess(3, true)
    await expect(thinking(3)).toHaveAttribute('aria-pressed', 'false')
    await toggle(3).click(); await expectProcess(3, false)
    await expectProcess(1, true); await expectProcess(2, false)
  })
  await test.step('leaving before activity navigation completes cancels its old reveal', async () => {
    await sendNext(4)
    await toggle(4).click(); await expectProcess(4, false)
    // Dispatch both UI actions before the reveal can finish its opening motion.
    // This also covers an activity target unmounting before its focus receipt.
    await conversation().getByRole('button', { name: '查看正在执行的活动', exact: true }).evaluate(button => {
      const projects = Array.from(document.querySelectorAll<HTMLButtonElement>('.work-navigation__item'))
        .find(element => element.textContent?.trim() === '项目')
      if (!projects || !(button instanceof HTMLButtonElement)) throw new Error('Missing activity/project navigation button')
      button.click(); projects.click()
    })
    await expect(conversation()).toHaveCount(0)
    finishTool(true); complete()
    await work().locator('.work-sidebar__task').filter({ hasText: prompts[0] }).click()
    await expect(turn(4).getByText(finalText(4), { exact: true })).toBeVisible()
    await expectProcess(4, false)
  })
  expect(roots.map(run => run.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded'])
  expect(chats).toHaveLength(5)
  await test.step('regeneration confirms once, resends the original turn and preserves files and draft', async () => {
    const original = roots[2], later = roots[3]
    const composer = conversation().getByRole('textbox', { name: '继续对话', exact: true })
    const draft = 'LIFECYCLE_UNSENT_DRAFT：这是尚未发送的草稿，请保留。'
    await composer.fill(draft)
    const answer = turn(3).locator('.work-message--assistant').filter({ has: page.getByText(finalText(3), { exact: true }) })
    const regenerate = answer.getByRole('button', { name: '重新生成', exact: true })
    await expect(turn(3).getByText(originalAttachment.name, { exact: true })).toBeVisible()
    await answer.hover(); await expect(regenerate).toBeEnabled(); await regenerate.click()
    const confirmation = page.getByRole('dialog', { name: '重新生成', exact: true })
    await expect(confirmation).toContainText('删除本轮及之后的对话')
    await expect(confirmation).toContainText('原指令和附件')
    await expect(confirmation).toContainText('文件保持原样')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect(truncateCalls).toHaveLength(0); expect(chats).toHaveLength(5)
    expect(roots.map(run => run.runId)).toEqual(['lifecycle-run-1', 'lifecycle-run-2', original.runId, later.runId])
    await expect.poll(() => composer.innerText()).toBe(draft)

    await answer.hover(); await regenerate.click()
    await expect(confirmation).toBeVisible()
    // A double click on one confirmation must still authorize just one replay.
    await confirmation.getByRole('button', { name: '重新生成', exact: true }).dblclick()
    await expect.poll(() => nextRun).toBe(5)
    await expect.poll(() => chats.length).toBe(6)
    expect(truncateCalls).toHaveLength(1)
    expect(truncateCalls[0]).toMatchObject({ sessionId: original.sessionId, messageId: original.userMessageId })
    expect(truncateCalls[0].removedIds).toContain(original.userMessageId)
    expect(truncateCalls[0].removedIds).toContain(later.userMessageId)
    expect(chats[5]).toMatchObject({ sessionId: original.sessionId, message: prompts[2],
      attachments: [{ name: originalAttachment.name, type: originalAttachment.type }] })
    expect(history.filter(row => row.role === 'user').map(row => row.id)).toEqual(['lifecycle-user-1', 'lifecycle-user-2', 'lifecycle-user-5'])
    expect(roots.map(run => run.runId)).toEqual(['lifecycle-run-1', 'lifecycle-run-2', 'lifecycle-run-5'])
    await expect(turn(4)).toHaveCount(0)
    await expect(conversation().getByText(finalText(3), { exact: true })).toHaveCount(0)
    await expect(conversation().getByText(finalText(4), { exact: true })).toHaveCount(0)
    await expect(turn(1).getByText(finalText(1), { exact: true })).toBeVisible()
    await expect(turn(2).getByText(finalText(2), { exact: true })).toBeVisible()
    await expect.poll(() => composer.innerText()).toBe(draft)
    const previousReply = turn(1).locator('.work-message--assistant').filter({ has: page.getByText(finalText(1), { exact: true }) })
    const previousRegenerate = previousReply.getByRole('button', { name: '重新生成', exact: true })
    await previousReply.hover(); await expect(previousRegenerate).toBeDisabled()
    await previousRegenerate.evaluate(button => { if (!(button instanceof HTMLButtonElement)) throw new Error('Expected regenerate button'); button.click(); button.click() })
    await expect(confirmation).toHaveCount(0)
    finishTool(true); complete()
    await expect(turn(3).getByText(finalText(5), { exact: true })).toBeVisible()
    await expect(turn(3).locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => composer.innerText()).toBe(draft)
    expect(truncateCalls).toHaveLength(1); expect(chats).toHaveLength(6)
    expect(fileReverts).toEqual([])
    expect(roots.map(run => run.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
  })
})
