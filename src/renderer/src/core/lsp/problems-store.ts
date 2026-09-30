/**
 * 问题列表 store（渲染层）
 *
 * 存放引擎 LSP 诊断结果（POST /lsp/diagnose 的产物），按文件分组。
 * 数据流：保存/手动诊断 → diagnostics.ts 写入本 store + Monaco markers；
 * 关闭/重命名文件 → 清对应条目。
 *
 * 合并引擎与独立 tsserver 的诊断；同一问题保留一份，来源各自更新/清理。
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

export type DiagnosisStatus = 'running' | 'completed' | 'unsupported' | 'error' | 'cancelled'
export interface FileDiagnosis { status: DiagnosisStatus; message?: string }

interface ProblemsState {
  diagnoses: Map<string, FileDiagnosis>
  /** 文件绝对路径 → 诊断列表 */
  byFile: Map<string, ProblemItem[]>
}

type ProblemOwner = 'engine' | 'tsserver'
const ownedProblems = new Map<string, Map<ProblemOwner, ProblemItem[]>>()
let state: ProblemsState = { byFile: new Map(), diagnoses: new Map() }
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

/** 引擎路径和 LSP URI 的 fsPath 在 Windows 上可能使用不同大小写/分隔符。 */
export function diagnosticFileKey(filePath: string): string {
  return /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(filePath)
    ? filePath.replace(/\\/g, '/').toLowerCase()
    : filePath
}

function prepareFileState(filePath: string, preferInputPath = false): ProblemsState & { filePath: string } {
  const byFile = new Map(state.byFile)
  const diagnoses = new Map(state.diagnoses)
  const key = diagnosticFileKey(filePath)
  const previous = [...new Set([...ownedProblems.keys(), ...diagnoses.keys()])]
    .find((path) => diagnosticFileKey(path) === key)
  const selected = preferInputPath ? filePath : (previous ?? filePath)
  // 引擎诊断由已打开文档发起，沿用它的路径才能回到同一个编辑器标签。
  if (previous && previous !== selected) {
    const owners = ownedProblems.get(previous)
    if (owners) { ownedProblems.delete(previous); ownedProblems.set(selected, owners) }
    const items = byFile.get(previous)
    if (items) { byFile.delete(previous); byFile.set(selected, items) }
    const diagnosis = diagnoses.get(previous)
    if (diagnosis) { diagnoses.delete(previous); diagnoses.set(selected, diagnosis) }
  }
  return { filePath: selected, byFile, diagnoses }
}

function problemSource(item: ProblemItem): string {
  return item.source === 'typescript-language-server' ? 'typescript' : item.source
}

function problemCode(item: ProblemItem): string {
  const code = item.code ?? ''
  return problemSource(item) === 'typescript' ? code.replace(/^TS(?=\d+$)/i, '') : code
}

function sameProblem(a: ProblemItem, b: ProblemItem): boolean {
  return a.severity === b.severity && problemSource(a) === problemSource(b)
    && a.line === b.line && a.column === b.column && problemCode(a) === problemCode(b)
    && a.message === b.message
    // tsc 文本输出没有结束位置；若双方都给出范围，则不同范围仍是不同问题。
    && (a.endLine === undefined || b.endLine === undefined || a.endLine === b.endLine)
    && (a.endColumn === undefined || b.endColumn === undefined || a.endColumn === b.endColumn)
}

/** 各来源独立替换，展示时合并相同诊断，保留较完整的范围。 */
function rebuildFile(filePath: string, byFile: Map<string, ProblemItem[]>): void {
  const owners = ownedProblems.get(filePath)
  const merged = [...(owners?.get('engine') ?? []), ...(owners?.get('tsserver') ?? [])]
  const visible: ProblemItem[] = []
  for (const item of merged) {
    const index = visible.findIndex((existing) => sameProblem(existing, item))
    if (index < 0) visible.push(item)
    else visible[index] = {
      ...visible[index],
      endLine: visible[index].endLine ?? item.endLine,
      endColumn: visible[index].endColumn ?? item.endColumn
    }
  }
  if (visible.length > 0 || owners?.has('engine') || owners?.has('tsserver')) byFile.set(filePath, visible)
  else byFile.delete(filePath)
}

export function setFileProblems(filePath: string, items: ProblemItem[], owner: ProblemOwner = 'engine'): void {
  const prepared = prepareFileState(filePath, owner === 'engine')
  filePath = prepared.filePath
  const { byFile, diagnoses } = prepared
  const owners = ownedProblems.get(filePath) ?? new Map<ProblemOwner, ProblemItem[]>()
  owners.set(owner, items)
  ownedProblems.set(filePath, owners)
  rebuildFile(filePath, byFile)
  if (owner === 'engine') diagnoses.set(filePath, { status: 'completed' })
  setState({ byFile, diagnoses })
}

export function setFileDiagnosis(filePath: string, status: DiagnosisStatus, message?: string): void {
  if (status === 'cancelled') { clearFileProblems(filePath, 'engine'); return }
  const prepared = prepareFileState(filePath, true)
  filePath = prepared.filePath
  const { byFile, diagnoses } = prepared
  diagnoses.set(filePath, { status, message })
  if (status !== 'completed') {
    const owners = ownedProblems.get(filePath)
    owners?.delete('engine')
    if (owners && owners.size === 0) ownedProblems.delete(filePath)
    rebuildFile(filePath, byFile)
  }
  setState({ byFile, diagnoses })
}

/** 关闭/重命名文件时清条目，避免面板残留死链接 */
export function clearFileProblems(filePath: string, owner?: ProblemOwner): void {
  const prepared = prepareFileState(filePath)
  filePath = prepared.filePath
  if (!state.byFile.has(filePath) && !state.diagnoses.has(filePath) && !ownedProblems.has(filePath)) return
  const { byFile, diagnoses } = prepared
  if (owner) {
    const owners = ownedProblems.get(filePath)
    owners?.delete(owner)
    if (owners && owners.size === 0) ownedProblems.delete(filePath)
    rebuildFile(filePath, byFile)
  } else {
    ownedProblems.delete(filePath)
    byFile.delete(filePath)
  }
  if (!owner || owner === 'engine') diagnoses.delete(filePath)
  setState({ byFile, diagnoses })
}

/** 问题总数（状态栏徽标用） */
export function countProblems(): number {
  let total = 0
  for (const items of state.byFile.values()) total += items.length
  return total
}
