import { statSync } from 'node:fs'
import { win32 } from 'node:path'

/** A drive-relative entry (C:bin or \bin) changes meaning when a project becomes the child's working directory. */
export function isFullyQualifiedWindowsPath(value: string): boolean {
  return !/[\0-\x1f]/.test(value) && (/^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value))
}

export function absoluteWindowsPathEntries(value: string): string[] {
  return value.split(';').map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(isFullyQualifiedWindowsPath)
}

/** `where git` and a bare Windows launch also search the current directory, which may be an arbitrary workspace. */
export function findWindowsGit(searchPath: string): string | undefined {
  for (const dir of absoluteWindowsPathEntries(searchPath)) {
    const file = win32.join(dir, 'git.exe')
    try { if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file }
    catch { /* An inaccessible PATH entry must not hide the next installation. */ }
  }
  return undefined
}
