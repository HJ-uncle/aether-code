import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import * as engine from './client'
import { publishEngineSource } from './source'
import { captureEngineLogs } from './log-store'

const INITIAL: EngineSnapshot = {
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
  updatedAt: 0
}

/**
 * 订阅引擎生命周期；日志保存在独立 store，避免更新应用级 Context。
 *
 * 状态由主进程主动推送，因此这里只取一次初值，之后完全依赖事件，
 * 不做轮询 —— 轮询会让状态灯在进程崩溃时仍有延迟。
 */
export function useEngine(): {
  snapshot: EngineSnapshot
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(INITIAL)

  useEffect(() => {
    let alive = true
    let observedSnapshot = false

    void engine.getSnapshot().then((value) => {
      if (alive && !observedSnapshot) {
        publishEngineSource(value)
        setSnapshot(value)
      }
    })

    const offSnapshot = engine.onSnapshot((value) => {
      observedSnapshot = true
      publishEngineSource(value)
      setSnapshot(value)
    })
    const offLog = captureEngineLogs()

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

  return useMemo(() => ({ snapshot, start, stop, restart }), [snapshot, start, stop, restart])
}
