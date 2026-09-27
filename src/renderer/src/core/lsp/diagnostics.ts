/**
 * 引擎 LSP 诊断（core 层）
 *
 * 诊断与补全的分工：补全由 Monaco tsWorker 本地承担（快、离线）；
 * 引擎 /lsp/diagnose 补足项目级诊断（tsc 语义检查 + eslint 规则），
 * 且支持传未保存内容——因此 remote 模式（文件在远端）同样可用。
 *
 * 结果双落点：problems-store（Problems 面板）+ Monaco markers
 * （编辑器波浪线）。失败静默，不打断保存流程。
 */
import { requestOrThrow } from '../engine/client'
import { acquireModel, languageForPath, monaco, peekModel } from '../editor/monaco-setup'
import { clearFileProblems, setFileProblems, type ProblemItem } from './problems-store'

/** 引擎 POST /lsp/diagnose 的 data 字段（见引擎 src/lsp/types.ts） */
interface DiagnoseResult {
  filePath: string
  language: string
  adapter: string
  diagnostics: ProblemItem[]
  durationMs: number
  fromCache: boolean
}

const MARKER_OWNER = 'aether-engine-lsp'

const SEVERITY: Record<ProblemItem['severity'], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint
}

/** 每文件一个序号：连续保存时只认最新一次请求，慢响应直接丢弃 */
const seqByFile = new Map<string, number>()

/** 补丁/差异文件不跑 LSP：VS Code 也不会对 .diff/.patch/.rej 跑 linter，
 *  否则 tsc/eslint 会把整份补丁判成语法错误，编辑器满屏红波浪线。 */
const NO_LINT_EXTENSIONS = new Set(['.diff', '.patch', '.rej'])

function isNoLint(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  return NO_LINT_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
}

/** 诊断一个文档（传编辑器当前内容，未保存状态也能查） */
export async function diagnoseDocument(filePath: string, content: string): Promise<boolean> {
  if (isNoLint(filePath)) {
    clearDocumentDiagnostics(filePath)
    return true
  }
  const seq = (seqByFile.get(filePath) ?? 0) + 1
  seqByFile.set(filePath, seq)

  let result: DiagnoseResult
  try {
    result = await requestOrThrow<DiagnoseResult>({
      method: 'POST',
      path: '/lsp/diagnose',
      body: { filePath, content }
    })
  } catch {
    return false
  }
  if (seqByFile.get(filePath) !== seq) return true

  const items = result.diagnostics ?? []
  setFileProblems(filePath, items)
  applyMarkers(filePath, items)
  return true
}

/** 清除某文件的诊断（Problems 条目 + Monaco markers） */
export function clearDocumentDiagnostics(filePath: string): void {
  seqByFile.delete(filePath)
  clearFileProblems(filePath)
  const model = peekModel(filePath)
  if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
}

function applyMarkers(filePath: string, items: ProblemItem[]): void {
  // 已打开用现成 model；未打开（理论上只在点击面板条目前的间隙出现）
  // 才新建，语言按路径推断，避免把 typescript 改成 plaintext
  const model = peekModel(filePath) ?? acquireModel(filePath, languageForPath(filePath))
  const markers: monaco.editor.IMarkerData[] = items.map((item) => ({
    severity: SEVERITY[item.severity] ?? monaco.MarkerSeverity.Info,
    // 引擎与 Monaco 均为 1-based；缺省范围时标记起始处一个字符
    startLineNumber: item.line,
    startColumn: item.column,
    endLineNumber: item.endLine ?? item.line,
    endColumn: item.endColumn ?? item.column + 1,
    message: item.message,
    source: item.source,
    ...(item.code ? { code: item.code } : {})
  }))
  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
}
