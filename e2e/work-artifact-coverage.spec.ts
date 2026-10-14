/** Artifact coverage contracts: current disk bytes, partial exports and historical
 * receipts must remain distinguishable without launching Electron or a model. */
import { expect, test } from '@playwright/test'
import { workArtifactExportName, workArtifactReadFailure, workArtifactReadResult, workArtifactSelectionQuote } from '../src/renderer/src/contrib/work/work-artifact-content'

test('完整空文件也是当前版本，不回退到旧回执', () => {
  const result = workArtifactReadResult({ content: '', isBinary: false, truncated: false })
  expect(result).toEqual({ content: '', coverage: 'current', notice: '' })
  expect(workArtifactExportName('report.md', result.coverage)).toBe('report.md')
})

test('显式截断和大文件片段不能以完整成果的文件名导出', () => {
  for (const flags of [{ truncated: true }, { tooLarge: true }]) {
    const result = workArtifactReadResult({ content: 'ONLY_A_PREFIX', isBinary: false, truncated: false, ...flags })
    expect(result.coverage).toBe('partial')
    expect(result.content).toBe('ONLY_A_PREFIX')
    expect(result.notice).toContain('只包含此片段')
    expect(workArtifactExportName('report.md', result.coverage)).toBe('report.md.preview.txt')
  }
})

test('二进制、超大空响应和无效正文均拒绝文本导出', () => {
  for (const file of [
    { content: 'BASE64', isBinary: true, truncated: false },
    { content: '', isBinary: false, tooLarge: true, truncated: false },
    JSON.parse('{"isBinary":false}')
  ]) {
    const result = workArtifactReadResult(file)
    expect(result.content).toBeNull()
    expect(result.coverage).toBe('unavailable')
    expect(result.notice.length).toBeGreaterThan(0)
  }
})

test('失败回退明确保留历史身份与实际失败，不能假称读取当前文件成功', () => {
  const failure = new Error('permission denied')
  const receipt = workArtifactReadFailure('# OLD_BYTES', failure)
  expect(receipt).toMatchObject({ coverage: 'receipt', content: '# OLD_BYTES' })
  expect(receipt.notice).toContain('历史版本')
  expect(receipt.notice).toContain('permission denied')
  expect(workArtifactExportName('report.md', receipt.coverage)).toBe('report.md.receipt.txt')
  expect(workArtifactReadFailure(null, failure)).toEqual({ coverage: 'unavailable', content: null, notice: 'permission denied' })
})

test('选中内容引用保留片段和历史来源，不能称为完整当前文件', () => {
  const text = 'SELECTED_BYTES\nsecond line'
  const receipt = workArtifactSelectionQuote('report.md', 'reports/report.md', text, 'receipt')
  const partial = workArtifactSelectionQuote('report.md', 'reports/report.md', text, 'partial')
  expect(receipt).toContain('历史写入回执中的选中内容')
  expect(partial).toContain('文件预览片段中的选中内容')
  for (const quote of [receipt, partial]) {
    expect(quote).toContain('reports/report.md')
    expect(quote).toContain('> SELECTED_BYTES\n> second line')
    expect(quote).not.toContain('完整当前文件')
  }
})
