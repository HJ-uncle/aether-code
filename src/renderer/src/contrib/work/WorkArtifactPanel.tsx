import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { WorkArtifact } from './work-state'
import { paths, readFile, readSessionFile, saveSessionFile } from '@renderer/core/workspace/fs-client'
import { openFileFromChat } from '@renderer/contrib/chat/open-file'
import { Markdown } from '@renderer/contrib/chat/Markdown'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
import { toast } from '@renderer/core/toast'
import { workSourceMarkdown } from './work-artifact-utils'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { workArtifactExportName, workArtifactReadFailure, workArtifactReadResult, type WorkArtifactContent } from './work-artifact-content'
import { FileGlyph } from '../explorer/FileGlyph'
import './work-artifact-panel.css'

export interface WorkArtifactPanelProps {
  artifact: WorkArtifact | null
  workspaceRoot?: string | null
  sessionId?: string
  onAddToConversation?: (artifact: WorkArtifact, selection?: string, selectionCoverage?: WorkArtifactContent['coverage']) => void
  onOpenFile?: (artifact: WorkArtifact) => void
  artifacts?: WorkArtifact[]
  onSelect?: (id: string) => void
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}
function isText(name: string): boolean {
  return /\.(txt|json|ya?ml|xml|tsx?|jsx?|[cm][jt]s|css|scss|less|html?|svg|py|go|rs|java|c|cpp|h|sh|sql|toml|ini|env)$/i.test(
    name
  )
}

async function readWorkFile(
  path: string,
  sessionId: string | undefined
): Promise<{ content: string; isBinary: boolean; truncated: boolean; tooLarge?: boolean }> {
  if (sessionId) {
    const result = await readSessionFile(sessionId, path)
    return {
      content: result.content,
      isBinary: result.isBinary,
      truncated: result.truncated,
      tooLarge: result.tooLarge
    }
  }
  return readFile(path)
}

/** Work's artifact surface is deliberately session-scoped: a receipt may be stale,
 * so preview reads the workspace before falling back to the receipt content. */
export function WorkArtifactPanel(props: WorkArtifactPanelProps): JSX.Element {
  const epoch = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  // Remount at an identity change so old content and selections never become
  // actionable during the first render of another task or engine connection.
  return <ArtifactContent key={JSON.stringify([epoch, props.sessionId, props.workspaceRoot, props.artifact?.id, props.artifact?.path])} {...props} epoch={epoch} />
}

function ArtifactContent({
  artifact,
  workspaceRoot,
  sessionId,
  onAddToConversation,
  onOpenFile,
  artifacts = [],
  onSelect,
  epoch
}: WorkArtifactPanelProps & { epoch: number }): JSX.Element {
  const [read, setRead] = useState<{ receipt: string | null | undefined; value: WorkArtifactContent | null }>({ receipt: artifact?.content, value: null })
  const value = read.receipt === artifact?.content ? read.value : null
  const content = value?.content ?? null
  const loading = Boolean(artifact && !value)
  const error = value?.coverage === 'unavailable' && !value.isBinary ? value.notice : ''
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [selection, setSelection] = useState('')
  const [readVersion, setReadVersion] = useState(0)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    setRead({ receipt: artifact?.content, value: null })
    setSelection('')
    setMode(artifact && isMarkdown(artifact.name) ? 'preview' : 'source')
    if (!artifact || !artifact.path) {
      if (artifact) setRead({ receipt: artifact.content, value: { content: null, coverage: 'unavailable', notice: '该成果没有有效的文件路径，无法读取。' } })
      return () => {
        active = false
      }
    }
    const readPath = /^(?:[A-Za-z]:[\\/]|\/)/.test(artifact.path)
      ? artifact.path
      : workspaceRoot
        ? paths.join(workspaceRoot, artifact.path)
        : artifact.path
    void readWorkFile(readPath, sessionId)
      .then((result) => {
        if (active && epoch === getEngineSource()) setRead({ receipt: artifact.content, value: workArtifactReadResult(result) })
      })
      .catch((reason: unknown) => {
        if (active && epoch === getEngineSource()) setRead({ receipt: artifact.content, value: workArtifactReadFailure(artifact.content, reason) })
      })
    return () => {
      active = false
    }
  }, [artifact?.id, artifact?.path, artifact?.content, workspaceRoot, sessionId, readVersion, epoch])

  const language = useMemo(
    () => artifact?.name.split('.').pop()?.toUpperCase() ?? 'TEXT',
    [artifact?.name]
  )

  useEffect(() => {
    const update = (): void => {
      const current = window.getSelection()
      if (
        !current?.anchorNode ||
        !current.focusNode ||
        !previewRef.current?.contains(current.anchorNode) ||
        !previewRef.current.contains(current.focusNode)
      ) {
        setSelection('')
        return
      }
      const value = current.toString().trim()
      setSelection(value)
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [artifact?.id])

  if (!artifact)
    return (
      <div className="work-artifact-panel-v2 work-artifact-panel-v2--empty">
        <Icon name="file" size={22} />
        <strong>成果会出现在这里</strong>
        <span>AI 创建或修改文件后，可在此预览、复制或继续引用。</span>
      </div>
    )

  const copy = async (): Promise<void> => {
    if (content === null || epoch !== getEngineSource()) return
    try {
      if (!navigator.clipboard) throw new Error('当前环境不支持复制')
      await navigator.clipboard.writeText(content)
      if (epoch === getEngineSource()) toast.success(value?.coverage === 'partial' ? '已复制预览片段' : value?.coverage === 'receipt' ? '已复制历史回执内容' : '已复制当前文件内容')
    } catch (reason: unknown) {
      toast.error(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const download = async (): Promise<void> => {
    if (saving || epoch !== getEngineSource()) return
    if (value?.isBinary && sessionId) {
      setSaving(true)
      try {
        const saved = await saveSessionFile(sessionId, artifact.path)
        if (mounted.current && epoch === getEngineSource() && saved.saved) toast.success('原文件已保存')
      } catch (reason: unknown) {
        if (mounted.current && epoch === getEngineSource()) toast.error(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (mounted.current) setSaving(false)
      }
      return
    }
    if (content === null || epoch !== getEngineSource()) return
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = workArtifactExportName(artifact.name, value?.coverage ?? 'unavailable')
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const addReference = (): void => {
    if (epoch !== getEngineSource()) return
    // A whole-file reference resolves its path at the next send. Never inject
    // the receipt bytes as though they were the successfully read version.
    onAddToConversation?.({ ...artifact, content: null }, selection || undefined, selection ? value?.coverage : undefined)
  }
  return (
    <section className="work-artifact-panel-v2" aria-label="成果预览">
      <header className="work-artifact-panel-v2__header work-artifact-select">
        <div className="work-artifact-panel-v2__title" title={artifact.path}>
          <FileGlyph name={artifact.name} size={17} />
          <div>
            <strong>{artifact.name}</strong>
            <span>{artifact.path}</span>
          </div>
        </div>
        {artifacts.length > 1 && onSelect ? (
          <Select
            className="work-artifact-panel-v2__picker"
            value={artifact.id}
            ariaLabel="选择成果"
            title="选择成果"
            width={280}
            onChange={onSelect}
            options={artifacts.map((item) => ({
              value: item.id,
              label: item.name,
              description: item.path
            }))}
          />
        ) : null}
        <span
          className={`work-artifact-panel-v2__status work-artifact-panel-v2__status--${artifact.status}`}
        >
          {artifact.status === 'ready' ? '已生成' : '草稿'}
        </span>
      </header>
      <div className="work-artifact-panel-v2__toolbar">
        <button
          type="button"
          className="work-quiet-button"
          disabled={!artifact.path}
          onClick={() => {
            if (epoch !== getEngineSource()) return
            if (onOpenFile) onOpenFile(artifact)
            else void openFileFromChat(
                  artifact.path,
                  sessionId ? { sessionId, workspaceRoot: workspaceRoot ?? undefined } : undefined
                ).catch((reason: unknown) =>
                  toast.error(reason instanceof Error ? reason.message : String(reason))
                )
          }}
        >
          <Icon name="file" size={14} />
          在编辑器打开
        </button>
        <button
          type="button"
          className="work-quiet-button"
          onClick={() => { if (epoch === getEngineSource()) setReadVersion(value => value + 1) }}
          disabled={loading || !artifact.path}
          aria-label="刷新成果预览"
          title="重新读取文件，更新预览"
        >
          <Icon name="restart" size={14} />
          刷新
        </button>
        <button
          type="button"
          className="work-quiet-button"
          onClick={addReference}
          disabled={!onAddToConversation || !artifact.path}
        >
          <Icon name="chat" size={14} />
          {selection ? '引用选中内容' : '添加到对话'}
        </button>
        <button
          type="button"
          className="work-quiet-button"
          onClick={() => void copy()}
          disabled={content === null}
        >
          <Icon name="copy" size={14} />
          {value?.coverage === 'partial' ? '复制片段' : value?.coverage === 'receipt' ? '复制回执' : '复制'}
        </button>
        <button
          type="button"
          className="work-quiet-button"
          onClick={() => void download()}
          disabled={saving || (content === null && !(value?.isBinary && sessionId))}
        >
          <Icon name="cloud-download-outline" size={14} />
          {saving ? '正在保存…' : value?.isBinary ? '下载原文件' : value?.coverage === 'partial' ? '下载片段' : value?.coverage === 'receipt' ? '下载回执' : '下载'}
        </button>
        {isMarkdown(artifact.name) && (
          <div className="work-artifact-panel-v2__modes">
            {isMarkdown(artifact.name) ? <>
              <button
                type="button"
                aria-pressed={mode === 'preview'}
                onClick={() => setMode('preview')}
              >
                预览
              </button>
              <button
                type="button"
                aria-pressed={mode === 'source'}
                onClick={() => setMode('source')}
              >
                {language}
              </button>
            </> : null}
          </div>
        )}
      </div>
      {value && value.coverage !== 'current' && value.coverage !== 'unavailable' ? (
        <div className="work-artifact-panel-v2__notice" role="status">
          <Icon name="warning" size={14} />
          <span>{value.notice}</span>
          <button type="button" className="work-quiet-button" onClick={() => setReadVersion(version => version + 1)}>重试读取</button>
        </div>
      ) : null}
      <div className="work-artifact-panel-v2__content work-artifact-preview" ref={previewRef}>
        {loading ? (
          <div className="work-artifact-panel-v2__loading" role="status">
            <Spinner size={16} />
            正在读取工作区文件…
          </div>
        ) : error ? (
          <div className="work-artifact-panel-v2__error" role="alert">
            {error}
            <button
              type="button"
              onClick={() => {
                setReadVersion((value) => value + 1)
              }}
            >
              重试
            </button>
          </div>
        ) : value?.isBinary ? (
          <div className="work-artifact-panel-v2__empty" role="status">
            {language} 文件 · {value.notice}
          </div>
        ) : content === null ? (
          <div className="work-artifact-panel-v2__empty">
            文件已生成，当前没有可读回执。可以添加到对话，让 AI 继续处理。
          </div>
        ) : mode === 'preview' && isMarkdown(artifact.name) ? (
          <div className="work-artifact-panel-v2__markdown">
            <Markdown
              text={content}
              fileContext={
                sessionId ? { sessionId, workspaceRoot: workspaceRoot ?? undefined } : undefined
              }
            />
          </div>
        ) : isText(artifact.name) ? (
          <div className="work-artifact-panel-v2__markdown work-artifact-panel-v2__source-markdown">
            <Markdown text={workSourceMarkdown(content, artifact.name)} />
          </div>
        ) : (
          <pre className="work-artifact-panel-v2__source">{content}</pre>
        )}
      </div>
    </section>
  )
}
