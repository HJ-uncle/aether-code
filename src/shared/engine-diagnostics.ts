/** Resource measurements describe the engine host, never the renderer's process. */
export interface EngineResourceSnapshot {
  sampledAt: number
  scope: 'engine-process'
  state: 'available' | 'unavailable'
  reason?: string
  pid: number | null
  cpu: { percent: number | null; intervalMs: number | null; normalization: 'one-logical-core' }
  memory: { rssBytes: number | null; privateBytes: number | null }
  /** OS process I/O transfer counters include file, pipe and device transfers. */
  io: {
    readBytes: number | null
    writeBytes: number | null
    readBytesPerSecond: number | null
    writeBytesPerSecond: number | null
  }
  hostMemory: { totalBytes: number | null; availableBytes: number | null }
  disk: { totalBytes: number | null; availableBytes: number | null; path: string | null }
  /**
   * A bounded view of the engine process tree. The main process remains the
   * primary resource sample above; this view makes child runtime/tool costs
   * visible without requiring the renderer to enumerate OS processes.
   */
  processTree: EngineProcessTreeSnapshot
  collection: { durationMs: number; cached: boolean }
}

export interface EngineProcessDetail {
  pid: number
  parentPid: number | null
  /** Stable process kind used by the UI instead of a localized executable name. */
  kind: 'engine' | 'child'
  name: string
  /** Executable path only; command-line arguments are intentionally omitted. */
  command: string
  depth: number
  ageMs: number | null
  cpu: { percent: number | null; intervalMs: number | null }
  memory: { rssBytes: number | null; privateBytes: number | null }
  io: {
    readBytes: number | null
    writeBytes: number | null
    readBytesPerSecond: number | null
    writeBytesPerSecond: number | null
  }
}

export interface EngineProcessTreeSnapshot {
  state: 'available' | 'unavailable'
  reason?: string
  rootPid: number | null
  /** Creation identity of the root process; guards cached rows against PID reuse. */
  rootIdentity: string | null
  partial: boolean
  processes: EngineProcessDetail[]
  totals: {
    count: number
    cpu: { percent: number | null; intervalMs: number | null }
    memory: { rssBytes: number | null; privateBytes: number | null }
    io: {
      readBytes: number | null
      writeBytes: number | null
      readBytesPerSecond: number | null
      writeBytesPerSecond: number | null
    }
  }
  sampledAt: number | null
  collection: { durationMs: number; cached: boolean }
}

export interface EngineStorageSnapshot {
  state: 'available' | 'unavailable'
  reason?: string
  path: string | null
  totalBytes: number | null
  files: number
  categories: Array<{ category: string; bytes: number; files: number }>
  partial: boolean
  scannedAt: number | null
  durationMs: number
  cached: boolean
}

export interface EngineHealthDiagnostics {
  /** Desktop-owned identity-checked HTTP probes, not a runtime heartbeat metric. */
  source?: 'desktop-http-probe'
  lastSuccessAt: number | null
  lastCheckedAt: number | null
  lastLatencyMs: number | null
  consecutiveFailures: number
  checkIntervalMs: number
  failureThreshold: number
  timeoutMs?: number
  checking?: boolean
  activeStreams: number
}

export interface EngineDiagnosticsInput {
  refreshStorage?: boolean
}

export interface EngineDiagnostics {
  /** Reject late results after a connection, process or account change. */
  identity: string
  resources: EngineResourceSnapshot
  storage: EngineStorageSnapshot
  health: EngineHealthDiagnostics
}
