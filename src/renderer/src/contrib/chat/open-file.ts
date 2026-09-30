import { activateDocument } from '@renderer/core/editor/editor-activation'
import { openFile } from '@renderer/core/editor/editor-store'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { getSnapshot } from '@renderer/core/engine/client'
import { resolveChatPath } from './chat-file-path'

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
export async function openFileFromChat(rawPath: string): Promise<void> {
  // Remote records name another filesystem; matching local paths are unrelated files.
  if ((await getSnapshot()).mode === 'remote') return
  const target = resolveChatPath(rawPath, getWorkspaceState().root)
  if (!target) return
  await openFile(target.filePath, target.line, target.column)
  activateDocument(target.filePath)
}
