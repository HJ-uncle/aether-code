/** Pure coverage: screenshot/file/MCP result images, nested history JSON, text preservation and unsafe-source rejection. */
import { expect, test } from '@playwright/test'
import { parseToolResult } from '../src/renderer/src/contrib/chat/tool-result'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII='
const src = `data:image/png;base64,${png}`
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

test('ordinary tool text and JSON retain exact original formatting', () => {
  for (const value of ['build succeeded\n2 tests passed', '  {"files":["a.ts"],"count":1}\n', '"quoted result"', 'false']) {
    expect(parseToolResult(value)).toEqual({ images: [], text: value })
  }
})

test('browser screenshot extracts PNG and retains navigation metadata without base64 text', () => {
  const result = parseToolResult(JSON.stringify({
    filename: 'browser-screenshot.png', mimeType: 'image/png', size: 68, dataUrl: src,
    description: JSON.stringify({ browserTabId: 'tab-1', navigationId: 2, cssViewport: { width: 885, height: 697 } })
  }))
  expect(result.images).toEqual([{ src, alt: 'browser-screenshot.png' }])
  expect(result.text).toContain('navigationId')
  expect(result.text).toContain('tab-1')
  expect(result.text).toContain('[图片 1]')
  expect(result.text).not.toContain(png)
  expect(result.text).not.toContain('data:image')
})

test('file image_vision result and double-encoded history output display the same image', () => {
  const file = { type: 'image_vision', data: { filename: 'saved.png', mimeType: 'image/png', dataUrl: src } }
  const expected = parseToolResult(file)
  expect(expected.images).toEqual([{ src, alt: 'saved.png' }])
  expect(parseToolResult(JSON.stringify(JSON.stringify(file)))).toEqual(expected)
})

test('MCP image blocks preserve accompanying text and decode bare base64', () => {
  const result = parseToolResult({ content: [
    { type: 'text', text: '两个区域匹配。' },
    { type: 'image', mimeType: 'image/png', data: png },
    { type: 'image', mimeType: 'image/gif', data: gif }
  ] })
  expect(result.images).toEqual([{ src, alt: '工具输出图片 1' }, { src: `data:image/gif;base64,${gif}`, alt: '工具输出图片 2' }])
  expect(result.text).toContain('两个区域匹配。')
  expect(result.text).toContain('[图片 2]')
  expect(result.text).not.toContain(png)
  expect(result.text).not.toContain(gif)
})

test('Anthropic base64 source and OpenAI image_url wrappers share one image preview', () => {
  const result = parseToolResult({ content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    { type: 'image_url', image_url: { url: src } }
  ] })
  expect(result.images).toHaveLength(1)
  expect(result.images[0].src).toBe(src)
  expect(result.text.match(/\[图片 1\]/g)).toHaveLength(2)
})

test('JSON text inside an MCP block yields inline preview and keeps sibling text', () => {
  const result = parseToolResult({ content: [
    { type: 'text', text: JSON.stringify({ dataUrl: src, width: 1, height: 1 }) },
    { type: 'text', text: 'captured successfully' }
  ] })
  expect(result.images[0].src).toBe(src)
  expect(result.text).toContain('captured successfully')
  expect(result.text).toContain('width')
  expect(result.text).not.toContain(png)
})

test('truncated legacy JSON still hides and previews complete image data', () => {
  const result = parseToolResult(`{"status":"done","dataUrl":"${src}",`)
  expect(result.images[0].src).toBe(src)
  expect(result.text).toContain('"status":"done"')
  expect(result.text).not.toContain(png)
})

test('Markdown data images preview without discarding surrounding tool notes', () => {
  const result = parseToolResult(`已生成棋盘：\n![截图](${src})\n当前落子位置已标注。`)
  expect(result.images).toEqual([{ src, alt: '工具输出图片 1' }])
  expect(result.text).toContain('已生成棋盘：')
  expect(result.text).toContain('当前落子位置已标注。')
  expect(result.text).not.toContain(png)
})

test('standalone and structured data URLs normalize ASCII whitespace without leaving Base64 text', () => {
  const wrapped = `${png.slice(0, 40)}\r\n\t ${png.slice(40, 64)}\v\f${png.slice(64)}`
  for (const value of [
    `data:image/png;base64,${wrapped}`,
    JSON.stringify({ dataUrl: `data:image/png;base64,${wrapped}` }),
    { type: 'image_url', image_url: { url: `data:image/png;base64,${wrapped}` } }
  ]) {
    const result = parseToolResult(value)
    expect(result.images).toEqual([{ src, alt: '工具输出图片 1' }])
    expect(result.text).not.toContain(png.slice(40, 64))
    expect(result.text).not.toContain(png.slice(64))
  }
})

test('MCP bare Base64 accepts ASCII whitespace and still deduplicates a matching data URL', () => {
  const result = parseToolResult({ content: [
    { type: 'image', mimeType: 'image/png', data: `${png.slice(0, 28)} \r\n\t\f\v${png.slice(28)}` },
    { type: 'image_url', image_url: src }
  ] })
  expect(result.images).toEqual([{ src, alt: '工具输出图片 1' }])
  expect(result.text).not.toContain(png.slice(28))
})

test('malformed wrapped data URL fields redact the entire value', () => {
  const suffix = 'unexpected-payload-tail'.repeat(50)
  const result = parseToolResult({ dataUrl: `data:image/png;base64,${png.slice(0, 40)}\n${suffix}`, note: '保留说明' })
  expect(result.images).toHaveLength(0)
  expect(result.text).toContain('[图片数据无效或格式不支持]')
  expect(result.text).toContain('保留说明')
  expect(result.text).not.toContain(suffix)
})

test('standalone image followed by ordinary prose does not swallow the next line', () => {
  const result = parseToolResult(`${src}\nNOTE\nScreenshot captured successfully.`)
  expect(result.images).toEqual([{ src, alt: '工具输出图片 1' }])
  expect(result.text).toBe('[图片 1]\nNOTE\nScreenshot captured successfully.')
})

test('supported raster headers include JPEG, WebP, BMP and AVIF', () => {
  const signatures: [string, Uint8Array][] = [
    ['image/jpeg', new Uint8Array([255, 216, 255, 224])],
    ['image/webp', new TextEncoder().encode('RIFF0000WEBPVP8 ')],
    ['image/bmp', new TextEncoder().encode('BM000000')],
    ['image/avif', new TextEncoder().encode('0000ftypavif0000')]
  ]
  for (const [mimeType, bytes] of signatures) {
    const data = Buffer.from(bytes).toString('base64')
    const result = parseToolResult({ mimeType, base64: data })
    expect(result.images).toEqual([{ src: `data:${mimeType};base64,${data}`, alt: '工具输出图片 1' }])
  }
})

for (const [name, badSrc] of [
  ['SVG', 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4='],
  ['wrong MIME signature', `data:image/jpeg;base64,${png}`],
  ['invalid base64', 'data:image/png;base64,not-a-valid-image'],
  ['empty base64', 'data:image/png;base64,'],
  ['HTML disguised as PNG', 'data:image/png;base64,PGh0bWw+PHNjcmlwdD48L3NjcmlwdD48L2h0bWw+']
] as const) {
  test(`unsupported ${name} never produces an image source or raw payload dump`, () => {
    const result = parseToolResult({ dataUrl: badSrc })
    expect(result.images).toHaveLength(0)
    expect(result.text).toContain('[图片数据无效或格式不支持]')
    expect(result.text).not.toContain('data:image')
  })
}

test('remote URLs, file paths and javascript URLs stay metadata and are never loaded', () => {
  const value = JSON.stringify({ content: [
    { type: 'image_url', image_url: { url: 'https://attacker.invalid/track.png' } },
    { type: 'image', url: 'file:///C:/secrets.png' },
    { type: 'image', url: 'javascript:alert(1)' },
    { path: '/api/v1/workspace/file/download?path=secret.png&sessionId=other' }
  ] })
  expect(parseToolResult(value)).toEqual({ images: [], text: value })
})

test('an image block missing MIME is redacted without guessing an image type', () => {
  const result = parseToolResult({ type: 'image', data: png })
  expect(result.images).toHaveLength(0)
  expect(result.text).toContain('[图片数据无效或格式不支持]')
  expect(result.text).not.toContain(png)
})

test('cyclic and deeply nested results cannot crash the renderer', () => {
  const cycle: Record<string, unknown> = { dataUrl: src }
  cycle.self = cycle
  expect(parseToolResult(cycle).text).toContain('[循环引用]')
  let deep: unknown = { dataUrl: src }
  for (let i = 0; i < 100; i++) deep = { child: deep }
  expect(parseToolResult(deep).text).toContain('[结果嵌套过深，已省略]')
})
