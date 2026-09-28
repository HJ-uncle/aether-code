/**
 * 克隆仓库共享流程（移植自 wuzu-client utils/gitCloneFlow.ts）
 *
 * 模块级单例状态 + useSyncExternalStore 订阅（aether store 统一模式）。
 * 「克隆仓库」入口分布在多个空状态，流程与进度状态必须全局唯一。
 *
 * 与 wuzu 版差异：wuzu 直接用 element-plus 的 MessageBox / Toast；
 * aether 把它们剥离成注入回调 —— 克隆完成后「是否打开」的确认框与提示
 * 由 UI 层提供（CloneFlowHooks），本模块只做流程编排与状态广播。
 */
import { useSyncExternalStore } from 'react'
import { gitCancelClone, gitClone, onGitCloneProgress } from './git-client'

export type GitCloneFlowStage = 'idle' | 'picking' | 'running'

export interface GitCloneFlowState {
  /** 弹窗输入 URL（UI 监听） */
  dialogVisible: boolean
  stage: GitCloneFlowStage
  percentage: number
  message: string
  activeCloneId: string
}

let state: GitCloneFlowState = {
  dialogVisible: false,
  stage: 'idle',
  percentage: 0,
  message: '',
  activeCloneId: ''
}

const listeners = new Set<() => void>()

function setState(patch: Partial<GitCloneFlowState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getCloneFlowState(): GitCloneFlowState {
  return state
}

export function onCloneFlowChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useGitCloneFlow(): GitCloneFlowState {
  return useSyncExternalStore(onCloneFlowChanged, getCloneFlowState, getCloneFlowState)
}

/** UI 注入的宿主能力：选父目录、克隆完成确认、提示、打开工作区 */
export interface CloneFlowHooks {
  /** 系统目录选择；取消返回 null */
  pickParentDir: () => Promise<string | null>
  /** 克隆完成后询问是否打开；是返回 true */
  confirmOpen: (finalPath: string) => Promise<boolean>
  toastError: (message: string) => void
  toastSuccess: (message: string) => void
  /** 打开克隆出的仓库为当前工作区 */
  openWorkspace: (path: string) => Promise<void> | void
}

let hooks: CloneFlowHooks | null = null

/** 应用根部挂载时注入宿主能力（单例流程的 UI 出口） */
export function configureCloneFlow(h: CloneFlowHooks): void {
  hooks = h
}

/**
 * 打开「克隆仓库」URL 弹窗（各空状态入口统一调用）；流程进行中时忽略重复触发
 */
export function startCloneFlow(): void {
  if (state.stage !== 'idle') return
  setState({ dialogVisible: true })
}

/** 关闭 URL 弹窗（用户点取消/遮罩/Esc）；仅在未进入克隆流程时有效 */
export function closeCloneDialog(): void {
  if (state.stage !== 'idle') return
  setState({ dialogVisible: false })
}

export function resetCloneProgress(): void {
  setState({ percentage: 0, message: '准备克隆…', activeCloneId: '' })
}

/**
 * URL 确认后的克隆主流程：选父目录 → 克隆 → 询问是否打开并切换工作区。
 * 返回是否已完成「打开仓库」（供 Git 面板等入口联动侧边视图）。
 */
export async function runCloneFlow(url: string): Promise<boolean> {
  if (!hooks || state.stage !== 'idle') return false

  setState({ dialogVisible: false, stage: 'picking' })

  const parentDir = await hooks.pickParentDir()
  if (!parentDir) {
    setState({ stage: 'idle' })
    return false
  }

  setState({ stage: 'running', percentage: 0, message: '准备克隆…', activeCloneId: '' })

  const res = await gitClone({ url, parentDir })
  setState({ stage: 'idle' })

  if (res.errorCode === 'clone-cancelled') return false
  if (!res.success || !res.finalPath) {
    hooks.toastError(res.error ?? '克隆失败')
    return false
  }

  const open = await hooks.confirmOpen(res.finalPath)
  if (!open) return false

  await hooks.openWorkspace(res.finalPath)
  hooks.toastSuccess('仓库已打开')
  return true
}

/**
 * 取消进行中的克隆（主进程按 cloneId kill 子进程，幂等）
 */
export async function cancelCloneFlow(): Promise<void> {
  if (!state.activeCloneId || !hooks) return
  const res = await gitCancelClone(state.activeCloneId)
  if (!res.success) hooks.toastError(res.error ?? '取消克隆失败')
}

/** 订阅克隆进度（返回退订函数）：百分比只前进不回退，由主进程保证 */
export function subscribeCloneProgress(): () => void {
  return onGitCloneProgress((payload) => {
    setState({
      activeCloneId: payload.cloneId,
      percentage: Math.max(state.percentage, payload.percentage),
      message: payload.message
    })
  })
}
