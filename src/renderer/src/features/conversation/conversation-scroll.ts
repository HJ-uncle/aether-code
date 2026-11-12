/** A paused follow intent is not evidence that the latest content is offscreen.
 * Ignore hidden panes and tolerate the rounding used by Chromium at fractional DPR. */
export function sessionConversationAwayFromBottom({ scrollHeight, clientHeight, scrollTop }: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}): boolean | null {
  if (clientHeight <= 0) return null
  const overflow = Math.max(0, scrollHeight - clientHeight)
  return overflow > 2 && overflow - Math.max(0, scrollTop) > 2
}
