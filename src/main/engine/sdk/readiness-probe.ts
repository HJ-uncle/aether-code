/**
 * 就绪探测
 *
 * 来源：ai-agent-engine/sdk-package/src/embedded/readinessProbe.ts
 * 逻辑与上游保持一致：按固定间隔轮询 GET /health，
 * 连接被拒等网络错误视为「尚未就绪」继续重试，直到总超时。
 *
 * 内联原因见 port-finder.ts 顶部说明。
 */

export interface ReadinessProbeOptions {
  /** 引擎基地址，如 http://127.0.0.1:12324 */
  baseUrl: string
  /** 最大等待时间（ms），默认 15000 */
  timeoutMs?: number
  /** 轮询间隔（ms），默认 200 */
  intervalMs?: number
  /** 外部取消信号 */
  signal?: AbortSignal
}

/**
 * 等待引擎就绪。
 * @throws 超时或外部取消时 reject
 */
export function waitUntilReady(opts: ReadinessProbeOptions): Promise<void> {
  const { baseUrl, timeoutMs = 15000, intervalMs = 200, signal } = opts
  const healthUrl = `${baseUrl.replace(/\/+$/, '')}/health`

  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    let stopped = false
    let timer: NodeJS.Timeout | null = null

    const stopTimers = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      clearTimeout(timeoutTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      stopped = true
      stopTimers()
      reject(new Error('readiness probe aborted'))
    }

    const timeoutTimer = setTimeout(() => {
      stopped = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`agent-engine startup timeout after ${timeoutMs}ms (url: ${healthUrl})`))
    }, timeoutMs)

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    async function probe(): Promise<void> {
      if (stopped) return

      try {
        const resp = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(intervalMs * 3)
        })
        if (resp.ok) {
          stopped = true
          stopTimers()
          resolve()
          return
        }
      } catch {
        // ECONNREFUSED / 超时 —— 引擎仍在启动，继续轮询
      }

      if (stopped) return
      // 预留一个间隔的余量，避免最后一轮刚发出就触发总超时
      if (Date.now() - startTime < timeoutMs - intervalMs) {
        timer = setTimeout(() => void probe(), intervalMs)
      }
    }

    void probe()
  })
}
