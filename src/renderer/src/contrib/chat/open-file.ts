import { activateDocument } from '@renderer/core/editor/editor-activation'
import { openFile } from '@renderer/core/editor/editor-store'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { paths } from '@renderer/core/workspace/fs-client'

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
  const target = resolveChatPath(rawPath)
  if (!target) return
  await openFile(target.filePath, target.line, target.column)
  activateDocument(target.filePath)
}

interface ResolvedPath {
  filePath: string
  line?: number
  column?: number
}

/** 解析聊天里出现的文件路径：补工作区根、拆行号、归一化分隔符 */
function resolveChatPath(rawPath: string): ResolvedPath | null {
  let text = rawPath.trim()
  if (!text) return null
  // 去掉两侧的反引号/引号/尖括号：模型常把路径包在 `path` 或 <path> 里
  text = text.replace(/^[`'"<]+|[`'">]+$/g, '')
  if (!text) return null

  // 拆尾部行号：path:line 或 path:line:column（Windows 盘符 C:\ 只有一个冒号且后跟 \，不会误判）
  let line: number | undefined
  let column: number | undefined
  const lineMatch = /:(\d+)(?::(\d+))?$/.exec(text)
  if (lineMatch && !/^[A-Za-z]:$/.test(text.slice(0, 2))) {
    // 仅当冒号后是纯数字结尾才视为行号；且不能是盘符（C: 后必须还有内容才算）
    const before = text.slice(0, lineMatch.index)
    if (before && !/^[A-Za-z]$/.test(before)) {
      line = Number(lineMatch[1])
      column = lineMatch[2] ? Number(lineMatch[2]) : undefined
      text = before
    }
  }
  if (!text) return null

  const absolute = isAbsolutePath(text)
    ? text
    : ((): string => {
        const root = getWorkspaceState().root
        return root ? paths.join(root, text) : text
      })()

  if (!isAbsolutePath(absolute)) return null
  return { filePath: absolute, line, column }
}

/** 是否是绝对路径：Windows 盘符 / UNC / POSIX 根 */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/')
}
