import { fileIdentity } from './file-identity'
import { ipcErrorMessage } from '../ipc-error'
import { toast } from '../toast'

/** 工作区外的文件保留绝对路径；不可把盘符大小写差异误判成工作区外。 */
export function relativeFilePath(root: string | null, filePath: string): string {
  if (!root) return filePath
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = filePath.replace(/\\/g, '/')
  const baseKey = fileIdentity(root).replace(/\/+$/, '')
  const fileKey = fileIdentity(normalized).replace(/\/+$/, '')
  if (fileKey === baseKey) return '.'
  return fileKey.startsWith(`${baseKey}/`) ? normalized.slice(base.length + 1) : filePath
}

export async function copyFilePaths(paths: readonly string[], root?: string | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(paths.map((path) =>
      root === undefined ? path : relativeFilePath(root, path)).join('\n'))
    toast.success(paths.length === 1 ? '路径已复制' : `已复制 ${paths.length} 个路径`)
  } catch (error) {
    toast.error(`复制路径失败：${ipcErrorMessage(error)}`)
  }
}

export async function revealFile(filePath: string): Promise<void> {
  try {
    await window.aether.fs.reveal(filePath)
  } catch (error) {
    toast.error(`无法在文件资源管理器中显示：${ipcErrorMessage(error)}`)
  }
}
