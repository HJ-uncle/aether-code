/** Authenticated PTY websocket transport owned by the Electron main process. */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { EngineSnapshot, TerminalCreateInput, TerminalExitInfo } from '../../shared/ipc'
import { engineTargetError } from '../engine/protocol'
import { engineHost } from '../engine/host'
import { getSettings } from '../settings-store'

interface Target { snapshot: EngineSnapshot; headers: Record<string, string>; signal: AbortSignal }
interface Callbacks { onData: (id: string, chunk: string) => void; onExit: (info: TerminalExitInfo) => void }
interface Session extends Callbacks { id: string; remoteId: string; target: Target; socket: WebSocket; ended: boolean; disposed: boolean; abort: () => void }

/** One service instance is shared by IPC handlers; sessions are endpoint-bound. */
export class RemoteTerminalService {
  private readonly sessions = new Map<string, Session>()
  constructor(private readonly getTarget: () => Target, private readonly getSessionId: () => string = () => getSettings().lastSessionId.trim()) {}
  owns(id: string): boolean { return this.sessions.has(id) }

  private current(target: Target): boolean {
    const next = this.getTarget()
    return !target.signal.aborted && next.snapshot.phase === 'ready' && engineTargetError(next.snapshot, target.snapshot) === null
  }

  async create(input: TerminalCreateInput, callbacks: Callbacks): Promise<{ id: string }> {
    const target = this.getTarget()
    if (target.snapshot.mode !== 'remote' || target.snapshot.phase !== 'ready') throw new Error('请先连接远端引擎')
    const sessionId = input.sessionId?.trim() || this.getSessionId()
    if (!sessionId) throw new Error('远程终端缺少会话 ID，请先创建或打开一个会话')
    if (![input.cols, input.rows].every(value => Number.isInteger(value) && value > 0)) throw new Error('终端尺寸无效')
    const response = await fetch(`${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...target.headers },
      body: JSON.stringify({ sessionId, cols: input.cols, rows: input.rows }),
      signal: AbortSignal.any([target.signal, AbortSignal.timeout(120_000)]), redirect: 'error'
    })
    const envelope = await response.json().catch(() => ({})) as { code?: number; message?: string; data?: { terminalId?: string } }
    const remoteId = envelope.data?.terminalId
    if (!response.ok || (envelope.code !== 200 && envelope.code !== 0) || typeof remoteId !== 'string' || !remoteId) throw new Error(envelope.message || `远程终端创建失败（HTTP ${response.status}）`)
    if (!this.current(target)) { await this.removeRemote(target, remoteId); throw new Error('引擎连接已变化，终端创建已取消') }
    const url = new URL(`${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/ws/${encodeURIComponent(remoteId)}`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: target.headers, followRedirects: false, handshakeTimeout: 15_000 })
    const id = `remote:${randomUUID()}`
    const session: Session = {
      id, remoteId, target, socket, ...callbacks, ended: false, disposed: false,
      abort: () => {
        this.end(id, 1, '远程引擎连接已断开；请重新创建终端')
        void this.removeRemote(target, remoteId)
      }
    }
    this.sessions.set(id, session)
    const opened = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', () => reject(new Error('远程终端 WebSocket 连接失败')))
      socket.once('close', () => reject(new Error('远程终端连接在就绪前关闭')))
    })
    socket.on('message', raw => {
      if (session.ended || session.disposed || !this.current(target)) return
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: string; code?: number; message?: string }
        if (message.type === 'output' && typeof message.data === 'string') callbacks.onData(id, message.data)
        else if (message.type === 'exit') this.end(id, Number.isFinite(message.code) ? message.code! : 0)
        else if (message.type === 'error') this.end(id, 1, message.message || '远程终端返回错误')
      } catch { this.end(id, 1, '远程终端返回了无效数据') }
    })
    socket.on('close', () => this.end(id, 1, '远程终端连接已断开；请重新创建终端'))
    socket.on('error', () => this.end(id, 1, '远程终端连接失败，请检查服务状态后重新创建终端'))
    target.signal.addEventListener('abort', session.abort, { once: true })
    try { await opened; if (!this.current(target) || session.ended) throw new Error('引擎连接已变化，终端创建已取消'); return { id } } catch (error) { await this.dispose(id); throw error }
  }

  private end(id: string, exitCode: number, message?: string): void {
    const session = this.sessions.get(id)
    if (!session || session.ended || session.disposed) return
    session.ended = true; session.target.signal.removeEventListener('abort', session.abort)
    session.onExit({ id, exitCode, ...(message ? { reason: message } : {}) }); session.socket.terminate()
    if (message) void this.removeRemote(session.target, session.remoteId)
  }
  private send(id: string, message: Record<string, unknown>): void {
    const session = this.sessions.get(id)
    if (!session || session.ended || session.disposed) return
    if (!this.current(session.target)) { this.end(id, 1); return }
    if (session.socket.readyState !== WebSocket.OPEN) { this.end(id, 1); return }
    session.socket.send(JSON.stringify(message))
  }
  write(id: string, data: string): void { this.send(id, { type: 'input', data }) }
  resize(id: string, cols: number, rows: number): void { if (cols > 0 && rows > 0) this.send(id, { type: 'resize', cols, rows }) }
  async dispose(id: string): Promise<void> {
    const session = this.sessions.get(id); if (!session || session.disposed) return
    session.disposed = true; this.sessions.delete(id); session.target.signal.removeEventListener('abort', session.abort)
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'kill' }))
    session.socket.close(); await this.removeRemote(session.target, session.remoteId); session.socket.terminate()
  }
  async disposeAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map(id => this.dispose(id))) }
  private async removeRemote(target: Target, remoteId: string): Promise<void> {
    await fetch(`${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/${encodeURIComponent(remoteId)}`, { method: 'DELETE', headers: target.headers, signal: AbortSignal.timeout(5_000), redirect: 'error' }).catch(() => undefined)
  }
}

export const remoteTerminalService = new RemoteTerminalService(() => ({ snapshot: engineHostSnapshot(), headers: engineHostHeaders(), signal: engineHostSignal() }))

// Narrow indirection avoids exposing the mutable EngineHost object to tests and
// keeps this transport's dependency surface to the three authenticated accessors.
function engineHostSnapshot(): EngineSnapshot { return engineHost.getSnapshot() }
function engineHostHeaders(): Record<string, string> { return engineHost.requestHeaders() }
function engineHostSignal(): AbortSignal { return engineHost.requestSignal }
