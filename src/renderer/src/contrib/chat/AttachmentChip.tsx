import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { paths, readFile } from '@renderer/core/workspace/fs-client'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { toast } from '@renderer/core/toast'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon, type IconName } from '@renderer/workbench/icons'

/** 字节数 → 人类可读（附件条上展示大小） */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 按工作区相对路径读 base64 data URL（图片缩略图 / 放大查看共用） */
export function useAttachmentImageSrc(root: string | null, file: ChatAttachment): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (root && file.type.startsWith('image/')) {
      void readFile(`${root}/${file.path}`)
        .then((result) => {
          if (alive && result.base64) setSrc(`data:${file.type};base64,${result.base64}`)
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [root, file.path, file.type])
  return src
}

/** 附件预览状态：图片带 data URL，文本附件由弹窗按路径回读内容 */
export interface AttachmentPreview {
  file: ChatAttachment
  src: string | null
}

const MIN_SCALE = 0.1
const MAX_SCALE = 10
const ZOOM_STEP = 0.2

/** data URL → Uint8Array */
function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** data URL 的 MIME（复制图片时区分 png/jpeg 等） */
function dataUrlMime(dataUrl: string, fallback: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1] ?? (fallback || 'image/png')
}

/**
 * 企业级图片查看器（对齐 Code 模式文件预览的交互）：
 * 缩放（滚轮/按钮/+/-）、拖拽平移、双击复位、适应窗口、100%、旋转、
 * 复制图片、另存为、左右翻页（多图时）、键盘快捷键。
 * 非图片附件回退为文本内容查看。
 */
export function AttachmentPreviewDialog({
  root,
  preview,
  onClose,
  images = [],
  onNavigate
}: {
  root: string | null
  preview: AttachmentPreview
  onClose: () => void
  /** 同组图片附件（用于左右翻页）；为空则不显示翻页 */
  images?: ChatAttachment[]
  onNavigate?: (file: ChatAttachment) => void
}): JSX.Element {
  const { file, src: initialSrc } = preview
  const isImage = file.type.startsWith('image/')
  const [text, setText] = useState<string | null>(null)

  // 图片源：翻页后 initialSrc 可能为 null（新图），需要按路径回读
  const [loadedSrc, setLoadedSrc] = useState<string | null>(initialSrc)
  useEffect(() => {
    setLoadedSrc(initialSrc)
  }, [initialSrc, file.path])
  useEffect(() => {
    let alive = true
    if (isImage && root && !initialSrc) {
      void readFile(`${root}/${file.path}`)
        .then((result) => {
          if (alive && result.base64) setLoadedSrc(`data:${file.type};base64,${result.base64}`)
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [isImage, root, file.path, file.type, initialSrc])
  const src = loadedSrc

  // ---- 查看器状态（对齐 FilePreview） ----
  const bodyRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLImageElement>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [rotation, setRotation] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [animated, setAnimated] = useState(false)
  const userAdjustedRef = useRef(false)

  const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

  const fitToContainer = useCallback((animate = false): void => {
    const el = mediaRef.current
    const box = bodyRef.current
    if (!el || !box) return
    const naturalW = el.naturalWidth
    const naturalH = el.naturalHeight
    if (!naturalW || !naturalH) return
    const next = clampScale(Math.min(box.clientWidth / naturalW, box.clientHeight / naturalH, 1))
    userAdjustedRef.current = false
    setAnimated(animate)
    setScale(next)
    setOffset({ x: 0, y: 0 })
  }, [])

  const resetView = useCallback((): void => {
    userAdjustedRef.current = false
    setAnimated(false)
    setScale(1)
    setRotation(0)
    setOffset({ x: 0, y: 0 })
  }, [])

  const zoomBy = useCallback((delta: number): void => {
    userAdjustedRef.current = true
    setAnimated(true)
    setScale((prev) => clampScale(prev + delta))
  }, [])

  const rotate = useCallback((): void => {
    userAdjustedRef.current = true
    setRotation((prev) => (prev + 90) % 360)
  }, [])

  // 切换图片时重置视角
  useEffect(() => {
    resetView()
  }, [file.path, resetView])

  // 解码出真实尺寸后再适配窗口；已缓存时 load 不再触发，直接算一次
  useEffect(() => {
    if (!isImage) return
    const el = mediaRef.current
    if (!(el instanceof HTMLImageElement)) return
    if (el.complete && el.naturalWidth) {
      fitToContainer()
      return
    }
    const onLoad = (): void => fitToContainer()
    el.addEventListener('load', onLoad)
    return () => el.removeEventListener('load', onLoad)
  }, [src, isImage, fitToContainer])

  // 容器尺寸变化时，若用户没手动缩放过则重新适配
  useEffect(() => {
    if (!isImage) return
    const box = bodyRef.current
    if (!box) return
    const observer = new ResizeObserver((): void => {
      if (!userAdjustedRef.current) fitToContainer()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [isImage, fitToContainer])

  const onWheel = useCallback(
    (event: React.WheelEvent): void => {
      if (!isImage) return
      zoomBy(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    },
    [isImage, zoomBy]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      if (!isImage || event.button !== 0) return
      userAdjustedRef.current = true
      setDragging(true)
      setAnimated(false)
      const startX = event.clientX
      const startY = event.clientY
      const origin = offset
      const onMove = (move: PointerEvent): void => {
        setOffset({ x: origin.x + (move.clientX - startX), y: origin.y + (move.clientY - startY) })
      }
      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [isImage, offset]
  )

  // ---- 翻页 ----
  const index = images.findIndex((item) => item.path === file.path)
  const hasPrev = index > 0
  const hasNext = index >= 0 && index < images.length - 1
  const goPrev = useCallback(() => {
    if (hasPrev && onNavigate) onNavigate(images[index - 1])
  }, [hasPrev, onNavigate, images, index])
  const goNext = useCallback(() => {
    if (hasNext && onNavigate) onNavigate(images[index + 1])
  }, [hasNext, onNavigate, images, index])

  // ---- 复制 / 另存为 ----
  const copyImage = useCallback(async (): Promise<void> => {
    if (!src) return
    try {
      const bytes = dataUrlToBytes(src)
      const mime = dataUrlMime(src, file.type)
      // 剪贴板对 PNG 支持最好；非 PNG 转成 PNG 再写
      if (mime === 'image/png') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      } else {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('画布不可用')
        ctx.drawImage(bitmap, 0, 0)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('转换失败')
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      }
      toast.success('已复制图片')
    } catch {
      toast.error('复制图片失败')
    }
  }, [src, file.type])

  const saveAs = useCallback((): void => {
    if (!src) return
    const anchor = document.createElement('a')
    anchor.href = src
    anchor.download = file.name
    anchor.click()
  }, [src, file.name])

  // ---- 键盘快捷键 ----
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') goPrev()
      else if (event.key === 'ArrowRight') goNext()
      else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP)
      else if (event.key === '-') zoomBy(-ZOOM_STEP)
      else if (event.key === '0') resetView()
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && isImage) {
        event.preventDefault()
        void copyImage()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext, zoomBy, resetView, copyImage, isImage])

  // 非图片：按路径回读文本内容
  useEffect(() => {
    let alive = true
    if (!isImage && root) {
      void readFile(`${root}/${file.path}`)
        .then((result) => {
          if (alive) setText(result.truncated ? `${result.content}\n\n…（内容过长已截断）` : result.content)
        })
        .catch(() => {
          if (alive) setText('（读取失败）')
        })
    }
    return () => {
      alive = false
    }
  }, [isImage, root, file.path])

  const toolbarButton = (
    icon: IconName,
    label: string,
    onClick: () => void,
    disabled = false
  ): JSX.Element => (
    <button
      type="button"
      className="viewer__tool"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} size={16} />
    </button>
  )

  return (
    <Dialog
      title={
        images.length > 1 && index >= 0
          ? `${file.name}（${index + 1} / ${images.length}）`
          : file.name
      }
      className="modal--image-preview modal--viewer"
      width={960}
      onClose={onClose}
    >
      {isImage ? (
        <div className="viewer">
          <div
            ref={bodyRef}
            className={dragging ? 'viewer__stage viewer__stage--dragging' : 'viewer__stage'}
            onWheel={onWheel}
            onDoubleClick={resetView}
          >
            {src ? (
              <img
                ref={mediaRef}
                className="viewer__image"
                src={src}
                alt={file.name}
                draggable={false}
                onPointerDown={onPointerDown}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scale(${scale})`,
                  transformOrigin: 'center',
                  cursor: dragging ? 'grabbing' : 'grab',
                  transition: animated && !dragging ? 'transform 100ms ease-out' : 'none'
                }}
              />
            ) : (
              <span className="image-preview__loading">加载中…</span>
            )}

            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  className="viewer__nav viewer__nav--prev"
                  onClick={goPrev}
                  disabled={!hasPrev}
                  title="上一张（←）"
                  aria-label="上一张"
                >
                  <Icon name="chevron-left" size={22} />
                </button>
                <button
                  type="button"
                  className="viewer__nav viewer__nav--next"
                  onClick={goNext}
                  disabled={!hasNext}
                  title="下一张（→）"
                  aria-label="下一张"
                >
                  <Icon name="chevron-right" size={22} />
                </button>
              </>
            ) : null}
          </div>

          <footer className="viewer__bar">
            <span className="viewer__meta" title={root ? paths.join(root, file.path) : file.path}>
              {file.name}
              {file.size > 0 ? ` · ${formatAttachmentBytes(file.size)}` : ''}
            </span>
            <span className="viewer__tools">
              {toolbarButton('minus', '缩小（-）', () => zoomBy(-ZOOM_STEP), scale <= MIN_SCALE)}
              <span className="viewer__zoom" title="双击复位">
                {Math.round(scale * 100)}%
              </span>
              {toolbarButton('plus', '放大（+）', () => zoomBy(ZOOM_STEP), scale >= MAX_SCALE)}
              {toolbarButton('fit-screen', '适应窗口', () => fitToContainer(true))}
              {toolbarButton('sync', '旋转 90°', rotate)}
              {toolbarButton('copy', '复制图片（Ctrl/⌘+C）', () => void copyImage(), !src)}
              {toolbarButton('cloud-download-outline', '另存为', saveAs, !src)}
            </span>
          </footer>
        </div>
      ) : (
        <pre className="attachment-text-preview">{text ?? '加载中…'}</pre>
      )}
    </Dialog>
  )
}

/** 附件 chip：图片只显示缩略图（点击放大），文本类可点击查看内容，其它显示图标 + 名称 */
export function AttachmentChip({
  root,
  file,
  onRemove,
  onPreview
}: {
  root: string | null
  file: ChatAttachment
  onRemove?: () => void
  onPreview: (file: ChatAttachment, src: string | null) => void
}): JSX.Element {
  const isImage = file.type.startsWith('image/')
  const isText =
    !isImage &&
    (file.type.startsWith('text/') ||
      /\.(txt|md|markdown|json|jsonc|log|csv|tsv|xml|ya?ml|toml|ini)$/i.test(file.name))
  const src = useAttachmentImageSrc(root, file)

  if (isImage && src) {
    return (
      <span className="attach-chip attach-chip--image" title={file.path}>
        <button
          type="button"
          className="attach-chip__image-btn"
          title={`点击查看 ${file.name}`}
          onClick={() => onPreview(file, src)}
        >
          <img className="attach-chip__thumb" src={src} alt={file.name} />
        </button>
        {onRemove ? (
          <button
            type="button"
            className="attach-chip__remove"
            title="移除附件"
            aria-label={`移除附件 ${file.name}`}
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
      <Icon name={isImage ? 'image' : 'file'} size={16} />
      <span className="attach-chip__name">{file.name}</span>
      {file.size > 0 ? <span className="attach-chip__size">{formatAttachmentBytes(file.size)}</span> : null}
    </>
  )

  return (
    <span className={`attach-chip${isText ? ' attach-chip--clickable' : ''}`} title={file.path}>
      {isText ? (
        <button
          type="button"
          className="attach-chip__open"
          title={`查看 ${file.name}`}
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
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </span>
  )
}
