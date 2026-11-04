/** Pure bridge ownership regression; real window coverage lives in workbench-client-ui. */
import { expect, test } from '@playwright/test'
import { deferredWorkPreview, isWorkbenchOwnerCurrent, type WorkbenchOwner } from '../src/renderer/src/core/workbench/connection-scope'

test('foreground changes preserve both mounted modes while actual session/source changes invalidate late commands', () => {
  const work: WorkbenchOwner = { mode: 'work', sessionId: 'product', source: 1, enabled: true }
  const code: WorkbenchOwner = { mode: 'code', sessionId: 'development', source: 1, enabled: true }
  for (const foreground of ['work', 'code', 'work']) {
    const workView = { ...work, foreground }, codeView = { ...code, foreground }
    expect(isWorkbenchOwnerCurrent(work, workView, 1, false)).toBe(true)
    expect(isWorkbenchOwnerCurrent(code, codeView, 1, false)).toBe(true)
  }
  expect(isWorkbenchOwnerCurrent(work, { ...work, sessionId: 'another-product' }, 1, false)).toBe(false)
  expect(isWorkbenchOwnerCurrent(work, { ...work, source: 2 }, 2, false)).toBe(false)
  expect(isWorkbenchOwnerCurrent(work, work, 2, false)).toBe(false)
  expect(isWorkbenchOwnerCurrent(work, { ...work, enabled: false }, 1, false)).toBe(false)
  expect(isWorkbenchOwnerCurrent(work, work, 1, true)).toBe(false)
  expect(isWorkbenchOwnerCurrent(work, code, 1, false)).toBe(false)
})

test('a background preview acknowledges only the selected entry, never content or visual verification', () => {
  expect(deferredWorkPreview('product/plan.docx')).toMatchObject({ path: 'product/plan.docx', opened: true, foreground: false,
    readStatus: 'not-confirmed', renderStatus: 'deferred-until-visible', visualVerification: false })
})
