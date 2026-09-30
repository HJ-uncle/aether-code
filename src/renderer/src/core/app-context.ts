/**
 * 应用级共享状态：context 实例与消费 hook
 *
 * 引擎状态与设置是跨区域共享的（状态栏、设置视图、对话视图都要用）。
 * context 与 Provider 拆成两个文件是 react-refresh 的要求：
 * 组件文件只导出组件，hook 文件只导出 hook；
 * 本文件 re-export AppProvider，让既有 import 路径保持不变。
 */
import { createContext, useContext } from 'react'
import type { AppSettings } from '@shared/ipc'
import type { useEngine } from './engine/useEngine'

export interface AppContextValue {
  engine: ReturnType<typeof useEngine>
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>, remoteToken?: string) => Promise<void>
  /** 引擎是否可用（用于命令 when 条件） */
  ready: boolean
  /**
   * 设置是否已从主进程加载完成。
   *
   * 依赖持久化设置做决策的逻辑（如恢复 lastSessionId）必须等它为 true，
   * 否则会在默认空设置上「顺手」生成新值并把持久化值覆盖掉。
   */
  settingsLoaded: boolean
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp 必须在 AppProvider 内使用')
  return value
}

export { AppProvider } from './app-provider'
export { getAppSettings, onAppSettingsChanged } from './app-provider'
