/**
 * 应用级共享状态的 Provider 侧
 *
 * 集中把 IPC 订阅收敛到一份，避免每个组件各自订阅造成重复监听与状态不一致。
 * context 实例与 useApp 在 ./app-context，这里是唯一的组件文件（react-refresh）。
 */
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, type AppSettings, type EngineSnapshot } from '@shared/ipc'
import { useEngine } from './engine/useEngine'
import { getSettings, updateSettings as persistSettings } from './engine/client'
import { refreshModels, resetModelStore } from './engine/model-store'
import { resetSecurityModeStore } from './engine/security-store'
import { setContextKeys } from './platform/context-keys'
import { AppContext, type AppContextValue } from './app-context'

/** 引擎阶段 → 上下文键，让命令/视图用 when 表达式声明可用性 */
function contextKeysFor(snapshot: EngineSnapshot): Record<string, boolean> {
  return {
    engineReady: snapshot.phase === 'ready',
    engineBusy: snapshot.phase === 'starting' || snapshot.phase === 'installing',
    engineError: snapshot.phase === 'error',
    engineEmbedded: snapshot.mode === 'embedded',
    engineRemote: snapshot.mode === 'remote'
  }
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const engine = useEngine()
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void getSettings().then((value) => {
      if (!alive) return
      setSettings(value)
      setSettingsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // 引擎阶段变化时同步到上下文键
  const phase = engine.snapshot.phase
  useEffect(() => {
    setContextKeys(contextKeysFor(engine.snapshot))
  }, [engine.snapshot])

  // 模型列表随引擎生命周期失效：引擎重启后旧的列表可能已不可用，
  // 因此离开 ready 时清空，重新就绪后再拉取，保证 UI 不会显示过期数据。
  // 安全模式同理：它存在引擎内存里，进程一换就回到默认值。
  useEffect(() => {
    if (phase === 'ready') {
      void refreshModels()
    } else {
      resetModelStore()
      resetSecurityModeStore()
    }
  }, [phase])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await persistSettings(patch)
    setSettings(next)
  }, [])

  const value = useMemo<AppContextValue>(
    () => ({ engine, settings, updateSettings, ready: engine.snapshot.phase === 'ready', settingsLoaded }),
    [engine, settings, updateSettings, settingsLoaded]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
