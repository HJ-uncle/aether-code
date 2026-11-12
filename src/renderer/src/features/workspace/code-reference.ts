import type { IRange, editor } from 'monaco-editor'
import { formatPathDisplay, type Mention, type MentionOrigin } from '../conversation/shared/mention-context'

/** Keep the same inclusive label and exact original bytes as Code's selection references. */
export function sessionCodeReference(model: Pick<editor.ITextModel, 'getLineMaxColumn' | 'getValueInRange'>,
  selection: IRange, path: string, origin: MentionOrigin = 'workspace'): Mention {
  const range: IRange = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
    ? { ...selection, endLineNumber: selection.endLineNumber - 1, endColumn: model.getLineMaxColumn(selection.endLineNumber - 1) }
    : selection
  return {
    source: 'code', origin, path,
    displayText: `${formatPathDisplay(path)}:${range.startLineNumber}${range.endLineNumber !== range.startLineNumber ? `-${range.endLineNumber}` : ''}`,
    startLine: range.startLineNumber, endLine: range.endLineNumber,
    startColumn: range.startColumn, endColumn: range.endColumn,
    content: model.getValueInRange(selection)
  }
}
