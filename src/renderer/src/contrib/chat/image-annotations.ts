export interface Point { readonly x: number; readonly y: number }

interface ImageAnnotationStyle {
  readonly id: string
  readonly color: string
  readonly width: number
}

/** Coordinates and stroke widths belong to the original image, independently
 * of preview zoom. Committed vectors stay immutable so history can share them. */
export type ImageAnnotation = ImageAnnotationStyle & (
  | { readonly kind: 'pen'; readonly points: readonly Point[] }
  | { readonly kind: 'arrow'; readonly start: Point; readonly end: Point }
  | { readonly kind: 'rectangle'; readonly start: Point; readonly end: Point }
  | { readonly kind: 'ellipse'; readonly start: Point; readonly end: Point }
  | { readonly kind: 'text'; readonly point: Point; readonly text: string; readonly fontSize: number }
)

export interface SnapshotHistory<T> {
  readonly snapshots: readonly T[]
  readonly index: number
}

export type AnnotationHistory = SnapshotHistory<readonly ImageAnnotation[]>

export function createSnapshotHistory<T>(initial: T): SnapshotHistory<T> {
  return { snapshots: [initial], index: 0 }
}

export function commitSnapshotHistory<T>(history: SnapshotHistory<T>, next: T): SnapshotHistory<T> {
  if (history.snapshots[history.index] === next) return history
  return { snapshots: [...history.snapshots.slice(0, history.index + 1), next], index: history.index + 1 }
}

export function undoSnapshotHistory<T>(history: SnapshotHistory<T>): SnapshotHistory<T> {
  return history.index > 0 ? { ...history, index: history.index - 1 } : history
}

export function redoSnapshotHistory<T>(history: SnapshotHistory<T>): SnapshotHistory<T> {
  return history.index < history.snapshots.length - 1 ? { ...history, index: history.index + 1 } : history
}

export function createAnnotationHistory(annotations: readonly ImageAnnotation[] = []): AnnotationHistory {
  return createSnapshotHistory([...annotations])
}

/** Accept a complete next snapshot, including erasures. Copy only the list:
 * unchanged vectors may be large and should not multiply with every action. */
export function commitAnnotationHistory(history: AnnotationHistory, annotations: readonly ImageAnnotation[]): AnnotationHistory {
  const current = history.snapshots[history.index]
  if (current.length === annotations.length && current.every((annotation, index) => annotation === annotations[index])) return history
  return commitSnapshotHistory(history, [...annotations])
}

export function undoAnnotationHistory(history: AnnotationHistory): AnnotationHistory {
  return undoSnapshotHistory(history)
}

export function redoAnnotationHistory(history: AnnotationHistory): AnnotationHistory {
  return redoSnapshotHistory(history)
}

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const TEXT_LINE_HEIGHT = 1.25
const TEXT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

function positiveSize(value: number): number { return Number.isFinite(value) && value > 0 ? value : 1 }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y) }

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x, dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return distance(point, start)
  const position = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - start.x - position * dx, point.y - start.y - position * dy)
}

function arrowHead(start: Point, end: Point, width: number): readonly [Point, Point] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  // Short drags retain a recognizable head without extending behind the tail.
  const length = Math.min(distance(start, end) * 0.45, Math.max(12, width * 4))
  return [
    { x: end.x - Math.cos(angle - Math.PI / 6) * length, y: end.y - Math.sin(angle - Math.PI / 6) * length },
    { x: end.x - Math.cos(angle + Math.PI / 6) * length, y: end.y - Math.sin(angle + Math.PI / 6) * length }
  ]
}

function drawDot(ctx: DrawingContext, point: Point, width: number): void {
  ctx.beginPath()
  ctx.arc(point.x, point.y, width / 2, 0, Math.PI * 2)
  ctx.fill()
}

function drawLine(ctx: DrawingContext, start: Point, end: Point, width: number): void {
  if (distance(start, end) === 0) { drawDot(ctx, start, width); return }
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(end.x, end.y)
  ctx.stroke()
}

/** Paint over the caller's image without clearing it or changing its transform.
 * The same vectors can therefore render in a zoomed preview and full-size export. */
export function drawImageAnnotations(ctx: DrawingContext, annotations: readonly ImageAnnotation[]): void {
  ctx.save()
  try {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash([])
    ctx.lineDashOffset = 0
    for (const annotation of annotations) {
      const width = positiveSize(annotation.width)
      ctx.strokeStyle = annotation.color
      ctx.fillStyle = annotation.color
      ctx.lineWidth = width
      if (annotation.kind === 'pen') {
        const first = annotation.points[0]
        if (!first) continue
        ctx.beginPath()
        ctx.moveTo(first.x, first.y)
        let moved = false
        for (let index = 1; index < annotation.points.length; index++) {
          const point = annotation.points[index]
          moved ||= point.x !== first.x || point.y !== first.y
          ctx.lineTo(point.x, point.y)
        }
        if (moved) ctx.stroke()
        else drawDot(ctx, first, width)
      } else if (annotation.kind === 'text') {
        const size = positiveSize(annotation.fontSize)
        ctx.font = `${size}px ${TEXT_FONT}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        annotation.text.split(/\r\n?|\n/).forEach((line, index) => {
          if (line) ctx.fillText(line, annotation.point.x, annotation.point.y + index * size * TEXT_LINE_HEIGHT)
        })
      } else if (annotation.kind === 'arrow') {
        drawLine(ctx, annotation.start, annotation.end, width)
        if (distance(annotation.start, annotation.end) === 0) continue
        const [left, right] = arrowHead(annotation.start, annotation.end, width)
        ctx.beginPath()
        ctx.moveTo(left.x, left.y)
        ctx.lineTo(annotation.end.x, annotation.end.y)
        ctx.lineTo(right.x, right.y)
        ctx.stroke()
      } else {
        const left = Math.min(annotation.start.x, annotation.end.x), top = Math.min(annotation.start.y, annotation.end.y)
        const spanX = Math.abs(annotation.end.x - annotation.start.x), spanY = Math.abs(annotation.end.y - annotation.start.y)
        if (spanX === 0 || spanY === 0) { drawLine(ctx, annotation.start, annotation.end, width); continue }
        ctx.beginPath()
        if (annotation.kind === 'rectangle') ctx.rect(left, top, spanX, spanY)
        else ctx.ellipse(left + spanX / 2, top + spanY / 2, spanX / 2, spanY / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  } finally { ctx.restore() }
}

/** Distance to the ellipse contour, including points inside it. Scaling a
 * circle distance by the minor radius makes thin ellipses erase far from ink. */
function ellipseDistance(point: Point, start: Point, end: Point): number {
  let radiusX = Math.abs(end.x - start.x) / 2, radiusY = Math.abs(end.y - start.y) / 2
  if (radiusX === 0 || radiusY === 0) return segmentDistance(point, start, end)
  let x = Math.abs(point.x - (start.x + end.x) / 2), y = Math.abs(point.y - (start.y + end.y) / 2)
  if (radiusX < radiusY) { [radiusX, radiusY] = [radiusY, radiusX]; [x, y] = [y, x] }
  if (y === 0) {
    const denominator = radiusX * radiusX - radiusY * radiusY
    const numerator = radiusX * x
    if (numerator < denominator) {
      const ratio = numerator / denominator
      return Math.hypot(radiusX * ratio - x, radiusY * Math.sqrt(1 - ratio * ratio))
    }
    return Math.abs(x - radiusX)
  }
  if (x === 0) return Math.abs(y - radiusY)
  const normalizedX = x / radiusX, normalizedY = y / radiusY
  const inside = normalizedX * normalizedX + normalizedY * normalizedY < 1
  const ratio = (radiusX / radiusY) ** 2
  let lower = normalizedY - 1, upper = inside ? 0 : Math.hypot(ratio * normalizedX, normalizedY) - 1
  let offset = 0
  for (let iteration = 0; iteration < 48; iteration++) {
    offset = (lower + upper) / 2
    const projectedX = ratio * normalizedX / (offset + ratio), projectedY = normalizedY / (offset + 1)
    if (projectedX * projectedX + projectedY * projectedY > 1) lower = offset
    else upper = offset
  }
  return Math.hypot(ratio * x / (offset + ratio) - x, y / (offset + 1) - y)
}

function estimatedTextWidth(text: string, size: number): number {
  // Hit testing is also used without a browser canvas. A conservative text box
  // keeps multiline labels erasable without coupling document state to fonts.
  return [...text].reduce((width, character) => width + size * (
    /\s/.test(character) ? 0.35 : character.codePointAt(0)! > 0xff ? 1 : /[ilI.,'`:;!|]/.test(character) ? 0.35 : /[MWmw@#%&]/.test(character) ? 0.9 : 0.65
  ), 0)
}

/** Erase a whole vector when the pointer touches its visible contour, not the
 * empty interior of outlined shapes. Tolerance is expressed in image pixels. */
export function hitTestAnnotation(annotation: ImageAnnotation, point: Point, tolerance: number): boolean {
  const margin = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0
  const radius = margin + positiveSize(annotation.width) / 2
  if (annotation.kind === 'pen') {
    return annotation.points.some((end, index) => segmentDistance(point, annotation.points[Math.max(0, index - 1)], end) <= radius)
  }
  if (annotation.kind === 'text') {
    const size = positiveSize(annotation.fontSize)
    return annotation.text.split(/\r\n?|\n/).some((line, index) => {
      if (!line.trim()) return false
      const top = annotation.point.y + index * size * TEXT_LINE_HEIGHT
      return point.x >= annotation.point.x - margin && point.x <= annotation.point.x + estimatedTextWidth(line, size) + margin &&
        point.y >= top - margin && point.y <= top + size + margin
    })
  }
  if (annotation.kind === 'ellipse') return ellipseDistance(point, annotation.start, annotation.end) <= radius
  if (annotation.kind === 'arrow') {
    const [left, right] = arrowHead(annotation.start, annotation.end, positiveSize(annotation.width))
    return segmentDistance(point, annotation.start, annotation.end) <= radius ||
      segmentDistance(point, left, annotation.end) <= radius || segmentDistance(point, right, annotation.end) <= radius
  }
  const oppositeA = { x: annotation.start.x, y: annotation.end.y }, oppositeB = { x: annotation.end.x, y: annotation.start.y }
  return segmentDistance(point, annotation.start, oppositeA) <= radius || segmentDistance(point, oppositeA, annotation.end) <= radius ||
    segmentDistance(point, annotation.end, oppositeB) <= radius || segmentDistance(point, oppositeB, annotation.start) <= radius
}
