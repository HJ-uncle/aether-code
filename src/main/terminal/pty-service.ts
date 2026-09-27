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
import type { TerminalCreateInput, TerminalExitInfo } from '@shared/ipc'

const terminals = new Map<string, IPty>()

function pickShell(): { file: string; args: string[] } {
  if (platform() === 'win32') {
    // pwsh（PowerShell 7）若可用则优先，退回系统自带 powershell
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['--login'] }
}

export function createTerminal(
  input: TerminalCreateInput,
  onData: (id: string, chunk: string) => void,
  onExit: (info: TerminalExitInfo) => void
): { id: string } {
  const id = randomUUID()
  const { file, args } = pickShell()
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd && input.cwd.length > 0 ? input.cwd : homedir(),
    env: process.env as Record<string, string>
  })

  pty.onData((chunk) => onData(id, chunk))
  pty.onExit(({ exitCode }) => {
    // 已被 dispose 的会话不再上报退出，避免渲染层误标「已退出」
    if (terminals.get(id) !== pty) return
    terminals.delete(id)
    onExit({ id, exitCode })
  })
  terminals.set(id, pty)
  return { id }
}

export function writeTerminal(id: string, data: string): void {
  terminals.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  // 尺寸过小（如隐藏后再显示的瞬间）不转发，ConPTY 有最小尺寸限制
  if (cols <= 0 || rows <= 0) return
  terminals.get(id)?.resize(cols, rows)
}

export function disposeTerminal(id: string): void {
  const pty = terminals.get(id)
  if (!pty) return
  terminals.delete(id)
  // kill 可能抛异常（进程已退出），不影响主流程
  try {
    pty.kill()
  } catch {
    // 忽略
  }
}

/** 应用退出时回收全部 shell，不留孤儿进程 */
export function disposeAllTerminals(): void {
  for (const id of [...terminals.keys()]) disposeTerminal(id)
}
