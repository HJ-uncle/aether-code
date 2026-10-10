/** Pure tests for compact inline diff context, exact line accounting, initial visibility,
 * language choice, and safe highlighting; no Electron. */
import { expect, test } from '@playwright/test'
import {
  compactFileChangeRows,
  fileChangeInitiallyCollapsed,
  fileChangeLanguage,
  highlightFileChangeLine,
  takeFileChangePreviewRows
} from '../src/renderer/src/contrib/chat/file-change-preview'
import {
  computeLineDiff,
  diffForDeletedFile,
  diffForNewFile,
  diffStats,
  type DiffRow
} from '../src/renderer/src/contrib/chat/diff'

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`)
}

function content(lines: string[]): string {
  return lines.join('\n') + '\n'
}

function displayedRows(rows: DiffRow[]): DiffRow[] {
  return compactFileChangeRows(rows).filter((row): row is DiffRow => row.type !== 'gap')
}

test('1600 行文件尾部的小改动立即展示差异，仅保留前后各三行上下文', () => {
  const oldLines = numberedLines(1600)
  const newLines = [...oldLines]
  newLines[1590] = 'changed near the end'
  const rows = computeLineDiff(content(oldLines), content(newLines))
  const originalRows = structuredClone(rows)
  const preview = compactFileChangeRows(rows)

  expect(preview).toEqual([
    { type: 'gap', count: 1587 },
    { type: 'context', text: 'line 1588', oldNo: 1588, newNo: 1588 },
    { type: 'context', text: 'line 1589', oldNo: 1589, newNo: 1589 },
    { type: 'context', text: 'line 1590', oldNo: 1590, newNo: 1590 },
    { type: 'del', text: 'line 1591', oldNo: 1591 },
    { type: 'add', text: 'changed near the end', newNo: 1591 },
    { type: 'context', text: 'line 1592', oldNo: 1592, newNo: 1592 },
    { type: 'context', text: 'line 1593', oldNo: 1593, newNo: 1593 },
    { type: 'context', text: 'line 1594', oldNo: 1594, newNo: 1594 },
    { type: 'gap', count: 6 }
  ])
  expect(rows).toEqual(originalRows)
  expect(diffStats(rows)).toEqual({ added: 1, removed: 1, approximate: false })
  expect(diffStats(displayedRows(rows))).toEqual(diffStats(rows))
})

test('分离的两处改动之间省略无关正文，并保留各自的真实行号', () => {
  const oldLines = numberedLines(40)
  const newLines = [...oldLines]
  newLines[5] = 'first edit'
  newLines[30] = 'second edit'
  const rows = computeLineDiff(content(oldLines), content(newLines))
  const preview = compactFileChangeRows(rows)

  expect(preview.filter(row => row.type === 'gap')).toEqual([
    { type: 'gap', count: 2 },
    { type: 'gap', count: 18 },
    { type: 'gap', count: 6 }
  ])
  expect(displayedRows(rows).filter(row => row.type !== 'context')).toEqual([
    { type: 'del', text: 'line 6', oldNo: 6 },
    { type: 'add', text: 'first edit', newNo: 6 },
    { type: 'del', text: 'line 31', oldNo: 31 },
    { type: 'add', text: 'second edit', newNo: 31 }
  ])
  expect(displayedRows(rows).map(row => row.text)).not.toContain('line 20')
  expect(diffStats(displayedRows(rows))).toEqual({ added: 2, removed: 2, approximate: false })
})

test('相邻或重叠的上下文窗口合并，公共行只展示一次', () => {
  for (const secondChangedLine of [11, 13]) {
    const oldLines = numberedLines(20)
    const newLines = [...oldLines]
    newLines[5] = 'first edit'
    newLines[secondChangedLine - 1] = 'second edit'
    const rows = computeLineDiff(content(oldLines), content(newLines))
    const preview = compactFileChangeRows(rows)
    const shown = displayedRows(rows)

    expect(preview.filter(row => row.type === 'gap')).toEqual([
      { type: 'gap', count: 2 },
      { type: 'gap', count: 20 - secondChangedLine - 3 }
    ])
    expect(shown.filter(row => row.type === 'context').map(row => row.oldNo)).toEqual(
      Array.from({ length: secondChangedLine + 1 }, (_, index) => index + 3)
        .filter(line => line !== 6 && line !== secondChangedLine)
    )
    expect(diffStats(shown)).toEqual(diffStats(rows))
  }
})

test('文件开头和结尾的插入删除不会越界，也不会丢失首尾变更', () => {
  const lines = numberedLines(10)
  const cases = [
    { old: lines, next: ['inserted head', ...lines], type: 'add', text: 'inserted head', no: 1, gapAt: 'end', omitted: 7 },
    { old: lines, next: [...lines, 'inserted tail'], type: 'add', text: 'inserted tail', no: 11, gapAt: 'start', omitted: 7 },
    { old: lines, next: lines.slice(1), type: 'del', text: 'line 1', no: 1, gapAt: 'end', omitted: 6 },
    { old: lines, next: lines.slice(0, -1), type: 'del', text: 'line 10', no: 10, gapAt: 'start', omitted: 6 }
  ] as const

  for (const entry of cases) {
    const rows = computeLineDiff(content([...entry.old]), content([...entry.next]))
    const preview = compactFileChangeRows(rows)
    const changed = displayedRows(rows).filter(row => row.type !== 'context')
    expect(changed).toEqual([entry.type === 'add'
      ? { type: 'add', text: entry.text, newNo: entry.no }
      : { type: 'del', text: entry.text, oldNo: entry.no }])
    expect(preview.filter(row => row.type === 'gap')).toEqual([{ type: 'gap', count: entry.omitted }])
    expect(entry.gapAt === 'start' ? preview[0] : preview.at(-1)).toEqual({ type: 'gap', count: entry.omitted })
    expect(displayedRows(rows).filter(row => row.type === 'context')).toHaveLength(3)
    expect(diffStats(displayedRows(rows))).toEqual(diffStats(rows))
  }
})

test('没有文本差异时不展示全文，也不生成省略占位行', () => {
  for (const text of ['', 'unchanged', content(numberedLines(1600))]) {
    expect(compactFileChangeRows(computeLineDiff(text, text))).toEqual([])
  }
})

test('新建和删除保留全部变更行及末尾换行标记，不受预览行数影响', () => {
  const text = numberedLines(1600).join('\n')
  for (const rows of [diffForNewFile(text), diffForDeletedFile(text)]) {
    const preview = compactFileChangeRows(rows)
    expect(preview).toEqual(rows)
    expect(preview).toHaveLength(1600)
    expect(preview.at(-1)).toMatchObject({ text: 'line 1600', noNewline: true })
    expect(diffStats(displayedRows(rows))).toEqual(diffStats(rows))
  }
})

test('调整上下文行数只影响展示，零行上下文仍保留全部增删与统计', () => {
  const oldLines = numberedLines(10)
  const newLines = [...oldLines]
  newLines[4] = 'changed'
  const rows = computeLineDiff(content(oldLines), content(newLines))
  expect(compactFileChangeRows(rows, 0)).toEqual([
    { type: 'gap', count: 4 },
    { type: 'del', text: 'line 5', oldNo: 5 },
    { type: 'add', text: 'changed', newNo: 5 },
    { type: 'gap', count: 5 }
  ])
  expect(compactFileChangeRows(rows, 10)).toEqual(rows)
})

test('恰好六十行代码时首尾省略提示随正文展示，不留下无意义的更多按钮', () => {
  const oldLines = numberedLines(100)
  const inserted = Array.from({ length: 54 }, (_, index) => `inserted ${index + 1}`)
  const newLines = [...oldLines.slice(0, 50), ...inserted, ...oldLines.slice(50)]
  const preview = compactFileChangeRows(computeLineDiff(content(oldLines), content(newLines)))
  const visible = takeFileChangePreviewRows(preview, 60)

  expect(preview.filter(row => row.type !== 'gap')).toHaveLength(60)
  expect(preview.filter(row => row.type === 'gap')).toEqual([
    { type: 'gap', count: 47 },
    { type: 'gap', count: 47 }
  ])
  expect(visible).toEqual(preview)
  expect(preview.length - visible.length).toBe(0)
})

test('超过六十行时按六十和一百二十行展开，保留顺序且最终展示完整差异', () => {
  const oldLines = numberedLines(100)
  const inserted = Array.from({ length: 126 }, (_, index) => `inserted ${index + 1}`)
  const newLines = [...oldLines.slice(0, 50), ...inserted, ...oldLines.slice(50)]
  const preview = compactFileChangeRows(computeLineDiff(content(oldLines), content(newLines)))
  const originalPreview = structuredClone(preview)
  const code = preview.filter((row): row is DiffRow => row.type !== 'gap')
  const first = takeFileChangePreviewRows(preview, 60)
  const second = takeFileChangePreviewRows(preview, 120)
  const complete = takeFileChangePreviewRows(preview, 180)

  expect(code).toHaveLength(132)
  expect(first.filter(row => row.type !== 'gap')).toEqual(code.slice(0, 60))
  expect(second.filter(row => row.type !== 'gap')).toEqual(code.slice(0, 120))
  expect(first.at(-1)).toMatchObject({ type: 'add', text: 'inserted 57' })
  expect(second.at(-1)).toMatchObject({ type: 'add', text: 'inserted 117' })
  expect(second.slice(0, first.length)).toEqual(first)
  expect(complete).toEqual(preview)
  expect(preview).toEqual(originalPreview)
})

test('分页边界可以带出省略提示，但不能提前显示下个差异片段的真实代码', () => {
  const oldLines = numberedLines(100)
  const inserted = Array.from({ length: 54 }, (_, index) => `first inserted ${index + 1}`)
  const newLines = [
    ...oldLines.slice(0, 20), ...inserted, ...oldLines.slice(20, 80),
    'second inserted 1', 'second inserted 2', ...oldLines.slice(80)
  ]
  const preview = compactFileChangeRows(computeLineDiff(content(oldLines), content(newLines)))
  const first = takeFileChangePreviewRows(preview, 60)
  const firstCode = first.filter((row): row is DiffRow => row.type !== 'gap')

  expect(firstCode).toHaveLength(60)
  expect(firstCode.at(-1)).toMatchObject({ type: 'context', text: 'line 23', oldNo: 23 })
  expect(first.at(-1)).toEqual({ type: 'gap', count: 54 })
  expect(firstCode.map(row => row.text)).not.toContain('line 78')
  expect(firstCode.map(row => row.text)).not.toContain('second inserted 1')
  expect(takeFileChangePreviewRows(preview, 61).at(-1)).toMatchObject({
    type: 'context', text: 'line 78', oldNo: 78
  })
  expect(takeFileChangePreviewRows(preview, 120)).toEqual(preview)
})

test('删除默认收起，写入类新建和修改默认展开', () => {
  expect(fileChangeInitiallyCollapsed({ kind: 'delete' })).toBe(true)
  expect(fileChangeInitiallyCollapsed({ kind: 'write' })).toBe(false)
})

test('按文件路径选择已知语法，不猜测普通文本', () => {
  expect(fileChangeLanguage('D:\\project\\src\\App.TSX')).toBe('typescript')
  expect(fileChangeLanguage('src/page.vue')).toBe('xml')
  expect(fileChangeLanguage('build/Dockerfile.dev')).toBe('dockerfile')
  expect(fileChangeLanguage('Makefile')).toBe('makefile')
  expect(fileChangeLanguage('notes.txt')).toBeUndefined()
})

test('高亮保留原文并转义源文件中的 HTML', () => {
  const result = highlightFileChangeLine('const view = "<img src=x onerror=alert(1)>";', 'typescript')
  expect(result).toContain('class="hljs-keyword">const</span>')
  expect(result).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(result).not.toContain('<img')
  expect(highlightFileChangeLine('<script>&"', undefined)).toBe('&lt;script&gt;&amp;&quot;')
})

test('极长行与未知语法安全回退为原始文本', () => {
  const longLine = `<${'x'.repeat(8_100)}>`
  expect(highlightFileChangeLine(longLine, 'typescript')).toBe(`&lt;${'x'.repeat(8_100)}&gt;`)
  expect(highlightFileChangeLine('<unknown>', 'unknown-language')).toBe('&lt;unknown&gt;')
})
