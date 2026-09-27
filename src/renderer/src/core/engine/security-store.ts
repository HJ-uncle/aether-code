/**
 * 会话安全模式共享状态
 *
 * 同一时刻可能有两处在显示「当前会话的模式」：对话底部的模式选择器，
 * 以及被拦截时授权卡片上的「一键放行」（它会把模式切成 full-access）。
 * 若各自持有 state，点完一键放行后选择器仍显示旧模式，用户会以为没生效，
 * 于是又去点一次确认 —— 正是要消除的那种反复。因此与 model-store 一样
 * 放在模块级 store 里：单点写入，多处订阅。
 *
 * 模式是会话级的（引擎按 tenant+sessionId 存在内存里），所以 state 必须带
 * sessionId：换会话时旧值立即失效，不能沿用。
 */
import { useSyncExternalStore } from 'react'
import { getSecurityMode, setSecurityMode, type SecurityMode } from './security'

export interface SecurityModeState {
  /** 当前 state 对应的会话；空串表示还没有会话 */
  sessionId: string
  mode: SecurityMode
  loading: boolean
  error: string | null
  /** 是否已按当前 sessionId 成功拉取过 */
  loaded: boolean
}

let state: SecurityModeState = {
  sessionId: '',
  mode: 'safe',
  loading: false,
  error: null,
  loaded: false
}
const listeners = new Set<() => void>()

function setState(patch: Partial<SecurityModeState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getSecurityModeState(): SecurityModeState {
  return state
}

export function onSecurityModeChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let inflight: Promise<void> | null = null

/** 拉取指定会话的安全模式。sessionId 变化时旧值立即作废，避免显示别的会话的模式。 */
export function refreshSecurityMode(sessionId: string): Promise<void> {
  if (!sessionId) {
    resetSecurityModeStore()
    return Promise.resolve()
  }

  if (state.sessionId !== sessionId) {
    setState({ sessionId, mode: 'safe', loaded: false, error: null, loading: true })
  } else {
    setState({ loading: true, error: null })
  }

  if (inflight) return inflight

  inflight = getSecurityMode(sessionId)
    .then((mode) => {
      // 请求期间可能已切走会话，迟到的结果不能覆盖新会话
      if (state.sessionId !== sessionId) return
      setState({ mode, loading: false, loaded: true, error: null })
    })
    .catch((err: unknown) => {
      if (state.sessionId !== sessionId) return
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/**
 * 切换模式。先乐观更新让界面立刻响应，失败则回滚并抛错
 * （调用方需要知道失败，否则会以为已经放开了）。
 */
export async function changeSecurityMode(sessionId: string, mode: SecurityMode): Promise<void> {
  if (!sessionId) throw new Error('缺少会话 ID，无法切换安全模式')
  const previous = state.mode
  setState({ sessionId, mode, loaded: true, error: null })

  try {
    await setSecurityMode(sessionId, mode)
  } catch (err) {
    setState({ mode: previous, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/** 引擎离开就绪态或换会话时调用：旧的模式一定不再适用 */
export function resetSecurityModeStore(): void {
  setState({ sessionId: '', mode: 'safe', loading: false, error: null, loaded: false })
}

/** 订阅会话安全模式（store 内部整体替换 state，引用稳定可作快照） */
export function useSecurityMode(): SecurityModeState & {
  refresh: (sessionId: string) => Promise<void>
} {
  const snapshot = useSyncExternalStore(onSecurityModeChanged, getSecurityModeState)
  return { ...snapshot, refresh: refreshSecurityMode }
}
