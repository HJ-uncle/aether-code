import type { ToolActivity } from '@renderer/core/engine/useChat'

export interface WorkToolFeedback {
  label: string
  detail: string
  kind: 'check' | 'command' | 'operation'
}

const COMMAND_TOOLS = new Set(['execute_cmd', 'exec_command', 'run_command', 'run_skill_script'])
const EXIT_CODES = new Set(['COMMAND_EXIT_FAILED', 'COMMAND_EXIT_NONZERO'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function inputOf(args: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(args)) } catch { return undefined }
}

function executable(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') ?? ''
}

/** Only explicit runner invocations establish a test. A filename, log line or
 * shell fragment mentioning tests is not evidence that a test runner executed. */
function testInvocation(command: unknown, args: unknown, wrapped = false): boolean {
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return false
  const name = executable(command), argv = args as string[]
  if (argv.some(arg => ['--help', '-h', '--version', '-V', '--listTests', '--collect-only'].includes(arg))) return false
  if (name === 'node' || name === 'nodejs') {
    if (argv.some(arg => ['-e', '--eval', '-p', '--print', '--run'].includes(arg) || /^(?:--(?:eval|print|run)=|-[ep].+)/.test(arg))) return false
    const index = argv.indexOf('--test')
    return index >= 0 && argv.slice(0, index).every(arg => arg.startsWith('-') &&
      !['--', '-e', '--eval', '-p', '--print', '--run'].includes(arg) && !/^--(?:eval|print|run)=/.test(arg))
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) return argv[0] === '-m' && ['pytest', 'unittest'].includes(argv[1])
  if (['pytest', 'py.test', 'jest', 'mocha', 'ava'].includes(name)) return true
  if (name === 'vitest') return argv[0] === 'run'
  if (['playwright', 'go', 'cargo', 'dotnet', 'bun', 'deno'].includes(name)) return argv[0] === 'test'
  if (['npm', 'pnpm', 'yarn'].includes(name)) {
    const script = argv[0] === 'run' ? argv[1] : argv[0]
    return typeof script === 'string' && /^test(?::[\w-]+)*$/.test(script)
  }
  return !wrapped && name === 'npx' && argv.length > 0 && !argv[0].startsWith('-') && testInvocation(argv[0], argv.slice(1), true)
}

function humanSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (/^[\[{]/.test(raw)) {
    try {
      const parsed = record(JSON.parse(raw))
      return parsed ? humanSummary(parsed.message ?? record(parsed.error)?.message) : undefined
    } catch { /* Incomplete structured output belongs in the original detail. */ }
    return undefined
  }
  const line = value.split(/\r?\n/).map(part => part.trim()).find(part => part &&
    !/^[\[\]{}"<`]/.test(part) && !/^at\s/.test(part) &&
    !/^[A-Z][A-Z0-9_.:-]*(?:\s+[A-Z][A-Z0-9_.:-]*)*$/.test(part.replace(/^(?:error|code|reason)[：:]\s*/i, '')))
  return line ? line.length > 140 ? `${line.slice(0, 137)}…` : line : undefined
}

/** Work describes the outcome of this step without changing the engine's
 * failure evidence or promoting a failed command into a failed root task. */
export function workToolFeedback(tool: ToolActivity, state = tool.state): WorkToolFeedback | null {
  if (state !== 'error' && state !== 'interrupted') return null
  const job = record(tool.commandJob) ?? record(tool.metadata?.commandJob)
  const error = record(job?.error) ?? record(tool.metadata?.error)
  const code = text(error?.code) ?? text(tool.metadata?.code) ?? text(tool.error)
  const exit = job && 'exitCode' in job ? job.exitCode : tool.metadata?.exitCode
  const exitCode = typeof exit === 'number' && Number.isInteger(exit) ? exit : undefined
  const signal = text(job && 'signal' in job ? job.signal : tool.metadata?.signal)
  const command = Boolean(job) || COMMAND_TOOLS.has(tool.name)
  const kind = command ? 'command' : 'operation'
  if (state === 'interrupted') return { label: '已中断', detail: command && signal
    ? `命令已中断，信号 ${signal}` : '这一步已中断，执行结果尚未确认', kind }
  if (command) {
    // Transport outcomes take precedence over a test entry point or a nonzero
    // exit: an unstarted or terminated runner did not report failed assertions.
    if (code === 'COMMAND_SPAWN_FAILED') return { label: '命令未启动', detail: '未能启动命令', kind }
    if (code === 'COMMAND_TIMEOUT' || job?.status === 'timed_out') return { label: '命令已超时', detail: '命令超过执行时限，已停止等待', kind }
    if (signal) return { label: '命令被终止', detail: `命令被信号 ${signal} 终止`, kind }
    if (EXIT_CODES.has(code ?? '') || exitCode !== undefined && exitCode !== 0) {
      const input = inputOf(tool.args)
      const check = testInvocation(job?.command ?? input?.command, job?.args ?? input?.args)
      return { label: check ? '测试未通过' : '命令未通过', kind: check ? 'check' : 'command',
        detail: `${check ? '测试' : '命令'}已结束，${exitCode === undefined ? '返回非零退出码' : `退出码 ${exitCode}`}` }
    }
  }
  return { label: '未完成', kind, detail: humanSummary(error?.message) ?? humanSummary(tool.error) ?? '这一步未完成' }
}
