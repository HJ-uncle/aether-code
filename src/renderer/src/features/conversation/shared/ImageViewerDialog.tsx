import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Dialog } from '@renderer/ui/Dialog'
import { Icon } from '@renderer/ui/icons'
import { OUTLINE_ICON_PATHS, OUTLINE_ICON_STROKE } from '@renderer/ui/outline-icons'
import { toast } from '@renderer/core/toast'
import { cssColor } from '@renderer/core/theme/palette'
import { useDocumentContextMenu } from '@renderer/core/editor/useDocumentContextMenu'
import { useImageConversation } from './image-conversation'
import { ImageStrokePicker } from './ImageStrokePicker'
import { ImageColorPicker } from './ImageColorPicker'
import { commitSnapshotHistory, createSnapshotHistory, drawImageAnnotations, hitTestAnnotation, redoSnapshotHistory,
  undoSnapshotHistory, type ImageAnnotation, type Point, type SnapshotHistory } from './image-annotations'
import './image-viewer.css'

type Tool = 'move' | ImageAnnotation['kind'] | 'eraser'
type Edit = { annotations: readonly ImageAnnotation[]; rotation: number }
type History = SnapshotHistory<Edit> & { exported?: Edit }
const EMPTY: Edit = { annotations: [], rotation: 0 }
const INITIAL: History = createSnapshotHistory(EMPTY)
const hasUnexportedEdits = (history: History): boolean => history.snapshots[history.index] !== EMPTY && history.snapshots[history.index] !== history.exported
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'move', label: '移动' }, { id: 'pen', label: '画笔' }, { id: 'arrow', label: '箭头' },
  { id: 'rectangle', label: '矩形' }, { id: 'ellipse', label: '椭圆' }, { id: 'text', label: '文字' }, { id: 'eraser', label: '橡皮擦' }
]

function MarkupIcon({ name }: { name: Tool | 'undo' | 'redo' }): JSX.Element {
  const shapes: Record<typeof name, JSX.Element> = {
    move: <><path d="m5 3 14 9-7 1-3 7Z" /></>,
    pen: <><path d="M4 18c3-8 4-14 7-14 4 0-6 15-1 15 2 0 3-8 5-8 2 0-1 7 1 7 1 0 2-2 4-3" /></>,
    arrow: <><path d="M4 20 20 4M9 4h11v11" /></>,
    rectangle: <rect x="4" y="5" width="16" height="14" rx="1.5" />,
    ellipse: <ellipse cx="12" cy="12" rx="9" ry="7" />,
    text: <><path d="M5 6V4h14v2M12 4v16M8 20h8" /></>,
    eraser: <><path d="m4 13 9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H7l-3-3a3 3 0 0 1 0-4ZM9 8l8 8M11 20h10" /></>,
    undo: <><path d={OUTLINE_ICON_PATHS.undo} /></>,
    redo: <><path d={OUTLINE_ICON_PATHS.redo} /></>
  }
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={OUTLINE_ICON_STROKE} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>
}

function pngName(title: string): string {
  const base = title.replace(/\.[a-z\d]{2,5}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100)
  return `${base || '图片'}-标注.png`
}

/** All preview entrances export the same full-resolution pixels. Zoom and pan
 * stay outside edit history; annotations and rotation are reversible edits. */
export function ImageViewerDialog({ src, title, onClose, open = true, className = '', onPrevious, onNext,
  canPrevious = false, canNext = false, onApply, root = null, filePath, loadError, imageIdentity, positionLabel }: {
  src: string | null; title: string; onClose: () => void; open?: boolean; className?: string
  onPrevious?: () => void; onNext?: () => void; canPrevious?: boolean; canNext?: boolean
  onApply?: (file: File) => Promise<void>; root?: string | null; filePath?: string; loadError?: string
  imageIdentity?: string; positionLabel?: string
}): JSX.Element {
  const conversation = useImageConversation()
  // Keep an export attached to the conversation that opened this viewer, even
  // if another tab becomes active while PNG encoding/upload is in progress.
  const receiver = useRef(conversation)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) receiver.current = conversation
  wasOpen.current = open
  const identity = useMemo(() => src && (imageIdentity || filePath ? JSON.stringify([imageIdentity ?? filePath, src]) : src), [imageIdentity, filePath, src])
  const [histories, setHistories] = useState<Map<string, History>>(() => new Map())
  const history = identity ? histories.get(identity) ?? INITIAL : INITIAL
  const edit = history.snapshots[history.index]
  const [image, setImage] = useState<{ src: string; element: HTMLImageElement } | null>(null)
  const [failure, setFailure] = useState('')
  const [tool, setTool] = useState<Tool>('move')
  const [color, setColor] = useState(() => cssColor('--danger').slice(0, 7))
  const [width, setWidth] = useState(4)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [draft, setDraft] = useState<readonly ImageAnnotation[] | null>(null)
  const [textEdit, setTextEdit] = useState<{ point: Point; text: string; fontSize: number } | null>(null)
  const textEditRef = useRef(textEdit)
  textEditRef.current = textEdit
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [dragging, setDragging] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const fitted = useRef(false)
  const gesture = useRef<{ pointerId: number; start: Point; origin: Point; annotations: readonly ImageAnnotation[]; item?: ImageAnnotation } | null>(null)
  const natural = image?.src === src ? image.element : null
  const ready = Boolean(natural && !failure && !loadError)
  const dirty = hasUnexportedEdits(history)

  const updateHistory = useCallback((change: (previous: History) => History): void => {
    if (!identity || !open) return
    setHistories(previous => { const next = new Map(previous); next.set(identity, change(previous.get(identity) ?? INITIAL)); return next })
  }, [identity, open])
  const commit = (next: Edit): void => updateHistory(previous => ({ ...previous, ...commitSnapshotHistory(previous, next) }))
  const undo = (): void => { setTextEdit(null); setDraft(null); updateHistory(previous => ({ ...previous, ...undoSnapshotHistory(previous) })) }
  const redo = (): void => { setTextEdit(null); setDraft(null); updateHistory(previous => ({ ...previous, ...redoSnapshotHistory(previous) })) }

  useEffect(() => {
    if (!open) return
    setFailure(''); setImage(null); setDraft(null); setTextEdit(null); setScale(1); setOffset({ x: 0, y: 0 }); fitted.current = false
    gesture.current = null; setDragging(false)
    if (!src) return
    let current = true
    const element = new Image()
    element.onload = () => { if (current) setImage({ src, element }) }
    element.onerror = () => { if (current) setFailure('图片无法加载，请关闭后重试') }
    element.src = src
    return () => { current = false }
  }, [src, identity, open])

  const fit = useCallback((): void => {
    if (!natural || !stage.current) return
    const sideways = edit.rotation % 180 !== 0
    const w = sideways ? natural.naturalHeight : natural.naturalWidth
    const h = sideways ? natural.naturalWidth : natural.naturalHeight
    const gutter = onPrevious || onNext ? 112 : 32
    // The canvas extends behind the floating toolbar. Explicit fit still keeps
    // the whole image readable above it, while manual zoom/pan uses every pixel.
    const visibleHeight = dock.current ? Math.max(1, dock.current.getBoundingClientRect().top - stage.current.getBoundingClientRect().top - 8) : stage.current.clientHeight
    setScale(Math.max(0.01, Math.min((stage.current.clientWidth - gutter) / w, (visibleHeight - 24) / h)))
    setOffset({ x: 0, y: (visibleHeight - stage.current.clientHeight) / 2 }); fitted.current = true
  }, [natural, edit.rotation, Boolean(onPrevious || onNext)])
  useLayoutEffect(() => { if (open && fitted.current) fit() }, [fit, open])
  useEffect(() => {
    const element = stage.current
    if (!element || !open) return
    const observer = new ResizeObserver(() => { if (fitted.current) fit() })
    observer.observe(element)
    if (dock.current) observer.observe(dock.current)
    return () => observer.disconnect()
  }, [fit, open])

  useLayoutEffect(() => {
    const element = canvas.current
    if (!element || !natural) return
    const ctx = element.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, element.width, element.height)
    drawImageAnnotations(ctx, draft ?? edit.annotations)
    if (textEdit?.text) drawImageAnnotations(ctx, [{ id: 'pending-text', kind: 'text', ...textEdit, color, width }])
  }, [natural, draft, edit, open, textEdit, color, width])

  const zoom = useCallback((factor: number): void => {
    fitted.current = false
    setScale(previous => Math.max(0.01, Math.min(10, previous * factor)))
  }, [])
  useEffect(() => {
    const element = stage.current
    if (!element || !open) return
    const wheel = (event: WheelEvent): void => { event.preventDefault(); if (!gesture.current) zoom(event.deltaY > 0 ? 1 / 1.15 : 1.15) }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [zoom, open, natural])

  const position = (event: { clientX: number; clientY: number }): Point => {
    const box = stage.current!.getBoundingClientRect(), angle = edit.rotation * Math.PI / 180
    const x = event.clientX - box.left - box.width / 2 - offset.x
    const y = event.clientY - box.top - box.height / 2 - offset.y
    return { x: Math.max(0, Math.min(natural!.naturalWidth, (x * Math.cos(angle) + y * Math.sin(angle)) / scale + natural!.naturalWidth / 2)),
      y: Math.max(0, Math.min(natural!.naturalHeight, (-x * Math.sin(angle) + y * Math.cos(angle)) / scale + natural!.naturalHeight / 2)) }
  }
  const finishText = (): void => {
    // Keyboard completion also blurs the field; consume this edit only once.
    const value = textEditRef.current
    textEditRef.current = null
    if (value?.text.trim()) commit({ ...edit, annotations: [...edit.annotations, { id: crypto.randomUUID(), kind: 'text', point: value.point, text: value.text, fontSize: value.fontSize, color, width }] })
    setTextEdit(null)
  }
  const eraseAt = (annotations: readonly ImageAnnotation[], point: Point): readonly ImageAnnotation[] => {
    const index = annotations.findLastIndex(item => hitTestAnnotation(item, point, 8 / scale))
    return index < 0 ? annotations : annotations.filter((_, i) => i !== index)
  }
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!natural || busy || event.button !== 0 || textEdit) return
    event.preventDefault()
    const point = position(event)
    if (tool === 'text') { setTextEdit({ point, text: '', fontSize: Math.max(18, width * 6) }); return }
    event.currentTarget.setPointerCapture(event.pointerId)
    const common = { id: crypto.randomUUID(), color, width }
    const item: ImageAnnotation | undefined = tool === 'pen' ? { ...common, kind: 'pen', points: [point] }
      : tool === 'arrow' || tool === 'rectangle' || tool === 'ellipse' ? { ...common, kind: tool, start: point, end: point } : undefined
    const annotations = tool === 'eraser' ? eraseAt(edit.annotations, point) : edit.annotations
    gesture.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: offset, annotations, item }
    setDragging(tool === 'move')
    if (tool !== 'move') setDraft(item ? [...annotations, item] : annotations)
  }
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (tool === 'move') {
      fitted.current = false
      setOffset({ x: current.origin.x + event.clientX - current.start.x, y: current.origin.y + event.clientY - current.start.y }); return
    }
    const point = position(event)
    if (tool === 'eraser') current.annotations = eraseAt(current.annotations, point)
    else if (current.item?.kind === 'pen') {
      const last = current.item.points[current.item.points.length - 1]
      if (Math.hypot(point.x - last.x, point.y - last.y) < 1 / scale) return
      current.item = { ...current.item, points: [...current.item.points, point] }
    } else if (current.item && current.item.kind !== 'text') current.item = { ...current.item, end: point }
    setDraft(current.item ? [...current.annotations, current.item] : current.annotations)
  }
  const pointerEnd = (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false): void => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!cancelled && tool !== 'move') {
      const annotations = current.item ? [...current.annotations, current.item] : current.annotations
      if (current.item || annotations !== edit.annotations) commit({ ...edit, annotations })
    }
    gesture.current = null; setDraft(null); setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  useEffect(() => { textInput.current?.focus() }, [Boolean(textEdit)])

  const exportPng = async (): Promise<Blob> => {
    if (!natural) throw new Error('请等待图片加载完成')
    const output = document.createElement('canvas'), sideways = edit.rotation % 180 !== 0
    output.width = sideways ? natural.naturalHeight : natural.naturalWidth
    output.height = sideways ? natural.naturalWidth : natural.naturalHeight
    const ctx = output.getContext('2d')
    if (!ctx) throw new Error('无法创建图片画布')
    ctx.translate(output.width / 2, output.height / 2); ctx.rotate(edit.rotation * Math.PI / 180)
    ctx.translate(-natural.naturalWidth / 2, -natural.naturalHeight / 2)
    ctx.drawImage(natural, 0, 0); drawImageAnnotations(ctx, edit.annotations)
    return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败')), 'image/png'))
  }
  const exportImage = async (action: 'copy' | 'save' | 'reference' | 'apply'): Promise<void> => {
    if (busyRef.current || !natural) return
    busyRef.current = true; setBusy(true)
    try {
      const blob = await exportPng(), file = new File([blob], pngName(title), { type: 'image/png' })
      if (action === 'copy') { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast.success('已复制图片') }
      else if (action === 'save') {
        const url = URL.createObjectURL(blob), link = document.createElement('a')
        link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } else if (action === 'apply' && onApply) { await onApply(file); toast.success('已应用到待发送图片') }
      else if (action === 'reference' && receiver.current) { await receiver.current.addImage(file); toast.success('已添加到当前会话') }
      else throw new Error('当前没有可接收图片的会话')
      // A native save dialog can still be cancelled after download starts.
      if (action !== 'save') updateHistory(previous => ({ ...previous, exported: edit }))
      if (action === 'apply' || action === 'reference') {
        if ([...histories].some(([key, value]) => key !== identity && hasUnexportedEdits(value))) setConfirmClose(true)
        else onClose()
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : '图片导出失败，请重试') }
    finally { busyRef.current = false; setBusy(false) }
  }
  const close = (): void => { if (busyRef.current) return; if ([...histories.values()].some(hasUnexportedEdits) || textEdit?.text.trim()) setConfirmClose(true); else onClose() }
  const navigate = (direction: 'previous' | 'next'): void => {
    if (!ready || busyRef.current || textEdit || confirmClose || gesture.current) return
    if (direction === 'previous' && canPrevious) onPrevious?.()
    if (direction === 'next' && canNext) onNext?.()
    // A boundary button becomes disabled after navigation; keep keyboard focus
    // on the canvas so the opposite arrow still works immediately.
    stage.current?.focus()
  }
  useEffect(() => {
    if (!open) { setConfirmClose(false); return }
    const key = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key === 'Escape' && textEdit && event.target === textInput.current) {
        event.preventDefault(); event.stopImmediatePropagation(); textEditRef.current = null; setTextEdit(null); stage.current?.focus(); return
      }
      if (!(event.target instanceof Node) || !stage.current?.closest('.modal')?.contains(event.target)) return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.defaultPrevented || busy || gesture.current || confirmClose) return
      const command = event.ctrlKey || event.metaKey, lower = event.key.toLowerCase()
      if (command && lower === 'z') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) redo(); else undo() }
      else if (command && lower === 'y') { event.preventDefault(); event.stopPropagation(); redo() }
      else if (command && lower === 'c') { event.preventDefault(); event.stopPropagation(); void exportImage('copy') }
      else if (command && lower === 's') { event.preventDefault(); event.stopPropagation(); void exportImage('save') }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.15) }
      else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.15) }
      else if (event.key === '0') { event.preventDefault(); fit() }
      else if (event.key === 'ArrowLeft' && canPrevious) { event.preventDefault(); navigate('previous') }
      else if (event.key === 'ArrowRight' && canNext) { event.preventDefault(); navigate('next') }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  const { menu } = useDocumentContextMenu(stage, { identity: src ?? title, path: filePath, root, active: open && ready && !busy && !textEdit,
    hasContent: false, getExtraItems: () => [
      { id: 'copy-image', label: '复制图片', onSelect: () => void exportImage('copy') },
      { id: 'save-image', label: '另存为', onSelect: () => void exportImage('save') }
    ] })

  const disabled = !ready || busy || Boolean(textEdit)
  const textPlacement = (): { left: number; top: number; width: number } => {
    const box = stage.current
    if (!box || !natural || !textEdit) return { left: 12, top: 12, width: 260 }
    const angle = edit.rotation * Math.PI / 180, x = textEdit.point.x - natural.naturalWidth / 2, y = textEdit.point.y - natural.naturalHeight / 2
    const inputWidth = Math.min(280, box.clientWidth - 24)
    const left = Math.max(12, Math.min(box.clientWidth - inputWidth - 12, box.clientWidth / 2 + offset.x + (x * Math.cos(angle) - y * Math.sin(angle)) * scale))
    let top = Math.max(12, Math.min(box.clientHeight - 100, box.clientHeight / 2 + offset.y + (x * Math.sin(angle) + y * Math.cos(angle)) * scale))
    if (dock.current) {
      const stageBox = box.getBoundingClientRect(), toolbar = dock.current.getBoundingClientRect()
      if (left + inputWidth > toolbar.left - stageBox.left && left < toolbar.right - stageBox.left && top + 100 > toolbar.top - stageBox.top)
        top = Math.max(12, toolbar.top - stageBox.top - 100)
    }
    return { left, top, width: inputWidth }
  }
  return <Dialog title={title} hideHeader className={`modal--image-preview modal--image-editor ${className}`} open={open} closeDisabled={busy} onClose={close}>
    <div className="image-editor" aria-busy={busy} onClick={event => event.stopPropagation()}>
      <div ref={stage} className={`image-editor__stage${dragging ? ' is-dragging' : ''}`} tabIndex={0} aria-label="图片画布" onDoubleClick={() => { if (tool === 'move') fit() }}>
        {natural ? <div className="image-editor__surface" style={{ width: natural.naturalWidth, height: natural.naturalHeight,
          transform: `translate(${offset.x}px, ${offset.y}px) rotate(${edit.rotation}deg) scale(${scale})` }}>
          <img src={src!} alt={title} draggable={false} />
          <canvas ref={canvas} className="image-editor__canvas" width={natural.naturalWidth} height={natural.naturalHeight}
            aria-label="图片标注画布" style={{ cursor: tool === 'move' ? dragging ? 'grabbing' : 'grab' : tool === 'text' ? 'text' : 'crosshair' }}
            onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)} onLostPointerCapture={event => pointerEnd(event, true)} />
        </div> : <div className="image-editor__status" role={failure || loadError ? 'alert' : 'status'}>{failure || loadError || '正在加载图片…'}</div>}
          {textEdit ? <textarea ref={textInput} className="image-editor__text" aria-label="标注文字" placeholder="输入文字" value={textEdit.text} wrap="off"
            style={textPlacement()}
            onChange={event => setTextEdit({ ...textEdit, text: event.target.value })} onBlur={finishText}
            onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); textEditRef.current = null; setTextEdit(null) }
              else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); finishText(); stage.current?.focus() } }} /> : null}
        {onPrevious ? <button type="button" className="image-editor__nav image-editor__nav--previous" aria-label="上一张" title="上一张（←）" disabled={!canPrevious || disabled || confirmClose} onClick={() => navigate('previous')}><Icon name="chevron-left" size={20} /></button> : null}
        {onNext ? <button type="button" className="image-editor__nav image-editor__nav--next" aria-label="下一张" title="下一张（→）" disabled={!canNext || disabled || confirmClose} onClick={() => navigate('next')}><Icon name="chevron-right" size={20} /></button> : null}
      </div>
      <div ref={dock} className="image-editor__dock">
      {confirmClose ? <div className="image-editor__notice" role="alert"><span>标注尚未导出，要放弃这些编辑吗？</span>
        <button type="button" onClick={() => setConfirmClose(false)}>继续编辑</button><button type="button" onClick={() => { setHistories(new Map()); setTextEdit(null); setConfirmClose(false); onClose() }}>放弃标注</button></div> : null}
      <div className="image-editor__toolbar" role="toolbar" aria-label="图片标注工具">
        <div className="image-editor__group" role="group" aria-label="标注工具">
          {TOOLS.map(item => <button key={item.id} type="button" className="image-editor__tool" title={item.label} aria-label={item.label}
            aria-pressed={tool === item.id} disabled={disabled} onClick={() => setTool(item.id)}><MarkupIcon name={item.id} /></button>)}
        </div>
        <div className="image-editor__group image-editor__style" role="group" aria-label="标注样式">
          <ImageColorPicker value={color} onChange={setColor} disabled={disabled || !open} />
          <ImageStrokePicker value={width} onChange={setWidth} disabled={disabled} />
        </div>
        <div className="image-editor__group" role="group" aria-label="编辑历史">
          <button type="button" className="image-editor__tool" aria-label="撤销" title="撤销（Ctrl/⌘+Z）" disabled={disabled || history.index === 0} onClick={undo}><MarkupIcon name="undo" /></button>
          <button type="button" className="image-editor__tool" aria-label="重做" title="重做（Ctrl/⌘+Shift+Z）" disabled={disabled || history.index === history.snapshots.length - 1} onClick={redo}><MarkupIcon name="redo" /></button>
        </div>
        <div className="image-editor__actions">
          <button type="button" className="image-editor__action" disabled={disabled} onClick={() => void exportImage('copy')}><Icon name="copy" size={15} />复制图片</button>
          {receiver.current ? <button type="button" className="image-editor__action" disabled={disabled} onClick={() => void exportImage('reference')}><Icon name="chat-outline" size={15} />引用到会话</button> : null}
          {onApply ? <button type="button" className="image-editor__action image-editor__action--primary" disabled={disabled || !dirty} onClick={() => void exportImage('apply')}><Icon name="check" size={15} />应用编辑</button> : null}
        </div>
      </div>
      <footer className="image-editor__footer">
        <div className="image-editor__details">
          <span className="image-editor__title" title={title}>{title}</span>
          {positionLabel ? <span className="image-editor__position" aria-label={`图片位置 ${positionLabel}`}>{positionLabel}</span> : null}
        <span className="image-editor__hint" role="status">{busy ? '正在导出图片…' : textEdit ? 'Ctrl/⌘+Enter 完成文字' : `${natural ? `${natural.naturalWidth} × ${natural.naturalHeight}` : ''}${dirty ? ' · 已编辑' : ''}`}</span>
        </div>
        <div className="image-editor__view-tools" role="group" aria-label="图片视图">
          <button type="button" className="image-editor__tool" aria-label="缩小" title="缩小（−）" disabled={!ready} onClick={() => zoom(1 / 1.15)}><Icon name="minus" size={16} /></button>
          <button type="button" className="image-editor__zoom" aria-label="实际大小" title="实际大小（100%）" disabled={!ready} onClick={() => { fitted.current = false; setScale(1); setOffset({ x: 0, y: 0 }) }}>{Math.round(scale * 100)}%</button>
          <button type="button" className="image-editor__tool" aria-label="放大" title="放大（+）" disabled={!ready} onClick={() => zoom(1.15)}><Icon name="plus" size={16} /></button>
          <button type="button" className="image-editor__tool" aria-label="适应窗口" title="适应窗口（0）" disabled={!ready} onClick={fit}><Icon name="fit-screen" size={16} /></button>
          <button type="button" className="image-editor__tool" aria-label="旋转 90°" title="顺时针旋转 90°" disabled={disabled} onClick={() => commit({ ...edit, rotation: (edit.rotation + 90) % 360 })}><Icon name="rotate-clockwise" size={18} /></button>
          <button type="button" className="image-editor__tool" aria-label="另存为" title="另存为 PNG（Ctrl/⌘+S）" disabled={disabled} onClick={() => void exportImage('save')}><Icon name="download" size={18} /></button>
        </div>
        <button type="button" className="image-editor__tool image-editor__close" aria-label="关闭" title="关闭（Esc）" disabled={busy} onClick={close}><Icon name="close" size={18} /></button>
      </footer>
      </div>
    </div>{menu}
  </Dialog>
}
