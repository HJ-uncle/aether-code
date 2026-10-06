import type { editor, IRange } from 'monaco-editor'
import { getDocument, isDirty } from '@renderer/core/editor/editor-store'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { getActiveEditor } from '@renderer/core/editor/active-editor'
import { showChatPanel } from '@renderer/core/platform/layout-state'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { toast } from '@renderer/core/toast'
import { formatPathDisplay, type Mention } from './mention-context'
import { pushPendingMentions } from './pending-mentions'

const snapshotPaths = new WeakMap<editor.ITextModel, string>()

/** Git 基线使用临时模型，但通过命令面板引用时仍须保留真实文件路径。 */
export function registerSnapshotContext(model: editor.ITextModel, filePath: string): () => void {
  snapshotPaths.set(model, filePath)
  return () => { snapshotPaths.delete(model) }
}

function referencePath(path: string): string {
  const root = getWorkspaceState().root?.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = path.replace(/\\/g, '/')
  if (root && fileIdentity(normalized).startsWith(`${fileIdentity(root)}/`)) return normalized.slice(root.length + 1)
  return normalized
}

function queue(mentions: Mention[]): boolean {
  if (!mentions.length) return false
  showChatPanel()
  pushPendingMentions(mentions)
  return true
}

export function addFilesToChat(entries: { path: string; kind: 'file' | 'directory' }[]): boolean {
  const seen = new Set<string>()
  const mentions = entries.filter(({ path }) => {
    const identity = fileIdentity(path)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  }).map(({ path, kind }): Mention => {
    const relative = referencePath(path)
    const doc = kind === 'file' ? getDocument(path) : undefined
    const snapshot = doc && !doc.loading && !doc.isBinary && !doc.truncated && isDirty(doc)
    return {
      source: kind === 'directory' ? 'dir' : 'file',
      path: relative,
      displayText: `${formatPathDisplay(relative)}${snapshot ? '（未保存）' : ''}`,
      ...(snapshot ? { content: doc.content } : {})
    }
  })
  return queue(mentions)
}

export function addSelectionToChat(instance: editor.ICodeEditor | null = getActiveEditor(), filePath?: string): boolean {
  const model = instance?.getModel()
  const selections = instance?.getSelections()?.filter((selection) => !selection.isEmpty())
  if (!model || !selections?.length) {
    toast.info('请先选择要添加到对话的代码。')
    return false
  }
  const sourcePath = filePath ?? snapshotPaths.get(model) ?? (model.uri.scheme === 'file' ? model.uri.fsPath : undefined)
  if (!sourcePath) {
    toast.info('此预览没有可引用的源文件路径。')
    return false
  }
  const path = referencePath(sourcePath)
  return queue(selections.map((selection): Mention => {
    // Monaco 的结束位置是排他的；选到下一行第 1 列不应把那一行算进引用。
    const range: IRange = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? { ...selection, endLineNumber: selection.endLineNumber - 1,
          endColumn: model.getLineMaxColumn(selection.endLineNumber - 1) }
      : selection
    return {
      source: 'code', path,
      displayText: `${formatPathDisplay(path)}:${range.startLineNumber}${range.endLineNumber !== range.startLineNumber ? `-${range.endLineNumber}` : ''}`,
      startLine: range.startLineNumber, endLine: range.endLineNumber,
      startColumn: range.startColumn, endColumn: range.endColumn,
      content: model.getValueInRange(selection)
    }
  }))
}
