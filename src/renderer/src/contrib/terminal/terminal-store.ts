/**
 * 终端会话 store（渲染层）
 *
 * 多标签的核心：xterm 实例与会话绑定而非与视图绑定。
 * 标签切换只是显隐 DOM（xterm 只能 open 一次），shell 进程与
 * 滚动缓冲始终存活；后台会话的输出照常写入各自的缓冲。
 *
 * 本地轨：node-pty 跑在 IDE 主进程，经 IPC 收发，不依赖引擎。
 * 会话对象本身不可变（id/title/term/fit/transport），可变的运行态
 * （attached/dead/cleanup）放在模块级 internals 登记表里，
 * 更新走「取旧值 → 展开覆盖 → set 新对象」。
 */
import { useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { buildTerminalTheme } from './terminal-theme'

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
}

/** 会话运行态：与不可变会话对象分离 */
interface SessionInternals {
  /** xterm 只能 open 一次：首次挂载容器后置真 */
  attached: boolean
  /** shell 已退出或连接已断：保留现场供查看，标签置灰，可手动关闭 */
  dead: boolean
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
  return internals.get(id)?.dead ?? false
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

/** 清空激活会话的屏幕（滚动缓冲保留在 shell 侧，这里只清视图） */
export function clearActiveSession(): void {
  state.sessions.find((item) => item.id === state.activeId)?.term.clear()
}

function newTerminal(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 12,
    cursorBlink: true,
    allowProposedApi: true,
    // 背景与面板区同材质（--bg-surface），终端不再是一块"贴进来的黑砖"
    theme: buildTerminalTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  return { term, fit }
}

/** 会话死亡时统一收尾：置灰标记 + 提示文案（只写一次）+ 触发重渲染 */
function markDead(id: string, term: Terminal, message: string): void {
  // 会话已关闭（internals 已删）时 transport.dispose 会触发一次 onClose，
  // 此时 xterm 已 dispose，不能再写入
  if (!internals.has(id) || isSessionDead(id)) return
  withInternals(id, { dead: true })
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
  if (state.creating) return
  // 显式创建是一次新的尝试：清掉上次的失败标记，成功与否都重新如实记录
  setState({ creating: true, createFailed: null, closedAll: false })
  try {
    // 后台创建用默认尺寸，首次挂载时由 fit 修正
    const { id } = await window.aether.terminal.create({ cwd, cols: 80, rows: 24 })
    const { term, fit } = newTerminal()

    const transport: TerminalTransport = {
      write: (data) => void window.aether.terminal.write(id, data),
      resize: (cols, rows) => void window.aether.terminal.resize(id, cols, rows),
      dispose: () => void window.aether.terminal.dispose(id)
    }

    internals.set(id, { attached: false, dead: false, cleanup: () => {} })

    // 会话级数据路由：只把属于自己的数据写进自己的缓冲
    const offData = window.aether.terminal.onData((event) => {
      if (event.id === id) term.write(event.chunk)
    })
    const offExit = window.aether.terminal.onExit((info) => {
      if (info.id !== id) return
      markDead(id, term, `进程已退出，代码 ${info.exitCode}`)
    })
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
      title: `终端 ${state.counter + 1}`,
      term,
      fit,
      transport
    })
  } catch (error) {
    // 创建失败（如环境不支持 ConPTY）不能只把 creating 复位了事：
    // 视图层的「无会话则自动新建」effect 依赖 sessions.length/creating，
    // 复位后依赖变化会立刻再触发一次创建 —— 失败-复位-重试的无限循环。
    // 用 createFailed 顶住，让视图层知道"这次尝试明确失败了"，不再自动重试。
    setState({ creating: false, createFailed: String(error) })
  }
}

/** 关闭会话：杀 shell、释放 xterm、激活标签落到右侧最后一个 */
export function closeSession(id: string): void {
  const session = state.sessions.find((item) => item.id === id)
  if (!session) return

  internals.get(id)?.cleanup()
  internals.delete(id)
  session.term.dispose()

  const remaining = state.sessions.filter((item) => item.id !== id)
  setState({
    sessions: remaining,
    activeId:
      state.activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : state.activeId,
    closedAll: remaining.length === 0
  })
}
