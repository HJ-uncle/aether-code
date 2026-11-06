/** Real Electron + controlled HTTP: shared Code/Work FileTreeView interactions,
 * Work expansion/selection/filter/viewport persistence, session/root isolation,
 * failed/delayed directory recovery and equivalent Windows root spellings,
 * and bounded directory motion that never animates ordinary virtual scrolling. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineFileChange, FsEntry } from '../src/shared/ipc'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { createFileTreeScope, FILE_TREE_MEMORY_KEY, type FileTreeMemory } from '../src/renderer/src/core/workspace/file-tree-memory'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'file-tree-memory-fixture-token', modelId = 'file-tree-memory-model'
const sharedRoot = '/remote/tree-memory/shared', otherRoot = '/remote/tree-memory/other'
const codeSession = 'code-tree-memory'
const taskA = { id: 'work-tree-memory-a', title: '文件树记忆 A', root: sharedRoot }
const taskB = { id: 'work-tree-memory-b', title: '文件树记忆 B', root: sharedRoot }
const taskC = { id: 'work-tree-memory-c', title: '文件树记忆 C', root: otherRoot }
const taskWindows = { id: 'work-tree-memory-windows', title: 'Windows 路径记忆', root: 'D:\\Work\\Tree-Memory\\Shared' }
const taskTabs = { id: 'work-tree-memory-tabs', title: '标签布局回归', root: '/remote/tree-memory/tabs' }
const taskPopulated = { id: 'work-tree-memory-populated', title: '多成果标签回归', root: '/remote/tree-memory/populated' }
const windowsRootAlias = 'd:/work/tree-memory/shared'
const tasks = [taskA, taskB, taskC, taskWindows, taskTabs, taskPopulated]
const roots = new Map([[codeSession, sharedRoot], ...tasks.map(task => [task.id, task.root] as const)])
const now = Date.now() - 10_000
const directoryReads = new Map<string, number>()
const requestCounts = new Map<string, number>()
const directoryFailures = new Map<string, string>()
const directoryGates = new Map<string, { entered: boolean; wait: Promise<void>; release: () => void }>()
const fileReads: Array<{ sessionId: string; path: string }> = []
let populatedChanges: EngineFileChange[] = []
let populatedRefreshGate: { entered: number; wait: Promise<void>; release: () => void } | null = null
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = '', memorySource = ''
type TreeMemory = { root: string; path: string; filter: string; scrollTop: number }
let memoryA: TreeMemory, memoryB: TreeMemory, memoryC: TreeMemory
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const fileName = (index: number): string => `item-${String(index).padStart(3, '0')}.md`
const filePath = (workspace: string, index: number): string => `${workspace.replace(/\\/g, '/')}/collection/nested/${fileName(index)}`
const fixturePathKey = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}
function pauseNextDirectory(sessionId: string, directory: string) {
  let release = (): void => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const gate = { entered: false, wait, release }
  directoryGates.set(`${sessionId}:${directory}`, gate)
  return gate
}
function entries(directory: string, sessionId?: string): FsEntry[] {
  const entry = (name: string, path: string, isDirectory = false): FsEntry => ({ name, path, isDirectory, size: isDirectory ? 0 : 48, mtimeMs: now })
  if (directory === '.') return [entry('collection', 'collection', true), entry('notes', 'notes', true), entry('README.md', 'README.md')]
  if (directory === 'collection') return [entry('nested', 'collection/nested', true), entry('index.md', 'collection/index.md')]
  if (directory === 'collection/nested') return Array.from({ length: sessionId === taskTabs.id ? 400 : 120 }, (_, index) => entry(fileName(index), `collection/nested/${fileName(index)}`))
  if (directory === 'notes') return [entry('overview.md', 'notes/overview.md')]
  return []
}
function history(sessionId: string) {
  return [
    { id: `${sessionId}-user`, role: 'user', content: `查看 ${sessionId} 的工作目录`, conversationId: `${sessionId}-turn`, createdAt: now },
    { id: `${sessionId}-answer`, role: 'assistant', content: `TREE_READY_${sessionId}`, conversationId: `${sessionId}-turn`, createdAt: now + 1 }
  ]
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? codeSession)
    const requestKey = `${sessionId}:${request.method ?? 'GET'} ${path}${url.searchParams.has('view') ? `?view=${url.searchParams.get('view')}` : ''}`
    requestCounts.set(requestKey, (requestCounts.get(requestKey) ?? 0) + 1)
    const workspace = roots.get(sessionId) ?? sharedRoot
    if (path === '/api/v1/chat') throw new Error('File tree browsing must not send a chat request')
    if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/chat/admission/context') {
      response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId,
        namespace: { id: 'file-tree-memory', generation: 'one' },
        transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: null, predecessor: null })); return
    }
    if (path === '/api/v1/chat/admission/receipt') {
      response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: body.namespace,
        sessionId, requestKey: body.requestKey })); return
    }
    if (path === '/api/v1/workspace/bind') {
      if (roots.has(sessionId) && (typeof body.workspaceRoot !== 'string' || fixturePathKey(body.workspaceRoot) !== fixturePathKey(workspace))) throw new Error(`Wrong workspace binding for ${sessionId}`)
      response.end(envelope({ workspaceRoot: workspace })); return
    }
    if (path === '/api/v1/workspace/directory') {
      let directory = (url.searchParams.get('path') ?? '.').replace(/\\/g, '/')
      const normalizedRoot = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
      if (fixturePathKey(directory) === fixturePathKey(normalizedRoot)) directory = '.'
      else if (fixturePathKey(directory).startsWith(`${fixturePathKey(normalizedRoot)}/`)) directory = directory.slice(normalizedRoot.length + 1)
      if (/^(?:[A-Za-z]:|\/)/.test(directory)) throw new Error(`Directory request crossed root: ${sessionId} ${directory}`)
      const readKey = `${sessionId}:${directory}`
      directoryReads.set(readKey, (directoryReads.get(readKey) ?? 0) + 1)
      const gate = directoryGates.get(readKey)
      if (gate) { directoryGates.delete(readKey); gate.entered = true; await gate.wait }
      const failure = directoryFailures.get(readKey)
      if (failure) {
        directoryFailures.delete(readKey)
        response.writeHead(503).end(JSON.stringify({ code: 503, message: failure, data: null })); return
      }
      response.end(envelope({ root: workspace, entries: entries(directory, sessionId), bindingEpoch: `epoch-${sessionId}` })); return
    }
    if (path === '/api/v1/workspace/file/content') {
      const relative = url.searchParams.get('path') ?? ''
      if (relative.startsWith('/') && !relative.startsWith(`${workspace}/`)) throw new Error(`File request crossed root: ${sessionId} ${relative}`)
      fileReads.push({ sessionId, path: relative.replace(`${workspace}/`, '') })
      const content = `# ${basename(relative)}\n\nSESSION=${sessionId}\nPATH=${relative}\n`
      response.end(envelope({ content, isBinary: false, totalSize: Buffer.byteLength(content), truncated: false })); return
    }
    if (path === '/api/v1/changes' && sessionId === taskPopulated.id) {
      if (populatedRefreshGate) { const gate = populatedRefreshGate; gate.entered++; await gate.wait }
      response.end(envelope(url.searchParams.get('view') === 'net' ? populatedChanges.filter(change => change.status === 'pending') : populatedChanges)); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'8'.repeat(64)}`, protocolVersion: 1,
        toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'file-tree-memory-fixture' }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '文件树验收模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true,
        history: history(sessionId), runs: [], projection: [], todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/conversation/history' ? history(sessionId)
      : path === '/api/v1/conversation/sessions' ? [{ sessionId: codeSession, title: 'Code 树记忆', lastAt: now, messageCount: 2 }]
      : path === '/api/v1/chat/status' ? { running: false, finished: true }
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
      : path === '/api/v1/git/binding' ? { root: workspace, epoch: `epoch-${sessionId}`, contractVersion: 2, mutationRequiresBinding: true }
      : path === '/api/v1/git/status' ? { success: true, isRepo: false, files: [] }
      : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
      : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

const work = () => page.locator('.work-view')
const workPanel = () => work().getByRole('region', { name: '工作区文件', exact: true })
const workTree = () => workPanel().locator('.explorer__tree')
const workFilter = () => workPanel().getByRole('textbox', { name: '筛选文件', exact: true })
const rowAt = (tree: Locator, path: string): Locator => tree.locator(`[role="treeitem"][data-path=${JSON.stringify(path)}]`)
async function savedWorkMemory(task: typeof taskA, workspace = task.root): Promise<FileTreeMemory> {
  const key = createFileTreeScope('work', memorySource, task.id, workspace).key
  return page.evaluate(({ storageKey, key }) => {
    const table: Record<string, FileTreeMemory> = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!table[key]) throw new Error(`Missing file tree memory: ${key}`)
    return table[key]
  }, { storageKey: FILE_TREE_MEMORY_KEY, key })
}
async function chooseWorkspaceTab(name: '工作区' | '资料'): Promise<void> {
  const tab = work().getByRole('tab', { name, exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    const open = work().getByRole('button', { name: '打开工作区', exact: true })
    if (await open.isVisible()) await open.click()
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
}
async function openTask(task: typeof taskA): Promise<void> {
  const expand = work().getByRole('button', { name: '展开 Work 导航', exact: true })
  if (await expand.isVisible()) await expand.click()
  await work().locator('.work-sidebar__task').filter({ hasText: task.title }).click()
  await expect(work().getByRole('heading', { name: task.title, exact: true })).toBeVisible()
  await chooseWorkspaceTab('工作区')
  await expect(workPanel()).toHaveAttribute('data-session-id', task.id)
  await expect(workTree()).toBeVisible()
  await expect(workTree()).toHaveAttribute('aria-busy', 'false')
}
async function expandNested(tree: Locator, workspace: string): Promise<void> {
  await tree.evaluate(element => { element.scrollTop = 0 })
  const normalizedRoot = workspace.replace(/\\/g, '/')
  for (const path of [workspace, `${normalizedRoot}/collection`, `${normalizedRoot}/collection/nested`]) {
    const row = rowAt(tree, path)
    if (path === workspace && await row.count() === 0) continue
    await expect(row).toBeVisible()
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(rowAt(tree, filePath(workspace, 0))).toBeVisible()
}
async function rememberWorkSelection(task: typeof taskA, index: number, filter: string): Promise<TreeMemory> {
  const tree = workTree()
  await expandNested(tree, task.root)
  await workFilter().fill(filter)
  await tree.evaluate((element, top) => { element.scrollTop = top }, Math.max(0, (index - 3) * 30))
  const path = filePath(task.root, index), selected = rowAt(tree, path)
  await expect(selected).toBeVisible()
  await selected.click()
  await expect(selected).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => fileReads.some(read => read.sessionId === task.id && read.path === `collection/nested/${fileName(index)}`)).toBe(true)
  const scrollTop = await tree.evaluate(element => element.scrollTop)
  expect(scrollTop).toBeGreaterThan(100)
  return { root: task.root, path, filter, scrollTop }
}
async function expectWorkMemory(memory: TreeMemory): Promise<void> {
  await expect(workFilter()).toHaveValue(memory.filter)
  await expect.poll(() => workTree().evaluate((element, top) => Math.abs(element.scrollTop - top), memory.scrollTop),
    { message: '加载展开目录后应恢复同一树滚动位置' }).toBeLessThanOrEqual(3)
  await expect(rowAt(workTree(), memory.path)).toHaveAttribute('aria-selected', 'true')
  await expect(rowAt(workTree(), memory.path)).toBeInViewport()
  expect(await workTree().getByRole('treeitem').count()).toBeLessThan(90)
}
async function expectFreshWorkTree(task: typeof taskA): Promise<void> {
  await expect(workFilter()).toHaveValue('')
  await expect.poll(() => workTree().evaluate(element => element.scrollTop)).toBe(0)
  await expect(rowAt(workTree(), `${task.root}/collection`)).toHaveAttribute('aria-expanded', 'false')
  await expect(workTree().locator('[aria-selected="true"]')).toHaveCount(0)
}

function observeTreeMotion(tree: Locator, eventName: 'mousedown' | 'scroll', branchPath?: string, followPath?: string) {
  return tree.evaluate((element, { eventName, branchPath, followPath }) => new Promise<{
    started: boolean; events: number; interrupted: number; ghostLayers: number; ghostRows: number; enters: number; settles: number
    duplicateRows: number; staleLabels: number; labelOverlaps: number; maxRows: number; duration: number; minOpacity: number
    followShift: number; followTravel: number; finalAnimations: number; finalGhosts: number
    childRows: number; repeatedChildren: number; maxChildSamples: number; maxChildShift: number
  }>(resolve => {
    const body = element.closest('.explorer__body')!
    const animatedRows = '.tree-row--branch-enter, .tree-row--branch-settle'
    const findRow = (path?: string): HTMLElement | undefined => Array.from(element.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(row => row.dataset.path === path)
    const removedNames = new Set(Array.from(element.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .filter(row => branchPath && row.dataset.path?.startsWith(`${branchPath}/`))
      .map(row => row.querySelector('.tree-row__name')?.textContent?.trim()).filter((name): name is string => Boolean(name)))
    const followTops: number[] = []
    const childPositions = new Map<string, { minimum: number; maximum: number; samples: number }>()
    const result = { started: false, events: 0, interrupted: 0, ghostLayers: 0, ghostRows: 0, enters: 0, settles: 0,
      duplicateRows: 0, staleLabels: 0, labelOverlaps: 0, maxRows: 0, duration: 0, minOpacity: 1,
      followShift: 0, followTravel: 0, finalAnimations: 0, finalGhosts: 0,
      childRows: 0, repeatedChildren: 0, maxChildSamples: 0, maxChildShift: 0 }
    const timeout = setTimeout(() => {
      element.removeEventListener(eventName, start, true)
      element.removeAttribute('data-motion-observing')
      resolve(result)
    }, 5_000)
    function start(): void {
      result.events++
      if (result.started) { if (element.querySelector(animatedRows)) result.interrupted++; return }
      clearTimeout(timeout)
      result.started = true
      const began = performance.now()
      const sample = (): void => {
        const rows = Array.from(element.querySelectorAll<HTMLElement>('[role="treeitem"]'))
        const rowsByPath = new Map(rows.map(row => [row.dataset.path, row]))
        for (const row of rows) {
          result.minOpacity = Math.min(result.minOpacity, Number.parseFloat(getComputedStyle(row).opacity))
          const path = row.dataset.path
          if (!branchPath || !path?.startsWith(`${branchPath}/`)) continue
          const parent = rowsByPath.get(path.slice(0, path.lastIndexOf('/')))
          if (!parent) continue
          // Relative geometry excludes whole-tree scrolling or panel movement;
          // a mounted child must not receive a second slide of its own.
          const relativeTop = row.getBoundingClientRect().top - parent.getBoundingClientRect().top
          const previous = childPositions.get(path)
          childPositions.set(path, previous ? {
            minimum: Math.min(previous.minimum, relativeTop), maximum: Math.max(previous.maximum, relativeTop), samples: previous.samples + 1
          } : { minimum: relativeTop, maximum: relativeTop, samples: 1 })
        }
        result.ghostLayers = Math.max(result.ghostLayers, body.querySelectorAll('.file-tree-motion').length)
        result.ghostRows = Math.max(result.ghostRows, body.querySelectorAll('.file-tree-motion__row').length)
        result.enters = Math.max(result.enters, element.querySelectorAll('.tree-row--branch-enter').length)
        result.settles = Math.max(result.settles, element.querySelectorAll('.tree-row--branch-settle').length)
        result.maxRows = Math.max(result.maxRows, rows.length)
        result.duplicateRows = Math.max(result.duplicateRows, rows.length - new Set(rows.map(row => row.dataset.path)).size)
        if (branchPath && findRow(branchPath)?.getAttribute('aria-expanded') === 'false') {
          const stale = Array.from(body.querySelectorAll('span')).filter(span =>
            !span.closest('.explorer__sticky') && removedNames.has(span.textContent?.trim() ?? ''))
          result.staleLabels = Math.max(result.staleLabels, stale.length)
        }
        // Sticky ancestors intentionally cover the top rows. All other labels
        // must remain separated, including during the first collapse frames.
        const labels = Array.from(body.querySelectorAll('.tree-row__name, .file-tree-motion__row > span:last-child'))
          .filter(label => !label.closest('.explorer__sticky')).map(label => label.getBoundingClientRect())
          .filter(rect => rect.width > 0 && rect.height > 0).sort((left, right) => left.top - right.top)
        result.labelOverlaps = Math.max(result.labelOverlaps, labels.slice(1).filter((rect, index) => rect.top < labels[index].bottom - 0.5).length)
        for (const row of element.querySelectorAll(animatedRows)) {
          const style = getComputedStyle(row)
          result.duration = Math.max(result.duration, ...style.animationDuration.split(',').map(value => Number.parseFloat(value)))
        }
        const follow = findRow(followPath)
        if (follow?.classList.contains('tree-row--branch-settle')) followTops.push(follow.getBoundingClientRect().top)
        if (performance.now() - began < 300) requestAnimationFrame(sample)
        else {
          element.removeEventListener(eventName, start, true)
          element.removeAttribute('data-motion-observing')
          result.finalAnimations = element.querySelectorAll(animatedRows).length
          result.finalGhosts = body.querySelectorAll('.file-tree-motion, .file-tree-motion__row').length
          result.childRows = childPositions.size
          for (const position of childPositions.values()) {
            if (position.samples > 1) result.repeatedChildren++
            result.maxChildSamples = Math.max(result.maxChildSamples, position.samples)
            result.maxChildShift = Math.max(result.maxChildShift, position.maximum - position.minimum)
          }
          if (follow && followTops.length) {
            const maximum = Math.max(...followTops), minimum = Math.min(...followTops)
            result.followShift = maximum - follow.getBoundingClientRect().top
            result.followTravel = maximum - minimum
          }
          resolve(result)
        }
      }
      requestAnimationFrame(sample)
    }
    element.addEventListener(eventName, start, { capture: true })
    element.setAttribute('data-motion-observing', 'true')
  }), { eventName, branchPath, followPath })
}

function observeWorkspaceTabLayout(workspace: Locator) {
  return workspace.evaluate(element => new Promise<{
    clicks: Array<{ target: string; at: number; firstCorrectLayoutMs: number | null; superseded: boolean }>
    frames: Array<{ at: number; gap: number; active: string | null; sized: number; topOffset: number | null; heightError: number | null;
      slotHeight: number; activeHeight: number | null; opacity: number | null; hiddenSized: number; hiddenFocusable: number; hiddenPointerHits: number;
      panes: Array<{ id: string; hidden: boolean; top: number; height: number; width: number }> }>
    timedOut: boolean
  }>(resolve => {
    const result: { clicks: Array<{ target: string; at: number; firstCorrectLayoutMs: number | null; superseded: boolean }>;
      frames: Array<{ at: number; gap: number; active: string | null; sized: number; topOffset: number | null; heightError: number | null;
        slotHeight: number; activeHeight: number | null; opacity: number | null; hiddenSized: number; hiddenFocusable: number; hiddenPointerHits: number;
        panes: Array<{ id: string; hidden: boolean; top: number; height: number; width: number }> }>; timedOut: boolean } = { clicks: [], frames: [], timedOut: false }
    let began = 0, lastClick = 0, lastFrame = 0, frame = 0
    const finish = (): void => {
      clearTimeout(timeout)
      cancelAnimationFrame(frame)
      document.removeEventListener('click', onClick, true)
      element.removeAttribute('data-tabs-observing')
      resolve(result)
    }
    const timeout = setTimeout(() => { result.timedOut = true; finish() }, 5_000)
    const sample = (): void => {
      const now = performance.now(), shell = element.getBoundingClientRect()
      const strip = element.querySelector('.work-workspace__tab-strip')!.getBoundingClientRect()
      const shellStyle = getComputedStyle(element)
      const slotBottom = shell.bottom - Number.parseFloat(shellStyle.borderBottomWidth) - Number.parseFloat(shellStyle.paddingBottom)
      const slotHeight = slotBottom - strip.bottom
      const nodes = Array.from(element.querySelectorAll<HTMLElement>('.work-workspace__body[role="tabpanel"]'))
      const activeId = element.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls') ?? null
      const active = nodes.find(node => node.id === activeId), activeRect = active?.getBoundingClientRect()
      const panes = nodes.map(node => { const rect = node.getBoundingClientRect(); return { id: node.id, hidden: node.hidden, top: rect.top, height: rect.height, width: rect.width } })
      const hidden = nodes.filter(node => node.id !== activeId)
      let hiddenFocusable = 0, hiddenPointerHits = 0
      for (const node of hidden) {
        if (!node.closest('[inert]')) hiddenFocusable += Array.from(node.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
          .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0).length
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)))
          if (hit && node.contains(hit)) hiddenPointerHits++
        }
      }
      const row = { at: now - began, gap: lastFrame ? now - lastFrame : now - began, active: activeId,
        sized: panes.filter(pane => pane.width > 0 && pane.height > 0).length,
        topOffset: activeRect ? activeRect.top - strip.bottom : null, heightError: activeRect ? activeRect.height - slotHeight : null,
        slotHeight, activeHeight: activeRect?.height ?? null, opacity: active ? Number.parseFloat(getComputedStyle(active).opacity) : null,
        hiddenSized: panes.filter(pane => pane.id !== activeId && pane.width > 0 && pane.height > 0).length,
        hiddenFocusable, hiddenPointerHits, panes }
      result.frames.push(row)
      lastFrame = now
      const click = result.clicks.at(-1)
      if (click && click.firstCorrectLayoutMs === null && activeId === click.target && row.sized === 1 &&
        row.topOffset !== null && Math.abs(row.topOffset) <= 1 && row.heightError !== null && Math.abs(row.heightError) <= 1 &&
        row.opacity === 1 && row.hiddenSized === 0 && row.hiddenFocusable === 0 && row.hiddenPointerHits === 0) click.firstCorrectLayoutMs = now - began - click.at
      if (now - began >= 400 && now - lastClick >= 300) finish()
      else frame = requestAnimationFrame(sample)
    }
    function onClick(event: MouseEvent): void {
      const control = event.target instanceof Element ? event.target.closest('[role="tab"], [role="menuitem"]') : null
      if (!control) return
      const target = control.getAttribute('aria-controls') ?? (control.getAttribute('role') === 'menuitem' && control.textContent?.trim() === '成果' ? 'work-panel-files' : null)
      if (target !== 'work-panel-files' && target !== 'work-panel-workspace') return
      if (control.getAttribute('role') === 'tab' && !element.contains(control)) return
      const now = performance.now()
      const previous = result.clicks.at(-1)
      if (previous && previous.firstCorrectLayoutMs === null) previous.superseded = true
      if (!began) began = now
      lastClick = now
      result.clicks.push({ target, at: now - began, firstCorrectLayoutMs: null, superseded: false })
      if (result.clicks.length === 1) frame = requestAnimationFrame(sample)
    }
    document.addEventListener('click', onClick, true)
    element.setAttribute('data-tabs-observing', 'true')
  }))
}

test.describe.serial('Code 与 Work 文件树状态记忆', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    memorySource = source
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'file-tree-memory-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: sharedRoot, autoStartEngine: true, lastSessionId: codeSession, lastModelId: modelId, lastFolder: '', appearance: 'dark' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'file-tree-memory', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ stateKey, codeKey, taskRows, codeId }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: taskRows, activeTaskId: taskRows[0].id }))
      localStorage.setItem(codeKey, codeId)
      // This fixture starts in Work; mode-switch keyboard focus is unrelated
      // to the file-tree contracts exercised below.
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'workspace', pane: 'workspace', ratio: 56 }))
    }, { stateKey: `aether.work.state.v1:${encodeURIComponent(source)}`, codeKey: sessionStorageKey('aether:lastSessionId', source), codeId: codeSession,
      taskRows: tasks.map(task => ({ id: task.id, title: task.title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: task.root, modelId, attachments: [], sources: [] })) })
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    await openTask(taskA)
  })
  test.afterEach(() => { health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('file-tree-memory-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('Work 展开嵌套目录并选择滚动后的文件，切标签与刷新保留筛选、选中和视口', async ({}, info) => {
    await expectFreshWorkTree(taskA)
    memoryA = await rememberWorkSelection(taskA, 80, 'item-')
    await chooseWorkspaceTab('资料')
    await expect(workPanel()).toBeHidden()
    await chooseWorkspaceTab('工作区')
    await expectWorkMemory(memoryA)
    const before = directoryReads.get(`${taskA.id}:collection/nested`) ?? 0
    await workPanel().getByRole('button', { name: '刷新工作区文件', exact: true }).click()
    await expect.poll(() => directoryReads.get(`${taskA.id}:collection/nested`) ?? 0).toBeGreaterThan(before)
    await expect(workTree()).toHaveAttribute('aria-busy', 'false')
    await expectWorkMemory(memoryA)
    await page.screenshot({ path: info.outputPath('work-tree-memory-refresh.png'), animations: 'disabled' })
  })

  test('同根不同会话与异根会话分别记忆，切回和页面重载后恢复展开、选中、筛选和滚动', async ({}, info) => {
    await openTask(taskB)
    await expectFreshWorkTree(taskB)
    memoryB = await rememberWorkSelection(taskB, 22, 'item-0')
    await openTask(taskC)
    await expectFreshWorkTree(taskC)
    memoryC = await rememberWorkSelection(taskC, 45, 'item-')
    await expect(workTree().locator(`[data-path^="${sharedRoot}/"]`)).toHaveCount(0)
    await openTask(taskA); await expectWorkMemory(memoryA)
    await expect(workTree().locator(`[data-path^="${otherRoot}/"]`)).toHaveCount(0)
    await openTask(taskB); await expectWorkMemory(memoryB)
    await openTask(taskC); await expectWorkMemory(memoryC)
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(workPanel()).toHaveAttribute('data-session-id', taskC.id)
    await expectWorkMemory(memoryC)
    await openTask(taskA); await expectWorkMemory(memoryA)
    await openTask(taskB); await expectWorkMemory(memoryB)
    await openTask(taskA); await expectWorkMemory(memoryA)
    await page.screenshot({ path: info.outputPath('work-tree-memory-restored.png'), animations: 'disabled' })
  })

  test('Code 共用虚拟树仍能展开和打开文件，保留旧展开记忆且与同根 Work 选择互不覆盖', async ({}, info) => {
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    const code = page.locator('.mode-surface[data-mode="code"]')
    const explorer = code.locator('.explorer'), tree = explorer.locator('.explorer__tree')
    await expect(tree).toBeVisible()
    await expect(rowAt(tree, `${sharedRoot}/collection`)).toHaveAttribute('aria-expanded', 'false')
    await expect(tree.locator('[aria-selected="true"]')).toHaveCount(0)
    await expandNested(tree, sharedRoot)
    await explorer.getByRole('button', { name: '按名称筛选（在已加载的树内过滤）', exact: true }).click()
    const filter = explorer.getByPlaceholder('筛选文件名…', { exact: true })
    await filter.fill('item-0')
    await tree.evaluate(element => { element.scrollTop = 1_680 })
    const selected = rowAt(tree, filePath(sharedRoot, 60))
    await expect(selected).toBeVisible()
    await selected.click()
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect(code.locator('.editor-tab.is-active')).toContainText('item-060.md')
    await expect.poll(() => fileReads.some(read => read.sessionId === codeSession && read.path === 'collection/nested/item-060.md')).toBe(true)
    const codeScroll = await tree.evaluate(element => element.scrollTop)
    expect(codeScroll).toBeGreaterThan(1_000)
    await expect.poll(() => page.evaluate(workspace => {
      const parsed: unknown = JSON.parse(localStorage.getItem('aether.expandedDirs') ?? '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      return (parsed as Record<string, unknown>)[workspace]
    }, sharedRoot)).toEqual(expect.arrayContaining([sharedRoot, `${sharedRoot}/collection`, `${sharedRoot}/collection/nested`]))
    await explorer.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(filter).toHaveValue('item-0')
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expectWorkMemory(memoryA)
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(filter).toHaveValue('item-0')
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => tree.evaluate((element, top) => Math.abs(element.scrollTop - top), codeScroll)).toBeLessThanOrEqual(3)
    expect(await tree.getByRole('treeitem').count()).toBeLessThan(90)
    await page.screenshot({ path: info.outputPath('code-shared-file-tree-memory.png'), animations: 'disabled' })
    const beforeReload = directoryReads.get(`${codeSession}:collection/nested`) ?? 0
    await page.reload()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(tree).toBeVisible()
    await expect.poll(() => directoryReads.get(`${codeSession}:collection/nested`) ?? 0).toBeGreaterThan(beforeReload)
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect(selected).toBeInViewport()
    await expect.poll(() => tree.evaluate((element, top) => Math.abs(element.scrollTop - top), codeScroll),
      { message: 'Code 应等待深层目录恢复完毕，再恢复选中项和滚动位置' }).toBeLessThanOrEqual(3)
    // The restored viewport is deep inside nested. Its sticky ancestor rows
    // prove the actual expanded tree without scrolling away from the memory.
    for (const path of [`${sharedRoot}/collection`, `${sharedRoot}/collection/nested`]) {
      await expect(explorer.locator(`.explorer__sticky [role="treeitem"][data-path="${path}"]`)).toHaveAttribute('aria-expanded', 'true')
    }
    await expect(code.locator('.editor-tab.is-active')).toContainText('item-060.md')
    expect(await tree.getByRole('treeitem').count()).toBeLessThan(90)
    await page.screenshot({ path: info.outputPath('code-shared-file-tree-reloaded.png'), animations: 'disabled' })
  })

  test('Code 与 Work 展开目录无二次位移，收起与快速开合无重叠且滚动和减少动态效果不误动画', async ({}, info) => {
    for (const mode of ['work', 'code'] as const) {
      await page.getByRole('tab', { name: mode === 'work' ? 'Work 办公' : 'Code 开发', exact: true }).click()
      if (mode === 'work') { await openTask(taskA); await workFilter().fill('') }
      const host = mode === 'work' ? workPanel() : page.locator('.mode-surface[data-mode="code"] .explorer')
      const tree = host.locator('.explorer__tree')
      if (mode === 'code') {
        const filter = host.getByPlaceholder('筛选文件名…', { exact: true })
        if (!await filter.isVisible()) await host.getByRole('button', { name: '按名称筛选（在已加载的树内过滤）', exact: true }).click()
        await filter.fill('')
      }
      await expandNested(tree, sharedRoot)
      const animatedRows = tree.locator('.tree-row--branch-enter, .tree-row--branch-settle')
      await expect(animatedRows).toHaveCount(0)
      const limit = await tree.evaluate(element => Math.ceil(element.clientHeight / 30) + 21)
      const branchPath = `${sharedRoot}/collection/nested`, followPath = `${sharedRoot}/collection/index.md`
      const nested = rowAt(tree, branchPath)
      const closing = observeTreeMotion(tree, 'mousedown', branchPath, followPath)
      await nested.click()
      const closed = await closing
      await info.attach(`${mode}-tree-closing-motion`, { body: JSON.stringify(closed, null, 2), contentType: 'application/json' })
      expect(closed.started).toBe(true)
      expect(closed.ghostLayers).toBe(0)
      expect(closed.ghostRows).toBe(0)
      expect(closed.staleLabels).toBe(0)
      expect(closed.duplicateRows).toBe(0)
      expect(closed.labelOverlaps).toBe(0)
      expect(closed.enters).toBe(0)
      expect(closed.settles).toBeGreaterThan(0)
      expect(closed.maxRows).toBeLessThanOrEqual(limit)
      expect(closed.duration).toBeGreaterThan(0)
      expect(closed.duration).toBeLessThanOrEqual(0.12)
      expect(closed.minOpacity, '收起滑动期间真实行应始终完全不透明').toBe(1)
      expect(closed.followShift, '后续真实文件应从最多4px的偏移滑回自身行位').toBeGreaterThan(0.1)
      expect(closed.followShift).toBeLessThanOrEqual(4.5)
      expect(closed.followTravel).toBeGreaterThan(0.1)
      expect(closed.finalAnimations).toBe(0)
      expect(closed.finalGhosts).toBe(0)
      await expect(nested).toHaveAttribute('aria-expanded', 'false')
      await expect(rowAt(tree, filePath(sharedRoot, 0))).toHaveCount(0)
      await expect(rowAt(tree, followPath)).toBeVisible()
      const opening = observeTreeMotion(tree, 'mousedown', branchPath)
      await nested.click()
      const opened = await opening
      await info.attach(`${mode}-tree-opening-motion`, { body: JSON.stringify(opened, null, 2), contentType: 'application/json' })
      expect(opened.started).toBe(true)
      expect(opened.enters).toBe(0)
      expect(opened.settles).toBe(0)
      expect(opened.maxRows).toBeLessThanOrEqual(limit)
      expect(opened.duration).toBe(0)
      expect(opened.childRows, '必须实际捕获展开后的子项，不能只检查空动画class').toBeGreaterThan(0)
      expect(opened.repeatedChildren).toBeGreaterThan(0)
      expect(opened.maxChildSamples).toBeGreaterThan(1)
      expect(opened.maxChildShift, '已挂载子项相对父目录的位置不应再次滑动').toBeLessThanOrEqual(0.5)
      expect(opened.minOpacity, '展开后的所有真实行应始终完全不透明').toBe(1)
      expect(opened.labelOverlaps).toBe(0)
      expect(opened.ghostLayers).toBe(0)
      expect(opened.finalAnimations).toBe(0)
      await expect(animatedRows).toHaveCount(0)

      await tree.evaluate(element => { element.scrollTop = 0 })
      await expect(nested).toBeInViewport()
      const [nestedBox, treeBox, viewport] = await Promise.all([
        nested.boundingBox(), tree.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      ])
      if (!nestedBox || !treeBox) throw new Error('Missing visible directory row for rapid-toggle regression')
      // A long filename can make the row wider than the clipped tree. Native
      // input must hit the visible intersection rather than that full row's center.
      const left = Math.max(nestedBox.x, treeBox.x, 0)
      const right = Math.min(nestedBox.x + nestedBox.width, treeBox.x + treeBox.width, viewport.width)
      const top = Math.max(nestedBox.y, treeBox.y, 0)
      const bottom = Math.min(nestedBox.y + nestedBox.height, treeBox.y + treeBox.height, viewport.height)
      expect(right - left).toBeGreaterThan(0)
      expect(bottom - top).toBeGreaterThan(0)
      const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="treeitem"]')?.getAttribute('data-path'), point)).toBe(branchPath)
      const rapid = observeTreeMotion(tree, 'mousedown', branchPath)
      await expect(tree).toHaveAttribute('data-motion-observing', 'true')
      // Native double click delivers the second toggle while the first motion
      // is still active; locator.click would wait for that motion to settle.
      await page.mouse.dblclick(point.x, point.y)
      const toggled = await rapid
      await info.attach(`${mode}-tree-rapid-motion`, { body: JSON.stringify({ point, ...toggled }, null, 2), contentType: 'application/json' })
      expect(toggled.events).toBe(2)
      expect(toggled.interrupted).toBeGreaterThan(0)
      expect(toggled.enters).toBe(0)
      expect(toggled.ghostLayers).toBe(0)
      expect(toggled.ghostRows).toBe(0)
      expect(toggled.staleLabels).toBe(0)
      expect(toggled.duplicateRows).toBe(0)
      expect(toggled.labelOverlaps).toBe(0)
      expect(toggled.minOpacity, '快速开合不应触发任何淡入淡出').toBe(1)
      expect(toggled.maxRows).toBeLessThanOrEqual(limit)
      expect(toggled.finalAnimations).toBe(0)
      expect(toggled.finalGhosts).toBe(0)
      await expect(nested).toHaveAttribute('aria-expanded', 'true')
      await expect(rowAt(tree, filePath(sharedRoot, 0))).toBeVisible()
      const scrolling = observeTreeMotion(tree, 'scroll')
      await tree.evaluate(element => { element.scrollTop = 900 })
      const scrolled = await scrolling
      expect(scrolled.started).toBe(true)
      expect(scrolled.ghostLayers).toBe(0)
      expect(scrolled.ghostRows).toBe(0)
      expect(scrolled.enters).toBe(0)
      expect(scrolled.settles).toBe(0)
      expect(scrolled.duplicateRows).toBe(0)
      expect(scrolled.labelOverlaps).toBe(0)
      expect(scrolled.maxRows).toBeLessThanOrEqual(limit)
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await openTask(taskA)
    await expandNested(workTree(), sharedRoot)
    const reducedClose = observeTreeMotion(workTree(), 'mousedown', `${sharedRoot}/collection/nested`)
    await rowAt(workTree(), `${sharedRoot}/collection/nested`).click()
    const reduced = await reducedClose
    expect(reduced.started).toBe(true)
    expect(reduced.ghostLayers).toBe(0)
    expect(reduced.ghostRows).toBe(0)
    expect(reduced.enters).toBe(0)
    expect(reduced.settles).toBe(0)
    expect(reduced.staleLabels).toBe(0)
    expect(reduced.labelOverlaps).toBe(0)
    await expect(rowAt(workTree(), filePath(sharedRoot, 0))).toHaveCount(0)
    const reducedOpen = observeTreeMotion(workTree(), 'mousedown')
    await rowAt(workTree(), `${sharedRoot}/collection/nested`).click()
    const reopened = await reducedOpen
    expect(reopened.started).toBe(true)
    expect(reopened.enters).toBe(0)
    expect(reopened.settles).toBe(0)
    expect(reopened.ghostLayers).toBe(0)
    await expect(rowAt(workTree(), filePath(sharedRoot, 0))).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  test('Work 点击 Windows 混合分隔符的子目录开关时祖先始终保持展开', async () => {
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await openTask(taskWindows)
    await workFilter().fill('')
    await workTree().evaluate(element => { element.scrollTop = 0 })
    const rootRow = rowAt(workTree(), taskWindows.root)
    const slashRoot = taskWindows.root.replace(/\\/g, '/')
    const collection = rowAt(workTree(), `${slashRoot}/collection`)
    const nested = rowAt(workTree(), `${slashRoot}/collection/nested`)
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'false')

    await collection.click()
    await expect(rootRow, '首次打开正斜杠子目录不能收起反斜杠根目录').toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'true')
    await expect(nested).toHaveAttribute('aria-expanded', 'false')
    await nested.click()
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'true')
    await expect(nested).toHaveAttribute('aria-expanded', 'true')
    await expect(rowAt(workTree(), filePath(taskWindows.root, 0))).toBeVisible()

    await nested.click()
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'true')
    await expect(nested).toHaveAttribute('aria-expanded', 'false')
    await expect(rowAt(workTree(), filePath(taskWindows.root, 0))).toHaveCount(0)
    await nested.click()
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'true')
    await expect(rowAt(workTree(), filePath(taskWindows.root, 0))).toBeVisible()

    await collection.click()
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'false')
    await expect(nested).toHaveCount(0)
    await collection.click()
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
    await expect(collection).toHaveAttribute('aria-expanded', 'true')
    await expect(nested).toHaveAttribute('aria-expanded', 'true')
    await expect(rowAt(workTree(), filePath(taskWindows.root, 0))).toBeVisible()
    await expect(workPanel().getByRole('alert')).toHaveCount(0)
  })

  test('Work 刷新目录临时失败保留展开、选中与视口，重试继续读取原来的深层分支', async () => {
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await openTask(taskA)
    await workFilter().fill('')
    const remembered = await rememberWorkSelection(taskA, 32, 'item-')
    const expectedExpanded = [sharedRoot, `${sharedRoot}/collection`, `${sharedRoot}/collection/nested`]
    const collectionKey = `${taskA.id}:collection`, nestedKey = `${taskA.id}:collection/nested`
    const beforeCollection = directoryReads.get(collectionKey) ?? 0
    const beforeNested = directoryReads.get(nestedKey) ?? 0
    directoryFailures.set(collectionKey, 'TREE_DIRECTORY_TEMPORARY_FAILURE')
    await workPanel().getByRole('button', { name: '刷新工作区文件', exact: true }).click()
    await expect(workPanel().getByRole('alert')).toContainText('TREE_DIRECTORY_TEMPORARY_FAILURE')
    await expect(workTree()).toHaveAttribute('aria-busy', 'false')
    expect(directoryReads.get(collectionKey)).toBeGreaterThan(beforeCollection)
    expect(directoryFailures.has(collectionKey)).toBe(false)
    await expectWorkMemory(remembered)
    expect((await savedWorkMemory(taskA)).expanded).toEqual(expect.arrayContaining(expectedExpanded))

    await workPanel().getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => directoryReads.get(nestedKey) ?? 0,
      { message: '重试必须沿原展开分支重新读取深层目录，不能仅显示遗留缓存' }).toBeGreaterThan(beforeNested)
    await expect(workTree()).toHaveAttribute('aria-busy', 'false')
    await expect(workPanel().getByRole('alert')).toHaveCount(0)
    await expectWorkMemory(remembered)
    expect((await savedWorkMemory(taskA)).expanded).toEqual(expect.arrayContaining(expectedExpanded))
  })

  test('Work 延迟恢复旧目录时保留用户刚展开的其他分支与新文件选择', async () => {
    await openTask(taskB)
    await workFilter().fill('')
    await rememberWorkSelection(taskB, 22, '')
    // Start from a remembered deep selection, but leave the root rows visible
    // so a user can make a different choice while restoration is still busy.
    await workTree().evaluate(element => { element.scrollTop = 0 })
    await expect.poll(async () => (await savedWorkMemory(taskB)).scrollTop).toBe(0)
    const gate = pauseNextDirectory(taskB.id, 'collection')
    try {
      await page.reload()
      await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
      await expect(workPanel()).toHaveAttribute('data-session-id', taskB.id)
      await expect.poll(() => gate.entered).toBe(true)
      await expect(workTree()).toHaveAttribute('aria-busy', 'true')
      const notesPath = `${sharedRoot}/notes`, readmePath = `${sharedRoot}/README.md`
      const notes = rowAt(workTree(), notesPath), readme = rowAt(workTree(), readmePath)
      await expect(notes).toHaveAttribute('aria-expanded', 'false')
      await notes.click()
      await expect(notes).toHaveAttribute('aria-expanded', 'true')
      await expect(rowAt(workTree(), `${notesPath}/overview.md`)).toBeVisible()
      const readsBefore = fileReads.length
      await readme.click()
      await expect(readme).toHaveAttribute('aria-selected', 'true')
      await expect.poll(() => fileReads.slice(readsBefore).some(read => read.sessionId === taskB.id && read.path === 'README.md')).toBe(true)

      gate.release()
      await expect(workTree()).toHaveAttribute('aria-busy', 'false')
      const saved = await savedWorkMemory(taskB)
      expect(saved.expanded).toEqual(expect.arrayContaining([
        sharedRoot, `${sharedRoot}/collection`, `${sharedRoot}/collection/nested`, notesPath
      ]))
      expect(saved.selection).toEqual([readmePath])
      expect(saved.cursorPath).toBe(readmePath)
      expect(saved.activeFilePath).toBe(readmePath)
      await workTree().evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(notes).toHaveAttribute('aria-expanded', 'true')
      await expect(rowAt(workTree(), `${notesPath}/overview.md`)).toBeVisible()
      await expect(readme).toHaveAttribute('aria-selected', 'true')
      await expect(workPanel().getByRole('alert')).toHaveCount(0)
    } finally {
      gate.release()
      directoryGates.delete(`${taskB.id}:collection`)
    }
  })

  test('Work 重新载入同一 Windows 根目录的新路径写法后恢复既有树状态', async () => {
    await openTask(taskWindows)
    const remembered = await rememberWorkSelection(taskWindows, 48, 'item-')
    roots.set(taskWindows.id, windowsRootAlias)
    // A new mount captures the current binding spelling. The preferences must
    // follow the same Windows directory without changing live binding rules.
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(workPanel()).toHaveAttribute('data-session-id', taskWindows.id)
    await expect(workPanel().locator('.work-workspace-panel__title')).toHaveAttribute('title', windowsRootAlias)
    await expect(workTree()).toHaveAttribute('aria-busy', 'false')
    await expectWorkMemory({ ...remembered, root: windowsRootAlias, path: filePath(windowsRootAlias, 48) })
    await expect(workPanel().getByRole('alert')).toHaveCount(0)
    const saved = await savedWorkMemory(taskWindows, windowsRootAlias)
    expect(saved.expanded).toEqual(expect.arrayContaining([
      windowsRootAlias, `${windowsRootAlias}/collection`, `${windowsRootAlias}/collection/nested`
    ]))
    expect(saved.selection).toEqual([filePath(windowsRootAlias, 48)])
    await workFilter().fill('')
    await workTree().evaluate(element => { element.scrollTop = 0 })
    for (const path of [windowsRootAlias, `${windowsRootAlias}/collection`, `${windowsRootAlias}/collection/nested`]) {
      await expect(rowAt(workTree(), path)).toHaveAttribute('aria-expanded', 'true')
    }
    const scopeCount = await page.evaluate(({ storageKey, sessionId }) => {
      const table: Record<string, unknown> = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      return Object.keys(table).filter(key => {
        const scope: unknown = JSON.parse(key)
        return Array.isArray(scope) && scope[0] === 'work' && scope[2] === sessionId
      }).length
    }, { storageKey: FILE_TREE_MEMORY_KEY, sessionId: taskWindows.id })
    expect(scopeCount).toBe(1)
  })

  test('Work 标签切换几何性能回归：400行工作区与空成果首次、重复和快速往返保持单一内容槽', async ({}, info) => {
    const reports: Array<{ phase: string; layout: Awaited<ReturnType<typeof observeWorkspaceTabLayout>>;
      requestsBefore: Record<string, number>; requestsAfter: Record<string, number>; requestDelta: Record<string, number>;
      hiddenFocus: { probes: number; escaped: string[] } }> = []
    const reportPath = info.outputPath('work-tabs-layout-performance.json')
    const counts = (): Record<string, number> => Object.fromEntries([...requestCounts]
      .filter(([key]) => key.startsWith(`${taskTabs.id}:`)).map(([key, count]) => [key.slice(taskTabs.id.length + 1), count]))
    try {
      await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
      await openTask(taskTabs)
      // A fresh mount isolates the first files-pane activation from the other
      // eight regressions, even when the complete serial spec runs together.
      await page.reload()
      await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
      await openTask(taskTabs)
      const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
      await expect(workspace.locator('#work-tab-files')).toHaveCount(0)
      const remembered = await rememberWorkSelection(taskTabs, 220, 'item-')
      await expect.poll(() => workTree().evaluate(element => element.scrollHeight)).toBeGreaterThanOrEqual(400 * 30)
      const savedBefore = await savedWorkMemory(taskTabs)
      const sample = async (phase: string, activate: () => Promise<unknown>): Promise<void> => {
        const requestsBefore = counts(), pending = observeWorkspaceTabLayout(workspace)
        await expect(workspace).toHaveAttribute('data-tabs-observing', 'true')
        await activate()
        const layout = await pending, requestsAfter = counts()
        const requestDelta = Object.fromEntries(Object.entries(requestsAfter).flatMap(([key, value]) => value === (requestsBefore[key] ?? 0) ? [] : [[key, value - (requestsBefore[key] ?? 0)]]))
        // Probe focus outside the timed frames so the measurement itself never
        // changes the user's focus or the tree's viewport during a transition.
        const hiddenFocus = await workspace.evaluate(element => {
          const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
          const activeId = element.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls')
          const escaped: string[] = []; let probes = 0
          for (const panel of element.querySelectorAll<HTMLElement>('.work-workspace__body[role="tabpanel"]')) {
            if (panel.id === activeId) continue
            const control = Array.from(panel.querySelectorAll<HTMLElement>('input, button, select, textarea, [tabindex]'))
              .find(candidate => !candidate.matches(':disabled') && candidate.tabIndex >= 0)
            if (!control) continue
            probes++
            control.focus({ preventScroll: true })
            if (panel.contains(document.activeElement)) escaped.push(panel.id)
          }
          previous?.focus({ preventScroll: true })
          return { probes, escaped }
        })
        reports.push({ phase, layout, requestsBefore, requestsAfter, requestDelta, hiddenFocus })
      }
      await workspace.getByRole('button', { name: '更多工作区', exact: true }).click()
      await sample('first-workspace-to-files', () => page.getByRole('menuitem', { name: '成果', exact: true }).click())
      const files = workspace.locator('#work-panel-files')
      await expect(files.locator('.work-session-artifacts')).toHaveAttribute('aria-busy', 'false')
      await expect(files.locator('.work-session-artifacts__header')).toHaveText('0 个涉及文件')
      await expect(files.locator('[role="treeitem"]')).toHaveCount(0)
      const workspaceTab = workspace.getByRole('tab', { name: '工作区', exact: true })
      const filesTab = workspace.getByRole('tab', { name: '成果', exact: true })
      await sample('first-files-to-workspace', () => workspaceTab.click())
      for (let cycle = 1; cycle <= 2; cycle++) {
        await sample(`repeat-${cycle}-workspace-to-files`, () => filesTab.click())
        await sample(`repeat-${cycle}-files-to-workspace`, () => workspaceTab.click())
      }
      const points = await workspace.evaluate(element => {
        const strip = element.querySelector('.work-workspace__tab-strip')!.getBoundingClientRect()
        return ['files', 'workspace'].map(id => {
          const button = element.querySelector<HTMLElement>(`#work-tab-${id}`)!
          const rect = button.getBoundingClientRect()
          const left = Math.max(rect.left, strip.left, 0), right = Math.min(rect.right, strip.right, innerWidth)
          const top = Math.max(rect.top, strip.top, 0), bottom = Math.min(rect.bottom, strip.bottom, innerHeight)
          if (right <= left || bottom <= top) throw new Error(`Tab is not inside the visible strip: ${id}`)
          const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
          if (document.elementFromPoint(point.x, point.y)?.closest('[role="tab"]') !== button) throw new Error(`Tab hit-test failed: ${id}`)
          return point
        })
      })
      await sample('rapid-files-workspace-files-workspace', async () => {
        for (const index of [0, 1, 0, 1]) await page.mouse.click(points[index].x, points[index].y)
      })
      await expect(workspaceTab).toHaveAttribute('aria-selected', 'true')
      await expectWorkMemory(remembered)
      const savedAfter = await savedWorkMemory(taskTabs)
      expect(savedAfter.expanded).toEqual(savedBefore.expanded)
      expect(savedAfter.selection).toEqual(savedBefore.selection)
      expect(savedAfter.filter).toBe(savedBefore.filter)
      expect(Math.abs(savedAfter.scrollTop - savedBefore.scrollTop)).toBeLessThanOrEqual(3)
      for (const report of reports) {
        const { layout } = report
        expect(layout.timedOut, report.phase).toBe(false)
        expect(layout.frames.length, report.phase).toBeGreaterThan(1)
        expect(layout.clicks.length, report.phase).toBe(report.phase.startsWith('rapid') ? 4 : 1)
        expect(report.hiddenFocus.probes, report.phase).toBeGreaterThan(0)
        expect(report.hiddenFocus.escaped, report.phase).toEqual([])
        // Legacy 成果 now reads the change ledger and verifies its authoritative
        // session root on activation. This is one root lookup, not a reload of
        // the retained workspace tree (whose selection/viewport are checked above).
        const resultActivations = report.phase.startsWith('rapid') ? 2 : report.phase.endsWith('workspace-to-files') ? 1 : 0
        expect(report.requestDelta['GET /api/v1/workspace/directory'] ?? 0, `${report.phase}: 成果仅校验会话根目录，不重读已展开子树`).toBeLessThanOrEqual(resultActivations)
        for (const frame of layout.frames) {
          expect(frame.sized, `${report.phase}: ${frame.at.toFixed(1)}ms`).toBe(1)
          expect(frame.hiddenSized, report.phase).toBe(0)
          expect(frame.hiddenFocusable, report.phase).toBe(0)
          expect(frame.hiddenPointerHits, report.phase).toBe(0)
          expect(frame.opacity, report.phase).toBe(1)
          expect(frame.topOffset, report.phase).not.toBeNull()
          expect(Math.abs(frame.topOffset!), report.phase).toBeLessThanOrEqual(1)
          expect(frame.heightError, report.phase).not.toBeNull()
          expect(Math.abs(frame.heightError!), report.phase).toBeLessThanOrEqual(1)
          expect(frame.gap, report.phase).toBeLessThanOrEqual(120)
        }
        const heights = layout.frames.map(frame => frame.activeHeight ?? 0)
        expect(Math.max(...heights) - Math.min(...heights), `${report.phase}: 内容槽高度应保持稳定`).toBeLessThanOrEqual(1)
        for (const click of layout.clicks.filter(click => !click.superseded)) {
          expect(click.firstCorrectLayoutMs, report.phase).not.toBeNull()
          expect(click.firstCorrectLayoutMs!, `${report.phase}: 点击后正确布局的首帧`).toBeLessThanOrEqual(120)
        }
      }
    } finally {
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, JSON.stringify({ sessionId: taskTabs.id, directoryEntries: 400, artifacts: 0,
        appEntry: process.env.AETHER_E2E_APP_ENTRY ?? '.', reports }, null, 2))
      await info.attach('work-tabs-layout-performance', { path: reportPath, contentType: 'application/json' })
    }
  })

  test('Work 多成果标签与刷新稳定性：400成果、1500行差异保留人工滚动且刷新不抖动', async ({}, info) => {
    const reportPath = info.outputPath('work-populated-tabs-refresh-performance.json')
    const phases: Array<{ name: string; layout: Awaited<ReturnType<typeof observeWorkspaceTabLayout>>; requests: Record<string, number> }> = []
    const report: Record<string, unknown> = { sessionId: taskPopulated.id, artifacts: 400, operationRecords: 401, longDocumentLines: 1500, phases }
    const counts = (): Record<string, number> => Object.fromEntries([...requestCounts].filter(([key]) => key.startsWith(`${taskPopulated.id}:`))
      .map(([key, count]) => [key.slice(taskPopulated.id.length + 1), count]))
    try {
      populatedChanges = Array.from({ length: 400 }, (_, index): EngineFileChange => {
        const lines = Array.from({ length: index === 220 ? 1500 : 300 }, (_, line) => `file${index} line${String(line).padStart(4, '0')} original`)
        const revised = [...lines]; if (index !== 220) revised[150] = `file${index} line0150 revised`
        return { id: `populated-${index}`, sessionId: taskPopulated.id, turnId: `${taskPopulated.id}-turn`, seq: index + 1,
          path: `${taskPopulated.root}/reports/report-${String(index).padStart(3, '0')}.md`, kind: 'write', status: 'pending',
          oldContent: index === 220 ? null : `${lines.join('\n')}\n`, newContent: `${revised.join('\n')}\n`,
          isNew: index === 220, truncated: false, createdAt: now + index }
      })
      // A second operation on the same path preserves the 400-file workload
      // while exposing the real scope + version picker layout from the report.
      populatedChanges.push({ ...populatedChanges[220], id: 'populated-220-older', seq: 0, status: 'kept',
        newContent: '# Earlier report revision\n', createdAt: now - 1000 })
      await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
      await openTask(taskPopulated)
      await page.reload()
      await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
      await openTask(taskPopulated)
      const treeMemory = await rememberWorkSelection(taskPopulated, 70, 'item-')
      const workspace = work().getByRole('region', { name: '任务工作区', exact: true })
      const artifacts = workspace.getByRole('region', { name: '本会话成果与改动', exact: true })
      const artifactTree = artifacts.getByRole('tree', { name: '本会话文件树', exact: true })
      const selectedPath = populatedChanges[220].path
      const selectedRow = rowAt(artifactTree, selectedPath)
      const diff = artifacts.locator('.work-session-artifacts__diff'), diffScroll = diff.locator('[data-diff-scroll]')
      const search = artifacts.getByRole('searchbox', { name: '搜索当前范围文件', exact: true })
      const sample = async (name: string, action: () => Promise<unknown>): Promise<void> => {
        const before = counts(), pending = observeWorkspaceTabLayout(workspace)
        await expect(workspace).toHaveAttribute('data-tabs-observing', 'true')
        await action()
        const layout = await pending, after = counts()
        phases.push({ name, layout, requests: Object.fromEntries(Object.entries(after).flatMap(([key, value]) => value === (before[key] ?? 0) ? [] : [[key, value - (before[key] ?? 0)]])) })
      }
      await workspace.getByRole('button', { name: '更多工作区', exact: true }).click()
      const dataReady = workspace.evaluate((element, sessionId) => new Promise<{ elapsedMs: number; files: number }>(resolve => {
        let clickedAt = 0
        const finish = (value: { elapsedMs: number; files: number }): void => {
          clearTimeout(timeout); observer.disconnect(); document.removeEventListener('click', clicked, true)
          element.removeAttribute('data-populated-ready-observing'); resolve(value)
        }
        const check = (): void => {
          if (!clickedAt) return
          const panel = element.querySelector<HTMLElement>('.work-session-artifacts')
          const files = panel?.querySelectorAll('[role="treeitem"][data-path^="/remote/tree-memory/populated/"]').length ?? 0
          if (panel?.dataset.sessionId === sessionId && panel.getAttribute('aria-busy') === 'false' && files === 400) finish({ elapsedMs: performance.now() - clickedAt, files })
        }
        function clicked(event: MouseEvent): void {
          const item = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null
          if (item?.textContent?.trim() === '成果') { clickedAt = performance.now(); check() }
        }
        const observer = new MutationObserver(check)
        const timeout = setTimeout(() => finish({ elapsedMs: -1, files: 0 }), 30_000)
        observer.observe(element, { childList: true, subtree: true, attributes: true })
        document.addEventListener('click', clicked, true)
        element.setAttribute('data-populated-ready-observing', 'true')
      }), taskPopulated.id)
      await expect(workspace).toHaveAttribute('data-populated-ready-observing', 'true')
      await sample('first-populated-files', () => page.getByRole('menuitem', { name: '成果', exact: true }).click())
      report.dataReady = await dataReady
      await expect(artifacts).toHaveAttribute('aria-busy', 'false')
      await expect(artifacts.locator('.work-session-artifacts__header')).toHaveText('400 个涉及文件')
      await search.fill('report-')
      await selectedRow.click()
      await expect(diff).toHaveAttribute('data-change-id', 'populated-220')
      await expect(diffScroll).toHaveAttribute('data-total-rows', '1500')
      await expect(artifacts.locator('.work-session-artifacts__file-header .work-session-artifacts__count')).toHaveAttribute('aria-label', '待确认改动的当前片段：增加 1500 行，删除 0 行')
      await artifactTree.evaluate(element => { element.scrollTop = 1200 })
      await diffScroll.evaluate(element => { element.scrollTop = 11000 })
      await expect(selectedRow).not.toBeInViewport()
      const memory = { tree: await artifactTree.evaluate(element => element.scrollTop), diff: await diffScroll.evaluate(element => element.scrollTop) }
      report.memoryBefore = memory
      const memories: Array<{ phase: string; tree: number; diff: number; search: string; selected: string | null }> = []
      report.memories = memories
      for (let cycle = 1; cycle <= 2; cycle++) {
        await sample(`populated-${cycle}-to-workspace`, () => workspace.getByRole('tab', { name: '工作区', exact: true }).click())
        await sample(`populated-${cycle}-to-files`, () => workspace.getByRole('tab', { name: '成果', exact: true }).click())
        await expect(artifacts).toHaveAttribute('aria-busy', 'false')
        memories.push({ phase: `cycle-${cycle}`, tree: await artifactTree.evaluate(element => element.scrollTop),
          diff: await diffScroll.evaluate(element => element.scrollTop), search: await search.inputValue(), selected: await diff.getAttribute('data-change-id') })
      }

      // Keep both projection responses pending to capture real busy frames.
      // Geometry assertions run only after recording, so an old scroll-memory
      // failure cannot prevent collecting the refresh-jitter regression.
      await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
      await page.getByRole('menu', { name: '差异范围', exact: true }).getByRole('menuitem', { name: /^修改记录/ }).click()
      await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
      await expect(diff).toHaveAttribute('data-change-id', 'populated-220')
      await expect(artifacts.getByRole('button', { name: '选择单次修改', exact: true })).toBeVisible()
      await expect(artifacts.locator('.work-session-artifacts__scope .select')).toHaveCount(2)
      await diffScroll.evaluate(element => { element.scrollTop = 11000 })
      report.refreshLayout = await artifacts.locator('.work-session-artifacts__scope').evaluate(element => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height, selectors: element.querySelectorAll('.select').length }
      })
      const refresh = artifacts.getByRole('button', { name: '刷新', exact: true })
      await expect(refresh).toBeEnabled()
      let release = (): void => {}
      populatedRefreshGate = { entered: 0, wait: new Promise<void>(resolve => { release = resolve }), release: () => release() }
      const gate = populatedRefreshGate
      const refreshRequestsBefore = counts()
      const refreshing = artifacts.evaluate(element => new Promise<Array<{
        at: number; busy: boolean; taskHint: boolean; contentRows: number; stats: string | null;
        boxes: Record<string, { top: number; height: number }>; buttons: Array<{ label: string; opacity: number; disabled: boolean; left: number; top: number; width: number; height: number }>
      }>>(resolve => {
        const frames: Array<{ at: number; busy: boolean; taskHint: boolean; contentRows: number; stats: string | null;
          boxes: Record<string, { top: number; height: number }>; buttons: Array<{ label: string; opacity: number; disabled: boolean; left: number; top: number; width: number; height: number }> }> = []
        const began = performance.now(); let busyFrames = 0, doneFrames = 0, frame = 0
        const finish = (): void => { clearTimeout(timeout); cancelAnimationFrame(frame); element.removeAttribute('data-refresh-observing'); element.removeAttribute('data-refresh-busy-sampled'); resolve(frames) }
        const timeout = setTimeout(finish, 10_000)
        const sample = (): void => {
          const busy = element.getAttribute('aria-busy') === 'true'
          const boxes = Object.fromEntries(['toolbar', 'batch', 'scope', 'diff'].map(name => {
            const rect = element.querySelector(`.work-session-artifacts__${name}`)!.getBoundingClientRect()
            return [name, { top: rect.top, height: rect.height }]
          }))
          frames.push({ at: performance.now() - began, busy, boxes,
            taskHint: element.textContent?.includes('任务结束后可确认') ?? false,
            contentRows: element.querySelectorAll('.work-session-artifacts__diff [data-diff-index]').length,
            stats: element.querySelector('.work-session-artifacts__file-header .work-session-artifacts__count')?.getAttribute('aria-label') ?? null,
            buttons: Array.from(element.querySelectorAll<HTMLButtonElement>('.work-session-artifacts__batch .work-change-review button, .work-session-artifacts__scope .work-change-review button'))
              .map(button => {
                const rect = button.getBoundingClientRect()
                return { label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '', opacity: Number.parseFloat(getComputedStyle(button).opacity), disabled: button.disabled,
                  left: rect.left, top: rect.top, width: rect.width, height: rect.height }
              }) })
          if (busy) { busyFrames++; if (busyFrames >= 5) element.setAttribute('data-refresh-busy-sampled', 'true') }
          else if (busyFrames) doneFrames++
          if (doneFrames >= 5) finish(); else frame = requestAnimationFrame(sample)
        }
        element.setAttribute('data-refresh-observing', 'true')
        sample()
      }))
      await expect(artifacts).toHaveAttribute('data-refresh-observing', 'true')
      await refresh.click()
      await expect.poll(() => gate.entered).toBeGreaterThanOrEqual(2)
      await expect(artifacts).toHaveAttribute('data-refresh-busy-sampled', 'true')
      await page.screenshot({ path: info.outputPath('populated-refresh-busy.png'), animations: 'disabled' })
      populatedChanges = populatedChanges.map((change, index) => index === 220 ? { ...change, newContent: `${change.newContent}POPULATED_REFRESH_APPENDED_LINE\n` }
        : index === 221 ? { ...change, newContent: change.newContent!.replace('file221 line0200 original', 'file221 line0200 refreshed') } : change)
      populatedRefreshGate = null; gate.release()
      const refreshFrames = await refreshing
      report.refresh = { requestsBefore: refreshRequestsBefore, requestsAfter: counts(), frames: refreshFrames }
      await expect(artifacts).toHaveAttribute('aria-busy', 'false')
      await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
      await expect(diff).toHaveAttribute('data-change-id', 'populated-220')
      await expect(artifacts.locator('.work-session-artifacts__file-header .work-session-artifacts__count')).toHaveAttribute('aria-label', '该次修改：增加 1501 行，删除 0 行')
      await expect(rowAt(artifactTree, populatedChanges[221].path).locator('.work-session-artifacts__count')).toHaveAttribute('aria-label', '待确认改动的当前片段：增加 2 行，删除 2 行')
      await page.screenshot({ path: info.outputPath('populated-refresh-ready.png'), animations: 'disabled' })
      report.memoryAfterRefresh = { tree: await artifactTree.evaluate(element => element.scrollTop), diff: await diffScroll.evaluate(element => element.scrollTop) }

      const ready = report.dataReady as { elapsedMs: number; files: number }
      expect(ready.files).toBe(400)
      expect(ready.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(ready.elapsedMs).toBeLessThanOrEqual(5000)
      for (const remembered of memories) {
        expect(remembered.search).toBe('report-')
        expect(remembered.selected).toBe('populated-220')
        expect(Math.abs(remembered.tree - memory.tree), `${remembered.phase}: 保留用户滚离选中文件的位置`).toBeLessThanOrEqual(3)
        expect(Math.abs(remembered.diff - memory.diff)).toBeLessThanOrEqual(3)
      }
      for (const phase of phases) {
        expect(phase.layout.timedOut, phase.name).toBe(false)
        expect(phase.layout.frames.length, phase.name).toBeGreaterThan(1)
        for (const frame of phase.layout.frames) {
          expect(frame.sized, phase.name).toBe(1)
          expect(frame.hiddenSized + frame.hiddenFocusable + frame.hiddenPointerHits, phase.name).toBe(0)
          expect(frame.opacity, phase.name).toBe(1)
          expect(frame.topOffset, phase.name).not.toBeNull()
          expect(Math.abs(frame.topOffset!), phase.name).toBeLessThanOrEqual(1)
          expect(Math.abs(frame.heightError ?? Infinity), phase.name).toBeLessThanOrEqual(1)
          // First activation includes decoding and mounting 400 full receipts.
          // Its data-ready measurement is separate from retained-tab latency.
          expect(frame.gap, phase.name).toBeLessThanOrEqual(phase.name === 'first-populated-files' ? 250 : 120)
        }
        for (const click of phase.layout.clicks) expect(click.firstCorrectLayoutMs ?? Infinity, phase.name).toBeLessThanOrEqual(120)
      }
      const busy = refreshFrames.filter(frame => frame.busy), idle = refreshFrames.filter(frame => !frame.busy)
      expect(busy.length).toBeGreaterThanOrEqual(5)
      expect(idle.length).toBeGreaterThanOrEqual(5)
      const before = refreshFrames[0]
      for (const frame of refreshFrames) {
        expect(frame.taskHint, `refresh ${frame.at.toFixed(1)}ms`).toBe(false)
        expect(frame.contentRows).toBeGreaterThan(0)
        for (const name of ['toolbar', 'batch', 'scope', 'diff']) {
          expect(Math.abs(frame.boxes[name].top - before.boxes[name].top), `${name} top`).toBeLessThanOrEqual(1)
          expect(Math.abs(frame.boxes[name].height - before.boxes[name].height), `${name} height`).toBeLessThanOrEqual(1)
        }
        expect(frame.buttons.length).toBeGreaterThanOrEqual(3)
        for (const button of frame.buttons) {
          const initial = before.buttons.find(candidate => candidate.label === button.label)!
          expect(button.opacity, button.label).toBe(initial.opacity)
          expect(button.disabled, button.label).toBe(frame.busy)
          for (const field of ['left', 'top', 'width', 'height'] as const) {
            expect(Math.abs(button[field] - initial[field]), `${button.label} ${field}`).toBeLessThanOrEqual(1)
          }
        }
      }
      await workspace.getByRole('tab', { name: '工作区', exact: true }).click()
      await expectWorkMemory(treeMemory)
    } finally {
      populatedRefreshGate?.release(); populatedRefreshGate = null
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, JSON.stringify(report, null, 2))
      await info.attach('work-populated-tabs-refresh-performance', { path: reportPath, contentType: 'application/json' })
    }
  })
})
