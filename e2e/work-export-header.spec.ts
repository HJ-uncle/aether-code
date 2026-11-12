/** Pure Work transcript metadata: the copied/downloaded document has a useful
 * session heading without exposing implementation details such as mode or engine. */
import { expect, test } from '@playwright/test'
import { buildMessageExportDocument } from '../src/renderer/src/features/conversation/shared/message-export'

test('Work export starts with the session name and compact conversation details', () => {
  const exported = buildMessageExportDocument('## 用户\n\n检查结果', {
    title: '发布验收会话',
    workspace: 'D:/projects/aether',
    turnCount: 2,
    exportedAt: new Date(2026, 10, 11, 9, 8, 7)
  })

  expect(exported).toMatch(/^# 发布验收会话\n\n/)
  expect(exported).toContain('- 工作目录：D:/projects/aether')
  expect(exported).toContain('- 导出时间：2026-11-11 09:08')
  expect(exported).toContain('- 对话轮次：2')
  expect(exported).toContain('\n\n---\n\n## 用户\n\n检查结果')
  expect(exported).not.toContain('模式')
  expect(exported).not.toContain('引擎')
})

test('standalone Work export uses a readable workspace fallback and safe title', () => {
  const exported = buildMessageExportDocument('正文', {
    title: '  \n  ',
    workspace: null,
    turnCount: -4,
    exportedAt: new Date(2026, 0, 2, 3, 4, 5)
  })

  expect(exported).toContain('# 未命名会话')
  expect(exported).toContain('- 工作目录：独立任务')
  expect(exported).toContain('- 对话轮次：0')
})
