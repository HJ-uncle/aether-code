/** Inline toolkit edits change selectors; ordinary text and sent-draft cleanup do not. */
import { expect, test } from '@playwright/test'
import { editDraftToolkits, draftToolkitIds } from '../src/renderer/src/contrib/work/work-toolkit-mentions'
import { mentionToken, type Mention } from '../src/renderer/src/contrib/chat/mention-context'

const mention: Mention = { source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理', textOffset: 2 }
const selected = { text: `前 ${mentionToken(mention)} 后`, mentions: [mention] }
const empty = { text: '', mentions: [] }

test('selecting an inline label enables exactly its known toolkit without replacing other choices', () => {
  expect(draftToolkitIds(selected)).toEqual(['agent-management'])
  expect(() => editDraftToolkits(undefined, empty, selected)).toThrow('读取会话工具包')
  expect(editDraftToolkits(['skill-management', 'knowledge-management'], empty, selected)).toEqual(['skill-management', 'knowledge-management', 'agent-management'])
  expect(editDraftToolkits(['retained'], empty, selected)).toEqual(['retained', 'agent-management'])
})

test('typing an identical token, stale offsets and unknown IDs do not enable anything', () => {
  expect(editDraftToolkits(undefined, empty, { ...selected, mentions: [] })).toBeUndefined()
  expect(draftToolkitIds({ ...selected, mentions: [{ ...mention, textOffset: 0 }] })).toEqual([])
  expect(draftToolkitIds({ text: '@toolkit:unknown', mentions: [{ ...mention, path: 'unknown', textOffset: 0 }] })).toEqual([])
})

test('deleting the last draft label explicitly disables it while ordinary edits preserve enabled sessions', () => {
  expect(editDraftToolkits(['agent-management'], selected, { text: '前 后', mentions: [] })).toEqual([])
  expect(editDraftToolkits(['agent-management'], empty, { text: '继续', mentions: [] })).toEqual(['agent-management'])
  const copied = { text: `${selected.text} ${mentionToken(mention)}`, mentions: [mention, { ...mention, textOffset: selected.text.length + 1 }] }
  expect(editDraftToolkits(['agent-management'], copied, selected)).toEqual(['agent-management'])
  expect(editDraftToolkits([], empty, selected)).toEqual(['agent-management'])
})

test('ordinary edits to restored historical labels preserve disabled or inherited permissions', () => {
  const edited = { ...selected, text: `${selected.text} 补充说明` }
  expect(editDraftToolkits([], selected, edited)).toEqual([])
  expect(editDraftToolkits(undefined, selected, edited)).toBeUndefined()
  expect(editDraftToolkits(['retained'], selected, edited)).toEqual(['retained'])
})

test('removing one package preserves all other resolved inherited packages', () => {
  const inherited = ['agent-management', 'skill-management', 'automation']
  expect(() => editDraftToolkits(undefined, selected, empty)).toThrow('读取会话工具包')
  expect(editDraftToolkits(inherited, selected, empty)).toEqual(['skill-management', 'automation'])
  expect(inherited).toEqual(['agent-management', 'skill-management', 'automation'])
})

test('MCP management edits preserve plugin management and versioned plugin choices', () => {
  const mcp: Mention = { source: 'toolkit', path: 'mcp-management', displayText: 'MCP 管理', textOffset: 0 }
  const draft = { text: mentionToken(mcp), mentions: [mcp] }
  const inherited = ['plugin-management', 'plugin-document-reader--r3', 'automation']
  expect(draftToolkitIds(draft)).toEqual(['mcp-management'])
  expect(editDraftToolkits(inherited, empty, draft)).toEqual([...inherited, 'mcp-management'])
  expect(editDraftToolkits([...inherited, 'mcp-management'], draft, empty)).toEqual(inherited)
  expect(editDraftToolkits(inherited, empty, { ...draft, mentions: [] })).toEqual(inherited)
  expect(() => editDraftToolkits(undefined, empty, draft)).toThrow('读取会话工具包')
})
