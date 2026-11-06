/** Pure preview invalidation contracts: one batch notification, captured engine
 * and session scope, normalized paths, legacy callers and bounded overflow.
 * No Electron, engine connection or filesystem writes. */
import { expect, test } from '@playwright/test'
import { requestWorkPreview, requestWorkPreviews, subscribeWorkPreview, workPreviewRevision } from '../src/renderer/src/core/workbench/preview-request'

test('a batch publishes one revision and notification for every affected path', () => {
  const source = 9101, sessionId = 'preview-batch'
  let notifications = 0
  const unsubscribe = subscribeWorkPreview(() => { notifications += 1 })
  try {
    const revision = requestWorkPreviews(source, sessionId, ['/project/one.md', '/project/two.md', '/project/one.md'])
    expect(notifications).toBe(1)
    expect(workPreviewRevision(source, sessionId, '/project/one.md')).toBe(revision)
    expect(workPreviewRevision(source, sessionId, '/project/two.md')).toBe(revision)
    expect(workPreviewRevision(source, sessionId, '/project/untouched.md')).toBe(0)
    requestWorkPreviews(source, sessionId, [])
    expect(notifications).toBe(1)
  } finally { unsubscribe() }
  requestWorkPreview(source, sessionId, '/project/three.md')
  expect(notifications).toBe(1)
})

test('completion invalidation remains in the original engine and session', () => {
  const source = 9102, path = '/shared/report.md'
  const revision = requestWorkPreviews(source, 'original-task', [path])
  expect(workPreviewRevision(source, 'original-task', path)).toBe(revision)
  expect(workPreviewRevision(source, 'newly-selected-task', path)).toBe(0)
  expect(workPreviewRevision(source + 1, 'original-task', path)).toBe(0)
  expect(workPreviewRevision(source, undefined, path)).toBe(0)
})

test('relative and absolute Windows paths share one normalized invalidation', () => {
  const source = 9104, sessionId = 'preview-windows', root = 'D:\\Work\\Project'
  const revision = requestWorkPreviews(source, sessionId, [
    '.\\reports\\drafts\\..\\Report.md', 'd:/work/project/reports/report.md'
  ], root)
  expect(workPreviewRevision(source, sessionId, 'D:\\WORK\\PROJECT\\REPORTS\\REPORT.MD')).toBe(revision)
  expect(workPreviewRevision(source, sessionId, 'reports/report.md', root)).toBe(revision)
  expect(workPreviewRevision(source, sessionId, './reports/Report.md', 'D:/work/project')).toBe(revision)
  expect(workPreviewRevision(source, sessionId, 'reports/report.md', 'D:/work/other')).toBe(0)
  expect(workPreviewRevision(source, sessionId, 'D:/work/project/reports/report2.md')).toBe(0)
})

test('normalization preserves POSIX case and matches UNC path spelling', () => {
  const source = 9105, sessionId = 'preview-platforms'
  const posixRevision = requestWorkPreview(source, sessionId, './Docs/../Report.md', '/project')
  expect(workPreviewRevision(source, sessionId, '/project/Report.md')).toBe(posixRevision)
  expect(workPreviewRevision(source, sessionId, '/project/report.md')).toBe(0)
  const uncRevision = requestWorkPreview(source, sessionId, '\\\\Server\\Share\\Reports\\A.md')
  expect(workPreviewRevision(source, sessionId, '//server/share/reports/a.md')).toBe(uncRevision)
  expect(workPreviewRevision(source, sessionId, '//server/other/reports/a.md')).toBe(0)
})

test('legacy unrooted requests still reach relative and resolved sandbox previews', () => {
  const source = 9106, sessionId = 'preview-private-sandbox'
  const revision = requestWorkPreview(source, sessionId, 'outputs/report.md')
  expect(workPreviewRevision(source, sessionId, 'outputs/report.md')).toBe(revision)
  expect(workPreviewRevision(source, sessionId, '/private/session/outputs/report.md', '/private/session')).toBe(revision)
  // Without a trusted root the fallback intentionally refreshes this whole
  // session, while the same path in other task/engine identities stays clean.
  expect(workPreviewRevision(source, sessionId, '/private/session/other.md')).toBe(revision)
  expect(workPreviewRevision(source, 'other-private-session', '/private/session/outputs/report.md')).toBe(0)
  expect(workPreviewRevision(source + 1, sessionId, '/private/session/outputs/report.md')).toBe(0)
})

test('an oversized batch retains early file invalidation through a session revision', () => {
  const source = 9108, sessionId = 'preview-large-batch'
  const paths = Array.from({ length: 400 }, (_, index) => `/project/file-${index}.md`)
  let notifications = 0
  const unsubscribe = subscribeWorkPreview(() => { notifications += 1 })
  try {
    const revision = requestWorkPreviews(source, sessionId, paths, '/project')
    expect(notifications).toBe(1)
    expect(workPreviewRevision(source, sessionId, paths[0])).toBe(revision)
    expect(workPreviewRevision(source, sessionId, paths[200])).toBe(revision)
    expect(workPreviewRevision(source, sessionId, paths[399])).toBe(revision)
    expect(workPreviewRevision(source, sessionId, 'file-0.md', '/project')).toBe(revision)
    expect(workPreviewRevision(source, 'other-large-task', paths[0])).toBe(0)
    expect(workPreviewRevision(source + 1, sessionId, paths[0])).toBe(0)
  } finally { unsubscribe() }
})

test('path eviction promotes earlier invalidations within their owning session', () => {
  const source = 9110, sessionId = 'preview-many-requests'
  const first = requestWorkPreview(source, sessionId, '/project/first.md')
  for (let index = 0; index < 150; index += 1) requestWorkPreview(source, sessionId, `/project/later-${index}.md`)
  expect(workPreviewRevision(source, sessionId, '/project/first.md')).toBeGreaterThanOrEqual(first)
  expect(workPreviewRevision(source, sessionId, '/project/later-149.md')).toBeGreaterThan(first)
  expect(workPreviewRevision(source, 'unrelated-task', '/project/first.md')).toBe(0)
})
