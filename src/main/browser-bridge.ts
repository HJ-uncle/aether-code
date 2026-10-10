import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserConnectInput, BrowserConnectionState } from '../shared/browser-api'
import type { BrowserContext, BrowserToolRequest, BrowserToolResult } from '../shared/browser'
import type { EngineSnapshot } from '../shared/ipc'
import { engineHost } from './engine/host'
import { engineTargetError } from './engine/protocol'

interface BrowserExecutor {
  getSettings(): { aiEnabled: boolean }
  execute(request: BrowserToolRequest, context: BrowserContext, signal?: AbortSignal): Promise<BrowserToolResult>
}

interface Registration {
  clientId: string
  clientToken: string
  sessionId: string
  capabilities?: { requestWatch?: boolean }
}
interface Connection {
  input: BrowserConnectInput
  context: BrowserContext
  baseUrl: string
  headers: Record<string, string>
  controller: AbortController
  generation: number
  registration: Registration
}
interface Command {
  requestId: string
  sessionId: string
  action: BrowserToolRequest['action']
  args: Omit<BrowserToolRequest, 'action'>
  expiresAt: number
}

export function browserEngineId(snapshot: BrowserConnectInput['expectedEngine']): string {
  return JSON.stringify([snapshot.mode, snapshot.baseUrl.replace(/\/+$/, ''), snapshot.instanceId ?? null, snapshot.accountId ?? null])
}

class BridgeError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** The engine queues actions; only this authenticated client can reach its visible browser. */
export class BrowserEngineBridge {
  private state: BrowserConnectionState = { status: 'disconnected', message: '等待引擎和会话就绪' }
  private desired: BrowserConnectInput | null = null
  private active: Connection | null = null
  private connecting: AbortController | null = null
  private generation = 0
  private releasing: Promise<void> = Promise.resolve()
  private releaseFailure: string | null = null
  private pendingRelease: Connection | null = null
  private retry: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly onSnapshot = (snapshot: EngineSnapshot): void => {
    if (!this.desired) return
    if (snapshot.phase !== 'ready' || engineTargetError(snapshot, this.desired.expectedEngine)) {
      this.stop()
      this.publish({ status: 'disconnected', message: '引擎连接已变化，等待重新绑定' })
    }
  }

  constructor(private readonly service: BrowserExecutor, private readonly changed: (state: BrowserConnectionState) => void) {
    engineHost.on('snapshot', this.onSnapshot)
  }

  getState(): BrowserConnectionState { return this.state }
  getContext(): BrowserContext | undefined {
    const input = this.desired
    const current = engineHost.getSnapshot()
    if (!input || current.phase !== 'ready' || engineTargetError(current, input.expectedEngine)) return undefined
    return { sessionId: input.sessionId, engineId: browserEngineId(input.expectedEngine) }
  }

  private publish(state: BrowserConnectionState): void {
    if (state.sessionId && this.desired) state = { ...state, engineId: browserEngineId(this.desired.expectedEngine) }
    if (JSON.stringify(state) === JSON.stringify(this.state)) return
    this.state = state
    this.changed(state)
  }

  async connect(input: BrowserConnectInput): Promise<BrowserConnectionState> {
    if (this.disposed) return this.state
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.sessionId.length > 256 || !input.expectedEngine) {
      throw new Error('浏览器连接缺少有效会话')
    }
    const current = engineHost.getSnapshot()
    if (current.phase !== 'ready' || engineTargetError(current, input.expectedEngine)) throw new Error('引擎或会话已变化，请重试')
    const same = this.desired?.sessionId === input.sessionId && this.desired && browserEngineId(this.desired.expectedEngine) === browserEngineId(input.expectedEngine)
    if (same && (this.active || this.connecting)) return this.state
    this.stop()
    this.desired = input
    if (!this.service.getSettings().aiEnabled) {
      this.publish({ status: 'disconnected', sessionId: input.sessionId, message: '已在浏览器设置中关闭 AI 操作' })
      return this.state
    }
    const generation = this.generation
    const controller = new AbortController()
    this.connecting = controller
    this.publish({ status: 'connecting', sessionId: input.sessionId, message: '正在连接 AI 浏览器工具' })
    try {
      await this.releasing
      if (generation !== this.generation) return this.state
      const headers = await engineHost.prepareRequestHeaders(current.baseUrl)
      if (generation !== this.generation) return this.state
      if (engineHost.getSnapshot().phase !== 'ready' || engineTargetError(engineHost.getSnapshot(), input.expectedEngine)) throw new Error('引擎身份已变化，请重试')
      const baseUrl = current.baseUrl.replace(/\/+$/, '')
      const registration = await this.request<Registration>(baseUrl, headers, controller.signal, 'POST', '/browser/clients', {
        sessionId: input.sessionId
      })
      if (!registration || typeof registration.clientId !== 'string' || typeof registration.clientToken !== 'string' || registration.sessionId !== input.sessionId) {
        throw new Error('引擎未返回有效浏览器连接，请更新配套引擎')
      }
      const connection: Connection = { input, baseUrl, headers, controller, generation, registration,
        context: { sessionId: input.sessionId, engineId: browserEngineId(input.expectedEngine) } }
      if (generation !== this.generation) { void this.unregister(connection); return this.state }
      this.connecting = null
      this.active = connection
      this.publish({ status: 'connected', sessionId: input.sessionId, message: this.connectedMessage(connection) })
      void this.poll(connection)
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) {
        this.connecting = null
        this.publish({ status: 'error', sessionId: input.sessionId, message: error instanceof BridgeError && error.status === 404
          ? '当前引擎尚未支持浏览器工具，请使用配套的新引擎' : error instanceof Error ? error.message : String(error) })
        // A connection interruption (including an abandoned lease) should recover
        // without requiring the user to toggle settings or change conversations.
        if (!(error instanceof BridgeError) || error.status === 401 || error.status === 409 || error.status >= 500) {
          this.retry = setTimeout(() => {
            this.retry = undefined
            if (!this.disposed && generation === this.generation) void this.connect(input).catch(() => {})
          }, 2000)
        }
      }
    }
    return this.state
  }

  async refresh(): Promise<void> {
    const input = this.desired
    if (!input) return
    this.stop()
    await this.connect(input)
  }

  disconnect(): void {
    this.stop()
    this.desired = null
    this.publish({ status: 'disconnected', message: 'AI 浏览器连接已断开' })
  }

  async disconnectAndWait(): Promise<string | null> {
    this.disconnect()
    await this.releasing
    if (this.pendingRelease) await this.unregister(this.pendingRelease)
    return this.releaseFailure
  }

  private stop(): void {
    this.generation++
    clearTimeout(this.retry)
    this.retry = undefined
    this.connecting?.abort()
    this.connecting = null
    const old = this.active
    this.active = null
    if (old) { old.controller.abort(); this.pendingRelease = old; this.releasing = this.unregister(old) }
  }

  private async unregister(connection: Connection): Promise<void> {
    try {
      await this.request(connection.baseUrl, this.clientHeaders(connection), AbortSignal.timeout(3000), 'DELETE',
        `/browser/clients/${encodeURIComponent(connection.registration.clientId)}`)
      if (this.pendingRelease === connection) this.pendingRelease = null
      this.releaseFailure = null
    } catch (error) {
      // Retain this registration's original headers for a best-effort retry.
      // Its server lease still expires if the account has already been revoked.
      this.releaseFailure = error instanceof Error ? error.message : String(error)
    }
  }

  private clientHeaders(connection: Connection): Record<string, string> {
    return { ...connection.headers, 'X-Aether-Browser-Token': connection.registration.clientToken }
  }

  private async authorizedHeaders(connection: Connection): Promise<Record<string, string>> {
    if (!this.owns(connection)) throw new Error('浏览器连接已变化')
    // Remote access tokens can rotate while a browser stays open for hours.
    const headers = await engineHost.prepareRequestHeaders(connection.baseUrl)
    if (!this.owns(connection)) throw new Error('浏览器连接已变化')
    connection.headers = headers
    return this.clientHeaders(connection)
  }

  private owns(connection: Connection): boolean {
    return this.active === connection && connection.generation === this.generation && !connection.controller.signal.aborted &&
      this.service.getSettings().aiEnabled && engineHost.getSnapshot().phase === 'ready' &&
      !engineTargetError(engineHost.getSnapshot(), connection.input.expectedEngine)
  }

  private connectedMessage(connection: Connection): string {
    return connection.registration.capabilities?.requestWatch === true ? 'AI 可使用当前会话的浏览器页面'
      : 'AI 浏览器已连接；此引擎不支持同步取消，请升级配套引擎'
  }

  private async requestState(connection: Connection, command: Command, wait: boolean, signal: AbortSignal): Promise<boolean> {
    const state = await this.request<{ active: boolean }>(connection.baseUrl, await this.authorizedHeaders(connection), signal, 'GET',
      `/browser/clients/${encodeURIComponent(connection.registration.clientId)}/requests/${encodeURIComponent(command.requestId)}/state?wait=${wait}`)
    if (!state || typeof state.active !== 'boolean') throw new Error('浏览器取消监控返回无效状态')
    return state.active
  }

  private async executeCommand(connection: Connection, command: Command): Promise<BrowserToolResult> {
    const remaining = Math.max(1, Math.min(60000, command.expiresAt - Date.now()))
    const lifetime = AbortSignal.any([connection.controller.signal, AbortSignal.timeout(remaining)])
    if (connection.registration.capabilities?.requestWatch !== true) {
      // Old engines retain their existing operations; the connection message
      // makes their weaker stop behavior explicit until the engine is upgraded.
      return this.service.execute({ ...command.args, action: command.action }, connection.context, lifetime)
    }
    if (!await this.requestState(connection, command, false, lifetime)) {
      return { success: false, error: '浏览器操作已取消或结束，尚未执行页面操作' }
    }
    const operation = new AbortController()
    const monitoring = new AbortController()
    const signal = AbortSignal.any([lifetime, operation.signal])
    const watchSignal = AbortSignal.any([lifetime, monitoring.signal])
    let watchFailure: string | undefined
    // Commands remain serial. Only the cancellation watch runs concurrently;
    // otherwise a page waiting for visibility cannot receive the stop signal.
    const watch = (async (): Promise<void> => {
      try {
        while (!watchSignal.aborted) {
          if (!await this.requestState(connection, command, true, watchSignal)) {
            watchFailure = '引擎已取消或结束本次浏览器操作；若输入可能已派发，请重新读取页面状态，勿重复提交'
            operation.abort(new Error(watchFailure))
            return
          }
        }
      } catch (error) {
        if (watchSignal.aborted) return
        watchFailure = `浏览器取消监控中断，已中止本次操作：${error instanceof Error ? error.message : String(error)}`
        operation.abort(new Error(watchFailure))
      }
    })()
    try {
      const result = await this.service.execute({ ...command.args, action: command.action }, connection.context, signal)
      return watchFailure ? { success: false, error: watchFailure } : result
    } finally {
      monitoring.abort()
      await watch
    }
  }

  private async poll(connection: Connection): Promise<void> {
    while (this.owns(connection)) {
      try {
        const data = await this.request<{ commands: Command[] }>(connection.baseUrl, await this.authorizedHeaders(connection),
          connection.controller.signal, 'GET', `/browser/clients/${encodeURIComponent(connection.registration.clientId)}/commands`)
        if (!this.owns(connection)) return
        if (!data || !Array.isArray(data.commands)) throw new Error('浏览器工具通道返回无效数据')
        this.publish({ status: 'connected', sessionId: connection.input.sessionId, message: this.connectedMessage(connection) })
        for (const command of data.commands) {
          if (!this.owns(connection)) return
          let result: BrowserToolResult
          if (command.sessionId !== connection.context.sessionId || !Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now()) {
            result = { success: false, error: '浏览器操作已过期或会话不匹配，未执行' }
          } else {
            try {
              result = await this.executeCommand(connection, command)
            }
            catch (error) { result = { success: false, error: error instanceof Error ? error.message : String(error) } }
          }
          if (!this.owns(connection)) return
          await this.request(connection.baseUrl, await this.authorizedHeaders(connection), connection.controller.signal, 'POST',
            `/browser/clients/${encodeURIComponent(connection.registration.clientId)}/results`, {
              requestId: command.requestId, success: result.success,
              output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null), error: result.error
            })
        }
      } catch (error) {
        if (!this.owns(connection)) return
        this.publish({ status: 'error', sessionId: connection.input.sessionId, message: `浏览器工具连接中断：${error instanceof Error ? error.message : String(error)}` })
        try { await delay(2000, undefined, { signal: connection.controller.signal }) } catch { return }
        if (!this.owns(connection)) return
        // A lost HTTP response must not create a second client competing for the same session.
        try {
          const renewed = await this.request<Registration>(connection.baseUrl, await this.authorizedHeaders(connection), connection.controller.signal, 'POST', '/browser/clients', {
            sessionId: connection.registration.sessionId,
            clientId: connection.registration.clientId,
            clientToken: connection.registration.clientToken
          })
          if (this.owns(connection)) connection.registration = renewed
        } catch (renewError) {
          if (renewError instanceof BridgeError && renewError.status === 404 && this.owns(connection)) {
            const input = connection.input
            this.stop()
            await this.connect(input)
            return
          }
        }
      }
    }
  }

  private async request<T>(baseUrl: string, headers: Record<string, string>, signal: AbortSignal, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method, headers: { ...headers, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)])
    })
    const result = await response.json() as { code?: number; message?: string; data?: T }
    if (!response.ok || (result.code !== 200 && result.code !== 0)) {
      throw new BridgeError(result.message || `HTTP ${response.status}`, response.status)
    }
    return result.data as T
  }

  dispose(): void { this.disposed = true; this.disconnect(); engineHost.off('snapshot', this.onSnapshot) }
}
