/** Pure tool image galleries: verified document receipts group across calls,
 * page identity survives equal pixels, and unrelated or incomplete receipts stay isolated. */
import { expect, test } from '@playwright/test'
import { parseToolResult } from '../src/renderer/src/contrib/chat/tool-result'
import { buildToolImageGallery, toolImageReference } from '../src/renderer/src/contrib/chat/tool-image-gallery'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lFEAAAAASUVORK5CYII='
const hash = 'a'.repeat(64), sessionId = 'work-gallery', source = 7
const receipt = (page: number, override: Record<string, unknown> = {}) => ({
  sessionId, path: '/remote/review.pptx', sha256: hash, expectedHash: `sha256:${hash}`,
  page, pageCount: 3, renderer: 'aether-pptx-to-html-1.1.2', filename: `review.pptx · 第 ${page}/3 页`,
  mimeType: 'image/png', dataUrl: PNG, ...override
})
const tool = (toolId: string, value: unknown, toolName = 'workbench_render') => ({ toolId, toolName, result: parseToolResult(value) })
// Exact whitelist emitted by the old truncateToolOutput for large data URLs.
const trimmed = (path = '/remote/review.pptx', sha256 = hash, override: Record<string, unknown> = {}) => ({
  filename: 'review.pptx · 第 99/100 页', mimeType: 'image/png', description: '原文件预览', size: 200_000,
  dataUrl: PNG, hasDataUrl: true,
  fileVersion: { path, expectedHash: `sha256:${sha256}`, encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false }, ...override
})
const legacy = (id: string, page: number, value: unknown = trimmed(), args: unknown = { path: '/remote/review.pptx', page }) =>
  ({ ...tool(id, JSON.stringify(value)), args })

test('separate calls sort by verified page number and exclude another document between them', () => {
  const index = buildToolImageGallery([
    tool('page-3', JSON.stringify(receipt(3))), tool('other', receipt(1, { path: '/remote/other.pptx' })),
    tool('page-1', receipt(1)), tool('page-2', receipt(2))
  ], { source, sessionId })
  const selected = index.images.get(toolImageReference('page-2', 0))!
  const group = index.groups.get(selected.groupId)!
  expect(group.items.map(item => item.toolId)).toEqual(['page-1', 'page-2', 'page-3'])
  expect(group.items.findIndex(item => item.identity === selected.identity)).toBe(1)
  expect(index.images.get(toolImageReference('other', 0))!.groupId).not.toBe(group.id)
})

test('identical bytes on distinct document pages remain separate images and annotation identities', () => {
  const result = parseToolResult([receipt(1), receipt(2)])
  expect(result.images).toHaveLength(2)
  expect(result.images.map(image => image.src)).toEqual([PNG, PNG])
  expect(result.images.map(image => image.documentPage?.page)).toEqual([1, 2])
  const index = buildToolImageGallery([{ toolId: 'two-pages', toolName: 'workbench_render', result }], { source, sessionId })
  const groups = [...index.groups.values()]
  expect(groups).toHaveLength(1)
  expect(groups[0].items).toHaveLength(2)
  expect(groups[0].items[0].identity).not.toBe(groups[0].items[1].identity)
})

test('connection, session, document version, renderer and page-count boundaries never mix', () => {
  const results = [tool('base', receipt(1)), tool('version', receipt(2, { sha256: 'b'.repeat(64), expectedHash: `sha256:${'b'.repeat(64)}` })),
    tool('session', receipt(2, { sessionId: 'another-session' })), tool('renderer', receipt(2, { renderer: 'another-renderer' })),
    tool('count', receipt(2, { pageCount: 4 }))]
  const first = buildToolImageGallery(results, { source, sessionId })
  expect(first.groups.size).toBe(5)
  expect([...first.groups.values()].every(group => group.items.length === 1)).toBe(true)
  const second = buildToolImageGallery(results, { source: source + 1, sessionId })
  expect(first.images.get(toolImageReference('base', 0))!.groupId).not.toBe(second.images.get(toolImageReference('base', 0))!.groupId)
})

test('nested wrappers retain image ownership while incomplete or contradictory page metadata is rejected', () => {
  const result = parseToolResult(JSON.stringify({ output: JSON.stringify({ ...receipt(2), dataUrl: undefined,
    content: [{ type: 'image', mimeType: 'image/png', data: PNG.split(',')[1] }] }) }))
  expect(result.images[0].documentPage).toMatchObject({ page: 2, pageCount: 3, path: '/remote/review.pptx', sha256: hash, sessionId })
  expect(result.text).toContain('"page": 2')
  expect(result.text).not.toContain(PNG.split(',')[1])
  for (const override of [{ expectedHash: `sha256:${'b'.repeat(64)}` }, { page: 4 }, { page: '2' }, { renderer: '' },
    { sessionId: '' }, { path: 'review.pptx' }, { path: '/remote/../review.pptx' }, { fileVersion: { path: '/remote/other.pptx' } }]) {
    expect(parseToolResult(receipt(2, override)).images[0].documentPage).toBeUndefined()
  }
  const child = parseToolResult({ ...receipt(1), dataUrl: undefined,
    content: [{ type: 'image', mimeType: 'image/png', data: PNG.split(',')[1], page: 9 }] })
  expect(child.images[0].documentPage).toBeUndefined()
})

test('generic images use only their own result gallery and never infer document ownership from names', () => {
  const first = tool('generic-a', [{ title: 'review.pptx · 第 1/3 页', dataUrl: PNG },
    { title: 'review.pptx · 第 2/3 页', dataUrl: PNG.replace('CAQAAAC1', 'CAQAAAC2') }], 'render_image')
  const second = tool('generic-b', { title: 'review.pptx · 第 3/3 页', dataUrl: PNG }, 'render_image')
  const index = buildToolImageGallery([first, second], { source, sessionId })
  const a = index.images.get(toolImageReference('generic-a', 0))!, b = index.images.get(toolImageReference('generic-b', 0))!
  expect(a.groupId).not.toBe(b.groupId)
  expect(index.groups.get(a.groupId)!.items).toHaveLength(2)
  expect(index.groups.get(b.groupId)!.items).toHaveLength(1)
})

test('repeated checks of one versioned page do not add duplicate navigation stops', () => {
  const index = buildToolImageGallery([tool('original', receipt(2)), tool('page-1', receipt(1)), tool('recheck', receipt(2))], { source, sessionId })
  const original = index.images.get(toolImageReference('original', 0))!, recheck = index.images.get(toolImageReference('recheck', 0))!
  expect(original).toEqual(recheck)
  expect(index.groups.get(original.groupId)!.items.map(item => item.toolId)).toEqual(['page-1', 'recheck'])
})

test('old trimmed receipts reconnect by invocation page and validated file version, never their display title', () => {
  const index = buildToolImageGallery([legacy('three', 3), legacy('one', 1, trimmed(), JSON.stringify({ path: 'review.pptx', page: 1 })),
    legacy('two', 2), legacy('other', 2, trimmed('/remote/other.pptx'), { path: '/remote/other.pptx', page: 2 })], { source, sessionId })
  const group = index.groups.get(index.images.get(toolImageReference('two', 0))!.groupId)!
  expect(group.items.map(item => item.toolId)).toEqual(['one', 'two', 'three'])
  expect(group.items.map(item => item.image.documentPage?.page)).toEqual([1, 2, 3])
  expect(group.items.every(item => item.image.documentPage?.pageCount === undefined)).toBe(true)
  expect(index.groups.size).toBe(2)
})

test('legacy and modern receipts share a single consistent renderer, with opened snapshots unchanged by later receipts', () => {
  const old = [legacy('one', 1), legacy('two', 2)]
  const original = buildToolImageGallery(old, { source, sessionId })
  const opened = [...original.groups.values()][0]
  const current = buildToolImageGallery([...old, tool('three', receipt(3))], { source, sessionId })
  expect(current.groups.size).toBe(1)
  expect([...current.groups.values()][0].items.map(item => item.toolId)).toEqual(['one', 'two', 'three'])
  expect(opened.items.map(item => item.toolId)).toEqual(['one', 'two'])
  const conflicting = buildToolImageGallery([...old, tool('three', receipt(3)), tool('other-renderer', receipt(1, { renderer: 'other' }))], { source, sessionId })
  expect(conflicting.groups.size).toBe(3)
  expect(conflicting.groups.get(conflicting.images.get(toolImageReference('one', 0))!.groupId)!.items.map(item => item.toolId)).toEqual(['one', 'two'])
})

test('legacy recovery rejects missing invocations, invalid versions and contradictory page metadata', () => {
  const invalid = [legacy('missing-args', 1, trimmed(), undefined), legacy('missing-page', 1, trimmed(), { path: '/remote/review.pptx' }),
    legacy('string-page', 1, trimmed(), { page: '1' }), legacy('path-mismatch', 1, trimmed(), { page: 1, path: '/remote/other.pptx' }),
    legacy('bad-version', 1, trimmed('/remote/review.pptx', 'not-a-hash')), legacy('relative-version', 1, trimmed('review.pptx')),
    legacy('partial-modern', 1, trimmed('/remote/review.pptx', hash, { page: 1 })),
    legacy('modern-conflict', 2, receipt(1)), { ...legacy('wrong-tool', 1), toolName: 'read_file' }]
  // Undefined must reach the gallery, rather than the helper's default argument.
  invalid[0].args = undefined
  const index = buildToolImageGallery([...invalid, legacy('valid-one', 1), legacy('valid-two', 2)], { source, sessionId })
  const validGroup = index.images.get(toolImageReference('valid-one', 0))!.groupId
  for (const item of invalid) {
    const group = index.groups.get(index.images.get(toolImageReference(item.toolId, 0))!.groupId)!
    expect(group.items).toHaveLength(1)
    expect(group.id).not.toBe(validGroup)
  }
  expect(index.groups.get(validGroup)!.items).toHaveLength(2)
})
