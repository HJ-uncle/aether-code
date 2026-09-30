import { posix, win32 } from 'node:path'
import type { EngineSnapshot } from '../../shared/ipc'
import { remoteAttachmentsForRequest } from './remote-attachments'

/** Validate a path for the server OS without resolving it on the client machine. */
export function validateRemoteWorkspaceRoot(value: unknown): string {
  if (typeof value !== 'string') throw new Error('远端工作目录必须是字符串')
  const root = value.trim()
  if (!root) return ''
  const hasControlCharacter = Array.from(root).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  if (hasControlCharacter || (!posix.isAbsolute(root) && !win32.isAbsolute(root))) {
    throw new Error('远端工作目录必须是引擎所在机器的绝对路径，例如 /srv/project 或 D:\\project')
  }
  if (root.startsWith('\\') && !root.startsWith('\\\\')) {
    throw new Error('远端 Windows 工作目录必须包含盘符或完整 UNC 路径')
  }
  return root
}

/** Existing sessions keep the execution directory recorded by their server. */
export function selectRemoteWorkspacePaths(runs: unknown, configuredRoot: string): string[] {
  if (!Array.isArray(runs)) throw new Error('远端会话工作区记录无效')
  if (runs.length > 0) {
    const latest = runs[runs.length - 1] as { workspacePaths?: unknown } | null
    if (!latest || !Array.isArray(latest.workspacePaths)) throw new Error('远端会话缺少工作区记录')
    return latest.workspacePaths.map((path: unknown) => {
      const root = validateRemoteWorkspaceRoot(path)
      if (!root) throw new Error('远端会话工作区包含空路径')
      return root
    })
  }
  const root = validateRemoteWorkspaceRoot(configuredRoot)
  return root ? [root] : []
}

interface RemoteChatContext {
  baseUrl: string
  headers: Record<string, string>
  signal: AbortSignal
  configuredRoot: string
  target?: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
}

/** Never transfer the client's workspace, attachments or implicit local context to a server. */
export async function prepareRemoteChatBody(body: unknown, context: RemoteChatContext): Promise<Record<string, unknown>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('远端聊天请求无效')
  const input = body as Record<string, unknown>
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) throw new Error('远端聊天缺少会话 ID')
  if (input.message !== undefined && typeof input.message !== 'string') throw new Error('远端聊天消息必须是文本；文件请使用附件上传入口')
  const allowed = ['message', 'sessionId', 'agentId', 'model', 'subagentModel', 'utilityModel', 'thinkingMode', 'runId']
  const clean = Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  if (input.toolResponse !== undefined) {
    if (!input.toolResponse || typeof input.toolResponse !== 'object' || Array.isArray(input.toolResponse)) {
      throw new Error('远端审批响应无效')
    }
    const response = input.toolResponse as Record<string, unknown>
    const fields = ['runId', 'requestId', 'toolCallId', 'name', 'output']
    clean.toolResponse = Object.fromEntries(fields.filter(key => response[key] !== undefined).map(key => [key, response[key]]))
    // The server restores the immutable original request when answering an approval.
    return clean
  }
  const response = await fetch(`${context.baseUrl}/api/v1/chat/runs?${new URLSearchParams({ sessionId: input.sessionId })}`, {
    redirect: 'error',
    headers: { ...context.headers, Accept: 'application/json' },
    signal: context.signal
  })
  const result = await response.json() as { code?: number; message?: string; data?: { runs?: unknown } }
  if (!response.ok || (result.code !== 200 && result.code !== 0)) {
    throw new Error(`无法读取远端会话工作区：${result.message || `HTTP ${response.status}`}`)
  }
  context.signal.throwIfAborted()
  clean.workspacePaths = selectRemoteWorkspacePaths(result.data?.runs, context.configuredRoot)
  const attachments = context.target ? remoteAttachmentsForRequest(input.attachments, context.target, input.sessionId) : []
  if (attachments.length) clean.attachments = attachments
  return clean
}
