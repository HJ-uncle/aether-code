import { useCallback, useEffect, useState } from 'react'
import type { EngineLogEntry, EngineSnapshot } from '@shared/ipc'
import * as engine from './client'
import { publishEngineSource } from './source'

const INITIAL: EngineSnapshot = {
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
  updatedAt: 0
}

const MAX_LOG_LINES = 500

/**
 * 订阅引擎状态与日志。
 *
 * 状态由主进程主动推送，因此这里只取一次初值，之后完全依赖事件，
 * 不做轮询 —— 轮询会让状态灯在进程崩溃时仍有延迟。
 */
export function useEngine(): {
  snapshot: EngineSnapshot
  logs: EngineLogEntry[]
  clearLogs: () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(INITIAL)
  const [logs, setLogs] = useState<EngineLogEntry[]>([])

  useEffect(() => {
    let alive = true
    let observedSnapshot = false

    void engine.getSnapshot().then((value) => {
      if (alive && !observedSnapshot) { publishEngineSource(value); setSnapshot(value) }
    })

    const offSnapshot = engine.onSnapshot((value) => { observedSnapshot = true; publishEngineSource(value); setSnapshot(value) })
    const offLog = engine.onEngineLog((entry) => {
      setLogs((prev) => {
        const next = prev.length >= MAX_LOG_LINES ? prev.slice(-(MAX_LOG_LINES - 1)) : prev
        return [...next, entry]
      })
    })

    return () => {
      alive = false
      offSnapshot()
      offLog()
    }
  }, [])

  const start = useCallback(async () => {
    await engine.startEngine()
  }, [])

  const stop = useCallback(async () => {
    await engine.stopEngine()
  }, [])

  const restart = useCallback(async () => {
    await engine.restartEngine()
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  return { snapshot, logs, clearLogs, start, stop, restart }
}
