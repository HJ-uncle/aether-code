/**
 * 全局 toast 服务
 *
 * 模块级 store + 顶层 ToastHost 渲染：任何模块（含非组件环境的 clone-hooks、
 * store 层）都能直接调 toast.error('...')，不必层层传回调。
 * 语义对齐 wuzu-client 的 stores/toast.ts：success / error / warning / info，
 * 默认 3000ms 自动消失，error 稍长（5000ms）。
 */
import { useSyncExternalStore } from 'react'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastState {
  items: ToastItem[]
}

let state: ToastState = { items: [] }
let nextId = 1
/** 每条 toast 自持 timer；dismiss 时清掉避免与队列淘汰竞速 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const listeners = new Set<() => void>()

function setState(patch: Partial<ToastState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getToastState(): ToastState {
  return state
}

export function onToastChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(onToastChanged, getToastState).items
}

/** 上限与淘汰：同屏最多 4 条，超出丢最旧的，长队列不会把屏幕糊满 */
const MAX_VISIBLE = 4

function push(kind: ToastKind, message: string, durationMs: number): void {
  const item: ToastItem = { id: nextId++, kind, message }
  const items = [...state.items, item]
  setState({ items: items.length > MAX_VISIBLE ? items.slice(-MAX_VISIBLE) : items })
  const timer = setTimeout(() => dismissToast(item.id), durationMs)
  timers.set(item.id, timer)
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  if (!state.items.some((item) => item.id === id)) return
  setState({ items: state.items.filter((item) => item.id !== id) })
}

export const toast = {
  success: (message: string): void => push('success', message, 3000),
  error: (message: string): void => push('error', message, 5000),
  warning: (message: string): void => push('warning', message, 4000),
  info: (message: string): void => push('info', message, 3000)
}
