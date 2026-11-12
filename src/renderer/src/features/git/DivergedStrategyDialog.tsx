/**
 * 「本地与远端已分叉」策略选择弹窗 + 全局 pick 服务
 *
 * 为什么存在：这份弹窗之前在 GitCommitBar / GitSyncButton 各内联了一份
 * （useState 存 {detail, resolve} + 手写 Promise 包装 + 同一段 Dialog JSX），
 * 标题/按钮/宽度完全一致，仅容器 className 不同。这里抽成模块级单例 store +
 * Host 组件，模式对齐 ui/ConfirmDialog。
 *
 * 用法（UI 层把它接进 chooseMergeStrategy 的 ChooseStrategy 回调）：
 *   const chooseStrategy: ChooseStrategy = (info) => pickDivergedStrategy(info.detail)
 *
 * 渲染端只需在根组件挂一次 <DivergedStrategyDialogHost />。
 */
import { useSyncExternalStore, type JSX } from 'react'
import { Dialog } from '../../ui/Dialog'
import { useMotionPresence, useMotionValue } from '@renderer/ui/MotionPresence'

/** 用户的选择：合并 / 变基 / 取消（null） */
export type DivergedStrategy = 'merge' | 'rebase' | null

interface DivergedRequest {
  id: number
  detail: string
  resolve: (v: DivergedStrategy) => void
}

// ---------- 极简单例 store：同时只会有一个分叉策略弹窗 ----------

let current: DivergedRequest | null = null
let nextRequestId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot(): DivergedRequest | null {
  return current
}

/**
 * 弹出「合并/变基/取消」选择框，resolve 用户的选择。
 * 已有弹窗在弹时，新请求直接 resolve(null) —— 同时弹两个没有好体验。
 */
export function pickDivergedStrategy(detail: string): Promise<DivergedStrategy> {
  if (current) return Promise.resolve(null)
  return new Promise<DivergedStrategy>((resolve) => {
    current = { detail, resolve, id: ++nextRequestId }
    notify()
  })
}

function settle(v: DivergedStrategy, expected: DivergedRequest): void {
  if (current !== expected) return
  const req = current
  current = null
  notify()
  req?.resolve(v)
}

/** 挂在应用根部：有 pending 请求时渲染弹窗 */
export function DivergedStrategyDialogHost(): JSX.Element | null {
  const currentRequest = useSyncExternalStore(subscribe, getSnapshot)
  const motion = useMotionPresence(Boolean(currentRequest))
  const req = useMotionValue(currentRequest)
  if (!motion.present || !req) return null
  return (
    <Dialog
      key={req.id}
      open={Boolean(currentRequest)}
      title="本地与远端已分叉"
      className="git-dialog git-diverged-dialog"
      width={480}
      onClose={() => settle(null, req)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => settle(null, req)}>
            取消
          </button>
          <button type="button" className="btn" onClick={() => settle('rebase', req)}>
            变基（rebase）
          </button>
          <button type="button" className="btn btn--primary" onClick={() => settle('merge', req)}>
            合并（merge）
          </button>
        </>
      }
    >
      <div className="git-diverged-dialog__detail">{req.detail}</div>
      <dl className="git-diverged-dialog__options">
        <div>
          <dt>合并（merge）</dt>
          <dd>保留双方的提交历史，并生成一次合并提交。</dd>
        </div>
        <div>
          <dt>变基（rebase）</dt>
          <dd>把本地提交接到远端提交之后，历史更直观，但会改写本地提交。</dd>
        </div>
      </dl>
      <p className="git-diverged-dialog__hint">选择会保存到当前仓库，下次分叉时沿用；取消则保持现状。</p>
    </Dialog>
  )
}
