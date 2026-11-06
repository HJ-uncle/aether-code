/** Compact file rows use U/M/D for binary receipts and preserve complete text
 * diff statistics; missing snapshots never imply deletion or zero line counts. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange } from '../src/shared/ipc'
import { workFileChangeCode, workFileChangeStats, workFileIsNew, workFilePrefersPreview } from '../src/renderer/src/contrib/work/work-file-change-presentation'

const change = (patch: Partial<EngineFileChange> = {}): EngineFileChange => ({
  id: 'change', sessionId: 'work-task', path: 'file.txt', kind: 'write', oldContent: 'old\nkeep\n',
  newContent: 'new\nkeep\nextra\n', truncated: false, status: 'pending', createdAt: 1, ...patch
})

test('新增、编辑和删除使用完整快照统计，空文件与末尾换行不多造行数', () => {
  expect(workFileChangeStats(change())).toEqual({ added: 2, removed: 1, approximate: false })
  expect(workFileChangeStats(change({ isNew: true, oldContent: null, newContent: 'one\ntwo\n' }))).toEqual({ added: 2, removed: 0, approximate: false })
  expect(workFileChangeStats(change({ kind: 'delete', newContent: null }))).toEqual({ added: 0, removed: 2, approximate: false })
  expect(workFileChangeStats(change({ isNew: true, oldContent: null, newContent: '' }))).toEqual({ added: 0, removed: 0, approximate: false })
  expect(workFileChangeStats(change({ oldContent: 'line', newContent: 'line\n' }))).toEqual({ added: 1, removed: 1, approximate: false })
})

test('快照缺失或截断显示未知，不误报零行或新文件', () => {
  for (const value of [
    change({ truncated: true }), change({ newContent: null }),
    change({ oldContent: null, isNew: false }), change({ oldContent: null, oldHash: 'a'.repeat(64) }),
    change({ kind: 'delete', oldContent: null, newContent: null })
  ]) expect(workFileChangeStats(value)).toBeNull()
  expect(workFileIsNew(change({ oldContent: null, oldHash: 'a'.repeat(64) }))).toBe(false)
  expect(workFileIsNew(change({ oldContent: null, oldHash: 'missing' }))).toBe(true)
  expect(workFileIsNew(change({ oldContent: null }))).toBe(true)
  expect(workFileIsNew(change({ kind: 'delete', oldContent: null }))).toBe(false)
})

test('超过LCS预算的完整内容显示估算计数而非截断后的假精确值', () => {
  const before = Array.from({ length: 1100 }, (_, index) => index === 550 ? 'shared middle line' : `before-${index}`).join('\n')
  const after = Array.from({ length: 1100 }, (_, index) => index === 550 ? 'shared middle line' : `after-${index}`).join('\n')
  expect(workFileChangeStats(change({ oldContent: before, newContent: after }))).toEqual({ added: 1100, removed: 1100, approximate: true })
})

test('二进制回执依靠文件版本显示 U、M、D，不用缺失文本推断删除', () => {
  const image = change({ path: 'shots/mobile.png', oldContent: null, newContent: null, truncated: true,
    oldHash: 'missing', newHash: `sha256:${'a'.repeat(64)}` })
  expect(workFileChangeCode(image)).toBe('U')
  expect(workFileIsNew(image)).toBe(true)
  expect(workFileChangeStats(image)).toBeNull()
  expect(workFileChangeCode({ ...image, oldHash: `sha256:${'b'.repeat(64)}` })).toBe('M')
  expect(workFileChangeCode({ ...image, kind: 'delete', newHash: 'missing' })).toBe('D')
  expect(workFileChangeCode({ ...image, oldHash: undefined, isNew: true })).toBe('U')
  expect(workFileChangeCode({ ...image, oldHash: undefined, isNew: false })).toBe('M')
  expect(workFileChangeCode({ ...image, oldHash: undefined })).toBe('M')
  expect(workFileChangeCode({ ...image, kind: 'delete', isNew: true })).toBe('D')
})

test('图片、视频及办公文档沿用已有预览类型，不计算文本行数', () => {
  for (const path of ['image.PNG', 'photo.jpeg', 'animation.webp', 'clip.mp4', 'report.PDF', 'document.docx', 'table.xlsx', 'slides.pptx']) {
    expect(workFilePrefersPreview(path), path).toBe(true)
    expect(workFileChangeStats(change({ path })), path).toBeNull()
  }
  for (const path of ['src/app.ts', 'chart.svg', 'notes.md', 'table.csv', 'image.png.ts', 'archive.bin']) {
    expect(workFilePrefersPreview(path), path).toBe(false)
  }
})
