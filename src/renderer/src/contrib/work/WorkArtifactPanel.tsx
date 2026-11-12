import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { WorkArtifact } from './work-state'
import { isWorkspaceRecoveryPath, paths, readFile, readLocalRecoveryFile, readSessionFile, saveSessionFile, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { openFileFromChat } from '@renderer/contrib/chat/open-file'
import { Markdown } from '@renderer/contrib/chat/Markdown'
import { Icon } from '@renderer/workbench/icons'
import { IconButton, Spinner } from '@renderer/workbench/ui-primitives'
import { toast } from '@renderer/core/toast'
import { getEngineSource, isEngineReady, isRemoteEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { workArtifactExportName, workArtifactReadFailure, workArtifactReadResult, type WorkArtifactContent } from './work-artifact-content'
import './work-artifact-panel.css'
import type { FsFileContent } from '@shared/ipc'
import { hasBinaryFileSignature, hasOfficeFileSignature } from '@shared/file-signature'
import { FilePreview } from '../editor/FilePreview'
import { FileGlyph } from '../explorer/FileGlyph'
import { isLargeWorkText } from './WorkTextPreview'
import { WorkCodePreview } from './WorkCodePreview'
import type { Mention } from '../chat/mention-context'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import { readWorkFileCached } from './work-file-read-cache'
import { subscribeWorkPreview, workPreviewRevision } from '@renderer/core/workbench/preview-request'
import { observePreviewSelection } from '@renderer/contrib/documents/document-selection'
import { runHtmlFile } from '../editor/run-html'
import { browserAction } from '../browser/browser-store'
import { DocumentMenuProvider, useDocumentContextMenu, type DocumentMenuOptions } from '@renderer/core/editor/useDocumentContextMenu'

export interface WorkArtifactPanelProps {
  artifact: WorkArtifact | null
  workspaceRoot?: string | null
  sessionId?: string
  onAddToConversation?: (artifact: WorkArtifact, selection?: string, selectionCoverage?: WorkArtifactContent['coverage'], reference?: Mention) => void
  onOpenFile?: (artifact: WorkArtifact) => void
  artifacts?: WorkArtifact[]
  onSelect?: (id: string) => void
  inResourceTab?: boolean
  /** Retained Work previews stay mounted but stop background interaction work. */
  active?: boolean
  reveal?: TextPreviewReveal
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
  const isBinary = hasBinaryFileSignature(sample)
  if (isBinary) return {
    path: file.name, content: '',
    ...(hasOfficeFileSignature(sample, file.name) ? { bytes: bytes.buffer as ArrayBuffer } : { base64: encodeBase64(bytes) }),
    isBinary: true, size: file.size, truncated: false
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
  inResourceTab = false,
  active = true,
  reveal,
  externalFile,
  externalPath,
  epoch
}: WorkArtifactPanelProps & { epoch: number }): JSX.Element {
  const [readVersion, setReadVersion] = useState(0)
  const previousReadVersion = useRef(-1)
  const requestRevision = useSyncExternalStore(subscribeWorkPreview, () => workPreviewRevision(epoch, sessionId, artifact?.path, workspaceRoot))
  const previousRequestRevision = useRef(0)
  const readKey = `${artifact?.content ?? ''}:${readVersion}:${requestRevision}`
  const [read, setRead] = useState<{ receipt: string; value: WorkArtifactContent | null; path?: string }>({ receipt: readKey, value: null })
  const value = artifact && !artifact.path
    ? { content: null, coverage: 'unavailable' as const, notice: '该成果没有有效的文件路径，无法读取。' }
    : read.receipt === readKey ? read.value : null
  const content = value?.content ?? null
  const loading = Boolean(artifact && !value)
  const error = value?.coverage === 'unavailable' && !value.isBinary ? value.notice : ''
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const mounted = useRef(true)
  const [mode, setMode] = useState<'preview' | 'source'>(reveal ? 'source' : 'preview')
  const [selection, setSelection] = useState('')
  const [codeSelections, setCodeSelections] = useState<Mention[]>([])
  const sourcePreview = content !== null && !value?.isBinary && Boolean(artifact) &&
    (isLargeWorkText(content) || mode !== 'preview' || !isMarkdown(artifact!.name))
  const previewRef = useRef<HTMLDivElement>(null)
  const documentMenu: DocumentMenuOptions = {
    identity: `${epoch}:${sessionId}:${artifact?.id}`,
    path: read.path ?? artifact?.path, root: workspaceRoot,
    active: active && !loading && !error && artifact?.status !== 'deleted',
    onAddFile: onAddToConversation ? () => {
      if (artifact && active && epoch === getEngineSource()) onAddToConversation({ ...artifact, content: null })
    } : undefined,
    onAddSelection: onAddToConversation ? text => {
      if (artifact && active && epoch === getEngineSource()) onAddToConversation({ ...artifact, content: null }, text, value?.coverage)
    } : undefined
  }
  const { menu: documentContextMenu } = useDocumentContextMenu(previewRef, documentMenu)

  useEffect(() => {
    // A search hit refers to source coordinates. Only a new request changes
    // mode, so the user can still return to the rendered preview afterwards.
    if (reveal) setMode('source')
  }, [reveal?.revision])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    if (artifact?.status === 'deleted') return () => { active = false }
    if (!artifact || !artifact.path) {
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
    const cacheKey = JSON.stringify([epoch, sessionId, workspaceRoot, externalPath, externalFile?.name, externalFile?.size, externalFile?.lastModified, artifact?.id, artifact?.path, artifact?.content])
    const refresh = (readVersion > 0 && readVersion > previousReadVersion.current) || requestRevision > previousRequestRevision.current
    previousReadVersion.current = readVersion
    previousRequestRevision.current = requestRevision
    if (externalFile) {
      void readWorkFileCached(cacheKey, () => readWithRetry(() => readExternalFile(externalFile)), refresh)
        .then((result) => {
          if (active && epoch === getEngineSource()) setRead({ receipt: readKey, value: workArtifactReadResult(result) })
        })
        .catch((reason: unknown) => {
          if (active && epoch === getEngineSource()) setRead({ receipt: readKey, value: workArtifactReadFailure(artifact.content, reason) })
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
    void readWorkFileCached(cacheKey, () => readWithRetry(load), refresh)
      .then((result) => {
        if (active && epoch === getEngineSource()) setRead({ receipt: readKey, value: workArtifactReadResult(result), path: result.path })
      })
      .catch((reason: unknown) => {
        if (active && epoch === getEngineSource()) setRead({ receipt: readKey, value: workArtifactReadFailure(artifact.content, reason) })
      })
    return () => {
      active = false
    }
  }, [artifact?.id, artifact?.path, artifact?.content, artifact?.status, workspaceRoot, sessionId, externalFile, externalPath, readVersion, requestRevision, epoch])

  const language = useMemo(
    () => artifact?.name.split('.').pop()?.toUpperCase() ?? 'TEXT',
    [artifact?.name]
  )

  useEffect(() => {
    setSelection('')
    setCodeSelections([])
    return active && !sourcePreview && previewRef.current ? observePreviewSelection(previewRef.current, setSelection) : undefined
  }, [artifact?.id, active, readKey, mode, sourcePreview])

  if (!artifact)
    return (
      <div className="work-artifact-panel-v2 work-artifact-panel-v2--empty">
        <Icon name="file" size={22} />
        <strong>成果会出现在这里</strong>
        <span>AI 创建或修改文件后，可在此预览、复制或继续引用。</span>
      </div>
    )

  if (artifact.status === 'deleted') return (
    <section className="work-artifact-panel-v2 work-artifact-panel-v2--empty" aria-label="已删除的成果" data-document-session={sessionId} data-document-path={artifact.path}>
      <FileGlyph name={artifact.path || artifact.name} size={22} />
      <strong>{artifact.name} 已删除</strong>
      <span>保留生成记录，当前文件已删除。</span>
    </section>
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
      if (!value.base64 && !value.bytes) return
      const bytes = value.bytes ? new Uint8Array(value.bytes.slice(0)) : Uint8Array.from(atob(value.base64!), char => char.charCodeAt(0))
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
    if (!active || epoch !== getEngineSource()) return
    if (sourcePreview && codeSelections.length) {
      for (const reference of codeSelections) addCodeReference(reference)
      return
    }
    // A whole-file reference resolves its path at the next send. Never inject
    // the receipt bytes as though they were the successfully read version.
    onAddToConversation?.({ ...artifact, content: null }, sourcePreview ? undefined : selection || undefined, !sourcePreview && selection ? value?.coverage : undefined)
  }
  const addCodeReference = (reference?: Mention): void => {
    if (!active || epoch !== getEngineSource()) return
    const suffix = value?.coverage === 'receipt' ? '（历史回执）' : value?.coverage === 'partial' ? '（预览片段）' : ''
    const quoted = reference && suffix ? { ...reference, displayText: `${reference.displayText}${suffix}` } : reference
    onAddToConversation?.({ ...artifact, content: null }, reference?.content, reference ? value?.coverage : undefined, quoted)
  }
  // Use the file that actually satisfied the preview read, including a bounded
  // local recovery, rather than the possibly stale path in a write receipt.
  const runPath = read.receipt === readKey ? read.path : undefined
  const runRoot = runPath && workspaceRoot && paths.contains(workspaceRoot, runPath)
    ? workspaceRoot : runPath ? paths.dirname(runPath) : undefined
  const canRun = /\.html?$/i.test(artifact.name) && !externalFile && !isRemoteEngine()
  const referenceLabel = '添加到对话'
  const copyLabel = value?.coverage === 'partial' ? '复制片段' : value?.coverage === 'receipt' ? '复制回执' : '复制'
  const saveLabel = saving ? '正在保存…' : value?.isBinary ? '保存原文件' : value?.coverage === 'partial' ? '保存预览片段' : value?.coverage === 'receipt' ? '保存历史回执' : '保存副本'
  return (
    <section className="work-artifact-panel-v2" aria-label="成果预览" data-document-session={sessionId} data-document-path={artifact.path} data-document-active={active ? 'true' : 'false'} data-workbench-request={requestRevision} data-file-read-status={loading ? 'loading' : value?.coverage ?? 'unavailable'} data-resource-tab={inResourceTab ? 'true' : 'false'} data-producer-child-session={artifact.producerChildSessionId} data-producer-run={artifact.producerRunId}>
      <div className="work-artifact-panel-v2__toolbar" role="group" aria-label="文件预览操作">
        {canRun ? <button type="button" className="work-artifact-panel-v2__action work-artifact-panel-v2__action--primary"
          aria-label="在浏览器中运行" title="在当前任务浏览器中运行 HTML"
          disabled={!active || loading || running || !runPath || !runRoot || value?.coverage !== 'current'}
          onClick={() => browserAction(async () => {
            if (runningRef.current || !runPath || !runRoot || epoch !== getEngineSource()) return
            runningRef.current = true
            setRunning(true)
            try { await runHtmlFile({ path: runPath, root: runRoot,
              sessionId: !externalPath && isEngineReady() ? sessionId : undefined }) }
            finally { runningRef.current = false; if (mounted.current) setRunning(false) }
          })}>
          {running ? <Spinner size={14} /> : <Icon name="play" size={14} />}<span className="work-artifact-panel-v2__action-label">{running ? '正在打开…' : '运行'}</span>
        </button> : null}
        <button type="button" className="work-artifact-panel-v2__action work-artifact-panel-v2__action--primary work-artifact-panel-v2__action--reference"
          aria-label={referenceLabel} title={referenceLabel}
          onPointerDown={event => { if (selection || codeSelections.length) event.preventDefault() }}
          onClick={addReference} disabled={!active || !onAddToConversation || !artifact.path}>
          <Icon name="plus" size={14} /><span className="work-artifact-panel-v2__action-label">添加到对话</span>
        </button>
        {isMarkdown(artifact.name) ? <div className="work-artifact-panel-v2__modes" role="group" aria-label="文件显示方式">
          <button type="button" aria-label="预览" title="预览" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
            <Icon name="eye-outline" size={14} /><span className="work-artifact-panel-v2__mode-label">预览</span>
          </button>
          <button type="button" aria-label={language} title="查看 Markdown 源码" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
            {language}
          </button>
        </div> : null}
        <div className="work-artifact-panel-v2__file-actions">
          {!inResourceTab && <IconButton icon="file" size={14} label="在资源中打开" title="在资源中打开"
            className="work-artifact-panel-v2__action"
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
          />}
          <IconButton icon="refresh" size={14} label="刷新成果预览"
            className="work-artifact-panel-v2__action"
            onClick={() => { if (epoch === getEngineSource()) setReadVersion(value => value + 1) }}
            disabled={loading || !artifact.path}
            title="重新读取文件，更新预览"
          />
          <IconButton icon="copy" size={14} label={copyLabel} title={copyLabel}
            className="work-artifact-panel-v2__action" onClick={() => void copy()} disabled={content === null} />
          <IconButton icon="download" size={14} label={saveLabel} title={saveLabel}
            className="work-artifact-panel-v2__action"
            onClick={() => void download()}
            disabled={saving || (content === null && !(value?.isBinary && (externalFile || externalPath ? Boolean(value.base64 || value.bytes) : Boolean(sessionId))))}
          />
        </div>
      </div>
      {value && value.coverage !== 'current' && value.coverage !== 'unavailable' ? (
        <div className="work-artifact-panel-v2__notice" role="status">
          <Icon name="warning" size={14} />
          <span>{value.notice}</span>
          <button type="button" className="work-quiet-button" onClick={() => setReadVersion(version => version + 1)}>重试读取</button>
        </div>
      ) : null}
      <DocumentMenuProvider value={documentMenu}><div className={`work-artifact-panel-v2__content work-artifact-preview${value?.base64 || value?.bytes ? ' work-artifact-panel-v2__content--document' : ''}`} ref={previewRef} tabIndex={0}>
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
        ) : value?.isBinary && (value.base64 || value.bytes) ? (
          <FilePreview name={artifact.name} path={read.path ?? artifact.path} base64={value.base64} bytes={value.bytes} size={value.size ?? 0} active={active} />
        ) : value?.isBinary ? (
          <div className="work-artifact-panel-v2__empty" role="status">
            {language} 文件 · {value.notice}
          </div>
        ) : content === null ? (
          <div className="work-artifact-panel-v2__empty">
            文件已生成，当前没有可读回执。可以添加到对话，让 AI 继续处理。
          </div>
        ) : !isLargeWorkText(content) && mode === 'preview' && isMarkdown(artifact.name) ? (
          <div className="work-artifact-panel-v2__markdown">
            <Markdown
              text={content}
              fileContext={
                sessionId ? { sessionId, workspaceRoot: workspaceRoot ?? undefined } : undefined
              }
            />
          </div>
        ) : (
          <WorkCodePreview key={`${artifact.id}:${readVersion}`} content={content} name={artifact.name}
            path={read.path ?? artifact.path} origin={inResourceTab ? 'workspace' : 'artifact'} reveal={reveal} active={active}
            onSelectionChange={setCodeSelections} onAddToConversation={onAddToConversation ? addCodeReference : undefined} />
        )}
      </div></DocumentMenuProvider>
      {documentContextMenu}
    </section>
  )
}
