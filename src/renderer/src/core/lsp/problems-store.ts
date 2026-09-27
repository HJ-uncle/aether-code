/**
 * 问题列表 store（渲染层）
 *
 * 存放引擎 LSP 诊断结果（POST /lsp/diagnose 的产物），按文件分组。
 * 数据流：保存/手动诊断 → diagnostics.ts 写入本 store + Monaco markers；
 * 关闭/重命名文件 → 清对应条目。
 *
 * 只存引擎诊断，不合并 Monaco tsWorker 自带标记（编辑器内的
 * 波浪线由两者叠加，面板侧 MVP 先不展示 worker 诊断避免重复）。
 */
import { useSyncExternalStore } from 'react'

/** 引擎 Diagnostic 的子集（见引擎 src/lsp/types.ts），行列均为 1-based */
export interface ProblemItem {
  severity: 'error' | 'warning' | 'info' | 'hint'
  line: number
  column: number
  endLine?: number
  endColumn?: number
  code?: string
  message: string
  source: string
}

interface ProblemsState {
  /** 文件绝对路径 → 诊断列表 */
  byFile: Map<string, ProblemItem[]>
}

let state: ProblemsState = { byFile: new Map() }
const listeners = new Set<() => void>()

function setState(next: ProblemsState): void {
  state = next
  for (const listener of listeners) listener()
}

export function getProblemsState(): ProblemsState {
  return state
}

export function onProblemsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProblems(): ProblemsState {
  return useSyncExternalStore(onProblemsChanged, getProblemsState)
}

/** 全量替换某文件的诊断（重复诊断天然去重：后到覆盖先到） */
export function setFileProblems(filePath: string, items: ProblemItem[]): void {
  const byFile = new Map(state.byFile)
  byFile.set(filePath, items)
  setState({ byFile })
}

/** 关闭/重命名文件时清条目，避免面板残留死链接 */
export function clearFileProblems(filePath: string): void {
  if (!state.byFile.has(filePath)) return
  const byFile = new Map(state.byFile)
  byFile.delete(filePath)
  setState({ byFile })
}

/** 问题总数（状态栏徽标用） */
export function countProblems(): number {
  let total = 0
  for (const items of state.byFile.values()) total += items.length
  return total
}
