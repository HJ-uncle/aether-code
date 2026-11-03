import { useCallback, useSyncExternalStore, type JSX } from 'react'
import { getDocumentIdentity, useEditorSelector, type EditorState, type OpenDocument } from '@renderer/core/editor/editor-store'
import { useRetainedPreviews } from '@renderer/core/editor/useRetainedPreviews'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { getEngineSource } from '@renderer/core/engine/source'
import { onWorkspaceConnectionChanged, workspaceConnectionKey } from '@renderer/core/workspace/connection'
import { documentKindFor } from '@renderer/contrib/documents/document-kind'
import type { DocumentRenderer } from './view-registry'

function retainedDocuments(state: EditorState, paths: readonly string[]): OpenDocument[] {
  return paths.flatMap(path => {
    const doc = state.docs.get(path)
    return doc && doc.isBinary && !doc.loading && !doc.error && !doc.tooLarge &&
      (doc.bytes || doc.base64) && documentKindFor(doc.name) ? [doc] : []
  })
}

/** Text editors keep their stable per-group Monaco slot. Only visited Office
 * and PDF documents get independent, bounded hosts so switching does not
 * rebuild their parser and iframe. Groups never share pagination or selection. */
export function DocumentSlots({ paths, filePath, groupId, workspaceRoot, Renderer }: {
  paths: readonly string[]
  filePath: string | null
  groupId: string
  workspaceRoot: string | null
  Renderer: DocumentRenderer | null
}): JSX.Element {
  const select = useCallback((state: EditorState) => retainedDocuments(state, paths), [paths])
  const documents = useEditorSelector(select, (a, b) => a.length === b.length && a.every((doc, index) => doc === b[index]))
  const connection = useSyncExternalStore(onWorkspaceConnectionChanged, () => `${workspaceConnectionKey()}:${getEngineSource()}`)
  const active = useAppMode() === 'code'
  const entries = documents.map(doc => ({
    id: JSON.stringify([doc.workspaceKey, doc.path, getDocumentIdentity(doc.path)?.instance]),
    path: doc.path,
    size: doc.size,
    version: doc.bytes ?? doc.base64
  }))
  const selected = entries.find(entry => entry.path === filePath)?.id ?? null
  const retained = useRetainedPreviews(entries, active ? selected : null, JSON.stringify([connection, workspaceRoot, groupId]))
  const retainedIds = new Set(retained.map(entry => entry.id))
  if (!Renderer) return filePath ? <div className="doc-placeholder">未注册文档渲染器。</div> : <></>
  return <>
    {filePath && !selected ? <Renderer key={groupId} filePath={filePath} groupId={groupId} active={active} /> : null}
    {/* Keep DOM order tied to open tabs: moving an iframe ancestor can reload
        its document even when React preserves the component and its key. */}
    {entries.filter(entry => retainedIds.has(entry.id)).map(entry => <div className="editor-document-slot" hidden={entry.id !== selected} key={entry.id}>
      <Renderer filePath={entry.path} groupId={groupId} active={active && entry.id === selected} />
    </div>)}
  </>
}
