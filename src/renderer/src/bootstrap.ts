/**
 * 渲染进程启动引导
 *
 * 在挂载 React 之前完成贡献注册与快捷键安装，保证首帧渲染时
 * 视图与命令已经就位（否则 ActivityBar 会先渲染成空列表再抖动一下）。
 */
import { registerContributions } from './contrib'
import { installKeybindingDispatcher } from './core/platform/keybindings'
import { restoreLastFolder } from './core/workspace/workspace-store'

export function bootstrapRenderer(): () => void {
  const disposeContributions = registerContributions()
  const disposeKeybindings = installKeybindingDispatcher()

  // 恢复上次打开的工作区。放在 React 之外调用，避免 StrictMode 下重复执行。
  void restoreLastFolder()

  return () => {
    disposeContributions()
    disposeKeybindings()
  }
}
