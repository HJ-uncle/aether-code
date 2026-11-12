import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { FsFileContent } from '@shared/ipc'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { getEngineSource, isEngineReady, isRemoteEngine, subscribeEngineReadiness, subscribeEngineSource } from '@renderer/core/engine/source'
import { readFile, readLocalRecoveryFile, readSessionFile, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { TextPreview } from '@renderer/core/editor/TextPreview'
import { FilePreview } from '../editor/FilePreview'
import { fileContentUrl } from '@renderer/core/workspace/file-content-bytes'
import { DocumentMenuProvider, useDocumentContextMenu } from '@renderer/core/editor/useDocumentContextMenu'
import { resolveChatPath } from '../conversation/shared/chat-file-path'
import { ImageViewerDialog } from '../conversation/shared/ImageViewerDialog'

/** The task owns uploaded files even when the user has not opened a project. */
export function useSessionSourceFile(source: ChatAttachment, sessionId?: string, root?: string | null, enabled = true) {
  const epoch = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const ready = useSyncExternalStore(subscribeEngineReadiness, isEngineReady)
  const key = JSON.stringify([epoch, ready, sessionId, root, source.path, source.type, enabled])
  const [attempt, retry] = useState(0)
  const [state, setState] = useState<{ key: string; file?: FsFileContent; error?: string }>({ key })
  useEffect(() => {
    let active = true
    setState({ key })
    if (!enabled || (sessionId && !ready)) return () => { active = false }
    const request = sessionId ? readSessionFile(sessionId, source.path, root).catch(async (reason: unknown) => {
      if (isRemoteEngine() || !root) throw reason
      const candidates = workspaceRecoveryCandidates(source.path, root)
      for (const candidate of candidates) {
        try { return await readLocalRecoveryFile(candidate) } catch { /* try the next bounded root */ }
      }
      throw reason
    })
      : root ? readFile(resolveChatPath(source.path, root)?.filePath ?? source.path)
        : Promise.reject(new Error('资料没有关联任务，请重新选择任务'))
    void request.then(file => {
      if (active && epoch === getEngineSource()) setState({ key, file })
    }).catch((reason: unknown) => {
      if (active && epoch === getEngineSource()) setState({ key, error: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { active = false }
  }, [key, epoch, ready, sessionId, root, source.path, enabled, attempt])
  return { ...(state.key === key ? state : { key }), retry: () => retry(value => value + 1) }
}

/** Inline references and attachment cards share the full image viewing and editing surface. */
export function SessionSourceImageDialog({ source, sessionId, root, onClose, onApply, images = [], onNavigate }: {
  source: ChatAttachment
  sessionId?: string
  root: string | null
  onClose: () => void
  onApply?: (file: File) => Promise<void>
  images?: ChatAttachment[]
  onNavigate?: (source: ChatAttachment) => void
}): JSX.Element {
  const { file, error } = useSessionSourceFile(source, sessionId, root)
  const image = useMemo(() => file ? fileContentUrl(file, source.type) : null, [file, source.type])
  useEffect(() => () => image?.revoke(), [image])
  const index = images.findIndex(item => item.path === source.path)
  return <ImageViewerDialog src={image?.url ?? null} title={source.name} root={root} filePath={source.path}
    loadError={error || (file?.tooLarge ? '图片超过当前读取上限' : file && !image ? '图片内容无法读取' : undefined)}
    onClose={onClose} onApply={onApply}
    positionLabel={images.length > 1 && index >= 0 ? `${index + 1} / ${images.length}` : undefined}
    onPrevious={onNavigate && images.length > 1 ? () => { if (index > 0) onNavigate(images[index - 1]) } : undefined}
    onNext={onNavigate && images.length > 1 ? () => { if (index >= 0 && index < images.length - 1) onNavigate(images[index + 1]) } : undefined}
    canPrevious={index > 0} canNext={index >= 0 && index < images.length - 1} />
}

interface SourcePreviewProps {
  source: ChatAttachment
  sessionId?: string
  root: string | null
  onAddFile?: () => void
  onAddSelection?: (text: string) => void
}

export function SourcePreview(props: SourcePreviewProps): JSX.Element {
  return <DocumentMenuProvider value={{ identity: `${props.sessionId}:${props.source.path}`, path: props.source.path,
    root: props.root, onAddFile: props.onAddFile, onAddSelection: props.onAddSelection }}>
    <SourcePreviewContent {...props} />
  </DocumentMenuProvider>
}

function SourcePreviewContent({ source, sessionId, root }: SourcePreviewProps): JSX.Element | null {
  const imageRef = useRef<HTMLImageElement>(null)
  const { menu } = useDocumentContextMenu(imageRef)
  const { file, error, retry } = useSessionSourceFile(source, sessionId, root)
  const isImage = source.type.startsWith('image/')
  const image = useMemo(() => file && isImage ? fileContentUrl(file, source.type) : null, [file, isImage, source.type])
  useEffect(() => () => image?.revoke(), [image])
  const unavailable = error || (file?.tooLarge ? '文件超过当前预览读取上限。' : '') || (file?.isBinary && !file.base64 && !file.bytes ? '未能读取完整文件，请重试。' : '')
  if (unavailable) return <div className="work-sources__preview-empty" role="alert">
    <Icon name="alert-circle" size={18} />
    <span>{unavailable}</span>
    <button type="button" className="work-quiet-button" onClick={retry}>重试读取</button>
  </div>
  if (!file) return <div className="work-sources__preview-empty" role="status">
    <Spinner size={16} /><span>{isImage ? '正在读取图片…' : '正在读取文件…'}</span>
  </div>
  if (isImage) return image ? <><img ref={imageRef} tabIndex={0} className="work-sources__preview-image" src={image.url} alt={source.name} />{menu}</> : null
  if (file.isBinary && (file.base64 || file.bytes)) return <FilePreview name={source.name} path={source.path} base64={file.base64} bytes={file.bytes} size={file.size} />
  const text = file.truncated ? `${file.content}\n\n…（内容过长已截断）` : file.content
  return <div className="work-sources__preview-text"><TextPreview content={text} name={source.name} /></div>
}
