import type { ChatMessage } from '@renderer/core/engine/useChat'
import { exportCommandJob } from '@renderer/core/engine/command-job-state'
import { exportSubagentDetails, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { exportToolDiagnostics } from '@renderer/core/engine/tool-feedback'
import { toolDisplayName, toolParamSummary } from './tool-names'
import { mentionToken, userMessageDraft } from './mention-context'

export interface MessageExportDocumentOptions {
  /** The conversation title shown as the document heading. */
  title: string
  /** The task workspace, or null for a standalone conversation. */
  workspace?: string | null
  /** Number of complete conversation turns included in the document. */
  turnCount: number
  /** Injectable for deterministic tests; callers normally omit it. */
  exportedAt?: Date
}

function exportDate(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function singleLine(value: string, fallback: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim()
  return normalized || fallback
}

/**
 * Add the small amount of context needed when a selected Work conversation is
 * copied or downloaded. Keeping this separate from message serialization
 * preserves the existing message-level export format used by Code and by
 * individual message actions.
 */
export function buildMessageExportDocument(body: string, options: MessageExportDocumentOptions): string {
  if (!body.trim()) return ''
  const title = singleLine(options.title, '未命名会话')
  const workspace = singleLine(options.workspace ?? '', '独立任务')
  const turnCount = Math.max(0, Math.floor(options.turnCount))
  const lines = [
    `# ${title}`,
    '',
    `- 工作目录：${workspace}`,
    `- 导出时间：${exportDate(options.exportedAt ?? new Date())}`,
    `- 对话轮次：${turnCount}`,
    '',
    '---',
    '',
    body
  ]
  return lines.join('\n')
}

function exportedUserText(content: string): string {
  const draft = userMessageDraft(content)
  let text = '', cursor = 0
  for (const mention of draft.mentions) {
    if (!mention.attachmentId || mention.textOffset === undefined) continue
    const start = mention.textOffset
    text += draft.text.slice(cursor, start) + mention.displayText
    cursor = start + mentionToken(mention).length
  }
  return (text + draft.text.slice(cursor)).trimEnd()
}

/**
 * Serialize a set of chat messages in their supplied (usually chronological)
 * order.  Both Code and Work use the same readable Markdown representation so
 * a transcript copied from either surface has the same headings, tool status,
 * and diagnostic details.
 */
export function serializeMessages(selected: readonly ChatMessage[]): string {
  return selected
    .map((message) => {
      const parts: string[] = [message.role === 'user' ? '## 用户' : '## Agent']

      if (message.thinking) {
        parts.push(`<details>\n<summary>思考过程</summary>\n\n${message.thinking}\n\n</details>`)
      }

      if (message.role !== 'user') {
        const exportedTools = message.tools.filter((tool) => !tool.hidden)
        if (exportedTools.length > 0) {
          const toolLines = exportedTools.map((tool) => {
            const state = toolStatusLabel(tool)
            const summary = tool.args ? toolParamSummary(tool.args, tool.name) : ''
            const details = tool.commandJob
              ? exportCommandJob(tool.commandJob)
              : tool.name === 'subagent'
                ? exportSubagentDetails(tool)
                : exportToolDiagnostics(tool)
            return `- ${toolDisplayName(tool.name)}${summary ? `：${summary}` : ''}（${state}）${details ? `\n\n${details}\n` : ''}`
          })
          parts.push(`\n**工具调用**\n\n${toolLines.join('\n')}`)
        }
      }

      if (message.content) {
        // User messages may contain protocol/reference blocks that are only
        // useful to the engine; export the readable body instead.
        parts.push(`\n${message.role === 'user' ? exportedUserText(message.content) : message.content}`)
      }
      if (message.role === 'user' && message.attachments?.length) {
        parts.push(`\n**附件**\n\n${message.attachments.map(file =>
          `- ${file.referenceLabel ? `${file.referenceLabel}：` : ''}${file.name}（${file.path}）`).join('\n')}`)
      }
      return parts.join('\n')
    })
    .join('\n\n---\n\n')
}
