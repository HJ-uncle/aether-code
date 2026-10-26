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

const REDACTED = '[REDACTED]'

/**
 * Names which are allowed to carry credentials in an engine environment or in
 * a diagnostic line.  Keep this list deliberately broader than the two
 * desktop handshake variables: third-party model providers commonly use
 * slightly different names for the same secret.
 */
const SECRET_FIELD = '(?:authorization|cookie|password|passwd|secret|credential|token|api[_-]?key|session|csrf|xsrf|signature|encryption[_-]?key|private[_-]?key|aether[_-]?instance[_-]?token|aether[_-]?ide[_-]?remote[_-]?(?:instance[_-]?token|api[_-]?key|bearer[_-]?token)|aether[_-]?remote[_-]?(?:api[_-]?key|bearer[_-]?token)|key|auth)'
const SECRET_ENV_NAME = /(?:^|_)(?:authorization|cookie|password|passwd|secret|credential|token|api[_-]?key|session|csrf|xsrf|signature|encryption[_-]?key|private[_-]?key|key)(?:$|_)/i

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove credentials before an engine line reaches either the terminal echo
 * or the renderer IPC channel.  Engine code is third-party code and may log
 * its environment while booting, so matching only intentional application
 * log calls is insufficient.  Values from the effective child environment
 * are scrubbed first, then common textual forms are covered as a fallback.
 */
export function redactEngineLogLine(
  raw: string,
  environment: Record<string, string | undefined> = process.env
): string {
  let line = String(raw)
  const values = Object.entries(environment)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length)
  for (const value of values) line = line.replace(new RegExp(escaped(value), 'g'), REDACTED)

  line = line.replace(/((?:Bearer|Basic)\s+)[A-Za-z\d+/_.=~-]+/gi, `$1${REDACTED}`)
  line = line.replace(
    new RegExp(`((?:^|[^A-Za-z0-9_])(?:["']?)(?:${SECRET_FIELD})(?:["']?)\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s&,;}]+)`, 'gi'),
    `$1${REDACTED}`
  )
  line = line.replace(
    new RegExp(`([?&](?:${SECRET_FIELD})=)[^&#\\s]+`, 'gi'),
    `$1${REDACTED}`
  )
  return line
}

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
  const safeLine = redactEngineLogLine(line)
  const entry: EngineLogEntry = { level, line: safeLine, ts: Date.now() }

  if (ECHO_TO_TERMINAL) {
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    write(`[engine] ${safeLine}`)
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
