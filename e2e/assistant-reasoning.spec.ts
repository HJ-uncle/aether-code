/** Display compatibility for provider reasoning envelopes in persisted and streaming Work replies. */
import { expect, test } from '@playwright/test'
import { splitAssistantReasoning } from '../src/renderer/src/core/engine/assistant-reasoning'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { workMessagePresentation, workMessageTimeline } from '../src/renderer/src/contrib/work/work-message-timeline'
import { subagentInstructionIssue } from '../src/renderer/src/contrib/work/subagent-followup-message'

const sample = (content: string, status: ChatMessage['status'] = 'done'): ChatMessage => ({
  id: 'reply', role: 'assistant', content, thinking: '', tools: [], items: [{ kind: 'content', text: content }], status, createdAt: 1
})

test('delegated work rejects reactions but retains short and multilingual instructions', () => {
  for (const text of ['!', '？！？', '…', '👍', ' \n\t', '\u200b']) expect(subagentInstructionIssue(text)).toContain('不能只发送标点或表情')
  for (const text of ['查', '继续', '2', 'Go', '修复 ! 判断', '検証', 'تحقق']) expect(subagentInstructionIssue(text)).toBeUndefined()
})

test('leading provider reasoning is separate from the answer while quoted tags remain literal', () => {
  expect(splitAssistantReasoning(' \n<THINK>核对上下文。</THINK>这是回复。')).toEqual({ thinking: '核对上下文。', content: '这是回复。' })
  for (const text of ['`<think>example</think>`', '```xml\n<think>example</think>\n```', '    <think>example</think>', '\t<think>example</think>', '字段是 <think>example</think>。', '&lt;think&gt;']) {
    expect(splitAssistantReasoning(text)).toEqual({ thinking: '', content: text })
  }
})

test('every streaming prefix of an envelope keeps reasoning out of answer content', () => {
  const tagged = '<think>正在核对。</think>', answer = '最终答复。'
  for (let end = 1; end <= tagged.length; end++) {
    const parts = splitAssistantReasoning(tagged.slice(0, end), true)
    expect(parts.content, tagged.slice(0, end)).toBe('')
    expect(parts.thinking).not.toContain('<')
  }
  expect(splitAssistantReasoning(tagged + answer, true)).toEqual({ thinking: '正在核对。', content: answer })
  expect(splitAssistantReasoning('<th', false)).toEqual({ thinking: '', content: '<th' })
})

test('cancelled reasoning-only output never becomes a final answer', () => {
  const message = sample('<think>尚未完成的核对', 'aborted')
  const timeline = workMessageTimeline(message)
  expect(timeline).toEqual([{ kind: 'thinking', key: 'content:0:thinking', text: '尚未完成的核对' }])
  expect(workMessagePresentation(timeline, undefined, undefined, false).map(item => item.kind)).toEqual(['process'])
})

test('historical raw reasoning folds once and the manifest publishes only answer text', () => {
  const message = sample('<think>REASONING_ONLY</think>最终答复。\n![成品](D:/final.png)')
  const original = structuredClone(message)
  const timeline = workMessageTimeline(message)
  const presentation = workMessagePresentation(timeline, undefined, { text: message.content }, false)
  expect(presentation.map(item => item.kind)).toEqual(['process', 'answer'])
  expect(presentation[0]).toMatchObject({ segments: [{ kind: 'thinking', text: 'REASONING_ONLY' }] })
  expect(presentation[1]).toEqual({ kind: 'answer', key: 'final-result', text: '最终答复。\n![成品](D:/final.png)' })
  expect(message).toEqual(original)
})

test('a manifest without transcript body still preserves its reasoning inside the process', () => {
  expect(workMessagePresentation([], undefined, { text: '<think>已核对</think>完成。' }, false)).toEqual([
    { kind: 'process', key: 'final-result-thinking', segments: [{ kind: 'thinking', key: 'final-result-thinking', text: '已核对' }] },
    { kind: 'answer', key: 'final-result', text: '完成。' }
  ])
})

test('chunked timeline content joins before parsing and never changes a user message', () => {
  const message = sample('<think>核对</think>完成。')
  message.items = [{ kind: 'content', text: '<th' }, { kind: 'content', text: 'ink>核对</thi' }, { kind: 'content', text: 'nk>完成。' }]
  expect(workMessageTimeline(message).map(item => item.kind)).toEqual(['thinking', 'content'])
  expect(workMessageTimeline({ ...message, role: 'user' })).toEqual([{ kind: 'content', key: 'content', text: message.content }])
})
