import type { ToolActivity } from './useChat'
import { commandLogText, isCommandTool, parseCommandReceipts } from '@shared/command-receipt'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function argumentsRecord(args: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(args)) } catch { return undefined }
}

/** This is a readable invocation, not a shell command to execute or re-parse. */
export function commandInvocation(args: string): string | undefined {
  const input = argumentsRecord(args)
  if (typeof input?.command !== 'string' || !input.command) return undefined
  const argv = Array.isArray(input.args) && input.args.every(arg => typeof arg === 'string') ? input.args as string[] : []
  // This is display text, never re-executed shell input. Preserve script lines
  // and quotes instead of making users read JSON escape sequences.
  const display = (arg: string): string => /[\r\n]/.test(arg) ? `\n${arg}\n`
    : arg.includes('"') && !arg.includes("'") ? `'${arg}'` : !arg || /[\s"']/.test(arg) ? `"${arg}"` : arg
  return [input.command, ...argv.map(display)].join(' ')
}

function commandOutcome(tool: ToolActivity): { code?: string; exitCode?: number; signal?: string; message?: string } {
  const job = record(tool.commandJob ?? tool.metadata?.commandJob)
  const error = record(job?.error)
  const exitCode = job?.exitCode ?? tool.metadata?.exitCode
  const signal = job?.signal ?? tool.metadata?.signal
  return {
    code: typeof error?.code === 'string' ? error.code : tool.error,
    message: typeof error?.message === 'string' ? error.message : undefined,
    exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : undefined,
    signal: typeof signal === 'string' && signal ? signal : undefined
  }
}

/** A failing assertion is an executed command, whereas a spawn error never ran it. */
export function commandFailureLabel(tool: ToolActivity): string | undefined {
  if (tool.name !== 'execute_cmd' || tool.state !== 'error') return undefined
  const outcome = commandOutcome(tool)
  if (outcome.code === 'COMMAND_SPAWN_FAILED') return '命令未启动'
  if (outcome.code === 'COMMAND_TIMEOUT') return '命令已超时'
  if (outcome.code === 'COMMAND_EXIT_FAILED' || (!outcome.code && outcome.exitCode !== undefined && outcome.exitCode !== 0)) {
    if (outcome.signal) return `命令被信号 ${outcome.signal} 终止`
    return outcome.exitCode === undefined ? '命令退出非零' : `命令退出码 ${outcome.exitCode}`
  }
  return undefined
}

export function toolFailureMessage(tool: ToolActivity): string | undefined {
  const label = commandFailureLabel(tool)
  if (!label) return tool.error
  const outcome = commandOutcome(tool)
  return [label, outcome.code ? `（${outcome.code}）` : '', outcome.message ? `：${outcome.message}` : ''].join('')
}

/** Retain both the first failure context and the final compiler/assertion summary. */
export function boundToolOutput(text: string, maxChars = 12000): string {
  if (text.length <= maxChars) return text
  const marker = '\n…（输出过长，中间内容已省略；完整输出请在工具详情或命令输出中查看）…\n'
  const head = Math.floor((maxChars - marker.length) / 2)
  return text.slice(0, head) + marker + text.slice(-(maxChars - marker.length - head))
}

function outputBlock(text: string): string {
  const longestFence = Math.max(2, ...(text.match(/`+/g) ?? []).map(match => match.length))
  const fence = '`'.repeat(longestFence + 1)
  return `${fence}text\n${text}\n${fence}`
}

/** Copy/export must carry diagnostics, not just the machine-readable failure code. */
export function exportToolDiagnostics(tool: ToolActivity): string {
  const sections: string[] = []
  if (tool.name === 'execute_cmd') {
    const invocation = commandInvocation(tool.args)
    const cwd = argumentsRecord(tool.args)?.cwd ?? record(tool.metadata?.commandJob)?.cwd
    if (invocation) sections.push(`命令：${boundToolOutput(invocation, 4000)}`)
    if (typeof cwd === 'string' && cwd) sections.push(`工作目录：${cwd}`)
    const outcome = commandOutcome(tool)
    if (outcome.exitCode !== undefined) sections.push(`退出码：${outcome.exitCode}`)
    if (outcome.signal) sections.push(`信号：${outcome.signal}`)
  }
  const error = toolFailureMessage(tool)
  if (error) sections.push(`原因：${error}`)
  // Successful source reads can be huge; failed tools and command evidence matter in a report.
  if (tool.result && (isCommandTool(tool.name) || tool.state === 'error' || tool.state === 'cancelled' || tool.state === 'interrupted')) {
    const receipts = parseCommandReceipts(tool.result, tool.name)
    const output = receipts ? receipts.map((item, index) => {
      if (!('type' in item)) return `命令 ${index + 1} 读取失败：${item.error}`
      return [receipts.length > 1 ? `命令 ${index + 1}` : '',
        item.exitCode !== null ? `退出码：${item.exitCode}` : `状态：${item.status}`,
        item.signal ? `信号：${item.signal}` : '', item.notice ?? '',
        item.error ? item.error.message || item.error.code : '',
        item.truncated ? '较早的日志已超出保留范围。' : '',
        item.entries.map(entry => entry.text).join(''),
        item.hasMore ? '后续输出尚未读取，可在命令结果中继续读取。' : ''].filter(Boolean).join('\n')
    }).join('\n\n') : commandLogText(tool.result, tool.name, tool.metadata)
    sections.push(`输出：\n${outputBlock(boundToolOutput(output))}`)
  }
  return sections.join('\n\n')
}
