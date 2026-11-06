/** Real Electron/HTTP/SSE coverage: ordered Work messages, shared tool cards,
 * navigation across bounded history, usage, plans, scoped artifact trees and
 * narrow panes, quiet tool failures, stopped-command exit motion and history,
 * live legacy ledger results, plus child continuation preserving drafts. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { ChatSsePayload, EngineFileChange, EngineTodo } from '../src/shared/ipc'
import type { BrowserScreenshot } from '../src/shared/browser'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult } from '../src/shared/final-result'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { SubagentRun } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi; workCancelledCardMounts: string[] } }

let health: ElectronHealthMonitor | undefined

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-timeline-fixture-token', modelId = 'work-timeline-model'
const requests: Record<string, unknown>[] = [], errors: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', responseStream: ServerResponse | undefined
let run: RootRun | undefined, child: SubagentRun | undefined, sequence = 0
let childLookupDelay: Promise<void> | null = null, childLookupCount = 0
const history: Array<{ id: string; role: string; content: string; createdAt: number; sessionId: string }> = []
const projection: ChatSsePayload[] = []
const seededHistories = new Map<string, EngineHistoryRow[]>()
const resultRuns = new Map<string, RootRun[]>()
const resultAssets = new Map<string, { bytes: Buffer; path: string; mimeType: string }>()
type DeliveryFile = { id: string; path: string; content: string | Buffer; name?: string; mimeType?: string }
const seededUsage = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>()
const changesBySession = new Map<string, EngineFileChange[]>()
const netChangesBySession = new Map<string, EngineFileChange[]>()
const admissionReceipts = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const commandJobs = new Map<string, CommandJobSnapshot>()
const commandOutputs = new Map<string, { stream: 'stdout' | 'stderr'; text: string }>()
const commandOutputReads = new Map<string, number>()
const commandCancelFailures = new Set<string>()
const commandCancelRequests: string[] = []
const progressChangeReads = new Map<string, number>()
const artifactNetChangeReads = new Map<string, number>()
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: ChatSsePayload): void {
  if (!run || !responseStream || responseStream.writableEnded) throw new Error('No live fixture stream')
  if (payload.fileChange) changesBySession.set(run.sessionId, [...(changesBySession.get(run.sessionId) ?? []), payload.fileChange])
  projection.push(payload)
  responseStream.write(`id: ${run.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function finalResult(owner: RootRun, text: string, files: DeliveryFile[]): FinalResult {
  const items = files.map(file => {
    const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)
    const mimeType = file.mimeType ?? 'text/markdown', assetId = `asset-${owner.runId}-${file.id}`
    resultAssets.set(JSON.stringify([owner.sessionId, owner.runId, assetId]), { bytes, path: file.path, mimeType })
    return { id: file.id, assetId, path: file.path, name: file.name ?? file.path.split('/').pop()!, mimeType,
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: mimeType.startsWith('image/') ? 'image' as const : 'file' as const }
  })
  return { schemaVersion: 1, sessionId: owner.sessionId, runId: owner.runId, turnId: owner.turnId,
    assistantMessageId: owner.assistantMessageId, text, items, publishedAt: Date.now() }
}
function seedFinalResult(sessionId: string, turnId: string, files: DeliveryFile[]): FinalResult {
  const rows = seededHistories.get(sessionId)!, own = rows.filter(row => row.conversationId === turnId)
  const user = own.find(row => row.role === 'user')!, answer = own.findLast(row => row.role === 'assistant')!
  const createdAt = user.createdAt ?? Date.now()
  const owner: RootRun = { schemaVersion: 1, sessionId, turnId, runId: `delivery-${turnId}`, userMessageId: user.id!, assistantMessageId: answer.id!,
    seq: 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: ['/remote/work-timeline'], createdAt, updatedAt: createdAt + 2000, finishedAt: createdAt + 2000 }
  const result = finalResult(owner, String(answer.content ?? ''), files)
  for (const row of own) row.metadata = { ...row.metadata, rootRunId: owner.runId, turnId, ...(row === answer ? { finalResult: result } : {}) }
  resultRuns.set(sessionId, [...(resultRuns.get(sessionId) ?? []).filter(run => run.turnId !== turnId), owner])
  return result
}
function finish(result?: FinalResult | null): void {
  if (!run) throw new Error('No fixture run')
  // Fixtures publish a final text receipt explicitly, just like the engine;
  // file changes and earlier process narration never seed its attachments.
  const finalText = projection.slice(projection.findLastIndex(payload => payload.toolStart || payload.toolEnd) + 1)
    .map(payload => payload.content ?? '').join('')
  // Explicit null exercises successful legacy turns that predate manifests.
  const published = result === null ? null : result ?? finalResult(run, finalText, [])
  run = { ...run, status: 'succeeded', updatedAt: Date.now(), finishedAt: Date.now(), version: run.version + 1 }
  resultRuns.set(run.sessionId, [...(resultRuns.get(run.sessionId) ?? []).filter(owner => owner.runId !== run!.runId), run])
  frame({ run })
  if (published) frame({ finalResult: published })
  responseStream!.end('data: [DONE]\n\n')
}
function snapshot(id: string): unknown {
  const seeded = seededHistories.get(id)
  if (seeded) return {
    schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
    projection: [], history: seeded, runs: resultRuns.get(id) ?? [], todos: [], changes: [], commandJobs: [...commandJobs.values()].filter(job => job.sessionId === id),
    sessionUsage: seededUsage.get(id) ?? { promptTokens: 110_000, completionTokens: 1_100, totalTokens: 111_100 }
  }
  return {
    schemaVersion: 1, sessionId: id, source: run?.status === 'running' ? 'live' : 'persisted',
    eventId: run ? `${run.runId}:${sequence}` : null, finished: run?.status !== 'running',
    projection: id === run?.sessionId ? projection : [], history: id === run?.sessionId ? history.filter(row => row.sessionId === id) : [],
    run: id === run?.sessionId ? run : undefined, runs: id === run?.sessionId ? [run] : [], todos: [], changes: [], commandJobs: []
  }
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path === '/browser-screenshot-fixture') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>浏览器截图验收</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 36px; color: #24262b; background: #f4f5f7; font: 15px/1.6 system-ui, sans-serif; }
  main { max-width: 560px; padding: 28px; border: 1px solid #dce0e5; border-radius: 16px; background: #fff; }
  p { margin: 0; color: #646a73; } h1 { margin: 8px 0 16px; font-size: 25px; font-weight: 600; }
  small { display: block; margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #646a73; }
</style></head><body><main><p>本地测试页面</p><h1>浏览器截图验收</h1>
<p>由 Aether 内置浏览器打开并截取此页面。</p><small>验收项目：截图展示 · 放大查看 · 键盘返回</small>
</main></body></html>`)
      return
    }
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401).end(envelope(null)); return
    }
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return
    }
    const cancelRoute = path.match(/^\/api\/v1\/command-jobs\/([^/]+)\/cancel$/)
    if (cancelRoute && request.method === 'POST') {
      const job = commandJobs.get(cancelRoute[1])
      if (!job || body.sessionId !== job.sessionId) { response.writeHead(404).end(envelope(null)); return }
      commandCancelRequests.push(job.jobId)
      if (commandCancelFailures.has(job.jobId)) {
        response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 409, message: '停止请求未被接受', data: null })); return
      }
      const cancelling: CommandJobSnapshot = { ...job, status: 'cancelling', version: job.version + 1, updatedAt: Date.now() }
      commandJobs.set(job.jobId, cancelling)
      response.setHeader('content-type', 'application/json')
      response.end(envelope(cancelling)); return
    }
    const commandRoute = path.match(/^\/api\/v1\/command-jobs\/([^/]+)\/output$/)
    if (commandRoute) {
      const job = commandJobs.get(commandRoute[1])
      if (!job || url.searchParams.get('sessionId') !== job.sessionId) { response.writeHead(404).end(envelope(null)); return }
      commandOutputReads.set(job.jobId, (commandOutputReads.get(job.jobId) ?? 0) + 1)
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ job, entries: [{ seq: 1, ...(commandOutputs.get(job.jobId) ?? { stream: 'stdout', text: 'CHILD_BACKGROUND_COMMAND_COMPLETE\n' }) }], nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false }))
      return
    }
    if (path === '/api/v1/chat/admission/context' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const current = run?.sessionId === sessionId && !seededHistories.has(sessionId) ? run : null
      const root = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId,
        namespace: { id: 'work-timeline-db', generation: 'one' },
        transport: { toolProfile: request.headers['x-aether-tool-profile'] || 'general', runLifetime: 'durable', subagentProtocol: 2 }, root,
        predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null }))
      return
    }
    if (path === '/api/v1/chat/admission/receipt' && request.method === 'POST') {
      const accepted = admissionReceipts.get(String(body.requestKey))
      const current = accepted && (accepted.run.runId === run?.runId ? run : accepted.run)
      response.setHeader('content-type', 'application/json')
      response.end(envelope(accepted && current ? {
        protocolVersion: 1, status: 'accepted',
        receipt: { ...accepted.admission, sessionId: current.sessionId, rootRunId: current.runId,
          turnId: current.turnId, userMessageId: current.userMessageId, assistantMessageId: current.assistantMessageId },
        run: current, projection: { rootVersion: current.version, rootAttemptId: `attempt-${current.runId}`,
          user: { messageId: current.userMessageId, state: 'projected' },
          assistant: { anchorMessageId: current.assistantMessageId, state: 'unwritten' } }
      } : { protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey }))
      return
    }
    if (path === '/api/v1/chat' && request.method === 'POST') {
      requests.push(body)
      const id = String(body.sessionId)
      sequence = 0; projection.length = 0; responseStream = response
      run = {
        schemaVersion: 1, runId: `timeline-run-${requests.length}`, sessionId: id,
        turnId: `timeline-turn-${requests.length}`, userMessageId: `timeline-user-${requests.length}`,
        assistantMessageId: `timeline-assistant-${requests.length}`, seq: requests.length, version: 1, status: 'running',
        modelId, pending: [], workspacePaths: [], createdAt: Date.now(), updatedAt: Date.now()
      }
      if (body.admission && typeof body.admission === 'object' && !Array.isArray(body.admission)) {
        const admission = body.admission as Record<string, unknown>
        if (admission.protocolVersion !== 1 || admission.owner !== 'work' || typeof admission.requestKey !== 'string') throw new Error('Invalid fixture admission envelope')
        admissionReceipts.set(admission.requestKey, { admission, run })
      }
      const user = { id: run.userMessageId, role: 'user', content: String(body.message), createdAt: Date.now() }
      history.push({ ...user, sessionId: id })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ run }); frame({ userMessage: user }); return
    }
    if (path === '/api/v1/subagent/runs/child-first-run' && childLookupDelay) {
      childLookupCount += 1
      await childLookupDelay
    }
    const id = url.searchParams.get('sessionId') ?? ''
    if (path === '/api/v1/conversation/result-asset') {
      const runId = url.searchParams.get('runId') ?? '', assetId = url.searchParams.get('assetId') ?? ''
      const asset = resultAssets.get(JSON.stringify([id, runId, assetId]))
      const owner = resultRuns.get(id)?.find(item => item.runId === runId)
      response.setHeader('content-type', 'application/json')
      if (!asset || owner?.status !== 'succeeded') { response.writeHead(404).end(JSON.stringify({ code: 40400, message: 'Result asset unavailable', data: null })); return }
      response.end(envelope({ path: asset.path, content: asset.bytes.toString('base64'), isBinary: asset.mimeType.startsWith('image/'),
        totalSize: asset.bytes.length, tooLarge: false, truncated: false, mimeType: asset.mimeType, encoding: 'base64' })); return
    }
    if (path === '/api/v1/conversation/display' && request.method === 'GET') {
      const rows: EngineHistoryRow[] = seededHistories.get(id) ?? history.filter(row => row.sessionId === id)
      // Live fixture user rows have no conversationId; row boundaries keep
      // each selected turn intact without accidentally including another turn.
      const users = rows.flatMap((row, index) => row.role === 'user' ? [{ row, index }] : [])
      const anchor = url.searchParams.get('anchorMessageId'), limit = Number(url.searchParams.get('limit') ?? 2)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error(`Invalid display limit: ${limit}`)
      const start = anchor ? users.findIndex(({ row }) => row.id === anchor) : Math.max(0, users.length - limit)
      response.setHeader('content-type', 'application/json')
      if (start < 0) {
        response.writeHead(404).end(JSON.stringify({ code: 40400, message: 'Display turn not found', data: null })); return
      }
      const selected = users.slice(start, start + limit)
      response.end(envelope({ schemaVersion: 1,
        turns: users.map(({ row }) => ({ userMessageId: row.id, conversationId: row.conversationId,
          preview: String(row.content ?? '').slice(0, 100), createdAt: row.createdAt })),
        messages: selected.length ? rows.slice(selected[0].index, users[start + selected.length]?.index ?? rows.length) : [],
        loadedTurnIds: selected.map(({ row }) => row.id), revision: `${id}:${rows.length}:${sequence}`,
        mutationRevision: `${id}:unchanged`, backend: 'jsonl', completeness: 'complete' }))
      return
    }
    if (path === '/api/v1/changes' && !url.searchParams.has('status') && !url.searchParams.has('view')) {
      progressChangeReads.set(id, (progressChangeReads.get(id) ?? 0) + 1)
    }
    if (path === '/api/v1/changes' && url.searchParams.get('view') === 'net') {
      artifactNetChangeReads.set(id, (artifactNetChangeReads.get(id) ?? 0) + 1)
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'work-timeline-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Timeline fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/chat/snapshot' ? snapshot(id)
            : path === '/api/v1/conversation/history' ? seededHistories.get(id) ?? history.filter(row => row.sessionId === id)
            : path === '/api/v1/changes' ? url.searchParams.get('view') === 'net'
              ? netChangesBySession.get(id) ?? (changesBySession.get(id) ?? []).filter(change => change.status === 'pending')
              : changesBySession.get(id) ?? []
            : path === '/api/v1/chat/runs' ? { runs: seededHistories.has(id) ? resultRuns.get(id) ?? [] : id === run?.sessionId ? [run] : [] }
            : path === '/api/v1/chat/status' ? { running: id === run?.sessionId && run.status === 'running', finished: id !== run?.sessionId || run.status !== 'running' }
              : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
              : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: child && url.searchParams.get('parentSessionId') === child.parentSessionId ? [child] : [], listComplete: true, hasMore: false, revision: 'fixture' }
                : path === '/api/v1/subagent/runs/child-first-run' ? child
                : path === '/api/v1/command-jobs' ? { jobs: [...commandJobs.values()].filter(job => job.sessionId === id) }
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                      : path === '/api/v1/agents' ? [{ id: 'timeline-agent', name: '界面验收 Agent', description: '检查响应式布局' }]
                        : path === '/api/v1/skills' ? { list: [{ id: 'review-ui', name: '界面审查', description: '检查交互与布局', enabled: true }, ...Array.from({ length: 28 }, (_, index) => ({ id: `review-${index}`, name: `验收技能 ${index + 1}`, description: '长列表键盘与滚动检查', enabled: true }))] }
                          : path === '/api/v1/mcp/servers' ? [{ id: 'browser-tools', name: '浏览器工具', description: '验证页面', enabled: true }]
                            : path === '/api/v1/knowledge/bases' ? [{ id: 'design-docs', name: '设计资料', description: '验收资料', documentCount: 2, createdAt: Date.now() }]
                              : path === '/api/v1/workspace/directory' ? { root: '/remote/work-timeline', entries: [] }
                        : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/work-timeline' } : []
    response.setHeader('content-type', 'application/json')
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const work = () => page.locator('.work-view')
async function copyToolDiagnostic(container: Locator, marker: string): Promise<string> {
  const instance = app!
  const previous = await instance.evaluate(({ clipboard }) => ({ formats: clipboard.availableFormats(), text: clipboard.readText(), html: clipboard.readHTML(),
    rtf: clipboard.readRTF(), image: clipboard.readImage().toPNG().toString('base64'), bookmark: clipboard.readBookmark() }))
  let copied = ''
  try {
    await container.getByRole('button', { name: '复制诊断', exact: true }).click()
    await expect.poll(() => instance.evaluate(({ clipboard }) => clipboard.readText())).toContain(marker)
    copied = await instance.evaluate(({ clipboard }) => clipboard.readText())
    return copied
  } finally {
    await instance.evaluate(({ clipboard, nativeImage }, saved) => {
      if (!saved.copied || clipboard.readText() !== saved.copied) return
      if (!saved.previous.formats.length) { clipboard.clear(); return }
      clipboard.write({ text: saved.previous.text, html: saved.previous.html, rtf: saved.previous.rtf,
        ...(saved.previous.image ? { image: nativeImage.createFromDataURL(`data:image/png;base64,${saved.previous.image}`) } : {}),
        ...(saved.previous.bookmark.title ? { bookmark: saved.previous.bookmark.title } : {}) })
    }, { copied, previous })
  }
}
async function expectNoWorkRawData(container: Locator): Promise<void> {
  await expect(container.locator('.work-tool-technical, .tool-result__metadata, .automation-card-receipt')).toHaveCount(0)
  await expect(container.getByLabel('工具技术详情', { exact: true })).toHaveCount(0)
  await expect(container.getByRole('region', { name: /^原始(?:输入|输出|错误)$/ })).toHaveCount(0)
  await expect(container.getByRole('button', { name: /^复制原始(?:输入|输出|错误)$/ })).toHaveCount(0)
  await expect(container.locator('summary').filter({ hasText: /原始数据|原始输入|原始输出|原始收据|工具技术详情|结果详情/ })).toHaveCount(0)
}
async function setWorkAppearance(appearance: 'dark' | 'light'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
}
async function expectPointerTarget(option: Locator): Promise<void> {
  await expect(option).toBeVisible()
  await expect.poll(() => option.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit !== null && element.contains(hit)
  })).toBe(true)
}

async function expectImageDialogSettled(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible()
  // Decoded pixels can precede the portal's two entrance frames. Capture only
  // after its actual opacity and motion settle, so screenshots include the modal.
  await expect.poll(() => dialog.evaluate(element => {
    const overlay = element.closest('.modal-overlay')
    if (!overlay || overlay.getAttribute('data-motion-state') !== 'open' || getComputedStyle(overlay).opacity !== '1') return false
    const moving = overlay.getAnimations({ subtree: true }).some(animation =>
      (animation.playState === 'running' || animation.pending) && animation.effect?.getTiming().iterations !== Infinity)
    const image = element.querySelector('img'), rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return !moving && !!image?.complete && image.naturalWidth > 0 && hit !== null && element.contains(hit)
  })).toBe(true)
}

async function expectPopoverInViewport(palette: Locator, input: Locator): Promise<void> {
  await expect(palette).toBeVisible()
  // Entrance transforms can briefly pass the bounds check before moving the
  // panel again. Measure only after its actual motion and layout have settled.
  await palette.evaluate(element => new Promise<void>((resolve, reject) => {
    const panel = element.closest('.work-completion-popover') ?? element
    let previous = '', stable = 0
    const deadline = performance.now() + 3000
    const sample = (): void => {
      const rect = panel.getBoundingClientRect()
      const next = JSON.stringify([rect.left, rect.right, rect.top, rect.bottom, innerWidth, innerHeight,
        document.querySelector('.menu-bar')?.getBoundingClientRect().bottom ?? 0])
      const moving = panel.getAnimations({ subtree: true }).some(animation =>
        (animation.playState === 'running' || animation.pending) && animation.effect?.getTiming().iterations !== Infinity)
      const open = !panel.hasAttribute('data-motion-state') || panel.getAttribute('data-motion-state') === 'open'
      stable = open && !moving && next === previous ? stable + 1 : 0; previous = next
      if (stable >= 3) { resolve(); return }
      if (performance.now() > deadline) { reject(new Error('Completion popover layout did not settle before viewport verification')); return }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  // Native setSize can finish before Chromium delivers its resize event. Wait
  // for the portal's measured position, keeping the same viewport constraints.
  await expect.poll(() => palette.evaluate(element => {
    const rect = (element.closest('.work-completion-popover') ?? element).getBoundingClientRect()
    const chromeBottom = document.querySelector('.menu-bar')?.getBoundingClientRect().bottom ?? 0
    return rect.left >= 8 && rect.right <= innerWidth - 8 &&
      rect.top >= chromeBottom && rect.bottom <= innerHeight - 8
  })).toBe(true)
  const metrics = await palette.evaluate(element => {
    const rect = (element.closest('.work-completion-popover') ?? element).getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, chromeBottom: document.querySelector('.menu-bar')?.getBoundingClientRect().bottom ?? 0 }
  })
  expect(metrics.left).toBeGreaterThanOrEqual(8)
  expect(metrics.right).toBeLessThanOrEqual(metrics.width - 8)
  expect(metrics.top).toBeGreaterThanOrEqual(metrics.chromeBottom)
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.height - 8)
  const inputBounds = await input.boundingBox()
  expect(inputBounds).not.toBeNull()
  expect(metrics.bottom <= inputBounds!.y || metrics.top >= inputBounds!.y + inputBounds!.height).toBe(true)
  // Agents share the tabbed MentionRefPicker and have no private Work title.
  // Test the selected actionable row rather than an obsolete decorative node.
  await expectPointerTarget(palette.getByRole('option', { selected: true }).first())
}

test.describe.serial('Work 时间线与协作详情', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-timeline-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, remoteWorkspaceRoot: '/remote/code-project', lastSessionId: '', lastModelId: modelId, appearance: 'dark', lastFolder: '' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-timeline', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, testInfo) => {
    responseStream?.destroy()
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-timeline-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('首页与小窗口的 @ Agent 和 / 资源候选可点击，选择结果保留在输入区', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 760))
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    await input.fill('@agent')
    const agentPalette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    const agentOption = agentPalette.getByRole('option', { name: /界面验收 Agent/ })
    await expectPopoverInViewport(agentPalette, input)
    await expectPointerTarget(agentOption)
    await page.screenshot({ path: testInfo.outputPath('work-home-agent-940.png'), animations: 'disabled' })
    await agentOption.click()
    await expect(input.locator('.mention-chip--agent')).toHaveText('界面验收 Agent')
    await expect(page.locator('.work-agent-picker')).toHaveCount(0)
    await input.fill('/')
    const resourcePalette = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    const resourceOption = resourcePalette.getByRole('option', { name: /界面审查/ })
    await expectPopoverInViewport(resourcePalette, input)
    await expectPointerTarget(resourceOption)
    await page.screenshot({ path: testInfo.outputPath('work-home-resources-940.png'), animations: 'disabled' })
    await resourceOption.click()
    await expect(work().locator('.work-resource-chip')).toHaveText('技能 · review-ui ×')
    await expect(page.locator('.resource-picker')).toHaveCount(0)
    await work().locator('.work-resource-chip').click()
    await expect(work().locator('.work-resource-chip')).toHaveCount(0)
    await input.fill('')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('候选键盘选择和空结果回车不会发送任务，内部滚动可抵达末项', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 640))
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    await input.fill('@agent')
    const agentPalette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    await expect(agentPalette.getByRole('option', { name: /界面验收 Agent/ })).toBeVisible()
    await expectPopoverInViewport(agentPalette, input)
    await input.press('Enter')
    await expect(input.locator('.mention-chip--agent')).toHaveText('界面验收 Agent')
    expect(requests).toHaveLength(0)
    await input.fill('@agent missing-agent')
    await expect(agentPalette).toContainText('没有匹配的 Agent')
    await input.press('Enter')
    await expect(agentPalette).toBeVisible()
    expect(requests).toHaveLength(0)
    await input.press('Escape')
    await expect(page.locator('.work-completion-popover')).toHaveCount(0)
    await input.fill('/')
    const resourcePalette = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    await expect(resourcePalette.getByRole('option')).toHaveCount(31)
    await expectPopoverInViewport(resourcePalette, input)
    await input.press('ArrowUp')
    await expectPointerTarget(resourcePalette.getByRole('option', { name: /设计资料/ }))
    await input.press('Enter')
    await expect(work().locator('.work-resource-chip')).toHaveText('知识库 · design-docs ×')
    await expect(resourcePalette).toHaveCount(0)
    expect(requests).toHaveLength(0)
    await work().locator('.work-resource-chip').click()
    await input.fill('/')
    await expect(resourcePalette.getByRole('option')).toHaveCount(31)
    await resourcePalette.hover()
    await page.mouse.wheel(0, 2200)
    await expect.poll(() => resourcePalette.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(resourcePalette).toBeVisible()
    const lastResource = resourcePalette.getByRole('option', { name: /设计资料/ })
    await lastResource.scrollIntoViewIfNeeded()
    await expectPointerTarget(lastResource)
    await page.screenshot({ path: testInfo.outputPath('work-resources-scrolled-940.png'), animations: 'disabled' })
    await lastResource.click()
    await expect(work().locator('.work-resource-chip')).toHaveText('知识库 · design-docs ×')
    await work().locator('.work-resource-chip').click()
    await input.fill('/missing-resource')
    await expect(resourcePalette).toContainText('没有匹配资源')
    await input.press('Enter')
    await expect(resourcePalette).toBeVisible()
    expect(requests).toHaveLength(0)
    await input.press('Escape')
    await expect(page.locator('.work-completion-popover')).toHaveCount(0)
    await input.fill('')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('正文与工具按发生顺序显示，结果提供可读预览且没有原始数据入口，执行反馈定位当前工具', async ({}, testInfo) => {
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('按顺序调研、编辑和验证，不要混淆过程与正文')
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    // Both command palettes remain usable while a task is running. This is a
    // real contenteditable interaction, not a static screenshot assertion.
    const composerInput = work().getByRole('textbox', { name: '继续对话', exact: true })
    await composerInput.fill('@agent')
    const agentPalette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    await expect(agentPalette).toContainText('界面验收 Agent')
    await expectPointerTarget(agentPalette.getByRole('option', { name: /界面验收 Agent/ }))
    await expectPopoverInViewport(agentPalette, composerInput)
    await composerInput.press('Escape')
    await expect(page.locator('.work-completion-popover')).toHaveCount(0)
    await composerInput.fill('/')
    const resourcePalette = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    await expect(resourcePalette).toContainText('界面审查')
    const taskResource = resourcePalette.getByRole('option', { name: /界面审查/ })
    await expectPointerTarget(taskResource)
    await expectPopoverInViewport(resourcePalette, composerInput)
    await taskResource.click()
    await expect(work().locator('.work-resource-chip')).toHaveText('技能 · review-ui ×')
    await expect(page.locator('.resource-picker')).toHaveCount(0)
    await work().locator('.work-resource-chip').click()
    frame({ content: '先读取需求，确认验收范围。' })
    const rawReadArgs = '{ "path": "requirements.md" }'
    frame({ toolStart: { id: 'read-plan', name: 'read_file', args: rawReadArgs } })
    frame({ toolEnd: { id: 'read-plan', name: 'read_file', output: 'READ_REQUIREMENTS_RESULT', success: true } })
    frame({ content: '需求已确认，现在实现页面。' })
    frame({ toolStart: { id: 'write-page', name: 'write_file', args: { path: 'index.html' } } })
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const message = conversation.locator('.work-message--assistant').last()
    await expect(message.locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(message.locator('[data-tool-id="write-page"]')).toHaveAttribute('data-tool-state', 'running')
    await expect(message.locator('.work-process')).toHaveCount(0)
    const ordered = await message.locator('.work-message__timeline').innerText()
    for (const part of ['先读取需求', 'requirements.md', '需求已确认', 'index.html']) expect(ordered).toContain(part)
    expect(ordered.indexOf('先读取需求')).toBeLessThan(ordered.indexOf('requirements.md'))
    expect(ordered.indexOf('requirements.md')).toBeLessThan(ordered.indexOf('需求已确认'))
    expect(ordered.indexOf('需求已确认')).toBeLessThan(ordered.indexOf('index.html'))
    const read = message.locator('[data-work-tool-id="read-plan"]')
    await read.locator('.compact-tool-row button.logline .logline__name').click()
    await expect(read).toContainText('READ_REQUIREMENTS_RESULT')
    await expect(read.locator('.logline__detail pre')).toHaveText('READ_REQUIREMENTS_RESULT')
    await expectNoWorkRawData(read)
    await conversation.getByRole('button', { name: '查看正在执行的活动', exact: true }).press('Enter')
    const write = message.locator('[data-work-tool-id="write-page"]')
    await expect(write).toBeFocused()
    await expect(write).toBeInViewport()
    await expect(write.locator('button.logline')).toContainText('index.html')
    await expectNoWorkRawData(write)
    await expect(work().getByRole('tab', { name: '活动', exact: true })).toHaveCount(0)
    await expect(work().getByRole('button', { name: '在侧栏查看详情', exact: true })).toHaveCount(0)
    frame({ todo: { todos: [{ id: 'plan', title: '核对需求范围', status: 'done', priority: 'medium' }, { id: 'verify', title: '运行页面验收', status: 'in_progress', priority: 'medium' }] } })
    await expect(conversation.getByRole('region', { name: '任务清单', exact: true })).toContainText('运行页面验收')
    frame({ toolEnd: { id: 'write-page', name: 'write_file', output: 'WRITE_PAGE_RESULT\n'.repeat(150), success: true } })
    frame({ content: '页面已实现，等待最终验收。' })
    finish()
    await expect(message.locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(message.locator('[data-tool-id="write-page"]')).toHaveAttribute('data-tool-state', 'done')
    await expect(message.locator('.md').last()).toContainText('页面已实现')
    await expectNoWorkRawData(message)
    await page.screenshot({ path: testInfo.outputPath('work-timeline-1440.png'), animations: 'disabled' })
  })

  test('窄窗口对话内可读结果独立滚动且没有横向溢出或技术入口', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 780))
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const scroll = conversation.locator('.work-conversation__scroll')
    const write = conversation.locator('[data-work-tool-id="write-page"]')
    const disclosure = write.locator('button.logline')
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
    const output = write.locator('.logline__detail pre')
    // A fixed-height pre is measurable before its enclosing disclosure has
    // finished growing. Take the outer-scroll baseline after that transition.
    await expect.poll(() => write.evaluate(element => [...element.querySelectorAll('[data-motion-state]')].every(node => node.getAttribute('data-motion-state') === 'open')
      && !element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity))).toBe(true)
    await output.scrollIntoViewIfNeeded()
    await expect(output).toContainText('WRITE_PAGE_RESULT')
    await expect.poll(() => scroll.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2)
    await output.evaluate(node => { node.scrollTop = 500 })
    await output.hover({ position: { x: 20, y: 20 } })
    const before = await output.evaluate(node => new Promise<{ outerTop: number; innerTop: number; outerRange: number }>((resolve, reject) => {
      const outer = node.closest('.work-conversation__scroll')!
      let previous = '', stable = 0
      const deadline = performance.now() + 3000
      const sample = (): void => {
        const rect = node.getBoundingClientRect(), next = JSON.stringify([outer.scrollTop, outer.scrollHeight, outer.clientHeight, rect.top, rect.height])
        stable = next === previous ? stable + 1 : 0; previous = next
        if (stable >= 3) { resolve({ outerTop: outer.scrollTop, innerTop: node.scrollTop, outerRange: outer.scrollHeight - outer.clientHeight }); return }
        if (performance.now() > deadline) { reject(new Error('Tool output layout did not settle before independent-scroll verification')); return }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }))
    expect(before.outerRange).toBeGreaterThan(0)
    expect(before.innerTop).toBe(500)
    // Pick a direction in which the outer container could move, so a leaked
    // wheel event cannot pass merely because the conversation is at an edge.
    const wheelDelta = before.outerTop > 0 ? -300 : 300
    await page.mouse.wheel(0, wheelDelta)
    await expect.poll(() => output.evaluate(node => node.scrollTop)).toBe(wheelDelta < 0 ? 200 : 800)
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(before.outerTop)
    await expectNoWorkRawData(conversation)
    await page.screenshot({ path: testInfo.outputPath('work-tool-details-680.png'), animations: 'disabled' })
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  })

  test('子代理详情可查看并继续同一代理，父对话的输入草稿保留', async () => {
    if (!run) throw new Error('Missing parent run')
    child = {
      schemaVersion: 2, view: 'summary', runId: 'child-first-run', tenantId: 'fixture', rootSessionId: run.sessionId, parentSessionId: run.sessionId,
      parentConversationId: run.turnId, parentMessageId: run.assistantMessageId, parentToolCallId: 'child-tool', childSessionId: 'child-session',
      task: '实现页面并验证可访问性', description: '页面开发代理', modelId, status: 'succeeded', lastSeq: 3,
      createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), continuation: { role: 'implementer', readOnly: false },
      resultSummary: 'CHILD_RESULT：页面已完成，键盘导航通过。', usage: { totalTokens: 42 }, toolCalls: [], toolCount: 0, activeToolCount: 0,
      coverage: { asOfSeq: 3, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0, ids: [], hasMore: false, truncated: false, completeness: 'complete' }
    }
    const openWorkspace = work().getByRole('button', { name: '打开工作区', exact: true })
    if (await openWorkspace.isVisible()) await openWorkspace.click()
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '子代理', exact: true }).click()
    const panel = work().getByRole('region', { name: '协作代理', exact: true })
    await panel.getByRole('button', { name: '刷新子代理状态', exact: true }).click()
    await expect(panel).toContainText('实现页面并验证可访问性')
    await expect(panel).toContainText('开发实现')
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('DRAFT_MUST_SURVIVE_CHILD_CONTINUATION')
    await panel.getByRole('button', { name: '查看 开发实现 子代理详情', exact: true }).click()
    const continuation = panel.getByRole('textbox', { name: '继续交给 开发实现', exact: true })
    await continuation.fill('继续检查小屏布局，修复后给出验证结果')
    let releaseLookup: () => void = () => undefined
    childLookupDelay = new Promise<void>(resolve => { releaseLookup = resolve })
    try {
      await panel.getByRole('button', { name: '继续执行', exact: true }).click()
      await expect.poll(() => childLookupCount).toBe(1)
      // The persistent detail composer can keep a next-step draft while the
      // submitted request is being checked; only duplicate submission is locked.
      await expect(continuation).toBeEnabled()
      await expect(continuation).toHaveValue('继续检查小屏布局，修复后给出验证结果')
      await expect(panel.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled()
      expect(requests).toHaveLength(1)
    } finally { childLookupDelay = null; releaseLookup() }
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1].sessionId).toBe(requests[0].sessionId)
    expect(requests[1].collaborators).toEqual([{ resumeRunId: 'child-first-run' }])
    expect(String(requests[1].message)).toContain('继续检查小屏布局')
    expect(String(requests[1].message)).not.toContain('DRAFT_MUST_SURVIVE')
    await expect(input).toHaveText('DRAFT_MUST_SURVIVE_CHILD_CONTINUATION')
    frame({ content: '子代理已继续同一上下文。' }); finish()
    await expect(input).toHaveText('DRAFT_MUST_SURVIVE_CHILD_CONTINUATION')
    expect(errors).toEqual([])
  })

  test('首页滚动移走输入区后关闭候选并释放键盘，临近顶部时菜单不遮挡标题栏', async ({}, testInfo) => {
    // Build a genuinely scrollable recent-task list using normal task creation.
    for (let index = 0; index < 10; index++) {
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(`滚动定位验收 ${index + 1}`)
      const count = requests.length
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => requests.length).toBe(count + 1)
      frame({ content: `滚动验收 ${index + 1} 已完成。` }); finish()
      await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(`滚动验收 ${index + 1} 已完成。`)
    }
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 640))
    const input = work().getByRole('textbox', { name: '任务目标', exact: true })
    const home = work().locator('.work-home')
    await input.fill('@agent')
    const palette = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
    await expectPointerTarget(palette.getByRole('option', { name: /界面验收 Agent/ }))
    const bounds = await home.boundingBox()
    if (!bounds) throw new Error('Missing scrollable Work homepage')
    await page.mouse.move(bounds.x + bounds.width - 24, bounds.y + bounds.height - 30)
    await page.mouse.wheel(0, 145)
    await expect.poll(() => home.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await expectPopoverInViewport(palette, input)
    await page.screenshot({ path: testInfo.outputPath('work-agent-near-chrome.png'), animations: 'disabled' })
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => input.evaluate(element => element.closest('.work-composer')!.getBoundingClientRect().bottom)).toBeLessThan(0)
    await expect(palette).toHaveCount(0)
    await expect(input).toBeFocused()
    const count = requests.length
    await page.keyboard.press('Tab')
    await expect(input).not.toBeFocused()
    expect(requests).toHaveLength(count)
    expect(errors).toEqual([])
  })

  test('未完成步骤只留在过程内，可键盘分页查看诊断且 DOM 有界，拖动分栏只在释放时保存布局', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_ACTIVITY_PERFORMANCE')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    for (let index = 0; index < 90; index++) {
      frame({ toolStart: { id: `performance-tool-${index}`, name: 'read_file', args: { path: `performance-${index}.txt` } } })
      frame({ toolEnd: { id: `performance-tool-${index}`, name: 'read_file', output: `PERFORMANCE_TOOL_RESULT_${index}`,
        error: `PERFORMANCE_TOOL_ERROR_${index}`, success: false } })
    }
    frame({ content: '活动压力任务已完成。' }); finish()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    await expect(conversation).toContainText('活动压力任务已完成。')
    await expect(conversation.locator('.work-failure-navigator')).toHaveCount(0)
    await expect(conversation.getByRole('region', { name: '未完成的步骤', exact: true })).toHaveCount(0)
    await expect(conversation.locator('[data-work-tool-id^="performance-tool-"]')).toHaveCount(0)
    const process = conversation.locator('.work-message__process-toggle')
    await expect(process).toContainText('90 步未通过')
    await process.press('Enter')
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    const pages = conversation.getByRole('navigation', { name: '活动分页', exact: true })
    await expect(pages).toContainText('81–90 / 90')
    const lastTool = conversation.locator('[data-work-tool-id="performance-tool-89"]')
    await expect(conversation.locator('[data-work-tool-id^="performance-tool-"]')).toHaveCount(10)
    await lastTool.locator('button.logline').press('Enter')
    await expect(lastTool.locator('button.logline')).toBeFocused()
    await expect(lastTool).toBeInViewport()
    await expect(lastTool.locator('.logline__detail')).toContainText('PERFORMANCE_TOOL_RESULT_89')
    await expect(lastTool.getByRole('alert')).toHaveCount(0)
    await expect(lastTool.locator('.work-tool-outcome[role="note"]')).toBeVisible()
    const diagnostic = await copyToolDiagnostic(lastTool, 'PERFORMANCE_TOOL_ERROR_89')
    expect(diagnostic).toContain('PERFORMANCE_TOOL_RESULT_89')
    await lastTool.locator('button.logline').press('Space')
    await expect(lastTool.locator('.logline__detail')).toHaveCount(0)
    await expectNoWorkRawData(lastTool)
    for (let index = 0; index < 4; index++) await pages.getByRole('button', { name: '上一页', exact: true }).press('Enter')
    await expect(pages).toContainText('1–20 / 90')
    await expect(pages.getByRole('button', { name: '上一页', exact: true })).toBeDisabled()
    const firstTool = conversation.locator('[data-work-tool-id="performance-tool-0"]')
    await firstTool.locator('button.logline').press('Enter')
    await expect(firstTool.locator('button.logline')).toBeFocused()
    await expect(firstTool.locator('.logline__detail')).toContainText('PERFORMANCE_TOOL_RESULT_0')
    await expect(firstTool.locator('.work-tool-outcome[role="note"]')).toBeVisible()
    await expect(firstTool.getByRole('alert')).toHaveCount(0)
    await expect(conversation.locator('[data-work-tool-id^="performance-tool-"]')).toHaveCount(20)
    await pages.getByRole('button', { name: '下一页', exact: true }).press('Enter')
    await expect(conversation.locator('[data-work-tool-id="performance-tool-0"]')).toHaveCount(0)
    await conversation.locator('[data-work-tool-id="performance-tool-20"] button.logline').press('Enter')
    await expect(conversation.locator('[data-work-tool-id="performance-tool-20"] button.logline')).toBeFocused()
    await pages.getByRole('button', { name: '上一页', exact: true }).press('Enter')
    await expect(conversation.locator('[data-work-tool-id="performance-tool-0"]')).toBeVisible()
    await expect(conversation.locator('[data-work-tool-id="performance-tool-20"]')).toHaveCount(0)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '活动', exact: true })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '资料', exact: true }).click()
    await expect(work().getByRole('tab', { name: '活动', exact: true })).toHaveCount(0)
    await expect(work().locator('.work-workspace__body--git .work-git-panel')).toHaveCount(0)
    const divider = work().getByRole('separator', { name: '调整对话与工作区宽度' })
    const storedRatio = () => page.evaluate(() => Number(JSON.parse(localStorage.getItem('aether.work.view.v1') || '{}').ratio))
    const ratio = Number(await divider.getAttribute('aria-valuenow'))
    await expect.poll(storedRatio).toBe(ratio)
    const rect = await divider.boundingBox()
    if (!rect) throw new Error('Missing Work divider')
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width / 2 + (ratio > 55 ? -80 : 80), rect.y + rect.height / 2, { steps: 12 })
    await expect.poll(() => divider.getAttribute('aria-valuenow')).not.toBe(String(ratio))
    expect(await storedRatio()).toBe(ratio)
    await page.mouse.up()
    const painted = await work().locator('.work-task-body').evaluate(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--work-conversation-ratio')))
    await expect.poll(storedRatio).toBeCloseTo(painted, 4)
    expect(errors).toEqual([])
  })

  test('Work 多次校验未通过后成功只保留紧凑步骤，写入失败和原始诊断仍可查看复制', async ({}, testInfo) => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_ROUTINE_FAILURE_RECOVERY')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    for (const attempt of [1, 2]) {
      frame({ toolStart: { id: `routine-test-${attempt}`, name: 'execute_cmd', args: { command: 'node', args: ['--test', 'board.test.mjs'], cwd: '/remote/work-timeline' } } })
      frame({ toolEnd: { id: `routine-test-${attempt}`, name: 'execute_cmd', success: false,
        error: 'COMMAND_EXIT_FAILED', metadata: { exitCode: 1 },
        output: `ROUTINE_TEST_ATTEMPT_${attempt}\nAssertionError: winning line must contain five stones\n4 !== 5` } })
    }
    frame({ toolStart: { id: 'routine-command', name: 'execute_cmd', args: { command: 'node', args: ['verify-board.mjs'] } } })
    frame({ toolEnd: { id: 'routine-command', name: 'execute_cmd', success: false, error: 'COMMAND_EXIT_FAILED',
      metadata: { exitCode: 2, code: 'COMMAND_EXIT_FAILED' }, output: 'ROUTINE_COMMAND_OUTPUT：校验文件尚未生成' } })
    frame({ toolStart: { id: 'routine-write', name: 'write_file', args: { path: 'board.json', content: '{"size":19}' } } })
    frame({ toolEnd: { id: 'routine-write', name: 'write_file', success: false,
      error: '写入 board.json 未完成：文件只读（EACCES）', output: 'ROUTINE_WRITE_OUTPUT：原文件内容保持不变' } })
    frame({ toolStart: { id: 'routine-test-success', name: 'execute_cmd', args: { command: 'node', args: ['--test', 'board.test.mjs'] } } })
    frame({ toolEnd: { id: 'routine-test-success', name: 'execute_cmd', success: true, metadata: { exitCode: 0 }, output: 'ROUTINE_TEST_SUCCESS：全部 8 项测试通过' } })
    frame({ content: '修复完成，最后一轮的 8 项测试全部通过。' }); finish()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    await expect(conversation).toContainText('最后一轮的 8 项测试全部通过')
    expect(run?.status).toBe('succeeded')
    await expect(conversation.locator('.work-error-notice, [role="alert"]')).toHaveCount(0)
    const process = conversation.locator('.work-message__process-toggle')
    await expect(process).toContainText('4 步未通过')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await process.press('Enter')
    const firstTest = conversation.locator('[data-work-tool-id="routine-test-1"]')
    const secondTest = conversation.locator('[data-work-tool-id="routine-test-2"]')
    await expect(firstTest.locator('.logline__status')).toHaveText('测试未通过')
    await expect(secondTest.locator('.logline__status')).toHaveText('测试未通过')
    await expect(conversation.locator('[data-work-tool-id="routine-command"] .logline__status')).toHaveText('命令未通过')
    await firstTest.locator('button.logline').press('Enter')
    await expect(firstTest.locator('.work-tool-outcome[role="note"]')).toContainText('测试已结束，退出码 1')
    await expect(firstTest.locator('.logline__detail > pre')).toContainText('AssertionError: winning line must contain five stones')
    const diagnostic = await copyToolDiagnostic(firstTest, 'ROUTINE_TEST_ATTEMPT_1')
    for (const evidence of ['node', '--test', 'board.test.mjs', '/remote/work-timeline', 'COMMAND_EXIT_FAILED', '退出码：1', '4 !== 5']) expect(diagnostic).toContain(evidence)
    await firstTest.locator('button.logline').press('Space')
    await expect(firstTest.locator('.logline__detail')).toHaveCount(0)
    const write = conversation.locator('[data-work-tool-id="routine-write"]')
    await expect(write.locator('.logline__status')).toHaveText('未完成')
    await write.locator('button.logline').press('Enter')
    await expect(write.locator('.work-tool-outcome[role="note"]')).toContainText('文件只读（EACCES）')
    await expect(write.locator('.logline__detail > pre')).toHaveText('ROUTINE_WRITE_OUTPUT：原文件内容保持不变')
    expect(await copyToolDiagnostic(write, 'EACCES')).toContain('ROUTINE_WRITE_OUTPUT')
    const success = conversation.locator('[data-work-tool-id="routine-test-success"]')
    await success.locator('button.logline').press('Enter')
    await expect(success.locator('pre')).toContainText('全部 8 项测试通过')
    await expect(success.locator('.work-tool-outcome, .logline__status')).toHaveCount(0)
    await expect(conversation.locator('.work-error-notice, [role="alert"]')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('work-routine-failure-recovered.png'), animations: 'disabled' })
    await process.press('Space')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await expect(conversation.locator('.work-tool-outcome')).toHaveCount(0)
    await expect(conversation).toContainText('最后一轮的 8 项测试全部通过')
    expect(errors).toEqual([])
  })

  test('展开过程的操作栏随对话滚动置顶，思考按钮仍可用，收起后解除置顶', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 640))
    const closeWorkspace = work().getByRole('button', { name: '收起工作区', exact: true })
    if (await closeWorkspace.isVisible()) await closeWorkspace.click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_PROCESS_STICKY_CONTROLS')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    frame({ thinking: '逐项核对页面结构、交互和诊断记录。' })
    frame({ content: '先读取各项验收记录，再整理检查结果。' })
    for (let index = 0; index < 20; index++) {
      frame({ toolStart: { id: `sticky-read-${index}`, name: 'read_file', args: { path: `review/item-${index}.md` } } })
      frame({ toolEnd: { id: `sticky-read-${index}`, name: 'read_file', success: true, output: `第 ${index + 1} 项记录已读取。` } })
    }
    frame({ content: '已完成全部 20 项记录的检查。' }); finish()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const scroll = conversation.locator('.work-conversation__scroll')
    const message = conversation.locator('.work-message--assistant').last()
    const bar = message.locator('.work-message__process-bar')
    const process = bar.locator('.work-message__process-toggle')
    try {
      await expect(message).toContainText('已完成全部 20 项记录的检查')
      await expect(process).toHaveAttribute('aria-expanded', 'false')
      await expect(bar).not.toHaveAttribute('data-expanded', 'true')
      await expect.poll(() => bar.evaluate(element => getComputedStyle(element).position)).not.toBe('sticky')
      await process.press('Enter')
      await expect(bar).toHaveAttribute('data-expanded', 'true')
      await expect(message.locator('[data-work-tool-id^="sticky-read-"]')).toHaveCount(20)
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200)
      await expect.poll(() => bar.evaluate(element => getComputedStyle(element).position)).toBe('sticky')
      await bar.evaluate(element => {
        const viewport = element.closest('.work-conversation__scroll')!
        viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 110
      })
      const pinned = () => bar.evaluate(element => {
        const viewport = element.closest('.work-conversation__scroll')!, rect = element.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
        const top = Number.parseFloat(getComputedStyle(element).top) || 0
        return Math.abs(rect.top - bounds.top - top) <= 2 && rect.bottom < bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right + 1
      })
      await expect.poll(pinned).toBe(true)
      const firstScroll = await scroll.evaluate(element => element.scrollTop)
      await scroll.evaluate(element => { element.scrollTop += 70 })
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(firstScroll + 20)
      await expect.poll(pinned).toBe(true)
      await expectPointerTarget(process)
      const showThinking = bar.getByRole('button', { name: '显示思考', exact: true })
      await expectPointerTarget(showThinking)
      await showThinking.press('Space')
      await expect(message.locator('.work-message__thinking')).toContainText('逐项核对页面结构、交互和诊断记录')
      await expect(bar.getByRole('button', { name: '隐藏思考', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(pinned).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('work-process-controls-sticky.png'), animations: 'disabled' })
      await bar.getByRole('button', { name: '隐藏思考', exact: true }).press('Enter')
      await expect(message.locator('.work-message__thinking')).toHaveCount(0)
      await process.press('Space')
      await expect(process).toHaveAttribute('aria-expanded', 'false')
      await expect(bar).not.toHaveAttribute('data-expanded', 'true')
      await expect.poll(() => bar.evaluate(element => getComputedStyle(element).position)).not.toBe('sticky')
      await expect(message.locator('[data-work-tool-id^="sticky-read-"]')).toHaveCount(0)
      await expect(message).toContainText('已完成全部 20 项记录的检查')
      await expect(conversation.locator('.work-failure-navigator')).toHaveCount(0)
      expect(requests.length).toBe(before + 1)
      expect(errors).toEqual([])
    } finally {
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    }
  })

  test('Work 后台命令确认停止后淡出收起，停止中和停止失败保留，历史停止卡不闪现', async ({}, testInfo) => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_STOPPED_COMMAND_DISMISSAL')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    frame({ content: '后台命令已启动。' }); finish()
    const id = run!.sessionId, turnId = 'stopped-command-turn', createdAt = Date.now() - 5000
    const makeJob = (suffix: string, status: CommandJobSnapshot['status']): CommandJobSnapshot => ({
      schemaVersion: 1, jobId: `work-dismiss-${suffix}`, sessionId: id, ownerSessionId: id,
      toolCallId: `work-dismiss-tool-${suffix}`, turnId, version: 1, status, command: 'node', args: [`${suffix}.mjs`],
      cwd: '/remote/work-timeline', background: true, createdAt, updatedAt: createdAt,
      exitCode: status === 'failed' ? 7 : status === 'succeeded' ? 0 : null, signal: null, cursor: 1, earliestCursor: 0,
      ...(status === 'failed' ? { error: { code: 'COMMAND_EXIT_FAILED', message: '检查脚本未通过' } } : {}),
      ...(status === 'cancelled' ? { error: { code: 'COMMAND_CANCELLED', message: '已按用户请求停止' } } : {})
    })
    const stopping = makeJob('stop', 'running'), stopFailure = makeJob('stop-failure', 'running'), reduced = makeJob('reduced', 'running')
    const failed = makeJob('failed', 'failed'), interrupted = makeJob('interrupted', 'interrupted')
    const succeeded = makeJob('succeeded', 'succeeded'), historical = makeJob('historical', 'cancelled')
    const jobs = [stopping, stopFailure, reduced, failed, interrupted, succeeded, historical]
    for (const job of jobs) commandJobs.set(job.jobId, job)
    commandOutputs.set(failed.jobId, { stream: 'stderr', text: 'WORK_BACKGROUND_FAILURE: AssertionError: expected seven stones\n' })
    commandCancelFailures.add(stopFailure.jobId)
    seededHistories.set(id, [
      { id: 'stopped-command-user', role: 'user', content: 'WORK_STOPPED_COMMAND_DISMISSAL', conversationId: turnId, createdAt },
      ...jobs.flatMap((job, index): EngineHistoryRow[] => [
        { id: `${job.jobId}-start`, role: 'assistant', content: '', conversationId: turnId, createdAt: createdAt + index * 200 + 10,
          toolCall: { id: job.toolCallId, name: 'execute_cmd', args: { command: job.command, args: job.args } } },
        { id: `${job.jobId}-result`, role: 'tool', content: '后台命令回执', toolCallId: job.toolCallId, conversationId: turnId,
          createdAt: createdAt + index * 200 + 100, metadata: { commandJob: job } }
      ]),
      { id: 'stopped-command-answer', role: 'assistant', content: '后台命令仍可逐项管理。', conversationId: turnId, createdAt: createdAt + 2000 }
    ])
    seedFinalResult(id, turnId, [])
    seededUsage.set(id, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    const observedIds = [historical.jobId, stopping.jobId, reduced.jobId]
    // Start before React mounts: a final hidden-state assertion alone would
    // miss a stale running card flashing before the persisted receipt arrives.
    await page.addInitScript(ids => {
      const observed: string[] = []
      Object.assign(window, { workCancelledCardMounts: observed })
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          for (const id of ids) if (node.matches(`[data-job-id="${id}"]`) || node.querySelector(`[data-job-id="${id}"]`)) observed.push(id)
        }
      }).observe(document, { childList: true, subtree: true })
    }, observedIds)
    const mounts = () => page.evaluate(() => window.workCancelledCardMounts)
    const card = (job: CommandJobSnapshot) => page.locator(`[data-job-id="${job.jobId}"]`)
    const presence = (job: CommandJobSnapshot) => page.locator(`[data-command-presence="${job.jobId}"]`)
    const observeExit = (job: CommandJobSnapshot) => presence(job).evaluateHandle(element => {
      const probe = { removed: false, frames: [] as Array<{ state: string | null; height: number; opacity: number; inert: boolean; hidden: boolean }> }
      const sample = (): void => {
        if (!element.isConnected) { probe.removed = true; return }
        probe.frames.push({ state: element.getAttribute('data-motion-state'), height: element.getBoundingClientRect().height,
          opacity: Number(getComputedStyle(element).opacity), inert: element.hasAttribute('inert'), hidden: element.getAttribute('aria-hidden') === 'true' })
        requestAnimationFrame(sample)
      }
      sample()
      return probe
    })
    const confirmStopped = (job: CommandJobSnapshot): void => {
      const current = commandJobs.get(job.jobId)!
      commandJobs.set(job.jobId, { ...current, status: 'cancelled', version: current.version + 1, updatedAt: Date.now(), finishedAt: Date.now(),
        error: { code: 'COMMAND_CANCELLED', message: '已按用户请求停止' } })
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const servicePanel = page.getByRole('complementary', { name: '后台服务', exact: true })
    const openServices = async (): Promise<void> => {
      if (!await servicePanel.isVisible()) await work().getByRole('button', { name: '查看后台服务', exact: true }).click()
      await expect(servicePanel).toBeVisible()
    }
    const showHistory = async (): Promise<void> => {
      const toggle = servicePanel.getByRole('button', { name: /历史记录/ })
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    }
    try {
      await page.reload()
      await openServices()
      await expect(card(stopping)).toHaveAttribute('data-status', 'running')
      await expect(card(historical)).toHaveCount(0)
      expect((await mounts()).filter(jobId => jobId === historical.jobId)).toEqual([])
      await expect(presence(stopping)).toHaveAttribute('data-motion-state', 'open')
      await card(stopping).getByRole('button', { name: '停止命令', exact: true }).click()
      await expect(card(stopping)).toHaveAttribute('data-status', 'cancelling')
      await expect(card(stopping).getByRole('button', { name: '停止命令', exact: true })).toBeDisabled()
      await expect(presence(stopping)).toHaveAttribute('data-motion-state', 'open')
      expect(commandCancelRequests.filter(jobId => jobId === stopping.jobId)).toHaveLength(1)
      confirmStopped(stopping)
      await expect.poll(() => commandJobs.get(stopping.jobId)?.status).toBe('cancelled')
      await showHistory()
      await expect(card(stopping)).toHaveAttribute('data-status', 'cancelled')

      await card(stopFailure).getByRole('button', { name: '停止命令', exact: true }).click()
      await expect(card(stopFailure)).toHaveAttribute('data-status', 'running')
      await expect(card(stopFailure).getByRole('alert')).toContainText('停止失败')
      await expect(card(stopFailure).getByRole('button', { name: '停止命令', exact: true })).toBeEnabled()
      await showHistory()
      await expect(card(failed)).toHaveAttribute('data-status', 'failed')
      await card(failed).locator('.work-service-card__toggle').press('Enter')
      await expect(card(failed)).toContainText('退出码')
      await expect(card(failed).getByLabel('命令输出')).toContainText('WORK_BACKGROUND_FAILURE: AssertionError: expected seven stones')
      const diagnostic = await copyToolDiagnostic(card(failed), 'WORK_BACKGROUND_FAILURE')
      for (const evidence of ['node failed.mjs', '退出码：7', 'COMMAND_EXIT_FAILED', 'expected seven stones']) expect(diagnostic).toContain(evidence)
      await expect(card(interrupted)).toHaveAttribute('data-status', 'interrupted')
      await expect(card(succeeded)).toHaveAttribute('data-status', 'succeeded')
      await page.screenshot({ path: testInfo.outputPath('work-command-stopped-removed.png'), animations: 'disabled' })

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await card(reduced).getByRole('button', { name: '停止命令', exact: true }).click()
      await expect(card(reduced)).toHaveAttribute('data-status', 'cancelling')
      const reducedExit = await observeExit(reduced)
      confirmStopped(reduced)
      await expect.poll(() => reducedExit.evaluate(probe => probe.removed)).toBe(true)
      expect((await reducedExit.jsonValue()).frames.filter(frame => frame.state === 'closing')).toEqual([])
      await reducedExit.dispose()

      await page.reload()
      await expect(work()).toContainText('后台命令仍可逐项管理。')
      await openServices()
      await expect(card(stopFailure)).toHaveAttribute('data-status', 'running')
      for (const job of [historical, stopping, reduced]) await expect(card(job)).toHaveCount(0)
      expect(await mounts()).toEqual([])
      await showHistory()
      for (const job of [failed, interrupted, succeeded]) await expect(card(job)).toHaveAttribute('data-status', job.status)
      expect(commandJobs.get(stopping.jobId)?.status).toBe('cancelled')
      expect(commandJobs.get(reduced.jobId)?.status).toBe('cancelled')
      expect(errors).toEqual([])
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      commandCancelFailures.delete(stopFailure.jobId)
    }
  })

  test('长对话限制初始DOM，上滚继续接收回复及展开历史保持阅读锚点', async () => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    for (let index = 0; index < 32; index++) {
      const input = work().getByRole('textbox', { name: index === 0 ? '任务目标' : '继续对话', exact: true })
      await input.fill(`PERFORMANCE_HISTORY_INPUT_${index}`)
      const send = work().getByRole('button', { name: index === 0 ? '开始任务' : '发送', exact: true })
      await expect(send).toBeEnabled()
      const before = requests.length
      await send.click()
      await expect.poll(() => requests.length).toBe(before + 1)
      frame({ content: `# 轮次 ${index + 1}\n\nPERFORMANCE_HISTORY_REPLY_${index}\n\n本轮已完成，可继续查看历史内容。` }); finish()
      await expect(conversation.locator('.work-message--assistant').last()).toContainText(`PERFORMANCE_HISTORY_REPLY_${index}`)
      await expect(work().getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    }
    await expect(conversation.locator('.work-message')).toHaveCount(60)
    const scroll = conversation.locator('.work-conversation__scroll')
    // Use the same explicit upward gesture as the real reader, not a bare DOM
    // write that cannot carry wheel/scrollbar navigation intent.
    await scroll.hover({ position: { x: 400, y: 120 } })
    await page.mouse.wheel(0, -100_000)
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
    await expect(conversation.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    const anchor = await conversation.locator('.work-message').first().getAttribute('data-message-id')
    await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('PERFORMANCE_HISTORY_WHILE_READING')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => requests.at(-1)?.message).toBe('PERFORMANCE_HISTORY_WHILE_READING')
    frame({ content: 'READING_ANCHOR_MUST_SURVIVE' }); finish()
    await expect(conversation.locator('.work-message--assistant').last()).toContainText('READING_ANCHOR_MUST_SURVIVE')
    await expect(conversation.locator('.work-message').first()).toHaveAttribute('data-message-id', anchor!)
    expect(await scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
    const anchored = conversation.locator(`.work-message[data-message-id="${anchor}"]`)
    const beforeTop = await anchored.evaluate(element => element.getBoundingClientRect().top)
    await conversation.getByRole('button', { name: /^查看更早消息/ }).click()
    await expect(conversation.locator('.work-message')).toHaveCount(66)
    await expect(conversation.locator('.work-message').first()).toContainText('PERFORMANCE_HISTORY_INPUT_0')
    expect(Math.abs(await anchored.evaluate(element => element.getBoundingClientRect().top) - beforeTop)).toBeLessThanOrEqual(2)
    await conversation.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(conversation.locator('.work-message')).toHaveCount(60)
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
  })

  test('Work 截图可放大、计划实时更新、改动可展开，用量和回复复制使用真实数据', async ({}, testInfo) => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_RICH_RECEIPTS')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    await expect(conversation.getByRole('navigation', { name: '消息导航', exact: true })).toHaveCount(0)
    const screenshotDataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 360; canvas.height = 180
      const context = canvas.getContext('2d')!
      context.fillStyle = '#f3f5f8'; context.fillRect(0, 0, 360, 180)
      context.fillStyle = '#ffffff'; context.fillRect(12, 12, 336, 156)
      context.fillStyle = '#e1e7ed'; context.fillRect(12, 12, 336, 26)
      context.fillStyle = '#1f2937'; context.font = 'bold 17px sans-serif'; context.fillText('Work report preview', 28, 70)
      context.fillStyle = '#6b7280'; context.font = '12px sans-serif'; context.fillText('Screenshot, task plan and file changes', 28, 94)
      context.fillStyle = '#dbeafe'; context.fillRect(28, 116, 230, 12)
      context.fillStyle = '#93c5fd'; context.fillRect(28, 136, 168, 12)
      return canvas.toDataURL('image/png')
    })
    frame({ thinking: '先确认页面截图与任务计划，再交付可以查看的结果。' })
    frame({ toolStart: { id: 'rich-screenshot', name: 'browser_screenshot', args: { tabId: 'fixture-page' } } })
    frame({ toolEnd: { id: 'rich-screenshot', name: 'browser_screenshot', success: true, durationMs: 138,
      output: JSON.stringify({ name: 'Work 验收截图.png', width: 360, height: 180, dataUrl: screenshotDataUrl }) } })
    frame({ toolStart: { id: 'rich-document', name: 'create_document', args: { path: 'summary.xlsx' } } })
    frame({ toolEnd: { id: 'rich-document', name: 'create_document', success: true,
      output: JSON.stringify({ path: 'summary.xlsx', rows: 24, status: '已生成' }) } })
    const todos: EngineTodo[] = Array.from({ length: 6 }, (_, index) => ({
      id: `rich-step-${index}`, title: `计划步骤 ${index + 1}`, priority: 'medium',
      status: index === 0 ? 'done' : index === 1 ? 'in_progress' : 'pending'
    }))
    frame({ todo: { todos } })
    const plan = conversation.getByRole('region', { name: '任务清单', exact: true })
    await expect(plan.locator('[data-todo-id]')).toHaveCount(6)
    await expect(plan.locator('[data-todo-id="rich-step-1"]')).toHaveAttribute('data-status', 'in_progress')
    await expect(plan.locator('.work-progress-panel__todo-toggle')).toContainText('1 / 6 已完成')
    await expect(plan.locator('.work-progress-panel__todo-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(plan.getByLabel('当前步骤', { exact: true })).toContainText('计划步骤 2')
    await plan.locator('.work-progress-panel__todo-toggle').press('Enter')
    await expect(plan.locator('[data-todo-id="rich-step-5"]')).toBeVisible()
    for (let index = 0; index < 5; index++) {
      const toolId = `rich-write-${index}`
      frame({ toolStart: { id: toolId, name: 'write_file', args: { path: `reports/result-${index}.md` } } })
      frame({ fileChange: { id: `rich-change-${index}`, sessionId: run!.sessionId, turnId: run!.turnId, runId: run!.runId,
        toolCallId: toolId, path: `/remote/work-timeline/reports/result-${index}.md`, kind: 'write', oldContent: null,
        newContent: `RESULT_FILE_${index}`, isNew: true, truncated: false, status: 'pending', createdAt: Date.now() + index } })
      frame({ toolEnd: { id: toolId, name: 'write_file', output: '文件已写入', success: true } })
    }
    const changeSummary = conversation.getByRole('region', { name: '最终交付物', exact: true })
    await expect(changeSummary).toHaveCount(0)
    await expect(conversation.locator('.work-file-change-row')).toHaveCount(5)
    await expect(conversation.locator('.diff-card')).toHaveCount(0)
    for (const row of await conversation.locator('.work-file-change-row').all()) {
      await expect(row.locator('.work-file-change-row__added')).toHaveText('+1')
      await expect(row.locator('.work-file-change-row__removed')).toHaveText('-0')
    }
    await conversation.locator('.work-file-change-row[data-change-id="rich-change-2"]').press('Enter')
    const allChanges = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    await expect(allChanges).toBeVisible()
    for (let index = 0; index < 5; index++) await expect(allChanges).toContainText(`result-${index}.md`)
    const review = allChanges.getByRole('group', { name: '待确认改动操作', exact: true })
    await expect(review.getByRole('button', { name: '批量改动操作', exact: true })).toBeDisabled()
    frame({ todo: { todos: todos.map((todo, index) => ({ ...todo, status: index === 5 ? 'cancelled' : 'done' })) } })
    await expect(plan.locator('.work-progress-panel__todo-toggle')).toContainText('5 / 6 已完成')
    await expect(plan).toContainText('5 / 6 已完成 · 1 已取消')
    await expect(plan.locator('[data-todo-id="rich-step-5"]')).toHaveAttribute('data-status', 'cancelled')
    frame({ usage: { usageScope: 'turn', modelId, promptTokens: 1_000, completionTokens: 250, totalTokens: 1_250, currentPromptTokens: 1_000, contextWindow: 200_000 } })
    frame({ content: 'WORK_RICH_REPLY：截图已经生成，可以直接查看。' })
    finish(finalResult(run!, 'WORK_RICH_REPLY：截图已经生成，可以直接查看。', [
      { id: 'rich-delivered-report', path: '/remote/work-timeline/reports/result-2.md', content: 'RESULT_FILE_2' }
    ]))
    await expect(changeSummary.locator('[data-final-result-item]')).toHaveCount(1)
    await expect(changeSummary).toContainText('result-2.md')
    await expect(changeSummary).not.toContainText('result-1.md')
    await expect(plan).toHaveCount(1)
    await expect(conversation.locator('.work-conversation-turn').last().getByRole('region', { name: '任务清单', exact: true })).toHaveCount(1)
    await expect(plan.locator('.work-progress-panel__todo-toggle')).toContainText('5 / 6 已完成 · 1 已取消')
    await expect(review.getByRole('button', { name: '批量改动操作', exact: true })).toBeEnabled()
    const message = conversation.locator('.work-message--assistant').last()
    const process = message.locator('.work-message__process-toggle')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await expect(process).toContainText('7 步')
    await expect(process).not.toContainText('思考')
    await expect(message.locator('.work-file-change-row')).toHaveCount(0)
    await expect(message.locator('.diff-card')).toHaveCount(0)
    const shot = message.getByRole('button', { name: '放大查看 Work 验收截图.png', exact: true })
    const screenshotTool = message.locator('[data-work-tool-id="rich-screenshot"]')
    await expect(screenshotTool).toHaveCount(0)
    await expect(shot).toBeHidden()
    await process.click()
    await expect(screenshotTool.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await screenshotTool.locator('button.logline').click()
    await expect(shot).toBeVisible()
    await expect.poll(() => shot.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(360)
    await expect(message).not.toContainText('iVBORw0KGgo')
    await shot.click()
    const enlarged = page.getByRole('dialog', { name: 'Work 验收截图.png', exact: true })
    await expect(enlarged).toBeVisible()
    await expect.poll(() => enlarged.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(360)
    await page.keyboard.press('Escape')
    await expect(enlarged).toHaveCount(0)
    await screenshotTool.locator('button.logline').click()
    await expect(screenshotTool.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(shot).toBeHidden()
    await screenshotTool.locator('button.logline').click()
    await expect(shot).toBeVisible()
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    await expect(message.locator('.work-message__thinking')).toHaveCount(0)
    const thinkingToggle = message.getByRole('button', { name: '显示思考', exact: true })
    await expect(thinkingToggle).toHaveAttribute('aria-pressed', 'false')
    await thinkingToggle.press('Space')
    await expect(message).toContainText('先确认页面截图与任务计划')
    await expect(message.getByRole('button', { name: '隐藏思考', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await message.getByRole('button', { name: '隐藏思考', exact: true }).press('Enter')
    await expect(message.locator('.work-message__thinking')).toHaveCount(0)
    await expect(message.locator('.work-process')).toHaveCount(0)
    await expect(message.locator('.work-file-change-row')).toHaveCount(5)
    await expect(message.locator('.diff-card')).toHaveCount(0)
    const documentResult = message.locator('[data-tool-id="rich-document"]')
    await documentResult.locator('button.logline .logline__name').click()
    await expect(documentResult.locator('.tool-result-data__fields')).toContainText('路径')
    await expect(documentResult.locator('.tool-result-data__fields')).toContainText('行24')
    await expect(documentResult.locator('.tool-result-data__fields')).toContainText('状态已生成')
    const documentData = documentResult.locator('.tool-result-data')
    await expect(documentData.locator('details, pre')).toHaveCount(0)
    await expectNoWorkRawData(documentResult)
    const fileTool = message.locator('[data-work-tool-id="rich-write-2"]')
    await expect(fileTool).toContainText('result-2.md')
    await expectNoWorkRawData(message)
    await fileTool.locator('.work-file-change-row').press('Enter')
    await expect(work().getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true')
    const artifacts = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    await expect(artifacts).toHaveAttribute('data-session-id', run!.sessionId)
    const artifactTree = artifacts.getByRole('tree', { name: '本会话文件树', exact: true })
    await expect(artifactTree.getByRole('treeitem').filter({ hasText: /^reports$/ })).toBeVisible()
    await expect(artifactTree.locator('[data-path$="/result-2.md"]')).toHaveAttribute('aria-selected', 'true')
    const selectedDiff = artifacts.locator('.work-session-artifacts__diff')
    await expect(selectedDiff).toHaveAttribute('data-change-id', 'rich-change-2')
    await expect(selectedDiff).toHaveAttribute('data-diff-scope', 'operation')
    await expect(selectedDiff).toContainText('RESULT_FILE_2')
    await expect(selectedDiff).not.toContainText('RESULT_FILE_1')
    await expect(message.locator('.diff-card')).toHaveCount(0)
    await process.click()
    await expect(shot).toBeHidden()
    await expect(screenshotTool).toHaveCount(0)

    await expect(work().locator('.usage-meter__tokens')).toHaveText('1.3k')
    await work().locator('.usage-meter__trigger').click()
    const total = page.getByRole('dialog', { name: '会话用量明细', exact: true })
    await expect(total).toContainText('输入')
    await expect(total).toContainText('输出')
    await expect(total).toContainText('250')
    await page.keyboard.press('Escape')
    await conversation.locator('.turn-usage__trigger').last().click()
    const turn = page.getByRole('dialog', { name: '本次问答用量', exact: true })
    await expect(turn).toContainText(modelId)
    await expect(turn).toContainText('对话时间')
    await page.keyboard.press('Escape')
    await message.getByRole('button', { name: '复制回复', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('WORK_RICH_REPLY：截图已经生成，可以直接查看。')
    await process.click()
    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      for (const width of [940, 1440]) {
        await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1000), width)
        if (width === 940) await work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true }).click()
        await conversation.locator('.work-conversation__scroll').evaluate(element => { element.scrollTop = 0 })
        await expect(plan).toHaveCount(1)
        await expect(plan.locator('.work-progress-panel__todo-toggle')).toContainText('5 / 6 已完成 · 1 已取消')
        await expect(changeSummary).toBeVisible()
        await expect(shot).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath(`work-rich-receipts-${appearance}-${width}.png`), animations: 'disabled' })
        await changeSummary.scrollIntoViewIfNeeded()
        await page.screenshot({ path: testInfo.outputPath(`work-progress-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await setWorkAppearance('dark')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })

  test('220 条历史可通过导航跨越挂载窗口，首尾与相邻跳转不改变累计用量', async ({}, testInfo) => {
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_NAVIGATION_ARCHIVE')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    frame({ content: '准备读取历史导航验收数据。' }); finish()
    const id = run!.sessionId
    const createdAt = Date.now() - 220_000
    seededHistories.set(id, Array.from({ length: 110 }, (_, index): EngineHistoryRow[] => [
      { id: `nav-user-${index}`, role: 'user', content: `NAV_REQUEST_${index}`, conversationId: `nav-turn-${index}`, createdAt: createdAt + index * 2_000 },
      { id: `nav-assistant-${index}`, role: 'assistant', conversationId: `nav-turn-${index}`, modelId, createdAt: createdAt + index * 2_000 + 1_000,
        content: `# NAV_REPLY_${index}\n\n第一段：保留这一轮的阅读位置。\n\n第二段：导航应定位实际用户提问。\n\n第三段：切换窗口后依然可以查看完整答复。\n\n第四段：累计用量包括当前未挂载的历史。`,
        usage: { promptTokens: 1_000, completionTokens: 10, totalTokens: 1_010 } }
    ]).flat())
    for (let index = 0; index < 110; index++) seedFinalResult(id, `nav-turn-${index}`, [])
    commandJobs.set('nav-child-command', {
      schemaVersion: 1, jobId: 'nav-child-command', sessionId: id, ownerSessionId: 'nav-child-session',
      ownerRunId: 'nav-child-run', turnId: 'nav-turn-109', version: 1, status: 'succeeded',
      command: 'node', args: ['verify-result.js'], cwd: '/remote/work-timeline', background: true,
      createdAt, updatedAt: createdAt + 1_000, finishedAt: createdAt + 1_000,
      exitCode: 0, signal: null, cursor: 1, earliestCursor: 0
    })
    await page.reload()
    await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText('NAV_REPLY_109')
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const navigation = conversation.getByRole('navigation', { name: '消息导航', exact: true })
    const content = conversation.locator('.work-conversation__content')
    await expect(navigation.locator('.chat__nav-dot')).toHaveCount(110)
    await expect(conversation.locator('.work-message')).toHaveCount(60)
    await expect(work().locator('.usage-meter__tokens')).toHaveText('111.1k')
    await work().getByRole('button', { name: '查看后台服务', exact: true }).click()
    const childCommands = page.getByRole('complementary', { name: '后台服务', exact: true })
    await childCommands.getByRole('button', { name: /历史记录/ }).click()
    await expect(childCommands).toContainText('node verify-result.js')
    const childCommand = childCommands.locator('[data-job-id="nav-child-command"]')
    await expect(childCommand).toHaveAttribute('data-status', 'succeeded')
    await childCommand.locator('.work-service-card__toggle').click()
    await expect(childCommand).toContainText('nav-child-run')
    await expect(childCommand.getByLabel('命令输出', { exact: true })).toContainText('CHILD_BACKGROUND_COMMAND_COMPLETE')
    await childCommand.locator('.work-service-card__toggle').click()
    await childCommands.getByRole('button', { name: '关闭后台服务', exact: true }).click()

    const trigger = navigation.getByRole('button', { name: '展开消息导航', exact: true })
    const panel = navigation.locator('.chat__nav-list')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => trigger.evaluate(element => {
      const body = element.closest('.work-conversation__body')!.getBoundingClientRect()
      const button = element.getBoundingClientRect()
      return Math.abs(button.y + button.height / 2 - body.y - body.height / 2)
    })).toBeLessThanOrEqual(2)
    await trigger.hover()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    await trigger.focus()
    await trigger.press('Home')
    await expect(navigation.getByRole('button', { name: '跳转到：NAV_REQUEST_0', exact: true })).toBeFocused()
    await page.keyboard.press('End')
    await expect(navigation.getByRole('button', { name: '跳转到：NAV_REQUEST_109', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(navigation.getByRole('button', { name: '跳转到：NAV_REQUEST_108', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden()
    await trigger.click()
    await navigation.getByRole('button', { name: '跳转到：NAV_REQUEST_0', exact: true }).click()
    await expect(content).toHaveAttribute('data-history-start', '0')
    await expect(conversation.locator('.work-message')).toHaveCount(180)
    const first = conversation.locator('[data-message-id="nav-user-0"]')
    await expect(first).toBeInViewport()
    await navigation.getByRole('button', { name: '跳转到：NAV_REQUEST_0', exact: true }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '删除本轮', exact: true })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '复制', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('NAV_REQUEST_0')
    await trigger.click()
    await navigation.getByRole('button', { name: '跳转到：NAV_REQUEST_100', exact: true }).click()
    await expect(content).toHaveAttribute('data-history-start', '160')
    await expect(conversation.locator('[data-message-id="nav-user-100"]')).toBeInViewport()
    await expect(navigation.locator('.chat__nav-dot[aria-current="true"]')).toHaveAttribute('title', 'NAV_REQUEST_100')
    await navigation.getByRole('button', { name: '上一条', exact: true }).click()
    await expect(conversation.locator('[data-message-id="nav-user-99"]')).toBeInViewport()
    await expect(navigation.locator('.chat__nav-dot[aria-current="true"]')).toHaveAttribute('title', 'NAV_REQUEST_99')
    await navigation.getByRole('button', { name: '下一条', exact: true }).click()
    await expect(conversation.locator('[data-message-id="nav-user-100"]')).toBeInViewport()
    await navigation.getByRole('button', { name: '回到顶部', exact: true }).click()
    await expect(content).toHaveAttribute('data-history-start', '0')
    await expect(first).toBeInViewport()
    await navigation.getByRole('button', { name: '回到底部', exact: true }).click()
    await expect(content).toHaveAttribute('data-history-start', '160')
    await expect(conversation.locator('[data-message-id="nav-assistant-109"]')).toBeInViewport()
    await expect(conversation.locator('.work-message')).toHaveCount(60)
    await expect(work().locator('.usage-meter__tokens')).toHaveText('111.1k')
    await page.screenshot({ path: testInfo.outputPath('work-navigation-220-messages.png'), animations: 'disabled' })
    await trigger.press('Escape')
    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      for (const width of [1440, 680]) {
        await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
        const mobileConversation = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
        if (await mobileConversation.isVisible()) await mobileConversation.click()
        await trigger.hover()
        await expect(trigger).toHaveAttribute('aria-expanded', 'true')
        await expect.poll(() => panel.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        })).toBe(true)
        await expect.poll(() => navigation.locator('.chat__nav-entries').evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
        await page.screenshot({ path: testInfo.outputPath(`work-radar-navigation-${appearance}-${width}-open.png`), animations: 'disabled' })
        await page.mouse.move(2, 2)
        await expect(trigger).toHaveAttribute('aria-expanded', 'false')
        await expect(panel).toBeHidden()
        await page.screenshot({ path: testInfo.outputPath(`work-radar-navigation-${appearance}-${width}-closed.png`), animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await trigger.hover()
    await expect(panel).toBeVisible()
    expect(await panel.evaluate(element => getComputedStyle(element).transitionDuration.split(',').every(value => Number.parseFloat(value) === 0))).toBe(true)
    await page.mouse.move(2, 2)
    await expect(panel).toBeHidden()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await setWorkAppearance('dark')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })

  test('Code 共享组件回归：历史用量、思考、导航与图片保持可用，JSON 保留原文展示', async ({}, testInfo) => {
    const id = 'code-shared-components', createdAt = Date.now() - 10_000
    const imageDataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16
      const context = canvas.getContext('2d')!; context.fillStyle = '#4f8ff7'; context.fillRect(0, 0, 24, 16)
      return canvas.toDataURL('image/png')
    })
    seededHistories.set(id, [
      { id: 'code-user-0', role: 'user', content: 'CODE_SHARED_FIRST', conversationId: 'code-turn-0', createdAt },
      { id: 'code-assistant-0', role: 'assistant', content: '', reasoningContent: 'CODE_SHARED_THINKING：核对共享工具卡片。',
        toolCall: { id: 'code-screen', name: 'browser_screenshot', args: { tabId: 'code-page' } }, conversationId: 'code-turn-0', createdAt: createdAt + 100 },
      { id: 'code-tool-0', role: 'tool', toolCallId: 'code-screen', content: JSON.stringify({ name: 'Code 共享截图.png', dataUrl: imageDataUrl }), conversationId: 'code-turn-0', createdAt: createdAt + 200, success: true },
      { id: 'code-answer-0', role: 'assistant', content: 'CODE_SHARED_FIRST_REPLY', conversationId: 'code-turn-0', createdAt: createdAt + 300, modelId,
        usage: { promptTokens: 1000, completionTokens: 250, totalTokens: 1250, currentPromptTokens: 1000, contextWindow: 200000 } },
      { id: 'code-user-1', role: 'user', content: 'CODE_SHARED_SECOND', conversationId: 'code-turn-1', createdAt: createdAt + 1000 },
      { id: 'code-assistant-1', role: 'assistant', content: '', toolCall: { id: 'code-json', name: 'create_document', args: { path: 'code.json' } }, conversationId: 'code-turn-1', createdAt: createdAt + 1100 },
      { id: 'code-tool-1', role: 'tool', toolCallId: 'code-json', content: '{"path":"code.json","rows":3,"status":"ok"}', conversationId: 'code-turn-1', createdAt: createdAt + 1200, success: true },
      { id: 'code-answer-1', role: 'assistant', content: 'CODE_SHARED_SECOND_REPLY', conversationId: 'code-turn-1', createdAt: createdAt + 1300, modelId,
        usage: { promptTokens: 1000, completionTokens: 250, totalTokens: 1250, currentPromptTokens: 1000, contextWindow: 200000 } }
    ])
    seededUsage.set(id, { promptTokens: 2000, completionTokens: 500, totalTokens: 2500 })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const key = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl: `http://127.0.0.1:${address.port}` }))
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key, id })
    await page.reload()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    const code = page.locator('.mode-surface[data-mode="code"]')
    await expect(code.locator('.message--user')).toContainText(['CODE_SHARED_FIRST', 'CODE_SHARED_SECOND'])
    await expect(code.locator('.usage-meter__tokens')).toHaveText('2.5k')
    await code.locator('.usage-meter__trigger').click()
    await expect(page.getByRole('dialog', { name: '会话用量明细' })).toContainText('500')
    await page.keyboard.press('Escape')
    await expect(code.locator('.turn-usage__value')).toHaveText(['1.3k', '1.3k'])
    await code.locator('.turn-usage__trigger').last().click()
    await expect(page.getByRole('dialog', { name: '本次问答用量' })).toContainText(modelId)
    await page.keyboard.press('Escape')
    const navigation = code.getByRole('navigation', { name: '消息导航', exact: true })
    await expect(navigation.getByRole('button', { name: /^跳转到：/ })).toHaveCount(2)
    await expect(navigation).toHaveAttribute('data-variant', 'waves')
    const firstTurn = navigation.getByRole('button', { name: '跳转到：CODE_SHARED_FIRST', exact: true })
    await firstTurn.hover()
    const preview = navigation.getByRole('tooltip')
    await expect(preview).toContainText('CODE_SHARED_FIRST')
    // A translated Code pane must not reinterpret viewport coordinates and
    // push the short-conversation preview outside the readable chat column.
    await expect.poll(() => preview.evaluate(panel => {
      const bounds = panel.getBoundingClientRect()
      const pane = panel.closest('.workbench__chat')!.getBoundingClientRect()
      return bounds.left >= pane.left && bounds.right <= pane.right + 1 &&
        bounds.top >= pane.top && bounds.bottom <= pane.bottom + 1
    })).toBe(true)
    await firstTurn.click()
    await expect(code.locator('.message--user').first()).toBeInViewport()
    for (const summary of await code.locator('.process__summary').all()) {
      if (await summary.getAttribute('aria-expanded') === 'false') await summary.click()
    }
    const thinking = code.getByRole('button', { name: 'CODE_SHARED_THINKING：核对共享工具卡片。', exact: true })
    await thinking.click()
    await expect(code.locator('.logline__detail--thinking')).toHaveText('CODE_SHARED_THINKING：核对共享工具卡片。')
    const screenshot = code.getByRole('button', { name: '放大查看 Code 共享截图.png', exact: true })
    await expect(screenshot).toBeVisible()
    await screenshot.click()
    const image = page.getByRole('dialog', { name: 'Code 共享截图.png', exact: true })
    await expect.poll(() => image.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(24)
    await page.keyboard.press('Escape')
    const json = code.locator('[data-tool-id="code-json"]')
    await json.locator('.logline__name').click()
    await expect(json.locator('pre')).toHaveText('{"path":"code.json","rows":3,"status":"ok"}')
    await expect(json.locator('.tool-result-data')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('code-shared-components.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })

  test('窄窗隐藏对话停止命令输出轮询，切回恢复且未打开的过程文件不后台轮询', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_CONVERSATION_VISIBILITY')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    frame({ content: '准备验证对话可见性与后台读取。' }); finish()
    await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText('准备验证对话可见性与后台读取。')
    const id = run!.sessionId, createdAt = Date.now() - 5_000, turnId = 'visibility-turn'
    const inlineJob: CommandJobSnapshot = {
      schemaVersion: 1, jobId: 'visibility-inline-command', sessionId: id, ownerSessionId: id,
      toolCallId: 'visibility-tool', turnId, version: 1, status: 'running', command: 'node', args: ['watch-inline.js'],
      cwd: '/remote/work-timeline', background: true, createdAt, updatedAt: createdAt, exitCode: null, signal: null, cursor: 1, earliestCursor: 0
    }
    const childJob: CommandJobSnapshot = {
      ...inlineJob, jobId: 'visibility-child-command', ownerSessionId: 'visibility-child-session',
      ownerRunId: 'visibility-child-run', toolCallId: 'visibility-child-tool', args: ['watch-child.js']
    }
    commandJobs.set(inlineJob.jobId, inlineJob)
    commandJobs.set(childJob.jobId, childJob)
    seededHistories.set(id, [
      { id: 'visibility-user', role: 'user', content: 'WORK_CONVERSATION_VISIBILITY', conversationId: turnId, createdAt },
      { id: 'visibility-tool-start', role: 'assistant', content: '', conversationId: turnId, createdAt: createdAt + 100,
        toolCall: { id: 'visibility-tool', name: 'execute_cmd', args: { command: 'node watch-inline.js' } } },
      { id: 'visibility-tool-result', role: 'tool', content: '命令已在后台运行', toolCallId: 'visibility-tool', conversationId: turnId,
        createdAt: createdAt + 200, metadata: { commandJob: inlineJob } },
      { id: 'visibility-answer', role: 'assistant', content: '后台命令仍在运行，页面可继续查看。', conversationId: turnId, createdAt: createdAt + 300 }
    ])
    seedFinalResult(id, turnId, [])
    seededUsage.set(id, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    changesBySession.set(id, [{ id: 'visibility-change', sessionId: id, turnId, path: '/remote/work-timeline/visibility.md',
      kind: 'write', oldContent: null, newContent: '待确认内容', isNew: true, truncated: false, status: 'pending', createdAt }])
    await page.reload()
    const conversation = work().locator('.work-conversation')
    await conversation.getByRole('button', { name: '查看后台服务', exact: true }).click()
    const services = page.getByRole('complementary', { name: '后台服务', exact: true })
    await expect(services.locator(`[data-job-id="${inlineJob.jobId}"]`)).toHaveAttribute('data-status', 'running')
    await expect(services.locator(`[data-job-id="${childJob.jobId}"]`)).toHaveAttribute('data-status', 'running')
    await expect(conversation.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
    await expect(conversation.getByRole('region', { name: '本轮成果摘要', exact: true })).toHaveCount(0)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '资料', exact: true }).click()
    await expect(conversation).toBeVisible()
    await expect(work().getByRole('tabpanel', { name: '资料', exact: true })).toBeVisible()
    // Service details now live in an anchored popover; outside navigation
    // dismisses it. Reopen explicitly before observing visible-service polling.
    await expect(services).not.toBeVisible()
    await conversation.getByRole('button', { name: '查看后台服务', exact: true }).click()
    // An explicit empty FinalResult suppresses legacy file cards and polling;
    // the Sources pane itself has no change inspector that would fetch edits.
    const counts = () => ({
      inline: commandOutputReads.get(inlineJob.jobId) ?? 0,
      child: commandOutputReads.get(childJob.jobId) ?? 0,
      changes: progressChangeReads.get(id) ?? 0
    })
    const continued = (previous: ReturnType<typeof counts>) => {
      const next = counts()
      return { inline: next.inline > previous.inline, child: next.child > previous.child, changes: next.changes > previous.changes }
    }
    const wide = counts()
    await expect.poll(() => continued(wide), { timeout: 10_000, message: '可见命令继续读取，未打开的过程文件没有后台轮询' })
      .toEqual({ inline: true, child: true, changes: false })
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 900))
    await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ }).click()
    await expect(conversation).toBeHidden()
    await expect(work().getByRole('tabpanel', { name: '资料', exact: true })).toBeVisible()
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const hidden = counts(), hiddenAt = Date.now()
    // This bounded observation proves absence across both the 1s command and
    // 4s changes intervals; it is not a fixed delay used to guess readiness.
    await expect.poll(() => {
      expect(counts()).toEqual(hidden)
      return Date.now() - hiddenAt
    }, { timeout: 6_500, intervals: [250, 500], message: '对话隐藏后，跨过完整轮询周期也不得发出新的 UI 请求' }).toBeGreaterThanOrEqual(4_500)
    await work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true }).click()
    await expect(conversation).toBeVisible()
    await conversation.getByRole('button', { name: '查看后台服务', exact: true }).click()
    await expect.poll(() => continued(hidden), { timeout: 10_000, message: '切回窄窗对话应只恢复两种命令输出读取' })
      .toEqual({ inline: true, child: true, changes: false })
    await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ }).click()
    await expect(conversation).toBeHidden()
    const beforeWide = counts()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(conversation).toBeVisible()
    await expect(work().getByRole('tabpanel', { name: '资料', exact: true })).toBeVisible()
    await conversation.getByRole('button', { name: '查看后台服务', exact: true }).click()
    await expect.poll(() => continued(beforeWide), { timeout: 10_000, message: '恢复宽窗双栏后，工作区仍被选中也不应暂停可见对话的读取' })
      .toEqual({ inline: true, child: true, changes: false })
    await page.getByRole('button', { name: '关闭后台服务', exact: true }).click()
    expect(errors).toEqual([])
  })

  test('无工具收据的连续回合实时同步成果，显式交付回合的待确认改动不延续旧回合轮询', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_LEGACY_LIVE_LEDGER')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    const id = run!.sessionId
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const reads = () => progressChangeReads.get(id) ?? 0
    const expectQuietLedger = async (message: string): Promise<void> => {
      let previous = reads(), quietSince = Date.now()
      // Observe a complete 4s poll interval. Any scheduled request restarts the
      // window, so this proves quiescence instead of guessing UI readiness.
      await expect.poll(() => {
        const next = reads()
        if (next !== previous) { previous = next; quietSince = Date.now() }
        return Date.now() - quietSince
      }, { timeout: 8_000, intervals: [250, 500], message }).toBeGreaterThanOrEqual(4_500)
    }
    const first: EngineFileChange = {
      id: 'legacy-live-first', sessionId: id, turnId: run!.turnId, runId: run!.runId,
      path: '/remote/work-timeline/legacy-first.md', kind: 'write', oldContent: null,
      newContent: 'FIRST_KEPT_RESULT', isNew: true, truncated: false, status: 'kept', createdAt: Date.now()
    }
    changesBySession.set(id, [first])
    frame({ content: 'LEGACY_FIRST_COMPLETE' }); finish(null)
    const firstTurn = conversation.locator('.work-conversation-turn').filter({ hasText: 'LEGACY_FIRST_COMPLETE' })
    const firstResults = firstTurn.getByRole('region', { name: '本轮成果摘要', exact: true })
    await expect(firstResults).toBeVisible()
    await firstResults.getByRole('button', { name: /^成果\s*1 个文件$/ }).click()
    await expect(firstResults.locator(`[data-change-id="${first.id}"]`)).toContainText('已保留')
    await expect(firstTurn.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
    await expectQuietLedger('首轮没有待确认记录，完成后应停止读取成果账本')

    const firstReads = reads()
    await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('WORK_LEGACY_SECOND_LEDGER')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 2)
    frame({ content: 'LEGACY_SECOND_COMPLETE' })
    const secondTurn = conversation.locator('.work-conversation-turn').filter({ hasText: 'LEGACY_SECOND_COMPLETE' })
    await expect(secondTurn).toBeVisible()
    await expect.poll(reads, { message: '新回合没有工具收据，也应刷新其成果范围' }).toBeGreaterThan(firstReads)
    await expectQuietLedger('第二轮尚未写入文件，等待完成期间不应依赖轮询发现成果')
    const second: EngineFileChange = {
      ...first, id: 'legacy-live-second', turnId: run!.turnId, runId: run!.runId,
      path: '/remote/work-timeline/legacy-second.md', newContent: 'SECOND_PENDING_RESULT', status: 'pending', createdAt: Date.now()
    }
    // No tool receipt or fileChange frame is sent: only durable storage learns
    // about this write, after the new turn's initial ledger request has settled.
    changesBySession.set(id, [first, second])
    finish(null)
    const secondResults = secondTurn.getByRole('region', { name: '本轮成果摘要', exact: true })
    await expect(secondResults).toBeVisible()
    await secondResults.getByRole('button', { name: /^成果\s*1 个文件$/ }).click()
    await expect(secondResults.locator(`[data-change-id="${second.id}"]`)).toBeVisible()
    await expect(secondResults).toContainText('1 个待确认')
    await expect(secondResults.locator(`[data-change-id="${first.id}"]`)).toHaveCount(0)
    await expect(firstResults.locator(`[data-change-id="${second.id}"]`)).toHaveCount(0)
    await expect(conversation.locator('.work-file-change-row')).toHaveCount(0)
    await expect(conversation.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)

    await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('WORK_EXPLICIT_EMPTY_RESULT')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 3)
    const publishedOnly: EngineFileChange = {
      ...second, id: 'explicit-result-pending', turnId: run!.turnId, runId: run!.runId,
      path: '/remote/work-timeline/process-only.md', newContent: 'PROCESS_ONLY_PENDING', createdAt: Date.now()
    }
    changesBySession.set(id, [first, { ...second, status: 'kept' }, publishedOnly])
    frame({ content: 'EXPLICIT_EMPTY_COMPLETE' }); finish()
    const publishedTurn = conversation.locator('.work-conversation-turn').filter({ hasText: 'EXPLICIT_EMPTY_COMPLETE' })
    await expect(publishedTurn).toBeVisible()
    await expect(secondResults.locator(`[data-change-id="${second.id}"]`)).toContainText('已保留')
    await expect(publishedTurn.getByRole('region', { name: '本轮成果摘要', exact: true })).toHaveCount(0)
    await expect(publishedTurn.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
    await expectQuietLedger('只有显式交付回合仍有待确认改动时，不应让旧回合继续读取成果账本')
    await expect(conversation.locator(`[data-change-id="${publishedOnly.id}"]`)).toHaveCount(0)
    expect(changesBySession.get(id)?.filter(change => change.status === 'pending').map(change => change.id)).toEqual([publishedOnly.id])
    expect(errors).toEqual([])
  })

  test('成果按用户轮次与时间筛选整棵树，搜索包含折叠目录，重复路径的版本和批量操作隔离会话', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const startTask = async (title: string): Promise<string> => {
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(title)
      const before = requests.length
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => requests.length).toBe(before + 1)
      frame({ content: `READY_${title}` }); finish()
      await expect(conversation).toContainText(`READY_${title}`)
      return run!.sessionId
    }
    const baseTime = new Date('2026-10-20T01:00:00.000Z').getTime()
    const sharedPath = '/remote/work-timeline/reports/shared.md'
    const createChange = (sessionId: string, turnId: string, id: string, path: string, oldContent: string | null, newContent: string, seq: number, createdAt: number): EngineFileChange => ({
      id, sessionId, turnId, toolCallId: `tool-${id}`, path, kind: 'write', oldContent, newContent,
      isNew: oldContent === null, truncated: false, status: 'pending', seq, createdAt
    })
    const turnHistory = (turnId: string, request: string, createdAt: number, changes: EngineFileChange[]): EngineHistoryRow[] => [
      { id: `${turnId}-user`, role: 'user', content: request, conversationId: turnId, createdAt },
      ...changes.flatMap((change, index): EngineHistoryRow[] => [
        { id: `${change.id}-start`, role: 'assistant', content: '', conversationId: turnId, createdAt: createdAt + 100 + index * 200,
          toolCall: { id: change.toolCallId, name: 'write_file', args: { path: change.path, content: change.newContent } } },
        { id: `${change.id}-result`, role: 'tool', toolCallId: change.toolCallId, content: '文件已写入', success: true,
          conversationId: turnId, createdAt: createdAt + 200 + index * 200, metadata: { change } }
      ]),
      { id: `${turnId}-answer`, role: 'assistant', content: `${turnId}_DONE`, conversationId: turnId, createdAt: createdAt + 1_000 }
    ]
    const sessionA = await startTask('WORK_ARTIFACT_SCOPE_A')
    const aFirst = [
      createChange(sessionA, 'artifact-a-first', 'a-shared-v1', sharedPath, null, 'SESSION_A_VERSION_ONE', 1, baseTime + 200),
      createChange(sessionA, 'artifact-a-first', 'a-only-alpha', '/remote/work-timeline/reports/only-alpha.md', null, 'SESSION_A_ALPHA', 2, baseTime + 400)
    ]
    const aSecond = [
      createChange(sessionA, 'artifact-a-second', 'a-shared-v2', sharedPath, 'SESSION_A_VERSION_ONE', 'SESSION_A_VERSION_TWO', 3, baseTime + 3_600_200),
      createChange(sessionA, 'artifact-a-second', 'a-only-beta', '/remote/work-timeline/archive/only-beta.md', null, 'SESSION_A_BETA', 4, baseTime + 3_600_400)
    ]
    seededHistories.set(sessionA, [
      ...turnHistory('artifact-a-first', '先创建共享报告和 Alpha 附件', baseTime, aFirst),
      ...turnHistory('artifact-a-second', '更新共享报告并新增 Beta 附件', baseTime + 3_600_000, aSecond)
    ])
    changesBySession.set(sessionA, [...aFirst, ...aSecond])
    // This server net row legitimately spans two turns. A turn filter must use
    // its source operation IDs instead of inheriting the last write's turnId.
    netChangesBySession.set(sessionA, [
      { ...aSecond[0], id: 'a-shared-net', oldContent: null, isNew: true, changeIds: ['a-shared-v1', 'a-shared-v2'] },
      aFirst[1], aSecond[1]
    ])
    const sessionB = await startTask('WORK_ARTIFACT_SCOPE_B')
    const bChanges = [createChange(sessionB, 'artifact-b-only', 'b-shared-v1', sharedPath, null, 'SESSION_B_INDEPENDENT_VERSION', 1, baseTime + 7_200_200)]
    seededHistories.set(sessionB, turnHistory('artifact-b-only', '为另一个任务生成同路径报告', baseTime + 7_200_000, bChanges))
    const deliveryFiles = (changes: EngineFileChange[]): DeliveryFile[] => changes.map(change => ({ id: change.id, path: change.path, content: change.newContent! }))
    const aFirstDelivery = seedFinalResult(sessionA, 'artifact-a-first', deliveryFiles(aFirst))
    const aSecondDelivery = seedFinalResult(sessionA, 'artifact-a-second', deliveryFiles(aSecond))
    seedFinalResult(sessionB, 'artifact-b-only', deliveryFiles(bChanges))
    changesBySession.set(sessionB, bChanges)
    netChangesBySession.set(sessionB, bChanges)
    seededUsage.set(sessionA, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    seededUsage.set(sessionB, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    await page.reload()
    await expect(conversation).toContainText('artifact-b-only_DONE')

    const openTask = async (title: string, answer: string): Promise<void> => {
      const expand = work().getByRole('button', { name: '展开 Work 导航', exact: true })
      if (await expand.isVisible()) await expand.click()
      await work().locator('.work-sidebar__task').filter({ hasText: title }).click()
      await expect(conversation).toContainText(answer)
      for (const toggle of await conversation.locator('.work-message__process-toggle').all()) {
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
      }
    }
    await openTask('WORK_ARTIFACT_SCOPE_A', 'artifact-a-second_DONE')
    const firstTurn = conversation.locator('.work-conversation-turn').filter({ hasText: 'artifact-a-first_DONE' })
    const secondTurn = conversation.locator('.work-conversation-turn').filter({ hasText: 'artifact-a-second_DONE' })
    const firstResults = firstTurn.getByRole('region', { name: '最终交付物', exact: true })
    const secondResults = secondTurn.getByRole('region', { name: '最终交付物', exact: true })
    await expect(conversation.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(2)
    for (const [owner, results] of [[firstTurn, firstResults], [secondTurn, secondResults]]) {
      await expect(results.locator('[data-final-result-item]')).toHaveCount(2)
      const toggle = owner.locator('.work-message__process-toggle')
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(await results.evaluate(element => {
        const reply = element.closest('.work-conversation-turn')!.querySelector('.work-message--assistant')!
        return Boolean(reply.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      })).toBe(true)
    }
    await expect(firstResults).toHaveAttribute('data-final-result-run', aFirstDelivery.runId)
    await expect(secondResults).toHaveAttribute('data-final-result-run', aSecondDelivery.runId)
    await expect(firstResults.locator('[data-final-result-item="a-shared-v1"]')).toHaveCount(1)
    await expect(firstResults.locator('[data-final-result-item="a-shared-v2"]')).toHaveCount(0)
    await expect(firstResults).toContainText('only-alpha.md')
    await expect(firstResults).not.toContainText('only-beta.md')
    await expect(secondResults.locator('[data-final-result-item="a-shared-v2"]')).toHaveCount(1)
    await expect(secondResults.locator('[data-final-result-item="a-shared-v1"]')).toHaveCount(0)
    await expect(secondResults).toContainText('only-beta.md')
    await expect(secondResults).not.toContainText('only-alpha.md')
    await firstTurn.locator('.work-message__process-toggle').press('Enter')
    await expect(firstTurn.locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(firstTurn.locator('.work-message__process')).toBeVisible()
    await expect(secondTurn.locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(secondTurn.locator('.work-message__process')).toHaveCount(0)
    await expect(secondResults).toBeVisible()
    const closeResultsWorkspace = work().getByRole('button', { name: '收起工作区', exact: true })
    if (await closeResultsWorkspace.isVisible()) await closeResultsWorkspace.click()
    await firstTurn.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('work-results-by-conversation-turn.png'), animations: 'disabled' })
    await firstResults.getByRole('button', { name: '预览 shared.md', exact: true }).press('Enter')
    const deliveredPreview = work().getByRole('region', { name: '交付物预览', exact: true })
    await expect(deliveredPreview).toHaveAttribute('data-final-result-run', aFirstDelivery.runId)
    await expect(deliveredPreview).toContainText('SESSION_A_VERSION_ONE')
    await expect(deliveredPreview).not.toContainText('SESSION_A_VERSION_TWO')
    await conversation.locator('.work-file-change-row[data-change-id="a-shared-v1"]').press('Enter')
    const artifacts = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    const scope = artifacts.locator('.work-session-artifacts__turn')
    const scopeButton = scope.getByRole('button', { name: '文件改动轮次', exact: true })
    const scopeMenu = page.getByRole('menu', { name: '文件改动轮次', exact: true })
    const selectTurn = async (name: string | RegExp): Promise<void> => {
      await scopeButton.click()
      await scopeMenu.getByRole('menuitem', { name }).click()
    }
    const search = artifacts.getByRole('searchbox', { name: '搜索当前范围文件', exact: true })
    const tree = artifacts.getByRole('tree', { name: '本会话文件树', exact: true })
    const diff = artifacts.locator('.work-session-artifacts__diff')
    const batch = artifacts.locator('.work-session-artifacts__batch')
    const fileCount = artifacts.locator('.work-session-artifacts__header span')
    await expect(artifacts).toHaveAttribute('data-session-id', sessionA)
    await expect(scope).toHaveAttribute('data-turn-scope', 'turn:artifact-a-first')
    const requestTimes = await page.evaluate(time => [new Date(time).toLocaleString(), new Date(time + 3_600_000).toLocaleString()], baseTime)
    await scopeButton.click()
    await expect(scopeMenu.getByRole('menuitem', { name: /^先创建共享报告和 Alpha 附件/ }).locator('.select__item-desc')).toHaveText(`请求时间 · ${requestTimes[0]}`)
    await expect(scopeMenu.getByRole('menuitem', { name: /^更新共享报告并新增 Beta 附件/ }).locator('.select__item-desc')).toHaveText(`请求时间 · ${requestTimes[1]}`)
    await expect(scopeMenu.getByRole('menuitem')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(fileCount).toHaveText('2 个涉及文件')
    await expect(tree.locator('[data-path$="/only-alpha.md"]')).toBeVisible()
    await expect(tree.locator('[data-path$="/only-beta.md"]')).toHaveCount(0)
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v1')
    await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
    await expect(diff.locator('.diff-row--add')).toContainText(['SESSION_A_VERSION_ONE'])
    await expect(diff).not.toContainText('SESSION_A_VERSION_TWO')
    await expect(batch.locator('.work-change-review__count')).toHaveText('2 条修改待确认')

    await selectTurn(/^更新共享报告并新增 Beta 附件/)
    await expect(fileCount).toHaveText('2 个涉及文件')
    await expect(tree.locator('[data-path$="/only-alpha.md"]')).toHaveCount(0)
    await expect(tree.locator('[data-path$="/only-beta.md"]')).toBeVisible()
    await tree.locator(`[data-path="${sharedPath}"]`).click()
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v2')
    await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
    await expect(diff.locator('.diff-row--add')).toContainText(['SESSION_A_VERSION_TWO'])
    await expect(diff.locator('.diff-row--del')).toContainText(['SESSION_A_VERSION_ONE'])
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    const diffScopeMenu = page.getByRole('menu', { name: '差异范围', exact: true })
    await expect(diffScopeMenu.getByRole('menuitem', { name: /^修改记录/ })).toBeVisible()
    await diffScopeMenu.getByRole('menuitem', { name: /^待确认改动/ }).click()
    await expect(diff).toHaveCount(0)
    await expect(artifacts).toContainText('此文件在当前范围没有待确认改动。')
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    await diffScopeMenu.getByRole('menuitem', { name: /^修改记录/ }).click()
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v2')
    await expect(artifacts.getByRole('note')).toContainText('跨轮次的净变化仅在“整个会话”查看')
    await search.fill('shared')
    await expect(fileCount).toHaveText('1 / 2 个涉及文件')
    const sourcesTab = work().getByRole('tab', { name: '资料', exact: true })
    if (await sourcesTab.isVisible()) await sourcesTab.click()
    else {
      await work().getByRole('button', { name: '更多工作区', exact: true }).click()
      await page.getByRole('menuitem', { name: '资料', exact: true }).click()
    }
    await expect(artifacts).toBeHidden()
    await work().getByRole('tab', { name: '成果', exact: true }).click()
    await expect(artifacts).toBeVisible()
    await expect(scope).toHaveAttribute('data-turn-scope', 'turn:artifact-a-second')
    await expect(search).toHaveValue('shared')
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v2')
    await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
    await search.fill('')
    await expect(batch).toHaveAttribute('aria-label', '当前轮次的文件改动操作')
    await expect(batch.locator('.work-change-review__count')).toHaveText('2 条修改待确认')
    await batch.getByRole('button', { name: '批量改动操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '保留待确认改动', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '保留待确认改动', exact: true })
    await expect(confirm).toContainText('以下 2 个文件的 2 处改动')
    await expect(confirm).toContainText('shared.md')
    await expect(confirm).toContainText('only-beta.md')
    await expect(confirm).not.toContainText('only-alpha.md')
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('work-artifacts-turn-scope.png'), animations: 'disabled' })

    await selectTurn(/^先创建共享报告和 Alpha 附件/)
    const reports = tree.getByRole('treeitem').filter({ hasText: /^reports$/ })
    if (await reports.getAttribute('aria-expanded') === 'true') await reports.click()
    await expect(reports).toHaveAttribute('aria-expanded', 'false')
    await expect(tree.locator('[data-path$="/only-alpha.md"]')).toHaveCount(0)
    await search.fill('/reports/only-alpha.md')
    await expect(tree.locator('[data-path$="/only-alpha.md"]')).toBeVisible()
    await expect(reports).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator(`[data-path="${sharedPath}"]`)).toHaveCount(0)
    await expect(fileCount).toHaveText('1 / 2 个涉及文件')
    await expect(batch).toHaveAttribute('aria-label', '当前轮次 · 当前筛选的文件改动操作')
    await expect(batch.locator('.work-change-review__count')).toHaveText('1 条修改待确认')
    await batch.getByRole('button', { name: '批量改动操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '保留待确认改动', exact: true }).click()
    await expect(confirm).toContainText('以下 1 个文件的 1 处改动')
    await expect(confirm).toContainText('only-alpha.md')
    await expect(confirm).not.toContainText('shared.md')
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await search.fill('only-beta')
    await expect(artifacts.getByRole('status')).toHaveText('当前范围没有匹配的文件。')
    await expect(fileCount).toHaveText('0 / 2 个涉及文件')
    await expect(batch.getByRole('group', { name: '待确认改动操作', exact: true })).toHaveCount(0)
    await search.fill('')
    await selectTurn('整个会话')
    await expect(fileCount).toHaveText('3 个涉及文件')
    await expect(batch.locator('.work-change-review__count')).toHaveText('4 条修改待确认')
    await tree.locator(`[data-path="${sharedPath}"]`).click()
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    await diffScopeMenu.getByRole('menuitem', { name: /^待确认改动/ }).click()
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-net')
    await expect(diff).toHaveAttribute('data-diff-scope', 'net')
    await expect(diff.locator('.diff-row--add')).toContainText(['SESSION_A_VERSION_TWO'])
    await expect(diff).not.toContainText('SESSION_A_VERSION_ONE')

    await openTask('WORK_ARTIFACT_SCOPE_B', 'artifact-b-only_DONE')
    await conversation.locator('.work-file-change-row[data-change-id="b-shared-v1"]').press('Enter')
    await expect(artifacts).toHaveAttribute('data-session-id', sessionB)
    await expect(scope).toHaveAttribute('data-turn-scope', 'turn:artifact-b-only')
    await scopeButton.click()
    await expect(scopeMenu.getByRole('menuitem')).toHaveCount(2)
    await expect(scopeMenu.getByRole('menuitem', { name: /Alpha|Beta/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(fileCount).toHaveText('1 个涉及文件')
    await expect(diff).toHaveAttribute('data-change-id', 'b-shared-v1')
    await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
    await expect(diff).toContainText('SESSION_B_INDEPENDENT_VERSION')
    await expect(diff).not.toContainText('SESSION_A_VERSION')
    await expect(batch.locator('.work-change-review__count')).toHaveText('1 条修改待确认')

    await openTask('WORK_ARTIFACT_SCOPE_A', 'artifact-a-second_DONE')
    await conversation.locator('.work-file-change-row[data-change-id="a-shared-v2"]').press('Enter')
    await expect(artifacts).toHaveAttribute('data-session-id', sessionA)
    await expect(scope).toHaveAttribute('data-turn-scope', 'turn:artifact-a-second')
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v2')
    await expect(diff).not.toContainText('SESSION_B_INDEPENDENT_VERSION')
    await page.screenshot({ path: testInfo.outputPath('work-artifacts-session-isolation.png'), animations: 'disabled' })
    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      for (const width of [1440, 940]) {
        await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1000), width)
        if (width === 940) await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ }).click()
        await expect(artifacts).toBeVisible()
        await expect(scope).toHaveAttribute('data-turn-scope', 'turn:artifact-a-second')
        await expect.poll(() => artifacts.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1
        }), { message: `成果面板 ${appearance}/${width} 的顶部筛选与文件树不应撑出窗口` }).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`work-artifacts-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    // The visible review alone owns this session's net projection; a hidden
    // review must stop reading even while the conversation remains visible.
    await search.fill('shared')
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v2')
    await expect.poll(() => artifactNetChangeReads.get(sessionA) ?? 0).toBeGreaterThan(0)
    await work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true }).click()
    await expect(artifacts).toBeHidden()
    await expect(conversation).toBeVisible()
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const hiddenNetReads = artifactNetChangeReads.get(sessionA) ?? 0, hiddenAt = Date.now()
    await expect.poll(() => {
      expect(artifactNetChangeReads.get(sessionA) ?? 0).toBe(hiddenNetReads)
      return Date.now() - hiddenAt
    }, { timeout: 6_500, intervals: [250, 500], message: '窄窗隐藏成果后，跨过4秒周期也不得读取净变化' }).toBeGreaterThanOrEqual(4_500)
    await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ }).click()
    await expect(artifacts).toBeVisible()
    await expect.poll(() => artifactNetChangeReads.get(sessionA) ?? 0, { timeout: 6_500, message: '切回成果应恢复净变化读取' }).toBeGreaterThan(hiddenNetReads)
    await expect(scope).toHaveAttribute('data-turn-scope', 'turn:artifact-a-second')
    await expect(search).toHaveValue('shared')
    await expect(diff).toHaveAttribute('data-change-id', 'a-shared-v2')
    await search.fill('')
    await setWorkAppearance('dark')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })

  test('13 文件多轮过程记录在高窗口保留完整工作区，640 行差异连续滚动且 DOM 有界', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1200))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_LARGE_ARTIFACT_INSPECTOR')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    frame({ content: '准备展示完整研究项目与长报告。' }); finish()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    await expect(conversation).toContainText('准备展示完整研究项目与长报告。')
    const sessionId = run!.sessionId
    const baseTime = new Date('2026-10-21T01:00:00.000Z').getTime()
    const reportPath = '/remote/work-timeline/reports/research-report.md'
    const oldReport = '# 第一版研究提纲\n'
    const reportLines = Array.from({ length: 640 }, (_, index) => index === 639
      ? 'LARGE_REPORT_LAST_LINE_0640：全部研究结论与后续行动已完整列出。'
      : `${String(index + 1).padStart(4, '0')}. 研究记录 ${index + 1}：核对来源，说明证据，并记录需要跟进的事项。`)
    const firstPaths = ['reports/research-report.md', 'docs/brief.md', 'docs/sources.md', 'docs/methodology.md', 'data/samples.csv', 'data/metrics.csv', 'README.md']
    const secondPaths = ['reports/research-report.md', 'reports/findings.md', 'reports/action-items.md', 'reports/risk-register.md', 'assets/chart-spec.json', 'exports/summary.txt', 'archives/notes.md']
    const changesForTurn = (paths: string[], turn: 1 | 2): EngineFileChange[] => paths.map((path, index) => ({
      id: `large-turn-${turn}-file-${index}`, sessionId, turnId: `large-turn-${turn}`, toolCallId: `large-tool-${turn}-${index}`,
      path: `/remote/work-timeline/${path}`, kind: 'write', oldContent: turn === 2 && index === 0 ? oldReport : null,
      newContent: index === 0 ? turn === 1 ? oldReport : `${reportLines.join('\n')}\n` : `# ${path}\n\n第 ${turn} 轮交付材料。\n`,
      isNew: turn === 1 || index !== 0, truncated: false, status: 'pending', seq: (turn - 1) * 7 + index + 1,
      createdAt: baseTime + (turn - 1) * 3_600_000 + (index + 1) * 100
    }))
    const first = changesForTurn(firstPaths, 1), second = changesForTurn(secondPaths, 2)
    const histories = (changes: EngineFileChange[], turn: 1 | 2): EngineHistoryRow[] => {
      const turnId = `large-turn-${turn}`, createdAt = baseTime + (turn - 1) * 3_600_000
      return [
        { id: `${turnId}-request`, role: 'user', conversationId: turnId, createdAt,
          content: turn === 1 ? '建立研究项目，整理提纲、来源与基础数据' : '结合新增来源补充完整报告，并整理六份交付材料' },
        ...changes.flatMap((change, index): EngineHistoryRow[] => [
          { id: `${change.id}-start`, role: 'assistant', content: '', conversationId: turnId, createdAt: createdAt + 100 + index * 200,
            toolCall: { id: change.toolCallId, name: 'write_file', args: { path: change.path } } },
          { id: `${change.id}-result`, role: 'tool', toolCallId: change.toolCallId, content: '文件已写入', success: true,
            conversationId: turnId, createdAt: createdAt + 200 + index * 200, metadata: { change } }
        ]),
        { id: `${turnId}-answer`, role: 'assistant', content: `LARGE_ARTIFACT_TURN_${turn}_DONE`, conversationId: turnId, createdAt: createdAt + 2_000 }
      ]
    }
    seededHistories.set(sessionId, [...histories(first, 1), ...histories(second, 2)])
    seedFinalResult(sessionId, 'large-turn-1', [])
    seedFinalResult(sessionId, 'large-turn-2', [])
    seededUsage.set(sessionId, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    changesBySession.set(sessionId, [...first, ...second])
    netChangesBySession.set(sessionId, [
      { ...second[0], id: 'large-report-net', oldContent: null, isNew: true, changeIds: [first[0].id, second[0].id] },
      ...first.slice(1), ...second.slice(1)
    ])
    await page.reload()
    await expect(conversation).toContainText('LARGE_ARTIFACT_TURN_2_DONE')
    for (const toggle of await conversation.locator('.work-message__process-toggle').all()) {
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    }
    await conversation.locator('.work-file-change-row[data-change-id="large-turn-2-file-0"]').click()
    const artifacts = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    const scope = artifacts.getByRole('button', { name: '文件改动轮次', exact: true })
    await scope.click()
    await page.getByRole('menu', { name: '文件改动轮次', exact: true }).getByRole('menuitem', { name: '整个会话', exact: true }).click()
    const tree = artifacts.getByRole('tree', { name: '本会话文件树', exact: true })
    await tree.locator(`[data-path="${reportPath}"]`).click()
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    await page.getByRole('menu', { name: '差异范围', exact: true }).getByRole('menuitem', { name: /^待确认改动/ }).click()
    const diff = artifacts.locator('.work-session-artifacts__diff')
    const scroll = diff.locator('[data-diff-scroll]')
    await expect(diff).toHaveAttribute('data-change-id', 'large-report-net')
    await expect(diff).toHaveAttribute('data-diff-scope', 'net')
    await expect(scroll).toHaveAttribute('data-total-rows', '640')
    await expect(tree.locator('[role="treeitem"][data-path^="/remote/work-timeline/"]')).toHaveCount(13)
    await expect(artifacts.getByRole('button', { name: '选择净变化片段', exact: true })).toHaveCount(0)
    await expect(artifacts.locator('.work-session-artifacts__header span')).toHaveText('13 个涉及文件')
    await expect.poll(async () => ((await artifacts.innerText()).match(/13 个涉及文件/g) ?? []).length).toBe(1)
    await expect(diff.getByRole('button', { name: /更多|展开/ })).toHaveCount(0)
    const assertFilledDiff = async (): Promise<void> => {
      await expect.poll(() => scroll.evaluate(element => {
        const detail = element.closest('.work-session-artifacts__detail')
        if (!detail) return false
        const area = detail.getBoundingClientRect(), viewport = element.getBoundingClientRect()
        const remaining = area.bottom - viewport.top
        return viewport.height > 250 && viewport.height >= remaining * 0.9 && area.bottom - viewport.bottom <= 20 &&
          viewport.right <= innerWidth + 1 && element.scrollHeight > element.clientHeight
      }), { message: '长差异滚动区应填满详情栏剩余高度，不受旧卡片高度上限限制' }).toBe(true)
      expect(await scroll.locator('[data-diff-index]').count()).toBeLessThan(200)
    }
    await assertFilledDiff()
    await expect(scroll).toContainText('0001. 研究记录 1')
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(scroll).toContainText('LARGE_REPORT_LAST_LINE_0640')
    await expect(scroll.getByText('LARGE_REPORT_LAST_LINE_0640：全部研究结论与后续行动已完整列出。', { exact: true })).toBeInViewport()
    expect(await scroll.locator('[data-diff-index]').count()).toBeLessThan(200)
    await expect(scroll).not.toContainText('0001. 研究记录 1')
    await expect(diff.getByRole('button', { name: /更多|展开/ })).toHaveCount(0)

    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      for (const [width, height] of [[1440, 1200], [940, 1100]] as const) {
        await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
        if (width === 940) await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ }).click()
        await expect(artifacts).toBeVisible()
        await assertFilledDiff()
        await scroll.hover({ position: { x: 400, y: 120 } })
      await page.mouse.wheel(0, -100_000)
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
        await expect(scroll).toContainText('0001. 研究记录 1')
        await page.screenshot({ path: testInfo.outputPath(`work-artifacts-large-${appearance}-${width}-top.png`), animations: 'disabled' })
        if (width === 1440) {
          await scope.click()
          await expect(page.getByRole('menu', { name: '文件改动轮次', exact: true }).getByRole('menuitem')).toHaveCount(3)
          await page.screenshot({ path: testInfo.outputPath(`work-artifacts-turn-picker-${appearance}.png`), animations: 'disabled' })
          await page.keyboard.press('Escape')
        }
        await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(scroll).toContainText('LARGE_REPORT_LAST_LINE_0640')
        await page.screenshot({ path: testInfo.outputPath(`work-artifacts-large-${appearance}-${width}-bottom.png`), animations: 'disabled' })
      }
    }
    // The narrow tree cannot show all seven second-turn files at once. A
    // repeated receipt must retry its reveal after the collapsed rows return.
    const reportReceipt = conversation.locator('.work-file-change-row[data-change-id="large-turn-2-file-0"]')
    const reportRow = tree.locator(`[role="treeitem"][data-path="${reportPath}"]`)
    const reportsDirectory = tree.locator('[role="treeitem"][data-path="reports"]')
    await work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true }).click()
    await reportReceipt.click()
    await expect(artifacts).toBeVisible()
    await expect(diff).toHaveAttribute('data-change-id', 'large-turn-2-file-0')
    await expect(reportRow).toHaveAttribute('aria-selected', 'true')
    await expect(reportRow).toBeInViewport()
    await expect(reportsDirectory).toHaveAttribute('aria-expanded', 'true')
    await reportsDirectory.click()
    await expect(reportsDirectory).toHaveAttribute('aria-expanded', 'false')
    await expect(reportRow).toHaveCount(0)
    await tree.evaluate(element => { element.scrollTop = 0 })
    await work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true }).click()
    await reportReceipt.click()
    await expect(artifacts).toBeVisible()
    await expect(reportsDirectory).toHaveAttribute('aria-expanded', 'true')
    await expect(diff).toHaveAttribute('data-change-id', 'large-turn-2-file-0')
    await expect(reportRow).toHaveAttribute('aria-selected', 'true')
    await expect(reportRow).toBeInViewport()
    await setWorkAppearance('dark')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })

  test('密集工具过程默认隐藏思考与成功元数据，只读结果就地展开且真实改动精确跳转', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1100))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('调研现有任务流程，整理说明并完善协作页面')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const message = conversation.locator('.work-message--assistant').last()
    const progress = [
      '我会先核对需求和当前页面，确认任务入口与文件组织方式。',
      '入口和数据流已经确认，接下来核对设置、页面组件和验证脚本。',
      '展示方式与可访问性约定已经核对，正在整理说明并完成页面改动。'
    ]
    const thoughts = [
      '先确认用户任务与已有报告，再检查实现入口。',
      '接下来比较设置和页面组件，确认可以复用的能力。',
      '最后核对视觉与键盘行为，再交付两份可以查看的成果。'
    ]
    const ordinary = [
      { name: 'read_file', args: { path: 'docs/requirements.md' }, output: '# 协作页面需求\n\n保留任务正文，工具结果按需展开。' },
      { name: 'read_file', args: { path: 'reports/current-flow.md' }, output: '当前流程：创建任务、核对资料、查看成果。' },
      { name: 'grep', args: { path: 'src', pattern: '任务入口' }, output: 'src/work/task-page.tsx:28：任务入口' },
      { name: 'execute_cmd', args: { command: 'rg "WorkView" src' }, output: 'src/work/task-page.tsx:12：引用 WorkView' },
      { name: 'read_file', args: { path: 'config/work-settings.json' }, output: '{"layout":"conversation","theme":"system"}' },
      { name: 'read_file', args: { path: 'src/work/task-page.tsx' }, output: 'export function TaskPage() { return <WorkView /> }' },
      { name: 'grep', args: { path: 'src/work', pattern: '工作区' }, output: 'src/work/workspace.tsx:42：工作区切换' },
      { name: 'execute_cmd', args: { command: 'node scripts/check-workspace.js' }, output: '工作区结构检查通过。' },
      { name: 'read_file', args: { path: 'docs/style-guide.md' }, output: '普通操作使用简洁单行，详细数据按需查看。' },
      { name: 'read_file', args: { path: 'docs/accessibility.md' }, output: '所有展开按钮支持 Enter 与空格键。' },
      { name: 'write_file', args: { path: 'drafts/review-checklist.md' }, output: '检查清单已接收，尚未提供文件改动回执。' },
      { name: 'execute_cmd', args: { command: 'npm run typecheck' }, output: 'Node 与 Web 类型检查均通过。' }
    ]
    for (let index = 0; index < ordinary.length; index++) {
      if (index % 4 === 0) {
        frame({ content: progress[index / 4] })
        frame({ thinking: thoughts[index / 4] })
      }
      const tool = ordinary[index], id = `dense-tool-${index}`
      frame({ toolStart: { id, name: tool.name, args: tool.args } })
      if (index === ordinary.length - 1) {
        const running = message.locator(`[data-tool-id="${id}"]`)
        await expect(running).toHaveAttribute('data-tool-state', 'running')
        await expect(running.locator('.logline__status')).toHaveText('运行中')
        await expect(running.locator('.logline__icon .ui-spinner')).toBeVisible()
      }
      frame({ toolEnd: { id, name: tool.name, output: tool.output, success: true, durationMs: 120 + index * 17 } })
    }
    const changes: EngineFileChange[] = [
      { id: 'dense-report-edit', sessionId: run!.sessionId, turnId: run!.turnId, runId: run!.runId, toolCallId: 'dense-edit-report',
        path: '/remote/work-timeline/reports/current-flow.md', kind: 'write', oldContent: '# 当前流程\n原有说明。\n',
        newContent: '# 当前流程\n核对资料后进入协作页面。\n工具结果按需展开，真实文件改动进入成果。\n',
        isNew: false, truncated: false, status: 'pending', createdAt: Date.now() },
      { id: 'dense-page-create', sessionId: run!.sessionId, turnId: run!.turnId, runId: run!.runId, toolCallId: 'dense-create-page',
        path: '/remote/work-timeline/src/work/task-summary.tsx', kind: 'write', oldContent: null,
        newContent: 'export function TaskSummary() {\n  return <section>协作任务概览</section>\n}\n',
        isNew: true, truncated: false, status: 'pending', createdAt: Date.now() + 1 }
    ]
    for (const change of changes) {
      frame({ toolStart: { id: change.toolCallId!, name: 'write_file', args: { path: change.path } } })
      frame({ fileChange: change })
      frame({ toolEnd: { id: change.toolCallId!, name: 'write_file', output: '文件已写入。', success: true, durationMs: 46 } })
    }
    frame({ content: '调研和页面整理已完成。报告补充了最新流程，新增了任务概览组件；类型检查通过。' })
    finish(finalResult(run!, '调研和页面整理已完成。报告补充了最新流程，新增了任务概览组件；类型检查通过。', [
      { id: 'dense-delivered-report', path: changes[0].path, content: changes[0].newContent! }
    ]))
    const originalResults = conversation.locator('.work-conversation-turn').first().getByRole('region', { name: '最终交付物', exact: true })
    await expect(originalResults.locator('[data-final-result-item]')).toHaveCount(1)
    await expect(originalResults).toContainText('current-flow.md')
    await expect(originalResults).not.toContainText('task-summary.tsx')
    await expect(originalResults).not.toContainText('review-checklist.md')
    const process = message.locator('.work-message__process-toggle')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await expect(process).toContainText('14 步')
    await expect(process).not.toContainText('思考')
    await process.press('Enter')
    const ordinaryRows = message.locator('.compact-tool-row--quiet')
    await expect(ordinaryRows).toHaveCount(12)
    await expect(message.locator('.work-file-change-row')).toHaveCount(2)
    await expect(message.locator('.work-file-change-row__state')).toHaveCount(0)
    await expect(message.locator('.work-message__thinking')).toHaveCount(0)
    await expect(ordinaryRows.locator('.logline__detail, .work-tool-technical, .logline__dot, .logline__status, .pending-card__hint')).toHaveCount(0)
    await expect(ordinaryRows.locator('.logline__summary--link, .logline__summary[role="button"]')).toHaveCount(0)
    for (const row of await ordinaryRows.all()) {
      await expect(row).toHaveAttribute('data-tool-state', 'done')
      await expect(row.locator('button.logline')).not.toContainText(/已完成|成功|\d+\s*ms/)
    }
    await expect(message.locator('.work-file-change-row[data-change-id="dense-report-edit"] .work-file-change-row__added')).toHaveText('+2')
    await expect(message.locator('.work-file-change-row[data-change-id="dense-report-edit"] .work-file-change-row__removed')).toHaveText('-1')
    await expect(message.locator('.work-file-change-row[data-change-id="dense-page-create"] .work-file-change-row__added')).toHaveText('+3')
    const thinkingToggle = message.getByRole('button', { name: '显示思考', exact: true })
    await expect(thinkingToggle).toHaveAttribute('aria-pressed', 'false')
    await thinkingToggle.press('Space')
    await expect(message.locator('.work-message__thinking')).toHaveCount(3)
    const ordered = await message.locator('.work-message__timeline').innerText()
    for (let index = 0; index < 3; index++) {
      const firstPath = ordinary[index * 4].args.path!
      expect(ordered.indexOf(progress[index])).toBeGreaterThanOrEqual(0)
      expect(ordered.indexOf(progress[index])).toBeLessThan(ordered.indexOf(thoughts[index]))
      expect(ordered.indexOf(thoughts[index])).toBeLessThan(ordered.indexOf(firstPath))
    }
    await message.getByRole('button', { name: '隐藏思考', exact: true }).press('Enter')
    await expect(message.locator('.work-message__thinking')).toHaveCount(0)
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    const closeWorkspace = work().getByRole('button', { name: '收起工作区', exact: true })
    if (await closeWorkspace.isVisible()) await closeWorkspace.click()
    const read = message.locator('[data-work-tool-id="dense-tool-0"]')
    const noReceipt = message.locator('[data-work-tool-id="dense-tool-10"]')
    for (const activity of [read, noReceipt]) {
      await activity.locator('.logline__summary').click()
      await expect(activity.locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
      await expect(activity.locator('.logline__detail')).toBeVisible()
      await expect(work().getByRole('button', { name: '打开工作区', exact: true })).toBeVisible()
      await expect(work().getByRole('region', { name: '本会话成果与改动', exact: true })).toBeHidden()
      await expect(activity.locator('.work-file-change-row')).toHaveCount(0)
      await activity.locator('button.logline').press('Enter')
    }
    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      for (const width of [1440, 940]) {
        await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1100), width)
        const mobileConversation = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
        if (await mobileConversation.isVisible()) await mobileConversation.click()
        await message.scrollIntoViewIfNeeded()
        await expect(ordinaryRows.locator('.logline__detail, .work-tool-technical')).toHaveCount(0)
        await expect(message.locator('.work-message__thinking')).toHaveCount(0)
        await expect.poll(() => conversation.locator('.work-conversation__scroll').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
        await page.screenshot({ path: testInfo.outputPath(`work-dense-process-${appearance}-${width}.png`), animations: 'disabled' })
        if (width === 1440) await message.screenshot({ path: testInfo.outputPath(`work-process-compact-${appearance}.png`), animations: 'disabled' })
      }
    }
    await setWorkAppearance('dark')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1100))
    await read.locator('button.logline').press('Enter')
    await expect(read.locator('.logline__detail')).toContainText('保留任务正文，工具结果按需展开。')
    await expect(read.locator('.logline__metadata')).toHaveCount(0)
    await expect(read.locator('.logline__detail')).not.toContainText('成功 · 120 ms')
    await expectNoWorkRawData(read)
    await expect(work().getByRole('button', { name: '打开工作区', exact: true })).toBeVisible()
    await read.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('work-read-result-inline.png'), animations: 'disabled' })
    await read.locator('button.logline').press('Enter')
    await message.locator('.work-file-change-row[data-change-id="dense-report-edit"]').press('Enter')
    const artifacts = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    await expect(work().getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', 'dense-report-edit')
    await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-diff-scope', 'operation')
    await expect(artifacts).toContainText('工具结果按需展开，真实文件改动进入成果。')
    // A reasoning-only answer still has a useful default when its process opens.
    await work().getByRole('textbox', { name: '继续对话', exact: true }).fill('简短说明接下来的检查重点')
    await work().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 2)
    frame({ thinking: '继续核对结果中的关键路径与键盘可达性。' })
    const reasoningOnly = conversation.locator('.work-message--assistant').last()
    await expect(conversation.locator('.work-conversation-turn').last().getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
    await expect(conversation.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(1)
    await expect(originalResults.locator('[data-final-result-item]')).toHaveCount(1)
    await expect(reasoningOnly.getByRole('button', { name: '隐藏思考', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(reasoningOnly.locator('.work-message__thinking')).toContainText('继续核对结果中的关键路径与键盘可达性。')
    frame({ content: '接下来核对文件内容与键盘操作。' }); finish()
    await expect(reasoningOnly.locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'false')
    await reasoningOnly.locator('.work-message__process-toggle').press('Enter')
    await expect(reasoningOnly.locator('.work-message__thinking')).toContainText('继续核对结果中的关键路径与键盘可达性。')
    await expect(conversation.locator('.work-conversation-turn').last().getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
    await expect(originalResults.locator('[data-final-result-item="dense-delivered-report"]')).toHaveCount(1)
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })

  test('Work 多文件与普通工具右侧对齐，悬停展开稳定且改动精确跳转', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1100))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_TOOL_ROW_ALIGNMENT')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const message = conversation.locator('.work-message--assistant').last()
    for (const receipt of [
      { id: 'align-read', name: 'read_file', args: { path: 'reports/需要核对的完整项目研究说明.md' }, output: 'ALIGN_READ_CONTENT：保留任务正文，逐项核对修改记录。' },
      { id: 'align-search', name: 'grep', args: { path: 'src/work', pattern: '任务概览' }, output: 'src/work/task-page.tsx:28：ALIGN_SEARCH_CONTENT' }
    ]) {
      frame({ toolStart: { id: receipt.id, name: receipt.name, args: receipt.args } })
      frame({ toolEnd: { id: receipt.id, name: receipt.name, output: receipt.output, success: true } })
    }
    frame({ toolStart: { id: 'align-empty-target', name: 'list_files', args: {} } })
    frame({ toolEnd: { id: 'align-empty-target', name: 'list_files', success: false,
      output: '当前目录暂不可读。', error: '目录列表读取失败，请稍后重试。' } })
    const makeChange = (id: string, toolCallId: string, path: string, oldContent: string | null, newContent: string | null, truncated = false): EngineFileChange => ({
      id, toolCallId, path: `/remote/work-timeline/${path}`, oldContent, newContent, truncated,
      sessionId: run!.sessionId, turnId: run!.turnId, runId: run!.runId,
      kind: 'write', isNew: oldContent === null, status: 'pending', createdAt: Date.now()
    })
    const batch = [
      makeChange('align-first', 'align-batch', 'reports/同组第一份较长文件名称用于核对首行宽度.md', null, 'ALIGN_FIRST\n'),
      makeChange('align-next', 'align-batch', 'reports/next.md', null, 'ALIGN_NEXT\n第二行\n第三行\n'),
      makeChange('align-binary', 'align-batch', 'assets/preview.png', null, null, true)
    ]
    const other = makeChange('align-other', 'align-other-tool', 'src/work/task-summary.tsx', '原有概览\n', 'ALIGN_OTHER\n更新任务概览\n')
    const failed = makeChange('align-failed', 'align-failed-tool', 'reports/partial-edit.md', '修改前\n', 'ALIGN_PARTIAL_EDIT\n')
    // Match the dense fixture's actual tool/receipt sequence; a batch owns all
    // its file rows, while the later edit and failed partial edit are separate.
    frame({ toolStart: { id: 'align-batch', name: 'write_file', args: { path: 'reports' } } })
    for (const change of batch) frame({ fileChange: change })
    frame({ toolEnd: { id: 'align-batch', name: 'write_file', output: '三份文件已写入。', success: true } })
    frame({ content: '资料已核对，继续修改任务概览并检查失败记录。' })
    for (const change of [other, failed]) {
      frame({ toolStart: { id: change.toolCallId!, name: 'edit_file', args: { path: change.path } } })
      frame({ fileChange: change })
      frame({ toolEnd: { id: change.toolCallId!, name: 'edit_file', success: change !== failed,
        output: change === failed ? '首处修改已写入，第二处匹配失败。' : '概览已更新。',
        ...(change === failed ? { error: '第二处目标内容未匹配，请核对已写入的改动。' } : {}) } })
    }
    frame({ content: 'ALIGNMENT_DONE：已保留全部修改记录。' }); finish()
    const process = message.locator('.work-message__process-toggle')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await process.press('Enter')
    await expect(message.locator('[data-work-tool-id="align-batch"] .work-file-change-row')).toHaveCount(3)
    await expect(message.locator('.work-file-change-row')).toHaveCount(5)
    await expect(message.locator('[data-change-id="align-binary"] .work-file-change-row__code')).toHaveText('U')
    await expect(message.locator('[data-change-id="align-failed"]')).toHaveAttribute('data-tool-state', 'error')
    await expect(message.locator('[data-change-id="align-failed"] .work-file-change-row__state')).toHaveText('失败')
    await expect(message.locator('[data-work-tool-id="align-empty-target"] .logline__summary')).toHaveCount(0)
    await expect(message.locator('[data-work-tool-id="align-empty-target"] .logline__status')).toBeVisible()
    const rows = message.locator('.work-file-change-row, .compact-tool-row--quiet > button.logline')
    await expect(rows).toHaveCount(9)
    const settled = async (row: Locator): Promise<void> => {
      await row.evaluate(async element => {
        await Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').map(animation => animation.finished))
      })
    }
    const geometry = () => rows.evaluateAll(elements => elements.map(element => {
      const arrow = element.querySelector<SVGElement>(':scope > svg:last-child')!
      const tail = element.querySelector<HTMLElement>('.work-file-change-row__stats, .work-file-change-row__unknown, .logline__status')
      const state = element.querySelector<HTMLElement>('.work-file-change-row__state')
      const label = element.querySelector<HTMLElement>('.work-file-change-row__action, .logline__name')!
      const bounds = element.getBoundingClientRect(), end = arrow.getBoundingClientRect(), suffix = tail?.getBoundingClientRect()
      return { right: bounds.right, labelLeft: label.getBoundingClientRect().left, arrowRight: end.right, arrowInset: bounds.right - end.right, arrowLeft: end.left, tailRight: suffix?.right ?? null,
        stateOverlaps: Boolean(state && suffix && state.getBoundingClientRect().right > suffix.left + 1),
        clipped: element.scrollWidth > element.clientWidth + 1 }
    }))
    const assertAligned = async (): Promise<void> => {
      await expect.poll(async () => {
        const positions = await geometry(), spread = (values: number[]) => Math.max(...values) - Math.min(...values)
        const tails = positions.flatMap(position => position.tailRight === null ? [] : [position.tailRight])
        return { rows: spread(positions.map(position => position.right)) <= 1,
          labels: spread(positions.map(position => position.labelLeft)) <= 1,
          arrows: spread(positions.map(position => position.arrowRight)) <= 1, tails: spread(tails) <= 1,
          contained: positions.every(position => !position.clipped && !position.stateOverlaps && position.arrowRight <= position.right + 1 &&
            (position.tailRight === null || position.tailRight < position.arrowLeft)) }
      }, { message: '同组首行、后续行及其它工具应共用右边界，尾部不得重叠或溢出' })
        .toEqual({ rows: true, labels: true, arrows: true, tails: true, contained: true })
    }
    const screenshots = join(fixtureRoot, 'work-tool-row-alignment')
    mkdirSync(screenshots, { recursive: true })
    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      for (const width of [1440, 940]) {
        const contentWidth = await app!.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.setSize(width, 1100)
          return window.getContentSize()[0]
        }, width)
        // Compare hover against the resized Chromium layout, not the previous
        // frame that can still exist after native setSize has returned.
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(contentWidth)
        const mobileConversation = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
        if (await mobileConversation.isVisible()) await mobileConversation.click()
        await page.mouse.move(0, 0)
        // Responsive navigation animates between its compact and full widths;
        // the centered message moves even after Chromium reports its new size.
        await message.evaluate(element => new Promise<void>((resolve, reject) => {
          const sidebar = element.closest('.work-view')!.querySelector('.work-sidebar')!
          const deadline = performance.now() + 3000
          let previous = '', stable = 0
          const sample = (): void => {
            const bounds = sidebar.getBoundingClientRect()
            const positions = Array.from(element.querySelectorAll('.work-file-change-row, .compact-tool-row--quiet > button.logline'))
              .map(row => { const rect = row.getBoundingClientRect(); return [rect.left, rect.right] })
            const next = JSON.stringify([bounds.left, bounds.right, positions])
            const moving = sidebar.getAnimations().some(animation => animation.playState === 'running' || animation.pending)
            stable = !moving && next === previous ? stable + 1 : 0; previous = next
            if (stable >= 3) { resolve(); return }
            if (performance.now() > deadline) { reject(new Error('Sidebar and tool row layout did not settle')); return }
            requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        }))
        await assertAligned()
        const baseline = await geometry()
        for (let index = 0; index < await rows.count(); index++) {
          const row = rows.nth(index)
          await row.hover()
          await settled(row)
          await assertAligned()
          expect(Math.abs((await geometry())[index].arrowInset - baseline[index].arrowInset), '悬停不得改变箭头相对行右界的位置').toBeLessThanOrEqual(1)
        }
        for (const toolId of ['align-read', 'align-search', 'align-empty-target', 'align-failed-tool']) {
          const activity = message.locator(`[data-work-tool-id="${toolId}"]`), toggle = activity.locator('button.logline')
          await toggle.press('Enter')
          await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          await expect(activity.locator('.logline__detail')).toBeVisible()
          await settled(activity)
          await assertAligned()
          await toggle.press('Enter')
          await expect(activity.locator('.logline__detail')).toHaveCount(0)
          await settled(toggle)
          await assertAligned()
        }
        const screenshot = join(screenshots, `work-tool-row-alignment-${appearance}-${width}.png`)
        await page.screenshot({ path: screenshot, animations: 'disabled' })
        await testInfo.attach(`tool-row-alignment-${appearance}-${width}`, { path: screenshot, contentType: 'image/png' })
      }
    }
    const artifacts = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    for (const change of [batch[0], batch[1], other, failed]) {
      const mobileConversation = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
      if (await mobileConversation.isVisible()) await mobileConversation.click()
      await message.locator(`.work-file-change-row[data-change-id="${change.id}"]`).click()
      await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', change.id)
      await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-diff-scope', 'operation')
      await expect(artifacts).toContainText(change.newContent!.trim().split('\n')[0])
    }
    await setWorkAppearance('dark')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })

  test('Work 浏览器点击保留点击前坐标与目标框，点击后画面独立展开且旧记录不猜测位置', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 900))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_BROWSER_CLICK_POSITION')
    const beforeRequests = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(beforeRequests + 1)
    const images = await page.evaluate(() => {
      const make = (width: number, height: number, color: string, text: string): { dataUrl: string; width: number; height: number } => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')!
        context.fillStyle = color; context.fillRect(0, 0, width, height)
        context.fillStyle = '#ffffff'; context.font = '20px sans-serif'; context.fillText(text, 12, 36)
        return { dataUrl: canvas.toDataURL('image/png'), width, height }
      }
      return { before: make(240, 400, '#354f70', 'BEFORE CLICK'), after: make(320, 180, '#467448', 'AFTER CLICK') }
    })
    const interaction = { type: 'click', x: 123.5, y: 456, navigationId: 7, pageUrl: 'https://fixture.test/before-click',
      viewport: { width: 480, height: 800, deviceScaleFactor: 2, scrollX: 0, scrollY: 320 },
      target: { name: '落子按钮', selector: '#private-click-target', bounds: { x: 100, y: 440, width: 60, height: 40 } } }
    const snapshot = { tab: { title: '点击后的游戏页面', url: 'https://fixture.test/after-click', loading: false },
      text: 'CLICK_AFTER_PAGE_TEXT', elements: [], viewport: { width: 640, height: 360 }, screenshot: images.after, truncated: false }
    const damaged = { ...images.before, dataUrl: 'data:image/png;base64,' + Buffer.from(images.before.dataUrl.split(',')[1], 'base64').subarray(0, 24).toString('base64') }
    for (const [id, output] of [
      ['click-position', { ...snapshot, interaction: { ...interaction, screenshot: images.before } }],
      ['click-no-before', { ...snapshot, interaction }],
      ['click-legacy', snapshot],
      ['click-damaged-before', { ...snapshot, interaction: { ...interaction, screenshot: damaged } }]
    ] as const) {
      frame({ toolStart: { id, name: 'browser_click', args: { tabId: 'fixture-browser', x: 123.5, y: 456 } } })
      frame({ toolEnd: { id, name: 'browser_click', success: true, output: JSON.stringify(output) } })
    }
    frame({ toolStart: { id: 'click-plain-snapshot', name: 'browser_snapshot', args: { tabId: 'fixture-browser' } } })
    frame({ toolEnd: { id: 'click-plain-snapshot', name: 'browser_snapshot', success: true,
      output: JSON.stringify({ ...snapshot, viewport: interaction.viewport, screenshot: images.before }) } })
    frame({ content: 'WORK_BROWSER_CLICK_DONE：点击操作已完成，位置证据保留在过程。' })
    finish()
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const message = conversation.locator('.work-message--assistant').last()
    await expect(message).toContainText('WORK_BROWSER_CLICK_DONE')
    const process = message.locator('.work-message__process-toggle')
    await expect(process).toHaveAttribute('aria-expanded', 'false'); await process.press('Enter')
    const open = async (id: string): Promise<Locator> => {
      const activity = message.locator(`[data-work-tool-id="${id}"]`)
      await expect(activity.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
      await activity.locator('button.logline').press('Enter')
      return activity
    }
    const current = await open('click-position')
    await expect(current.locator('.tool-browser-snapshot__header, .tool-browser-snapshot__title')).toHaveCount(0)
    const position = current.locator('.tool-browser-click')
    await expect(position).toContainText('点击位置')
    await expect(position).toContainText('X 123.5 · Y 456')
    await expect(position).toContainText('落子按钮')
    await expect(position).not.toContainText('#private-click-target')
    await expect(position.locator('.tool-browser-click__map')).toHaveAttribute('viewBox', '0 0 480 800')
    await expect(position.locator('.tool-browser-position__image')).toHaveAttribute('href', images.before.dataUrl)
    await expect(position.locator('.tool-browser-click__point')).toHaveAttribute('cx', '123.5')
    await expect(position.locator('.tool-browser-click__point')).toHaveAttribute('cy', '456')
    for (const [attribute, value] of Object.entries(interaction.target.bounds)) {
      await expect(position.locator('.tool-browser-click__bounds')).toHaveAttribute(attribute, String(value))
    }
    const after = current.locator('.tool-browser-snapshot__after')
    await expect(after.locator('img')).toBeHidden()
    const preview = position.getByRole('button', { name: '放大查看 点击前页面截图', exact: true })
    await preview.press('Enter')
    const dialog = page.getByRole('dialog', { name: '点击前页面截图', exact: true })
    await expect(dialog.locator('.tool-browser-click__map')).toHaveAttribute('viewBox', '0 0 480 800')
    await expect(dialog.locator('.tool-browser-position__image')).toHaveAttribute('href', images.before.dataUrl)
    await expect(dialog.locator('.tool-browser-click__point')).toHaveAttribute('cx', '123.5')
    await expect(dialog.locator('.tool-browser-click__point')).toHaveAttribute('cy', '456')
    await expect(dialog.locator('.tool-browser-click__bounds')).toHaveAttribute('width', '60')
    await expect(dialog.locator('.tool-browser-position__image')).toBeVisible()
    await expect.poll(() => dialog.evaluate(element => {
      const overlay = element.closest('.modal-overlay')
      return !!overlay && overlay.getAttribute('data-motion-state') === 'open' && getComputedStyle(overlay).opacity === '1' &&
        !overlay.getAnimations({ subtree: true }).some(animation =>
          (animation.playState === 'running' || animation.pending) && animation.effect?.getTiming().iterations !== Infinity)
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('work-browser-click-position-enlarged.png'), animations: 'disabled' })
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(preview).toBeFocused()
    await after.locator('summary').press('Enter')
    await expect(after.locator('img')).toHaveAttribute('src', images.after.dataUrl)
    await expect.poll(() => after.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width: 320, height: 180 })
    await expect(after.locator('.tool-browser-click__point')).toHaveCount(0)
    const afterPreview = after.getByRole('button', { name: '放大查看 点击后页面截图', exact: true })
    await afterPreview.press('Enter')
    const afterDialog = page.getByRole('dialog', { name: '点击后页面截图', exact: true })
    await expect(afterDialog.locator('img')).toHaveAttribute('src', images.after.dataUrl)
    await expect(afterDialog.locator('.tool-browser-click__point')).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(afterDialog).toHaveCount(0); await expect(afterPreview).toBeFocused()
    await after.locator('summary').press('Enter')
    await expect(after.locator('img')).toBeHidden()
    const plain = await open('click-plain-snapshot')
    await expect(plain.locator('.tool-browser-snapshot__header, .tool-browser-snapshot__title')).toHaveCount(0)
    const plainImage = plain.getByRole('button', { name: '放大查看 页面截图', exact: true }).locator('img')
    await expect.poll(() => plainImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240)
    for (const appearance of ['light', 'dark'] as const) {
      await setWorkAppearance(appearance)
      for (const width of [940, 680]) {
        await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
        await expect(preview).toBeVisible()
        // Compare the actual pixels, not just a full-width SVG box: a capped
        // SVG height previously left the screenshot centred inside that box.
        await expect.poll(async () => {
          const geometry = (element: Element) => {
            const image = element.getBoundingClientRect()
            const container = element.closest('.tool-browser-snapshot--work')!.getBoundingClientRect()
            return { left: image.left - container.left, width: image.width, height: image.height }
          }
          const actual = await position.locator('.tool-browser-position__image').evaluate(geometry)
          const ordinary = await plainImage.evaluate(geometry)
          return Math.max(Math.abs(actual.left - ordinary.left), Math.abs(actual.width - ordinary.width),
            Math.abs(actual.height - ordinary.height), Math.max(0, actual.left - 2))
        }, { message: '普通截图与点击截图应按相同规则等比缩放并靠左显示' }).toBeLessThanOrEqual(1)
        await expectNoWorkRawData(current)
        await current.screenshot({ path: testInfo.outputPath(`work-browser-click-position-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await plain.locator('button.logline').press('Enter')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 900))
    await current.locator('button.logline').press('Enter')
    const withoutBefore = await open('click-no-before')
    await expect(withoutBefore.locator('.tool-browser-click__point')).toHaveAttribute('cx', '123.5')
    await expect(withoutBefore.locator('.tool-browser-position__image')).toHaveCount(0)
    await expect(withoutBefore.getByRole('button', { name: '放大查看 点击前页面截图', exact: true })).toHaveCount(0)
    await expect(withoutBefore.getByRole('button', { name: '放大查看 点击后页面截图', exact: true }).locator('img')).toHaveAttribute('src', images.after.dataUrl)
    await expect(withoutBefore).toContainText('此记录未保存截图，已显示位置示意图')
    await withoutBefore.locator('button.logline').press('Enter')
    const legacy = await open('click-legacy')
    await expect(legacy).toContainText('这条记录未保存点击位置')
    await expect(legacy.locator('.tool-browser-click__point')).toHaveCount(0)
    await expect(legacy.locator('.tool-browser-click__map')).toHaveCount(0)
    await expect(legacy.getByRole('button', { name: '放大查看 点击后页面截图', exact: true }).locator('img')).toHaveAttribute('src', images.after.dataUrl)
    await legacy.locator('button.logline').press('Enter')
    const broken = await open('click-damaged-before')
    await expect(broken).toContainText('截图无法显示，已显示位置示意图')
    await expect(broken.locator('.tool-browser-click__point')).toHaveAttribute('cy', '456')
    await expect(broken.locator('.tool-browser-position__image')).toHaveCount(0)
    await expect(broken.getByRole('button', { name: '放大查看 点击前页面截图', exact: true })).toHaveCount(0)
    await expectNoWorkRawData(broken)
    await broken.locator('button.logline').press('Enter')
    await process.press('Enter')
    await expect(message.locator('.work-message__process')).toHaveCount(0)
    await expect(conversation.getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('Work 工具图片收进过程，显式交付的成品图与真实浏览器截图直接显示并可放大', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('WORK_BROWSER_COMPACT_PROCESS')
    const before = requests.length
    await work().getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => requests.length).toBe(before + 1)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing browser fixture port')
    const fixtureUrl = `http://127.0.0.1:${address.port}/browser-screenshot-fixture`
    const workspaceWasOpen = await work().getByRole('button', { name: '收起工作区', exact: true }).isVisible()
    const selectedWorkspaceTab = await work().locator('.work-workspace__tab-button[aria-selected="true"]').evaluateAll(tabs => tabs[0]?.id ?? null)
    const browserTab = await page.evaluate(url => window.aether.browser.create({ url }), fixtureUrl)
    let captured: BrowserScreenshot
    try {
      await expect.poll(() => page.evaluate(() => window.aether.browser.list())).toContainEqual(expect.objectContaining({
        tabId: browserTab.tabId, url: fixtureUrl, title: '浏览器截图验收', loading: false
      }))
      await page.evaluate(tabId => window.aether.browser.action({ tabId, action: 'viewport', viewport: {
        width: 640, height: 360, mobile: false, deviceScaleFactor: 1
      } }), browserTab.tabId)
      const result = await page.evaluate(tabId => window.aether.browser.read(tabId, 'screenshot'), browserTab.tabId)
      expect(result.success, result.error).toBe(true)
      captured = result.output as BrowserScreenshot
      expect(captured.mimeType).toBe('image/png')
      expect(captured.dataUrl).toMatch(/^data:image\/png;base64,/)
      expect(captured.width).toBeGreaterThan(0)
      expect(captured.height).toBeGreaterThan(0)
    } finally {
      await page.evaluate(tabId => window.aether.browser.close(tabId), browserTab.tabId)
      if (workspaceWasOpen && selectedWorkspaceTab) await page.locator(`[id="${selectedWorkspaceTab}"]`).click()
      if (!workspaceWasOpen && await work().getByRole('button', { name: '收起工作区', exact: true }).isVisible()) {
        await work().getByRole('button', { name: '收起工作区', exact: true }).click()
      }
    }
    const { dataUrl, width, height } = captured
    writeFileSync(testInfo.outputPath('captured-browser-page.png'), Buffer.from(dataUrl.split(',')[1], 'base64'))
    const ordinary = [
      { id: 'browser-process-read', name: 'browser_snapshot', title: '读取页面记录', text: 'BROWSER_READ_TEXT：当前页面列出了待核对的任务。', args: { tabId: 'fixture-browser' } },
      { id: 'browser-process-navigate', name: 'browser_navigate', title: '导航页面记录', text: 'BROWSER_NAVIGATE_TEXT：已进入项目概览页面。', args: { tabId: 'fixture-browser', url: 'https://example.test/projects' } },
      { id: 'browser-process-resize', name: 'browser_set_viewport', title: '调整窗口记录', text: 'BROWSER_RESIZE_TEXT：页面已使用新的窗口尺寸。', args: { tabId: 'fixture-browser', width: 980, height: 720 } }
    ]
    for (const receipt of ordinary) {
      frame({ toolStart: { id: receipt.id, name: receipt.name, args: receipt.args } })
      frame({ toolEnd: { id: receipt.id, name: receipt.name, success: true, durationMs: 45,
        output: JSON.stringify({ tab: { tabId: 'fixture-browser', title: receipt.title, url: 'https://example.test/projects', loading: false },
          text: receipt.text, elements: [{ ref: 'e1', role: 'heading', name: '项目概览' }], viewport: { width: 980, height: 720 }, truncated: false }) } })
    }
    frame({ toolStart: { id: 'browser-process-read-image', name: 'browser_snapshot', args: { tabId: 'fixture-browser' } } })
    // Restored snapshots may contain a valid screenshot without viewport data.
    // The image must decode independently of coordinate-overlay support.
    frame({ toolEnd: { id: 'browser-process-read-image', name: 'browser_snapshot', success: true, durationMs: 61,
      output: JSON.stringify({ tab: { tabId: browserTab.tabId, title: '页面截图记录', url: fixtureUrl, loading: false },
        text: 'SCREENSHOT_PAGE_TEXT', elements: [], screenshot: { dataUrl, width, height }, truncated: false }) } })
    for (const name of ['browser_navigate', 'browser_set_viewport']) {
      const id = `${name}-image`
      frame({ toolStart: { id, name, args: { tabId: 'fixture-browser' } } })
      frame({ toolEnd: { id, name, success: true, output: JSON.stringify({
        tab: { tabId: browserTab.tabId, title: '浏览器截图验收', url: fixtureUrl, loading: false },
        text: '本地测试页面\n浏览器截图验收', elements: [], screenshot: { dataUrl, width, height }, truncated: false
      }) } })
    }
    frame({ toolStart: { id: 'browser-process-standalone', name: 'browser_screenshot', args: { tabId: 'fixture-browser' } } })
    frame({ toolEnd: { id: 'browser-process-standalone', name: 'browser_screenshot', success: true,
      output: JSON.stringify({ name: '独立页面截图.png', dataUrl, width, height }) } })
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const message = conversation.locator('.work-message--assistant').last(), process = message.locator('.work-message__process-toggle')
    const viewedImageId = 'viewed-image-receipt'
    frame({ toolStart: { id: viewedImageId, name: 'view_image', args: { path: 'images/browser-page.png' } } })
    frame({ toolEnd: { id: viewedImageId, name: 'view_image', success: true,
      output: JSON.stringify({ filename: '查看图片结果.png', dataUrl, width, height }) } })
    const samplePng = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABgCAYAAACaJ3mZAAABLUlEQVR4nO3SoQ0CAQAEwe+/QQrAoBCED7injCPZEeNX7PF4fi9YOdYBtBmQKQMyZUCmDMiUAZkyIFMGZMqATBmQKQMyZUCmDMiUAZkyIFMGZMqATBmQKQMyZUCmDMiUAZkyIFMGZMqATBmQKQMydbzen6vodj/5AwbEgAbsMiAGNGCXATGgAbsMiAEN2GVADGjALgNiQAN2GRADGrDLgBjQgF0GxIAG7DIgBjRglwExoAG7DIgBDdhlQAxowC4DYkADdhkQAxqwy4AY0IBdBsSABuwyIAY0YJcBMaABuwyIAQ3YZUAMaMAuA2JAA3YZEAMasMuAGNCAXQbEgAbsMiAGNGCXATGgAbsMiAEN2GVADGjALgNiQAN2GRADGrDLgBjQgF0GxIAG7DIgUz+e/ulA2DaA7wAAAABJRU5ErkJggg=='
    const generatedToolId = 'generated-image-with-change', generatedToolAlt = '生成工具结果.png'
    frame({ toolStart: { id: generatedToolId, name: 'image_generate', args: { path: 'images/generated.png' } } })
    frame({ fileChange: { id: 'generated-image-change', sessionId: run!.sessionId, turnId: run!.turnId, runId: run!.runId,
      toolCallId: generatedToolId, path: '/remote/work-timeline/images/generated.png', kind: 'write', oldContent: null,
      newContent: null, isNew: true, truncated: true, status: 'pending', createdAt: Date.now() } })
    frame({ toolEnd: { id: generatedToolId, name: 'image_generate', success: true,
      output: JSON.stringify({ filename: generatedToolAlt, dataUrl: `data:image/png;base64,${samplePng}` }) } })
    const imageToolIds = ['browser-process-read-image', 'browser_navigate-image', 'browser_set_viewport-image', 'browser-process-standalone', viewedImageId]
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    for (const id of [...imageToolIds, generatedToolId]) {
      const activity = message.locator(`[data-work-tool-id="${id}"]`)
      await expect(activity.locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
      await expect.poll(() => activity.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight }))).toEqual(id === generatedToolId ? { width: 160, height: 96 } : { width, height })
    }
    const liveClosed = message.locator('[data-work-tool-id="browser-process-read-image"]')
    await liveClosed.locator('button.logline').press('Enter')
    await expect(liveClosed.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(liveClosed.locator('img')).toHaveCount(0)
    // The parent disclosure stays open by explicit choice across completion,
    // so the next phase must also close image rows that remain mounted.
    await process.press('Enter')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await process.press('Enter')
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    await expect(liveClosed.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(liveClosed.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    await expect(liveClosed.locator('img')).toHaveCount(0)
    const liveReopened = message.locator(`[data-work-tool-id="${viewedImageId}"]`)
    await expect(liveReopened.locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
    await liveReopened.locator('button.logline').press('Enter')
    await liveReopened.locator('button.logline').press('Enter')
    await expect(liveReopened.locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
    const generatedAlt = '生成图测试样例.png', browserAlt = '浏览器页面截图.png'
    const finalText = 'WORK_BROWSER_COMPACT_DONE：页面检查已完成。\n\n已交付生成图与内置浏览器实际捕获的本地测试页面，两张图片均可点击放大。'
    const turn = message.locator('xpath=ancestor::*[contains(@class,"work-conversation-turn")]')
    const deliverables = turn.getByRole('region', { name: '最终交付物', exact: true })
    frame({ content: finalText })
    await expect(deliverables).toHaveCount(0)
    await expect(liveClosed.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    finish(finalResult(run!, finalText, [
      { id: 'browser-generated-delivery', name: generatedAlt, path: '/remote/work-timeline/images/generated.png', mimeType: 'image/png', content: Buffer.from(samplePng, 'base64') },
      { id: 'browser-captured-delivery', name: browserAlt, path: '/remote/work-timeline/images/browser-page.png', mimeType: 'image/png', content: Buffer.from(dataUrl.split(',')[1], 'base64') }
    ]))
    const generated = deliverables.getByRole('button', { name: `放大查看 ${generatedAlt}`, exact: true })
    const finalShot = deliverables.getByRole('button', { name: `放大查看 ${browserAlt}`, exact: true })
    await expect.poll(() => generated.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width: 160, height: 96 })
    await expect.poll(() => finalShot.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width, height })
    await expect(message).toContainText('WORK_BROWSER_COMPACT_DONE')
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    for (const id of [...imageToolIds, generatedToolId]) {
      const activity = message.locator(`[data-work-tool-id="${id}"]`)
      await expect(activity.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
      await expect(activity.locator('img')).toHaveCount(0)
    }
    await process.press('Enter')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await expect(process).toContainText('9 步')
    for (const id of [...ordinary.map(receipt => receipt.id), ...imageToolIds, generatedToolId]) {
      await expect(message.locator(`[data-work-tool-id="${id}"]`)).toHaveCount(0)
    }
    await expect(message.locator('.md-image')).toHaveCount(0)
    await expect(deliverables.locator('[data-final-result-kind="image"]')).toHaveCount(2)
    for (const image of [generated, finalShot]) {
      await expect(image).toBeVisible()
      expect(await image.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(false)
    }
    expect(await message.innerText()).not.toContain('data:image/png;base64')
    await page.screenshot({ path: testInfo.outputPath('work-final-delivered-images.png'), animations: 'disabled' })
    await finalShot.click()
    const finalEnlarged = page.getByRole('dialog', { name: browserAlt, exact: true })
    await expect.poll(() => finalEnlarged.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(width)
    await expectImageDialogSettled(finalEnlarged)
    await page.screenshot({ path: testInfo.outputPath('work-final-delivered-image-enlarged.png'), animations: 'disabled' })
    await page.keyboard.press('Tab')
    await expect(finalEnlarged.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(finalShot).toBeFocused()
    // Reopen during the close animation; the final reply must keep one live dialog.
    await page.keyboard.press('Enter')
    await expect(finalEnlarged).toHaveCount(1)
    await expect(finalEnlarged).toBeVisible()
    await expect.poll(() => finalEnlarged.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(width)
    await page.keyboard.press('Escape')
    await expect(finalEnlarged).toHaveCount(0)
    await expect(finalShot).toBeFocused()
    await expectNoWorkRawData(message)

    await process.press('Enter')
    for (const receipt of ordinary) {
      const activity = message.locator(`[data-work-tool-id="${receipt.id}"]`)
      expect(await activity.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(true)
      await expect(activity.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
      await expect(activity.locator('.logline__detail')).toHaveCount(0)
      await activity.locator('button.logline').press('Enter')
      const snapshot = activity.getByRole('region', { name: '浏览器页面快照', exact: true })
      await expect(activity.locator('button.logline')).toContainText(receipt.title)
      await expect(snapshot.locator('.tool-browser-snapshot__header, .tool-browser-snapshot__title')).toHaveCount(0)
      await expect(snapshot.getByRole('status')).toHaveText('这条记录未附截图')
      const pageText = snapshot.locator('.tool-browser-snapshot__text p')
      await expect(pageText).toBeHidden()
      await snapshot.locator('.tool-browser-snapshot__text > summary').press('Enter')
      await expect(pageText).toBeVisible()
      await expect(snapshot).toContainText(receipt.text)
      await expect(snapshot.locator('img')).toHaveCount(0)
      await expect(snapshot).not.toContainText('https://example.test/projects')
      await expect(snapshot).not.toContainText('980 × 720')
      await expectNoWorkRawData(activity)
      await activity.locator('button.logline').press('Enter')
      await expect(snapshot).toHaveCount(0)
    }
    for (const id of imageToolIds) {
      const activity = message.locator(`[data-work-tool-id="${id}"]`)
      await expect(activity).toBeVisible()
      expect(await activity.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(true)
      await expect(activity.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
      await expect(activity.locator('img')).toHaveCount(0)
      await activity.locator('button.logline').press('Enter')
      await expect.poll(() => activity.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width, height })
      await activity.locator('button.logline').press('Enter')
    }
    const generatedActivity = message.locator(`[data-work-tool-id="${generatedToolId}"]`)
    await expect(generatedActivity).toBeVisible()
    expect(await generatedActivity.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(true)
    await expect(generatedActivity.locator('.work-file-change-row')).toHaveAttribute('data-change-id', 'generated-image-change')
    await expect(generatedActivity.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(generatedActivity.locator('img')).toHaveCount(0)
    await generatedActivity.locator('button.logline').press('Enter')
    const generatedToolImage = generatedActivity.getByRole('button', { name: `放大查看 ${generatedToolAlt}`, exact: true })
    await expect.poll(() => generatedToolImage.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width: 160, height: 96 })
    await generatedToolImage.click()
    const generatedToolDialog = page.getByRole('dialog', { name: generatedToolAlt, exact: true })
    await expectImageDialogSettled(generatedToolDialog)
    await expect.poll(() => generatedToolDialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(160)
    await page.screenshot({ path: testInfo.outputPath('work-generated-tool-image-with-change.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(generatedToolDialog).toHaveCount(0)
    await expect(generatedToolImage).toBeFocused()
    await generatedActivity.locator('button.logline').press('Enter')
    await expect(generatedActivity.locator('img')).toHaveCount(0)
    const withImage = message.locator('[data-work-tool-id="browser-process-read-image"]')
    await withImage.locator('button.logline').press('Enter')
    const shot = withImage.getByRole('button', { name: '放大查看 页面截图', exact: true })
    await expect(shot).toBeVisible()
    await expect.poll(() => shot.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width, height })
    // Recreate the image row without changing the fixture's persisted history;
    // its explicit settled choice must survive both remounting and visibility.
    await process.press('Enter')
    await expect(withImage).toHaveCount(0)
    await process.press('Enter')
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    await expect(withImage.locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => shot.locator('img').evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width, height })
    await expect(withImage).not.toContainText('iVBORw0KGgo')
    await expectNoWorkRawData(message)
    await page.screenshot({ path: testInfo.outputPath('work-browser-operation-images.png'), animations: 'disabled' })
    await shot.click()
    const enlarged = page.getByRole('dialog', { name: '页面截图', exact: true })
    await expect.poll(() => enlarged.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(width)
    await expectImageDialogSettled(enlarged)
    await page.screenshot({ path: testInfo.outputPath('work-browser-read-screenshot-enlarged.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(enlarged).toHaveCount(0)
    await expect(shot).toBeFocused()
    // Focus returns before the exit animation finishes; reopening must cancel
    // that exit instead of being discarded by its delayed callback.
    await page.keyboard.press('Enter')
    await expect(enlarged).toBeVisible()
    await expect.poll(() => enlarged.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(width)
    await page.keyboard.press('Escape')
    await expect(enlarged).toHaveCount(0)
    for (const appearance of ['dark', 'light'] as const) {
      await setWorkAppearance(appearance)
      await expect(process).toHaveAttribute('aria-expanded', 'true')
      await expect(withImage.locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
      await expect(shot).toBeVisible()
      await expect(generated).toBeVisible()
      await expect(finalShot).toBeVisible()
      await message.screenshot({ path: testInfo.outputPath(`work-browser-process-expanded-${appearance}.png`), animations: 'disabled' })
    }
    await setWorkAppearance('dark')
    await withImage.locator('button.logline').press('Enter')
    await expect(withImage.locator('button.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(shot).toBeHidden()
    await process.press('Enter')
    for (const id of [...ordinary.map(receipt => receipt.id), ...imageToolIds, generatedToolId]) {
      await expect(message.locator(`[data-work-tool-id="${id}"]`)).toHaveCount(0)
    }
    await expect(generated).toBeVisible()
    await expect(finalShot).toBeVisible()
    await expect(message.locator('.md-image')).toHaveCount(0)
    await expect(deliverables.locator('[data-final-result-kind="image"]')).toHaveCount(2)
    await expectNoWorkRawData(message)
    await page.screenshot({ path: testInfo.outputPath('work-browser-process-collapsed.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })

  test('短内容展开不显示回到最新，溢出上滚保留停止入口，缩放和折叠重新判断且成果归属对应回复', async ({}, testInfo) => {
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      await page.emulateMedia({ reducedMotion })
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1200))
      await work().getByRole('button', { name: '新任务', exact: true }).click()
      await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(`滚动反馈 ${reducedMotion}`)
      const before = requests.length
      await work().getByRole('button', { name: '开始任务', exact: true }).click()
      await expect.poll(() => requests.length).toBe(before + 1)
      const conversation = work().getByRole('region', { name: '协作对话', exact: true })
      const scroll = conversation.locator('.work-conversation__scroll')
      const latest = conversation.getByRole('button', { name: '回到最新', exact: true })
      const dock = conversation.locator('.work-run-status')
      const feedback = conversation.locator('.work-turn-feedback')
      frame({ toolStart: { id: 'scroll-short-read', name: 'read_file', args: { path: 'outline.md' } } })
      frame({ toolEnd: { id: 'scroll-short-read', name: 'read_file', output: '已确认本次目标。', success: true } })
      frame({ content: '正在按要求检查页面。' })
      // A streamed write remains process evidence until explicitly delivered
      // after root success; it must not add height as a premature result card.
      frame({ toolStart: { id: 'scroll-result', name: 'write_file', args: { path: `result-${reducedMotion}.md` } } })
      frame({ fileChange: { id: `scroll-change-${reducedMotion}`, sessionId: run!.sessionId, turnId: run!.turnId, runId: run!.runId,
        toolCallId: 'scroll-result', path: `/remote/work-timeline/result-${reducedMotion}.md`, kind: 'write', oldContent: null,
        newContent: '本次任务的成果', isNew: true, truncated: false, status: 'pending', createdAt: Date.now() } })
      frame({ toolEnd: { id: 'scroll-result', name: 'write_file', output: '成果文件已写入。', success: true } })
      const summary = conversation.getByRole('region', { name: '最终交付物', exact: true })
      await expect(summary).toHaveCount(0)
      await expect(feedback).toBeVisible()
      await expect.poll(() => conversation.evaluate(element => {
        const status = element.querySelector('.work-turn-feedback')!
        const reply = element.querySelector('.work-conversation-turn .work-message--assistant')!
        return Boolean(reply.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)
          && reply.getBoundingClientRect().bottom <= status.getBoundingClientRect().top
      })).toBe(true)
      const process = conversation.locator('.work-message__process-toggle')
      if (await process.getAttribute('aria-expanded') !== 'true') await process.click()
      await expect(process).toHaveAttribute('aria-expanded', 'true')
      await conversation.locator('[data-work-tool-id="scroll-short-read"] button.logline').click()
      await expect(conversation.locator('[data-work-tool-id="scroll-short-read"]')).toContainText('已确认本次目标。')
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
      await expect(latest).toHaveCount(0)
      await expect(dock).toHaveCount(0)
      await expect(feedback.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
      await expect(feedback).toHaveAttribute('data-current-run-feedback', 'true')
      await page.screenshot({ path: testInfo.outputPath(`work-short-scroll-${reducedMotion}.png`), animations: 'disabled' })

      // The expanded process must overflow while its collapsed state still fits.
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 680))
      for (let index = 0; index < 12; index++) {
        frame({ toolStart: { id: `scroll-read-${index}`, name: 'read_file', args: { path: `detail-${index}.md` } } })
        frame({ toolEnd: { id: `scroll-read-${index}`, name: 'read_file', output: `已检查第 ${index + 1} 项。`, success: true } })
      }
      await expect(conversation.locator('[data-work-tool-id^="scroll-read-"]')).toHaveCount(12)
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(70)
      await scroll.hover({ position: { x: 400, y: 120 } })
      await page.mouse.wheel(0, -100_000)
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
      await expect(latest).toBeVisible()
      await expect(dock.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
      await expect(dock).toHaveAttribute('data-current-run-feedback', 'true')
      await expect(feedback).not.toHaveAttribute('data-current-run-feedback')
      await latest.click()
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2)
      await expect(latest).toHaveCount(0)
      await expect(dock).toHaveCount(0)
      await scroll.hover({ position: { x: 400, y: 120 } })
      await page.mouse.wheel(0, -100_000)
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
      await expect(latest).toBeVisible()

      // Window growth and disclosure collapse can remove overflow without
      // another user scroll; both must retire the duplicate fixed status.
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1200))
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
      await expect(latest).toHaveCount(0)
      await expect(dock).toHaveCount(0)
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 680))
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(70)
      await scroll.hover({ position: { x: 400, y: 120 } })
      await page.mouse.wheel(0, -100_000)
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
      await expect(latest).toBeVisible()
      await process.click()
      await expect(process).toHaveAttribute('aria-expanded', 'false')
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
      await expect(latest).toHaveCount(0)
      await expect(dock).toHaveCount(0)
      await expect(feedback.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
      await expect(summary).toHaveCount(0)
      frame({ content: '本轮页面检查完成。' })
      finish(finalResult(run!, '本轮页面检查完成。', [{ id: `scroll-delivery-${reducedMotion}`,
        path: `/remote/work-timeline/result-${reducedMotion}.md`, content: '本次任务的成果' }]))
      await expect(feedback).toHaveCount(0)
      await expect(summary).toBeVisible()
      await expect(summary.locator('[data-final-result-item]')).toHaveCount(1)
      expect(await summary.evaluate(element => {
        const owner = element.closest('.work-conversation-turn')!
        const reply = owner.querySelector('.work-message--assistant')!
        return Boolean(reply.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
          && reply.getBoundingClientRect().bottom <= element.getBoundingClientRect().top
      })).toBe(true)
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(errors).toEqual([])
  })
})
