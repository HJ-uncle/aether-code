import { DOCUMENT_CONTEXT_EVENT } from '../../core/editor/document-menu-events'

const FRAME_SELECTION = 'aether-document-selection'

/** A selection belongs to one preview only when both endpoints are inside it. */
export function selectionTextWithin(selection: Selection | null, root: Node | null): string | null {
  if (!selection || !root || selection.isCollapsed || !selection.rangeCount || !selection.anchorNode || !selection.focusNode
    || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null
  return selection.toString().trim() || null
}

function observeSelection(document: Document, root: () => Node | null, change: (text: string) => void): () => void {
  const update = (): void => {
    const text = selectionTextWithin(document.getSelection(), root())
    // A toolbar focus change may collapse the browser selection before click.
    // Keep the last valid quote until an explicit new selection/clear action.
    if (text !== null) change(text)
  }
  const clear = (event: Event): void => {
    const target = event.target as Node | null
    if (target && root()?.contains(target)) change('')
  }
  const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') change('') }
  document.addEventListener('selectionchange', update)
  document.addEventListener('pointerdown', clear, true)
  document.addEventListener('keydown', escape)
  return () => {
    document.removeEventListener('selectionchange', update)
    document.removeEventListener('pointerdown', clear, true)
    document.removeEventListener('keydown', escape)
  }
}

/** Trusted parent observes the scriptless, same-origin preview document.
 * No script injection, postMessage listener or sandbox permission is added. */
export function bridgeFrameSelection(frame: HTMLIFrameElement): () => void {
  let detach = (): void => {}
  const loaded = (): void => {
    detach()
    const document = frame.contentDocument
    if (!document) return
    const releaseSelection = observeSelection(document, () => document.querySelector('main.document-page'), text => {
      frame.dispatchEvent(new CustomEvent(FRAME_SELECTION, { bubbles: true, detail: text }))
    })
    const context = (event: MouseEvent): void => {
      event.preventDefault()
      frame.dispatchEvent(new CustomEvent(DOCUMENT_CONTEXT_EVENT, { bubbles: true, cancelable: true, detail: { x: event.clientX, y: event.clientY } }))
    }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const selection = document.getSelection()
      const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
      frame.dispatchEvent(new CustomEvent(DOCUMENT_CONTEXT_EVENT, { bubbles: true, cancelable: true,
        detail: { x: rect?.left ?? 16, y: rect?.bottom ?? 16 } }))
    }
    document.addEventListener('contextmenu', context)
    document.addEventListener('keydown', keyboard)
    detach = () => { releaseSelection(); document.removeEventListener('contextmenu', context); document.removeEventListener('keydown', keyboard) }
  }
  frame.addEventListener('load', loaded)
  loaded()
  return () => { frame.removeEventListener('load', loaded); detach() }
}

export function observePreviewSelection(root: HTMLElement, change: (text: string) => void): () => void {
  const detach = observeSelection(root.ownerDocument, () => root, change)
  const frameChanged = (event: Event): void => {
    const frame = event.target as HTMLIFrameElement | null
    if (!frame || frame.tagName !== 'IFRAME' || !root.contains(frame)
      || frame.getAttribute('data-document-selection-frame') !== 'true'
      || frame.getAttribute('sandbox') !== 'allow-same-origin') return
    const text = (event as CustomEvent<unknown>).detail
    // Re-read from the child instead of accepting an event-supplied quote.
    if (text === '') change('')
    else {
      const document = frame.contentDocument
      const selected = selectionTextWithin(document?.getSelection() ?? null, document?.querySelector('main.document-page') ?? null)
      if (selected !== null) change(selected)
    }
  }
  root.addEventListener(FRAME_SELECTION, frameChanged)
  return () => { detach(); root.removeEventListener(FRAME_SELECTION, frameChanged) }
}
