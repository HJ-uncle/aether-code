import { execFile, spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { OpenWithApp, OpenWithAppId } from '../shared/ipc'
import { recoverHiddenVSCodeWindow } from './open-with-vscode-window'

type LaunchKind = 'vscode' | 'sublime' | 'zed' | 'notepad-plus-plus' | 'jetbrains' | 'mac-app'

export interface OpenWithInstallation {
  app: OpenWithApp
  command?: { executable: string; kind: LaunchKind; applicationPath?: string }
}

export interface OpenWithRegistryEntry {
  kind: 'app-path' | 'uninstall'
  name: string
  executable?: string
  location?: string
}

export interface OpenWithEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  isFile: (file: string) => Promise<boolean>
  readDirectories?: (directory: string) => Promise<string[]>
  readRegistry?: () => Promise<OpenWithRegistryEntry[]>
}

interface DeveloperApplication {
  id: Exclude<OpenWithAppId, 'file-explorer'>
  label: string
  kind: Exclude<LaunchKind, 'mac-app'>
  executables: string[]
  folders: string[]
  registryName: RegExp
  macBundles: string[]
  linuxCommands: string[]
  toolbox?: string[]
}

const developerApplications: DeveloperApplication[] = [
  { id: 'vscode', label: 'VS Code', kind: 'vscode', executables: ['Code.exe'], folders: ['Microsoft VS Code'], registryName: /^(?:Microsoft )?Visual Studio Code(?!.*Insiders)/i, macBundles: ['Visual Studio Code.app'], linuxCommands: ['code'] },
  { id: 'vscode-insiders', label: 'VS Code Insiders', kind: 'vscode', executables: ['Code - Insiders.exe'], folders: ['Microsoft VS Code Insiders'], registryName: /Visual Studio Code.*Insiders/i, macBundles: ['Visual Studio Code - Insiders.app'], linuxCommands: ['code-insiders'] },
  { id: 'cursor', label: 'Cursor', kind: 'vscode', executables: ['Cursor.exe'], folders: ['cursor', 'Cursor'], registryName: /^Cursor(?:\s|$)/i, macBundles: ['Cursor.app'], linuxCommands: ['cursor'] },
  { id: 'windsurf', label: 'Windsurf', kind: 'vscode', executables: ['Windsurf.exe'], folders: ['Windsurf'], registryName: /^Windsurf(?:\s|$)/i, macBundles: ['Windsurf.app'], linuxCommands: ['windsurf'] },
  { id: 'trae', label: 'Trae', kind: 'vscode', executables: ['TRAE.exe', 'Trae CN.exe'], folders: ['Trae', 'TRAE', 'Trae CN'], registryName: /^TRAE(?:\s|$)/i, macBundles: ['Trae.app', 'TRAE.app', 'Trae CN.app'], linuxCommands: ['trae'] },
  { id: 'vscodium', label: 'VSCodium', kind: 'vscode', executables: ['VSCodium.exe'], folders: ['VSCodium'], registryName: /^VSCodium(?:\s|$)/i, macBundles: ['VSCodium.app'], linuxCommands: ['codium'] },
  { id: 'zed', label: 'Zed', kind: 'zed', executables: ['Zed.exe'], folders: ['Zed'], registryName: /^Zed(?:\s|$)/i, macBundles: ['Zed.app'], linuxCommands: ['zed', 'zeditor'] },
  { id: 'sublime-text', label: 'Sublime Text', kind: 'sublime', executables: ['sublime_text.exe'], folders: ['Sublime Text', 'Sublime Text 3'], registryName: /^Sublime Text(?:\s|$)/i, macBundles: ['Sublime Text.app'], linuxCommands: ['subl', 'sublime_text'] },
  { id: 'notepad-plus-plus', label: 'Notepad++', kind: 'notepad-plus-plus', executables: ['notepad++.exe'], folders: ['Notepad++'], registryName: /^Notepad\+\+(?:\s|$)/i, macBundles: [], linuxCommands: [] },
  { id: 'intellij-idea', label: 'IntelliJ IDEA', kind: 'jetbrains', executables: ['idea64.exe', 'idea.exe'], folders: ['IntelliJ IDEA', 'IntelliJ IDEA Community Edition'], registryName: /^(?:JetBrains )?IntelliJ IDEA(?:\s|$)/i, macBundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'], linuxCommands: ['idea', 'idea.sh'], toolbox: ['IDEA-U', 'IDEA-C', 'intellij-idea-ultimate', 'intellij-idea-community-edition'] },
  { id: 'webstorm', label: 'WebStorm', kind: 'jetbrains', executables: ['webstorm64.exe', 'webstorm.exe'], folders: ['WebStorm'], registryName: /^(?:JetBrains )?WebStorm(?:\s|$)/i, macBundles: ['WebStorm.app'], linuxCommands: ['webstorm', 'webstorm.sh'], toolbox: ['WebStorm', 'webstorm'] },
  { id: 'pycharm', label: 'PyCharm', kind: 'jetbrains', executables: ['pycharm64.exe', 'pycharm.exe'], folders: ['PyCharm', 'PyCharm Community Edition'], registryName: /^(?:JetBrains )?PyCharm(?:\s|$)/i, macBundles: ['PyCharm.app', 'PyCharm CE.app'], linuxCommands: ['pycharm', 'pycharm.sh'], toolbox: ['PyCharm-P', 'PyCharm-C', 'pycharm-professional', 'pycharm-community'] },
  { id: 'goland', label: 'GoLand', kind: 'jetbrains', executables: ['goland64.exe', 'goland.exe'], folders: ['GoLand'], registryName: /^(?:JetBrains )?GoLand(?:\s|$)/i, macBundles: ['GoLand.app'], linuxCommands: ['goland', 'goland.sh'], toolbox: ['Goland', 'GoLand', 'goland'] },
  { id: 'rider', label: 'Rider', kind: 'jetbrains', executables: ['rider64.exe', 'rider.exe'], folders: ['JetBrains Rider', 'Rider'], registryName: /^(?:JetBrains )?Rider(?:\s|$)/i, macBundles: ['Rider.app'], linuxCommands: ['rider', 'rider.sh'], toolbox: ['Rider', 'rider'] },
  { id: 'clion', label: 'CLion', kind: 'jetbrains', executables: ['clion64.exe', 'clion.exe'], folders: ['CLion'], registryName: /^(?:JetBrains )?CLion(?:\s|$)/i, macBundles: ['CLion.app'], linuxCommands: ['clion', 'clion.sh'], toolbox: ['CLion', 'clion'] },
  { id: 'rustrover', label: 'RustRover', kind: 'jetbrains', executables: ['rustrover64.exe', 'rustrover.exe'], folders: ['RustRover'], registryName: /^(?:JetBrains )?RustRover(?:\s|$)/i, macBundles: ['RustRover.app'], linuxCommands: ['rustrover', 'rustrover.sh'], toolbox: ['RustRover', 'rustrover'] },
  { id: 'android-studio', label: 'Android Studio', kind: 'jetbrains', executables: ['studio64.exe', 'studio.exe'], folders: ['Android Studio', 'Android/Android Studio'], registryName: /^Android Studio(?:\s|$)/i, macBundles: ['Android Studio.app'], linuxCommands: ['android-studio', 'studio', 'studio.sh'], toolbox: ['AndroidStudio', 'android-studio'] }
]

// A fixed script reads registration data, never executable command lines. UTF-8
// JSON preserves custom installation paths containing Chinese characters.
const registryScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$records = @(
  foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
    Get-ChildItem -LiteralPath $root | ForEach-Object {
      if ($_.PSChildName -match '^(Code|Code - Insiders|Cursor|Windsurf|TRAE|Trae CN|VSCodium|Zed|sublime_text|notepad\\+\\+|idea(?:64)?|webstorm(?:64)?|pycharm(?:64)?|goland(?:64)?|rider(?:64)?|clion(?:64)?|rustrover(?:64)?|studio(?:64)?)\\.exe$') {
        [pscustomobject]@{kind='app-path';name=$_.PSChildName;executable=$_.GetValue('');location=$_.GetValue('Path')}
      }
    }
  }
  foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
    Get-ChildItem -LiteralPath $root | ForEach-Object {
      $name = $_.GetValue('DisplayName')
      if ($name -match 'Visual Studio Code|^Cursor|^Windsurf|^TRAE|^VSCodium|^Zed|^Sublime Text|^Notepad\\+\\+|IntelliJ IDEA|WebStorm|PyCharm|GoLand|Rider|CLion|RustRover|Android Studio') {
        [pscustomobject]@{kind='uninstall';name=$name;executable=$_.GetValue('DisplayIcon');location=$_.GetValue('InstallLocation')}
      }
    }
  }
)
ConvertTo-Json -InputObject $records -Depth 3 -Compress
`

export function parseOpenWithRegistry(value: string): OpenWithRegistryEntry[] {
  try {
    const parsed: unknown = JSON.parse(value.replace(/^\uFEFF/, '').trim())
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(entry => entry && typeof entry === 'object' &&
      (entry.kind === 'app-path' || entry.kind === 'uninstall') && typeof entry.name === 'string'
      ? [{ kind: entry.kind, name: entry.name, ...(typeof entry.executable === 'string' ? { executable: entry.executable } : {}),
          ...(typeof entry.location === 'string' ? { location: entry.location } : {}) }] : [])
  } catch { return [] }
}

let registryCache: { until: number; request: Promise<OpenWithRegistryEntry[]> } | undefined
function readWindowsRegistry(): Promise<OpenWithRegistryEntry[]> {
  if (registryCache && Date.now() < registryCache.until) return registryCache.request
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (!root || !path.win32.isAbsolute(root)) return Promise.resolve([])
  const executable = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const request = new Promise<OpenWithRegistryEntry[]>(resolve => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', registryScript], {
      windowsHide: true, encoding: 'utf8', timeout: 4000, maxBuffer: 2 * 1024 * 1024
    }, (error, stdout) => resolve(error ? [] : parseOpenWithRegistry(stdout)))
  })
  // Menu hover and its subsequent click share registry discovery, but every
  // detection still stats the executable so uninstalling an app fails safely.
  registryCache = { until: Date.now() + 10_000, request }
  return request
}

const nativeEnvironment: OpenWithEnvironment = {
  platform: process.platform, env: process.env, home: homedir(),
  isFile: async file => { try { return (await stat(file)).isFile() } catch { return false } },
  readDirectories: async directory => {
    try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse().slice(0, 100) }
    catch { return [] }
  },
  readRegistry: readWindowsRegistry
}

/** Known desktop IDEs only: no recursive disk search and no executable paths supplied by the renderer. */
export async function detectOpenWithApplications(context = nativeEnvironment): Promise<OpenWithInstallation[]> {
  const windows = context.platform === 'win32', paths = windows ? path.win32 : path.posix
  const env = (key: string): string | undefined => {
    const name = Object.keys(context.env).find(name => windows ? name.toLowerCase() === key.toLowerCase() : name === key)
    return name ? context.env[name] : undefined
  }
  const expand = (value: string): string => value.replace(/%([^%]+)%/g, (match, key: string) => env(key) ?? match)
  const absolute = (value: string | undefined): string | undefined => {
    const clean = value ? expand(value).trim().replace(/^"(.*)"$/, '$1') : ''
    return clean && !/[\u0000-\u001f]/.test(clean) && paths.isAbsolute(clean) ? paths.normalize(clean) : undefined
  }
  const dirs = (env('PATH') ?? '').split(windows ? ';' : ':').map(absolute).filter((item): item is string => Boolean(item))
  const first = async (candidates: string[]): Promise<string | undefined> => {
    for (const candidate of new Set(candidates)) if (await context.isFile(candidate)) return candidate
    return undefined
  }
  const explorer: OpenWithInstallation = { app: { id: 'file-explorer', label: '项目目录', available: true } }
  const install = (app: DeveloperApplication, executable: string, applicationPath?: string): OpenWithInstallation => ({
    app: { id: app.id, label: app.id === 'trae' && /(?:^|[\\/])trae cn\.(?:exe|app)$/i.test(applicationPath ?? executable) ? 'Trae CN' : app.label, available: true },
    command: { executable, kind: applicationPath ? 'mac-app' : app.kind, ...(applicationPath ? { applicationPath } : {}) }
  })

  if (windows) {
    const local = absolute(env('LOCALAPPDATA'))
    const roots = [...new Set([env('ProgramW6432'), env('ProgramFiles'), env('ProgramFiles(x86)'),
      local && paths.join(local, 'Programs'), local].map(absolute).filter((item): item is string => Boolean(item)))]
    const scanRoots = [...new Set(roots.flatMap(root => [root, paths.join(root, 'JetBrains')]))]
    const directories = new Map<string, string[]>()
    const [registry] = await Promise.all([
      context.readRegistry?.().catch(() => []) ?? Promise.resolve([]),
      Promise.all(scanRoots.map(async root => directories.set(root, (await context.readDirectories?.(root) ?? []).slice(0, 100))))
    ])
    const toolboxRoot = local ? paths.join(local, 'JetBrains', 'Toolbox', 'apps') : undefined
    const found = await Promise.all(developerApplications.map(async app => {
      const candidates: string[] = []
      const at = (directory: string): void => { for (const file of app.executables) candidates.push(paths.join(directory, file), paths.join(directory, 'bin', file)) }
      for (const entry of registry) {
        const matches = entry.kind === 'app-path'
          ? app.executables.some(name => name.toLowerCase() === entry.name.toLowerCase())
          : app.registryName.test(entry.name)
        if (!matches) continue
        // DisplayIcon may include an icon index; reject commands/arguments after the executable.
        const match = entry.executable?.trim().match(/^(?:"([^"]+\.exe)"|(.+\.exe))(?:,\s*-?\d+)?$/i)
        const executable = absolute(match?.[1] ?? match?.[2])
        if (executable && app.executables.some(name => name.toLowerCase() === paths.basename(executable).toLowerCase())) candidates.push(executable)
        const location = absolute(entry.location)
        if (location) at(location)
      }
      for (const root of roots) for (const folder of app.folders) at(paths.join(root, folder))
      for (const directory of dirs) { at(directory); for (const file of app.executables) candidates.push(paths.join(directory, '..', file)) }
      if (app.kind === 'jetbrains') {
        for (const [root, children] of directories) for (const child of children) {
          if (app.folders.some(folder => child.toLowerCase() === folder.toLowerCase() || child.toLowerCase().startsWith(folder.toLowerCase() + ' '))) at(paths.join(root, child))
        }
        // Toolbox uses either a direct product directory or product/channel/version.
        if (toolboxRoot) for (const alias of app.toolbox ?? []) {
          const product = paths.join(toolboxRoot, alias)
          at(product)
          for (const channel of (await context.readDirectories?.(product) ?? []).slice(0, 10)) {
            const branch = paths.join(product, channel); at(branch)
            if (/^ch-\d+$/.test(channel)) for (const version of (await context.readDirectories?.(branch) ?? []).slice(0, 10)) at(paths.join(branch, version))
          }
        }
      }
      const executable = await first(candidates)
      return executable ? install(app, executable) : undefined
    }))
    return [...found.filter((item): item is OpenWithInstallation => Boolean(item)), explorer]
  }

  const found = await Promise.all(developerApplications.map(async app => {
    if (context.platform === 'darwin') {
      for (const base of ['/Applications', paths.join(context.home, 'Applications')]) for (const bundle of app.macBundles) {
        const applicationPath = paths.join(base, bundle)
        if (await context.isFile(paths.join(applicationPath, 'Contents', 'Info.plist')) && await context.isFile('/usr/bin/open')) {
          return install(app, '/usr/bin/open', applicationPath)
        }
      }
    }
    const executable = await first(dirs.flatMap(directory => app.linuxCommands.map(name => paths.join(directory, name))))
    return executable ? install(app, executable) : undefined
  }))
  return [...found.filter((item): item is OpenWithInstallation => Boolean(item)), explorer]
}

export function openWithLaunchArguments(kind: LaunchKind, directory: string, applicationPath?: string): string[] {
  switch (kind) {
    case 'vscode': case 'sublime': return ['--new-window', directory]
    case 'zed': return ['--new', directory]
    case 'notepad-plus-plus': return ['-openFoldersAsWorkspace', directory]
    case 'jetbrains': return [directory]
    case 'mac-app': {
      if (!applicationPath) throw new Error('应用路径不可用')
      return ['-a', applicationPath, directory]
    }
  }
}

export function launchOpenWithApplication(installation: OpenWithInstallation, directory: string): Promise<void> {
  const command = installation.command
  if (!command) return Promise.reject(new Error('此打开方式不可用'))
  const launched = new Promise<void>((resolve, reject) => {
    // This is an explicit request to show an editor. SW_HIDE also suppresses
    // Electron GUI windows on Windows, even when the editor starts normally.
    const child = spawn(command.executable, openWithLaunchArguments(command.kind, directory, command.applicationPath), {
      cwd: directory, detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false, windowsHide: false,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_INSPECT_RESUME_ON_START'].includes(name.toUpperCase())))
    })
    let settled = false, stderr = '', timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      error ? reject(error) : resolve()
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data: string) => {
        if (!settled) stderr = (stderr + data).slice(-4096)
      })
      // Continue draining without keeping Aether alive or closing the editor's
      // stderr underneath it after the short startup observation window.
      if ('unref' in child.stderr && typeof child.stderr.unref === 'function') child.stderr.unref()
    }
    child.once('error', error => finish(new Error(`无法打开 ${installation.app.label}：${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) { finish(); return } // Existing editor instances may accept and forward this request.
      const detail = stderr.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().slice(-1000)
      finish(new Error(`无法打开 ${installation.app.label}：程序启动后退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}）${detail ? `\n${detail}` : ''}`))
    })
    child.once('spawn', () => {
      child.unref()
      // spawn only confirms CreateProcess succeeded; native loader/CLI errors
      // can still terminate the process immediately afterwards.
      timer = setTimeout(() => finish(), 1500)
    })
  })
  return launched.then(async () => {
    if (process.platform === 'win32' && installation.app.id === 'vscode') await recoverHiddenVSCodeWindow(command.executable, directory)
  })
}
