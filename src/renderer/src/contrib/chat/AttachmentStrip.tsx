import { useRef, useState, type DragEvent, type JSX } from 'react'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { AttachmentChip } from './AttachmentChip'
import { ATTACHMENT_DRAG_TYPE, referencesAttachment, type AttachmentReference } from './attachment-references'
import type { Mention } from './mention-context'
import './attachment-references.css'

interface AttachmentStripProps {
  root: string | null
  sessionId?: string
  references: readonly AttachmentReference[]
  mentions: readonly Mention[]
  onRemove: (file: ChatAttachment) => void
  onReorder: (ids: string[]) => void
  onPreview: (file: ChatAttachment, src: string | null) => void
  disabled?: boolean
}

/** A card drop reorders attachments; an editor drop copies a reference to the same identity. */
export function AttachmentStrip({ root, sessionId, references, mentions, onRemove, onReorder, onPreview, disabled = false }: AttachmentStripProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const draggedAt = useRef(Number.NEGATIVE_INFINITY)
  const hasReference = (reference: AttachmentReference): boolean => mentions.some(mention => referencesAttachment(mention, reference))
  const move = (id: string, target: number): void => {
    const ids = references.map(reference => reference.id)
    const from = ids.indexOf(id)
    if (disabled || from < 0 || target < 0 || target >= ids.length || target === from) return
    ids.splice(from, 1)
    ids.splice(target, 0, id)
    onReorder(ids)
    setAnnouncement(`${references[from].file.name} 已移到第 ${target + 1} 位`)
  }
  const dragOver = (event: DragEvent<HTMLDivElement>, id: string): void => {
    if (disabled || !event.dataTransfer.types.includes(ATTACHMENT_DRAG_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    setDropTarget({ id, after: event.clientX >= bounds.left + bounds.width / 2 })
  }
  const drop = (event: DragEvent<HTMLDivElement>, targetId: string): void => {
    if (disabled || !event.dataTransfer.types.includes(ATTACHMENT_DRAG_TYPE)) return
    let payload: unknown
    try { payload = JSON.parse(event.dataTransfer.getData(ATTACHMENT_DRAG_TYPE)) } catch { return }
    if (!payload || typeof payload !== 'object' || !('id' in payload) || typeof payload.id !== 'string') return
    const id = payload.id
    if (!references.some(reference => reference.id === id)) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    if (id === targetId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const after = event.clientX >= bounds.left + bounds.width / 2
    const remaining = references.filter(reference => reference.id !== id)
    const target = remaining.findIndex(reference => reference.id === targetId)
    if (target >= 0) move(id, target + (after ? 1 : 0))
  }
  return <div className="attachment-strip" role="list" aria-label="当前附件">
    {references.map(reference => <div key={reference.id} role="listitem"
      className={`attachment-strip__item${reference.file.type.startsWith('image/') ? '' : ' attachment-strip__item--file'}${draggingId === reference.id ? ' is-dragging' : ''}${dropTarget?.id === reference.id ? dropTarget.after ? ' is-drop-after' : ' is-drop-before' : ''}`}
      data-attachment-id={reference.id} data-attachment-label={reference.label} draggable={!disabled}
      onDragStart={event => {
        if (disabled) { event.preventDefault(); return }
        event.dataTransfer.setData(ATTACHMENT_DRAG_TYPE, JSON.stringify({ id: reference.id }))
        event.dataTransfer.effectAllowed = 'copyMove'
        setDraggingId(reference.id)
      }}
      onDragEnd={() => { draggedAt.current = performance.now(); setDraggingId(null); setDropTarget(null) }}
      onPointerDown={() => { draggedAt.current = Number.NEGATIVE_INFINITY }}
      onClickCapture={event => {
        // Chromium normally omits click after a native drag; avoid preview/delete if a platform emits it.
        if (event.detail > 0 && performance.now() - draggedAt.current < 200) { event.preventDefault(); event.stopPropagation() }
      }}
      onDragOver={event => dragOver(event, reference.id)} onDrop={event => drop(event, reference.id)}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null)
      }}>
      <AttachmentChip root={root} sessionId={sessionId} file={reference.file} disabled={disabled}
        referenceLabel={hasReference(reference) ? reference.label : undefined}
        onRemove={() => onRemove(reference.file)} onPreview={onPreview} />
    </div>)}
    <span className="attachment-strip__announcement" role="status">{announcement}</span>
  </div>
}
