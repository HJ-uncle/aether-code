/**
 * 内置终端（node-pty）
 *
 * 主进程只负责「按 id 管理一组 pty 进程」，不感知标签页概念：
 * 会话的创建/切换/销毁由渲染层 store 决策，这里只做路由。
 * 窗口退出时统一回收（见 main/index.ts 的 before-quit）。
 */
import { spawn, type IPty } from 'node-pty'
import { homedir, platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dirname, delimiter, join, normalize, resolve } from 'node:path'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { TerminalCleanupError, TerminalCreateInput, TerminalExitInfo } from '@shared/ipc'
import { PtyLifecycle } from './pty-lifecycle'

interface TerminalSession { pty: IPty; lifecycle: PtyLifecycle; closing?: Promise<void> }
const terminals = new Map<string, TerminalSession>()

interface ShellSpec {
  file: string
  args: string[]
  env: Record<string, string>
  homeDir?: string
}

function envRecord(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function pathKey(value: string): string {
  return normalize(resolve(value)).replace(/[\\/]+$/, '').toLowerCase()
}

/** Remove only a foreign PowerShell installation's module directory. */
function filterForeignPowerShellModules(env: Record<string, string>, selectedFile: string): Record<string, string> {
  const raw = env.PSModulePath
  if (!raw) return env
  const selectedRoot = pathKey(dirname(selectedFile))
  const entries = raw.split(delimiter)
  const filtered = entries.filter((entry) => {
    const modulePath = entry.trim()
    if (!modulePath || !/[\\/]Modules$/i.test(modulePath)) return true
    const installRoot = dirname(modulePath)
    const hasPowerShellHost = existsSync(join(installRoot, 'pwsh.exe')) || existsSync(join(installRoot, 'powershell.exe'))
    return !hasPowerShellHost || pathKey(installRoot) === selectedRoot
  })
  if (filtered.length === entries.length) return env
  return { ...env, PSModulePath: filtered.join(delimiter) }
}

function findOnPath(executable: string): string | null {
  const pathValue = process.env.PATH ?? ''
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"|"$/g, '')
    if (!entry) continue
    const candidate = join(entry, executable)
    if (existsSync(candidate)) return resolve(candidate)
  }
  return null
}

/**
 * ConPTY hosts may run under a read-only profile (CI, managed sandboxes,
 * locked-down desktop profiles). Give PSReadLine a disposable writable home
 * in that case so its history attempt cannot block the first command.
 */
function ensurePowerShellProfile(env: Record<string, string>): { env: Record<string, string>; homeDir?: string } {
  const appData = env.APPDATA ?? join(env.USERPROFILE ?? homedir(), 'AppData', 'Roaming')
  const historyDir = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine')
  const historyFile = join(historyDir, 'ConsoleHost_history.txt')
  try {
    mkdirSync(historyDir, { recursive: true })
    accessSync(existsSync(historyFile) ? historyFile : historyDir, constants.W_OK)
    return { env }
  } catch {
    try {
      const homeDir = mkdtempSync(join(tmpdir(), 'aether-terminal-home-'))
      const fallbackAppData = join(homeDir, 'AppData', 'Roaming')
      mkdirSync(fallbackAppData, { recursive: true })
      return {
        homeDir,
        env: {
          ...env,
          USERPROFILE: homeDir,
          APPDATA: fallbackAppData,
          LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
          HOMEDRIVE: env.SystemDrive ?? 'C:',
          HOMEPATH: '\\'
        }
      }
    } catch {
      return { env }
    }
  }
}

function cleanupTemporaryHome(homeDir: string | undefined): void {
  if (!homeDir) return
  const expectedRoot = resolve(tmpdir())
  if (dirname(resolve(homeDir)) !== expectedRoot || !homeDir.split(/[\\/]/).at(-1)?.startsWith('aether-terminal-home-')) {
    throw new Error('Refusing terminal profile cleanup outside its temporary root')
  }
  rmSync(homeDir, { recursive: true, force: true })
}

function pickShell(): ShellSpec {
  const env = envRecord()
  if (platform() === 'win32') {
    const pwsh = findOnPath('pwsh.exe')
    if (pwsh) {
      const profile = ensurePowerShellProfile(env)
      return { file: pwsh, args: ['-NoLogo'], ...profile }
    }
    const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const file = existsSync(powershell) ? powershell : 'powershell.exe'
    const profile = ensurePowerShellProfile(filterForeignPowerShellModules(env, file))
    return { file, args: ['-NoLogo'], ...profile }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['--login'], env }
}

export function createTerminal(
  input: TerminalCreateInput,
  onData: (id: string, chunk: string) => void,
  onExit: (info: TerminalExitInfo) => void
): { id: string } {
  const id = randomUUID()
  const { file, args, env, homeDir } = pickShell()
  let pty: IPty
  try {
    pty = spawn(file, args, {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd && input.cwd.length > 0 ? input.cwd : homeDir ?? homedir(),
      env
    })
  } catch (error) {
    cleanupTemporaryHome(homeDir)
    throw error
  }

  const lifecyclePty: IPty & { onCleanup?: (listener: (event: { cleanupError?: TerminalCleanupError }) => void) => { dispose: () => void } } = pty
  const lifecycle = new PtyLifecycle(lifecyclePty, () => cleanupTemporaryHome(homeDir), event => {
    void disposeTerminal(id).then(() => onExit({ id, exitCode: event.exitCode }), error => {
      console.error(`[terminal] ${id} cleanup failed:`, error)
      const cleanupError = lifecycle.cleanupFailure ?? event.cleanupError ?? {
        code: 'PTY_CLEANUP_FAILED' as const,
        message: error instanceof Error ? error.message : String(error),
        errors: [{ phase: 'client-cleanup', code: 'PTY_CLEANUP_FAILED', name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }]
      }
      onExit({ id, exitCode: event.exitCode, reason: error instanceof Error ? error.message : String(error), cleanupError })
    })
  })
  terminals.set(id, { pty, lifecycle })
  pty.onData((chunk) => onData(id, chunk))
  return { id }
}

export function writeTerminal(id: string, data: string): void {
  const session = terminals.get(id)
  if (session?.lifecycle.stopped) throw new Error('终端正在关闭或已经退出')
  session?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  // 尺寸过小（如隐藏后再显示的瞬间）不转发，ConPTY 有最小尺寸限制
  if (cols <= 0 || rows <= 0) return
  const session = terminals.get(id)
  if (session?.lifecycle.stopped) throw new Error('终端正在关闭或已经退出')
  session?.pty.resize(cols, rows)
}

export function disposeTerminal(id: string): Promise<void> {
  const session = terminals.get(id)
  if (!session) return Promise.resolve()
  if (session.closing) return session.closing
  const closing = session.lifecycle.close().then(() => {
    if (terminals.get(id) === session) terminals.delete(id)
  }).finally(() => { if (session.closing === closing) session.closing = undefined })
  session.closing = closing
  return closing
}

/** 应用退出时回收全部 shell，不留孤儿进程 */
export async function disposeAllTerminals(): Promise<void> {
  const results = await Promise.allSettled([...terminals.keys()].map(disposeTerminal))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), '本地终端清理失败')
}
