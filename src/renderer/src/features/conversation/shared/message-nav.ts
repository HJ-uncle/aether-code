/** Position model used by the chat message navigator.
 *
 * Keeping this calculation independent from DOM traversal makes it explicit that
 * only the outer turn anchors participate. Nested message elements also carry a
 * `data-turn-id` for other features, but they are not navigation entries.
 */
export interface MessageNavAnchor {
  id: string
  top: number
}

/** Return the last turn whose top edge has crossed the viewport probe. */
export function resolveActiveNavId(
  anchors: readonly MessageNavAnchor[],
  probe: number
): string | null {
  let current: string | null = null
  for (const anchor of anchors) {
    if (anchor.top <= probe) current = anchor.id
    else break
  }
  return current
}

/** Outer turn wrappers stay in document flow, so their top edges are ordered.
 * Read geometry lazily: collecting every rect first would keep scrolling O(n)
 * even if the search over those collected values were binary. Equal top edges
 * select the last crossed anchor, matching the linear prefix rule above. */
export function resolveOrderedNavIndex(length: number, probe: number, topAt: (index: number) => number): number {
  let start = 0, end = length
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2)
    if (topAt(middle) <= probe) start = middle + 1
    else end = middle
  }
  return start - 1
}

export interface MessageNavBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** The radar unfolds around its centre while staying inside the reading pane. */
export function messageNavPanelLayout(anchor: MessageNavBounds, bounds: MessageNavBounds, count: number): {
  left: number; top: number; width: number; height: number; originY: number
} {
  const width = Math.min(292, Math.max(1, bounds.right - bounds.left))
  // Navigation actions share the header; reserve the remaining height for rows.
  const height = Math.min(344, 48 + Math.max(2, count) * 32, Math.max(1, bounds.bottom - bounds.top))
  const centre = (anchor.top + anchor.bottom) / 2
  const left = Math.max(bounds.left, Math.min(anchor.right + 6, bounds.right - width))
  const top = Math.max(bounds.top, Math.min(centre - height / 2, bounds.bottom - height))
  return { left, top, width, height, originY: Math.max(0, Math.min(height, centre - top)) }
}
