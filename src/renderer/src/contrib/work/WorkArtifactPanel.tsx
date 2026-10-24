import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { WorkArtifact } from './work-state'
import { isWorkspaceRecoveryPath, readFile, readLocalRecoveryFile, readSessionFile, saveSessionFile, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { openFileFromChat } from '@renderer/contrib/chat/open-file'
import { Markdown } from '@renderer/contrib/chat/Markdown'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
import { toast } from '@renderer/core/toast'
import { workSourceMarkdown } from './work-artifact-utils'
import { getEngineSource, isRemoteEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { workArtifactExportName, workArtifactReadFailure, workArtifactReadResult, type WorkArtifactContent } from './work-artifact-content'
import { FileGlyph } from '../explorer/FileGlyph'
import './work-artifact-panel.css'
import type { FsFileContent } from '@shared/ipc'
import { FilePreview } from '../editor/FilePreview'

export interface WorkArtifactPanelProps {
  artifact: WorkArtifact | null
  workspaceRoot?: string | null
  sessionId?: string
  onAddToConversation?: (artifact: WorkArtifact, selection?: string, selectionCoverage?: WorkArtifactContent['coverage']) => void
  onOpenFile?: (artifact: WorkArtifact) => void
  artifacts?: WorkArtifact[]
  onSelect?: (id: string) => void
  inResourceTab?: boolean
  /** File supplied by the desktop picker/drop target. It never enters the
   * engine workspace and is read only when this panel is visible. */
  externalFile?: File
  /** Absolute local path for a read-only resource opened outside the current
   * task workspace. */
  externalPath?: string
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
  sessionId: string | undefined,
  workspaceRoot: string | null | undefined,
  allowExternal = false
): Promise<FsFileContent> {
  // A normal Work receipt is always read through its authenticated session.
  // Only a resource explicitly opened outside that session may use the
  // read-only local bridge; this keeps model-supplied paths from becoming an
  // implicit arbitrary-file read.
  if (sessionId) {
    try { return await readSessionFile(sessionId, path, workspaceRoot) } catch (error) {
      // A local Work task may have been admitted with a project root that the
      // engine's authenticated workspace binder does not know yet (for
      // example a restored campaign root).  The root comes from the user's
      // task selection, so a read-only bounded fallback keeps previews usable
      // without turning a model-supplied path into an arbitrary disk read.
      if (!isRemoteEngine() && isWorkspaceRecoveryPath(path, workspaceRoot)) {
        try { return await readLocalRecoveryFile(path) } catch { /* retain the session error below */ }
      }
      if (!allowExternal || isRemoteEngine()) throw error
    }
  }
  if (allowExternal && !isRemoteEngine()) return readLocalRecoveryFile(path)
  return readFile(path)
}

function externalArtifactCandidates(filePath: string, workspaceRoot?: string | null): string[] {
  return workspaceRecoveryCandidates(filePath, workspaceRoot)
}

const MAX_EXTERNAL_BYTES = 32 * 1024 * 1024
const MAX_EXTERNAL_TEXT_BYTES = 4 * 1024 * 1024

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return btoa(binary)
}

async function readExternalFile(file: File): Promise<FsFileContent> {
  if (file.size > MAX_EXTERNAL_BYTES) return {
    path: file.name, content: '', isBinary: true, size: file.size, truncated: false, tooLarge: true
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sample = bytes.subarray(0, Math.min(8192, bytes.length))
  const isBinary = sample.includes(0)
  if (isBinary) return {
    path: file.name, content: '', base64: encodeBase64(bytes), isBinary: true, size: file.size, truncated: false
  }
  const truncated = bytes.length > MAX_EXTERNAL_TEXT_BYTES
  const text = new TextDecoder().decode(truncated ? bytes.subarray(0, MAX_EXTERNAL_TEXT_BYTES) : bytes)
    .replace(/^\uFEFF/, '')
  return { path: file.name, content: text, isBinary: false, size: file.size, truncated }
}

/** Work's artifact surface is deliberately session-scoped: a receipt may be stale,
 * so preview reads the workspace before falling back to the receipt content. */
export function WorkArtifactPanel(props: WorkArtifactPanelProps): JSX.Element {
  const epoch = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  // Remount at an identity change so old content and selections never become
  // actionable during the first render of another task or engine connection.
  return <ArtifactContent key={JSON.stringify([epoch, props.sessionId, props.workspaceRoot, props.externalPath, props.externalFile?.name, props.artifact?.id, props.artifact?.path])} {...props} epoch={epoch} />
}

function ArtifactContent({
  artifact,
  workspaceRoot,
  sessionId,
  onAddToConversation,
  onOpenFile,
  artifacts = [],
  onSelect,
  inResourceTab = false,
  externalFile,
  externalPath,
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
    const readWithRetry = async (reader: () => Promise<FsFileContent>): Promise<FsFileContent> => {
      let last: unknown
      // Files can be in the middle of an async write when a resource tab is
      // opened. Retry a couple of times so a transient read race never forces
      // the user to discover and press the refresh button themselves.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await reader()
        } catch (reason) {
          last = reason
          if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 120 * (attempt + 1)))
          if (!active) throw reason
        }
      }
      throw last ?? new Error('读取文件失败')
    }
    if (externalFile) {
      void readWithRetry(() => readExternalFile(externalFile))
        .then((result) => {
          if (active && epoch === getEngineSource()) setRead({ receipt: artifact.content, value: workArtifactReadResult(result) })
        })
        .catch((reason: unknown) => {
          if (active && epoch === getEngineSource()) setRead({ receipt: artifact.content, value: workArtifactReadFailure(artifact.content, reason) })
        })
      return () => { active = false }
    }
    // Always try the authenticated session path first.  A receipt can point
    // at a valid session file outside the selected project root (for example
    // after restoring a task or switching projects), while the local recovery
    // candidates intentionally filter paths that are outside that root.  The
    // session reader remains the security boundary; recovery paths are only
    // fallbacks for a local engine whose workspace binder is not ready yet.
    const candidates = externalPath
      ? [externalPath]
      : [artifact.path, ...externalArtifactCandidates(artifact.path, workspaceRoot)]
    const load = async (): Promise<FsFileContent> => {
      let last: unknown
      for (const candidate of candidates) {
        try {
          return await readWorkFile(candidate, externalPath ? undefined : sessionId, workspaceRoot, Boolean(externalPath))
        } catch (error) { last = error }
      }
      throw last ?? new Error('文件不在当前工作区。请使用“打开文件”或将文件拖到资源栏。')
    }
    void readWithRetry(load)
      .then((result) => {
        if (active && epoch === getEngineSource()) setRead({ receipt: artifact.content, value: workArtifactReadResult(result) })
      })
      .catch((reason: unknown) => {
        if (active && epoch === getEngineSource()) setRead({ receipt: artifact.content, value: workArtifactReadFailure(artifact.content, reason) })
      })
    return () => {
      active = false
    }
  }, [artifact?.id, artifact?.path, artifact?.content, workspaceRoot, sessionId, externalFile, externalPath, readVersion, epoch])

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
    if (value?.isBinary && sessionId && !externalFile && !externalPath) {
      setSaving(true)
      try {
        const saved = await saveSessionFile(sessionId, artifact.path, workspaceRoot)
        if (mounted.current && epoch === getEngineSource() && saved.saved) toast.success('原文件已保存')
      } catch (reason: unknown) {
        if (mounted.current && epoch === getEngineSource()) toast.error(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (mounted.current) setSaving(false)
      }
      return
    }
    if (value?.isBinary && (externalFile || externalPath)) {
      if (!value.base64) return
      const bytes = Uint8Array.from(atob(value.base64), char => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = artifact.name
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
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
    <section className="work-artifact-panel-v2" aria-label="成果预览" data-document-session={sessionId} data-document-path={artifact.path} data-resource-tab={inResourceTab ? 'true' : 'false'}>
      {!inResourceTab ? <header className="work-artifact-panel-v2__header work-artifact-select">
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
      </header> : null}
      <div className="work-artifact-panel-v2__toolbar">
        {!inResourceTab && <button
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
          打开文档标签
        </button>}
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
          disabled={saving || (content === null && !(value?.isBinary && (externalFile || externalPath ? Boolean(value.base64) : Boolean(sessionId))))}
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
      <div className={`work-artifact-panel-v2__content work-artifact-preview${value?.base64 ? ' work-artifact-panel-v2__content--document' : ''}`} ref={previewRef}>
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
        ) : value?.isBinary && value.base64 ? (
          <FilePreview name={artifact.name} path={artifact.path} base64={value.base64} size={value.size ?? 0} />
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
