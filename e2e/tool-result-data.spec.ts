/** Readable tool receipts: only complete JSON is structured; source/log output
 * remains exact, nested wrappers are bounded, and original fields stay intact. */
import { expect, test } from '@playwright/test'
import { parseToolResultData, toolResultFieldLabel } from '../src/renderer/src/contrib/chat/tool-result-data'

test('完整对象、列表和嵌套 JSON 收据可以读取而不更改原始内容', () => {
  const receipt = { path: 'report.xlsx', sheets: [{ name: '概览', rows: 12 }], success: true }
  const raw = JSON.stringify(receipt, null, 4)
  expect(parseToolResultData(raw)).toEqual(receipt)
  expect(parseToolResultData(JSON.stringify(raw))).toEqual(receipt)
  expect(parseToolResultData('[{"name":"报告"}]')).toEqual([{ name: '报告' }])
  expect(raw).toBe(JSON.stringify(receipt, null, 4))
  expect(toolResultFieldLabel('sheets')).toBe('工作表')
  expect(toolResultFieldLabel('custom_field')).toBe('custom_field')
  for (const key of ['__proto__', 'constructor', 'toString']) expect(toolResultFieldLabel(key)).toBe(key)
  expect(Object.keys(parseToolResultData('{"__proto__":"safe","constructor":"field"}')!)).toEqual(['__proto__', 'constructor'])
})

test('日志、部分 JSON、原始标量和超大结果保持原始展示', () => {
  for (const text of ['done\n[exit 0]', '{"path":', 'true', '42', 'null', '"plain text"', '{"text":"' + 'a'.repeat(64_000) + '"}']) {
    expect(parseToolResultData(text)).toBeNull()
  }
})
