import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { getEditorState, onEditorChanged } from '@renderer/core/editor/editor-store'
import { useEditorGroups } from '@renderer/core/editor/editor-groups'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { watchSourceGit, type SourceGitSnapshot } from '@renderer/core/editor/source-git-features'
import { originalLineForModified } from '@renderer/core/git/source-git-utils'

export function EditorBlameStatus({ filePath, groupId }: { filePath: string; groupId?: string }): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<SourceGitSnapshot | null>(null)
  const cursor = useSyncExternalStore(onEditorChanged, () => getEditorState().cursor)
  const { focusedGroupId } = useEditorGroups()
  useEffect(() => watchSourceGit(filePath, setSnapshot), [filePath])
  if (!snapshot || snapshot.status !== 'ready' || (groupId && groupId !== focusedGroupId)) return null
  const line = cursor && fileIdentity(cursor.filePath) === fileIdentity(filePath) ? cursor.line : 1
  const originalLine = originalLineForModified(line, snapshot.changes)
  if (originalLine === null) return <span className="editor-blame-status" title="当前行与 HEAD 不同，尚无对应的提交归属。">尚未提交的更改</span>
  const blame = snapshot.blame[originalLine - 1]
  if (!blame) return null
  const date = new Date(blame.date)
  const formatted = Number.isNaN(date.getTime()) ? blame.date : date.toLocaleDateString('zh-CN')
  return <span className="editor-blame-status" title={`${blame.author} · ${formatted}\n${blame.hash}\n${blame.subject}`}>
    {blame.author} · {blame.shortHash} · {blame.subject}
  </span>
}
