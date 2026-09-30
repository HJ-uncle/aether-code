export interface LspPosition {
  line: number
  character: number
}
export interface LspTextRange {
  start: LspPosition
  end: LspPosition
}
export interface LspTextEdit {
  range: LspTextRange
  newText: string
}
export interface LspDocumentEdit {
  uri: string
  version?: number | null
  edits: LspTextEdit[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function position(value: unknown): value is LspPosition {
  return (
    object(value) &&
    Number.isInteger(value.line) &&
    Number(value.line) >= 0 &&
    Number.isInteger(value.character) &&
    Number(value.character) >= 0
  )
}
function textEdits(value: unknown): LspTextEdit[] {
  if (!Array.isArray(value)) throw new Error('语言服务未返回有效的文本编辑列表')
  return value.map((edit: unknown) => {
    if (
      !object(edit) ||
      !object(edit.range) ||
      !position(edit.range.start) ||
      !position(edit.range.end) ||
      typeof edit.newText !== 'string'
    )
      throw new Error('语言服务返回了无效的文本编辑')
    const { start, end } = edit.range
    if (end.line < start.line || (end.line === start.line && end.character < start.character))
      throw new Error('语言服务返回了倒置的文本范围')
    return { range: { start, end }, newText: edit.newText }
  })
}

/** Validate the whole protocol edit before creating models or changing any user buffer. */
export function parseWorkspaceTextEdits(value: unknown): LspDocumentEdit[] {
  if (!object(value)) throw new Error('语言服务未返回有效的工作区编辑')
  if (value.documentChanges !== undefined) {
    if (!Array.isArray(value.documentChanges)) throw new Error('工作区文档编辑格式无效')
    return value.documentChanges.map((change: unknown) => {
      if (!object(change)) throw new Error('工作区文档编辑格式无效')
      if (change.kind !== undefined)
        throw new Error('暂不支持语言服务创建、删除或移动文件；没有应用任何编辑')
      if (!object(change.textDocument) || typeof change.textDocument.uri !== 'string')
        throw new Error('工作区编辑缺少目标文档')
      const { uri, version } = change.textDocument
      if (version !== undefined && version !== null && !Number.isInteger(version))
        throw new Error('工作区编辑的文档版本无效')
      return { uri, version: version as number | null | undefined, edits: textEdits(change.edits) }
    })
  }
  if (value.changes === undefined) return []
  if (!object(value.changes)) throw new Error('工作区编辑的 changes 格式无效')
  return Object.entries(value.changes).map(([uri, edits]) => ({ uri, edits: textEdits(edits) }))
}

export interface LspCommand {
  title?: string
  command: string
  arguments?: unknown[]
}
export interface LspCodeAction {
  title: string
  kind?: string
  edit?: unknown
  command?: LspCommand
  isPreferred?: boolean
  disabled?: { reason: string }
  data?: unknown
}

/** A CodeAction response can also contain bare Commands; do not confuse the two command fields. */
export function parseLspCodeAction(value: unknown): LspCodeAction | null {
  if (!object(value) || typeof value.title !== 'string') return null
  if (typeof value.command === 'string')
    return {
      title: value.title,
      command: {
        title: value.title,
        command: value.command,
        arguments: Array.isArray(value.arguments) ? value.arguments : undefined
      }
    }
  const command =
    object(value.command) && typeof value.command.command === 'string'
      ? {
          title: typeof value.command.title === 'string' ? value.command.title : value.title,
          command: value.command.command,
          arguments: Array.isArray(value.command.arguments) ? value.command.arguments : undefined
        }
      : undefined
  return {
    title: value.title,
    kind: typeof value.kind === 'string' ? value.kind : undefined,
    edit: value.edit,
    command,
    data: value.data,
    isPreferred: value.isPreferred === true,
    disabled:
      object(value.disabled) && typeof value.disabled.reason === 'string'
        ? { reason: value.disabled.reason }
        : undefined
  }
}
