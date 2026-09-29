/**
 * 引擎宿主
 *
 * 管理引擎的完整生命周期，对外只暴露状态机 + 事件流 + 一条流式通道。
 * 上层（IPC / 主窗口）不需要知道进程是怎么拉起来的。
 *
 * 设计要点：
 *   - 所有状态变更产出不可变快照并广播，渲染层无需轮询
 *   - 引擎以 Node 身份运行：Electron 的 process.execPath 是 electron.exe，
 *     必须注入 ELECTRON_RUN_AS_NODE=1，否则会再拉起一个 Electron 实例
 *   - 记录子进程 PID，应用退出时主动回收，避免孤儿进程占着端口
 *   - ready 后持续健康检查，进程静默死亡时能及时反映到 UI
 *   - 启动前若首选端口已有健康引擎，则复用它而不是另起一个：
 *     异常退出遗留的孤儿引擎仍持有同一个 SQLite 文件，双进程同一 DB 是数据风险
 *
 * 已知限制（P0）：复用外部引擎时无法将其关闭（只断开连接）；
 * 计划在 P5 引入 PID 文件，实现遗留进程的识别与回收。
 */
import { EventEmitter } from 'node:events'
import type { ChatSsePayload, EngineSnapshot, StreamEvent } from '../../shared/ipc'
import { getSettings } from '../settings-store'
import { logger } from './logger'
import { ensureEncryptionKey } from './secrets'
import { findAvailablePort } from './sdk/port-finder'
import { startProcess, type ProcessHandle } from './sdk/process-manager'
import { waitUntilReady } from './sdk/readiness-probe'
import { DEFAULT_ENGINE_VERSION, engineDataFile, resolveRuntime } from './runtime'

const PREFERRED_PORT = 12323
const STARTUP_TIMEOUT_MS = 60_000
const HEALTH_INTERVAL_MS = 5_000
const HEALTH_FAILURE_THRESHOLD = 3

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
    version: null,
    dataDir: null,
    error: null,
    updatedAt: Date.now()
  }

  private healthTimer: ReturnType<typeof setInterval> | null = null
  private healthFailures = 0
  private starting: Promise<EngineSnapshot> | null = null
  /** 用户主动停止时置位，用于区分「正常关闭」与「异常退出」 */
  private stopping = false
  /** 当前引擎是否复用自外部（不由本应用启动） */
  private adopted = false

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

  /** 引擎基地址；未就绪时为空串 */
  get baseUrl(): string {
    return this.snapshot.baseUrl
  }

  // ==================== 启动 ====================

  async start(mode: 'embedded' | 'remote', remoteBaseUrl = ''): Promise<EngineSnapshot> {
    // 并发调用合并到同一次启动流程
    if (this.starting) return this.starting
    if (this.snapshot.phase === 'ready' && this.snapshot.mode === mode) return this.snapshot

    this.starting = this.doStart(mode, remoteBaseUrl).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async doStart(
    mode: 'embedded' | 'remote',
    remoteBaseUrl: string
  ): Promise<EngineSnapshot> {
    await this.stop()

    if (mode === 'remote') return this.startRemote(remoteBaseUrl)
    return this.startEmbedded()
  }

  private async startRemote(remoteBaseUrl: string): Promise<EngineSnapshot> {
    const url = remoteBaseUrl.trim().replace(/\/+$/, '')
    if (!url) {
      return this.patch({ mode: 'remote', phase: 'error', error: '未配置远端引擎地址' })
    }

    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`/health 返回 HTTP ${res.status}`)
    } catch (err) {
      return this.patch({
        mode: 'remote',
        phase: 'error',
        baseUrl: '',
        port: null,
        pid: null,
        error: `无法连接远端引擎：${err instanceof Error ? err.message : String(err)}`
      })
    }

    logger.info(`已连接远端引擎 ${url}`)
    this.startHealthWatch()
    const version = await fetchEngineVersion(url)
    return this.patch({
      mode: 'remote',
      phase: 'ready',
      baseUrl: url,
      port: portOf(url),
      pid: null,
      adopted: false,
      entryPath: null,
      version,
      dataDir: null,
      error: null
    })
  }

  private async startEmbedded(): Promise<EngineSnapshot> {
    // 首选端口上若已有健康引擎，复用它而不是再起一个。
    // 上一轮异常退出（如被强杀）会留下孤儿引擎，它仍持有同一个 SQLite 文件；
    // 此时再起一个引擎会造成两个进程同时读写同一份 DB。
    // 端口来自用户设置：独立 userData（如 E2E）可配不同端口实现隔离。
    const preferredPort = getSettings().preferredPort || PREFERRED_PORT
    const adopted = await this.tryAdoptExisting(preferredPort)
    if (adopted) return adopted

    const runtime = resolveRuntime()
    if (!runtime) {
      return this.patch({
        mode: 'embedded',
        phase: 'error',
        error:
          '未找到引擎运行时。请设置 AETHER_IDE_ENGINE_ENTRY 指向引擎入口，或先安装引擎（安装包内置 / 从 CDN 下载）。'
      })
    }

    this.patch({
      mode: 'embedded',
      phase: 'starting',
      entryPath: runtime.entryPath,
      version: runtime.version,
      error: null
    })
    logger.info(`使用引擎运行时（来源：${runtime.source}）：${runtime.entryPath}`)

    let encryptionKey: string
    try {
      const secret = ensureEncryptionKey()
      encryptionKey = secret.key
      if (!secret.encryptedAtRest) {
        logger.warn('系统密钥存储不可用，引擎加密密钥以明文保存')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return this.patch({ phase: 'error', error: message })
    }

    const dataDir = engineDataFile(DEFAULT_ENGINE_VERSION)

    let port: number
    try {
      port = await findAvailablePort(preferredPort)
    } catch (err) {
      return this.patch({
        phase: 'error',
        error: `未找到可用端口：${err instanceof Error ? err.message : String(err)}`
      })
    }

    this.stopping = false
    this.handle = startProcess({
      binPath: runtime.entryPath,
      port,
      dataDir,
      env: {
        // 关键：让 electron.exe 以 Node 模式运行引擎脚本
        ELECTRON_RUN_AS_NODE: '1',
        HOST: '127.0.0.1',
        ENCRYPTION_KEY: encryptionKey
      },
      onExit: (code, signal) => this.onProcessExit(code, signal)
    })

    const baseUrl = `http://127.0.0.1:${port}`

    try {
      await waitUntilReady({ baseUrl, timeoutMs: STARTUP_TIMEOUT_MS })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.stop()
      return this.patch({
        phase: 'error',
        baseUrl: '',
        port: null,
        pid: null,
        error: `引擎启动超时或失败：${message}`
      })
    }

    logger.info(`引擎已就绪 ${baseUrl}（pid ${this.handle?.pid ?? '未知'}）`)
    this.startHealthWatch()
    const version = await fetchEngineVersion(baseUrl)
    return this.patch({
      phase: 'ready',
      baseUrl,
      port,
      pid: this.handle?.pid ?? null,
      adopted: false,
      version,
      dataDir,
      error: null
    })
  }

  /**
   * 探测首选端口上是否已有可用的引擎，有则复用。
   *
   * 判定依据有两条，缺一不可：
   *   1. 首选端口被占用（端口探测器会返回其它端口）
   *   2. 该端口 /health 返回引擎标准信封且 status=ok
   * 不满足第 2 条时说明占用者是无关程序，退回正常启动流程。
   */
  private async tryAdoptExisting(preferredPort: number): Promise<EngineSnapshot | null> {
    let freePort: number
    try {
      freePort = await findAvailablePort(preferredPort)
    } catch {
      return null
    }
    if (freePort === preferredPort) return null

    const baseUrl = `http://127.0.0.1:${preferredPort}`
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null

      const body = (await res.json()) as { code?: number; data?: { status?: string } }
      if (body?.code !== 200 || body?.data?.status !== 'ok') return null
    } catch {
      // 端口被占用但不是引擎
      return null
    }

    this.adopted = true
    logger.warn(
      `检测到 ${baseUrl} 上已有引擎在运行，将复用它。` +
        '（常见于上次异常退出遗留的进程）该进程不由本应用启动，停止只会断开连接。'
    )
    this.startHealthWatch()
    return this.patch({
      mode: 'embedded',
      phase: 'ready',
      baseUrl,
      port: preferredPort,
      pid: null,
      adopted: true,
      entryPath: null,
      version: await fetchEngineVersion(baseUrl),
      dataDir: null,
      error: null
    })
  }

  /** 子进程退出回调：区分我们主动停止还是意外崩溃 */
  private onProcessExit(code: number | null, signal: string | null): void {
    if (this.stopping) return

    logger.error(`引擎进程意外退出（code=${code} signal=${signal}）`)
    this.stopHealthWatch()
    this.handle = null
    this.patch({
      phase: 'error',
      baseUrl: '',
      port: null,
      pid: null,
      adopted: false,
      error: `引擎进程意外退出（code=${code ?? '-'} signal=${signal ?? '-'}）`
    })
  }

  // ==================== 停止 ====================

  async stop(): Promise<EngineSnapshot> {
    this.stopHealthWatch()

    const wasAdopted = this.adopted
    this.adopted = false

    const handle = this.handle
    this.handle = null

    if (handle) {
      this.stopping = true
      this.patch({ phase: 'stopping' })
      try {
        await handle.stop()
      } catch (err) {
        logger.warn(`停止引擎进程时出错：${err instanceof Error ? err.message : String(err)}`)
      }
      this.stopping = false
    } else if (wasAdopted) {
      // 复用自外部的引擎不归我们管，只断开连接
      logger.info('已断开与外部引擎的连接（该进程未由本应用启动，保持运行）')
      this.patch({ phase: 'stopping' })
    }

    return this.patch({
      phase: 'idle',
      baseUrl: '',
      port: null,
      pid: null,
      adopted: false,
      error: null
    })
  }

  // ==================== 健康监测 ====================

  private startHealthWatch(): void {
    this.stopHealthWatch()
    this.healthFailures = 0
    this.healthTimer = setInterval(() => {
      void this.checkHealth()
    }, HEALTH_INTERVAL_MS)
  }

  private stopHealthWatch(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  private async checkHealth(): Promise<void> {
    const baseUrl = this.snapshot.baseUrl
    if (!baseUrl || this.snapshot.phase !== 'ready') return

    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(String(res.status))
      this.healthFailures = 0
    } catch {
      this.healthFailures++
      if (this.healthFailures >= HEALTH_FAILURE_THRESHOLD) {
        this.stopHealthWatch()
        this.patch({
          phase: 'error',
          error: `引擎失去响应（连续 ${this.healthFailures} 次健康检查失败）`
        })
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
    query?: Record<string, string>
  ): Promise<void> {
    const baseUrl = this.snapshot.baseUrl
    if (!baseUrl) {
      this.emit('stream', { streamId, type: 'error', message: '引擎未就绪' } satisfies StreamEvent)
      return
    }

    try {
      let url = `${baseUrl}${normalizePath(path)}`
      if (query && Object.keys(query).length > 0) {
        url += `?${new URLSearchParams(query).toString()}`
      }
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal
      })

      if (!res.ok || !res.body) {
        throw new Error(`SSE 请求失败：HTTP ${res.status}`)
      }

      // 引擎在部分错误路径（如鉴权失败）会返回标准 JSON 信封而不是 SSE。
      // 若不判别就按 SSE 解析，会得到一条空回复且没有任何错误提示 —— 必须显式拦截。
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const text = await res.text()
        let message = `引擎返回了非流式响应（HTTP ${res.status}）`
        try {
          const envelope = JSON.parse(text) as { code?: number; message?: string }
          if (envelope.message) message = envelope.message
        } catch {
          if (text) message = text.slice(0, 500)
        }
        this.emit('stream', { streamId, type: 'error', message } satisfies StreamEvent)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 以空行分隔事件；最后一段可能不完整，留在缓冲区
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          const parsed = parseSseBlock(block)
          if (parsed === 'done') {
            this.emit('stream', { streamId, type: 'done' } satisfies StreamEvent)
            return
          }
          if (parsed) {
            this.emit('stream', {
              streamId,
              type: 'payload',
              payload: parsed
            } satisfies StreamEvent)
          }
        }
      }

      this.emit('stream', { streamId, type: 'done' } satisfies StreamEvent)
    } catch (err) {
      // 用户主动中断不算错误
      if (signal.aborted) {
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

// ==================== 工具函数 ====================

function portOf(baseUrl: string): number | null {
  try {
    const parsed = new URL(baseUrl)
    return parsed.port ? Number(parsed.port) : null
  } catch {
    return null
  }
}

/** 拉取引擎版本（/meta，白名单免鉴权）。失败不阻塞连接，仅版本显示为 null */
async function fetchEngineVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/meta`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = (await res.json()) as { code?: number; data?: { version?: string } }
    return body?.code === 200 ? (body.data?.version ?? null) : null
  } catch {
    return null
  }
}

/**
 * 引擎的 health / metrics 挂在根路径，业务路由全部在 /api/v1 下。
 * 实测确认：/models 位于 /api/v1/models，不在根路径。
 */
function normalizePath(path: string): string {
  const trimmed = path.startsWith('/') ? path : `/${path}`
  if (/^\/(health|metrics|openapi\.json)(\/|$)/.test(trimmed)) return trimmed
  return `/api/v1${trimmed}`
}

/** 解析单个 SSE 事件块；返回 'done' 表示终止帧，null 表示忽略（心跳/非 data 帧） */
function parseSseBlock(block: string): ChatSsePayload | 'done' | null {
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()

    // 心跳注释帧（`: ping <ts>`）
    if (line.startsWith(':')) continue

    if (line.startsWith('event:')) {
      if (line.slice(6).trim() === 'done') return 'done'
      continue
    }

    if (line.startsWith('data:')) {
      const data = line.slice(5).trim()
      if (data === '[DONE]') return 'done'
      try {
        return JSON.parse(data) as ChatSsePayload
      } catch {
        return null
      }
    }
  }
  return null
}

/** 全局单例 */
export const engineHost = new EngineHost()
