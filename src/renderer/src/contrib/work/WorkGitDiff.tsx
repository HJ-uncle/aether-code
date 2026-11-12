import { useEffect, useRef, useState, type JSX } from 'react'
import type { GitCommitFileChange, GitFileDiff } from '@shared/git-types'
import { loadGitCommitDiff } from '@renderer/core/git/git-commit-diff'
import type { GitStore } from '@renderer/core/git/git-store-instance'
import { languageForPath, monaco, setupMonacoEnvironment } from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import {
  getEditorDisplayOptions,
  onEditorDisplayOptionsChanged,
  toMonacoEditorOptions
} from '@renderer/core/editor/editor-display-options'
import { watchTheme } from '@renderer/core/theme/palette'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'

/** Snapshot models never enter Code's editor registry or its workspace resolver. */
export function WorkGitDiff({
  store,
  path,
  staged,
  commit,
  onClose,
  onOpenFile
}: {
  store: GitStore
  path: string
  staged: boolean
  commit?: { hash: string; file: GitCommitFileChange }
  onClose: () => void
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [sideBySide, setSideBySide] = useState(false)
  useEffect(() => {
    let current = true
    setLoading(true)
    setDiff(null)
    setError('')
    void store
      .readClient(async (client) => {
        if (commit) return loadGitCommitDiff(client, commit.hash, commit.file)
        const result = await client.gitDiff(path, staged)
        if (!result.success || !result.diff) throw new Error(result.error || '无法读取文件差异')
        return result.diff
      })
      .then((result) => {
        if (current) setDiff(result)
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [store, path, staged, commit, revision])
  useEffect(() => {
    if (!container.current || !diff || diff.binary) return
    setupMonacoEnvironment()
    refreshEditorTheme()
    const original = monaco.editor.createModel(diff.oldContent, languageForPath(path))
    const modified = monaco.editor.createModel(diff.newContent, languageForPath(path))
    const view = monaco.editor.createDiffEditor(container.current, {
      ...toMonacoEditorOptions(getEditorDisplayOptions()),
      theme: currentEditorThemeName(),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      // The explicit layout choice must survive Monaco's narrow-pane breakpoint.
      useInlineViewWhenSpaceIsLimited: false,
      scrollBeyondLastLine: false,
      renderIndicators: true
    })
    editor.current = view
    view.setModel({ original, modified })
    const theme = watchTheme(refreshEditorTheme)
    const preferences = onEditorDisplayOptionsChanged((options) =>
      view.updateOptions(toMonacoEditorOptions(options))
    )
    return () => {
      theme()
      preferences()
      view.dispose()
      original.dispose()
      modified.dispose()
      editor.current = null
    }
  }, [diff, path])
  useEffect(() => {
    editor.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])
  return (
    <section className="work-git-diff" aria-label="任务文件差异">
      <header className="work-git-diff__header">
        <div className="work-git-diff__identity">
          <strong title={path}>{path}</strong>
          <span>
            {commit
              ? `父提交 ↔ ${commit.hash.slice(0, 8)}`
              : staged
                ? 'HEAD ↔ 暂存区'
                : '暂存区 ↔ 工作区'}
          </span>
        </div>
        <div className="work-git-diff__actions">
          <button
            type="button"
            aria-pressed={sideBySide}
            onClick={() => setSideBySide((value) => !value)}
          >
            {sideBySide ? '行内比较' : '并排比较'}
          </button>
          <button
            type="button"
            title="上一处差异"
            aria-label="上一处差异"
            onClick={() => editor.current?.goToDiff('previous')}
          >
            <Icon name="chevron-up" size={14} />
          </button>
          <button
            type="button"
            title="下一处差异"
            aria-label="下一处差异"
            onClick={() => editor.current?.goToDiff('next')}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          <button
            type="button"
            title="刷新差异"
            aria-label="刷新差异"
            onClick={() => setRevision((value) => value + 1)}
          >
            <Icon name="refresh" size={14} />
          </button>
          {onOpenFile && diff?.changeType !== 'deleted' ? (
            <button type="button" onClick={() => onOpenFile(path)}>
              打开文件
            </button>
          ) : null}
          <button type="button" title="关闭差异" aria-label="关闭差异" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>
      {loading ? (
        <p className="work-git-diff__notice">
          <Spinner size={14} />
          正在加载差异…
        </p>
      ) : null}
      {error ? (
        <p className="work-git-diff__notice" role="alert">
          {error}
        </p>
      ) : null}
      {diff?.binary ? <p className="work-git-diff__notice">二进制文件无法显示文本差异。</p> : null}
      <div ref={container} className="work-git-diff__editor" />
    </section>
  )
}
