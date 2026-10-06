/** Main-process owner of one engine instance and its authenticated transport. */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { parseSseBlock } from './sse'
import type { EngineSnapshot, StreamEvent } from '../../shared/ipc'
import { getSettings } from '../settings-store'
import { logger } from './logger'
import { ensureEncryptionKey } from './secrets'
import { getRemoteInstanceToken } from './remote-token'
import { prepareRemoteChatBody, validateRemoteWorkspaceRoot } from './remote-workspace'
import { clearRemoteAttachments } from './remote-attachments'
import { findAvailablePort } from './sdk/port-finder'
import { startProcess, type ProcessHandle } from './sdk/process-manager'
import { waitUntilReady } from './sdk/readiness-probe'
import { engineDataFile, migrateLegacyModels, resolveRuntime, runtimeEnvironment } from './runtime'
import {
  assertEngineHealth,
  engineHeaders,
  engineTargetError,
  normalizeEnginePath,
  parseEngineMeta,
  remoteRequestError,
  remoteInstanceToken,
  type EngineMeta
} from './protocol'

const PREFERRED_PORT = 12323
const STARTUP_TIMEOUT_MS = 60_000
const HEALTH_INTERVAL_MS = 5_000
const HEALTH_FAILURE_THRESHOLD = 3
/** Remote links should survive short network flaps and service restarts. */
const REMOTE_RECONNECT_INITIAL_MS = 1_000
const REMOTE_RECONNECT_MAX_MS = 30_000

export interface EngineHostEvents {
  snapshot: (snapshot: EngineSnapshot) => void
  stream: (event: StreamEvent) => void
}

export class EngineHost extends EventEmitter {
  private handle: ProcessHandle | null = null
  private snapshot: EngineSnapshot = {
    mode: 'embedded',
    phase: 'idle',
    baseUrl: '',
    port: null,
    pid: null,
    adopted: false,
    entryPath: null,
    runtimeSource: null,
    version: null,
    dataDir: null,
    error: null,
    updatedAt: Date.now()
  }
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private healthFailures = 0
  private remoteReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private remoteReconnectAttempt = 0
  /** Explicitly disabled by stop(); enabled while a remote target is selected. */
  private remoteReconnectEnabled = false
  private remoteTarget: { url: string; workspaceRoot: string } | null = null
  private starting: Promise<EngineSnapshot> | null = null
  private generation = 0
  private startupController: AbortController | null = null
  private transportController = new AbortController()
  private teardown: Promise<void> = Promise.resolve()
  // Credentials never enter snapshots, logs, or persisted settings. Token IPC is
  // handled only by dedicated main-process handlers and never returned to the renderer.
  private instanceToken = ''
  private activeRemoteWorkspaceRoot = ''

  getSnapshot(): EngineSnapshot {
    return this.snapshot
  }

  on<K extends keyof EngineHostEvents>(event: K, listener: EngineHostEvents[K]): this {
    return super.on(event, listener)
  }

  private patch(next: Partial<EngineSnapshot>): EngineSnapshot {
    this.snapshot = { ...this.snapshot, ...next, updatedAt: Date.now() }
    this.emit('snapshot', this.snapshot)
    return this.snapshot
  }

  get baseUrl(): string {
    return this.snapshot.phase === 'ready' ? this.snapshot.baseUrl : ''
  }
  /** Saved connection preferences apply only when a new connection is started. */
  get remoteWorkspaceRoot(): string {
    return this.snapshot.phase === 'ready' && this.snapshot.mode === 'remote' ? this.activeRemoteWorkspaceRoot : ''
  }
  get requestSignal(): AbortSignal {
    return this.transportController.signal
  }
  requestHeaders(): Record<string, string> {
    return engineHeaders(this.instanceToken)
  }

  async start(mode: 'embedded' | 'remote', remoteBaseUrl = '', remoteWorkspaceRoot = '', autoReconnect = false): Promise<EngineSnapshot> {
    if (this.starting) return this.starting
    const normalizedRemote = remoteBaseUrl.trim().replace(/\/+$/, '')
    const configuredRoot = mode === 'remote' ? validateRemoteWorkspaceRoot(remoteWorkspaceRoot) : ''
    // A direct start is an explicit user action. It supersedes a pending
    // reconnect attempt and starts the backoff from the beginning.
    if (!autoReconnect) this.cancelRemoteReconnect()
    this.remoteReconnectEnabled = mode === 'remote'
    this.remoteTarget = mode === 'remote'
      ? { url: normalizedRemote, workspaceRoot: configuredRoot }
      : null
    if (
      this.snapshot.phase === 'ready' &&
      this.snapshot.mode === mode &&
      (mode === 'embedded' || this.snapshot.baseUrl === normalizedRemote)
    )
      return this.snapshot

    const generation = ++this.generation
    this.startupController?.abort()
    const controller = new AbortController()
    this.startupController = controller
    const task = this.doStart(mode, normalizedRemote, configuredRoot, generation, controller.signal).finally(() => {
      if (this.starting === task) this.starting = null
      if (this.startupController === controller) this.startupController = null
    })
    this.starting = task
    return task
  }

  private current(generation: number, signal?: AbortSignal): boolean {
    return generation === this.generation && !signal?.aborted
  }

  private async doStart(
    mode: 'embedded' | 'remote',
    remoteBaseUrl: string,
    remoteWorkspaceRoot: string,
    generation: number,
    signal: AbortSignal
  ): Promise<EngineSnapshot> {
    this.patch({
      mode,
      phase: 'starting',
      baseUrl: '',
      port: null,
      pid: null,
      adopted: false,
      entryPath: null,
      runtimeSource: null,
      version: null,
      dataDir: null,
      error: null,
      buildId: undefined,
      protocolVersion: undefined,
      instanceId: undefined
    })
    await this.releaseResources()
    if (!this.current(generation, signal)) return this.snapshot
    this.transportController = new AbortController()
    this.activeRemoteWorkspaceRoot = remoteWorkspaceRoot
    try {
      if (mode === 'remote') await this.startRemote(remoteBaseUrl, generation, signal)
      else await this.startEmbedded(generation, signal)
    } catch (err) {
      if (!this.current(generation, signal)) return this.snapshot
      await this.releaseResources()
      if (this.current(generation, signal)) {
        this.patch({
          phase: 'error',
          baseUrl: '',
          port: null,
          pid: null,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return this.snapshot
  }

  private async startRemote(url: string, generation: number, signal: AbortSignal): Promise<void> {
    if (!url) throw new Error('未配置远端引擎地址')
    // Prefer the encrypted setting; keep the environment variable as a migration and
    // headless-launch fallback. Never return the secret through settings or snapshots.
    this.instanceToken = remoteInstanceToken(
      url,
      getRemoteInstanceToken() || process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN
    )
    const meta = await this.handshake(url, signal)
    if (!this.current(generation, signal)) return
    this.patch({
      phase: 'ready',
      baseUrl: url,
      port: portOf(url),
      pid: null,
      adopted: false,
      entryPath: null,
      runtimeSource: null,
      dataDir: null,
      error: null,
      version: meta.version,
      buildId: meta.buildId,
      protocolVersion: meta.protocolVersion,
      instanceId: meta.instanceId
    })
    // A successful handshake means the service is back. Do not carry an old
    // network flap's attempt count into the next outage.
    this.remoteReconnectAttempt = 0
    this.startHealthWatch()
  }

  private async startEmbedded(generation: number, signal: AbortSignal): Promise<void> {
    const runtime = resolveRuntime()
    if (!runtime)
      throw new Error(
        '未找到配套引擎运行时。开发时请构建同级引擎或设置 AETHER_IDE_ENGINE_ENTRY；安装包必须内置引擎。'
      )
    this.patch({
      entryPath: runtime.entryPath,
      runtimeSource: runtime.source,
      version: runtime.version,
      buildId: runtime.manifest.buildId
    })
    logger.info(`使用引擎运行时（来源：${runtime.source}）：${runtime.entryPath}`)
    const runtimeConfig = runtimeEnvironment(runtime)
    const secret = ensureEncryptionKey()
    if (!secret.encryptedAtRest) logger.warn('系统密钥存储不可用，引擎加密密钥以明文保存')
    await migrateLegacyModels(runtime, secret.key, signal)
    if (!this.current(generation, signal)) return
    const port = await findAvailablePort(getSettings().preferredPort || PREFERRED_PORT)
    if (!this.current(generation, signal)) return
    const dataDir = engineDataFile()
    this.instanceToken = randomBytes(32).toString('hex')
    this.handle = startProcess({
      binPath: runtime.entryPath,
      nodePath: runtime.nodePath,
      cwd: runtimeConfig.cwd,
      port,
      dataDir,
      env: {
        ...runtimeConfig.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOST: '127.0.0.1',
        // Embedded instances are owned by this desktop process and protected
        // by the random instance token. Preserve an explicit operator setting.
        AUTH_ENABLED: process.env.AUTH_ENABLED ?? 'false',
        ENCRYPTION_KEY: secret.key,
        AETHER_INSTANCE_TOKEN: this.instanceToken
      },
      onExit: (code, exitSignal) => this.onProcessExit(generation, code, exitSignal)
    })
    const baseUrl = `http://127.0.0.1:${port}`
    await waitUntilReady({ baseUrl, timeoutMs: STARTUP_TIMEOUT_MS, signal })
    if (!this.current(generation, signal)) return
    const meta = await this.handshake(baseUrl, signal, runtime.manifest.buildId)
    if (!this.current(generation, signal)) return
    this.patch({
      phase: 'ready',
      baseUrl,
      port,
      pid: this.handle?.pid ?? null,
      adopted: false,
      version: meta.version,
      buildId: meta.buildId,
      protocolVersion: meta.protocolVersion,
      instanceId: meta.instanceId,
      dataDir,
      error: null
    })
    logger.info(`引擎已就绪 ${baseUrl}（pid ${this.handle?.pid ?? '未知'}）`)
    this.startHealthWatch()
  }

  private async handshake(
    baseUrl: string,
    signal: AbortSignal,
    buildId?: string
  ): Promise<EngineMeta> {
    const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' as const }
    const health = await fetch(`${baseUrl}/health`, options)
    if (!health.ok) throw new Error(`/health 返回 HTTP ${health.status}`)
    assertEngineHealth(await health.json())
    const response = await fetch(`${baseUrl}/meta`, options)
    if (!response.ok) throw new Error(`/meta 返回 HTTP ${response.status}`)
    const meta = parseEngineMeta(await response.json(), buildId)
    // Public metadata is insufficient to establish that the authenticated transport works.
    const probe = await fetch(`${baseUrl}/api/v1/tools`, {
      ...options,
      headers: this.requestHeaders()
    })
    if (probe.status === 401 || probe.status === 403) {
      throw new Error('引擎拒绝连接凭据：请在设置→引擎→远端令牌中填写与目标引擎 AETHER_INSTANCE_TOKEN 一致的值，或在启动 Aether Code 的进程中设置 AETHER_IDE_REMOTE_INSTANCE_TOKEN；保存后重新连接。')
    }
    if (!probe.ok) throw new Error(`引擎实例认证失败（HTTP ${probe.status}）`)
    const body = (await probe.json()) as { code?: number }
    if (body?.code !== 200 && body?.code !== 0) throw new Error('引擎实例认证探针返回失败')
    return meta
  }

  private onProcessExit(generation: number, code: number | null, signal: string | null): void {
    if (!this.current(generation) || !this.handle) return
    ++this.generation
    this.startupController?.abort()
    this.starting = null
    this.handle = null
    this.stopHealthWatch()
    this.transportController.abort()
    this.instanceToken = ''
    clearRemoteAttachments()
    const error = `引擎进程意外退出（code=${code ?? '-'} signal=${signal ?? '-'}）`
    logger.error(error)
    this.patch({ phase: 'error', baseUrl: '', port: null, pid: null, error })
  }

  /** Detach immediately, serialize owned-process cleanup, and never stop an external process. */
  private releaseResources(): Promise<void> {
    this.stopHealthWatch()
    this.transportController.abort()
    this.instanceToken = ''
    this.activeRemoteWorkspaceRoot = ''
    clearRemoteAttachments()
    const handle = this.handle
    this.handle = null
    if (handle) {
      this.teardown = this.teardown.then(async () => {
        try {
          await handle.stop()
        } catch (err) {
          logger.warn(`停止引擎进程时出错：${err instanceof Error ? err.message : String(err)}`)
        }
      })
    }
    return this.teardown
  }

  async stop(): Promise<EngineSnapshot> {
    const generation = ++this.generation
    // stop() is explicit: never let a health check or pending timer reconnect
    // after the user has shut the engine down.
    this.remoteReconnectEnabled = false
    this.remoteTarget = null
    this.cancelRemoteReconnect()
    this.startupController?.abort()
    this.startupController = null
    this.starting = null
    this.patch({ phase: 'stopping', baseUrl: '' })
    await this.releaseResources()
    if (!this.current(generation)) return this.snapshot
    return this.patch({
      phase: 'idle',
      baseUrl: '',
      port: null,
      pid: null,
      adopted: false,
      error: null
    })
  }

  private startHealthWatch(): void {
    this.stopHealthWatch()
    this.healthFailures = 0
    this.healthTimer = setInterval(() => {
      void this.checkHealth()
    }, HEALTH_INTERVAL_MS)
  }

  private stopHealthWatch(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private cancelRemoteReconnect(): void {
    if (this.remoteReconnectTimer) clearTimeout(this.remoteReconnectTimer)
    this.remoteReconnectTimer = null
    this.remoteReconnectAttempt = 0
  }

  /**
   * Keep a remote connection alive through transient network failures and a
   * remote service restart. The loop is owned by the main process so all
   * renderer requests observe one connection state. It intentionally has no
   * retry ceiling; stop() disables it for an explicit user shutdown.
   */
  private scheduleRemoteReconnect(reason: string): void {
    if (!this.remoteReconnectEnabled || this.snapshot.mode !== 'remote' || !this.remoteTarget) return
    if (this.remoteReconnectTimer || this.starting) return
    const attempt = ++this.remoteReconnectAttempt
    const delay = Math.min(
      REMOTE_RECONNECT_MAX_MS,
      REMOTE_RECONNECT_INITIAL_MS * 2 ** Math.min(attempt - 1, 10)
    )
    this.stopHealthWatch()
    this.transportController.abort()
    this.patch({
      phase: 'starting',
      baseUrl: '',
      port: null,
      pid: null,
      error: `${reason}；正在重新连接（第 ${attempt} 次，${Math.ceil(delay / 1000)} 秒后）`
    })
    this.remoteReconnectTimer = setTimeout(() => {
      this.remoteReconnectTimer = null
      const target = this.remoteTarget
      if (!target || !this.remoteReconnectEnabled) return
      void this.start('remote', target.url, target.workspaceRoot, true).then((snapshot) => {
        if (snapshot.phase === 'error') this.scheduleRemoteReconnect('远端引擎暂时不可用')
      })
    }, delay)
  }

  private async checkHealth(): Promise<void> {
    const { baseUrl, instanceId } = this.snapshot
    const generation = this.generation
    if (!baseUrl || this.snapshot.phase !== 'ready') return
    try {
      const signal = AbortSignal.any([this.requestSignal, AbortSignal.timeout(3000)])
      const health = await fetch(`${baseUrl}/health`, { signal, redirect: 'error' })
      if (!health.ok) throw new Error(String(health.status))
      assertEngineHealth(await health.json())
      const response = await fetch(`${baseUrl}/meta`, { signal, redirect: 'error' })
      if (!response.ok) throw new Error(String(response.status))
      const meta = parseEngineMeta(await response.json(), this.snapshot.buildId ?? undefined)
      if (meta.instanceId !== instanceId) throw new Error('引擎实例已变化')
      if (this.current(generation)) this.healthFailures = 0
    } catch {
      if (!this.current(generation) || this.snapshot.phase !== 'ready') return
      if (++this.healthFailures >= HEALTH_FAILURE_THRESHOLD) {
        if (this.snapshot.mode === 'remote') {
          this.scheduleRemoteReconnect(
            `远端引擎失去响应或已重启（连续 ${this.healthFailures} 次检查失败）`
          )
        } else {
          // Embedded processes are owned by this desktop and cannot be
          // repaired by reconnecting. Preserve the existing terminal error
          // state for local callers.
          this.stopHealthWatch()
          this.transportController.abort()
          this.patch({
            phase: 'error',
            baseUrl: '',
            error: `引擎失去响应（连续 ${this.healthFailures} 次检查失败）`
          })
        }
      }
    }
  }

  // ==================== 流式请求 ====================

  /**
   * 发起 SSE 请求并把事件转发给渲染进程。
   *
   * 放在主进程的原因：引擎未启用 CORS，渲染进程直接 fetch 会被浏览器拦截；
   * 同时这样能统一注入鉴权头、统一处理错误契约。
   */
  async stream(
    streamId: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    method: 'GET' | 'POST' = 'POST',
    query?: Record<string, string>,
    expectedEngine?: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
  ): Promise<void> {
    const snapshot = this.snapshot
    const unsupported = engineTargetError(snapshot, expectedEngine) ?? remoteRequestError(snapshot.mode, method, path)
    if (unsupported) {
      this.emit('stream', { streamId, type: 'error', message: unsupported } satisfies StreamEvent)
      return
    }
    const baseUrl = this.baseUrl
    const requestSignal = AbortSignal.any([signal, this.requestSignal])
    if (!baseUrl) {
      this.emit('stream', { streamId, type: 'error', message: '引擎未就绪' } satisfies StreamEvent)
      return
    }

    try {
      const normalizedPath = normalizeEnginePath(path)
      const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...this.requestHeaders() }
      const requestBody = snapshot.mode === 'remote' && method === 'POST' && normalizedPath.split('?')[0] === '/api/v1/chat'
        ? await prepareRemoteChatBody(body, { baseUrl, headers, signal: requestSignal, configuredRoot: this.remoteWorkspaceRoot, target: snapshot })
        : body
      requestSignal.throwIfAborted()
      let url = `${baseUrl}${normalizedPath}`
      if (query && Object.keys(query).length > 0) {
        url += `?${new URLSearchParams(query).toString()}`
      }
      const res = await fetch(url, {
        redirect: 'error',
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(requestBody ?? {}) : undefined,
        signal: requestSignal
      })

      if (!res.ok || !res.body) {
        const envelope = await res.json().catch(() => ({})) as { code?: number; message?: string }
        if (res.status === 409 && envelope.code === 40902) {
          this.emit('stream', { streamId, type: 'snapshot-required' } satisfies StreamEvent)
          return
        }
        this.emit('stream', { streamId, type: 'error', status: res.status, code: envelope.code,
          message: envelope.message || `SSE 请求失败：HTTP ${res.status}` } satisfies StreamEvent)
        return
      }

      // 引擎在部分错误路径（如鉴权失败）会返回标准 JSON 信封而不是 SSE。
      // 若不判别就按 SSE 解析，会得到一条空回复且没有任何错误提示 —— 必须显式拦截。
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const text = await res.text()
        let message = `引擎返回了非流式响应（HTTP ${res.status}）`
        let code: number | undefined
        try {
          const envelope = JSON.parse(text) as { code?: number; message?: string }
          if (envelope.message) message = envelope.message
          if (typeof envelope.code === 'number') code = envelope.code
        } catch {
          if (text) message = text.slice(0, 500)
        }
        this.emit('stream', { streamId, type: 'error', status: res.status, code, message } satisfies StreamEvent)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        requestSignal.throwIfAborted()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 以空行分隔事件；最后一段可能不完整，留在缓冲区
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          const parsed = parseSseBlock(block)
          if (parsed) {
            this.emit('stream', { streamId, ...parsed } satisfies StreamEvent)
            if (parsed.type === 'done') return
          }
        }
      }

      this.emit('stream', { streamId, type: 'error', message: '连接在终止帧之前结束，正在恢复会话' } satisfies StreamEvent)
    } catch (err) {
      // 用户主动中断不算错误
      if (requestSignal.aborted) {
        this.emit('stream', { streamId, type: 'done' } satisfies StreamEvent)
        return
      }
      logger.error(`SSE 请求失败：${err instanceof Error ? err.message : String(err)}`)
      const raw = err instanceof Error ? err.message : String(err)
      const message = /terminated/i.test(raw)
        ? '生成中断：与引擎的连接被意外断开，请点击「继续」恢复'
        : raw
      this.emit('stream', {
        streamId,
        type: 'error',
        message
      } satisfies StreamEvent)
    }
  }
}

function portOf(baseUrl: string): number | null {
  const parsed = new URL(baseUrl)
  return parsed.port ? Number(parsed.port) : null
}

/** 全局单例 */
export const engineHost = new EngineHost()
