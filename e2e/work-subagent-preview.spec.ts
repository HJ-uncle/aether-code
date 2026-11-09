/** Pure Markdown preview: strip layout syntax, retain words/code, collapse blank lines. */
import { expect, test } from '@playwright/test'
import { workSubagentPreview } from '../src/renderer/src/contrib/work/work-subagent-preview'

test('headings, emphasis and links become readable result text', () => {
  expect(workSubagentPreview('## 1. 接口调研\n\n**可以复用**现有协议，查看[接口说明](https://example.com)。\n\n后续保留 `call_id`。'))
    .toBe('1. 接口调研 可以复用现有协议，查看接口说明。 后续保留 call_id。')
})
test('nested lists, quotes and tables retain their content without layout markers', () => {
  expect(workSubagentPreview('- **接口**兼容\n- 验证通过\n\n> 保留上下文\n\n| 模块 | 结果 |\n|---|---|\n| 存储 | 完成 |'))
    .toBe('接口兼容 验证通过 保留上下文 模块 结果 存储 完成')
})
test('code and literal escaped punctuation remain intact', () => {
  expect(workSubagentPreview('```ts\nconst value = a ** 2;\nconst tag = "<div>";\n```\n\n\\*文字\\*'))
    .toBe('const value = a ** 2; const tag = "<div>"; *文字*')
})
