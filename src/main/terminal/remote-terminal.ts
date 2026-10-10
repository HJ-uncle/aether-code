/** Authenticated PTY websocket transport owned by the Electron main process. */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { EngineSnapshot, TerminalCreateInput, TerminalExitInfo } from '../../shared/ipc'
import { engineTargetError } from '../engine/protocol'
import { engineHost } from '../engine/host'
import { getSettings } from '../settings-store'

interface Target { snapshot: EngineSnapshot; headers: Record<string, string>; signal: AbortSignal }
interface Callbacks { onData: (id: string, chunk: string) => void; onExit: (info: TerminalExitInfo) => void }
interface Session extends Callbacks {
  id: string
  remoteId: string
  target: Target
  socket: WebSocket | null
  status: 'connecting' | 'connected' | 'disconnected' | 'exited'
  disposed: boolean
  abort: () => void
  connecting?: Promise<void>
  cancelConnection?: () => void
  disposePromise?: Promise<void>
}

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
    const id = `remote:${randomUUID()}`
    const session: Session = {
      id, remoteId, target, socket: null, ...callbacks, status: 'disconnected', disposed: false,
      abort: () => undefined
    }
    this.sessions.set(id, session)
    try { await this.attach(session, target); return { id } }
    catch (error) { await this.dispose(id); throw error }
  }

  async reconnect(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.disposed) throw new Error('此终端已关闭，请新建终端')
    if (session.status === 'exited') throw new Error('终端进程已退出，请重新启动终端')
    const target = this.getTarget()
    if (target.snapshot.mode !== 'remote' || target.snapshot.phase !== 'ready' || target.signal.aborted) throw new Error('请先恢复远端引擎连接，再重试终端连接')
    if (engineTargetError(target.snapshot, session.target.snapshot)) throw new Error('终端所属的引擎实例或账号已变化，请新建终端')
    if (session.status === 'connected' && this.current(session.target)) return
    if (session.connecting) return session.connecting
    const connecting = this.attach(session, target)
    session.connecting = connecting
    try { await connecting }
    finally { if (session.connecting === connecting) session.connecting = undefined }
  }

  private async attach(session: Session, target: Target): Promise<void> {
    session.target.signal.removeEventListener('abort', session.abort)
    session.socket?.terminate()
    session.target = target
    const url = new URL(`${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/ws/${encodeURIComponent(session.remoteId)}`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: target.headers, followRedirects: false, handshakeTimeout: 15_000 })
    session.socket = socket
    session.status = 'connecting'
    const active = (): boolean => !session.disposed && session.socket === socket
    let failConnection: (reason: string) => void = () => undefined
    const stop = (status: 'disconnected' | 'exited', reason: string, code = 1): void => {
      if (!active()) return
      failConnection(reason)
      this.end(session, status, code, reason)
    }
    session.abort = () => stop('disconnected', '远程引擎连接已断开，可在引擎就绪后恢复连接')
    socket.on('message', raw => {
      if (!active()) return
      if (!this.current(target)) { stop('disconnected', '引擎连接已变化，请确认当前引擎后重试'); return }
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: string; code?: number; message?: string }
        if (message.type === 'output' && typeof message.data === 'string') session.onData(session.id, message.data)
        else if (message.type === 'exit') stop('exited', '远程终端进程已退出', Number.isFinite(message.code) ? message.code! : 0)
        else if (message.type === 'error') {
          const reason = message.message || '远程终端返回错误'
          stop(/terminal\b.*not found/i.test(reason) ? 'exited' : 'disconnected', reason)
        }
      } catch { stop('disconnected', '远程终端返回了无效数据') }
    })
    socket.on('close', () => stop('disconnected', '远程终端连接已断开，可尝试恢复连接'))
    socket.on('error', () => stop('disconnected', '远程终端连接失败，请检查服务状态后重试'))
    target.signal.addEventListener('abort', session.abort, { once: true })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => stop('disconnected', '远程终端连接超时，请重试'), 15_000)
      let settled = false
      const finish = (reason?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.cancelConnection = undefined
        if (reason) reject(new Error(reason)); else resolve()
      }
      failConnection = reason => finish(reason)
      session.cancelConnection = () => finish('终端已关闭，连接已取消')
      // The engine may accept the upgrade and immediately reject a missing PTY.
      // A native pong follows those frames and requires no application protocol change.
      const probe = randomUUID()
      socket.once('open', () => {
        if (!active() || !this.current(target)) { stop('disconnected', '引擎连接已变化，终端连接已取消'); return }
        socket.ping(probe)
      })
      socket.on('pong', data => {
        if (data.toString() !== probe || !active() || settled) return
        if (!this.current(target)) { stop('disconnected', '引擎连接已变化，终端连接已取消'); return }
        session.status = 'connected'
        finish()
      })
      if (target.signal.aborted) session.abort()
    })
  }

  private end(session: Session, status: 'disconnected' | 'exited', exitCode: number, reason?: string): void {
    if (session.disposed || session.status === 'exited' || session.status === status) return
    session.status = status
    session.target.signal.removeEventListener('abort', session.abort)
    const socket = session.socket
    session.socket = null
    socket?.terminate()
    // The server keeps the PTY when its socket drops. Only explicit disposal may
    // delete it, otherwise a brief network interruption would destroy user work.
    session.onExit({ id: session.id, exitCode, status, ...(reason ? { reason } : {}) })
  }
  private send(id: string, message: Record<string, unknown>): void {
    const session = this.sessions.get(id)
    if (!session || session.status !== 'connected' || session.disposed) return
    if (!this.current(session.target) || session.socket?.readyState !== WebSocket.OPEN) { this.end(session, 'disconnected', 1, '远程终端连接已断开，可尝试恢复连接'); return }
    session.socket.send(JSON.stringify(message))
  }
  write(id: string, data: string): void { this.send(id, { type: 'input', data }) }
  resize(id: string, cols: number, rows: number): void { if (cols > 0 && rows > 0) this.send(id, { type: 'resize', cols, rows }) }
  dispose(id: string): Promise<void> {
    const session = this.sessions.get(id); if (!session) return Promise.resolve()
    if (session.disposePromise) return session.disposePromise
    session.disposed = true
    const closing = Promise.resolve().then(async () => {
      session.target.signal.removeEventListener('abort', session.abort)
      session.cancelConnection?.()
      session.socket?.close()
      // Keep the local ownership record until the authenticated DELETE has
      // completed. A failed cleanup must remain retryable and observable.
      await this.removeRemote(session.target, session.remoteId)
      session.disposed = true
      this.sessions.delete(id)
      session.socket?.terminate()
    }).finally(() => { if (session.disposePromise === closing) session.disposePromise = undefined })
    session.disposePromise = closing
    return closing
  }
  async disposeAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map(id => this.dispose(id))) }
  async disposeForIdentityChange(): Promise<string[]> {
    const failures: string[] = []
    await Promise.all([...this.sessions.keys()].map(async id => {
      const session = this.sessions.get(id)
      try { await this.dispose(id) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        // Keep the old endpoint/credential for a retry; never delete an old
        // tenant's PTY using credentials from the newly selected account.
        session?.onExit({ id, exitCode: 1, status: 'disconnected', reason: '远程终端清理未完成：' + message,
          cleanupError: { code: 'PTY_CLEANUP_FAILED', message, errors: [{ phase: 'remote-delete', code: 'REMOTE_CLEANUP_FAILED', name: 'Error', message }] } })
      }
    }))
    return failures
  }
  private async removeRemote(target: Target, remoteId: string): Promise<void> {
    const response = await fetch(`${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/${encodeURIComponent(remoteId)}`, { method: 'DELETE', headers: target.headers, signal: AbortSignal.timeout(15_000), redirect: 'error' })
    const envelope = await response.json().catch(() => ({})) as { code?: number; message?: string; data?: { success?: boolean } }
    if (!response.ok || (envelope.code !== 200 && envelope.code !== 0) || envelope.data?.success !== true) {
      throw new Error(envelope.message || `远程终端清理失败（HTTP ${response.status}）`)
    }
  }
}

export const remoteTerminalService = new RemoteTerminalService(() => ({ snapshot: engineHostSnapshot(), headers: engineHostHeaders(), signal: engineHostSignal() }))

// Narrow indirection avoids exposing the mutable EngineHost object to tests and
// keeps this transport's dependency surface to the three authenticated accessors.
function engineHostSnapshot(): EngineSnapshot { return engineHost.getSnapshot() }
function engineHostHeaders(): Record<string, string> { return engineHost.requestHeaders() }
function engineHostSignal(): AbortSignal { return engineHost.requestSignal }
