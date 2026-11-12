/**
 * 渲染进程启动引导
 *
 * 在挂载 React 之前完成贡献注册与快捷键安装，保证首帧渲染时
 * 视图与命令已经就位（否则 ActivityBar 会先渲染成空列表再抖动一下）。
 */
import { registerContributions } from './contrib'
import { installKeybindingDispatcher } from './core/platform/keybindings'
import { installHorizontalWheelScrolling } from './core/platform/horizontal-scroll'
import { wireBrowserConnection } from './core/browser/connection'
import { wireBrowserPresentation } from './core/browser/presentation'

/**
 * Monaco's native quick-input hover list rejects its pending Delayer when the
 * picker is disposed. That cancellation is expected during a fast close, but
 * Monaco 0.56 leaves the rejection unhandled. Keep it from surfacing as a
 * renderer error while preserving every other unhandled rejection.
 */
function installMonacoCancellationGuard(): () => void {
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as { name?: unknown; message?: unknown } | null
    if (reason?.name === 'Canceled' && reason?.message === 'Canceled') event.preventDefault()
  }
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  return () => window.removeEventListener('unhandledrejection', onUnhandledRejection)
}

/** Remove only storage owned by the retired Code surface.
 * Work state, shared editor layout and engine records intentionally stay put:
 * this is a namespace cleanup, not a reset of the user's workspace. */
function clearRetiredCodeStorage(): void {
  const prefixes = ['aether.code-queue-command.v1:']
  try {
    localStorage.removeItem('aether.app.mode')
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key && prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key)
    }
  } catch { /* Storage may be unavailable during a restricted bootstrap. */ }
}

export function bootstrapRenderer(): () => void {
  clearRetiredCodeStorage()
  const disposeBrowserPresentation = wireBrowserPresentation()
  const disposeMonacoCancellationGuard = installMonacoCancellationGuard()
  const disposeContributions = registerContributions()
  const disposeKeybindings = installKeybindingDispatcher()
  const disposeHorizontalScrolling = installHorizontalWheelScrolling()

  const disposeBrowserConnection = wireBrowserConnection()

  return () => {
    disposeBrowserPresentation()
    disposeMonacoCancellationGuard()
    disposeContributions()
    disposeKeybindings()
    disposeHorizontalScrolling()
    disposeBrowserConnection()
  }
}
