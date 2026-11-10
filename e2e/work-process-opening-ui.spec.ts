/** Fresh Electron regression for Work process opening/closing paint overlap.
 * Sixty-seven real history receipts, interleaved prose, long result disclosure,
 * changes and a final heading/table. rAF geometry includes every overflow clip;
 * animations remain enabled during sampling and screenshots. No model/export. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineFileChange } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'process-opening-fixture', sessionId = 'work-process-opening', modelId = 'process-opening-model'
const title = '长过程展开布局核对', remoteRoot = '/remote/process-opening', now = Date.now() - 10_000
const answerTitle = '验收结论：过程与正文独立呈现'
const finalAnswer = `## ${answerTitle}\n\n已完成 67 项检查，以下正文和表格应始终保持完整、清晰。\n\n| 项目 | 结果 |\n| --- | --- |\n| 文件读取 | 通过 |\n| 文件变更 | 已记录 |\n| 布局复核 | 保留全部证据 |\n\nFINAL_BODY_END：最终结果不会被过程列表覆盖。`
const run: RootRun = { schemaVersion: 1, runId: 'opening-root-run', sessionId, turnId: 'opening-turn', userMessageId: 'opening-user',
  assistantMessageId: 'opening-answer', seq: 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: [],
  createdAt: now, updatedAt: now + 1000, finishedAt: now + 1000 }
const metadata = { rootRunId: run.runId, turnId: run.turnId }
const changes: EngineFileChange[] = []
const history: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata }]
for (let index = 0; index < 67; index++) {
  const id = `opening-tool-${index}`, path = `${remoteRoot}/review/module-${index}.ts`, at = now + index * 10
  if (index % 9 === 0) history.push({ id: `opening-note-${index}`, role: 'assistant', content: `阶段 ${index + 1}：核对文件内容、读取范围与依赖关系。\n\n保留已有实现，逐项记录验证结果。`,
    createdAt: at, conversationId: run.turnId, metadata })
  const write = index % 5 === 4
  const content = Array.from({ length: index === 0 || index === 66 ? 90 : 5 }, (_, line) => `${line + 1} | export const item_${index}_${line} = ${line};`).join('\n')
  const change: EngineFileChange | undefined = write ? { id: `opening-change-${index}`, sessionId, turnId: run.turnId, runId: run.runId,
    path, kind: 'write', oldContent: null, newContent: `export const reviewed_${index} = true;\n`, isNew: true, oldHash: 'missing',
    truncated: false, status: 'pending', createdAt: at + 2, toolCallId: id } : undefined
  if (change) changes.push(change)
  history.push({ id: `call-${id}`, role: 'assistant', content: '', createdAt: at + 1, conversationId: run.turnId, metadata,
    toolCall: { id, name: write ? 'write_file' : 'read_file', args: write ? { path, content: change!.newContent } : { path } } },
  { id: `result-${id}`, role: 'tool', toolCallId: id, success: true, createdAt: at + 2, conversationId: run.turnId,
    content: write ? '文件已创建' : JSON.stringify({ path, expectedHash: `sha256:${'a'.repeat(64)}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false,
      startLine: 1, endLine: index === 0 || index === 66 ? 90 : 5, totalLines: index === 0 || index === 66 ? 90 : 5, numberedContent: content }),
    metadata: { ...metadata, success: true, ...(change ? { change } : {}) } })
}
history.push({ id: run.assistantMessageId, role: 'assistant', content: finalAnswer, createdAt: now + 1000, conversationId: run.turnId, metadata })
const laterRun: RootRun = { ...run, runId: 'opening-later-run', turnId: 'opening-later-turn', userMessageId: 'opening-later-user',
  assistantMessageId: 'opening-later-answer', seq: 2, createdAt: now + 2000, updatedAt: now + 3000, finishedAt: now + 3000 }
const laterTitle = '后续核对记录'
const laterMetadata = { rootRunId: laterRun.runId, turnId: laterRun.turnId }
const laterHistory: EngineHistoryRow[] = [
  { id: laterRun.userMessageId, role: 'user', content: laterTitle, createdAt: now + 2000, conversationId: laterRun.turnId, metadata: laterMetadata },
  { id: laterRun.assistantMessageId, role: 'assistant', content: `## ${laterTitle}\n\n${Array.from({ length: 24 }, (_, index) => `后续记录 ${index + 1}：保留本轮验收结果，继续整理后续工作与复核说明。`).join('\n\n')}`,
    createdAt: now + 3000, conversationId: laterRun.turnId, metadata: laterMetadata }
]
let includeLaterTurn = false

const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  const matching = id === sessionId, rows = matching ? includeLaterTurn ? [...history, ...laterHistory] : history : []
  const runs = matching ? includeLaterTurn ? [run, laterRun] : [run] : [], currentRun = runs.at(-1)
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Process disclosure must not mutate ${path}`)
  }
  if (path === '/api/v1/workspace/file/content') throw new Error('Receipt disclosure must use its saved result')
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'process-opening-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '过程布局核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: currentRun, runs, subagentRuns: [], todos: [], changes: matching ? changes : [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: currentRun, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: history.length }]
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: runs.map(item => ({ userMessageId: item.userMessageId,
      conversationId: item.turnId, preview: item === run ? title : laterTitle, createdAt: item.createdAt })), messages: rows, loadedTurnIds: runs.map(item => item.userMessageId),
      revision: includeLaterTurn ? 'opening-history-later' : 'opening-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/changes' ? matching ? changes : []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'opening-tenant', sessionId: id,
      namespace: { id: 'opening-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
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

interface Bounds { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface Frame {
  time: number; interval: number; expanded: string | null; phase: string | null; activeAnimations: number
  wrapper: Bounds | null; wrapperClientHeight: number; wrapperScrollHeight: number; translate: string; overflow: string
  viewport: Bounds | null; viewportClientHeight: number; viewportScrollHeight: number; scrollTop: number
  divider: Bounds | null; body: Bounds | null; visiblePaint: Bounds | null; rawPaintBottom: number | null
  rows: Array<{ id: string; raw: Bounds; visible: Bounds }>; violations: string[]
  artifacts: { expanded: string | null; panel: Bounds | null; heading: Bounds | null; body: Bounds | null; visibleRows: Bounds[] }
  longTasks: Array<{ start: number; duration: number }>
}
type ProbeWindow = Window & { __openingProbe?: { stop: () => Frame[] } }
const toggle = () => page.locator('.work-conversation .work-message__process-toggle')
const processPanel = () => page.locator('.work-conversation .work-message__process-viewport')

async function startProbe(): Promise<void> {
  await page.evaluate(() => {
    const host = window as ProbeWindow
    host.__openingProbe?.stop()
    const frames: Frame[] = [], started = performance.now(), longTasks: Array<{ start: number; duration: number }> = []
    let raf = 0, stopped = false, lastTime = started
    const performanceObserver = PerformanceObserver.supportedEntryTypes.includes('longtask') ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime - started, duration: entry.duration })
    }) : null
    performanceObserver?.observe({ type: 'longtask', buffered: false })
    let observedWrapper: Element | null = null, intersection: IntersectionObserver | null = null, mutation: MutationObserver | null = null
    let watched: Element[] = [], rows: Element[] = []
    const onscreen = new Set<Element>()
    const observe = (wrapper: Element | null, viewport: Element | null): void => {
      if (wrapper === observedWrapper) return
      intersection?.disconnect(); mutation?.disconnect(); onscreen.clear(); watched = []; rows = []; observedWrapper = wrapper
      if (!wrapper) return
      intersection = new IntersectionObserver(entries => {
        for (const entry of entries) { if (entry.isIntersecting) onscreen.add(entry.target); else onscreen.delete(entry.target) }
      }, { root: viewport, threshold: 0 })
      const refresh = (): void => {
        watched = [...wrapper.querySelectorAll('button.logline, .work-file-change-row, .work-activity-group__toggle, .work-message__process-note p, .logline__detail')]
        rows = watched.filter(element => element.matches('button.logline, .work-file-change-row, .work-activity-group__toggle'))
        intersection?.disconnect(); onscreen.clear()
        for (const element of watched) intersection?.observe(element)
      }
      mutation = new MutationObserver(refresh); mutation.observe(wrapper, { childList: true, subtree: true }); refresh()
    }
    const box = (rect: DOMRect | Bounds): Bounds => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    type Clip = { left: number; top: number; right: number; bottom: number; alpha: number; hidden: boolean }
    let clips = new Map<Element, Clip>()
    const clipFor = (element: Element): Clip => {
      const cached = clips.get(element)
      if (cached) return cached
      const clip: Clip = element.parentElement ? { ...clipFor(element.parentElement) }
        : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, alpha: 1, hidden: false }
      const style = getComputedStyle(element)
      clip.alpha *= Number(style.opacity)
      clip.hidden ||= style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || clip.alpha < 0.01
      // aria-hidden and inert do not stop paint during closing transitions.
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX}/${style.overflowY}`)) {
        const rect = element.getBoundingClientRect(), html = element as HTMLElement
        const scaleX = html.offsetWidth ? rect.width / html.offsetWidth : 1, scaleY = html.offsetHeight ? rect.height / html.offsetHeight : 1
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
          const left = rect.left + element.clientLeft * scaleX
          clip.left = Math.max(clip.left, left); clip.right = Math.min(clip.right, left + element.clientWidth * scaleX)
        }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
          const top = rect.top + element.clientTop * scaleY
          clip.top = Math.max(clip.top, top); clip.bottom = Math.min(clip.bottom, top + element.clientHeight * scaleY)
        }
      }
      clips.set(element, clip); return clip
    }
    const visible = (element: Element, source: DOMRect | Bounds): Bounds | null => {
      const clip = clipFor(element)
      if (clip.hidden) return null
      const left = Math.max(clip.left, source.left), top = Math.max(clip.top, source.top), right = Math.min(clip.right, source.right), bottom = Math.min(clip.bottom, source.bottom)
      return right - left > 0.25 && bottom - top > 0.25 ? { left, top, right, bottom, width: right - left, height: bottom - top } : null
    }
    const sample = (): void => {
      clips = new Map()
      const sampledAt = performance.now()
      const article = document.querySelector('.work-conversation .work-message--assistant')
      const wrapper = article?.querySelector<HTMLElement>('.work-message__process'), viewport = wrapper?.querySelector<HTMLElement>('.work-message__process-viewport')
      observe(wrapper ?? null, viewport ?? null)
      const divider = article?.querySelector<HTMLElement>('.work-message__process-divider')
      const body = article?.querySelector<HTMLElement>('.work-message__answer, .work-message__body')
      const dividerBounds = divider ? visible(divider, divider.getBoundingClientRect()) : null
      const bodyBounds = body ? visible(body, body.getBoundingClientRect()) : null
      const style = wrapper ? getComputedStyle(wrapper) : null
      const frame: Frame = { time: sampledAt - started, interval: sampledAt - lastTime, expanded: article?.querySelector('.work-message__process-toggle')?.getAttribute('aria-expanded') ?? null,
        phase: wrapper?.dataset.motionState ?? null, activeAnimations: wrapper?.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length ?? 0,
        wrapper: wrapper ? box(wrapper.getBoundingClientRect()) : null, wrapperClientHeight: wrapper?.clientHeight ?? 0, wrapperScrollHeight: wrapper?.scrollHeight ?? 0,
        translate: style?.translate ?? '', overflow: style ? `${style.overflowX}/${style.overflowY}` : '',
        viewport: viewport ? box(viewport.getBoundingClientRect()) : null, viewportClientHeight: viewport?.clientHeight ?? 0,
        viewportScrollHeight: viewport?.scrollHeight ?? 0, scrollTop: viewport?.scrollTop ?? 0,
        divider: dividerBounds, body: bodyBounds, visiblePaint: null, rawPaintBottom: null, rows: [], violations: [],
        artifacts: { expanded: null, panel: null, heading: null, body: null, visibleRows: [] }, longTasks: longTasks.splice(0) }
      lastTime = sampledAt
      const includePaint = (element: Element, rect: DOMRect | Bounds, label: string): void => {
        frame.rawPaintBottom = Math.max(frame.rawPaintBottom ?? -Infinity, rect.bottom)
        const paint = visible(element, rect)
        if (!paint) return
        const previous = frame.visiblePaint
        frame.visiblePaint = previous ? { left: Math.min(previous.left, paint.left), top: Math.min(previous.top, paint.top),
          right: Math.max(previous.right, paint.right), bottom: Math.max(previous.bottom, paint.bottom), width: 0, height: 0 } : { ...paint }
        frame.visiblePaint.width = frame.visiblePaint.right - frame.visiblePaint.left; frame.visiblePaint.height = frame.visiblePaint.bottom - frame.visiblePaint.top
        const intersectsX = (target: Bounds): boolean => Math.min(paint.right, target.right) - Math.max(paint.left, target.left) > 1
        if (dividerBounds && intersectsX(dividerBounds) && paint.bottom > dividerBounds.top + 1) frame.violations.push(`${label}: paint ${paint.bottom.toFixed(2)} below divider ${dividerBounds.top.toFixed(2)}`)
        if (bodyBounds && intersectsX(bodyBounds) && Math.min(paint.bottom, bodyBounds.bottom) - Math.max(paint.top, bodyBounds.top) > 1)
          frame.violations.push(`${label}: visible paint intersects answer`)
      }
      if (wrapper) {
        // Native intersection tracking avoids reading all 67 receipts each rAF.
        // First/last sentinels cover the mount frame before observer delivery.
        const candidates = new Set([...onscreen, ...rows.slice(0, 6), ...rows.slice(-6)])
        for (const element of rows.filter(row => candidates.has(row))) {
          const raw = box(element.getBoundingClientRect()), clipped = visible(element, raw)
          if (clipped) frame.rows.push({ id: element.closest('[data-work-tool-id]')?.getAttribute('data-work-tool-id') ?? element.className, raw, visible: clipped })
          includePaint(element, raw, 'receipt')
        }
        // Text ranges include overflowing prose and long result lines that can
        // extend beyond their zero-height transition box on the opening frame.
        for (const candidate of candidates) {
          const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim() || !node.parentElement) continue
            const range = document.createRange(); range.selectNodeContents(node)
            for (const rect of range.getClientRects()) includePaint(node.parentElement, rect, node.textContent.trim().slice(0, 35))
          }
        }
        for (let index = 1; index < frame.rows.length; index++) {
          const previous = frame.rows[index - 1], current = frame.rows[index]
          if (Math.min(previous.visible.right, current.visible.right) - Math.max(previous.visible.left, current.visible.left) > 1 && previous.visible.bottom > current.visible.top + 1)
            frame.violations.push(`${previous.id} overlaps ${current.id}`)
        }
      }
      const artifacts = document.querySelector<HTMLElement>('.work-conversation .work-progress-panel[data-result-turn-id]')
      if (artifacts) {
        const panelBox = box(artifacts.getBoundingClientRect()), heading = artifacts.querySelector('.work-progress-panel__heading')
        const artifactBody = artifacts.querySelector<HTMLElement>('.work-progress-panel__changes-body')
        const headingBox = heading ? visible(heading, heading.getBoundingClientRect()) : null
        const composer = document.querySelector<HTMLElement>('.work-conversation__footer .work-composer')
        const composerBox = composer ? visible(composer, composer.getBoundingClientRect()) : null
        frame.artifacts = { expanded: artifacts.querySelector('.work-progress-panel__changes-toggle')?.getAttribute('aria-expanded') ?? null,
          panel: panelBox, heading: heading ? box(heading.getBoundingClientRect()) : null,
          body: artifactBody ? visible(artifactBody, artifactBody.getBoundingClientRect()) : null, visibleRows: [] }
        for (const row of artifacts.querySelectorAll('.work-progress-panel__file')) {
          const paint = visible(row, row.getBoundingClientRect())
          if (!paint) continue
          frame.artifacts.visibleRows.push(paint)
          if (paint.bottom > panelBox.bottom + 1) frame.violations.push('artifact row paints below its card')
          if (headingBox && paint.top < headingBox.bottom - 1) frame.violations.push('artifact row overlaps its heading')
          if (composerBox && Math.min(paint.bottom, composerBox.bottom) - Math.max(paint.top, composerBox.top) > 1) frame.violations.push('artifact row overlaps composer')
        }
        for (let index = 1; index < frame.artifacts.visibleRows.length; index++) {
          if (frame.artifacts.visibleRows[index - 1].bottom > frame.artifacts.visibleRows[index].top + 1) frame.violations.push('adjacent artifact rows overlap')
        }
      }
      frames.push(frame)
      if (!stopped && frames.length < 900) raf = requestAnimationFrame(sample)
    }
    host.__openingProbe = { stop: () => { stopped = true; cancelAnimationFrame(raf); sample(); intersection?.disconnect(); mutation?.disconnect(); performanceObserver?.disconnect(); return frames } }
    sample()
  })
}
async function finishProbe(name: string, info: TestInfo, requireClosing = false, artifactsOnly = false): Promise<void> {
  const frames = await page.evaluate(() => (window as ProbeWindow).__openingProbe?.stop() ?? [])
  await info.attach(`${name}-frames`, { body: JSON.stringify(frames, null, 2), contentType: 'application/json' })
  expect(frames.length).toBeGreaterThan(3)
  if (artifactsOnly) {
    expect(frames.some(frame => frame.artifacts.visibleRows.length >= 3)).toBe(true)
    expect(frames.some(frame => frame.artifacts.expanded === 'false' && frame.artifacts.visibleRows.length === 0)).toBe(true)
  } else {
    expect(frames.some(frame => frame.visiblePaint !== null && frame.body !== null)).toBe(true)
    expect(frames.some(frame => frame.phase === 'entering' || frame.activeAnimations > 0)).toBe(true)
  }
  if (requireClosing) expect(frames.some(frame => frame.phase === 'closing')).toBe(true)
  expect(frames.flatMap((frame, index) => frame.violations.map(problem => `frame ${index} at ${frame.time.toFixed(1)}ms: ${problem}`))).toEqual([])
}
async function stableOpen(): Promise<void> {
  await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.work-conversation [data-work-tool-id]')).toHaveCount(67)
  await expect.poll(() => processPanel().evaluate(element => {
    const wrapper = element.closest('.work-message__process')!
    return element.clientHeight > 250 && wrapper.getAttribute('data-motion-state') === 'open'
      && wrapper.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')
  })).toBe(true)
}
async function screenshot(name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'allow' }); await info.attach(name, { path, contentType: 'image/png' })
}
async function pauseOuterFollowing(): Promise<void> {
  const scroll = page.locator('.work-conversation__scroll')
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await scroll.hover({ position: { x: 8, y: 16 } }); await page.mouse.wheel(0, -900)
  await scroll.evaluate(element => { element.scrollTop = 0 })
  await expect(toggle()).toBeInViewport()
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'process-opening-profile-'))
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
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false)
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) {
    const frames = await page.evaluate(() => (window as ProbeWindow).__openingProbe?.stop() ?? [])
    if (info.status !== info.expectedStatus) {
      await info.attach('failure-frames', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' })
      await screenshot('process-opening-failure', info)
    }
  }
  await info.attach('app-errors', { body: JSON.stringify({ errors, mutations }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('process-opening-profile-')) throw new Error('Unsafe opening fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('首次展开 67 步过程：每个动画帧的可见回执和过程文本均不覆盖正文', async ({}, info) => {
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false'); await expect(toggle()).toContainText('67 步')
  await pauseOuterFollowing(); await startProbe(); await toggle().click(); await stableOpen()
  await expect(page.locator('.work-message__answer').getByRole('heading', { name: answerTitle, exact: true })).toBeVisible()
  await expect(page.locator('.work-message__answer table')).toBeVisible()
  for (const stage of [1, 10, 19, 28, 37, 46, 55, 64]) {
    await expect(page.locator('.work-conversation').getByText(`阶段 ${stage}：核对文件内容、读取范围与依赖关系。`, { exact: true })).toHaveCount(1)
  }
  await finishProbe('first-open', info); await screenshot('first-open-stable', info)
})

test('长结果展开并滚到底部后关闭重开：保留滚动位置且首帧不重叠', async ({}, info) => {
  if (await toggle().getAttribute('aria-expanded') !== 'true') await toggle().click()
  await stableOpen(); await pauseOuterFollowing()
  const first = page.locator('[data-work-tool-id="opening-tool-0"] button.logline')
  if (await first.getAttribute('aria-expanded') !== 'true') await first.click()
  await expect(page.locator('[data-work-tool-id="opening-tool-0"] .logline__detail')).toContainText('item_0_89')
  await processPanel().focus(); await page.keyboard.press('End')
  await processPanel().evaluate(element => { element.scrollTop = element.scrollHeight })
  const last = page.locator('[data-work-tool-id="opening-tool-66"] button.logline')
  await last.scrollIntoViewIfNeeded(); if (await last.getAttribute('aria-expanded') !== 'true') await last.click()
  await expect(page.locator('[data-work-tool-id="opening-tool-66"] .logline__detail')).toContainText('item_66_89')
  await stableOpen(); await processPanel().evaluate(element => { element.scrollTop = element.scrollHeight })
  const saved = await processPanel().evaluate(element => element.scrollTop)
  expect(saved).toBeGreaterThan(1000)
  await startProbe(); await toggle().click(); await expect(processPanel()).toHaveCount(0)
  await toggle().click(); await stableOpen()
  await expect.poll(() => processPanel().evaluate(element => element.scrollTop)).toBeGreaterThan(saved - 2)
  expect(await processPanel().evaluate(element => element.scrollTop)).toBeLessThan(saved + 2)
  await finishProbe('saved-bottom-reopen', info, true); await screenshot('saved-bottom-reopen-stable', info)
})

test('真实动画期间快速反复开关：不出现首帧穿透、回执叠压或过期关闭', async ({}, info) => {
  if (await toggle().getAttribute('aria-expanded') === 'true') { await toggle().click(); await expect(processPanel()).toHaveCount(0) }
  await pauseOuterFollowing(); await toggle().focus(); await startProbe()
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press('Enter')
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  }
  await stableOpen(); await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.work-message__answer')).toContainText('FINAL_BODY_END')
  await finishProbe('rapid-reversals', info, true); await screenshot('rapid-reversals-stable', info)
})

test('13 个成果文件：底部跟随时展开仍贴底，末尾入口可见且文件行不重叠', async ({}, info) => {
  if (await toggle().getAttribute('aria-expanded') === 'true') { await toggle().click(); await expect(processPanel()).toHaveCount(0) }
  if (!app) throw new Error('Electron application missing')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 720))
  await expect.poll(() => page.evaluate(() => innerHeight)).toBe(720)
  const panel = page.locator('.work-conversation .work-progress-panel[data-result-turn-id]')
  const button = panel.locator('.work-progress-panel__changes-toggle'), body = panel.locator('.work-progress-panel__changes-body')
  await expect(button).toContainText('13 个文件')
  if (await button.getAttribute('aria-expanded') === 'true') await button.click()
  const scroll = page.locator('.work-conversation__scroll')
  const latest = page.locator('.work-follow-latest')
  if (await latest.isVisible()) await latest.click()
  // A real downward gesture at the end resumes following even when a short
  // collapsed conversation currently has no scroll range. scrollTop alone does not.
  await scroll.hover({ position: { x: 8, y: 16 } }); await page.mouse.wheel(0, 10_000)
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(button).toBeInViewport({ ratio: 0.99 })
  await startProbe(); await button.click(); await expect(button).toHaveAttribute('aria-expanded', 'true')
  // Native hidden toggles still need the subsequent ResizeObserver/follow frames;
  // inspect those frames rather than accepting the synchronous click geometry.
  await page.evaluate(() => new Promise<void>(done => {
    let frames = 0
    const next = (): void => { if (++frames >= 12) done(); else requestAnimationFrame(next) }
    requestAnimationFrame(next)
  }))
  const opening = await page.evaluate(() => (window as ProbeWindow).__openingProbe?.stop() ?? [])
  await info.attach('artifacts-follow-opening-frames', { body: JSON.stringify(opening, null, 2), contentType: 'application/json' })
  const openedFrames = opening.filter(frame => frame.artifacts.expanded === 'true' && frame.artifacts.heading)
  expect(openedFrames.length).toBeGreaterThan(2)
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
  await expect(latest).toBeHidden()
  await expect(panel.locator('.work-progress-panel__footer')).toBeInViewport({ ratio: 0.99 })
  expect(opening.flatMap(frame => frame.violations)).toEqual([])
  await screenshot('artifacts-follow-open-bottom', info)
  // Moving the reader afterward is intentional, so the following disclosure
  // checks can inspect the complete preview. Closing has no fixed-anchor rule.
  await body.scrollIntoViewIfNeeded(); await button.focus(); await startProbe()
  // This surface currently uses the native hidden attribute, not MotionPresence.
  // Sample its actual frames without requiring a transition or assuming a bug.
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Enter')
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  }
  await expect(button).toHaveAttribute('aria-expanded', 'true'); await expect(body).toBeVisible()
  await expect(panel.locator('.work-progress-panel__file')).toHaveCount(5)
  await expect(body).toContainText('还有 8 个文件')
  await finishProbe('artifacts-13-open-close', info, false, true); await screenshot('artifacts-13-expanded', info)
  await button.click(); await expect(body).toBeHidden()
})

test('历史成果展开：真实向上阅读后保持标题和视口位置，不强制回到底部', async ({}, info) => {
  // A later turn makes this a genuine historical card, with content below it.
  includeLaterTurn = true
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-conversation').getByRole('heading', { name: laterTitle, exact: true })).toBeVisible()
  const panel = page.locator('.work-conversation .work-progress-panel[data-result-turn-id]')
  const button = panel.locator('.work-progress-panel__changes-toggle'), heading = panel.locator('.work-progress-panel__heading')
  const scroll = page.locator('.work-conversation__scroll'), latest = page.locator('.work-follow-latest')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  if (await latest.isVisible()) await latest.click()
  await scroll.hover({ position: { x: 8, y: 16 } }); await page.mouse.wheel(0, 10_000)
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
  const upwardDistance = await heading.evaluate(element => element.getBoundingClientRect().top
    - element.closest('.work-conversation__scroll')!.getBoundingClientRect().top - 64)
  expect(upwardDistance).toBeLessThan(-100)
  await page.mouse.wheel(0, upwardDistance)
  await expect(button).toBeInViewport({ ratio: 0.99 })
  await expect(latest).toBeVisible()
  await expect.poll(() => heading.evaluate(element => Math.abs(element.getBoundingClientRect().top
    - element.closest('.work-conversation__scroll')!.getBoundingClientRect().top - 64))).toBeLessThanOrEqual(2)
  const before = { headingTop: await heading.evaluate(element => element.getBoundingClientRect().top),
    scrollTop: await scroll.evaluate(element => element.scrollTop) }
  await startProbe(); await button.click(); await expect(button).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(() => new Promise<void>(done => {
    let frames = 0
    const next = (): void => { if (++frames >= 12) done(); else requestAnimationFrame(next) }
    requestAnimationFrame(next)
  }))
  const frames = await page.evaluate(() => (window as ProbeWindow).__openingProbe?.stop() ?? [])
  await info.attach('artifacts-history-opening-frames', { body: JSON.stringify({ before, frames }, null, 2), contentType: 'application/json' })
  const expanded = frames.filter(frame => frame.artifacts.expanded === 'true' && frame.artifacts.heading)
  expect(expanded.length).toBeGreaterThan(2)
  for (const frame of expanded) expect(Math.abs(frame.artifacts.heading!.top - before.headingTop), `历史成果标题在 ${frame.time.toFixed(1)}ms 的移动量`).toBeLessThanOrEqual(2)
  expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - before.scrollTop)).toBeLessThanOrEqual(2)
  expect(await scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100)
  await expect(latest).toBeVisible()
  expect(frames.flatMap(frame => frame.violations)).toEqual([])
  await screenshot('artifacts-history-open-preserved', info)
})
