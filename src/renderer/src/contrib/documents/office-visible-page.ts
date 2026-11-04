/** A viewport anchor follows scrolling, except at the end: short slides can be
 * fully visible below the anchor and otherwise never acquire their notes. */
export function officeVisiblePage(scrollTop: number, viewportHeight: number, scrollHeight: number, heights: readonly number[], gap = 16): number {
  if (!heights.length || scrollTop <= 0) return 1
  if (scrollTop > 0 && scrollHeight > viewportHeight + 1 && scrollTop + viewportHeight >= scrollHeight - 2) return heights.length
  const anchor = Math.max(0, scrollTop) + Math.max(0, viewportHeight) * 0.35
  let bottom = gap
  for (let index = 0; index < heights.length; index++) {
    bottom += heights[index] + gap
    if (bottom >= anchor) return index + 1
  }
  return heights.length
}
