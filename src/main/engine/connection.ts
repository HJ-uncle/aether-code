import type { AppSettings, EngineConnectionInput, EngineSnapshot } from '../../shared/ipc'
import { getSettings, updateSettings, workspaceRootForConnection } from '../settings-store'
import { engineHost } from './host'
import { validateRemoteInstanceToken } from './protocol'
import { withRemoteAuthChange } from './remote-auth'
import { remoteAuthTarget, validateRemoteAuth } from './remote-auth-contract'
import { probeRemoteConnection } from './remote-probe'
import { assertRemoteTokenTargetChange, withRemoteInstanceTokenChange } from './remote-token'
import { requireLocalRuntime } from './runtime'
import { sameRemoteService } from '../../shared/remote-service-url'

export const connectionKeys = ['engineMode', 'preferredPort', 'remoteBaseUrl', 'remoteWorkspaceRoot', 'autoStartEngine'] as const
type ConnectionPreferences = Pick<AppSettings, typeof connectionKeys[number]>
type NormalizedInput = EngineConnectionInput & { remoteWorkspaceRoot: string }

/** Generic settings IPC must preserve the difference between a partial edit and an explicitly supplied path. */
export function connectionInputForSettings(saved: AppSettings, patch: Partial<AppSettings>): EngineConnectionInput {
  const { engineMode, preferredPort, remoteBaseUrl, autoStartEngine } = { ...saved, ...patch }
  const input: EngineConnectionInput = { engineMode, preferredPort, remoteBaseUrl, autoStartEngine }
  if (patch.remoteWorkspaceRoot !== undefined) input.remoteWorkspaceRoot = patch.remoteWorkspaceRoot
  return input
}
interface PendingChange { controller: AbortController; committed: boolean }
let pending: PendingChange | null = null
const cancelled = (): Error => new Error('已取消连接。')

export function assertEngineConnectionAvailable(): void {
  if (pending) throw new Error('正在处理引擎连接，请先等待完成或取消连接。')
}
export function cancelPendingEngineConnection(): void {
  pending?.controller.abort(cancelled())
}
export function stopEngineConnection(): Promise<EngineSnapshot> {
  const change = pending
  if (change) {
    cancelPendingEngineConnection()
    // A preflight never owned the current engine; stopping it here would disconnect A.
    if (!change.committed) {
      engineHost.setCheckingConnection(false)
      return Promise.resolve(engineHost.getSnapshot())
    }
  }
  return engineHost.stop()
}

function normalize(input: EngineConnectionInput, saved: AppSettings): NormalizedInput {
  if (!input || (input.engineMode !== 'remote' && input.engineMode !== 'embedded') ||
      typeof input.remoteBaseUrl !== 'string' || typeof input.autoStartEngine !== 'boolean' ||
      !Number.isInteger(input.preferredPort) || input.preferredPort < 1 || input.preferredPort > 65535 ||
      (input.instanceToken !== undefined && typeof input.instanceToken !== 'string')) throw new Error('引擎连接设置无效。')
  let url = input.remoteBaseUrl.trim()
  if (input.engineMode === 'remote') {
    try { url = remoteAuthTarget(url) }
    catch { throw new Error('请输入有效的 HTTP 或 HTTPS 服务地址，地址中不能包含账号、密码、查询参数或片段。') }
  } else {
    if (input.instanceToken !== undefined || input.userCredential !== undefined) throw new Error('本机引擎不使用外部服务凭据。')
    // Selecting local must also work with an invalid, dormant legacy remote preference.
    url = saved.remoteBaseUrl
  }
  assertRemoteTokenTargetChange(url)
  return {
    engineMode: input.engineMode, preferredPort: input.preferredPort, remoteBaseUrl: url,
    remoteWorkspaceRoot: workspaceRootForConnection(input.engineMode, url, input.remoteWorkspaceRoot), autoStartEngine: input.autoStartEngine,
    instanceToken: input.instanceToken === undefined ? undefined : validateRemoteInstanceToken(input.instanceToken),
    userCredential: input.userCredential == null ? input.userCredential : validateRemoteAuth(input.userCredential)
  }
}

/** Settings and both encrypted overrides commit together; no secret is included in public preferences. */
function save(input: NormalizedInput): void {
  const { instanceToken, userCredential, ...preferences } = input
  const persist = (): void => {
    const current = getSettings()
    if (connectionKeys.some(key => current[key] !== preferences[key])) updateSettings(preferences satisfies ConnectionPreferences)
  }
  const withAuth = (): void => withRemoteAuthChange(input.remoteBaseUrl, userCredential, persist)
  if (instanceToken === undefined) withAuth()
  else withRemoteInstanceTokenChange(input.remoteBaseUrl, instanceToken, withAuth)
}

// Saving the launch toggle must also work when the selected service is offline or its package is missing.
function startupPreferenceOnly(input: EngineConnectionInput, saved: AppSettings): boolean {
  return !!input && typeof input.autoStartEngine === 'boolean' && input.autoStartEngine !== saved.autoStartEngine &&
    input.engineMode === saved.engineMode && input.preferredPort === saved.preferredPort &&
    (input.remoteBaseUrl === saved.remoteBaseUrl || (saved.engineMode === 'remote' && typeof input.remoteBaseUrl === 'string' && sameRemoteService(input.remoteBaseUrl, saved.remoteBaseUrl))) &&
    (input.remoteWorkspaceRoot === undefined || input.remoteWorkspaceRoot === saved.remoteWorkspaceRoot) &&
    input.instanceToken === undefined && input.userCredential === undefined
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function startLocal(saved: AppSettings, snapshot: EngineSnapshot, signal: AbortSignal): Promise<void> {
  const previous = saved.engineMode === 'remote' && snapshot.mode === 'remote' && snapshot.phase === 'ready' &&
    sameRemoteService(saved.remoteBaseUrl, snapshot.baseUrl) ? { url: snapshot.baseUrl, root: engineHost.remoteWorkspaceRoot } : null
  let disconnected = false
  try {
    if (snapshot.phase !== 'idle') await engineHost.stop()
    disconnected = true
    signal.throwIfAborted()
    const next = await engineHost.start('embedded', '', '', false, undefined, signal)
    signal.throwIfAborted()
    if (previous && next.phase !== 'ready') throw new Error(next.error || '本机引擎未就绪')
  } catch (cause) {
    signal.throwIfAborted() // An explicit stop owns the final state, even during recovery.
    if (!previous) throw cause
    const failure = (disconnected ? '本机引擎启动失败：' : '原服务未能正常断开：') + errorText(cause)
    try {
      // Other preferences can change during startup. Restore only this connection's original settings.
      updateSettings({ engineMode: saved.engineMode, remoteBaseUrl: saved.remoteBaseUrl,
        preferredPort: saved.preferredPort, autoStartEngine: saved.autoStartEngine })
    } catch (recovery) {
      throw new Error(failure + '；未能恢复原服务设置：' + errorText(recovery))
    }
    if (!disconnected) throw new Error(failure + '。原服务设置已恢复，请检查连接状态。')
    try {
      // Verify A again with its current credentials. Reconnecting cannot restore streams that already ended.
      const restored = await engineHost.start('remote', previous.url, previous.root, false, undefined, signal)
      signal.throwIfAborted()
      if (restored.phase !== 'ready' || restored.mode !== 'remote' || !sameRemoteService(restored.baseUrl, previous.url)) {
        throw new Error(restored.error || '原服务尚未就绪')
      }
    } catch (recovery) {
      signal.throwIfAborted()
      throw new Error(failure + '。原服务设置已恢复，但重新连接未成功：' + errorText(recovery))
    }
    throw new Error(failure + '。已重新连接原服务。')
  }
}

export async function applyEngineConnection(raw: EngineConnectionInput): Promise<EngineSnapshot> {
  assertEngineConnectionAvailable()
  const saved = getSettings(), snapshot = engineHost.getSnapshot()
  if (startupPreferenceOnly(raw, saved)) {
    updateSettings({ autoStartEngine: raw.autoStartEngine })
    return snapshot
  }
  const input = normalize(raw, saved)
  const remote = input.engineMode === 'remote'
  const sameLive = snapshot.phase === 'ready' && snapshot.mode === input.engineMode && (remote
    ? snapshot.baseUrl === input.remoteBaseUrl && engineHost.remoteWorkspaceRoot === input.remoteWorkspaceRoot
    : saved.preferredPort === input.preferredPort)
  if (sameLive && input.instanceToken === undefined && input.userCredential === undefined) {
    // A launch preference is independent of live transport: no probe, stream interruption or restart.
    save(input)
    return snapshot
  }
  const change: PendingChange = { controller: new AbortController(), committed: false }
  const { signal } = change.controller
  pending = change
  engineHost.setCheckingConnection(true)
  try {
    const proof = remote ? await probeRemoteConnection(input.remoteBaseUrl, input, signal) : null
    if (!remote) requireLocalRuntime()
    signal.throwIfAborted()
    save(input)
    change.committed = true
    if (proof) {
      await engineHost.startVerifiedRemote(proof, input.remoteWorkspaceRoot, signal)
    } else await startLocal(saved, snapshot, signal)
  } finally {
    if (pending === change) {
      pending = null
      engineHost.setCheckingConnection(false)
    }
  }
  // IPC callers and snapshot subscribers must see the same final state.
  return engineHost.getSnapshot()
}
