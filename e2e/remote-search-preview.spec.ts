/** Pure remote search regression: complete replacement confirmation values,
 * unchanged search snippet limits, row caps and exact write semantics. */
import { expect, test } from '@playwright/test'
import type { SearchOptions } from '../src/shared/ipc'
import { previewRemoteReplace, replaceRemoteWorkspace, searchRemoteWorkspace, type RemoteSearchTransport } from '../src/renderer/src/features/search/remote-search'

const options: SearchOptions = { caseSensitive: true, wholeWord: false, useRegex: false, include: '', exclude: '' }
function transport(content: string): { remote: RemoteSearchTransport; writes: { path: string; content: string }[] } {
  const writes: { path: string; content: string }[] = []
  return { writes, remote: {
    assertCurrent: () => undefined,
    listFiles: async () => ({ name: '.', type: 'dir', children: [{ name: 'long-line.txt', type: 'file' }] }),
    readFile: async () => ({ content, originalLength: content.length, isBinary: false }),
    writeFile: async (path, value) => { writes.push({ path, content: value }) }
  } }
}

test('完整预览保留 240 字符之后的命中、空白与替换结果，确认后写入一致', async () => {
  const query = 'REPLACE_THIS', before = `\t  ${'长行前缀 '.repeat(80)}${query}${' unchanged-tail'.repeat(50)}  `
  const replacement = `\t${'完整新正文 '.repeat(90)}literal:$&:$1:$\x60:$'\n最后一行  `
  const after = before.replace(query, () => replacement)
  const { remote, writes } = transport(`${before}\r\nkeep-this-line\n`)
  const preview = await previewRemoteReplace(remote, query, options, replacement, {})
  expect(preview.error).toBeUndefined()
  expect(preview).toMatchObject({ total: 1, truncated: false, files: [{ path: 'long-line.txt', lines: [{ line: 1, before, after }] }] })
  expect(writes).toEqual([])

  const search = await searchRemoteWorkspace(remote, query, options, {})
  expect(search.hits).toHaveLength(1)
  expect(search.hits[0].text.length).toBeLessThanOrEqual(240)
  expect(search.hits[0].text).toContain(query)
  expect(search.hits[0].column).toBe(before.indexOf(query) + 1)

  expect(await replaceRemoteWorkspace(remote, query, options, replacement, {})).toEqual({ files: ['long-line.txt'], replacements: 1 })
  expect(writes).toEqual([{ path: 'long-line.txt', content: `${after}\r\nkeep-this-line\n` }])
})

test('保留 500 行预览上限并报告截断，每个已展示的长行仍完整', async () => {
  const query = 'TARGET', before = `${'prefix '.repeat(50)}${query}${' tail'.repeat(30)}`, replacement = '完整替换'
  const { remote, writes } = transport(Array.from({ length: 501 }, () => before).join('\n'))
  const preview = await previewRemoteReplace(remote, query, options, replacement, {})
  expect(preview.error).toBeUndefined()
  expect(preview.total).toBe(501); expect(preview.truncated).toBe(true)
  expect(preview.files).toHaveLength(1); expect(preview.files[0].lines).toHaveLength(500)
  const after = before.replace(query, replacement)
  expect(preview.files[0].lines[0]).toEqual({ line: 1, before, after })
  expect(preview.files[0].lines[499]).toEqual({ line: 500, before, after })
  expect(writes).toEqual([])
})
