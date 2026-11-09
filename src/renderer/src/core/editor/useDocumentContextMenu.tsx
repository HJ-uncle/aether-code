import { createContext, useContext, useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { toast } from '@renderer/core/toast'
import { DOCUMENT_CONTEXT_EVENT } from './document-menu-events'
import { relativeFilePath } from './file-context-actions'

export interface DocumentMenuOptions {
  identity?: string
  path?: string
  root?: string | null
  active?: boolean
  onAddFile?: () => void
  onAddSelection?: (text: string) => void
  hasContent?: boolean
  getContentRoot?: (target: HTMLElement | null) => HTMLElement | null
  getExtraItems?: () => ContextMenuItem[]
  /** Image-only controls may use a button to offer click-to-expand. */
  allowButtons?: boolean
  /** The complete loaded text, including rows outside a virtual viewport. */
  getText?: () => string
}

const DocumentMenuContext = createContext<DocumentMenuOptions>({})
function mergeOptions(parent: DocumentMenuOptions, own: DocumentMenuOptions): DocumentMenuOptions {
  const merged = { ...parent, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)) }
  if (parent.getExtraItems && own.getExtraItems) merged.getExtraItems = () => [...parent.getExtraItems!(), ...own.getExtraItems!()]
  return merged
}
export function DocumentMenuProvider({ value, children }: { value: DocumentMenuOptions; children: ReactNode }): JSX.Element {
  const parent = useContext(DocumentMenuContext)
  return <DocumentMenuContext.Provider value={mergeOptions(parent, value)}>{children}</DocumentMenuContext.Provider>
}

interface MenuRequest {
  x: number
  y: number
  text?: string
  selectionRoot?: HTMLElement
  selectAll?: () => void
  restoreFocus?: () => void
  hasContent?: boolean
}
interface MenuSnapshot extends MenuRequest {
  requestId: number
  scope: string
  text: string
  path?: string
  root?: string | null
  addFile?: () => void
  addSelection?: (text: string) => void
  extraItems?: ContextMenuItem[]
}

function selectedText(root: HTMLElement): string {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode ||
    !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return ''
  return selection.toString()
}

const OWN_MENU = '.monaco-editor, input, textarea, select, button, [contenteditable="true"], [role="menu"]'

/** Menu focus can collapse a selection. Capture its text before opening, and
 * keep file/session actions supplied by the owning document rather than guessing. */
export function useDocumentContextMenu(rootRef: RefObject<HTMLElement | null>, options: DocumentMenuOptions = {}): {
  menu: JSX.Element | null
  openMenu: (request: MenuRequest) => void
} {
  const inherited = useContext(DocumentMenuContext)
  const merged = mergeOptions(inherited, options)
  const latest = useRef(merged)
  latest.current = merged
  const scope = JSON.stringify([merged.identity, merged.path, merged.root])
  const [snapshot, setSnapshot] = useState<MenuSnapshot | null>(null)
  const nextRequestId = useRef(0)
  const allText = useRef<{ root: HTMLElement; text: string; anchor: Node | null; anchorOffset: number; focus: Node | null; focusOffset: number } | null>(null)
  const rememberAll = (root: HTMLElement, text: string): void => {
    const selection = root.ownerDocument.getSelection()
    allText.current = selection ? { root, text, anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
      focus: selection.focusNode, focusOffset: selection.focusOffset } : null
  }
  const completeSelection = (root: HTMLElement): string | null => {
    const saved = allText.current, selection = root.ownerDocument.getSelection()
    if (!saved || saved.root !== root) return null
    if (saved.text !== latest.current.getText?.() || !selection || selection.anchorNode !== saved.anchor || selection.anchorOffset !== saved.anchorOffset ||
      selection.focusNode !== saved.focus || selection.focusOffset !== saved.focusOffset) { allText.current = null; return null }
    return saved.text
  }
  const selectContent = (root: HTMLElement): void => {
    root.focus({ preventScroll: true })
    root.ownerDocument.getSelection()?.selectAllChildren(root)
    const complete = latest.current.getText?.()
    if (complete === undefined) allText.current = null
    else rememberAll(root, complete)
  }
  const openMenu = (request: MenuRequest): void => {
    const current = latest.current
    const root = request.selectionRoot ?? current.getContentRoot?.(null) ?? rootRef.current
    const owner = rootRef.current
    if (!root || !owner || current.active === false || !owner.getClientRects().length ||
      owner.closest('[hidden], [inert], [aria-hidden="true"]') || root.closest('[hidden], [inert], [aria-hidden="true"]')) return
    const text = request.text ?? completeSelection(root) ?? selectedText(root)
    const path = current.path && current.root && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(current.path)
      ? `${current.root.replace(/[\\/]+$/, '')}/${current.path.replace(/^[\\/]+/, '')}` : current.path
    setSnapshot({ ...request, requestId: ++nextRequestId.current, scope: JSON.stringify([current.identity, current.path, current.root]), selectionRoot: root, text,
      path, root: current.root, addFile: current.onAddFile, addSelection: current.onAddSelection, extraItems: current.getExtraItems?.(),
      hasContent: request.hasContent ?? current.hasContent ?? Boolean(current.getText?.() || root.innerText?.trim()),
      restoreFocus: request.restoreFocus ?? (() => rootRef.current?.focus({ preventScroll: true })),
      selectAll: request.selectAll ?? (() => selectContent(root)) })
  }
  const opener = useRef(openMenu)
  opener.current = openMenu

  // Some preview roots mount only after bytes arrive. Rebind to the current
  // element after each commit; callbacks themselves always read current scope.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const owns = (target: EventTarget | null): target is Element => {
      if (!(target instanceof Element) || !root.contains(target)) return false
      const owner = target.closest(OWN_MENU)
      return !owner || Boolean(latest.current.allowButtons && owner instanceof HTMLButtonElement)
    }
    const context = (event: MouseEvent): void => {
      if (event.defaultPrevented || !owns(event.target) || latest.current.active === false) return
      const content = latest.current.getContentRoot?.(event.target instanceof HTMLElement ? event.target : event.target.parentElement)
      if (content && !content.contains(event.target)) return
      event.preventDefault(); event.stopPropagation()
      opener.current({ x: event.clientX, y: event.clientY, selectionRoot: content ?? undefined })
    }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !owns(event.target) || latest.current.active === false) return
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault(); event.stopPropagation()
        const rect = (event.target as HTMLElement).getBoundingClientRect()
        opener.current({ x: rect.left + Math.min(rect.width, 24), y: rect.top + Math.min(rect.height, 24) })
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); event.stopPropagation()
        const content = latest.current.getContentRoot?.(event.target instanceof HTMLElement ? event.target : event.target.parentElement) ?? root
        // A document shortcut must never fall through to selecting the entire
        // workbench; image/media previews intentionally have no text selection.
        const hasContent = latest.current.hasContent ?? Boolean(latest.current.getText?.() || content.innerText?.trim())
        if (hasContent) selectContent(content)
      }
    }
    const copy = (event: ClipboardEvent): void => {
      const text = completeSelection(root)
      if (text === null || !selectedText(root)) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', text)
    }
    const clear = (event: PointerEvent): void => { if (event.button === 0) allText.current = null }
    const frameContext = (event: Event): void => {
      if (event.defaultPrevented) return
      const frame = event.target
      if (!(frame instanceof HTMLIFrameElement) || !root.contains(frame) ||
        frame.dataset.documentSelectionFrame !== 'true' || frame.getAttribute('sandbox') !== 'allow-same-origin') return
      const detail: unknown = (event as CustomEvent<unknown>).detail
      if (!detail || typeof detail !== 'object' || !('x' in detail) || !('y' in detail) ||
        typeof detail.x !== 'number' || typeof detail.y !== 'number' || !Number.isFinite(detail.x) || !Number.isFinite(detail.y)) return
      const content = frame.contentDocument?.querySelector<HTMLElement>('main.document-page')
      if (!content) return
      event.preventDefault(); event.stopPropagation()
      const rect = frame.getBoundingClientRect()
      const scaleX = rect.width / Math.max(1, frame.clientWidth), scaleY = rect.height / Math.max(1, frame.clientHeight)
      opener.current({ x: rect.left + Math.max(0, Math.min(frame.clientWidth, detail.x)) * scaleX,
        y: rect.top + Math.max(0, Math.min(frame.clientHeight, detail.y)) * scaleY, selectionRoot: content,
        restoreFocus: () => { frame.contentWindow?.focus() },
        selectAll: () => { frame.contentWindow?.focus(); content.ownerDocument.getSelection()?.selectAllChildren(content) } })
    }
    root.addEventListener('contextmenu', context)
    root.addEventListener('keydown', keyboard)
    root.addEventListener('copy', copy)
    root.addEventListener('pointerdown', clear)
    root.addEventListener(DOCUMENT_CONTEXT_EVENT, frameContext)
    return () => {
      root.removeEventListener('contextmenu', context); root.removeEventListener('keydown', keyboard)
      root.removeEventListener('copy', copy); root.removeEventListener('pointerdown', clear)
      root.removeEventListener(DOCUMENT_CONTEXT_EVENT, frameContext)
    }
  })
  useEffect(() => { allText.current = null; setSnapshot(null) }, [merged.identity, merged.path, merged.active])

  const write = (text: string): void => {
    void navigator.clipboard.writeText(text).catch(() => toast.error('复制失败，请重试。'))
  }
  const items: ContextMenuItem[] = snapshot ? [
    ...(snapshot.addSelection && snapshot.text ? [{ id: 'add-selection', label: '添加选区到对话',
      onSelect: () => { if (latest.current.active !== false && snapshot.text) snapshot.addSelection?.(snapshot.text) } }] : []),
    ...(snapshot.addFile ? [{ id: 'add-file', label: '添加到对话',
      onSelect: () => { if (latest.current.active !== false) snapshot.addFile?.() } }] : []),
    ...(snapshot.extraItems ?? []).map((item, index) => ({ ...item, separatorBefore: index === 0 || item.separatorBefore })),
    { id: 'copy-selection', label: '复制', hint: 'Ctrl+C', separatorBefore: true, disabled: !snapshot.text, onSelect: () => write(snapshot.text) },
    { id: 'select-all', label: '全选', hint: 'Ctrl+A', disabled: !snapshot.hasContent, onSelect: () => snapshot.selectAll?.() },
    ...(snapshot.path ? [{ id: 'copy-path', label: /^(?:[A-Za-z]:[\\/]|[\\/])/.test(snapshot.path) ? '复制绝对路径' : '复制文件路径', separatorBefore: true, onSelect: () => write(snapshot.path!) },
      ...(snapshot.root ? [{ id: 'copy-relative-path', label: '复制相对路径', onSelect: () => write(relativeFilePath(snapshot.root!, snapshot.path!)) }] : [])] : [])
  ] : []
  // Coordinates do not identify an opening: Escape followed by a right-click
  // at the same point must replace the exiting menu and cancel its old timer.
  return { openMenu, menu: snapshot && snapshot.scope === scope && merged.active !== false ? <ContextMenu key={snapshot.requestId} x={snapshot.x} y={snapshot.y}
    items={items} anchor={rootRef.current} onDismiss={snapshot.restoreFocus}
    onClose={() => setSnapshot(current => current === snapshot ? null : current)} /> : null }
}
