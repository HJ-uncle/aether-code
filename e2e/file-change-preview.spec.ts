/** Pure tests for inline file previews: initial visibility, language choice, and safe highlighting. */
import { expect, test } from '@playwright/test'
import {
  fileChangeInitiallyCollapsed,
  fileChangeLanguage,
  highlightFileChangeLine
} from '../src/renderer/src/contrib/chat/file-change-preview'

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
