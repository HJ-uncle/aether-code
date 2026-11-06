import { createContext, useContext, useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'

export interface OverlayOptions {
  open: boolean
  /** Retain the layer's paint order while its exit animation finishes. */
  present?: boolean
  modal?: boolean
  panelRef: RefObject<HTMLElement | null>
  triggerRef?: RefObject<HTMLElement | null>
  /** Global services can retain the layer that requested their dialog. */
  ownerId?: string | null
  onClose?: () => void
  closeOnOutside?: boolean
  closeOnEscape?: boolean
  restoreFocus?: boolean
  trapFocus?: boolean
  initialFocus?: boolean
}

interface Layer {
  id: string
  parentId: string | null
  order: number
  open: boolean
  read: () => OverlayOptions
  panel: HTMLElement | null
  opener: HTMLElement | null
  outsideDismiss: boolean
}

const Owner = createContext<string | null>(null)
const layers = new Map<string, Layer>()
const listeners = new Set<() => void>()
let revision = 0, sequence = 0
let observing = false, observer: MutationObserver | null = null
let syncing = false, focusRedirecting = false
const blocked = new Set<HTMLElement>()

export function OverlayScope({ id, children }: { id: string; children: ReactNode }) {
  return <Owner.Provider value={id}>{children}</Owner.Provider>
}

function ordered(): Layer[] {
  const result: Layer[] = [], seen = new Set<string>()
  const visit = (parentId: string | null): void => {
    for (const layer of [...layers.values()].filter(item => item.parentId === parentId || parentId === null && !layers.has(item.parentId ?? '')).sort((a, b) => a.order - b.order)) {
      if (seen.has(layer.id)) continue
      seen.add(layer.id)
      result.push(layer)
      visit(layer.id)
    }
  }
  visit(null)
  return result
}

function descendant(layer: Layer, ancestorId: string): boolean {
  const seen = new Set<string>()
  for (let current: Layer | undefined = layer; current && !seen.has(current.id); current = layers.get(current.parentId ?? '')) {
    if (current.id === ancestorId) return true
    seen.add(current.id)
  }
  return false
}

// A menu may close after launching a modal. Ownership must survive that exit
// animation; hiding the owner must not deactivate its newly opened child.
function active(layer: Layer): boolean { return layer.open }

function top(): Layer | undefined { return ordered().findLast(active) }
function topModal(): Layer | undefined { return ordered().findLast(layer => active(layer) && layer.read().modal) }
export function getTopOverlayId(): string | null { return top()?.id ?? null }
export function isTopOverlay(id: string): boolean { return top()?.id === id }

function roots(id: string, includeTriggers = false): HTMLElement[] {
  return ordered().filter(layer => active(layer) && descendant(layer, id)).flatMap(layer => {
    const options = layer.read()
    return [options.panelRef.current, includeTriggers ? options.triggerRef?.current : null].filter((node): node is HTMLElement => Boolean(node?.isConnected))
  })
}

export function ownsOverlayTarget(id: string, target: Node | null): boolean {
  return Boolean(target && roots(id, true).some(root => root.contains(target)))
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
function canFocus(element: HTMLElement): boolean {
  return !element.closest('[inert], [hidden], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0
}
function focusables(id: string): HTMLElement[] {
  return [...new Set(roots(id).flatMap(root => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]))].filter(element => (element.tabIndex >= 0 || element.isContentEditable && !element.hasAttribute('tabindex')) && canFocus(element))
}
function focusLayer(layer: Layer): void {
  const panel = layer.read().panelRef.current
  if (!panel || !canFocus(panel)) return
  const preferred = panel.querySelector<HTMLElement>('[autofocus], input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])')
  const destination = preferred && canFocus(preferred) ? preferred : focusables(layer.id)[0] ?? panel
  destination.focus({ preventScroll: true })
}

function syncIsolation(): void {
  if (syncing || typeof document === 'undefined') return
  syncing = true
  try {
    const modal = topModal(), allowed = modal ? roots(modal.id) : []
    const next = new Set<HTMLElement>()
    const visit = (container: HTMLElement): void => {
      for (const child of container.children) {
        if (!(child instanceof HTMLElement) || /^(SCRIPT|STYLE|LINK)$/.test(child.tagName)) continue
        if (allowed.some(root => root === child || root.contains(child))) continue
        if (allowed.some(root => child.contains(root))) visit(child)
        else next.add(child)
      }
    }
    if (allowed.length) visit(document.body)
    for (const element of blocked) {
      if (next.has(element)) continue
      // Closing/hidden surfaces have their own inert owner after leaving ours.
      if (element.dataset.motionState !== 'closing' && element.getAttribute('aria-hidden') !== 'true') element.inert = false
      blocked.delete(element)
    }
    for (const element of next) {
      if (blocked.has(element)) { if (!element.inert) element.inert = true; continue }
      if (element.inert) continue
      element.inert = true
      blocked.add(element)
    }
  } finally { syncing = false }
}

function keydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  const current = top()
  if (event.key === 'Escape' && current) {
    if (current.read().closeOnEscape === false) return
    event.preventDefault()
    event.stopImmediatePropagation()
    current.outsideDismiss = false
    current.read().onClose?.()
    return
  }
}

// Let controls such as Select dismiss their portaled menu and return focus to
// the trigger before enforcing the surrounding modal's Tab boundary.
function tabKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing) return
  const modal = topModal()
  if (!modal || modal.read().trapFocus === false) return
  const candidates = focusables(modal.id), focused = document.activeElement
  const inside = focused instanceof Node && roots(modal.id).some(root => root.contains(focused))
  if (!candidates.length || !inside || event.shiftKey && focused === candidates[0] || !event.shiftKey && focused === candidates.at(-1)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (candidates.length) candidates[event.shiftKey ? candidates.length - 1 : 0].focus({ preventScroll: true })
    else focusLayer(modal)
  }
}

function outside(event: MouseEvent): void {
  const current = top()
  if (!current || current.read().closeOnOutside === false || ownsOverlayTarget(current.id, event.target instanceof Node ? event.target : null)) return
  current.outsideDismiss = true
  current.read().onClose?.()
}

function focusin(event: FocusEvent): void {
  if (focusRedirecting) return
  const modal = topModal()
  if (!modal || modal.read().trapFocus === false || event.target instanceof Node && roots(modal.id).some(root => root.contains(event.target as Node))) return
  focusRedirecting = true
  try { focusLayer(modal) } finally { focusRedirecting = false }
}

function observe(): void {
  if (observing || typeof document === 'undefined') return
  observing = true
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('keydown', tabKeydown)
  document.addEventListener('mousedown', outside, true)
  document.addEventListener('focusin', focusin, true)
  observer = new MutationObserver(syncIsolation)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'data-motion-state'] })
}
function emit(): void {
  revision++
  syncIsolation()
  for (const listener of listeners) listener()
}
function restore(layer: Layer): void {
  if (layer.read().restoreFocus === false || layer.outsideDismiss) return
  let opener = layer.opener
  const focused = document.activeElement
  const current = top()
  if (current && current.id !== layer.parentId && !descendant(layer, current.id)) return
  const panel = layer.read().panelRef.current ?? layer.panel
  if (focused === document.body || focused === panel || focused instanceof Node && panel?.contains(focused) || focused instanceof HTMLElement && focused.closest('[inert]')) {
    // A short-lived menu can still be animating out when its dialog closes.
    // Restore through inactive owners rather than focusing their inert items.
    for (let parent = layers.get(layer.parentId ?? ''); parent && (!opener?.isConnected || !canFocus(opener)); parent = layers.get(parent.parentId ?? '')) {
      if (parent.open) break
      opener = parent.opener
    }
    if (opener?.isConnected && canFocus(opener)) opener.focus({ preventScroll: true })
    else if (current?.read().modal) focusLayer(current)
  }
}
function remove(id: string): void {
  const layer = layers.get(id)
  if (!layer) return
  layers.delete(id)
  for (const child of layers.values()) if (child.parentId === id) {
    child.parentId = layer.parentId
    if (child.opener && layer.panel?.contains(child.opener)) child.opener = layer.opener
  }
  emit()
  if (layer.open) restore(layer)
  if (!layers.size && observing) {
    document.removeEventListener('keydown', keydown, true)
    document.removeEventListener('keydown', tabKeydown)
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('focusin', focusin, true)
    observer?.disconnect()
    observer = null
    observing = false
    sequence = 0
  }
}

/** Portals keep React ownership while all paint/focus/dismissal decisions use
 * this one layer tree. A later modal covers the entire older overlay branch. */
export function useOverlay(options: OverlayOptions) {
  const id = useId(), inheritedOwner = useContext(Owner)
  const parentId = options.ownerId === undefined ? inheritedOwner : options.ownerId
  const latest = useRef(options)
  latest.current = options
  const openingFocus = useRef<{ open: boolean; element: HTMLElement | null }>({ open: false, element: null })
  if (options.open !== openingFocus.current.open) {
    // React autoFocus runs during the following commit, before layout effects.
    // Capture the invoker while rendering the opening transition instead.
    openingFocus.current = { open: options.open, element: options.open && document.activeElement instanceof HTMLElement ? document.activeElement : null }
  }
  const read = useRef(() => latest.current)
  const present = options.present ?? options.open
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => revision, () => 0)
  useLayoutEffect(() => {
    let layer = layers.get(id)
    if (!present) { remove(id); return }
    if (!layer) {
      layer = { id, parentId, order: ++sequence, open: options.open, read: read.current, panel: options.panelRef.current,
        opener: options.triggerRef?.current?.matches(FOCUSABLE) ? options.triggerRef.current :
          options.triggerRef?.current?.querySelector<HTMLElement>(FOCUSABLE) ?? openingFocus.current.element, outsideDismiss: false }
      layers.set(id, layer)
      observe()
      emit()
      if (options.open && (options.initialFocus ?? options.modal) && top()?.id === id) focusLayer(layer)
    } else if (layer.open !== options.open) {
      layer.open = options.open
      if (options.open) {
        layer.order = ++sequence
        layer.outsideDismiss = false
        layer.opener = options.triggerRef?.current?.matches(FOCUSABLE) ? options.triggerRef.current :
          options.triggerRef?.current?.querySelector<HTMLElement>(FOCUSABLE) ?? openingFocus.current.element
      }
      emit()
      if (!options.open) restore(layer)
      else if ((options.initialFocus ?? options.modal) && top()?.id === id) focusLayer(layer)
    }
    if (options.panelRef.current) layer.panel = options.panelRef.current
  })
  useLayoutEffect(() => () => remove(id), [id])
  return { id, zIndex: 200 + Math.max(0, ordered().findIndex(layer => layer.id === id)) * 2,
    isTop: isTopOverlay(id), owns: (target: Node | null) => ownsOverlayTarget(id, target),
    layerProps: { 'data-overlay-id': id } }
}
