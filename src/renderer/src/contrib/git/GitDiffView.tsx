import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { GitFileDiff } from '@shared/git-types'
import { gitDiff } from '@renderer/core/git/git-client'
import { languageForPath, monaco, retainModel, setupMonacoEnvironment } from '@renderer/core/editor/monaco-setup'
import { ensureWorkspaceModel, openWorkspaceResource } from '@renderer/core/editor/monaco-workspace'
import { getDocument, isDirty, saveDocument, useEditor } from '@renderer/core/editor/editor-store'
import { registerActiveEditor } from '@renderer/core/editor/active-editor'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import { getEditorDisplayOptions, onEditorDisplayOptionsChanged, toMonacoEditorOptions } from '@renderer/core/editor/editor-display-options'
import { showEditorView } from '@renderer/core/platform/layout-state'
import { paths } from '@renderer/core/workspace/fs-client'
import { watchTheme } from '@renderer/core/theme/palette'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import { registerView, updateView } from '@renderer/workbench/view-registry'
import { addFilesToChat, addSelectionToChat, registerSnapshotContext } from '@renderer/contrib/chat/editor-context'
import './git-diff-view.css'

interface Comparison { cwd: string; path: string; staged: boolean; diff: GitFileDiff | null; loading: boolean; error: string | null; version: number }
let state: Comparison = { cwd: '', path: '', staged: false, diff: null, loading: false, error: null, version: 0 }
const listeners = new Set<() => void>()
let registered = false
function publish(patch: Partial<Comparison>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export async function openGitDiff(cwd: string, path: string, staged = false): Promise<void> {
  if (!registered) {
    registerView({ id: 'git-file-diff', title: '文件差异', location: 'editor', icon: 'git', closable: true, component: GitDiffView })
    registered = true
  }
  const version = state.version + 1
  publish({ cwd, path, staged, loading: true, diff: null, error: null, version })
  updateView('git-file-diff', {
    title: `${paths.basename(path)} · ${staged ? '暂存区' : '更改'}`
  })
  showEditorView('git-file-diff')
  try {
    const result = await gitDiff(cwd, path, staged)
    if (state.version !== version) return
    if (!result.success || !result.diff) throw new Error(result.error ?? '无法读取文件差异')
    publish({ diff: result.diff, loading: false })
  } catch (error) {
    if (state.version === version) publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }

export function GitDiffView(): JSX.Element {
  const comparison = useSyncExternalStore(subscribe, () => state)
  const documents = useEditor()
  const containerRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const absolute = paths.join(comparison.cwd, comparison.path)
  const doc = documents.docs.get(absolute) ?? getDocument(absolute)
  const editable = Boolean(comparison.diff && !comparison.staged && comparison.diff.changeType !== 'deleted' && !comparison.diff.binary)
  const [loadedVersion, setLoadedVersion] = useState(0)
  const documentClosed = editable && loadedVersion === comparison.version && !doc
  const save = async (): Promise<void> => {
    try { await saveDocument(absolute) } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => {
    const container = containerRef.current
    const data = comparison.diff
    if (!container || !data || data.binary || documentClosed) return
    let disposed = false
    let cleanup = (): void => {}
    setError(null)
    void (async () => {
      setupMonacoEnvironment(); refreshEditorTheme()
      const modified = editable
        ? await ensureWorkspaceModel(monaco.Uri.file(absolute))
        : monaco.editor.createModel(data.newContent, languageForPath(comparison.path))
      if (disposed) { if (!editable) modified.dispose(); return }
      const release = editable ? retainModel(absolute) : () => {}
      setLoadedVersion(comparison.version)
      const original = monaco.editor.createModel(data.oldContent, languageForPath(comparison.path))
      const releaseOriginalContext = registerSnapshotContext(original, absolute)
      const releaseModifiedContext = editable ? () => {} : registerSnapshotContext(modified, absolute)
      const editor = monaco.editor.createDiffEditor(container, {
        ...toMonacoEditorOptions(getEditorDisplayOptions()),
        theme: currentEditorThemeName(), automaticLayout: true, renderSideBySide: sideBySide,
        readOnly: !editable, originalEditable: false, scrollBeyondLastLine: false,
        renderOverviewRuler: true, renderIndicators: true
      })
      diffRef.current = editor
      editor.setModel({ original, modified })
      const target = editor.getModifiedEditor()
      const unregister = registerActiveEditor(target, 'git-diff')
      const originalEditor = editor.getOriginalEditor()
      const unregisterOriginal = registerActiveEditor(originalEditor, 'git-diff-original')
      const originalSelectionAction = originalEditor.addAction({ id: 'aether.diff.addOriginalSelectionToChat', label: '添加到对话',
        precondition: 'editorHasSelection', contextMenuGroupId: 'navigation',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
        run: (instance) => { addSelectionToChat(instance, absolute) }
      })
      const selectionAction = target.addAction({ id: 'aether.diff.addSelectionToChat', label: '添加到对话',
        precondition: 'editorHasSelection', contextMenuGroupId: 'navigation',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
        run: (instance) => { addSelectionToChat(instance, absolute) }
      })
      const saveAction = target.addAction({ id: 'aether.diff.save', label: '保存工作区文件',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: async () => { if (editable) await save() } })
      const preferences = onEditorDisplayOptionsChanged((options) => editor.updateOptions(toMonacoEditorOptions(options)))
      const theme = watchTheme(refreshEditorTheme)
      cleanup = () => {
        theme(); preferences(); unregister(); unregisterOriginal(); originalSelectionAction.dispose(); selectionAction.dispose(); saveAction.dispose()
        releaseOriginalContext(); releaseModifiedContext()
        editor.dispose(); original.dispose(); if (!editable) modified.dispose()
        release()
        diffRef.current = null
      }
      target.focus()
    })().catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true; cleanup() }
    // 布局选项独立更新，不因每次输入或切 inline 重建差异模型。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparison.version, comparison.diff, editable, absolute, documentClosed])
  useEffect(() => { diffRef.current?.updateOptions({ renderSideBySide: sideBySide }) }, [sideBySide])
  return (
    <section className="git-diff-view" aria-label="文件差异编辑器">
      <header className="git-diff-view__toolbar">
        <div className="git-diff-view__identity">
          <span className="git-diff-view__kind"><Icon name="git" size={15} />文件差异</span>
          <span className="git-diff-view__path" title={absolute}>{comparison.path}</span>
          <span className="git-diff-view__scope">{comparison.staged ? 'HEAD ↔ 暂存区（只读）' : '暂存区 ↔ 工作区'}</span>
        </div>
        <div className="git-diff-view__actions">
          <div className="git-diff-view__segmented" role="group" aria-label="差异布局">
            <button type="button" aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>并排比较</button>
            <button type="button" aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>行内比较</button>
          </div>
          <button type="button" title="上一处差异" onClick={() => diffRef.current?.goToDiff('previous')}><Icon name="chevron-up" size={13} /><span>上一处</span></button>
          <button type="button" title="下一处差异" onClick={() => diffRef.current?.goToDiff('next')}><Icon name="chevron-down" size={13} /><span>下一处</span></button>
          <button type="button" title="重新读取差异" onClick={() => void openGitDiff(comparison.cwd, comparison.path, comparison.staged)}><Icon name="restart" size={13} /><span>刷新</span></button>
          {editable ? <>
            <button type="button" title="在源码编辑器中打开" onClick={() => void openWorkspaceResource(monaco.Uri.file(absolute))}><Icon name="file" size={13} /><span>打开源码</span></button>
            <button type="button" className="git-diff-view__chat-action" title="将当前文件添加到对话" onClick={() => addFilesToChat([{ path: absolute, kind: 'file' }])}><Icon name="chat" size={13} /><span>添加到对话</span></button>
            <button type="button" className="git-diff-view__save-action" disabled={!doc || !isDirty(doc)} onClick={() => void save()}><Icon name="check" size={13} /><span>保存</span></button>
          </> : null}
        </div>
      </header>
      {comparison.loading ? <p className="git-diff-view__notice">正在加载差异…</p> : null}
      {comparison.error || error ? <p role="alert" className="git-diff-view__notice">{comparison.error ?? error}</p> : null}
      {comparison.diff?.binary ? <p className="git-diff-view__notice">二进制文件无法显示文本差异。</p> : null}
      {documentClosed ? <p className="git-diff-view__notice">源文件已关闭。可刷新比较以重新打开。</p> : null}
      <div className="git-diff-view__editor" ref={containerRef} />
      {editable && doc ? <footer className="git-diff-view__footer">
        <span>{documents.cursor && documents.cursor.filePath === absolute ? `行 ${documents.cursor.line}，列 ${documents.cursor.column}` : '差异编辑器'}</span>
        <span className={isDirty(doc) ? 'is-dirty' : 'is-saved'}>{isDirty(doc) ? '● 未保存：工作区编辑与源码标签共享' : '工作区文件已保存'}</span>
      </footer> : null}
    </section>
  )
}
