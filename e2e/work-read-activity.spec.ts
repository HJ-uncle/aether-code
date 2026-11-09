/** Read receipt compatibility and pagination presentation; pure functions, no Electron window or build. */
import { expect, test } from '@playwright/test'
import { readActivityFiles, readActivityPreview } from '../src/renderer/src/contrib/work/work-activity-presentation'

const hash = 'a'.repeat(64)
const version = { path: 'D:/workspace/example.ts', expectedHash: `sha256:${hash}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false }
const page = {
  ...version, byteLength: 600, totalLines: 30, requestedEndLine: 30,
  startLine: 1, startColumn: 1, endLine: 2, endColumn: 6, columnUnit: 'utf16', partialLine: false,
  hasMore: true, nextStartLine: 3, nextStartColumn: 1, rangeIsComplete: false, contentIsComplete: false,
  numberedContent: '1 | first\n2 | second'
}
const preview = (receipt: unknown) => readActivityPreview({ name: 'read_file', state: 'done', result: JSON.stringify(receipt) })

test('numbered pages expose source and the available range without version metadata', () => {
  const result = preview(page)
  expect(result).toEqual({ content: '1 | first\n2 | second', range: {
    label: '引用行数：1–2', title: '本次读取第 1–2 行 · 文件共 30 行'
  } })
  expect(result?.content).not.toContain(hash)
  expect(result?.content).not.toContain('utf-8')
  expect(result?.content).not.toContain(version.path)
  expect(page.numberedContent).toBe('1 | first\n2 | second')
})

test('final pages, explicit line ranges and empty files do not claim more content', () => {
  expect(preview({ ...page, startLine: 30, endLine: 30, hasMore: false, nextStartLine: null, nextStartColumn: null,
    rangeIsComplete: true, numberedContent: '30 | last' })).toEqual({ content: '30 | last', range: { label: '引用行数：30', title: '本次读取第 30 行 · 文件共 30 行' } })
  expect(preview({ ...page, requestedEndLine: 2, hasMore: false, nextStartLine: null, nextStartColumn: null,
    rangeIsComplete: true })).toEqual({ content: '1 | first\n2 | second', range: { label: '引用行数：1–2', title: '本次读取第 1–2 行 · 文件共 30 行' } })
  expect(preview({ ...page, byteLength: 0, totalLines: 1, requestedEndLine: 1, endLine: 1, endColumn: 0,
    hasMore: false, nextStartLine: null, nextStartColumn: null, rangeIsComplete: true, contentIsComplete: true,
    numberedContent: '1 | ' })).toEqual({ content: '1 | ', range: { label: '引用行数：1', title: '本次读取第 1 行 · 文件共 1 行' } })
})

test('a long line shows that its current page contains only part of the line', () => {
  expect(preview({ ...page, startLine: 2, startColumn: 8, endLine: 2, endColumn: 12, partialLine: true,
    nextStartLine: 2, nextStartColumn: 13, numberedContent: '2 | 文本😀' })).toEqual({
    content: '2 | 文本😀', range: { label: '引用行数：2', title: '本次读取第 2 行（含不完整行） · 文件共 30 行' }
  })
})

test('legacy and current exact receipts preserve source bytes, empty content and hash formats', () => {
  for (const expectedHash of [hash, `sha256:${hash}`]) {
    const exact = { ...version, expectedHash, startLine: 1, endLine: 2, totalLines: 2, content: '\uFEFF第一行\r\n第二行\r\n' }
    const range = { label: '引用行数：1–2', title: '本次读取第 1–2 行 · 文件共 2 行' }
    expect(preview(exact)).toEqual({ content: exact.content, range })
    expect(preview({ ...exact, sha256: hash, byteLength: 30, trailingLineEnding: 'CRLF', contentIsComplete: true })).toEqual({ content: exact.content, range })
    expect(preview({ ...exact, startLine: 1, endLine: 1, totalLines: 1, content: '' })).toEqual({ content: '', range: { label: '引用行数：1', title: '本次读取第 1 行 · 文件共 1 行' } })
  }
})

test('legacy textual envelopes still unwrap only the known prefix', () => {
  for (const expectedHash of [hash, `sha256:${hash}`]) {
    const result = `[读取监控] 耗时: 1ms\n[文件版本] ${JSON.stringify({ ...version, expectedHash })}\n[精确编辑] 读取原文后编辑。\n\n1 | source\n`
    expect(readActivityPreview({ name: 'read_file', state: 'done', result })).toEqual({ content: '1 | source\n' })
  }
})

test('unknown, invalid and unfinished results remain intact for the normal fallback', () => {
  for (const receipt of [
    { ...page, unexpected: 'diagnostic' }, { ...page, expectedHash: 'invalid' },
    { ...page, startLine: 0 }, { ...page, startLine: 3 }, { ...page, endLine: 31 },
    { ...page, totalLines: 2.5 }, { ...page, hasMore: 'yes' },
    { ...page, nextStartLine: null }, { ...page, nextStartColumn: 0 },
    { ...page, hasMore: false }, { path: 'document.json', content: 'ordinary JSON' }
  ]) expect(preview(receipt)).toBeNull()
  for (const tool of [
    { name: 'write_file', state: 'done', result: JSON.stringify(page) },
    { name: 'read_file', state: 'running', result: JSON.stringify(page) },
    { name: 'read_file', state: 'error', result: JSON.stringify(page) },
    { name: 'read_file', state: 'done', result: JSON.stringify(page), error: 'read failed' },
    { name: 'read_file', state: 'done', result: '{partial JSON' },
    { name: 'read_file', state: 'done', result: 'ordinary source text' }
  ]) expect(readActivityPreview(tool)).toBeNull()
})

test('successful read metadata supplies actual page bounds without guessing from the request or output', () => {
  const { numberedContent: result, ...metadata } = page
  const tool = { name: 'read_file', state: 'done', result, metadata }
  expect(readActivityPreview(tool)).toEqual({ content: result, range: { label: '引用行数：1–2', title: '本次读取第 1–2 行 · 文件共 30 行' } })
  expect(readActivityPreview({ ...tool, result: JSON.stringify({ ...page, endLine: 3, nextStartLine: 4, numberedContent: `${result}\n3 | third` }) })?.range?.label).toBe('引用行数：1–3')
  expect(readActivityPreview({ ...tool, state: 'error' })).toBeNull()
  expect(readActivityPreview({ ...tool, state: 'running' })).toBeNull()
  expect(readActivityPreview({ ...tool, metadata: { ...metadata, endLine: 31 } })).toBeNull()
  expect(readActivityPreview({ ...tool, metadata: version })).toBeNull()
  const requestOnly = { ...tool, metadata: undefined, args: '{"start_line":1,"end_line":30}' }
  expect(readActivityPreview(requestOnly)).toBeNull()
})

test('batch partial failures retain successful content and per-file ranges without a batch range', () => {
  const result = JSON.stringify({ batch: true, files: [
    { path: 'a.ts', success: true, output: page },
    { path: 'missing.ts', success: false, error: 'FILE_READ_FAILED', output: { message: '文件不存在' } },
    { path: 'cancelled.ts', success: false, status: 'cancelled', error: 'FILE_BATCH_CANCELLED', output: { message: '读取已取消' } }
  ] })
  const source = { name: 'read_file', state: 'error', error: 'Some files failed', result, metadata: { ...page, batch: true } }
  const parsed = readActivityPreview(source)
  expect(parsed?.range).toBeUndefined()
  expect(parsed?.content).toContain('a.ts · 已读取\n本次读取第 1–2 行 · 文件共 30 行\n1 | first\n2 | second')
  expect(parsed?.content).toContain('missing.ts · 读取失败\n文件不存在\nFILE_READ_FAILED')
  expect(parsed?.content).toContain('cancelled.ts · 已取消')
  expect(parsed?.content).not.toContain(hash)
  expect(source.result).toBe(result)
})

test('each batch file keeps its own range and empty-file state', () => {
  const parsed = preview({ batch: true, files: [
    { path: 'first.ts', success: true, output: page },
    { path: 'empty.ts', success: true, output: { ...version, startLine: 1, endLine: 1, totalLines: 1, content: '' } }
  ] })
  expect(parsed?.range).toBeUndefined()
  expect(parsed?.content).toContain('first.ts · 已读取\n本次读取第 1–2 行 · 文件共 30 行')
  expect(parsed?.content).toContain('empty.ts · 已读取\n本次读取第 1 行 · 文件共 1 行\n文件内容为空')
})

test('Office batch previews show warnings and independent cursors without claiming a full or visual review', () => {
  const result = JSON.stringify({ batch: true, files: [
    { path: 'report.docx', success: true, executed: true, output: {
      ...version, path: 'report.docx', content: '正文', contentIncluded: true, warnings: ['仅提取正文'],
      contentPage: { offset: 0, returnedChars: 2, totalPreviewChars: 20, nextOffset: 2, hasMore: true, sourceTruncated: false, documentComplete: false }
    } },
    { path: 'data.xlsx', success: true, executed: true, output: {
      ...version, path: 'data.xlsx', content: '末尾', contentIncluded: true, warnings: ['公式缓存未重算'],
      contentPage: { offset: 98, returnedChars: 2, totalPreviewChars: 100, nextOffset: null, hasMore: false, sourceTruncated: true, documentComplete: false }
    } },
    { path: 'blocked.pptx', success: false, executed: false, error: 'OFFICE_BATCH_PENDING_INPUT', output: { message: '等待许可' } }
  ] })
  const parsed = readActivityPreview({ name: 'office_inspect', state: 'waiting', result })
  expect(parsed?.range).toBeUndefined()
  expect(parsed?.content).toContain('report.docx · 已检查\n预览字符 1–2 / 20 · 还有更多内容 · 非全文或版式验收\n提示：仅提取正文\n正文')
  expect(parsed?.content).toContain('data.xlsx · 已检查\n预览字符 99–100 / 100 · 提取范围有限 · 非全文或版式验收\n提示：公式缓存未重算\n末尾')
  expect(parsed?.content).toContain('blocked.pptx · 未执行\n等待许可')
})

test('malformed batch data and running results stay available to the unmodified fallback', () => {
  for (const receipt of [
    { batch: true, files: [] }, { batch: true, files: [{ path: 'a.txt', success: true }] },
    { batch: true, files: [{ path: 'a.txt', success: 'yes', output: 'text' }] },
    { batch: true, files: [{ path: 'a.txt', success: true, output: 'text', unknown: 'important details' }] },
    { batch: false, files: [{ path: 'a.txt', success: true, output: page }] }
  ]) expect(preview(receipt)).toBeNull()
  const result = JSON.stringify({ batch: true, files: [{ path: 'a.txt', success: true, output: page }] })
  expect(readActivityPreview({ name: 'read_file', state: 'running', result })).toBeNull()
  expect(readActivityPreview({ name: 'write_file', state: 'done', result })).toBeNull()
  expect(readActivityPreview({ name: 'office_inspect', state: 'done', result: JSON.stringify(page) })).toBeNull()
})

test('collapsed file summaries use actual current page ranges, never requested limits or total lines', () => {
  const files = [
    { path: 'D:/workspace/README.md', success: true, output: { ...page, path: 'D:/workspace/README.md',
      startLine: 1, endLine: 255, totalLines: 1000, requestedEndLine: 1000, nextStartLine: 256 } },
    { path: 'D:/workspace/src/app.ts', success: true, output: { ...page, path: 'D:/workspace/src/app.ts',
      startLine: 64, endLine: 123, totalLines: 900, requestedEndLine: 900, nextStartLine: 124 } }
  ]
  const source = { name: 'read_file', state: 'done', args: JSON.stringify({ files: files.map(file => ({ path: file.path, end_line: 99999 })) }),
    result: JSON.stringify({ batch: true, files }) }
  const original = structuredClone(source), summaries = readActivityFiles(source)!
  expect(summaries.map(file => [file.label, file.range, file.state])).toEqual([
    ['README.md', '1–255', undefined], ['app.ts', '64–123', undefined]
  ])
  expect(summaries[0].title).toBe('D:/workspace/README.md\n本次读取第 1–255 行 · 文件共 1000 行')
  expect(summaries[1].title).toContain('本次读取第 64–123 行 · 文件共 900 行')
  expect(source).toEqual(original)
})

test('success, failure, cancellation and unexecuted items keep independent states and only successful ranges', () => {
  const rows = [
    { path: 'D:/workspace/example.ts', success: true, output: page },
    { path: 'failed.ts', success: false, error: 'FILE_READ_FAILED', output: page },
    { path: 'cancelled.ts', success: false, error: 'FILE_BATCH_CANCELLED', output: page },
    { path: 'pending.ts', success: false, executed: false, output: { message: 'Await permission' } }
  ]
  const summaries = readActivityFiles({ name: 'read_file', state: 'error', error: 'Partial failure',
    result: JSON.stringify({ batch: true, files: rows }), metadata: { ...page, batch: true } })!
  expect(summaries.map(file => [file.label, file.range, file.state])).toEqual([
    ['example.ts', '1–2', undefined], ['failed.ts', undefined, 'error'], ['cancelled.ts', undefined, 'cancelled'], ['pending.ts', undefined, 'pending']
  ])
  expect(summaries[1].title).toContain('FILE_READ_FAILED')
  expect(summaries[3].title).toContain('Await permission')
})

test('metadata pages match by actual path and version, not by their array index', () => {
  const a = { ...page, path: 'D:/workspace/a.ts', startLine: 10, endLine: 12, nextStartLine: 13 }
  const b = { ...page, path: 'D:/workspace/b.ts', startLine: 20, endLine: 25, nextStartLine: 26 }
  const rows = [{ path: a.path, success: true, output: 'a source' }, { path: b.path, success: true, output: 'b source' }]
  const result = JSON.stringify({ batch: true, files: rows })
  const summaries = readActivityFiles({ name: 'read_file', state: 'done', result, metadata: { batch: true, files: [b, a] } })!
  expect(summaries.map(file => file.range)).toEqual(['10–12', '20–25'])
  const differentPaths = readActivityFiles({ name: 'read_file', state: 'done', result,
    metadata: { batch: true, files: [{ ...a, path: 'D:/another/a.ts' }, { ...b, path: 'D:/another/b.ts' }] } })!
  expect(differentPaths.map(file => file.range)).toEqual([undefined, undefined])
  const differentVersion = readActivityFiles({ name: 'read_file', state: 'done', result: JSON.stringify({ batch: true, files: [
    { path: a.path, success: true, output: { path: a.path, expectedHash: `sha256:${'b'.repeat(64)}` } }
  ] }), metadata: { batch: true, files: [a] } })!
  expect(differentVersion[0].range).toBeUndefined()
  const wrongInnerPath = readActivityFiles({ name: 'read_file', state: 'done', result: JSON.stringify({ batch: true, files: [
    { path: a.path, success: true, output: b }
  ] }), metadata: { batch: true, files: [a] } })!
  expect(wrongInnerPath[0]).toMatchObject({ path: a.path, label: 'a.ts' })
  expect(wrongInnerPath[0].range).toBeUndefined()
})

test('continuations stay on their own current page and duplicate basenames use distinguishing path suffixes', () => {
  const paths = ['D:/workspace/client/src/index.ts', 'D:/workspace/server/src/index.ts']
  const make = (startLine: number, endLine: number) => readActivityFiles({ name: 'read_file', state: 'done',
    result: JSON.stringify({ batch: true, files: paths.map(path => ({ path, success: true,
      output: { ...page, path, startLine, endLine, totalLines: 500, nextStartLine: endLine + 1 } })) }) })!
  expect(make(1, 63).map(file => [file.label, file.range])).toEqual([['client/src/index.ts', '1–63'], ['server/src/index.ts', '1–63']])
  expect(make(64, 123).map(file => file.range)).toEqual(['64–123', '64–123'])
  const duplicate = readActivityFiles({ name: 'read_file', state: 'running', result: '', args: JSON.stringify({ files: paths.map(() => ({ path: paths[0] })) }) })!
  expect(duplicate.map(file => file.label)).toEqual(['index.ts（第 1 项）', 'index.ts（第 2 项）'])
})

test('single exact, numbered, partial-line and legacy reads keep verified file ranges', () => {
  const exact = { ...version, expectedHash: hash, startLine: 4, endLine: 9, totalLines: 50, content: 'exact source' }
  const tool = { name: 'read_file', state: 'done', args: JSON.stringify({ path: version.path, end_line: 1000 }) }
  expect(readActivityFiles({ ...tool, result: JSON.stringify(exact) })?.[0]).toMatchObject({ label: 'example.ts', range: '4–9' })
  const legacy = `[读取监控] 耗时: 1ms\n[文件版本] ${JSON.stringify(version)}\n[精确编辑] 读取后编辑。\n\nsource`
  expect(readActivityFiles({ ...tool, result: legacy, metadata: exact })?.[0].range).toBe('4–9')
  const partial = readActivityFiles({ ...tool, result: JSON.stringify({ ...page, startLine: 2, endLine: 2,
    partialLine: true, nextStartLine: 2, nextStartColumn: 9 }) })?.[0]
  expect(partial?.range).toBe('2')
  expect(partial?.title).toContain('本次读取第 2 行（含不完整行） · 文件共 30 行')
  expect(readActivityFiles({ ...tool, state: 'error', result: JSON.stringify(exact), metadata: exact })?.[0]).toMatchObject({ state: 'error' })
  expect(readActivityFiles({ ...tool, state: 'error', result: JSON.stringify(exact), metadata: exact })?.[0].range).toBeUndefined()
})

test('running and missing-receipt calls show known names without inventing read ranges', () => {
  const args = JSON.stringify({ files: [{ path: 'src/a.ts', start_line: 1, end_line: 255 }, { path: 'src/b.ts', start_line: 64, end_line: 123 }] })
  const running = readActivityFiles({ name: 'read_file', state: 'running', args, result: JSON.stringify(page), metadata: page })!
  expect(running.map(file => [file.label, file.range, file.state])).toEqual([['a.ts', undefined, undefined], ['b.ts', undefined, undefined]])
  const pending = readActivityFiles({ name: 'read_file', state: 'done', args, result: '' })!
  expect(pending.map(file => [file.label, file.range, file.state])).toEqual([['a.ts', undefined, 'pending'], ['b.ts', undefined, 'pending']])
  const refused = readActivityFiles({ name: 'read_file', state: 'error', args, result: '{"batch":true,"code":"LIMIT"}', metadata: { batch: true, executed: false } })!
  expect(refused.map(file => file.state)).toEqual(['pending', 'pending'])
  const single = readActivityFiles({ name: 'read_file', state: 'running', result: '', args: '{"path":"README.md","end_line":10000}' })!
  expect(single[0]).toMatchObject({ label: 'README.md', title: 'README.md' })
  expect(single[0].range).toBeUndefined()
})

test('metadata-only completed batches retain validated ranges and Office never fabricates line numbers', () => {
  const metadata = { batch: true, files: [{ ...page, success: true }, { path: 'missing.ts', success: false, error: 'MISSING' }] }
  expect(readActivityFiles({ name: 'read_file', state: 'done', result: '', metadata })?.map(file => [file.range, file.state]))
    .toEqual([['1–2', undefined], [undefined, 'error']])
  const office = readActivityFiles({ name: 'office_inspect', state: 'done', result: JSON.stringify({ batch: true, files: [
    { path: version.path, success: true, output: page }
  ] }), metadata })!
  expect(office[0].label).toBe('example.ts')
  expect(office[0].range).toBeUndefined()
  expect(office[0].title).toContain('不提供实读行号')
})

test('invalid inputs, oversized groups and ambiguous metadata never produce a misleading file range', () => {
  for (const args of ['{partial', '{"files":[]}', '{"files":[null]}', '{"files":[{"path":""}]}',
    JSON.stringify({ files: Array.from({ length: 17 }, (_, i) => ({ path: `${i}.ts` })) })]) {
    expect(readActivityFiles({ name: 'read_file', state: 'running', args, result: '' })).toBeUndefined()
  }
  for (const files of [[], [null], [{ path: 'a.ts', success: 'yes' }], Array.from({ length: 17 }, () => ({ path: version.path, success: true, output: page }))]) {
    expect(readActivityFiles({ name: 'read_file', state: 'done', result: JSON.stringify({ batch: true, files }) })).toBeUndefined()
  }
  expect(readActivityFiles({ name: 'write_file', state: 'done', result: JSON.stringify(page) })).toBeUndefined()
  expect(readActivityFiles({ name: 'read_file', state: 'done', result: '' })).toBeUndefined()
  const summaries = readActivityFiles({ name: 'read_file', state: 'done', result: JSON.stringify({ batch: true, files: [
    { path: version.path, success: true, output: 'source' }
  ] }), metadata: { files: [page, { ...page, endLine: 3, nextStartLine: 4 }] } })!
  expect(summaries[0].range).toBeUndefined()
})
