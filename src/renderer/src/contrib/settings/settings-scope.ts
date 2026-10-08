import { createContext, useContext } from 'react'

export type SettingsScope = 'user' | 'workspace'

export const SettingsScopeContext = createContext<SettingsScope>('user')

export function useSettingsScope(): SettingsScope {
  return useContext(SettingsScopeContext)
}
