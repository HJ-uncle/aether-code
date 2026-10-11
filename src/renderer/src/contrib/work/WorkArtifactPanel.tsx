import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { WorkArtifact } from './work-state'
import { paths, readFile, readSessionFile } from '@renderer/core/workspace/fs-client'
import { openFileFromChat } from '@renderer/contrib/chat/open-file'
import { Markdown } from '@renderer/contrib/chat/Markdown'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
import { toast } from '@renderer/core/toast'
import { workSourceMarkdown } from './work-artifact-utils'
import { FileGlyph } from '../explorer/FileGlyph'
import './work-artifact-panel.css'

export interface WorkArtifactPanelProps {
  artifact: WorkArtifact | null
  workspaceRoot?: string | null
  sessionId?: string
  onAddToConversation?: (artifact: WorkArtifact, selection?: string) => void
  onOpenFile?: (artifact: WorkArtifact) => void
  onOpenChanges?: () => void
  artifacts?: WorkArtifact[]
  onSelect?: (id: string) => void
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}
function isText(name: string): boolean {
  return /\.(txt|json|ya?ml|xml|tsx?|jsx?|css|scss|less|html?|svg|py|go|rs|java|c|cpp|h|sh|sql|toml|ini|env)$/i.test(
    name
  )
}

async function readWorkFile(
  path: string,
  sessionId: string | undefined
): Promise<{ content: string; isBinary: boolean; truncated?: boolean; tooLarge?: boolean }> {
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
export function WorkArtifactPanel({
  artifact,
  workspaceRoot,
  sessionId,
  onAddToConversation,
  onOpenFile,
  onOpenChanges,
  artifacts = [],
  onSelect
}: WorkArtifactPanelProps): JSX.Element {
  const [content, setContent] = useState<string | null>(artifact?.content ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [selection, setSelection] = useState('')
  const [readVersion, setReadVersion] = useState(0)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    setContent(artifact?.content ?? null)
    setError('')
    setSelection('')
    setMode(artifact && isMarkdown(artifact.name) ? 'preview' : 'source')
    if (!artifact || !artifact.path)
      return () => {
        active = false
      }
    setLoading(true)
    const readPath = /^(?:[A-Za-z]:[\\/]|\/)/.test(artifact.path)
      ? artifact.path
      : workspaceRoot
        ? paths.join(workspaceRoot, artifact.path)
        : artifact.path
    void readWorkFile(readPath, sessionId)
      .then((result) => {
        if (!active) return
        if (result.isBinary) {
          setError('二进制文件无法在此预览')
        } else if (typeof result.content === 'string') {
          setContent(result.content)
        } else if (artifact.content === null) {
          setError('工作区返回了无效的文件内容')
        }
      })
      .catch((reason: unknown) => {
        // The engine write receipt remains a valid first frame while the workspace
        // is still settling; only show the read error when there is no receipt to use.
        if (active && artifact.content === null)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [artifact?.id, artifact?.path, artifact?.content, workspaceRoot, sessionId, readVersion])

  const canRender = Boolean(
    artifact && content !== null && (isMarkdown(artifact.name) || isText(artifact.name))
  )
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
    if (content === null) return
    try {
      if (!navigator.clipboard) throw new Error('当前环境不支持复制')
      await navigator.clipboard.writeText(content)
      toast.success('已复制文件内容')
    } catch (reason: unknown) {
      toast.error(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const download = (): void => {
    if (content === null) return
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = artifact.name
    link.click()
    URL.revokeObjectURL(url)
  }
  const addReference = (): void => {
    onAddToConversation?.(artifact, selection || undefined)
    if (onAddToConversation) toast.success(selection ? '已引用选中内容' : '已添加到对话')
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
          onClick={() =>
            onOpenFile
              ? onOpenFile(artifact)
              : void openFileFromChat(
                  artifact.path,
                  sessionId ? { sessionId, workspaceRoot: workspaceRoot ?? undefined } : undefined
                ).catch((reason: unknown) =>
                  toast.error(reason instanceof Error ? reason.message : String(reason))
                )
          }
        >
          <Icon name="file" size={14} />
          在编辑器打开
        </button>
        <button
          type="button"
          className="work-quiet-button"
          onClick={addReference}
          disabled={!onAddToConversation}
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
          复制
        </button>
        <button
          type="button"
          className="work-quiet-button"
          onClick={download}
          disabled={content === null}
        >
          <Icon name="cloud-download-outline" size={14} />
          下载
        </button>
        {(canRender || onOpenChanges) && (
          <div className="work-artifact-panel-v2__modes">
            {canRender ? <>
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
            {onOpenChanges ? <button type="button" onClick={onOpenChanges}>文件改动</button> : null}
          </div>
        )}
      </div>
      <div className="work-artifact-panel-v2__content work-artifact-preview" ref={previewRef}>
        {loading ? (
          <div className="work-artifact-panel-v2__loading">
            <Spinner size={16} />
            正在读取工作区文件…
          </div>
        ) : error ? (
          <div className="work-artifact-panel-v2__error">
            {error}
            <button
              type="button"
              onClick={() => {
                setError('')
                setReadVersion((value) => value + 1)
              }}
            >
              重试
            </button>
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
