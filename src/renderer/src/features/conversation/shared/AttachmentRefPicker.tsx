import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from 'react'
import { FileGlyph } from '@renderer/features/explorer/FileGlyph'
import { Icon } from '@renderer/ui/icons'
import { isMotionInteractive } from '@renderer/ui/motion'
import { isTopOverlay } from '@renderer/ui/overlay'
import { usePickerPointerSelection } from '@renderer/ui/usePickerPointerSelection'
import { useAttachmentImageSrc } from './AttachmentChip'
import { attachmentMention, type AttachmentReference } from './attachment-references'
import type { Mention } from './mention-context'
import './attachment-references.css'

export function AttachmentOption({ root, sessionId, reference, active, onSelect, onActivate, optionId, tabIndex }: {
  root: string | null
  sessionId?: string
  reference: AttachmentReference
  active: boolean
  onSelect: () => void
  onActivate: (event: PointerEvent<HTMLButtonElement>) => void
  optionId?: string
  tabIndex?: number
}): JSX.Element {
  const src = useAttachmentImageSrc(root, reference.file, sessionId)
  const isImage = reference.file.type.startsWith('image/')
  return <button type="button" role="option" aria-selected={active} id={optionId} tabIndex={tabIndex}
    className={`attachment-ref-picker__item${active ? ' is-active' : ''}`}
    data-attachment-id={reference.id} title={reference.file.name}
    onMouseDown={event => event.preventDefault()} onClick={onSelect} onPointerEnter={onActivate} onPointerMove={onActivate}>
    <span className="attachment-ref-picker__preview" aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : isImage ? <Icon name="image" size={18} /> : <FileGlyph name={reference.file.name} mimeType={reference.file.type} size={18} />}
    </span>
    <span className="attachment-ref-picker__copy"><strong>{reference.label}</strong><small>{reference.file.name}</small></span>
  </button>
}

export function AttachmentRefPicker({ root, sessionId, references, query, onSelect, onClose }: {
  root: string | null
  sessionId?: string
  references: readonly AttachmentReference[]
  query: string
  onSelect: (mention: Mention) => void
  onClose: () => void
}): JSX.Element {
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const pointerSelection = usePickerPointerSelection()
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return references.filter(reference => `${reference.label} ${reference.file.name}`.toLowerCase().includes(keyword))
  }, [references, query])
  useEffect(() => setActive(0), [query, filtered.length])
  useEffect(() => {
    if (!isMotionInteractive(rootRef.current)) return
    rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isMotionInteractive(rootRef.current)) return
      const owner = rootRef.current?.closest<HTMLElement>('[data-overlay-id]')?.dataset.overlayId
      if (owner && (!isTopOverlay(owner) || event.key === 'Escape')) return
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.target instanceof Element && event.target.closest('[data-mention-list-control]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) || event.shiftKey) return
      pointerSelection.markKeyboard()
      event.preventDefault()
      event.stopPropagation()
      if (!filtered.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
      } else onSelect(attachmentMention(filtered[active] ?? filtered[0]))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, filtered, onClose, onSelect, pointerSelection.markKeyboard])
  return <div ref={rootRef} className="attachment-ref-picker" role="listbox" aria-label="选择当前附件">
    {filtered.map((reference, index) => <AttachmentOption key={reference.id} root={root} sessionId={sessionId}
      reference={reference} active={index === active} onActivate={event => { if (pointerSelection.canActivate(event)) setActive(index) }}
      onSelect={() => onSelect(attachmentMention(reference))} />)}
    {!filtered.length ? <div className="mention-ref-picker__empty">{references.length ? '没有匹配的附件' : '暂无可用附件'}</div> : null}
  </div>
}
