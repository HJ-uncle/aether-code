/** Pure contracts: Code/Work delegation, chip identity and alias/file separation. */
import { expect, test } from '@playwright/test'
import { agentMentionSearch, buildAgentMentionMessage } from '../src/renderer/src/contrib/chat/agent-references'
import { buildWorkAgentMessage } from '../src/renderer/src/contrib/work/work-agent-collaboration'
import { userMessageDraft, userMessageText, type Mention } from '../src/renderer/src/contrib/chat/mention-context'

test('Code and Work share structured collaborators and stable replay identities', () => {
  const text = '  @reviewer 检查 @src/app.ts，@writer 更新 @docs  '
  const mentions: Mention[] = [
    { source: 'agent', path: 'reviewer', displayText: '审查工程师', textOffset: text.indexOf('@reviewer') },
    { source: 'file', path: 'src/app.ts', displayText: 'app.ts', textOffset: text.indexOf('@src/app.ts') },
    { source: 'agent', path: 'writer', displayText: '文档工程师', textOffset: text.indexOf('@writer') },
    { source: 'dir', path: 'docs', displayText: 'docs', textOffset: text.indexOf('@docs') }
  ]
  const sent = buildAgentMentionMessage(text, mentions)
  expect(sent.collaborators).toEqual([{ agentId: 'reviewer' }, { agentId: 'writer' }])
  expect(buildWorkAgentMessage(text, mentions)).toEqual(sent)
  // Existing chip serialization separates token boundaries from punctuation.
  const normalized = '@reviewer 检查 @src/app.ts ， @writer 更新 @docs'
  expect(userMessageText(sent.message)).toBe(normalized)
  const restored = userMessageDraft(sent.message)
  expect(restored.mentions.map(ref => [ref.source, ref.path, ref.displayText]))
    .toEqual(mentions.map(ref => [ref.source, ref.path, ref.displayText]))
  expect(restored.mentions.map(ref => ref.textOffset))
    .toEqual(['@reviewer', '@src/app.ts', '@writer', '@docs'].map(token => normalized.indexOf(token)))
  expect(buildAgentMentionMessage(restored.text, restored.mentions)).toEqual(sent)
})

test('same filename and Agent id remain distinct; repeat Agent chips delegate once', () => {
  const text = '@reviewer 与 @reviewer，最后 @reviewer'
  const sent = buildAgentMentionMessage(text, [
    { source: 'file', path: 'reviewer', displayText: 'reviewer', textOffset: 0 },
    { source: 'agent', path: 'reviewer', displayText: '审查员', textOffset: text.indexOf('@reviewer', 1) },
    { source: 'agent', path: 'reviewer', displayText: '审查员', textOffset: text.lastIndexOf('@reviewer') }
  ])
  expect(sent.collaborators).toEqual([{ agentId: 'reviewer' }])
  expect(userMessageDraft(sent.message).mentions.map(ref => ref.source)).toEqual(['file', 'agent', 'agent'])
  expect(buildAgentMentionMessage('@reviewer 手工文字', []).collaborators).toEqual([])
  expect(buildAgentMentionMessage('@reviewer 文件引用', [{ source: 'file', path: 'reviewer', displayText: 'reviewer' }]).collaborators).toEqual([])
})

test('deleted chips and pasted serialized metadata cannot authorize a collaborator', () => {
  const agent: Mention = { source: 'agent', path: 'reviewer', displayText: '审查员' }
  expect(buildAgentMentionMessage('已删除引用', [agent]).collaborators).toEqual([])
  const pasted = buildAgentMentionMessage('@reviewer 帮我检查', [agent]).message
  expect(buildAgentMentionMessage(pasted, []).collaborators).toEqual([])
  const stale = { source: 'agent' as const, path: 'absent', displayText: '已删除' }
  expect(buildAgentMentionMessage(pasted, [stale]).collaborators).toEqual([])
})

test('Agent aliases require whole-word boundaries and horizontal search spacing', () => {
  for (const query of ['agent', 'AGENT', '智能体']) expect(agentMentionSearch(query)).toBe('')
  for (const query of ['agent 审查工程师', '智能体\u00a0审查工程师', 'agent\u3000审查工程师'])
    expect(agentMentionSearch(query)).toBe('审查工程师')
  for (const filename of ['agents.ts', 'agent.ts', 'agent-config.json', 'agent/review.ts', '智能体配置.ts', 'agent\t审查', '智能体\n审查'])
    expect(agentMentionSearch(filename)).toBeNull()
})
