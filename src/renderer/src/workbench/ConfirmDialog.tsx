/**
 * 通用确认弹窗 + 全局 confirm 服务
 *
 * 为什么存在：确认弹窗之前在 ChatView / GitChangesPanel 各内联了一份，
 * 更多地方（关闭未保存文档、删除模型/规则、克隆后询问）直接用原生
 * window.confirm —— 样式跟应用完全脱节，且在无边框窗口里标题栏都是系统的。
 *
 * 用法：
 *   const ok = await confirmDialog({ title: '删除模型', body: '…', danger: true })
 *   if (!ok) return
 *
 * 渲染端只需要在根组件挂一次 <ConfirmDialogHost />。
 */
import { useSyncExternalStore, type JSX } from 'react'
import { Dialog } from './Dialog'
import { toast } from '@renderer/core/toast'

export interface ConfirmOptions {
  title: string
  /** 正文说明 */
  body: string
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string
  /** 危险操作（删除/覆盖）确认按钮用警示色 */
  danger?: boolean
  /** 中间附加按钮（如「保存并关闭」）：run 返回 true 视同确认 */
  tertiary?: {
    text: string
    run: () => Promise<boolean> | boolean
  }
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
  id: number
  busy: boolean
}

// ---------- 极简单例 store：同时只会有一个确认弹窗 ----------

let current: ConfirmRequest | null = null
let nextRequestId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot(): ConfirmRequest | null {
  return current
}

/**
 * 弹一个主题化确认框，resolve 用户的选择。
 * 已有确认框在弹时，新请求直接 resolve(false) —— 同时弹两个确认框没有好体验，
 * 且调用方都是「用户刚点了一个按钮」的场景，不该排队。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (current) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    current = { ...options, resolve, id: ++nextRequestId, busy: false }
    notify()
  })
}

function settle(ok: boolean, id: number): void {
  if (current?.id !== id) return
  const req = current
  current = null
  notify()
  req?.resolve(ok)
}

/** 挂在应用根部：有 pending 请求时渲染弹窗 */
export function ConfirmDialogHost(): JSX.Element | null {
  const req = useSyncExternalStore(subscribe, getSnapshot)
  if (!req) return null
  return (
    <Dialog
      title={req.title}
      width={440}
      onClose={() => { if (!req.busy) settle(false, req.id) }}
      footer={
        <>
          <button type="button" className="btn" disabled={req.busy} onClick={() => settle(false, req.id)}>
            取消
          </button>
          {req.tertiary ? (
            <button
              type="button"
              className="btn"
              disabled={req.busy}
              onClick={() => {
                if (current?.id !== req.id || current.busy) return
                current = { ...current, busy: true }
                notify()
                void Promise.resolve().then(() => req.tertiary?.run() ?? false)
                  .then((ok) => settle(ok, req.id))
                  .catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : '操作失败，已保留当前内容')
                    settle(false, req.id)
                  })
              }}
            >
              {req.busy ? '处理中…' : req.tertiary.text}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn btn--primary${req.danger ? ' btn--danger' : ''}`}
            disabled={req.busy}
            onClick={() => settle(true, req.id)}
          >
            {req.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>{req.body}</p>
    </Dialog>
  )
}
