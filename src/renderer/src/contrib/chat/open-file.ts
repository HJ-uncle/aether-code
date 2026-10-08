import { activateDocument } from '@renderer/core/editor/editor-activation'
import { getEditorState, openFile, resolveDocumentPath } from '@renderer/core/editor/editor-store'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { getSnapshot } from '@renderer/core/engine/client'
import { resolveChatPath } from './chat-file-path'
import { getEngineSource, isRemoteEngine } from '@renderer/core/engine/source'
import { remoteWorkspaceContext } from '@renderer/core/workspace/fs-client'
import { assertWorkspaceTarget } from '@renderer/core/workspace/connection'
import { resolveArtifactPath, type ChatFileContext, type ChatLinkTarget } from './chat-link'

/**
 * 从聊天里打开文件：读进编辑器标签并激活，可带行号定位。
 *
 * 这是聊天视图（FileChangeCard / 工具行 / Markdown 链接）与编辑器之间
 * 唯一的通道 —— 对齐 wuzu-client 里「消息内点文件路径 → store.openFile()」
 * 的用法，但收口成一个函数，调用方不用关心激活与跳行的细节。
 *
 * 路径约定：
 * - 引擎/模型给的多是工作区相对路径（fileChange 帧、工具参数、正文里的
 *   反引号路径），用工作区根拼成绝对路径；
 * - 已是绝对路径（含盘符或 / 开头）则原样使用；
 * - 尾部可带 :line 或 :line:column（用户截图里 `file.ts:15` 这种写法）。
 */
export async function openFileFromChat(rawPath: string, context?: ChatFileContext): Promise<void> {
  if ((await getSnapshot()).mode === 'remote' || isRemoteEngine()) {
    const remote = await remoteWorkspaceContext()
    if (context && remote.sessionId !== context.sessionId) throw new Error('会话已经切换，请返回文件所属会话后重试。')
    const match = /:(\d+)(?::(\d+))?$/.exec(rawPath.trim())
    const pathText = (match ? rawPath.trim().slice(0, match.index) : rawPath).trim().replace(/^[`'"<]+|[`'">]+$/g, '')
    if (!pathText || pathText.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathText)) return
    const filePath = `${remote.root}/${pathText.replace(/^[/\\]+|[/\\]+$/g, '')}`
    await openFile(filePath, match ? Number(match[1]) : undefined, match?.[2] ? Number(match[2]) : undefined)
    activateDocument(filePath)
    return
  }
  const target = resolveChatPath(rawPath, context ? context.workspaceRoot ?? null : getWorkspaceState().root)
  if (!target) return
  await openFile(target.filePath, target.line, target.column)
  activateDocument(target.filePath)
}

/** A download URL names a session artifact, not a local path or a navigation URL. */
export async function openArtifactFromChat(target: Extract<ChatLinkTarget, { kind: 'artifact' }>, context: ChatFileContext): Promise<void> {
  if (target.sessionId !== context.sessionId) throw new Error('文件链接不属于当前消息会话。')
  const source = getEngineSource()
  const snapshot = await getSnapshot()
  if (source !== getEngineSource()) throw new Error('引擎连接已变化，请重试。')
  let root = context.workspaceRoot
  const remote = snapshot.mode === 'remote' || isRemoteEngine() ? await remoteWorkspaceContext() : null
  if (remote) {
    if (remote.sessionId !== target.sessionId) throw new Error('会话已经切换，请返回文件所属会话后重试。')
    assertWorkspaceTarget(remote.target)
    root = remote.root
  }
  const filePath = resolveDocumentPath(resolveArtifactPath(target.path, root))
  await openFile(filePath)
  if (source !== getEngineSource()) throw new Error('引擎连接已变化，请重试。')
  if (remote) assertWorkspaceTarget(remote.target)
  const error = getEditorState().docs.get(filePath)?.error
  if (error) throw new Error(error)
  activateDocument(filePath)
}
