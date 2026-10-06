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
import { startRemoteTsLsp, startTsLsp, stopTsLsp } from './ts-client'
import { getEngineSource, isEngineReady, isRemoteEngine, subscribeEngineSource } from '../engine/source'

let wired = false
/** 当前 LSP 服务绑定的工作区根；换根需要停旧起新 */
let activeRoot: string | null = null
let activeMode: 'local' | 'remote' | null = null
/**
 * Engine identity the active language-service session was opened against.
 *
 * The workspace root and local/remote mode can stay the same while a remote
 * engine reconnects (or an embedded engine restarts).  In that case the old
 * LSP session belongs to a dead engine and must be recreated explicitly.
 */
let activeEngineGeneration: number | null = null

/** 工作区根变化 → 同步 LSP 服务：换根先停旧的再按新根启动 */
function syncWithWorkspace(): void {
  const root = getWorkspaceState().root
  const mode = isRemoteEngine() ? 'remote' : 'local'
  const engineGeneration = getEngineSource()
  if (root === activeRoot && mode === activeMode && engineGeneration === activeEngineGeneration) return
  const sourceChanged = activeEngineGeneration !== null && engineGeneration !== activeEngineGeneration
  activeRoot = root
  activeMode = mode
  activeEngineGeneration = engineGeneration

  // A reconnect keeps the same root and mode, so startRemoteTsLsp/startTsLsp
  // would otherwise see a matching running session and return early.  Stop
  // the old transport first, then start only if no newer transition superseded
  // this one while the asynchronous teardown was in flight.
  const startCurrent = (): void => {
    if (activeRoot !== root || activeMode !== mode || activeEngineGeneration !== engineGeneration) return
    if (mode === 'remote') { if (root && isEngineReady()) void startRemoteTsLsp(root); else if (!root) void stopTsLsp() }
    else if (!root) void stopTsLsp()
    else void startTsLsp(root, '')
  }
  if (sourceChanged) {
    // Even if the old transport reports a teardown error, still attempt to
    // open the current engine session.  startInternal/startRemoteInternal can
    // perform their own cleanup, while skipping the restart would leave the
    // editor without language features after a transient disconnect.
    void stopTsLsp().then(startCurrent, startCurrent)
    return
  }
  // The embedded TypeScript language server speaks a local stdio protocol and
  // cannot see a remote workspace. Remote diagnostics are provided by the
  // engine's /lsp/diagnose endpoint; keeping a local server here would produce
  // misleading errors against the client's filesystem.
  startCurrent()
}

/** 挂接 LSP 生命周期到工作区变化。幂等。 */
export function wireTsLsp(): void {
  if (wired) return
  wired = true
  // 首次：工作区可能已打开（启动时恢复了 lastFolder），直接同步一次
  syncWithWorkspace()
  onWorkspaceChanged(syncWithWorkspace)
  // Engine mode can change without the workspace changing. Re-evaluate the
  // language-service track on every connection identity transition.
  subscribeEngineSource(syncWithWorkspace)
}
