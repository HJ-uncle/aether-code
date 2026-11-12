/**
 * 终端会话 store（渲染层）
 *
 * 多标签的核心：xterm 实例与会话绑定而非与视图绑定。
 * 标签切换只是显隐 DOM（xterm 只能 open 一次），shell 进程与
 * 滚动缓冲始终存活；后台会话的输出照常写入各自的缓冲。
 *
 * 本地轨：node-pty 跑在 IDE 主进程，经 IPC 收发；远端轨由主进程代理
 * 引擎的 authenticated WebSocket。会话对象对上层保持同一 transport 面。
 * 会话对象本身不可变（id/title/term/fit/transport），可变的运行态
 * （attached/dead/cleanup）放在模块级 internals 登记表里，
 * 更新走「取旧值 → 展开覆盖 → set 新对象」。
 */
import { useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalDataEvent, TerminalExitInfo } from '@shared/ipc'
import { toast } from '@renderer/core/toast'
import { getSettings, getSnapshot } from '@renderer/core/engine/client'
import { engineConnectionKey, engineStorageKey, getEngineSource, getEngineStorageKey, sessionStorageKey } from '@renderer/core/engine/source'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { captureSessionFileTarget } from '@renderer/core/workspace/fs-client'
import { buildTerminalTheme } from './terminal-theme'
import { getTerminalPreferences, onTerminalPreferencesChanged } from './terminal-preferences'

/** 本地轨共用的会话操作面：上层不感知数据是走 IPC 还是 WS */
export interface TerminalTransport {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  dispose: () => void
}

export interface TerminalSession {
  id: string
  title: string
  term: Terminal
  fit: FitAddon
  transport: TerminalTransport
  /** Origin remains fixed when another workspace/account is selected. */
  source: string
  cwd?: string
  sessionId?: string
  /** Explicit Work ownership keeps task terminals out of the shared Code list. */
  scopedToSession?: boolean
}

export type TerminalStatus = 'running' | 'disconnected' | 'exited' | 'reconnecting'

/** 会话运行态：与不可变会话对象分离 */
interface SessionInternals {
  /** xterm 只能 open 一次：首次挂载容器后置真 */
  attached: boolean
  /** shell 已退出或连接已断：保留现场供查看，标签置灰，可手动关闭 */
  status: TerminalStatus
  /** 退订该会话的全部事件 / 释放传输层 */
  cleanup: () => void
}

interface TerminalState {
  sessions: TerminalSession[]
  activeId: string | null
  /** 创建进行中：守卫挂载竞态与 StrictMode 双执行 */
  creating: boolean
  /** 会话序号，只增不减，保证标题唯一 */
  counter: number
  /**
   * 用户主动关掉了全部会话：视图层的「无会话自动新建」要跳过，
   * 否则关掉最后一个标签会立刻弹出一个新终端。下次 createSession 复位。
   */
  closedAll: boolean
  /**
   * 上次创建失败的原始信息（如环境不支持 ConPTY）。
   * 非 null 时视图层停止自动重试，改为提示用户；下次显式创建前清空。
   */
  createFailed: string | null
}

const internals = new Map<string, SessionInternals>()
const sessionScopeStates = new Map<string, { closedAll: boolean; createFailed: string | null }>()
const scopeKey = (sessionId: string, source = getEngineStorageKey()): string => JSON.stringify([source, sessionId])
export function getTerminalScopeState(sessionId?: string): { closedAll: boolean; createFailed: string | null } {
  return sessionId === undefined ? state : sessionScopeStates.get(scopeKey(sessionId)) ?? { closedAll: false, createFailed: null }
}
interface TerminalCreation {
  scope?: string
  replacingId?: string
  detach?: () => void
}
let pendingCreation: TerminalCreation | null = null

/** Cancellation releases only its own attempt; a late IPC result must not
 * clear a newer task's creating flag or restart a deliberately closed scope. */
function cancelCreation(creation: TerminalCreation): void {
  if (pendingCreation !== creation) return
  pendingCreation = null
  creation.detach?.()
  if (creation.scope) sessionScopeStates.set(creation.scope, { closedAll: true, createFailed: null })
  setState({ creating: false, ...(!creation.scope ? { closedAll: true, createFailed: null } : {}) })
}

function withInternals(id: string, patch: Partial<SessionInternals>): void {
  const current = internals.get(id)
  if (current) internals.set(id, { ...current, ...patch })
}

let state: TerminalState = {
  sessions: [],
  activeId: null,
  creating: false,
  counter: 0,
  closedAll: false,
  createFailed: null
}
const listeners = new Set<() => void>()

// Settings changes apply to existing sessions as well as newly created ones,
// matching VS Code's live terminal preference behavior.
onTerminalPreferencesChanged(() => {
  const preferences = getTerminalPreferences()
  for (const session of state.sessions) {
    session.term.options.fontFamily = preferences.fontFamily
    session.term.options.fontSize = preferences.fontSize
    session.term.options.lineHeight = preferences.lineHeight
    session.term.options.cursorBlink = preferences.cursorBlink
    session.term.options.scrollback = preferences.scrollback
  }
  if (state.sessions.length > 0) setState({ sessions: [...state.sessions] })
})

function setState(patch: Partial<TerminalState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getTerminalState(): TerminalState {
  return state
}

export function onTerminalChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTerminalStore(): TerminalState {
  return useSyncExternalStore(onTerminalChanged, getTerminalState)
}

/** 标签置灰用：会话是否已退出/断开 */
export function isSessionDead(id: string): boolean {
  return getSessionStatus(id) !== 'running'
}

export function getSessionStatus(id: string): TerminalStatus {
  return internals.get(id)?.status ?? 'exited'
}

export function renameSession(id: string, title: string): void {
  const name = title.trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('请输入 1–80 个字符的终端名称，不含控制字符')
  setState({ sessions: state.sessions.map(session => session.id === id ? { ...session, title: name } : session) })
}

export function clearSession(id: string): void {
  const term = state.sessions.find(session => session.id === id)?.term
  term?.clearSelection()
  term?.clear()
}

/** 挂载点用：xterm 是否已 open 过 */
export function isSessionAttached(id: string): boolean {
  return internals.get(id)?.attached ?? false
}

export function markSessionAttached(id: string): void {
  withInternals(id, { attached: true })
}

export function setActiveSession(id: string): void {
  if (state.activeId !== id) setState({ activeId: id })
}

/** 清除终端显示和滚动历史，不向 shell 发送命令。 */
export function clearActiveSession(): void {
  if (state.activeId) clearSession(state.activeId)
}

/**
 * 复制选区到系统剪贴板，失败时报错而非静默——静默会让用户以为按了没反应。
 * 右键菜单与 Ctrl+C 快捷键共用这一条路径，两处反馈保持一致。
 */
export async function copyTerminalSelection(selection: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(selection)
    toast.success('已复制终端选区')
  } catch (error) {
    toast.error(`复制失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Paste through xterm so newline normalization and bracketed paste stay intact. */
export async function pasteTerminalClipboard(id: string): Promise<void> {
  const session = state.sessions.find(item => item.id === id)
  if (!session || isSessionDead(id)) {
    toast.info('终端未连接，请恢复连接或重新启动后粘贴')
    return
  }
  try {
    const text = await navigator.clipboard.readText()
    // Reading the OS clipboard is asynchronous. Never redirect a pending paste
    // into a newly selected tab, or write to a disposed terminal.
    if (state.activeId !== id || !state.sessions.includes(session) || isSessionDead(id) || !session.term.element?.getClientRects().length) {
      toast.info('目标终端已关闭或切换，请重新粘贴')
      return
    }
    if (!text) {
      toast.info('剪贴板中没有可粘贴的文本')
      session.term.focus()
      return
    }
    session.term.clearSelection()
    session.term.focus()
    session.term.paste(text)
  } catch (error) {
    toast.error(`粘贴失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function newTerminal(id: string): { term: Terminal; fit: FitAddon } {
  const preferences = getTerminalPreferences()
  const term = new Terminal({
    fontFamily: preferences.fontFamily,
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    cursorBlink: preferences.cursorBlink,
    scrollback: preferences.scrollback,
    allowProposedApi: true,
    // 背景与面板区同材质（--bg-surface），终端不再是一块"贴进来的黑砖"
    theme: buildTerminalTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const isMac = navigator.platform.toLowerCase().includes('mac')
  // xterm maps Ctrl+V to ^V and cancels the browser's native paste event.
  // Handle clipboard shortcuts before that mapping, using one paste path for
  // both keyboard and context menu. Ctrl+C without a selection still interrupts.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const key = event.key.toLowerCase()
    const primaryModifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    const paste = !event.altKey && ((key === 'v' && primaryModifier) ||
      (key === 'insert' && event.shiftKey && !event.ctrlKey && !event.metaKey))
    if (paste) {
      event.preventDefault()
      event.stopPropagation()
      void pasteTerminalClipboard(id)
      return false
    }
    if (key !== 'c' || !primaryModifier || event.altKey) return true
    const selection = term.getSelection()
    if (!selection) return true
    event.preventDefault()
    event.stopPropagation()
    void copyTerminalSelection(selection)
    term.clearSelection()
    return false
  })

  return { term, fit }
}

/** 会话死亡时统一收尾：置灰标记 + 提示文案（只写一次）+ 触发重渲染 */
function markDead(id: string, term: Terminal, message: string, status: 'disconnected' | 'exited' = 'exited'): void {
  // 会话已关闭（internals 已删）时 transport.dispose 会触发一次 onClose，
  // 此时 xterm 已 dispose，不能再写入
  if (!internals.has(id) || getSessionStatus(id) === 'exited' || getSessionStatus(id) === status) return
  withInternals(id, { status })
  term.write(`\r\n\x1b[90m[${message}]\x1b[0m`)
  setState({ sessions: [...state.sessions] })
}

/** 结束创建：登记会话并激活（两条轨道共用） */
function registerSession(session: TerminalSession): void {
  setState({
    sessions: [...state.sessions, session],
    activeId: session.id,
    counter: state.counter + 1,
    creating: false,
    ...(!session.scopedToSession ? { closedAll: false } : {})
  })
}

/** 新建终端；cwd 跟随工作区根目录（未打开文件夹时用主目录） */
export async function createLocalSession(cwd?: string, sessionId?: string): Promise<void> {
  await createSession(cwd, undefined, sessionId)
}

async function createSession(cwd?: string, replacing?: TerminalSession, requestedSessionId?: string): Promise<void> {
  if (state.creating) return
  const sourceGeneration = getEngineSource()
  const scopedToSession = replacing?.scopedToSession ?? requestedSessionId !== undefined
  const ownedSessionId = replacing?.sessionId ?? requestedSessionId?.trim()
  const creationScope = scopedToSession ? scopeKey(ownedSessionId ?? '', replacing?.source ?? getEngineStorageKey()) : undefined
  const creation: TerminalCreation = { scope: creationScope, replacingId: replacing?.id }
  pendingCreation = creation
  const currentCreation = (): boolean => pendingCreation === creation && sourceGeneration === getEngineSource()
  const setCreation = (creating: boolean, createFailed: string | null): void => {
    if (creationScope) {
      sessionScopeStates.set(creationScope, { closedAll: false, createFailed })
      setState({ creating })
    } else setState({ creating, createFailed, closedAll: false })
  }
  // 显式创建是一次新的尝试：清掉上次的失败标记，成功与否都重新如实记录
  setCreation(true, null)
  let createdId: string | undefined
  let pendingTerm: Terminal | undefined
  let offEarlyData: (() => void) | undefined
  let offEarlyExit: (() => void) | undefined
  // Keep the creation listeners alive until the per-session listeners are
  // installed. IPC can deliver the shell banner in the small window between
  // `internals.set` and `window.aether.terminal.onData`; using `internals.has`
  // as the filter here would silently drop that output.
  let createdEventId: string | undefined
  let routeLive = false
  try {
    if (scopedToSession && !ownedSessionId) throw new Error('请先选择当前任务，再创建终端')
    const [settings, snapshot] = await Promise.all([getSettings(), getSnapshot()])
    if (!currentCreation()) return
    if (replacing && (replacing.source !== engineStorageKey(snapshot) || !state.sessions.some(session => session.id === replacing.id))) {
      throw new Error('终端所属连接或账号已变化，请在当前工作区新建终端')
    }
    // Command-palette actions bypass the view's disabled button. Check the
    // authoritative snapshot here too; waiting for a remote connection is not
    // a failed PTY launch, and must never fall back to creating a local shell.
    const remote = snapshot.mode === 'remote' || (snapshot.phase !== 'ready' && settings.engineMode === 'remote')
    if (remote && (snapshot.mode !== 'remote' || snapshot.phase !== 'ready')) {
      if (replacing) throw new Error('请先连接远端引擎')
      return
    }
    // 后台创建用默认尺寸，首次挂载时由 fit 修正
    // Capture ownership for local PTYs too; later model reads must not infer it
    // from whichever conversation happens to be selected at read time.
    let sessionId: string | undefined = ownedSessionId ?? (settings.lastSessionId.trim() || undefined)
    if (remote && ownedSessionId === undefined) {
      sessionId = settings.lastSessionId.trim()
      const source = getEngineStorageKey()
      if (source) {
        try { sessionId = localStorage.getItem(sessionStorageKey('aether:lastSessionId', source))?.trim() || sessionId } catch { /* optional persistence */ }
      }
      if (replacing?.sessionId) sessionId = replacing.sessionId
    }
    // Scratch tasks have no project hint. Resolve their own workspace instead
    // of silently starting a local shell in Code's workspace or the home folder.
    const resolvedCwd = !remote && scopedToSession && !cwd && sessionId
      ? (await captureSessionFileTarget(sessionId)).root
      : cwd
    const current = await getSnapshot()
    if (!currentCreation() || current.mode !== snapshot.mode || (remote && (current.phase !== 'ready' || engineConnectionKey(current) !== engineConnectionKey(snapshot)))) return
    // Shell banners can arrive during the IPC creation handshake. Listen before
    // creating, then replay only the returned terminal's events in their order.
    const early: ({ kind: 'data'; value: TerminalDataEvent } | { kind: 'exit'; value: TerminalExitInfo })[] = []
    offEarlyData = window.aether.terminal.onData(value => {
      // Before create() resolves we do not know the id, so retain all events
      // and filter them during replay. Once it resolves, retain only the new
      // session. Do not consult internals here: that entry is created before
      // the live event listeners below and would otherwise create a race.
      if (!routeLive && (!createdEventId || value.id === createdEventId)) early.push({ kind: 'data', value })
    })
    offEarlyExit = window.aether.terminal.onExit(value => {
      if (!routeLive && (!createdEventId || value.id === createdEventId)) early.push({ kind: 'exit', value })
    })
    creation.detach = () => { offEarlyData?.(); offEarlyExit?.() }
    const { id } = await window.aether.terminal.create({ cwd: resolvedCwd, cols: 80, rows: 24, ...(sessionId ? { sessionId } : {}) })
    createdId = id
    createdEventId = id
    const after = await getSnapshot()
    if (!currentCreation() || engineConnectionKey(after) !== engineConnectionKey(snapshot) || (remote && after.phase !== 'ready') ||
        (replacing && !state.sessions.some(session => session.id === replacing.id))) {
      throw new Error('连接或目标终端已变化，终端创建已取消')
    }
    const { term, fit } = newTerminal(id)
    pendingTerm = term

    const transport: TerminalTransport = {
      write: (data) => { if (!isSessionDead(id)) void window.aether.terminal.write(id, data).catch(error => markDead(id, term, ipcErrorMessage(error), id.startsWith('remote:') ? 'disconnected' : 'exited')) },
      resize: (cols, rows) => { if (!isSessionDead(id)) void window.aether.terminal.resize(id, cols, rows).catch(error => markDead(id, term, ipcErrorMessage(error), id.startsWith('remote:') ? 'disconnected' : 'exited')) },
      dispose: () => { void window.aether.terminal.dispose(id).catch(error => toast.error(`关闭终端失败：${ipcErrorMessage(error)}`)) }
    }

    internals.set(id, { attached: false, status: 'running', cleanup: () => {} })

    // 会话级数据路由：只把属于自己的数据写进自己的缓冲
    const receiveData = (event: TerminalDataEvent): void => {
      if (event.id === id && routeLive) term.write(event.chunk)
    }
    const receiveExit = (info: TerminalExitInfo): void => {
      if (info.id !== id || !routeLive) return
      const cleanupMessage = info.cleanupError
        ? `${info.cleanupError.code}: ${info.cleanupError.message}`
        : undefined
      markDead(id, term, cleanupMessage ?? info.reason ?? `进程已退出，代码 ${info.exitCode}`, info.status ?? 'exited')
    }
    const offData = window.aether.terminal.onData(receiveData)
    const offExit = window.aether.terminal.onExit(receiveExit)
    offEarlyData(); offEarlyExit()
    routeLive = true
    const offInput = term.onData((data) => transport.write(data))
    withInternals(id, {
      cleanup: () => {
        offData()
        offExit()
        offInput.dispose()
        transport.dispose()
      }
    })

    // The replacement now exists; closing its old tab must not cancel the
    // completed attempt or mark the newly registered scope as closed.
    pendingCreation = null
    registerSession({
      id,
      title: replacing?.title ?? `终端 ${state.counter + 1}`,
      term,
      fit,
      transport,
      source: engineStorageKey(snapshot),
      cwd: resolvedCwd,
      sessionId,
      scopedToSession
    })
    createdId = undefined
    pendingTerm = undefined
    for (const event of early) {
      if (event.kind === 'data') receiveData(event.value)
      else receiveExit(event.value)
    }
    // Keep the previous output available until a replacement actually exists.
    if (replacing) closeSession(replacing.id)
  } catch (error) {
    if (createdId) {
      const entry = internals.get(createdId)
      internals.delete(createdId)
      if (entry) entry.cleanup()
      else void window.aether.terminal.dispose(createdId).catch(() => undefined)
      pendingTerm?.dispose()
    }
    if (!currentCreation()) return
    // 创建失败（如环境不支持 ConPTY）不能只把 creating 复位了事：
    // 视图层的「无会话则自动新建」effect 依赖 sessions.length/creating，
    // 复位后依赖变化会立刻再触发一次创建 —— 失败-复位-重试的无限循环。
    // 用 createFailed 顶住，让视图层知道"这次尝试明确失败了"，不再自动重试。
    setCreation(false, ipcErrorMessage(error))
    if (state.sessions.length > 0) toast.error(`终端启动失败：${ipcErrorMessage(error)}`)
  } finally {
    offEarlyData?.()
    offEarlyExit?.()
    if (pendingCreation === creation) {
      pendingCreation = null
      if (state.creating) setState({ creating: false })
    }
  }
}

export async function reconnectSession(id: string): Promise<void> {
  const session = state.sessions.find(item => item.id === id)
  if (!session || getSessionStatus(id) !== 'disconnected') return
  withInternals(id, { status: 'reconnecting' })
  setState({ sessions: [...state.sessions] })
  try {
    await window.aether.terminal.reconnect(id)
    if (!internals.has(id) || getSessionStatus(id) !== 'reconnecting') return
    withInternals(id, { status: 'running' })
    session.transport.resize(session.term.cols, session.term.rows)
    session.term.write('\r\n\x1b[90m[终端连接已恢复]\x1b[0m\r\n')
    if (state.activeId === id && session.term.element?.getClientRects().length) session.term.focus()
  } catch (error) {
    if (!internals.has(id)) return
    if (getSessionStatus(id) === 'reconnecting') withInternals(id, { status: 'disconnected' })
    toast.error(`恢复终端连接失败：${ipcErrorMessage(error)}`)
  }
  setState({ sessions: [...state.sessions] })
}

export async function restartSession(id: string): Promise<void> {
  const session = state.sessions.find(item => item.id === id)
  if (!session || getSessionStatus(id) === 'reconnecting') return
  await createSession(session.cwd, session)
}

export function closeOtherSessions(id: string, visibleIds?: readonly string[]): void {
  for (const session of [...state.sessions]) if (session.id !== id && (!visibleIds || visibleIds.includes(session.id))) closeSession(session.id)
}

export function closeAllSessions(visibleIds?: readonly string[], scope?: { sessionId: string; source?: string }): void {
  const targetScope = scope ? scopeKey(scope.sessionId, scope.source ?? getEngineStorageKey()) : undefined
  // Work may display a Code-origin terminal for the same session. The caller's
  // scope, rather than the listed terminal's origin, owns a pending creation.
  for (const session of [...state.sessions]) if (!visibleIds || visibleIds.includes(session.id)) closeTerminalSession(session.id, false)
  if (targetScope) sessionScopeStates.set(targetScope, { closedAll: true, createFailed: null })
  const creation = pendingCreation
  if (creation && (!visibleIds || creation.scope === targetScope)) cancelCreation(creation)
  setState(!scope ? { closedAll: true, createFailed: null } : {})
}

/** 关闭会话：杀 shell、释放 xterm、激活标签落到右侧最后一个 */
export function closeSession(id: string): void {
  closeTerminalSession(id, true)
}

function closeTerminalSession(id: string, cancelPending: boolean): void {
  const session = state.sessions.find((item) => item.id === id)
  if (!session) return

  const entry = internals.get(id)
  internals.delete(id)
  entry?.cleanup()
  session.term.dispose()

  const remaining = state.sessions.filter((item) => item.id !== id)
  if (session.sessionId && !remaining.some(item => item.source === session.source && item.sessionId === session.sessionId)) {
    sessionScopeStates.set(scopeKey(session.sessionId, session.source), { closedAll: true, createFailed: null })
  }
  const creation = pendingCreation
  const closedScope = session.sessionId ? scopeKey(session.sessionId, session.source) : undefined
  if (cancelPending && creation && (creation.replacingId === id ||
      (creation.scope ? creation.scope === closedScope && !remaining.some(item => item.source === session.source && item.sessionId === session.sessionId)
        : !session.scopedToSession && !remaining.some(item => !item.scopedToSession)))) cancelCreation(creation)
  setState({
    sessions: remaining,
    activeId:
      state.activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : state.activeId,
    ...(!session.scopedToSession ? { closedAll: remaining.every(item => item.scopedToSession) } : {})
  })
}
