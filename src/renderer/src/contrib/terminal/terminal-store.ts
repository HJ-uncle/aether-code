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
import { engineConnectionKey, engineStorageKey, getEngineStorageKey, sessionStorageKey } from '@renderer/core/engine/source'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
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
let creationGeneration = 0

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
    if (state.activeId !== id || !state.sessions.includes(session) || isSessionDead(id)) {
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
    closedAll: false
  })
}

/** 新建终端；cwd 跟随工作区根目录（未打开文件夹时用主目录） */
export async function createLocalSession(cwd?: string): Promise<void> {
  await createSession(cwd)
}

async function createSession(cwd?: string, replacing?: TerminalSession): Promise<void> {
  if (state.creating) return
  const generation = ++creationGeneration
  // 显式创建是一次新的尝试：清掉上次的失败标记，成功与否都重新如实记录
  setState({ creating: true, createFailed: null, closedAll: false })
  let createdId: string | undefined
  let pendingTerm: Terminal | undefined
  let offEarlyData: (() => void) | undefined
  let offEarlyExit: (() => void) | undefined
  try {
    const [settings, snapshot] = await Promise.all([getSettings(), getSnapshot()])
    if (replacing && (replacing.source !== engineStorageKey(snapshot) || !state.sessions.some(session => session.id === replacing.id))) {
      throw new Error('终端所属连接或账号已变化，请在当前工作区新建终端')
    }
    // Command-palette actions bypass the view's disabled button. Check the
    // authoritative snapshot here too; waiting for a remote connection is not
    // a failed PTY launch, and must never fall back to creating a local shell.
    const remote = snapshot.mode === 'remote' || (snapshot.phase !== 'ready' && settings.engineMode === 'remote')
    if (remote && (snapshot.mode !== 'remote' || snapshot.phase !== 'ready')) {
      if (replacing) throw new Error('请先连接远端引擎')
      setState({ creating: false })
      return
    }
    // 后台创建用默认尺寸，首次挂载时由 fit 修正
    let sessionId: string | undefined
    if (remote) {
      sessionId = settings.lastSessionId.trim()
      const source = getEngineStorageKey()
      if (source) {
        try { sessionId = localStorage.getItem(sessionStorageKey('aether:lastSessionId', source))?.trim() || sessionId } catch { /* optional persistence */ }
      }
      if (replacing?.sessionId) sessionId = replacing.sessionId
    }
    const current = await getSnapshot()
    if (generation !== creationGeneration || current.mode !== snapshot.mode || (remote && (current.phase !== 'ready' || engineConnectionKey(current) !== engineConnectionKey(snapshot)))) {
      setState({ creating: false })
      return
    }
    // Shell banners can arrive during the IPC creation handshake. Listen before
    // creating, then replay only the returned terminal's events in their order.
    const early: ({ kind: 'data'; value: TerminalDataEvent } | { kind: 'exit'; value: TerminalExitInfo })[] = []
    offEarlyData = window.aether.terminal.onData(value => { if (!internals.has(value.id)) early.push({ kind: 'data', value }) })
    offEarlyExit = window.aether.terminal.onExit(value => { if (!internals.has(value.id)) early.push({ kind: 'exit', value }) })
    const { id } = await window.aether.terminal.create({ cwd, cols: 80, rows: 24, ...(sessionId ? { sessionId } : {}) })
    createdId = id
    const after = await getSnapshot()
    if (generation !== creationGeneration || engineConnectionKey(after) !== engineConnectionKey(snapshot) || (remote && after.phase !== 'ready') ||
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
      if (event.id === id) term.write(event.chunk)
    }
    const receiveExit = (info: TerminalExitInfo): void => {
      if (info.id !== id) return
      markDead(id, term, info.reason ?? `进程已退出，代码 ${info.exitCode}`, info.status ?? 'exited')
    }
    const offData = window.aether.terminal.onData(receiveData)
    const offExit = window.aether.terminal.onExit(receiveExit)
    offEarlyData(); offEarlyExit()
    const offInput = term.onData((data) => transport.write(data))
    withInternals(id, {
      cleanup: () => {
        offData()
        offExit()
        offInput.dispose()
        transport.dispose()
      }
    })

    registerSession({
      id,
      title: replacing?.title ?? `终端 ${state.counter + 1}`,
      term,
      fit,
      transport,
      source: engineStorageKey(snapshot),
      cwd,
      sessionId
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
    if (generation !== creationGeneration) { setState({ creating: false }); return }
    // 创建失败（如环境不支持 ConPTY）不能只把 creating 复位了事：
    // 视图层的「无会话则自动新建」effect 依赖 sessions.length/creating，
    // 复位后依赖变化会立刻再触发一次创建 —— 失败-复位-重试的无限循环。
    // 用 createFailed 顶住，让视图层知道"这次尝试明确失败了"，不再自动重试。
    setState({ creating: false, createFailed: ipcErrorMessage(error) })
    if (state.sessions.length > 0) toast.error(`终端启动失败：${ipcErrorMessage(error)}`)
  } finally {
    offEarlyData?.()
    offEarlyExit?.()
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
    if (state.activeId === id) session.term.focus()
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

export function closeOtherSessions(id: string): void {
  for (const session of [...state.sessions]) if (session.id !== id) closeSession(session.id)
}

export function closeAllSessions(): void {
  creationGeneration++
  for (const session of [...state.sessions]) closeSession(session.id)
  setState({ closedAll: true })
}

/** 关闭会话：杀 shell、释放 xterm、激活标签落到右侧最后一个 */
export function closeSession(id: string): void {
  const session = state.sessions.find((item) => item.id === id)
  if (!session) return

  const entry = internals.get(id)
  internals.delete(id)
  entry?.cleanup()
  session.term.dispose()

  const remaining = state.sessions.filter((item) => item.id !== id)
  if (remaining.length === 0) creationGeneration++
  setState({
    sessions: remaining,
    activeId:
      state.activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : state.activeId,
    closedAll: remaining.length === 0
  })
}
