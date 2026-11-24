import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, normalize } from 'node:path'
import { absoluteWindowsPathEntries, isFullyQualifiedWindowsPath } from './git/windows-git'

function windowsPathKey(entry: string): string {
  return normalize(entry.trim().replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '').toLowerCase()
}

/** Only the child process sees these paths. Imported engines share the tools shipped with the desktop. */
export function localToolchainEnvironment(consumer: 'engine' | 'terminal' | 'git', engineNode?: string): Record<string, string> {
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const inherited = process.env[pathKey] ?? ''
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return engineNode ? { [pathKey]: [dirname(engineNode), inherited].filter(Boolean).join(delimiter) } : {}
  }

  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const node = join(resources, 'engine', 'win32-x64', 'runtime')
  const python = join(resources, 'toolchains', 'win32-x64', 'python')
  const git = join(resources, 'toolchains', 'win32-x64', 'git', 'cmd')
  const interpreter = join(python, 'python.exe')
  const fallback: string[] = []
  const overrides: Record<string, string> = {}
  if (existsSync(join(node, 'node.exe'))) fallback.push(node)
  else if (engineNode) fallback.push(dirname(engineNode))
  const hasPython = existsSync(interpreter)
  if (hasPython) {
    fallback.push(python)
    const scripts = join(python, 'Scripts')
    if (existsSync(scripts)) fallback.push(scripts)
    if (consumer === 'engine' && !process.env.AETHER_OFFICE_PYTHON && !process.env.AETHER_OFFICE_RUNTIME_ROOT) {
      // Office probes trust installation roots, never executables found in a project directory.
      overrides.AETHER_OFFICE_RUNTIME_ROOT = python
      overrides.AETHER_OFFICE_PYTHON = interpreter
    }
  }
  // MinGit's public cmd directory belongs on PATH; its private Unix tools must never shadow Windows programs.
  if (existsSync(join(git, 'git.exe'))) fallback.push(git)
  // Windows may search the command's working directory even before its PATH. Scope this opt-out to the child.
  overrides.NoDefaultCurrentDirectoryInExePath = '1'

  // Opening a directory must not implicitly activate its .venv or execute a workspace-owned program.
  const active = process.env.VIRTUAL_ENV
  const preferred = active && isFullyQualifiedWindowsPath(active) && existsSync(join(active, 'Scripts', 'python.exe')) ? [join(active, 'Scripts')] : []
  const aliases: string[] = []
  const store = windowsPathKey(join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps'))
  for (const dir of absoluteWindowsPathEntries(inherited)) {
    // Keep version-manager shims before the fallback and the Store's python.exe placeholder after it.
    if (hasPython && windowsPathKey(dir) === store) aliases.push(dir)
    else preferred.push(dir)
  }
  const seen = new Set<string>()
  overrides[pathKey] = [...preferred, ...fallback, ...aliases].filter(dir => {
    const id = windowsPathKey(dir)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }).join(delimiter)
  return overrides
}
