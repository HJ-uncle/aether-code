/**
 * git 状态共享 store
 *
 * 「状态栏的分支/改动数」与「版本控制视图」显示的是同一份数据，
 * 因此按 model-store 的既有模式放在模块级 store 里：单点请求、多处订阅。
 *
 * 刷新时机：工作区根目录变化、用户点刷新，以及两个自动触发点 ——
 * 保存文件后（editor-store）、Agent 一轮对话结束后（ChatView）。
 * 早先刻意不做自动刷新，但保存与对话轮结束恰好是「改动刚落盘」的两个
 * 确定时刻，此时刷新一次成本低、又免去了手动核对的摩擦。
 */
import { useSyncExternalStore } from 'react'
import type { GitCommit, GitStatus } from '@shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { gitLog, gitStatus } from './git-client'

export interface GitStoreState {
  /** 当前数据对应的仓库根目录 */
  root: string | null
  status: GitStatus | null
  commits: GitCommit[]
  loading: boolean
  error: string | null
  /** 是否已针对当前 root 成功拉取过 */
  loaded: boolean
}

let state: GitStoreState = {
  root: null,
  status: null,
  commits: [],
  loading: false,
  error: null,
  loaded: false
}

const listeners = new Set<() => void>()

function setState(patch: Partial<GitStoreState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getGitState(): GitStoreState {
  return state
}

export function onGitChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let inflight: Promise<void> | null = null

/**
 * 拉取指定根目录的 git 状态与历史。
 *
 * status 与 log 用 allSettled 而非 all：两者失败原因相互独立
 * （比如空仓库跑不了 log），一个失败不该让另一个的结果也丢掉。
 */
export function refreshGit(root: string | null): Promise<void> {
  if (!root) {
    resetGitStore()
    return Promise.resolve()
  }

  if (state.root !== root) {
    // 换了仓库：旧数据一定不适用，先清空避免显示上一个项目的分支
    setState({ root, status: null, commits: [], loaded: false, error: null, loading: true })
  } else {
    setState({ loading: true, error: null })
  }

  if (inflight) return inflight

  inflight = Promise.allSettled([gitStatus(root), gitLog(root)])
    .then(([statusResult, logResult]) => {
      // 请求期间可能已切走仓库，迟到的结果不能覆盖新仓库
      if (state.root !== root) return

      const failures: string[] = []
      if (statusResult.status === 'rejected')
        failures.push(`状态：${ipcErrorMessage(statusResult.reason)}`)
      if (logResult.status === 'rejected')
        failures.push(`历史：${ipcErrorMessage(logResult.reason)}`)

      setState({
        status: statusResult.status === 'fulfilled' ? statusResult.value : null,
        commits: logResult.status === 'fulfilled' ? logResult.value : [],
        loading: false,
        loaded: true,
        error: failures.length > 0 ? failures.join('；') : null
      })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

export function resetGitStore(): void {
  setState({ root: null, status: null, commits: [], loading: false, error: null, loaded: false })
}

/** 订阅 git 状态 */
export function useGit(): GitStoreState & { refresh: (root: string | null) => Promise<void> } {
  /**
   * 用 useSyncExternalStore 而不是「useState + useEffect 里 setSnapshot」。
   *
   * 后者是本仓库其它 store（model / editor / workspace）的写法，但那种写法
   * 会在 effect 里同步 setState，被 react-hooks 规则判为会导致级联渲染。
   * 这里换成本就为「订阅外部 store」设计的官方 API：更短、无额外渲染，
   * 且 getGitState 返回的对象在每次变更时才替换，符合快照必须稳定的要求。
   */
  const snapshot = useSyncExternalStore(onGitChanged, getGitState, getGitState)
  return { ...snapshot, refresh: refreshGit }
}
