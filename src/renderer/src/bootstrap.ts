/**
 * 渲染进程启动引导
 *
 * 在挂载 React 之前完成贡献注册与快捷键安装，保证首帧渲染时
 * 视图与命令已经就位（否则 ActivityBar 会先渲染成空列表再抖动一下）。
 */
import { registerContributions } from './contrib'
import { installKeybindingDispatcher } from './core/platform/keybindings'
import { restoreLastFolder } from './core/workspace/workspace-store'
import { wireWorkspaceLiveSync } from './core/workspace/live-sync'
import { wireTsLsp } from './core/lsp/lifecycle'

export function bootstrapRenderer(): () => void {
  const disposeContributions = registerContributions()
  const disposeKeybindings = installKeybindingDispatcher()

  // TS 语言服务跟随工作区启动/停止。监听必须在 restoreLastFolder 之前注册：
  // 后者是异步的，完成后才触发工作区变化回调，先注册就不会漏掉首次启动
  wireTsLsp()
  const disposeWorkspaceLiveSync = wireWorkspaceLiveSync()
  void restoreLastFolder()

  return () => {
    disposeContributions()
    disposeKeybindings()
    disposeWorkspaceLiveSync()
  }
}
