/**
 * 引擎日志总线
 *
 * 主进程是唯一能拿到引擎 stdout/stderr 的地方，日志通过这里
 * 广播给渲染进程的输出面板，同时保留一份到终端（开发期排障用）。
 *
 * 之所以不用「劫持 console」的做法：引擎进程由本模块自己 spawn，
 * 日志本就经过我们手里，没必要再做全局 console 钩子。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface EngineLogEntry {
  level: LogLevel
  line: string
  ts: number
}

export type LogListener = (entry: EngineLogEntry) => void

const listeners = new Set<LogListener>()

export function onEngineLog(listener: LogListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 是否把引擎日志同步到主进程终端。
 *
 * 默认关闭：Windows 控制台默认代码页是 GBK，而引擎输出是 UTF-8，
 * 直接打到终端会显示成乱码（如「命中」→「鍛戒腑」）。
 * 这不是数据损坏 —— IDE 的输出面板通过 IPC 拿到的是正确的 JS 字符串，
 * 只是终端转码所致。默认不往终端打，避免误导；需要时用环境变量打开。
 */
const ECHO_TO_TERMINAL = process.env.AETHER_IDE_ECHO_ENGINE === '1'

export function emitLog(level: LogLevel, line: string): void {
  const entry: EngineLogEntry = { level, line, ts: Date.now() }

  if (ECHO_TO_TERMINAL) {
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    write(`[engine] ${line}`)
  }

  for (const listener of listeners) listener(entry)
}

export const logger = {
  info: (line: string): void => emitLog('info', line),
  warn: (line: string): void => emitLog('warn', line),
  error: (line: string): void => emitLog('error', line),
  /** 引擎 stdout */
  engine: (line: string): void => emitLog('info', line),
  /** 引擎 stderr */
  engineError: (line: string): void => emitLog('error', line)
}
