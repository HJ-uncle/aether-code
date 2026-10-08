import type { AppSettings } from '@shared/ipc'

/** The embedded engine owns the main settings field; remote IDs only belong to their endpoint. */
export function selectSessionId(
  source: string,
  embeddedSessionId: string,
  remoteSessionId: string,
  createId: () => string
): string {
  return (source ? remoteSessionId : embeddedSessionId) || createId()
}

export function settingsPatchForSource(source: string, patch: Partial<AppSettings>): Partial<AppSettings> {
  const persisted = { ...patch }
  if (source) delete persisted.lastSessionId
  return persisted
}

/** 主设置只保存 embedded 会话；远端的普通设置响应不能替换 endpoint 当前选择。 */
export function sessionIdAfterSettingsUpdate(input: {
  requestSource: number
  currentSource: number
  storageSource: string
  currentSessionId: string
  persistedSessionId: string
  requestedSessionId?: string
}): string {
  if (input.requestSource !== input.currentSource) return input.currentSessionId
  if (input.requestedSessionId) return input.requestedSessionId
  return input.storageSource ? input.currentSessionId : input.persistedSessionId
}
