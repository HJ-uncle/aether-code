/**
 * git 客户端（渲染层）
 *
 * 薄封装 window.aether.git。主进程直接调用 git，cwd 受工作区白名单限制。
 * 这里不做任何缓存与重试：git 调用是只读且便宜的，状态交给 git-store 统一持有。
 */
import type { GitCommit, GitStatus } from '@shared/ipc'

function bridge(): Window['aether'] {
  const api = window.aether
  if (!api) throw new Error('IPC 桥未就绪：preload 未加载')
  return api
}

export function gitStatus(root: string): Promise<GitStatus> {
  return bridge().git.status(root)
}

export function gitLog(root: string, limit?: number): Promise<GitCommit[]> {
  return bridge().git.log(root, limit)
}
