/** Pure annotation regressions: undo/redo branch ownership, whole-vector
 * erasure, reversed drags, arrow heads and thin ellipse contour accuracy. */
import { expect, test } from '@playwright/test'
import { commitAnnotationHistory, createAnnotationHistory, hitTestAnnotation, redoAnnotationHistory, undoAnnotationHistory,
  type ImageAnnotation } from '../src/renderer/src/features/conversation/shared/image-annotations'

const style = { id: 'annotation', color: 'currentColor', width: 4 }
const stroke: ImageAnnotation = { ...style, kind: 'pen', points: [{ x: 10, y: 10 }, { x: 100, y: 10 }] }
const box: ImageAnnotation = { ...style, id: 'box', kind: 'rectangle', start: { x: 100, y: 100 }, end: { x: 20, y: 20 } }

test('annotation deletion undoes and redoes without copying existing vectors', () => {
  const initial = createAnnotationHistory([stroke, box])
  const erased = commitAnnotationHistory(initial, [box])
  expect(erased.snapshots[erased.index]).toEqual([box])
  const restored = undoAnnotationHistory(erased)
  expect(restored.snapshots[restored.index]).toEqual([stroke, box])
  expect(restored.snapshots[restored.index][0]).toBe(stroke)
  expect(redoAnnotationHistory(restored).snapshots[1]).toEqual([box])
  expect(initial.snapshots).toEqual([[stroke, box]])
})

test('a commit after undo removes only the redo branch and isolates list mutations', () => {
  const original = commitAnnotationHistory(commitAnnotationHistory(createAnnotationHistory(), [stroke]), [stroke, box])
  const nextList = [box]
  const branch = commitAnnotationHistory(undoAnnotationHistory(original), nextList)
  nextList.push(stroke)
  expect(branch.snapshots).toEqual([[], [stroke], [box]])
  expect(branch.index).toBe(2)
  expect(redoAnnotationHistory(branch)).toBe(branch)
  expect(original.snapshots[2]).toEqual([stroke, box])
  expect(undoAnnotationHistory(createAnnotationHistory()).index).toBe(0)
})

test('annotation history retains every committed action and no-op preserves redo', () => {
  let history = createAnnotationHistory()
  for (let index = 0; index < 300; index++) history = commitAnnotationHistory(history, [{ ...stroke, id: String(index) }])
  expect(history.snapshots).toHaveLength(301)
  const previous = undoAnnotationHistory(history)
  expect(commitAnnotationHistory(previous, previous.snapshots[previous.index])).toBe(previous)
  expect(redoAnnotationHistory(previous).index).toBe(300)
  expect(history.snapshots[1][0].id).toBe('0')
})

test('pen hit testing covers line segments, round endpoints and single-point marks', () => {
  expect(hitTestAnnotation(stroke, { x: 55, y: 14 }, 2)).toBe(true)
  expect(hitTestAnnotation(stroke, { x: 55, y: 15 }, 2)).toBe(false)
  expect(hitTestAnnotation(stroke, { x: 8, y: 10 }, 0)).toBe(true)
  expect(hitTestAnnotation({ ...style, kind: 'pen', points: [{ x: 10, y: 10 }] }, { x: 11, y: 11 }, 0)).toBe(true)
  expect(hitTestAnnotation({ ...style, kind: 'pen', points: [] }, { x: 0, y: 0 }, 10)).toBe(false)
})

test('reversed rectangles erase only near an edge and collapsed shapes remain erasable', () => {
  expect(hitTestAnnotation(box, { x: 20, y: 60 }, 0)).toBe(true)
  expect(hitTestAnnotation(box, { x: 60, y: 60 }, 2)).toBe(false)
  expect(hitTestAnnotation(box, { x: 103, y: 60 }, 2)).toBe(true)
  for (const kind of ['rectangle', 'ellipse', 'arrow'] as const) {
    const line: ImageAnnotation = { ...style, kind, start: { x: 20, y: 20 }, end: { x: 20, y: 100 } }
    expect(hitTestAnnotation(line, { x: 22, y: 60 }, 0)).toBe(true)
    expect(hitTestAnnotation({ ...line, end: line.start }, { x: 21, y: 21 }, 0)).toBe(true)
  }
})

test('arrow heads participate in erasing beyond the straight shaft', () => {
  const arrow: ImageAnnotation = { ...style, kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }
  expect(hitTestAnnotation(arrow, { x: 86.2, y: 8 }, 0)).toBe(true)
  expect(hitTestAnnotation(arrow, { x: 80, y: 8 }, 0)).toBe(false)
  expect(hitTestAnnotation(arrow, { x: 102, y: 0 }, 0)).toBe(true)
})

test('ellipse hit testing respects the contour on thin, tall and reversed ellipses', () => {
  const ellipse: ImageAnnotation = { ...style, kind: 'ellipse', start: { x: -100, y: -10 }, end: { x: 100, y: 10 } }
  expect(hitTestAnnotation(ellipse, { x: 0, y: 0 }, 0)).toBe(false)
  expect(hitTestAnnotation(ellipse, { x: 120, y: 0 }, 0)).toBe(false)
  expect(hitTestAnnotation(ellipse, { x: 0, y: 11 }, 0)).toBe(true)
  expect(hitTestAnnotation(ellipse, { x: 100, y: 0 }, 0)).toBe(true)
  expect(hitTestAnnotation(ellipse, { x: Math.SQRT1_2 * 100, y: Math.SQRT1_2 * 10 }, 0)).toBe(true)
  expect(hitTestAnnotation({ ...ellipse, start: ellipse.end, end: ellipse.start }, { x: 0, y: -11 }, 0)).toBe(true)
  const tall: ImageAnnotation = { ...ellipse, start: { x: -10, y: -100 }, end: { x: 10, y: 100 } }
  expect(hitTestAnnotation(tall, { x: 0, y: 120 }, 0)).toBe(false)
  expect(hitTestAnnotation(tall, { x: 11, y: 0 }, 0)).toBe(true)
})

test('multiline text uses its image position and line height while ignoring empty lines', () => {
  const text: ImageAnnotation = { ...style, kind: 'text', point: { x: 100, y: 50 }, text: 'ABC\r\n\r\n中文', fontSize: 20 }
  expect(hitTestAnnotation(text, { x: 110, y: 60 }, 0)).toBe(true)
  expect(hitTestAnnotation(text, { x: 110, y: 80 }, 0)).toBe(false)
  expect(hitTestAnnotation(text, { x: 130, y: 110 }, 0)).toBe(true)
  expect(hitTestAnnotation(text, { x: 150, y: 110 }, 0)).toBe(false)
  expect(hitTestAnnotation(text, { x: 98, y: 110 }, 2)).toBe(true)
})
