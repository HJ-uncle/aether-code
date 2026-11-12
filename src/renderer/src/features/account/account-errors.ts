/** Electron's IPC wrapper is transport detail, not an instruction the user can act on. */
export function accountErrorMessage(cause: unknown, fallback = '操作失败，请重试。'): string {
  let message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  let previous: string
  do {
    previous = message
    message = message.replace(/^Error invoking remote method\s+['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/i, '').trim()
  } while (message !== previous)
  return message || fallback
}
