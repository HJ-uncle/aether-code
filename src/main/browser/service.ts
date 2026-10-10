import { app, BrowserWindow, session, WebContentsView } from 'electron'
import type { Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  BrowserAction, BrowserBoundsInput, BrowserConsoleEntry, BrowserContext, BrowserCreateInput,
  BrowserElement, BrowserEvent, BrowserReadKind, BrowserScreenshot,
  BrowserSettings, BrowserSnapshot, BrowserTabState, BrowserToolRequest, BrowserToolResult
} from '../../shared/browser'
import { BrowserSettingsStore } from './settings'
import { BrowserNetworkCollector } from './network-collector'
import type { BrowserNetworkDetail, BrowserNetworkDetailOptions, BrowserNetworkList, BrowserNetworkQuery } from '../../shared/browser-network'
import { browserError, clampBounds, contextsMatch, normalizeBrowserUrl, validateContext, validateViewport, validateZoom } from './validation'

interface BrowserEntry {
  owner: BrowserWindow
  view: WebContentsView
  state: BrowserTabState
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  console: BrowserConsoleEntry[]
  network: BrowserNetworkCollector
  networkInterrupted: boolean
  initialization: Promise<void>
  initializationState: 'starting' | 'ready' | 'failed'
  navigationVersion: number
  closed: AbortController
  refs: Map<string, number>
  ready?: Promise<void>
  visibilityWaiters: Set<(error?: Error) => void>
  queue: Promise<unknown>
  logId: number
}

interface AXNode {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string | number }
  properties?: { name: string; value: { value?: unknown } }[]
}

interface RuntimeResult<T> {
  result?: { value?: T; objectId?: string; description?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

const MAX_LOGS = 300
const MAX_ELEMENTS = 500
const MAX_TEXT = 24000

function boundedPush<T>(entries: T[], value: T): void {
  entries.push(value)
  if (entries.length > MAX_LOGS) entries.splice(0, entries.length - MAX_LOGS)
}

function text(value: unknown, limit = 4000): string { return String(value ?? '').slice(0, limit) }

function duration(value: number | undefined): number {
  if (value === undefined) return 10000
  if (!Number.isInteger(value) || value < 100 || value > 30000) throw new Error('等待时间应为 100–30000 毫秒')
  return value
}

/** Only this service owns guest pages; neither page JS nor the AI receives a raw CDP socket. */
export class BrowserService {
  private readonly tabs = new Map<string, BrowserEntry>()
  private readonly configuredSessions = new Set<Session>()
  private readonly owners = new WeakSet<BrowserWindow>()
  private readonly settings = new BrowserSettingsStore()
  private readonly temporaryPartition = `aether-browser-${randomUUID()}`
  private disposed = false

  constructor(private readonly getWindow: () => BrowserWindow | undefined, private readonly emit: (event: BrowserEvent) => void) {}

  getSettings(): BrowserSettings { return this.settings.get() }

  updateSettings(patch: Partial<BrowserSettings>): BrowserSettings { return this.settings.update(patch) }

  list(): BrowserTabState[] { return [...this.tabs.values()].map((entry) => this.state(entry)) }

  async create(input: BrowserCreateInput = {}): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('浏览器服务已关闭')
    const owner = this.getWindow()
    if (!owner || owner.isDestroyed()) throw new Error('编辑器窗口尚未就绪')
    const settings = this.settings.get()
    const url = normalizeBrowserUrl(input.url ?? settings.homeUrl)
    const context = input.context ? validateContext(input.context) : undefined
    const partition = settings.persistSession ? 'persist:aether-browser' : this.temporaryPartition
    const browserSession = session.fromPartition(partition)
    this.configureSession(browserSession)
    const view = new WebContentsView({ webPreferences: {
      session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
      spellcheck: false, backgroundThrottling: false, safeDialogs: true
    } })
    const entry: BrowserEntry = {
      owner, view, visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 }, console: [],
      network: new BrowserNetworkCollector(async (method, params) => { await this.ensureInitialized(entry); await this.debugger(entry); return this.command(entry, method, params) }),
      networkInterrupted: false, initialization: Promise.resolve(), initializationState: 'starting', navigationVersion: 0, closed: new AbortController(), refs: new Map(),
      queue: Promise.resolve(), logId: 0, visibilityWaiters: new Set(),
      state: { tabId: randomUUID(), url, title: '浏览器', loading: true, canGoBack: false, canGoForward: false,
        zoomFactor: settings.zoomFactor, viewport: settings.defaultViewport, navigationId: 0, ...(context ? { context } : {}) }
    }
    this.tabs.set(entry.state.tabId, entry)
    owner.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    view.setVisible(false)
    this.observeOwner(owner)
    this.observe(entry)
    // Publish a usable lifecycle barrier before exposing the tab to the renderer.
    // The renderer may submit an address immediately in response to `created`.
    entry.initialization = this.initialize(entry, settings)
    this.emit({ type: 'created', tabId: entry.state.tabId, tab: this.state(entry) })
    try {
      await entry.initialization
      // A user address submitted during initialization takes precedence over homeUrl.
      if (url !== 'about:blank' && entry.navigationVersion === 0) await this.navigate(entry, url)
      else this.changed(entry)
    } catch (error) {
      if (!view.webContents.isDestroyed()) {
        entry.state.error = browserError(error)
        entry.state.loading = false
        this.changed(entry)
      }
    }
    this.entry(entry.state.tabId)
    return this.state(entry)
  }

  async action(input: BrowserAction): Promise<BrowserTabState> {
    const entry = this.entry(input.tabId)
    const wc = entry.view.webContents
    if (input.action === 'navigate') {
      await this.navigate(entry, input.url)
      this.changed(entry)
      return this.state(entry)
    }
    const changesNavigation = ['back', 'forward', 'reload', 'stop'].includes(input.action)
    const version = changesNavigation ? ++entry.navigationVersion : entry.navigationVersion
    await this.ensureInitialized(entry)
    if (changesNavigation && version !== entry.navigationVersion) return this.state(entry)
    switch (input.action) {
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break
      case 'reload':
        entry.state.error = undefined
        // An explicit browser refresh starts a new document capture even when
        // Chromium has a cached response for the same URL. Bypass that cache so
        // the page, console, and network timeline are all actually reloaded.
        wc.reloadIgnoringCache()
        break
      case 'stop': wc.stop(); break
      case 'zoom': entry.state.zoomFactor = validateZoom(input.zoomFactor); wc.setZoomFactor(input.zoomFactor); break
      case 'viewport': entry.state.viewport = validateViewport(input.viewport); await this.applyViewport(entry); break
      case 'devtools': if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' }); break
      default: throw new Error('未知浏览器操作')
    }
    this.changed(entry)
    return this.state(entry)
  }

  setBounds(input: BrowserBoundsInput): void {
    const entry = this.entry(input.tabId)
    const [width, height] = entry.owner.getContentSize()
    const bounds = clampBounds(input.bounds, { width, height })
    if (bounds.width > 0 && bounds.height > 0) entry.bounds = bounds
    entry.visible = input.visible === true && bounds.width > 0 && bounds.height > 0
    entry.view.setVisible(entry.visible)
    if (entry.visible) for (const resolve of [...entry.visibilityWaiters]) resolve()
    if (bounds.width > 0 && bounds.height > 0) {
      this.applyViewport(entry).catch((error: unknown) => this.log(entry, 'error', browserError(error)))
    }
  }

  close(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    this.tabs.delete(tabId)
    entry.closed.abort()
    for (const resolve of [...entry.visibilityWaiters]) resolve(new Error('浏览器标签已关闭'))
    if (!entry.owner.isDestroyed()) entry.owner.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) {
      if (entry.view.webContents.debugger.isAttached()) entry.view.webContents.debugger.detach()
      // No page beforeunload handler may keep a closed editor tab alive.
      entry.view.webContents.close({ waitForBeforeUnload: false })
    }
    entry.refs.clear()
    entry.network.clear()
    this.emit({ type: 'closed', tabId })
  }

  /** Called only by the explicit renderer share action with the trusted active context. */
  bindContext(tabId: string, context: BrowserContext): BrowserTabState {
    const entry = this.entry(tabId)
    entry.state.context = validateContext(context)
    this.changed(entry)
    return this.state(entry)
  }

  async clearData(): Promise<void> {
    const sessions = new Set(this.configuredSessions)
    sessions.add(session.fromPartition('persist:aether-browser'))
    for (const browserSession of sessions) {
      await browserSession.clearStorageData()
      await browserSession.clearCache()
      await browserSession.clearAuthCache()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.tabs.keys()]) this.close(id)
  }

  async read(tabId: string, kind: BrowserReadKind): Promise<BrowserToolResult> {
    try { return { success: true, output: await this.readEntry(this.entry(tabId), kind) } }
    catch (error) { return { success: false, error: browserError(error) } }
  }

  network(tabId: string, query?: BrowserNetworkQuery): BrowserNetworkList {
    const entry = this.entry(tabId)
    return { ...entry.network.list(this.state(entry), query), warnings: this.networkWarnings(entry) }
  }

  async networkRequest(tabId: string, requestId: string, options?: BrowserNetworkDetailOptions): Promise<BrowserNetworkDetail> {
    const entry = this.entry(tabId)
    // Already captured metadata remains useful while DevTools owns CDP. Only the
    // collector's lazy body read needs the debugger, and it reports failure in body.state.
    const result = await entry.network.detail(this.state(entry), requestId, options)
    return { ...result, warnings: [...result.warnings, ...this.networkWarnings(entry)] }
  }

  private networkWarnings(entry: BrowserEntry): string[] {
    if (entry.initializationState === 'starting') return ['浏览器正在初始化，Network.enable 尚未就绪；当前网络列表可能为空']
    if (entry.initializationState === 'failed') return ['浏览器初始化失败，网络捕获未就绪；请关闭此标签后重新打开']
    if (entry.view.webContents.isDevToolsOpened()) return ['开发者工具正在占用调试连接，网络捕获已暂停；已采集记录仍可查看，关闭开发者工具后继续捕获']
    if (!entry.view.webContents.debugger.isAttached()) return ['网络调试连接尚未就绪或已断开，当前列表不是实时完整记录']
    return entry.networkInterrupted ? ['网络捕获曾暂停；暂停期间的请求可能未被采集'] : []
  }

  async execute(request: BrowserToolRequest, context: BrowserContext, signal?: AbortSignal): Promise<BrowserToolResult> {
    try {
      const assertConnection = (): void => {
        if (signal?.aborted) throw new Error('浏览器工具连接已切换，当前操作已取消')
      }
      assertConnection()
      validateContext(context)
      if (!this.settings.get().aiEnabled) throw new Error('内置浏览器的 AI 操作已在设置中关闭')
      if (!request || typeof request !== 'object') throw new Error('浏览器工具请求无效')
      if (request.action === 'tabs') return { success: true, output: this.list().filter((tab) => contextsMatch(tab.context, context)) }
      if (request.action === 'open') {
        const tab = await this.create({ url: request.url, context })
        assertConnection()
        return tab.error ? { success: false, output: tab, error: tab.error } : { success: true, output: tab }
      }
      if (!request.tabId) throw new Error('必须指定 browser_open 或 browser_tabs 返回的 tabId')
      const entry = this.entry(request.tabId)
      if (!contextsMatch(entry.state.context, context)) throw new Error('这个浏览器标签属于其他会话或引擎，请在当前会话重新打开')
      const assertActive = (): void => {
        assertConnection()
        if (!this.settings.get().aiEnabled) throw new Error('内置浏览器的 AI 操作已在设置中关闭')
        if (!contextsMatch(entry.state.context, context)) throw new Error('浏览器标签已交给其他会话，当前操作已取消')
      }
      const run = async (): Promise<unknown> => {
        this.entry(entry.state.tabId)
        assertActive()
        if (request.navigationId !== undefined && request.navigationId !== entry.state.navigationId) throw new Error('页面已经变化，请重新读取快照后操作')
        return this.executeEntry(entry, request, assertActive, signal)
      }
      const task = entry.queue.then(run, run)
      entry.queue = task.catch(() => undefined)
      const output = await task
      assertActive()
      return { success: true, output }
    } catch (error) { return { success: false, error: browserError(error) } }
  }

  private entry(tabId: string): BrowserEntry {
    const entry = this.tabs.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('浏览器标签已关闭，请重新打开')
    return entry
  }

  private state(entry: BrowserEntry): BrowserTabState { return structuredClone(entry.state) }

  private async initialize(entry: BrowserEntry, settings: BrowserSettings): Promise<void> {
    // Chromium needs a document before Runtime.enable. Navigations wait for this
    // initial document and Network.enable, so first-load traffic cannot disappear.
    try {
      await this.withLifetime(entry, entry.view.webContents.loadURL('about:blank'), '初始化空白页', 15000)
      await this.debugger(entry)
      entry.view.webContents.setZoomFactor(settings.zoomFactor)
      await this.applyViewport(entry)
      entry.initializationState = 'ready'
    } catch (error) { entry.initializationState = 'failed'; throw error }
  }

  private async ensureInitialized(entry: BrowserEntry): Promise<void> {
    await entry.initialization
    this.entry(entry.state.tabId)
  }

  private changed(entry: BrowserEntry): void {
    if (!this.tabs.has(entry.state.tabId) || entry.view.webContents.isDestroyed()) return
    const wc = entry.view.webContents
    entry.state.canGoBack = wc.navigationHistory.canGoBack()
    entry.state.canGoForward = wc.navigationHistory.canGoForward()
    entry.state.loading = wc.isLoading()
    this.emit({ type: 'changed', tabId: entry.state.tabId, tab: this.state(entry) })
  }

  private log(entry: BrowserEntry, level: string, message: string, source?: string, line?: number): void {
    boundedPush(entry.console, { id: ++entry.logId, timestamp: Date.now(), level, message: text(message), source, line })
  }

  private configureSession(browserSession: Session): void {
    if (this.configuredSessions.has(browserSession)) return
    this.configuredSessions.add(browserSession)
    browserSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
    browserSession.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = permission === 'clipboard-sanitized-write'
      callback(allowed)
      if (!allowed) {
        const entry = [...this.tabs.values()].find((tab) => tab.view.webContents === wc)
        if (entry) this.log(entry, 'warning', `网页请求的 ${permission} 权限未授权`)
      }
    })
    browserSession.on('will-download', (_event, item) => {
      // Electron presents a save dialog; the page cannot choose an arbitrary filesystem path.
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
    })
  }

  private observeOwner(owner: BrowserWindow): void {
    if (this.owners.has(owner)) return
    this.owners.add(owner)
    owner.once('closed', () => {
      for (const entry of this.tabs.values()) if (entry.owner === owner) this.close(entry.state.tabId)
    })
    owner.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
      if (!mainFrame) return
      for (const entry of this.tabs.values()) if (entry.owner === owner) {
        entry.visible = false
        entry.view.setVisible(false)
      }
    })
  }

  private observe(entry: BrowserEntry): void {
    const wc = entry.view.webContents
    wc.on('focus', () => this.emit({ type: 'focused', tabId: entry.state.tabId }))
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
      const key = input.key.toLowerCase()
      if (!['l', 'r', 't', 'w', 'p'].includes(key)) return
      event.preventDefault()
      if (input.isAutoRepeat) return
      if (key === 'r') {
        if (input.shift) {
          const version = ++entry.navigationVersion
          this.ensureInitialized(entry).then(() => { if (version === entry.navigationVersion) wc.reloadIgnoringCache() }).catch((error: unknown) => this.log(entry, 'error', browserError(error)))
        }
        else this.action({ tabId: entry.state.tabId, action: 'reload' }).catch((error: unknown) => this.log(entry, 'error', browserError(error)))
      } else if (key === 't') {
        this.create({ context: entry.state.context }).then((tab) => {
          this.focusOwner(entry)
          this.emit({ type: 'focus-address', tabId: tab.tabId })
        }).catch((error: unknown) => this.log(entry, 'error', browserError(error)))
      } else if (key === 'w') {
        this.focusOwner(entry)
        this.close(entry.state.tabId)
      } else if (key === 'l') {
        this.focusOwner(entry)
        this.emit({ type: 'focus-address', tabId: entry.state.tabId })
      } else {
        // A native child view cannot bubble keyboard events to the IDE document.
        // Forward only the two workbench commands, never arbitrary page input.
        this.focusOwner(entry)
        const modifiers: ('control' | 'meta' | 'shift')[] = [input.meta ? 'meta' : 'control', ...(input.shift ? ['shift' as const] : [])]
        entry.owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers })
        entry.owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers })
      }
    })
    wc.on('will-navigate', (event, url) => {
      try { normalizeBrowserUrl(url); entry.navigationVersion += 1 } catch (error) { event.preventDefault(); entry.state.error = browserError(error); this.changed(entry) }
    })
    wc.on('will-redirect', (event, url) => {
      try { normalizeBrowserUrl(url) } catch (error) { event.preventDefault(); entry.state.error = browserError(error); this.changed(entry) }
    })
    wc.setWindowOpenHandler(({ url }) => {
      // Keep popup ownership explicit, including the AI session that opened the parent.
      try {
        const target = normalizeBrowserUrl(url)
        this.create({ url: target, context: entry.state.context }).catch((error: unknown) => this.log(entry, 'error', browserError(error)))
      } catch (error) { this.log(entry, 'warning', browserError(error)) }
      return { action: 'deny' }
    })
    wc.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (!mainFrame) return
      entry.state.url = url
      entry.state.error = undefined
      if (!inPlace) {
        // A top-level document gets a fresh console/network timeline. Same-
        // document hash/history changes keep the current page diagnostics.
        entry.state.navigationId += 1
        entry.refs.clear()
        entry.console.length = 0
        entry.network.beginNavigation(entry.state.navigationId, url)
        entry.state.title = '加载中…'
      }
      this.changed(entry)
    })
    wc.on('did-navigate', (_event, url) => { entry.state.url = url; this.changed(entry) })
    wc.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) { entry.state.url = url; this.changed(entry) } })
    wc.on('page-title-updated', (_event, title) => { entry.state.title = title || '浏览器'; this.changed(entry) })
    wc.on('did-start-loading', () => this.changed(entry))
    wc.on('did-stop-loading', () => {
      if (!wc.isDestroyed()) { entry.state.title = wc.getTitle() || (wc.getURL() === 'about:blank' ? '新标签页' : '浏览器'); this.changed(entry) }
    })
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return
      entry.state.error = `网页加载失败：${description} (${code})`
      this.changed(entry)
    })
    wc.on('render-process-gone', (_event, details) => {
      entry.state.error = `网页进程已退出 (${details.reason})，请刷新页面`
      entry.state.loading = false
      entry.refs.clear()
      this.changed(entry)
    })
    wc.on('console-message', (details) => this.log(entry, details.level, details.message, details.sourceId, details.lineNumber))
    wc.on('destroyed', () => {
      entry.closed.abort()
      entry.network.clear()
      if (!this.tabs.delete(entry.state.tabId)) return
      this.emit({ type: 'closed', tabId: entry.state.tabId })
    })
    wc.debugger.on('detach', () => { entry.ready = undefined; entry.networkInterrupted = true })
    wc.on('devtools-closed', () => {
      if (!this.tabs.has(entry.state.tabId) || wc.isDestroyed()) return
      this.ensureInitialized(entry).then(() => this.debugger(entry)).catch((error: unknown) => this.log(entry, 'warning', `网络捕获恢复失败：${browserError(error)}`))
    })
    wc.debugger.on('message', (_event, method, params: Record<string, unknown>) => this.debuggerEvent(entry, method, params))
  }

  private debuggerEvent(entry: BrowserEntry, method: string, params: Record<string, unknown>): void {
    if (method.startsWith('Network.')) entry.network.event(method, params, entry.state.navigationId)
    else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number } | undefined
      if (details) this.log(entry, 'error', text(details.exception?.description ?? details.text), details.url, details.lineNumber)
    }
  }

  private async debugger(entry: BrowserEntry): Promise<void> {
    const wc = entry.view.webContents
    if (wc.isDevToolsOpened()) throw new Error('请先关闭此网页的开发者工具，再让 AI 操作浏览器')
    if (entry.ready && wc.debugger.isAttached()) return entry.ready
    entry.ready = undefined
    entry.ready = (async () => {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      await this.command(entry, 'Runtime.enable')
      await this.command(entry, 'Network.enable', { maxTotalBufferSize: 24 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024, maxPostDataSize: 2 * 1024 * 1024 })
    })().catch((error: unknown) => { entry.ready = undefined; throw error })
    return entry.ready
  }

  private async command<T = Record<string, unknown>>(entry: BrowserEntry, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.withLifetime(entry, entry.view.webContents.debugger.sendCommand(method, params) as Promise<T>, method, 12000)
  }

  private async withLifetime<T>(entry: BrowserEntry, operation: Promise<T>, label: string, timeout: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('浏览器标签已关闭，操作已取消'))
          if (entry.closed.signal.aborted) { abort(); return }
          entry.closed.signal.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => reject(new Error(`浏览器操作超时：${label}`)), timeout)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (abort) entry.closed.signal.removeEventListener('abort', abort)
    }
  }

  private async evaluate<T>(entry: BrowserEntry, expression: string): Promise<T> {
    await this.debugger(entry)
    const result = await this.command<RuntimeResult<T>>(entry, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '网页状态读取失败')
    return result.result?.value as T
  }

  private async navigate(entry: BrowserEntry, url: string): Promise<void> {
    const target = normalizeBrowserUrl(url)
    const version = ++entry.navigationVersion
    await this.ensureInitialized(entry)
    if (version !== entry.navigationVersion) return
    entry.state.error = undefined
    entry.state.url = target
    try { await entry.view.webContents.loadURL(target) }
    catch (error) {
      // A later address intentionally cancels the earlier load; it is not a page error.
      if (version !== entry.navigationVersion) return
      if (!entry.view.webContents.isDestroyed()) { entry.state.error = browserError(error); this.changed(entry) }
      throw error
    }
  }

  private async applyViewport(entry: BrowserEntry): Promise<void> {
    const wc = entry.view.webContents
    if (wc.isDestroyed()) return
    const viewport = entry.state.viewport
    if (viewport) {
      const bounds = entry.bounds
      const scale = Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height)
      const width = Math.max(1, Math.round(viewport.width * scale))
      const height = Math.max(1, Math.round(viewport.height * scale))
      entry.view.setBounds({ x: bounds.x + Math.round((bounds.width - width) / 2), y: bounds.y, width, height })
      wc.enableDeviceEmulation({
        screenPosition: viewport.mobile ? 'mobile' : 'desktop', screenSize: { width: viewport.width, height: viewport.height },
        viewPosition: { x: 0, y: 0 }, viewSize: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        scale
      })
    } else {
      if (entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds)
      wc.disableDeviceEmulation()
    }
    if (wc.debugger.isAttached()) await this.command(entry, 'Emulation.setTouchEmulationEnabled', { enabled: !!viewport?.mobile, maxTouchPoints: 1 })
  }

  private async readEntry(entry: BrowserEntry, kind: BrowserReadKind): Promise<unknown> {
    switch (kind) {
      case 'console': return { tab: this.state(entry), entries: structuredClone(entry.console) }
      case 'network': return this.network(entry.state.tabId)
      case 'snapshot': return this.snapshot(entry)
      case 'screenshot': return this.screenshot(entry)
      default: throw new Error('未知浏览器读取类型')
    }
  }

  private async snapshot(entry: BrowserEntry): Promise<BrowserSnapshot> {
    await this.ensureInitialized(entry)
    await this.debugger(entry)
    const navigationId = entry.state.navigationId
    const tree = await this.command<{ nodes: AXNode[] }>(entry, 'Accessibility.getFullAXTree')
    const page = await this.evaluate<{ text: string; viewport: BrowserSnapshot['viewport'] }>(entry,
      `({text:(document.body?.innerText||'').slice(0,${MAX_TEXT + 1}),viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,scrollX,scrollY}})`)
    if (entry.state.navigationId !== navigationId) throw new Error('页面正在导航，请重新读取快照')
    entry.refs.clear()
    const elements: BrowserElement[] = []
    for (const node of tree.nodes) {
      if (node.ignored) continue
      const role = node.role?.value ?? ''
      const name = text(node.name?.value, 1000)
      if (!role || (['generic', 'none', 'InlineTextBox'].includes(role) && !name)) continue
      const element: BrowserElement = { role, name }
      if (node.backendDOMNodeId) {
        element.ref = `${navigationId}:${node.backendDOMNodeId}`
        entry.refs.set(element.ref, node.backendDOMNodeId)
      }
      let protectedValue = node.properties?.some((property) => property.name === 'protected' && property.value.value === true) ?? false
      if (node.value?.value !== undefined && ['textbox', 'textField', 'searchbox'].includes(role)) {
        // AX does not consistently expose the password protection property. Inspect
        // only attributes so ordinary form values remain testable without reading secrets.
        protectedValue ||= await this.isProtectedInput(entry, node.backendDOMNodeId)
      }
      if (node.value?.value !== undefined && !protectedValue) element.value = text(node.value.value, 1000)
      elements.push(element)
      if (elements.length >= MAX_ELEMENTS) break
    }
    if (entry.state.navigationId !== navigationId) throw new Error('页面正在导航，请重新读取快照')
    return { tab: this.state(entry), text: page.text.slice(0, MAX_TEXT), viewport: page.viewport, elements, truncated: page.text.length > MAX_TEXT || elements.length >= MAX_ELEMENTS }
  }

  private async isProtectedInput(entry: BrowserEntry, backendNodeId: number | undefined): Promise<boolean> {
    if (!backendNodeId) return true
    try {
      const result = await this.command<{ node?: { attributes?: string[] } }>(entry, 'DOM.describeNode', { backendNodeId, depth: 0 })
      if (!result.node) return true
      const attributes = result.node.attributes ?? []
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index].toLowerCase() === 'type' && attributes[index + 1]?.toLowerCase() === 'password') return true
        if (attributes[index].toLowerCase() === 'autocomplete' && /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/i.test(attributes[index + 1] ?? '')) return true
      }
      return false
    } catch { return true }
  }

  private async screenshot(entry: BrowserEntry): Promise<BrowserScreenshot> {
    await this.ensureInitialized(entry)
    const navigationId = entry.state.navigationId
    const viewport = await this.evaluate<BrowserScreenshot['viewport']>(entry, '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})')
    const image = await entry.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    if (entry.state.navigationId !== navigationId) throw new Error('页面正在导航，请重新截图')
    if (image.isEmpty()) throw new Error('页面尚未完成绘制，请稍后重试截图')
    const size = image.getSize()
    const png = image.toPNG()
    return { tab: this.state(entry), dataUrl: `data:image/png;base64,${png.toString('base64')}`, mimeType: 'image/png', filename: `browser-${entry.state.tabId}.png`, size: png.byteLength, width: size.width, height: size.height, viewport }
  }

  private async executeEntry(entry: BrowserEntry, request: BrowserToolRequest, assertActive: () => void, signal?: AbortSignal): Promise<unknown> {
    if (!['navigate', 'close', 'network', 'network_detail', 'console'].includes(request.action)) {
      await this.ensureInitialized(entry)
      assertActive()
    }
    switch (request.action) {
      case 'snapshot': case 'screenshot': case 'console': return this.readEntry(entry, request.action)
      case 'network': return this.network(entry.state.tabId, request.query)
      case 'network_detail': return this.networkRequest(entry.state.tabId, request.requestId ?? '', { bodyTarget: request.bodyTarget, bodyOffset: request.bodyOffset, bodyLimit: request.bodyLimit })
      case 'close': this.close(entry.state.tabId); return { tabId: entry.state.tabId, closed: true }
      case 'navigate': if (!request.url) throw new Error('请提供网页地址'); await this.navigate(entry, request.url); return this.snapshot(entry)
      case 'viewport': entry.state.viewport = validateViewport(request.viewport ?? null); await this.applyViewport(entry); this.changed(entry); return this.snapshot(entry)
      case 'click': await this.click(entry, request, assertActive, signal); return this.snapshot(entry)
      case 'fill': await this.fill(entry, request, assertActive, signal); return this.snapshot(entry)
      case 'press_key': await this.pressKey(entry, request.key, assertActive, signal); return this.snapshot(entry)
      case 'scroll': await this.scroll(entry, request, assertActive, signal); return this.snapshot(entry)
      case 'wait': return this.waitFor(entry, request, assertActive)
      default: throw new Error('未知浏览器工具操作')
    }
  }

  private async focus(entry: BrowserEntry, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('浏览器工具连接已切换，当前操作已取消')
    if (!entry.visible) await new Promise<void>((resolve, reject) => {
      const aborted = (): void => finished(new Error('浏览器工具连接已切换，当前操作已取消'))
      const finished = (error?: Error): void => {
        clearTimeout(timer)
        entry.visibilityWaiters.delete(finished)
        signal?.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finished(new Error('请先打开并显示这个浏览器标签，再进行页面操作')), 5000)
      entry.visibilityWaiters.add(finished)
      signal?.addEventListener('abort', aborted, { once: true })
    })
    if (signal?.aborted) throw new Error('浏览器工具连接已切换，当前操作已取消')
    if (entry.owner.isMinimized()) throw new Error('编辑器窗口已最小化，请恢复窗口后操作页面')
    await this.debugger(entry)
    if (signal?.aborted) throw new Error('浏览器工具连接已切换，当前操作已取消')
    entry.view.webContents.focus()
  }

  private focusOwner(entry: BrowserEntry): void {
    if (entry.owner.isDestroyed()) return
    entry.owner.focus()
    entry.owner.webContents.focus()
  }

  private assertNavigation(entry: BrowserEntry, expected: number): void {
    if (entry.state.navigationId !== expected) throw new Error('页面已经变化，请重新读取快照后操作')
  }

  private async elementObject(entry: BrowserEntry, request: BrowserToolRequest): Promise<string> {
    await this.debugger(entry)
    if (request.ref) {
      const id = entry.refs.get(request.ref)
      if (!id || !request.ref.startsWith(`${entry.state.navigationId}:`)) throw new Error('元素引用已过期，请重新读取页面快照')
      const result = await this.command<{ object?: { objectId?: string } }>(entry, 'DOM.resolveNode', { backendNodeId: id })
      if (!result.object?.objectId) throw new Error('元素已离开页面，请重新读取快照')
      return result.object.objectId
    }
    if (typeof request.selector !== 'string' || !request.selector || request.selector.length > 2000) throw new Error('请提供快照中的 ref 或 CSS selector')
    const result = await this.command<RuntimeResult<unknown>>(entry, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(request.selector)})`, returnByValue: false })
    if (result.exceptionDetails) throw new Error('CSS 选择器无效')
    if (!result.result?.objectId) throw new Error('未找到匹配元素')
    return result.result.objectId
  }

  private async withElement<T>(entry: BrowserEntry, request: BrowserToolRequest, functionDeclaration: string, assertActive?: () => void): Promise<T> {
    const objectId = await this.elementObject(entry, request)
    try {
      assertActive?.()
      const result = await this.command<RuntimeResult<T>>(entry, 'Runtime.callFunctionOn', { objectId, functionDeclaration, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '元素操作失败')
      return result.result?.value as T
    } finally { this.command(entry, 'Runtime.releaseObject', { objectId }).catch(() => undefined) }
  }

  private async click(entry: BrowserEntry, request: BrowserToolRequest, assertActive: () => void, signal?: AbortSignal): Promise<void> {
    const navigationId = entry.state.navigationId
    await this.focus(entry, signal)
    assertActive()
    let point: { x: number; y: number }
    if (request.ref || request.selector) {
      point = await this.withElement(entry, request, `function(){
        if (!(this instanceof Element) || !this.isConnected) throw new Error('元素已离开页面');
        if (this.matches(':disabled,[aria-disabled="true"]')) throw new Error('元素已禁用');
        this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const r=this.getBoundingClientRect(); if(!r.width||!r.height) throw new Error('元素不可见');
        const x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2));
        const top=document.elementFromPoint(x,y); if(top!==this&&!this.contains(top)) throw new Error('元素被其他内容遮挡');
        return {x,y};
      }`, assertActive)
    } else {
      if (!Number.isFinite(request.x) || !Number.isFinite(request.y) || request.x! < 0 || request.y! < 0) throw new Error('点击坐标无效')
      point = { x: request.x!, y: request.y! }
      const viewport = await this.evaluate<{ width: number; height: number }>(entry, '({width:innerWidth,height:innerHeight})')
      if (point.x >= viewport.width || point.y >= viewport.height) throw new Error('点击坐标超出页面视口')
    }
    this.assertNavigation(entry, navigationId)
    assertActive()
    await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }

  private async fill(entry: BrowserEntry, request: BrowserToolRequest, assertActive: () => void, signal?: AbortSignal): Promise<void> {
    const navigationId = entry.state.navigationId
    if (typeof request.text !== 'string' || request.text.length > 100000) throw new Error('输入内容无效或过长')
    await this.focus(entry, signal)
    assertActive()
    await this.withElement(entry, request, `function(){
      if (!(this instanceof HTMLElement) || !this.isConnected) throw new Error('元素已离开页面');
      if (this.matches(':disabled,[readonly],[aria-disabled="true"]')) throw new Error('输入框不可编辑');
      if(this instanceof HTMLInputElement&&['file','hidden','checkbox','radio','button','submit'].includes(this.type)) throw new Error('此元素不支持文本输入');
      if(!(this instanceof HTMLInputElement)&&!(this instanceof HTMLTextAreaElement)&&!this.isContentEditable) throw new Error('目标不是输入框');
      this.scrollIntoView({block:'center',behavior:'instant'}); this.focus();
      if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r)}
      else if(typeof this.select==='function') this.select();
      return true;
    }`, assertActive)
    this.assertNavigation(entry, navigationId)
    assertActive()
    await this.command(entry, 'Input.insertText', { text: request.text })
  }

  private async pressKey(entry: BrowserEntry, key: string | undefined, assertActive: () => void, signal?: AbortSignal): Promise<void> {
    const navigationId = entry.state.navigationId
    if (!key || key.length > 80) throw new Error('按键无效')
    await this.focus(entry, signal)
    assertActive()
    const parts = key.split('+')
    const raw = parts.pop()!
    let modifiers = 0
    for (const modifier of parts) {
      const flag = ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 } as Record<string, number>)[modifier]
      if (!flag) throw new Error(`不支持的修饰键：${modifier}`)
      modifiers |= flag
    }
    const definitions: Record<string, [string, string, number]> = {
      Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27],
      Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
      ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
      Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Space: [' ', 'Space', 32]
    }
    const definition = definitions[raw] ?? (raw.length === 1 ? [raw, /^[a-z]$/i.test(raw) ? `Key${raw.toUpperCase()}` : '', raw.toUpperCase().charCodeAt(0)] as [string, string, number] : undefined)
    if (!definition) throw new Error(`不支持的按键：${raw}`)
    const [keyValue, code, windowsVirtualKeyCode] = definition
    const input = { key: keyValue, code, windowsVirtualKeyCode, modifiers }
    this.assertNavigation(entry, navigationId)
    assertActive()
    await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyDown', ...input, ...(raw === 'Enter' ? { text: '\r' } : !modifiers && keyValue.length === 1 ? { text: keyValue } : {}) })
    await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyUp', ...input })
  }

  private async scroll(entry: BrowserEntry, request: BrowserToolRequest, assertActive: () => void, signal?: AbortSignal): Promise<void> {
    const navigationId = entry.state.navigationId
    await this.focus(entry, signal)
    assertActive()
    const deltaX = request.deltaX ?? 0
    const deltaY = request.deltaY ?? 600
    if (![deltaX, deltaY].every((value) => Number.isFinite(value) && Math.abs(value) <= 10000)) throw new Error('滚动距离无效')
    this.assertNavigation(entry, navigationId)
    if (request.ref || request.selector) {
      await this.withElement(entry, request, `function(){this.scrollBy({left:${deltaX},top:${deltaY},behavior:'instant'});return true}`, assertActive)
    } else {
      await this.debugger(entry)
      assertActive()
      await this.evaluate(entry, `window.scrollBy({left:${deltaX},top:${deltaY},behavior:'instant'})`)
    }
  }

  private async waitFor(entry: BrowserEntry, request: BrowserToolRequest, assertActive: () => void): Promise<BrowserSnapshot> {
    if (!request.selector && !request.text) throw new Error('等待需要 selector 或 text 条件')
    if (request.selector && request.selector.length > 2000 || request.text && request.text.length > 4000) throw new Error('等待条件过长')
    const timeout = duration(request.timeoutMs)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      this.entry(entry.state.tabId)
      assertActive()
      const matched = await this.evaluate<boolean>(entry, `(()=>{${request.selector ? `const element=document.querySelector(${JSON.stringify(request.selector)});if(!element||!element.getClientRects().length)return false;` : ''}${request.text ? `if(!(document.body?.innerText||'').includes(${JSON.stringify(request.text)}))return false;` : ''}return true})()`)
      if (matched) return this.snapshot(entry)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`等待页面条件超时 (${timeout}ms)`)
  }
}
