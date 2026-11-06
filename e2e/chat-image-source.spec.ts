/** Pure message-image classification and byte validation: paths, session URLs,
 * raster signatures, SVG img sources and size limits. No Electron or filesystem reads. */
import { expect, test } from '@playwright/test'
import type { FsFileContent } from '../src/shared/ipc'
import { chatImageFileSource, classifyChatImage, MAX_CHAT_IMAGE_BYTES } from '../src/renderer/src/contrib/chat/chat-image-source'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+S8AAAAASUVORK5CYII='
const pngSource = `data:image/png;base64,${png}`
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>中文 100% #标签</text></svg>'
const artifact = (path: string, sessionId = 'session-a') => '/api/v1/workspace/file/download?' + new URLSearchParams({ sessionId, path })
const file = (patch: Partial<FsFileContent> = {}): FsFileContent => ({ path: '截图.png', content: '', base64: png, isBinary: true, size: 68, truncated: false, ...patch })

test('local image paths retain Unicode, spaces, literal percent and hash without URL decoding', () => {
  for (const path of ['D:/项目/截图 100% #tag%23.png', 'C:\\项目\\截图 100% #tag%23.png', '/project/截图 100% #tag%23.png', 'images/截图 100% #tag%23.png']) {
    expect(classifyChatImage(path)).toEqual({ kind: 'file', path })
  }
  expect(classifyChatImage('././images/图.png')).toEqual({ kind: 'file', path: 'images/图.png' })
  expect(classifyChatImage('.\\images\\图.png')).toEqual({ kind: 'file', path: 'images\\图.png' })
  expect(classifyChatImage('/D:/项目/图.png')).toEqual({ kind: 'file', path: 'D:/项目/图.png' })
  expect(classifyChatImage('images/screenshot')).toEqual({ kind: 'file', path: 'images/screenshot' })
})

test('file URLs decode once and reject host, credentials, queries and fragments', () => {
  expect(classifyChatImage('file:///D:/项目/截图%20100%25%20%23tag%2523.png')).toEqual({ kind: 'file', path: 'D:/项目/截图 100% #tag%23.png' })
  expect(classifyChatImage('file:///workspace/图%20片.png')).toEqual({ kind: 'file', path: '/workspace/图 片.png' })
  for (const href of ['file://host/share/a.png', 'file://localhost/a.png', 'file://user:password@host/a.png', 'file:///a.png?x=1', 'file:///a.png?', 'file:///a.png#x', 'file:relative.png', 'file:///a%2Fb.png', 'file:///bad%.png', 'file:///a%00.png']) {
    expect(classifyChatImage(href).kind, href).toBe('unavailable')
  }
})

test('artifact images use the owning session and decode query filenames exactly once', () => {
  const engine = 'http://127.0.0.1:12323'
  for (const path of ['图片/截图 100% #标签+.png', 'literal%23/image.png']) {
    expect(classifyChatImage(artifact(path), 'session-a', engine)).toEqual({ kind: 'file', path })
    expect(classifyChatImage(engine + artifact(path), 'session-a', engine)).toEqual({ kind: 'file', path })
  }
  expect(classifyChatImage(artifact('a.png', 'session-b'), 'session-a')).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('会话') })
  expect(classifyChatImage(artifact('a.png'))).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('会话') })
  for (const href of [artifact('../a.png'), artifact('a.png') + '&path=b.png', 'https://other.example' + artifact('a.png'), '/api/unknown?path=a.png']) {
    expect(classifyChatImage(href, 'session-a', engine).kind).toBe('unavailable')
  }
})

test('untrusted protocols and ambiguous filesystem paths cannot initiate image loading', () => {
  for (const href of ['', '#figure', 'C:', 'C:relative.png', '../a.png', './a/../b.png', 'a/./b.png', 'javascript:alert(1)', 'blob:https://example/id', 'https://example/a.png', '//example/a.png', 'a\u0000.png', 'data:text/html,<img src=x>']) {
    expect(classifyChatImage(href).kind, href).toBe('unavailable')
  }
})

test('raster data URLs and file bytes keep their image signature', () => {
  expect(classifyChatImage(pngSource)).toEqual({ kind: 'data', src: pngSource })
  expect(chatImageFileSource(file())).toBe(pngSource)
  const bytes = Uint8Array.from(Buffer.from(png, 'base64'))
  expect(chatImageFileSource(file({ bytes: bytes.buffer, base64: undefined }))).toBe(pngSource)
  expect(chatImageFileSource(file({ path: 'animation.apng' }))).toBe(pngSource)
  expect(chatImageFileSource(file({ path: 'icon.ico', base64: 'AAABAAEAAAAA' }))).toBe('data:image/x-icon;base64,AAABAAEAAAAA')
})

test('malformed and mismatched images fail explicitly instead of producing a broken source', () => {
  for (const data of ['data:image/png;base64,abcd', 'data:image/png;base64,%%%%', `data:image/jpeg;base64,${png}`, 'data:image/png,raw', 'data:image/png;base64,']) {
    expect(classifyChatImage(data)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('图片数据') })
  }
  for (const patch of [{ path: 'wrong.jpg' }, { path: 'page.html' }, { base64: '%%%%' }, { base64: '' }, { path: 'bad.ico', base64: png }, { size: NaN }, { size: -1 }]) {
    expect(() => chatImageFileSource(file(patch))).toThrow('图片数据')
  }
  expect(() => chatImageFileSource(file({ truncated: true }))).toThrow('内容不完整')
  expect(() => chatImageFileSource(file({ tooLarge: true }))).toThrow('20 MiB')
})

test('SVG base64, percent data and text files remain self-contained img sources', () => {
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  expect(classifyChatImage(source)).toEqual({ kind: 'data', src: source })
  expect(classifyChatImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)).toEqual({ kind: 'data', src: source })
  expect(classifyChatImage(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)).toEqual({ kind: 'data', src: source })
  expect(chatImageFileSource(file({ path: '图.svg', isBinary: false, content: svg, base64: undefined }))).toBe(source)
  const bytes = Uint8Array.from(Buffer.from(svg))
  expect(chatImageFileSource(file({ path: '图.svg', bytes: bytes.buffer, base64: undefined }))).toBe(source)
  const declared = '<?xml version="1.0"?>\n<!-- exported -->\n' + svg
  expect(classifyChatImage(`data:image/svg+xml,${encodeURIComponent(declared)}`).kind).toBe('data')
  for (const data of ['data:image/svg+xml,%ZZ', 'data:image/svg+xml,<html>not SVG</html>', 'data:image/svg+xml;base64,/w==']) {
    expect(classifyChatImage(data).kind).toBe('unavailable')
  }
  expect(() => chatImageFileSource(file({ path: 'bad.svg', content: '<html></html>', base64: undefined, isBinary: false }))).toThrow('图片数据')
  expect(() => chatImageFileSource(file({ path: 'bad.svg', base64: '/w==' }))).toThrow('图片数据')
})

test('20 MiB cap uses actual decoded bytes and rejects misleading metadata', () => {
  expect(() => chatImageFileSource(file({ size: MAX_CHAT_IMAGE_BYTES + 1 }))).toThrow('20 MiB')
  const bytes = Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1)
  Buffer.from(png, 'base64').copy(bytes)
  const oversized = bytes.toString('base64')
  expect(classifyChatImage(`data:image/png;base64,${oversized}`)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('20 MiB') })
  expect(() => chatImageFileSource(file({ base64: oversized, size: 1 }))).toThrow('20 MiB')
  expect(() => chatImageFileSource(file({ bytes: Uint8Array.from(bytes).buffer, size: 1 }))).toThrow('20 MiB')
  const exact = bytes.subarray(0, MAX_CHAT_IMAGE_BYTES).toString('base64')
  expect(classifyChatImage(`data:image/png;base64,${exact}`).kind).toBe('data')
  const multibyteSvg = `<svg>${'中'.repeat(Math.ceil(MAX_CHAT_IMAGE_BYTES / 3))}</svg>`
  expect(() => chatImageFileSource(file({ path: 'large.svg', base64: undefined, content: multibyteSvg, isBinary: false, size: 1 }))).toThrow('20 MiB')
})
