/** Pure delivery preview routing: MIME/original path select the parser while
 * display labels and download names remain independent. No Electron. */
import { expect, test } from '@playwright/test'
import { documentKindFor } from '../src/renderer/src/contrib/documents/document-kind'
import { previewKindFor, mimeFor } from '../src/renderer/src/core/editor/preview'
import { finalResultPreviewFormat } from '../src/renderer/src/contrib/work/final-result-preview-format'

test('PDF及Office使用真实MIME选型，显示名无后缀或误用后缀不影响预览', () => {
  for (const [mimeType, kind] of [
    ['application/pdf', 'pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx']
  ]) {
    for (const name of ['最终报告', '最终报告.txt']) {
      const item = { mimeType, path: '/workspace/source.bin', name }
      expect(documentKindFor(finalResultPreviewFormat(item))).toBe(kind)
      expect(item.name).toBe(name)
    }
  }
})

test('MIME优先于原路径的相反扩展名，未知MIME使用原路径而非显示名', () => {
  expect(documentKindFor(finalResultPreviewFormat({ mimeType: 'application/pdf', path: 'D:\\work\\source.docx' }))).toBe('pdf')
  expect(documentKindFor(finalResultPreviewFormat({ mimeType: 'application/octet-stream', path: 'D:\\work\\报告.DOCX' }))).toBe('docx')
  expect(documentKindFor(finalResultPreviewFormat({ mimeType: 'application/octet-stream', path: '/work/report.pdf' }))).toBe('pdf')
  expect(previewKindFor(finalResultPreviewFormat({ mimeType: 'application/octet-stream', path: '/work/opaque-file' }))).toBe('hex')
})

test('视频使用真实格式生成媒体MIME，未知文件继续安全十六进制预览', () => {
  const format = finalResultPreviewFormat({ mimeType: 'video/webm', path: '/work/opaque-file' })
  expect(previewKindFor(format)).toBe('video')
  expect(mimeFor(format)).toBe('video/webm')
  expect(previewKindFor(finalResultPreviewFormat({ mimeType: 'application/zip', path: '/work/package.zip' }))).toBe('hex')
  expect(documentKindFor(finalResultPreviewFormat({ mimeType: 'application/octet-stream', path: '/work/looks.pdf/opaque-file' }))).toBeNull()
})
