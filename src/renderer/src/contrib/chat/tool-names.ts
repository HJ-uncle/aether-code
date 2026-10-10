import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { commandInvocation } from '@renderer/core/engine/tool-feedback'
export { toolDisplayName } from '@renderer/core/engine/tool-labels'

/**
 * 参数摘要与路径展示。中文名称由 core/engine/tool-labels 统一提供，
 * 避免聊天、审批和导出分别维护映射而遗漏新增工具。
 */

/** 参数摘要优先取的键（按常见工具入参排序） */
const SUMMARY_KEYS = [
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'task',
  'question',
  'title',
  'skill',
  'name',
  'id'
]

/**
 * 从工具参数 JSON 里提取文件路径（path / filePath / file），供「点击打开」使用。
 * 只认明确的文件路径键，command/url 等不会误判成文件。非法 JSON 返回 null。
 */
export function toolPathArg(argsJson: string): string | null {
  if (!argsJson) return null
  try {
    const args: unknown = JSON.parse(argsJson)
    if (!args || typeof args !== 'object') return null
    const record = args as Record<string, unknown>
    for (const key of ['path', 'filePath', 'file']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
  } catch {
    // 截断中的流式参数不是合法 JSON：没有路径可点，静默跳过
  }
  return null
}

/**
 * 从工具参数 JSON 里提取一行人类可读的摘要（如文件路径 / 命令）。
 * args 不是合法 JSON（截断或格式化过）时退回原文首行。
 */
export function toolParamSummary(argsJson: string): string {
  if (!argsJson) return ''
  const command = commandInvocation(argsJson)
  if (command) return condense(command)
  try {
    const args: unknown = JSON.parse(argsJson)
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>
      for (const key of SUMMARY_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value) return condense(relativize(value))
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      }
      return ''
    }
    if (typeof args === 'string') return condense(args)
  } catch {
    // fallthrough
  }
  return condense(argsJson)
}

/** 压成单行并截断到 96 字符 */
function condense(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 96 ? `${oneLine.slice(0, 96)}…` : oneLine
}

/**
 * 绝对路径裁成相对工作区根的路径：参数里的 `D:\dev\aether-code\package.json`
 * 在摘要行显示为 `package.json`；不在工作区内的路径原样保留。
 * 分隔符与盘符大小写都归一后比较（Windows 不区分大小写、两向斜杠混用）。
 */
function relativize(value: string): string {
  const root = getWorkspaceState().root
  if (!root) return value
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const v = norm(value)
  const r = norm(root)
  if (v === r) return '.'
  if (v.startsWith(`${r}/`)) return value.replace(/\\/g, '/').replace(/\/+$/, '').slice(r.length + 1)
  return value
}
