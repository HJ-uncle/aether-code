import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { readFile, readSessionFile } from '@renderer/core/workspace/fs-client'
import { getEngineSource, isEngineReady, subscribeEngineReadiness, subscribeEngineSource } from '@renderer/core/engine/source'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { Dialog } from '@renderer/ui/Dialog'
import { Icon } from '@renderer/ui/icons'
import { ImageViewerDialog } from './ImageViewerDialog'
import { FileGlyph } from '@renderer/features/explorer/FileGlyph'
import { useDocumentContextMenu } from '@renderer/core/editor/useDocumentContextMenu'
import { resolveChatPath } from './chat-file-path'
import { pastedTextLabel } from '@shared/pasted-text-label'

/** 字节数 → 人类可读（附件条上展示大小） */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 按工作区相对路径读 base64 data URL（图片缩略图 / 放大查看共用） */
export function useAttachmentImageSrc(root: string | null, file: ChatAttachment, sessionId?: string): string | null {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const ready = useSyncExternalStore(subscribeEngineReadiness, isEngineReady)
  const identity = JSON.stringify([source, ready, root, sessionId, file.path, file.type])
  const [loaded, setLoaded] = useState<{ identity: string; src: string } | null>(null)
  useEffect(() => {
    let alive = true
    // Restored drafts mount before the engine snapshot; a failed early read
    // must not leave a permanent placeholder once the connection is ready.
    if (sessionId && !ready) return
    if ((root || sessionId) && file.type.startsWith('image/')) {
      const request = sessionId ? readSessionFile(sessionId, file.path, root) : readFile(resolveChatPath(file.path, root)?.filePath ?? file.path)
      void request
        .then((result) => {
          if (alive && result.base64) setLoaded({ identity, src: `data:${file.type};base64,${result.base64}` })
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [root, file.path, file.type, sessionId, identity, ready])
  return loaded?.identity === identity ? loaded.src : null
}

/** 附件预览状态：图片带 data URL，文本附件由弹窗按路径回读内容 */
export interface AttachmentPreview {
  file: ChatAttachment
  src: string | null
}

/** Image previews share the same annotation/export surface as tool receipts. */
export function AttachmentPreviewDialog({ root, preview, onClose, images = [], onNavigate, onApply, sessionId }: {
  root: string | null
  preview: AttachmentPreview
  onClose: () => void
  images?: ChatAttachment[]
  onNavigate?: (file: ChatAttachment) => void
  onApply?: (file: File) => Promise<void>
  sessionId?: string
}): JSX.Element {
  const { file, src: initialSrc } = preview
  const isImage = file.type.startsWith('image/')
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const ready = useSyncExternalStore(subscribeEngineReadiness, isEngineReady)
  const identity = JSON.stringify([source, ready, root, sessionId, file.path, file.type])
  const [loaded, setLoaded] = useState<{ identity: string; src: string | null; text: string | null; error?: string } | null>(null)
  const textRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let active = true
    if (isImage && initialSrc) return
    if (!root && !sessionId) return
    if (sessionId && !ready) return
    const request = sessionId ? readSessionFile(sessionId, file.path, root) : readFile(resolveChatPath(file.path, root)?.filePath ?? file.path)
    void request.then(result => {
      if (active) setLoaded({ identity, src: result.base64 ? `data:${file.type};base64,${result.base64}` : null,
        error: isImage && !result.base64 ? '图片内容无法读取' : undefined,
        text: result.truncated ? `${result.content}\n\n…（内容过长已截断）` : result.content })
    }).catch(() => { if (active) setLoaded({ identity, src: null, text: '（读取失败）', error: '图片读取失败，请关闭后重试' }) })
    return () => { active = false }
  }, [root, sessionId, file.path, file.type, isImage, initialSrc, identity, ready])
  const result = loaded?.identity === identity ? loaded : null
  const { menu } = useDocumentContextMenu(textRef, { identity: file.path, path: file.path, root,
    active: !isImage && result?.text != null, getText: () => result?.text ?? '' })
  const index = images.findIndex(item => item.path === file.path)
  const title = images.length > 1 && index >= 0 ? `${file.name}（${index + 1} / ${images.length}）` : file.name
  if (isImage) return <ImageViewerDialog src={initialSrc ?? result?.src ?? null} title={file.name} onClose={onClose}
    positionLabel={images.length > 1 && index >= 0 ? `${index + 1} / ${images.length}` : undefined}
    root={root} filePath={file.path} onApply={onApply} loadError={initialSrc ? undefined : result?.error}
    onPrevious={images.length > 1 ? () => { if (index > 0) onNavigate?.(images[index - 1]) } : undefined}
    onNext={images.length > 1 ? () => { if (index >= 0 && index < images.length - 1) onNavigate?.(images[index + 1]) } : undefined}
    canPrevious={index > 0} canNext={index >= 0 && index < images.length - 1} />
  return <Dialog title={title} width={960} onClose={onClose}>
    <pre ref={textRef} tabIndex={0} className="attachment-text-preview">{result?.text ?? '加载中…'}</pre>{menu}
  </Dialog>
}

/** 附件 chip：图片只显示缩略图（点击放大），文本类可点击查看内容，其它显示图标 + 名称 */
export function AttachmentChip({
  root,
  file,
  onRemove,
  onPreview,
  sessionId,
  referenceLabel,
  disabled = false
}: {
  root: string | null
  file: ChatAttachment
  onRemove?: () => void
  onPreview: (file: ChatAttachment, src: string | null) => void
  sessionId?: string
  referenceLabel?: string
  disabled?: boolean
}): JSX.Element {
  const isImage = file.type.startsWith('image/')
  const isText =
    !isImage &&
    (file.type.startsWith('text/') ||
      /\.(txt|md|markdown|json|jsonc|log|csv|tsv|xml|ya?ml|toml|ini)$/i.test(file.name))
  const src = useAttachmentImageSrc(root, file, sessionId)
  const pastedLabel = pastedTextLabel(file.name, file.type)

  if (isImage) {
    return (
      <span className="attach-chip attach-chip--image" title={file.path}>
        <button
          type="button"
          className="attach-chip__image-btn"
          title={`点击查看 ${file.name}`}
          aria-label={`查看 ${file.name}`}
          onClick={() => onPreview(file, src)}
        >
          {src ? <img className="attach-chip__thumb" src={src} alt={file.name} draggable={false} /> : <Icon name="image" size={18} />}
        </button>
        {referenceLabel ? <span className="attach-chip__reference attach-chip__reference--image">{referenceLabel}</span> : null}
        {onRemove ? (
          <button
            type="button"
            className="attach-chip__remove"
            title="移除附件"
            aria-label={`移除附件 ${file.name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </span>
    )
  }

  const body = (
    <>
      {isImage ? <Icon name="image" size={16} /> : <FileGlyph name={file.name} mimeType={file.type} />}
      {referenceLabel && !pastedLabel ? <span className="attach-chip__reference">{referenceLabel}</span> : null}
      <span className="attach-chip__name">{pastedLabel ?? file.name}</span>
      {file.size > 0 ? <span className="attach-chip__size">{formatAttachmentBytes(file.size)}</span> : null}
    </>
  )

  return (
    <span className={`attach-chip${isText || isImage ? ' attach-chip--clickable' : ''}`} title={file.path}>
      {isText || isImage ? (
        <button
          type="button"
          className="attach-chip__open"
          title={pastedLabel ? `${file.name}\n长文本已折叠，点击查看全文` : `查看 ${file.name}`}
          onClick={() => onPreview(file, null)}
        >
          {body}
        </button>
      ) : (
        <>{body}</>
      )}
      {onRemove ? (
        <button
          type="button"
          className="attach-chip__remove"
          title="移除附件"
          aria-label={`移除附件 ${file.name}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </span>
  )
}
