/** Workbench privileges belong to one document, not every URL in its window.
 * Hash and query changes retain that document; sibling paths and credentials
 * do not. Keep this check usable by both the main process and trusted preload. */
export function isTrustedWorkbenchUrl(actual: string, expected: string): boolean {
  try {
    const target = new URL(actual), entry = new URL(expected)
    return ['file:', 'http:', 'https:'].includes(entry.protocol) &&
      !target.username && !target.password && !entry.username && !entry.password &&
      target.protocol === entry.protocol && target.host === entry.host && target.pathname === entry.pathname
  } catch { return false }
}
