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
