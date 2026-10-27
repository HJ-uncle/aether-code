import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  DEFAULT_HEX_BYTES,
  base64ToBytes,
  formatSize,
  hexDump,
  previewKindFor,
  toDataUrl
} from '@renderer/core/editor/preview'
import { Icon } from '@renderer/workbench/icons'
import { documentKindFor } from '../documents/document-kind'

const DocumentPreview = lazy(() => import('../documents/DocumentPreview').then(module => ({ default: module.DocumentPreview })))

interface FilePreviewProps {
  /** 文件名（用于判定预览方式与 MIME） */
  name: string
  /** 绝对路径（展示与排错用） */
  path: string
  /** Work may keep a hidden preview alive without rebuilding its parser. */
  active?: boolean
  /** 编辑组内保持稳定的预览身份；分栏不能共享分页状态。 */
  groupId?: string
  /** 磁盘内容（base64）；Office/PDF 也可直接传 bytes。 */
  base64?: string
  bytes?: ArrayBuffer
  size: number
}

const MIN_SCALE = 0.1
const MAX_SCALE = 10
const ZOOM_STEP = 0.2

/**
 * 二进制文件预览
 *
 * 二进制按格式提供安全的预览/编辑入口。PDF 由文档预览器处理批注和另存为；
 * 其它二进制仍保持只读，避免用文本编辑器改写后损坏文件。
 *
 * 图片支持拖拽平移与缩放，交互对齐 wuzu-client 的预览：滚轮 / 按钮缩放、
 * 左键拖拽平移、双击或「适应窗口」复位。位移放在 transform 上，不占布局，
 * 因此可以拖出容器边界再拖回来。
 */
export const FilePreview = memo(function FilePreview(props: FilePreviewProps): JSX.Element {
  if (documentKindFor(props.name)) return <Suspense fallback={<div className="doc-placeholder" role="status">正在准备文档预览…</div>}>
    <DocumentPreview name={props.name} base64={props.base64} data={props.bytes} size={props.size} identityKey={`${props.path}:${props.groupId || ''}`} active={props.active ?? true} />
  </Suspense>
  return <BinaryFilePreview {...props} />
})

function BinaryFilePreview({ name, path, base64 = '', size }: FilePreviewProps): JSX.Element {
  const kind = previewKindFor(name)

  // 十六进制视图只解码前 16 KB：见 preview.ts 的 base64ToBytes 说明
  const dump = useMemo(
    () => (kind === 'hex' ? hexDump(base64ToBytes(base64, DEFAULT_HEX_BYTES)) : ''),
    [kind, base64]
  )

  const dataUrl = useMemo(
    () => (kind === 'hex' ? '' : toDataUrl(base64, name)),
    [kind, base64, name]
  )

  const isImage = kind === 'image'
  const bodyRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLImageElement>(null)

  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // 复位时跳过过渡：从放大的位置动画回原尺寸很晃眼
  const [animated, setAnimated] = useState(false)
  // 用户是否手动缩放过。手动缩放后容器尺寸变化不再自动重适配，
  // 否则拖一下面板就把辛苦放大的视角重置了
  const userAdjustedRef = useRef(false)

  const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

  /** 缩到能完整放进容器；图片小于容器时保持 1:1，不放大 */
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

  // 图片解码出真实尺寸后再算适应窗口；已缓存时 load 不会再触发，需直接算一次
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
  }, [dataUrl, isImage, fitToContainer])

  // 容器尺寸变化（拖分隔条、缩放窗口）时重新适配
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

  const zoomBy = useCallback((delta: number): void => {
    userAdjustedRef.current = true
    setAnimated(true)
    setScale((prev) => clampScale(prev + delta))
  }, [])

  const resetView = useCallback((): void => {
    userAdjustedRef.current = false
    setAnimated(false)
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const onWheel = useCallback(
    (event: React.WheelEvent): void => {
      if (!isImage) return
      // 固定步进加法：缩放幅度可预期，不受滚轮速度影响
      zoomBy(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    },
    [isImage, zoomBy]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      if (!isImage || event.button !== 0) return
      userAdjustedRef.current = true
      // 监听挂在 window 上而不是元素上：快速拖动时指针会离开元素，挂在元素上会丢事件
      setDragging(true)
      setAnimated(false)
      const startX = event.clientX
      const startY = event.clientY
      const origin = offset
      const onMove = (move: PointerEvent): void => {
        setOffset({
          x: origin.x + (move.clientX - startX),
          y: origin.y + (move.clientY - startY)
        })
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

  return (
    <div className="preview">
      <div
        className={isImage ? 'preview__body preview__body--interactive' : 'preview__body'}
        ref={bodyRef}
        onWheel={onWheel}
        onDoubleClick={isImage ? resetView : undefined}
      >
        {isImage ? (
          <img
            className={dragging ? 'preview__image preview__image--dragging' : 'preview__image'}
            ref={mediaRef}
            src={dataUrl}
            alt={name}
            title={path}
            draggable={false}
            onPointerDown={onPointerDown}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: 'center',
              cursor: dragging ? 'grabbing' : 'grab',
              transition: animated && !dragging ? 'transform 100ms ease-out' : 'none'
            }}
          />
        ) : kind === 'video' ? (
          <video className="preview__video" src={dataUrl} controls preload="metadata" title={path} />
        ) : (
          <pre className="preview__hex">{dump}</pre>
        )}
      </div>

      <footer className="preview__status">
        <span>{previewLabel(kind)}</span>
        <span>{formatSize(size)}</span>
        {kind === 'hex' ? <span>仅显示前 {formatSize(DEFAULT_HEX_BYTES)}</span> : null}
        {isImage ? (
          <span className="preview__zoom">
            <button
              type="button"
              className="preview__zoom-btn"
              onClick={() => zoomBy(-ZOOM_STEP)}
              disabled={scale <= MIN_SCALE}
              title="缩小"
              aria-label="缩小"
            >
              <Icon name="minus" />
            </button>
            <span className="preview__zoom-value">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="preview__zoom-btn"
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={scale >= MAX_SCALE}
              title="放大"
              aria-label="放大"
            >
              <Icon name="plus" />
            </button>
            <button
              type="button"
              className="preview__zoom-btn"
              onClick={() => fitToContainer(true)}
              title="适应窗口"
              aria-label="适应窗口"
            >
              <Icon name="fit-screen" />
            </button>
          </span>
        ) : null}
        <span className="preview__path" title={path}>
          {path}
        </span>
      </footer>
    </div>
  )
}

function previewLabel(kind: string): string {
  if (kind === 'image') return '图片预览'
  if (kind === 'video') return '视频预览'
  return '十六进制预览'
}
