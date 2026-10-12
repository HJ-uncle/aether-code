// Pure submission contracts: structured delegation follows real mention chips,
// while the message preserves identity labels for replay and draft recovery.
import { expect, test } from '@playwright/test'
import { buildWorkAgentMessage } from '../src/renderer/src/contrib/work/work-agent-collaboration'
import { userMessageDraft, userMessageText } from '../src/renderer/src/contrib/chat/mention-context'

test('Work sends mentioned Agents separately and preserves all reference identities', () => {
  const text = '@frontend 实现页面， @backend 实现接口；请审查 @src/app.ts'
  const mentions = [
    { source: 'agent' as const, path: 'frontend', displayText: '前端工程师', textOffset: 0 },
    { source: 'agent' as const, path: 'backend', displayText: '后端工程师', textOffset: text.indexOf('@backend') },
    { source: 'file' as const, path: 'src/app.ts', displayText: 'app.ts', textOffset: text.indexOf('@src/app.ts') }
  ]
  const sent = buildWorkAgentMessage(text, mentions)
  expect(sent.collaborators).toEqual([{ agentId: 'frontend' }, { agentId: 'backend' }])
  expect(userMessageDraft(sent.message).mentions.map(mention => [mention.source, mention.path, mention.displayText]))
    .toEqual([['agent', 'frontend', '前端工程师'], ['agent', 'backend', '后端工程师'], ['file', 'src/app.ts', 'app.ts']])
  expect(userMessageText(sent.message)).toBe(text)
})

test('repeated mentions delegate once; removed references and plain @ text do not run Agents', () => {
  const sent = buildWorkAgentMessage('@reviewer 看第一处，@reviewer 看第二处', [
    { source: 'agent', path: 'reviewer', displayText: '审查员', textOffset: 0 },
    { source: 'agent', path: 'reviewer', displayText: '审查员', textOffset: 16 }
  ])
  expect(sent.collaborators).toEqual([{ agentId: 'reviewer' }])
  expect(buildWorkAgentMessage('已经删除引用', [{ source: 'agent', path: 'reviewer', displayText: '审查员' }]).collaborators).toEqual([])
  expect(buildWorkAgentMessage('@reviewer 仅手工文字', []).collaborators).toEqual([])
})

test('Agent names with punctuation survive reference metadata and do not become instructions', () => {
  const sent = buildWorkAgentMessage('@agent-1 帮我检查', [{ source: 'agent', path: 'agent-1', displayText: '工程师 <!--x--> "A"' }])
  expect(sent.collaborators).toEqual([{ agentId: 'agent-1' }])
  expect(userMessageDraft(sent.message).mentions[0].displayText).toBe('工程师 <!--x--> "A"')
  expect(sent.message).toContain('\\u003c')
})

test('contenteditable chip spacer text delegates both Agents', () => {
  const text = '@collaboration-front  @collaboration-back  分别实现页面与接口，并返回独立结果。'
  const sent = buildWorkAgentMessage(text, [
    { source: 'agent', path: 'collaboration-front', displayText: '前端协作工程师', textOffset: 0 },
    { source: 'agent', path: 'collaboration-back', displayText: '后端协作工程师', textOffset: 22 }
  ])
  expect(sent.collaborators).toEqual([{ agentId: 'collaboration-front' }, { agentId: 'collaboration-back' }])
})
