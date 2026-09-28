/**
 * TS 语言服务生命周期（渲染进程）
 *
 * 挂在工作区上：打开/切换工作区根 → 启动 LSP；关闭工作区 → 停止。
 * 与 workspace-store 解耦成独立模块：store 只管状态，这里管副作用，
 * 避免 store 直接 import LSP 客户端（那会把 monaco 拉进 store 的依赖图）。
 *
 * 服务器入口路径在主进程里解析（require.resolve 只在主进程可用），
 * 渲染进程只传「工作区根」过去，主进程自己定位 typescript-language-server。
 */
import { getWorkspaceState, onWorkspaceChanged } from '../workspace/workspace-store'
import { startTsLsp, stopTsLsp } from './ts-client'

let wired = false
/** 当前 LSP 服务绑定的工作区根；换根需要停旧起新 */
let activeRoot: string | null = null

/** 工作区根变化 → 同步 LSP 服务：换根先停旧的再按新根启动 */
function syncWithWorkspace(): void {
  const root = getWorkspaceState().root
  if (root === activeRoot) return
  activeRoot = root
  if (root) void startTsLsp(root, '')
  else void stopTsLsp()
}

/** 挂接 LSP 生命周期到工作区变化。幂等。 */
export function wireTsLsp(): void {
  if (wired) return
  wired = true
  // 首次：工作区可能已打开（启动时恢复了 lastFolder），直接同步一次
  syncWithWorkspace()
  onWorkspaceChanged(syncWithWorkspace)
}
