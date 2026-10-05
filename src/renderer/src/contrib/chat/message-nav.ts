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
