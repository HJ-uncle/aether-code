import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserContext, BrowserExecutionIdentity, BrowserToolRequest, BrowserToolResult } from '../../shared/browser'

export interface NativeBrowserHostTransport {
  /** Includes the actual engine instance and account; contains no credential. */
  engineId: string
  baseUrl: string
  authorityKind: 'account' | 'instance'
  signal: AbortSignal
  headers(): Promise<Record<string, string>>
}
export interface NativeBrowserHostExecutor {
  getSettings(): { aiEnabled: boolean }
  execute(request: BrowserToolRequest, context: BrowserContext, signal?: AbortSignal,
    owner?: { execution: Readonly<BrowserExecutionIdentity>; requestId: string }): Promise<BrowserToolResult>
  whenInputIdle?(): Promise<void>
}
interface HostRegistration { hostId: string; hostToken: string; protocolVersion: 1; authority: { kind: string }; capabilities: { nativeHostDemand: number }; leaseMs: number }
interface ClientRegistration {
  clientId: string; clientToken: string; sessionId: string; protocolVersion: 2
  capabilities: { requestWatch: boolean; executionIdentity: number; resultMetadata: number }
}
interface Demand { demandId: string; demandToken: string; execution: BrowserExecutionIdentity; expiresAt: number }
interface Command {
  requestId: string; sessionId: string; action: BrowserToolRequest['action']; args: Omit<BrowserToolRequest, 'action'>
  execution: BrowserExecutionIdentity; expiresAt: number | null
}
interface RootConnection { key: string; registration: ClientRegistration; execution: Readonly<BrowserExecutionIdentity>; controller: AbortController; joined: Promise<void> }
interface HostConnection {
  key: string; transport: NativeBrowserHostTransport; controller: AbortController
  registration?: HostRegistration; roots: Map<string, RootConnection>; joined: Promise<void>
  cleanupHeaders?: Record<string, string>
}
export class NativeBrowserHostError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
const identityKeys = ['rootSessionId', 'rootRunId', 'ownerRunId'] as const
const terminalRootStatuses = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
export function validBrowserExecution(value: unknown): value is BrowserExecutionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 3 && identityKeys.every(key => typeof record[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record[key] as string))
}
function exactExecution(left: BrowserExecutionIdentity, right: BrowserExecutionIdentity): boolean {
  return identityKeys.every(key => left[key] === right[key])
}
function rootKey(execution: BrowserExecutionIdentity): string { return JSON.stringify([execution.rootSessionId, execution.rootRunId]) }
const pathId = (id: string) => encodeURIComponent(id)

/** One native window serves bounded root-run clients; selection changes do not stop background work. */
export class NativeBrowserHostManager {
  private readonly hosts = new Map<string, HostConnection>()
  private readonly tasks = new Set<Promise<void>>()
  private disposed = false
  private refreshVersion = 0
  private cleanupFailure: string | null = null

  constructor(private readonly executor: NativeBrowserHostExecutor,
    private readonly transports: () => Promise<NativeBrowserHostTransport[]>, private readonly http: typeof fetch = fetch) {}

  getSnapshot(): { hosts: number; roots: number; cleanupFailure: string | null } {
    return { hosts: this.hosts.size, roots: [...this.hosts.values()].reduce((sum, host) => sum + host.roots.size, 0), cleanupFailure: this.cleanupFailure }
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion
    const candidates = this.disposed || !this.executor.getSettings().aiEnabled ? [] : await this.transports()
    if (version !== this.refreshVersion) return
    const expected = new Map(candidates.map(transport => [JSON.stringify([transport.engineId, transport.authorityKind]), transport]))
    for (const [key, host] of this.hosts) {
      const candidate = expected.get(key)
      if (!candidate || candidate.signal !== host.transport.signal || candidate.signal.aborted) this.stopHost(host)
      else expected.delete(key)
    }
    for (const [key, transport] of expected) {
      if (transport.signal.aborted) continue
      const host: HostConnection = { key, transport, controller: new AbortController(), roots: new Map(), joined: Promise.resolve() }
      this.hosts.set(key, host)
      host.joined = this.track(this.runHost(host))
    }
  }

  async disconnectAndWait(): Promise<string | null> {
    ++this.refreshVersion
    for (const host of [...this.hosts.values()]) this.stopHost(host)
    // Includes callbacks that have already left the map but still need to join.
    await Promise.all([...this.tasks])
    await this.executor.whenInputIdle?.()
    return this.cleanupFailure
  }
  dispose(): void { this.disposed = true; void this.disconnectAndWait() }
  private track(task: Promise<void>): Promise<void> {
    const joined = task.catch(() => undefined)
    this.tasks.add(joined)
    void joined.then(() => this.tasks.delete(joined))
    return joined
  }
  private signal(host: HostConnection, extra?: AbortSignal): AbortSignal {
    return AbortSignal.any([host.controller.signal, host.transport.signal, ...(extra ? [extra] : [])])
  }
  private live(host: HostConnection): boolean {
    return !this.disposed && this.hosts.get(host.key) === host && !this.signal(host).aborted && this.executor.getSettings().aiEnabled
  }
  private stopHost(host: HostConnection): void {
    if (this.hosts.get(host.key) === host) this.hosts.delete(host.key)
    host.controller.abort()
    for (const root of host.roots.values()) root.controller.abort()
  }
  private async request<T>(host: HostConnection, method: string, route: string, body?: unknown,
    options: { signal?: AbortSignal; client?: ClientRegistration; demandToken?: string; cleanup?: boolean } = {}): Promise<T> {
    const sourceHeaders = options.cleanup && host.cleanupHeaders ? host.cleanupHeaders : await host.transport.headers()
    if (!options.cleanup) host.cleanupHeaders = { ...sourceHeaders }
    // Cleanup uses this connection's last original credentials; an account
    // change must never lend the replacement account to an old DELETE.
    const headers = new Headers(sourceHeaders)
    const registration = host.registration
    if (!options.cleanup && !this.live(host)) throw new Error('浏览器宿主连接已变化')
    headers.set('Accept', 'application/json')
    if (registration) headers.set('X-Aether-Browser-Host-Token', registration.hostToken)
    if (options.client) headers.set('X-Aether-Browser-Token', options.client.clientToken)
    if (options.demandToken) headers.set('X-Aether-Browser-Demand-Token', options.demandToken)
    if (body === undefined) headers.delete('Content-Type')
    else headers.set('Content-Type', 'application/json')
    const response = await this.http(`${host.transport.baseUrl.replace(/\/+$/, '')}/api/v1${route}`, {
      method, redirect: 'error', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.cleanup ? AbortSignal.timeout(3000) : AbortSignal.any([this.signal(host, options.signal), AbortSignal.timeout(25_000)])
    })
    const result = await response.json() as { code: number; message?: string; data: T }
    if (!response.ok || result.code !== 200 && result.code !== 0) throw new NativeBrowserHostError(result.message || `HTTP ${response.status}`, response.status)
    return result.data
  }

  private async runHost(host: HostConnection): Promise<void> {
    try {
      while (this.live(host)) {
        try {
          if (!host.registration) {
            const registration = await this.request<HostRegistration>(host, 'POST', '/browser/hosts', { protocolVersion: 1, authorityKind: host.transport.authorityKind })
            if (!registration || registration.protocolVersion !== 1 || registration.authority?.kind !== host.transport.authorityKind ||
              registration.capabilities?.nativeHostDemand !== 1 || typeof registration.hostId !== 'string' || typeof registration.hostToken !== 'string') {
              throw new NativeBrowserHostError('引擎尚未提供可信浏览器宿主协议', 400)
            }
            host.registration = registration
          }
          const pending = await this.request<{ demands: Demand[] }>(host, 'GET', `/browser/hosts/${pathId(host.registration.hostId)}/demands`)
          if (!Array.isArray(pending?.demands) || pending.demands.length > 32) throw new NativeBrowserHostError('浏览器宿主需求列表无效', 400)
          for (const demand of pending.demands) {
            if (!this.live(host)) return
            try { await this.acceptDemand(host, demand) }
            catch (error) {
              if (error instanceof NativeBrowserHostError && [400, 401, 403].includes(error.status)) throw error
              // A vanished demand or lost first-use ACK belongs to one exact root.
              // Only a 404 from the host poll establishes that the host expired.
              // Releasing it cannot evict other roots or replay page operations.
              if (validBrowserExecution(demand?.execution) && host.registration) {
                try { await this.request(host, 'DELETE', `/browser/hosts/${pathId(host.registration.hostId)}/roots/${pathId(demand.execution.rootSessionId)}/runs/${pathId(demand.execution.rootRunId)}`) }
                catch (cleanupError) {
                  if (!(cleanupError instanceof NativeBrowserHostError && cleanupError.status === 404))
                    this.cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }
              }
            }
          }
        } catch (error) {
          if (!this.live(host)) return
          // A lost poll response retains the same host and clients. A server-side
          // expired host is the only evidence allowing a fresh registration.
          if (error instanceof NativeBrowserHostError && error.status === 404) {
            for (const root of host.roots.values()) root.controller.abort()
            await Promise.all([...host.roots.values()].map(root => root.joined))
            host.registration = undefined
          } else if (error instanceof NativeBrowserHostError && [400, 401, 403, 409].includes(error.status)) return
          try { await delay(1000, undefined, { signal: this.signal(host) }) } catch { return }
        }
      }
    } finally {
      this.stopHost(host)
      await Promise.all([...host.roots.values()].map(root => root.joined))
      if (host.registration) {
        try { await this.request(host, 'DELETE', `/browser/hosts/${pathId(host.registration.hostId)}`, undefined, { cleanup: true }) }
        catch (error) {
          if (!(error instanceof NativeBrowserHostError && error.status === 404)) this.cleanupFailure = error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
  private async acceptDemand(host: HostConnection, demand: Demand): Promise<void> {
    if (!validBrowserExecution(demand?.execution) || typeof demand.demandId !== 'string' || typeof demand.demandToken !== 'string' ||
      !Number.isFinite(demand.expiresAt) || demand.expiresAt <= Date.now()) throw new NativeBrowserHostError('浏览器需求身份无效', 400)
    const execution = Object.freeze({ ...demand.execution }), key = rootKey(execution)
    if (host.roots.has(key)) return
    const path = `/browser/hosts/${pathId(host.registration!.hostId)}/demands/${pathId(demand.demandId)}`
    if (host.roots.size >= 32) {
      await this.request(host, 'POST', path + '/reject', { execution, demandToken: demand.demandToken, code: 'BROWSER_HOST_SLOT_CAPACITY' })
      return
    }
    // Demand state and ready are exact-triple checks; no command can execute
    // until the server atomically registers this root's negotiated v2 client.
    const query = new URLSearchParams({ ...execution, wait: 'false' })
    const state = await this.request<{ active: boolean; execution: BrowserExecutionIdentity }>(host, 'GET', path + '/state?' + query,
      undefined, { demandToken: demand.demandToken })
    if (state?.active !== true || !validBrowserExecution(state.execution) || !exactExecution(state.execution, execution)) return
    const registration = await this.request<ClientRegistration>(host, 'POST', path + '/client', { execution, demandToken: demand.demandToken })
    if (registration?.sessionId !== execution.rootSessionId || registration.protocolVersion !== 2 || registration.capabilities?.requestWatch !== true ||
      registration.capabilities?.executionIdentity !== 1 || registration.capabilities?.resultMetadata !== 1) throw new NativeBrowserHostError('引擎未返回可信浏览器客户端', 400)
    const root: RootConnection = { key, execution, registration, controller: new AbortController(), joined: Promise.resolve() }
    host.roots.set(key, root)
    root.joined = this.track(this.runRoot(host, root))
  }
  private async runRoot(host: HostConnection, root: RootConnection): Promise<void> {
    const monitor = new AbortController()
    const signal = this.signal(host, root.controller.signal)
    const watch = this.monitorRoot(host, root, AbortSignal.any([signal, monitor.signal]))
    try {
      while (this.live(host) && !signal.aborted) {
        try {
          const pending = await this.request<{ commands: Command[] }>(host, 'GET', `/browser/clients/${pathId(root.registration.clientId)}/commands`, undefined,
            { client: root.registration, signal })
          if (!Array.isArray(pending?.commands) || pending.commands.length > 32) throw new NativeBrowserHostError('浏览器命令列表无效', 400)
          for (const command of pending.commands) {
            if (signal.aborted || !this.live(host)) return
            if (!validBrowserExecution(command.execution) || command.execution.rootSessionId !== root.execution.rootSessionId ||
              command.execution.rootRunId !== root.execution.rootRunId || command.sessionId !== root.execution.rootSessionId || typeof command.requestId !== 'string') {
              throw new NativeBrowserHostError('浏览器命令不属于此任务', 400)
            }
            if (command.expiresAt !== null && (!Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now())) {
              throw new NativeBrowserHostError('浏览器命令已过期，尚未派发', 400)
            }
            const execution = Object.freeze({ ...command.execution })
            const result = await this.executeCommand(host, root, { ...command, execution }, signal)
            if (signal.aborted || !this.live(host)) return
            try {
              await this.request(host, 'POST', `/browser/clients/${pathId(root.registration.clientId)}/results`, {
                requestId: command.requestId, execution, success: result.success,
                output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null), error: result.error,
                metadata: result.metadata ?? { code: 'BROWSER_OPERATION_UNCONFIRMED', operationPerformed: 'unknown' }
              }, { client: root.registration, signal })
            } catch {
              // We cannot tell whether this result reached the server. Closing
              // only this client settles its delivered request as unknown and
              // prevents perpetual renewal of an unacknowledged command.
              return
            }
          }
        } catch (error) {
          if (signal.aborted || !this.live(host)) return
          if (error instanceof NativeBrowserHostError && [400, 401, 403, 404].includes(error.status)) return
          // Results are not replayed. A network failure can only resume polling;
          // the engine retains its pending result/unknown cancellation evidence.
          try { await delay(1000, undefined, { signal }) } catch { return }
        }
      }
    } finally {
      root.controller.abort(); monitor.abort(); await watch
      if (host.roots.get(root.key) === root) host.roots.delete(root.key)
      if (host.registration) {
        try { await this.request(host, 'DELETE', `/browser/hosts/${pathId(host.registration.hostId)}/roots/${pathId(root.execution.rootSessionId)}/runs/${pathId(root.execution.rootRunId)}`, undefined, { cleanup: true }) }
        catch (error) { if (!(error instanceof NativeBrowserHostError && error.status === 404)) this.cleanupFailure = error instanceof Error ? error.message : String(error) }
      }
    }
  }
  private async monitorRoot(host: HostConnection, root: RootConnection, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const status = await this.request<{ running: boolean; finished: boolean; run?: { runId: string; status: string } }>(host, 'GET',
          '/chat/status?sessionId=' + pathId(root.execution.rootSessionId), undefined, { signal })
        // Stream publication can finish after an oversized frame while the
        // durable producer keeps running. Only its persisted terminal status
        // may release the browser client; the stream flags are not ownership.
        if (!status?.run || status.run.runId !== root.execution.rootRunId || terminalRootStatuses.has(status.run.status)) {
          root.controller.abort(); return
        }
        await delay(2000, undefined, { signal })
      }
    } catch { if (!signal.aborted) root.controller.abort() }
  }
  private async executeCommand(host: HostConnection, root: RootConnection, command: Command, signal: AbortSignal): Promise<BrowserToolResult> {
    const deadline = typeof command.expiresAt === 'number' ? Math.max(1, command.expiresAt - Date.now()) : undefined
    const operation = new AbortController(), monitoring = new AbortController()
    const lifetime = AbortSignal.any([signal, operation.signal, ...(deadline === undefined ? [] : [AbortSignal.timeout(deadline)])])
    const watchSignal = AbortSignal.any([signal, monitoring.signal])
    const path = `/browser/clients/${pathId(root.registration.clientId)}/requests/${pathId(command.requestId)}/state`
    const state = async (wait: boolean, stateSignal: AbortSignal) => {
      const query = new URLSearchParams({ ...command.execution, wait: String(wait) })
      const current = await this.request<{ active: boolean; execution?: BrowserExecutionIdentity }>(host, 'GET', path + '?' + query,
        undefined, { client: root.registration, signal: stateSignal })
      if (current?.active === false) return false
      if (!validBrowserExecution(current?.execution) || !exactExecution(current.execution, command.execution)) throw new NativeBrowserHostError('浏览器取消监控身份不匹配', 400)
      return current.active === true
    }
    try {
      if (!await state(false, lifetime)) return { success: false, error: '浏览器操作已取消，尚未派发', metadata: { code: 'BROWSER_REQUEST_CANCELLED', operationPerformed: false } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), metadata: { code: 'BROWSER_MONITOR_UNAVAILABLE', operationPerformed: false } }
    }
    const watch = (async () => {
      try { while (!watchSignal.aborted) { if (!await state(true, watchSignal)) { operation.abort(); return } } }
      catch { if (!watchSignal.aborted) operation.abort() }
    })()
    try {
      const result = await this.executor.execute({ ...command.args, action: command.action },
        { sessionId: command.execution.rootSessionId, engineId: host.transport.engineId }, lifetime,
        { execution: command.execution, requestId: command.requestId })
      return lifetime.aborted ? { success: false, error: '浏览器操作监控已中断，请重新读取页面状态',
        metadata: { code: 'BROWSER_MONITOR_INTERRUPTED', operationPerformed: result.metadata?.operationPerformed === false ? false : 'unknown' } } : result
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), metadata: { code: 'BROWSER_OPERATION_UNCONFIRMED', operationPerformed: 'unknown' } }
    } finally { monitoring.abort(); await watch }
  }
}
