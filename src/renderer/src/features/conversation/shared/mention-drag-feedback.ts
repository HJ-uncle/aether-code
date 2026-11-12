interface CaretRect { left: number; top: number; height: number }
export interface MentionDropTarget { range: Range; caret: CaretRect }

function nearestRect(range: Range, x: number, y: number): DOMRect | undefined {
  return [...range.getClientRects()].filter(rect => rect.height > 0).sort((a, b) =>
    Math.abs(a.top + a.height / 2 - y) * 100 + Math.abs(a.left - x) -
    (Math.abs(b.top + b.height / 2 - y) * 100 + Math.abs(b.left - x)))[0]
}

/** The visual indicator and the committed drop must use the same atomic boundary. */
export function mentionDropTarget(box: HTMLElement, x: number, y: number): MentionDropTarget {
  const bounds = box.getBoundingClientRect(), style = getComputedStyle(box)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
  const left = bounds.left + box.clientLeft + parseFloat(style.paddingLeft)
  const top = bounds.top + box.clientTop + parseFloat(style.paddingTop)
  const right = bounds.left + box.clientLeft + box.clientWidth - parseFloat(style.paddingRight)
  const bottom = bounds.top + box.clientTop + box.clientHeight - parseFloat(style.paddingBottom)
  const pointX = Math.max(left, Math.min(x, right - 1)), pointY = Math.max(top, Math.min(y, bottom - 1))
  const hit = document.elementFromPoint(pointX, pointY)?.closest<HTMLElement>('[data-mention-key]')
  let range = document.caretRangeFromPoint(pointX, pointY) ?? document.createRange()
  if (!box.contains(range.startContainer)) {
    range.selectNodeContents(box)
    range.collapse(pointY <= top + lineHeight / 2)
  }
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const chip = hit && box.contains(hit) ? hit : element?.closest<HTMLElement>('[data-mention-key]')
  if (chip && box.contains(chip)) {
    const rect = chip.getBoundingClientRect(), before = pointX < rect.left + rect.width / 2
    if (before) range.setStartBefore(chip)
    else range.setStartAfter(chip)
    range.collapse(true)
    return { range, caret: { left: before ? rect.left : rect.right, top: rect.top, height: rect.height } }
  }
  range.collapse(true)
  const textRect = nearestRect(range, pointX, pointY)
  if (textRect) return { range, caret: { left: textRect.left, top: textRect.top, height: textRect.height } }

  // Chromium omits the collapsed rect before a preserved blank-line newline.
  // Its character range still has the correct line box; measure a clone so the
  // committed insertion remains collapsed at that same offset.
  if (range.startContainer instanceof Text && range.startContainer.data[range.startOffset] === '\n') {
    const probe = range.cloneRange()
    probe.setEnd(range.startContainer, range.startOffset + 1)
    const rect = nearestRect(probe, pointX, pointY)
    if (rect) return { range, caret: { left: rect.left, top: rect.top, height: rect.height } }
  }

  // Element boundaries around chips and empty lines have no collapsed Range
  // rectangle. Measure their adjacent content without inserting probe nodes.
  const edge = (node: Node | undefined, end: boolean): CaretRect | undefined => {
    if (!node) return undefined
    if (node instanceof HTMLElement && node.matches('[data-mention-key]')) {
      const rect = node.getBoundingClientRect()
      return { left: end ? rect.right : rect.left, top: rect.top, height: rect.height }
    }
    const probe = document.createRange()
    probe.selectNodeContents(node); probe.collapse(!end)
    const rect = nearestRect(probe, pointX, pointY)
    if (rect) return { left: rect.left, top: rect.top, height: rect.height }
    if (node instanceof HTMLBRElement) {
      const rect = node.getBoundingClientRect()
      return { left, top: rect.top + (end ? lineHeight : 0), height: lineHeight }
    }
    return node.childNodes.length ? edge(end ? node.lastChild! : node.firstChild!, end) : undefined
  }
  const container = range.startContainer, offset = range.startOffset
  const adjacent = container.nodeType === Node.TEXT_NODE ? undefined
    : edge(container.childNodes[offset], false) ?? edge(container.childNodes[offset - 1], true)
  return { range, caret: adjacent ?? { left: left - box.scrollLeft, top: top - box.scrollTop, height: lineHeight } }
}

/** A separate preview avoids fading the reference that remains in the draft. */
export function createMentionDragPreview(chip: HTMLElement): HTMLElement {
  const preview = chip.cloneNode(true) as HTMLElement
  const style = getComputedStyle(chip), bounds = chip.getBoundingClientRect()
  preview.classList.remove('is-pointer-drag')
  preview.classList.add('mention-chip-drag-preview')
  preview.removeAttribute('data-mention-key')
  preview.removeAttribute('id')
  preview.removeAttribute('role')
  preview.removeAttribute('tabindex')
  preview.setAttribute('aria-hidden', 'true')
  preview.inert = true
  preview.draggable = false
  Object.assign(preview.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`,
    maxWidth: 'none', margin: '0', font: style.font, lineHeight: style.lineHeight, color: style.color })
  document.body.appendChild(preview)
  return preview
}
