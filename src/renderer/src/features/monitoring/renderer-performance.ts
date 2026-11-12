/** Local page telemetry is independent of engine memory. Keep only aggregates:
 * retaining PerformanceEntry objects would turn the monitor into a profiler. */
export const RENDERER_PERFORMANCE_INTERVAL_MS = 2_000

export interface RendererHeapEstimate {
  usedBytes: number
  totalBytes: number
  limitBytes: number
}

export interface RendererPerformanceSnapshot {
  observedMs: number
  longTasks: { available: boolean; count: number; totalMs: number; maxMs: number }
  heap: RendererHeapEstimate | null
}

export interface RendererPerformancePorts {
  now: () => number
  readHeap: () => unknown
  observe: (consume: (entries: ReadonlyArray<{ startTime: number; duration: number }>) => void) => (() => void) | null
  schedule: (publish: () => void, intervalMs: number) => () => void
}

export function parseRendererHeap(value: unknown): RendererHeapEstimate | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const valid = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
  if (!valid(raw.usedJSHeapSize) || !valid(raw.totalJSHeapSize) || !valid(raw.jsHeapSizeLimit)
    || raw.totalJSHeapSize < raw.usedJSHeapSize || raw.jsHeapSizeLimit < raw.totalJSHeapSize || raw.jsHeapSizeLimit === 0) return null
  return { usedBytes: raw.usedJSHeapSize, totalBytes: raw.totalJSHeapSize, limitBytes: raw.jsHeapSizeLimit }
}

/** The owner starts this only while visible and expanded. Disposal ignores late
 * observer callbacks and releases the observer and the sole slow timer. */
export function startRendererPerformanceProbe(
  ports: RendererPerformancePorts,
  publish: (snapshot: RendererPerformanceSnapshot) => void
): () => void {
  let alive = true, count = 0, totalMs = 0, maxMs = 0
  const started = ports.now()
  let disconnect: (() => void) | null = null
  try {
    disconnect = ports.observe(entries => {
      if (!alive) return
      for (const entry of entries) {
        if (!Number.isFinite(entry.startTime) || entry.startTime < started || !Number.isFinite(entry.duration) || entry.duration < 50) continue
        count += 1
        totalMs += entry.duration
        maxMs = Math.max(maxMs, entry.duration)
      }
    })
  } catch { /* Unsupported observers are unavailable, never a healthy zero. */ }
  const sample = (): void => {
    if (!alive) return
    let heap: RendererHeapEstimate | null = null
    try { heap = parseRendererHeap(ports.readHeap()) } catch { /* Some Chromium builds disallow memory estimates. */ }
    publish({ observedMs: Math.max(0, ports.now() - started), longTasks: { available: disconnect !== null, count, totalMs, maxMs }, heap })
  }
  sample()
  const cancel = ports.schedule(sample, RENDERER_PERFORMANCE_INTERVAL_MS)
  return () => { alive = false; cancel(); disconnect?.() }
}
