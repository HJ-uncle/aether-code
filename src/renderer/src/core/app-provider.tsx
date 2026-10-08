/**
 * 应用级共享状态的 Provider 侧
 *
 * 集中把 IPC 订阅收敛到一份，避免每个组件各自订阅造成重复监听与状态不一致。
 * context 实例与 useApp 在 ./app-context，这里是唯一的组件文件（react-refresh）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, type AppSettings, type EngineSnapshot, type RemoteAuthCredential } from '@shared/ipc'
import { useEngine } from './engine/useEngine'
import { selectSessionId, sessionIdAfterSettingsUpdate, settingsPatchForSource } from './engine/session-selection'
import { engineConnectionKey, getEngineStorageKey, getEngineSource, isEngineReady, sessionStorageKey, subscribeEngineSource } from './engine/source'
import { getSettings, updateSettings as persistSettings } from './engine/client'
import { refreshModels, resetModelStore } from './engine/model-store'
import { resetSecurityModeStore } from './engine/security-store'
import { setContextKeys } from './platform/context-keys'
import { AppContext, type AppContextValue } from './app-context'
import { publishWorkspaceSelection } from './workspace/connection'
import { getWorkspaceState, onWorkspaceChanged } from './workspace/workspace-store'
import { getWorkspaceSettings, onWorkspaceSettingsChanged } from './workspace/workspace-settings'

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

/**
 * 当前设置的模块级镜像。
 *
 * 设置的正源仍是 AppProvider 的 state（React 渲染要用），但模块级 store
 * （搜索等）不在组件树里，拿不到 context。镜像只在每次设置变化时被写入，
 * 与 state 同源同刻，因此读到的永远是当前值。
 */
let currentSettings: AppSettings = DEFAULT_SETTINGS

/** 供非组件代码读取当前设置（组件请用 useApp，才有重渲染） */
export function getAppSettings(): AppSettings {
  return currentSettings
}

/**
 * 设置变更的非组件订阅点。
 *
 * 模块级 store（搜索等）不在组件树里，拿不到 context；设置一变它们
 * 就得自己知道（搜索要按新的排除表重搜）。search-store 注册进来，
 * AppProvider 在设置落定后广播 —— 依赖方向仍是 store → app-context → 本文件，不成环。
 */
const settingsListeners = new Set<(settings: AppSettings) => void>()

export function onAppSettingsChanged(listener: (settings: AppSettings) => void): () => void {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

function publishSettings(next: AppSettings): void {
  currentSettings = next
  for (const listener of settingsListeners) listener(next)
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const engine = useEngine()
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  // 异步设置响应必须读取最新选择，不能使用发起请求时闭包里的会话。
  const sessionIdRef = useRef(DEFAULT_SETTINGS.lastSessionId)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const selectedSourceRef = useRef<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const workspace = useSyncExternalStore(onWorkspaceChanged, getWorkspaceState)
  const workspaceSettings = useSyncExternalStore(
    onWorkspaceSettingsChanged,
    () => getWorkspaceSettings(workspace.root),
    () => getWorkspaceSettings(null)
  )
  const connectionKey = engineConnectionKey(engine.snapshot)
  const visibleSettings = useMemo<AppSettings>(
    () => ({ ...settings, ...workspaceSettings }),
    [settings, workspaceSettings]
  )

  useEffect(() => {
    publishSettings(visibleSettings)
  }, [visibleSettings])

  useEffect(() => {
    let alive = true
    void getSettings().then((value) => {
      if (!alive) return
      sessionIdRef.current = value.lastSessionId
      setSettings(value)
      publishSettings({ ...value, ...getWorkspaceSettings(getWorkspaceState().root) })
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
  }, [phase, connectionKey])

  useEffect(() => subscribeEngineSource(() => {
    resetModelStore()
    resetSecurityModeStore()
  }), [])

  // Embedded selection follows explicit main settings writes. Remote selection is endpoint-local.
  useEffect(() => {
    if (!settingsLoaded || !isEngineReady()) return
    const storageSource = getEngineStorageKey()
    if (selectedSourceRef.current === storageSource) return
    const source = getEngineSource()
    let alive = true
    void (async () => {
      const persisted = storageSource ? null : await getSettings()
      if (!alive || source !== getEngineSource() || !isEngineReady()) return
      let saved = ''
      if (storageSource) {
        try { saved = localStorage.getItem(sessionStorageKey('aether:lastSessionId', storageSource)) ?? '' } catch { /* optional persistence */ }
      }
      const sessionId = selectSessionId(storageSource, persisted?.lastSessionId ?? '', saved, () => globalThis.crypto.randomUUID())
      selectedSourceRef.current = storageSource
      if (storageSource) {
        try { localStorage.setItem(sessionStorageKey('aether:lastSessionId', storageSource), sessionId) } catch { /* optional persistence */ }
      } else if (!persisted?.lastSessionId) {
        void persistSettings({ lastSessionId: sessionId }).catch(() => {})
      }
      const next = { ...settings, lastSessionId: sessionId }
      sessionIdRef.current = sessionId
      setSettings(next)
      publishSettings({ ...next, ...getWorkspaceSettings(getWorkspaceState().root) })
      publishWorkspaceSelection(next, storageSource)
      setSelectedSource(storageSource)
    })()
    return () => { alive = false }
  }, [settingsLoaded, connectionKey, phase, settings])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>, remoteToken?: string, remoteAuth?: RemoteAuthCredential | null) => {
    const source = getEngineSource()
    const storageSource = getEngineStorageKey()
    const persistedPatch = settingsPatchForSource(storageSource, patch)
    const next = Object.keys(persistedPatch).length > 0 || remoteToken !== undefined || remoteAuth !== undefined
      ? await persistSettings(persistedPatch, remoteToken, remoteAuth)
      : await getSettings()
    const currentSource = getEngineSource()
    if (source === currentSource && storageSource && patch.lastSessionId) {
      try { localStorage.setItem(sessionStorageKey('aether:lastSessionId', storageSource), patch.lastSessionId) } catch { /* optional persistence */ }
    }
    const nextUserSettings = { ...next, lastSessionId: sessionIdAfterSettingsUpdate({
      requestSource: source,
      currentSource,
      storageSource,
      currentSessionId: sessionIdRef.current,
      persistedSessionId: next.lastSessionId,
      requestedSessionId: patch.lastSessionId
    }) }
    sessionIdRef.current = nextUserSettings.lastSessionId
    setSettings(nextUserSettings)
    const visible = { ...nextUserSettings, ...getWorkspaceSettings(getWorkspaceState().root) }
    publishSettings(visible)
    if (source === getEngineSource()) publishWorkspaceSelection(nextUserSettings, storageSource)
  }, [])

  const value = useMemo<AppContextValue>(
    () => ({
      engine,
      settings: visibleSettings,
      userSettings: settings,
      updateSettings,
      ready: engine.snapshot.phase === 'ready' && isEngineReady() && settingsLoaded && selectedSource === getEngineStorageKey(),
      settingsLoaded
    }),
    [engine, visibleSettings, updateSettings, settingsLoaded, selectedSource]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
