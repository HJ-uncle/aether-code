import type { BrowserViewport } from '@shared/browser'

export interface BrowserSurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserOverlayBounds {
  bounds: BrowserSurfaceBounds
  visible: boolean
  modal?: boolean
}

/** Mirrors native viewport placement while keeping DOM comparisons in CSS pixels. */
export function projectBrowserSurfaceBounds(
  bounds: BrowserSurfaceBounds,
  viewport: BrowserViewport | null,
  hostZoom = 1
): BrowserSurfaceBounds {
  if (!viewport || !hasArea(bounds) || viewport.width <= 0 || viewport.height <= 0) return bounds
  const zoom = Number.isFinite(hostZoom) && hostZoom > 0 ? hostZoom : 1
  const hostWidth = Math.round(bounds.width * zoom)
  const hostHeight = Math.round(bounds.height * zoom)
  const scale = Math.min(1, hostWidth / viewport.width, hostHeight / viewport.height)
  const width = Math.max(1, Math.round(viewport.width * scale))
  const height = Math.max(1, Math.round(viewport.height * scale))
  return {
    x: (Math.round(bounds.x * zoom) + Math.round((hostWidth - width) / 2)) / zoom,
    y: Math.round(bounds.y * zoom) / zoom,
    width: width / zoom,
    height: height / zoom
  }
}

function hasArea(bounds: BrowserSurfaceBounds): boolean {
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0
  )
}

export function overlapsBrowserSurface(
  surface: BrowserSurfaceBounds,
  overlays: readonly BrowserOverlayBounds[]
): boolean {
  if (!hasArea(surface)) return false
  return overlays.some(
    ({ bounds, visible, modal }) =>
      visible &&
      hasArea(bounds) &&
      (modal === true ||
        (bounds.x < surface.x + surface.width &&
          bounds.x + bounds.width > surface.x &&
          bounds.y < surface.y + surface.height &&
          bounds.y + bounds.height > surface.y))
  )
}

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="menu"]',
  '.popover__panel',
  '.context-menu',
  '.menu-bar__dropdown',
  '.modal-overlay',
  '.palette-overlay',
  '.palette-backdrop',
  '.quick-open',
  '.drag-overlay'
].join(', ')

/**
 * Popover uses role=dialog for anchored panels such as Usage and Select. Those
 * panels should only hide a native page they overlap; role alone is not modality.
 */
export function isBrowserSurfaceOccluded(
  bounds: BrowserSurfaceBounds,
  viewport: BrowserViewport | null,
  ownerDocument: Document = document,
  hostZoom = 1
): boolean {
  const view = ownerDocument.defaultView
  if (!view) return false
  const overlays: BrowserOverlayBounds[] = []
  for (const element of ownerDocument.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    if (!element.getClientRects().length) continue
    const style = view.getComputedStyle(element)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      continue
    const modal = element.getAttribute('aria-modal') === 'true'
    // Full-screen modal/palette backdrops are included as their actual geometry,
    // even when the dialog itself sits entirely in another editor column.
    overlays.push({ bounds: element.getBoundingClientRect(), visible: true, modal })
  }
  return overlapsBrowserSurface(projectBrowserSurfaceBounds(bounds, viewport, hostZoom), overlays)
}
