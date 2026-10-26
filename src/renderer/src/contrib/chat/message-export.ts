import type { ChatMessage } from '@renderer/core/engine/useChat'
import { exportCommandJob } from '@renderer/core/engine/command-job-state'
import { exportSubagentDetails, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { exportToolDiagnostics } from '@renderer/core/engine/tool-feedback'
import { toolDisplayName, toolParamSummary } from './tool-names'
import { userMessageText } from './mention-context'

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
            const summary = tool.args ? toolParamSummary(tool.args) : ''
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
        parts.push(`\n${message.role === 'user' ? userMessageText(message.content) : message.content}`)
      }
      return parts.join('\n')
    })
    .join('\n\n---\n\n')
}
