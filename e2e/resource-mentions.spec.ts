/** Pure composer resource selection and message round-trips; no browser or engine required. */
import { expect, test } from '@playwright/test'
import { buildMentionMessage, isStoredMention, mentionToken, parseMentionContent, userMessageDraft, type Mention, type ResourceMentionSource } from '../src/renderer/src/contrib/chat/mention-context'
import { consumedResourcePatch, draftResourceBindings, editResourceBindings, hasNonResourceContent, resourceBindingEdits, resourceFollowupChanges, resourceMention, restoredResourcePatch, sameResourceBindings, type ResourceBindings, type ResourceDraft } from '../src/renderer/src/contrib/chat/resource-mentions'
import { attachmentReferences, referencesAttachment } from '../src/renderer/src/contrib/chat/attachment-references'
import { consumedWorkResourcePatch, workResourceFollowupChanges, workResourceSelection } from '../src/renderer/src/contrib/work/work-resource-selection'

const kinds = [['skill', 'skills', '技能'], ['mcp', 'mcpServers', 'MCP 服务'], ['kb', 'knowledgeBases', '知识库']] as const
const empty = (): ResourceBindings => ({ skills: [], mcpServers: [], knowledgeBases: [] })
const plain: ResourceDraft = { text: '请保留普通说明', mentions: [] }
function draft(entries: Array<[ResourceMentionSource, string]>, prefix = ''): ResourceDraft {
  let text = prefix
  const mentions: Mention[] = []
  for (const [kind, id] of entries) {
    const mention = { ...resourceMention(kind, id, `名称 ${id}`), textOffset: text.length }
    mentions.push(mention); text += `${mentionToken(mention)} `
  }
  return { text, mentions }
}

test('only anchored resource chips bind; typed slash commands, stale offsets and file mentions do not', () => {
  const selected = draft([['skill', 'same'], ['mcp', 'same'], ['kb', 'same'], ['skill', 'same']], '😀 普通说明 ')
  expect(draftResourceBindings(selected)).toEqual({ skills: ['same'], mcpServers: ['same'], knowledgeBases: ['same'] })
  expect(draftResourceBindings({ text: selected.text, mentions: [] })).toEqual(empty())
  for (const offset of [undefined, -1, 0, 1, selected.text.length + 1]) {
    expect(draftResourceBindings({ text: selected.text, mentions: [{ ...selected.mentions[0], textOffset: offset }] })).toEqual(empty())
  }
  const file: Mention = { source: 'file', origin: 'attachment', attachmentId: 'same', path: 'same', displayText: '技能同名文件', textOffset: 0 }
  expect(draftResourceBindings({ text: mentionToken(file), mentions: [file] })).toEqual(empty())
  expect(draftResourceBindings({ text: selected.text, mentions: selected.mentions.map(item => ({ ...item, source: 'toolkit' })) })).toEqual(empty())
})

test('editing resource chips changes only matching bindings and preserves inherited selections without mutating them', () => {
  const current: ResourceBindings = { skills: ['inherited', 'selected'], mcpServers: ['server'], knowledgeBases: ['library'] }
  const snapshot = structuredClone(current)
  const before = draft([['skill', 'selected']]), after = draft([['skill', 'new'], ['mcp', 'added']])
  expect(editResourceBindings(current, before, after)).toEqual({ skills: ['inherited', 'new'], mcpServers: ['server', 'added'], knowledgeBases: ['library'] })
  expect(current).toEqual(snapshot)
  expect(editResourceBindings(undefined, plain, after)).toEqual({ skills: ['new'], mcpServers: ['added'], knowledgeBases: [] })
  expect(editResourceBindings(current, plain, plain)).toEqual(current)
})

test('delete, undo and redo restore the resource binding in each category, including removing its last chip', () => {
  for (const [kind, key] of kinds) {
    const selected = draft([[kind, 'picked']])
    const bound = { ...empty(), [key]: ['picked'] }
    const removed = editResourceBindings(bound, selected, plain)
    expect(removed).toEqual(empty())
    expect(resourceBindingEdits(selected, plain)).toEqual([key])
    const restored = editResourceBindings(removed, plain, selected)
    expect(restored).toEqual(bound)
    expect(editResourceBindings(restored, selected, plain)).toEqual(empty())
  }
})

test('moving, renaming and deleting one duplicate preserves selection and produces no category edit', () => {
  const before = draft([['skill', 'a'], ['mcp', 'b'], ['skill', 'a'], ['kb', 'c']])
  const moved = draft([['kb', 'c'], ['skill', 'a'], ['mcp', 'b']], '换到后面 ')
  moved.mentions = moved.mentions.map(item => ({ ...item, displayText: '重命名仅改变显示' }))
  const current = { skills: ['a', 'inherited'], mcpServers: ['b'], knowledgeBases: ['c'] }
  expect(editResourceBindings(current, before, moved)).toEqual(current)
  expect(resourceBindingEdits(before, moved)).toEqual([])
  expect(sameResourceBindings(current, { ...current, skills: ['inherited', 'a'] })).toBe(true)
  expect(sameResourceBindings(current, { ...current, knowledgeBases: [] })).toBe(false)
})

test('resource messages round-trip names, IDs and offsets alongside a file with the same identity', () => {
  const selected = draft([['skill', 'shared'], ['mcp', 'shared'], ['kb', 'shared']], '请检查 ')
  const file: Mention = { source: 'file', origin: 'attachment', attachmentId: 'shared', path: 'shared', displayText: 'shared.yml', textOffset: selected.text.length }
  const text = selected.text + mentionToken(file) + ' 并保留结论'
  const message = buildMentionMessage(text, [...selected.mentions, file])
  const parsed = parseMentionContent(message)
  expect(parsed.refs.map(ref => [ref.t, ref.p, ref.d])).toEqual([
    ['skill', 'shared', '名称 shared'], ['mcp', 'shared', '名称 shared'], ['kb', 'shared', '名称 shared'], ['file', 'shared', 'shared.yml']
  ])
  for (const [, , hint] of kinds) expect(parsed.body).toContain(`${hint}：名称 shared`)
  expect(parsed.body).toContain('shared.yml（文件：shared）')
  expect(parsed.body).not.toContain('<reference'); expect(parsed.body).not.toMatch(/\/(?:skill|mcp|kb):/)
  expect(parsed.refs.slice(0, 3).every(ref => ref.a === undefined && ref.o === undefined)).toBe(true)
  expect(parsed.refs[3]).toMatchObject({ o: 'attachment', a: 'shared' })
  const restored = userMessageDraft(message)
  expect(restored.text).toBe(text)
  expect(restored.mentions).toEqual([...selected.mentions, file])
  expect(draftResourceBindings(restored)).toEqual({ skills: ['shared'], mcpServers: ['shared'], knowledgeBases: ['shared'] })
  const receipt = attachmentReferences([{ attachmentId: 'shared', path: 'shared', name: 'shared.yml', type: 'text/yaml', size: 18 }])[0]
  expect(restored.mentions.map(item => referencesAttachment(item, receipt))).toEqual([false, false, false, true])
})

test('persisted resource identities reject file fields, malformed IDs and invalid offsets', () => {
  for (const [kind] of kinds) {
    const valid = { ...resourceMention(kind, 'plugin/中文 id', '中文名称'), textOffset: 0 }
    expect(isStoredMention(valid)).toBe(true)
    for (const patch of [{ origin: 'attachment' }, { origin: 'workspace' }, { attachmentId: 'same' }, { content: 'snapshot' },
      { startLine: 1 }, { path: '' }, { path: ' ' }, { path: 'bad\nname' }, { path: 'a'.repeat(2049) },
      { textOffset: -1 }, { textOffset: 0.5 }]) {
      expect(isStoredMention({ ...valid, ...patch }), JSON.stringify([kind, patch])).toBe(false)
    }
  }
})

test('invalid resource history metadata cannot acquire file identity while valid file references still restore', () => {
  const selected = draft([['skill', 'shared']])
  const file: Mention = { source: 'file', origin: 'attachment', attachmentId: 'shared', path: 'shared', displayText: 'shared.txt', textOffset: selected.text.length }
  const message = buildMentionMessage(selected.text + mentionToken(file), [...selected.mentions, file])
  const parsed = parseMentionContent(message)
  for (const patch of [{ o: 'attachment' }, { a: 'shared' }, { r: [1, 1] }, { p: '' }, { p: 'bad\rname' }]) {
    const tampered = `${parsed.body}\n<!--aether-refs:${JSON.stringify([{ ...parsed.refs[0], ...patch }, parsed.refs[1]])}-->`
    expect(parseMentionContent(tampered).refs).toEqual([parsed.refs[1]])
    expect(userMessageDraft(tampered).mentions.map(item => item.source)).toEqual(['file'])
  }
})

test('plain resource-like text never becomes a chip or binding during history replay', () => {
  const text = '请原样保留 /skill:example /mcp:example /kb:example 和 技能：名称'
  expect(buildMentionMessage(text, [])).toBe(text)
  expect(parseMentionContent(text)).toEqual({ body: text, refs: [] })
  const restored = userMessageDraft(text)
  expect(restored).toEqual({ text, mentions: [] })
  expect(draftResourceBindings(restored)).toEqual(empty())
})

test('resource labels alone are not sendable, while prose, files and agents remain sendable', () => {
  const selected = draft([['skill', 'selected'], ['mcp', 'server'], ['kb', 'library']], ' \n\u200b ')
  expect(hasNonResourceContent(selected)).toBe(false)
  expect(hasNonResourceContent({ text: '\u200b \n', mentions: [] })).toBe(false)
  expect(hasNonResourceContent({ ...selected, text: selected.text + '继续处理这份资料' })).toBe(true)
  for (const mention of [
    { source: 'file', path: 'report.txt', displayText: 'report.txt', origin: 'attachment', attachmentId: 'report' },
    { source: 'agent', path: 'review-agent', displayText: '审查 Agent' }
  ] satisfies Mention[]) {
    const withReference = { ...mention, textOffset: selected.text.length }
    expect(hasNonResourceContent({ text: selected.text + mentionToken(mention), mentions: [...selected.mentions, withReference] })).toBe(true)
  }
})

test('hand-typed slash tokens stay prose and stale resource metadata cannot hide an instruction', () => {
  const selected = draft([['skill', 'same']])
  const typed = selected.text + '/skill:same /mcp:typed /kb:typed'
  expect(hasNonResourceContent({ ...selected, text: typed })).toBe(true)
  expect(draftResourceBindings({ ...selected, text: typed })).toEqual({ skills: ['same'], mcpServers: [], knowledgeBases: [] })
  expect(hasNonResourceContent({ text: typed, mentions: [] })).toBe(true)
  expect(draftResourceBindings({ text: typed, mentions: [] })).toEqual(empty())
  const stale = { text: '请实际处理', mentions: selected.mentions }
  expect(hasNonResourceContent(stale)).toBe(true)
  expect(draftResourceBindings(stale)).toEqual(empty())
})

test('successful sends consume only their resource identities and explicitly clear their last selection', () => {
  const sent = draft([['skill', 'sent'], ['mcp', 'server'], ['skill', 'sent']])
  const current: ResourceBindings = { skills: ['sent', 'selected-later'], mcpServers: ['server'], knowledgeBases: ['untouched-library'] }
  const snapshot = structuredClone(current)
  expect(consumedResourcePatch(current, sent)).toEqual({ skills: ['selected-later'], mcpServers: [] })
  expect(consumedResourcePatch({}, sent)).toEqual({ skills: [], mcpServers: [] })
  expect(current).toEqual(snapshot)
  expect(consumedResourcePatch(current, { text: sent.text, mentions: [] })).toEqual({})
  expect(consumedResourcePatch(current, plain)).toEqual({})
})

test('Work admission retains conversation knowledge while consuming single-turn tools and draft labels', () => {
  const current = { skills: ['skill'], mcpServers: ['server'], knowledgeBases: ['existing', 'sent', 'later'], knowledgeBaseMentionsConsumed: ['existing'] }
  const snapshot = structuredClone(current)
  const sent = draft([['skill', 'skill'], ['mcp', 'server'], ['kb', 'sent']])
  const patch = consumedWorkResourcePatch(current, sent)
  expect(patch).toEqual({ skills: [], mcpServers: [], knowledgeBaseMentionsConsumed: ['existing', 'sent'] })
  expect({ ...current, ...patch }.knowledgeBases).toEqual(['existing', 'sent', 'later'])
  expect(consumedWorkResourcePatch({ ...empty(), knowledgeBases: ['sent'] }, plain, { knowledgeBases: ['sent'] }))
    .toEqual({ knowledgeBaseMentionsConsumed: ['sent'] })
  expect(consumedWorkResourcePatch(empty(), sent).knowledgeBaseMentionsConsumed).toEqual([])
  expect(current).toEqual(snapshot)
  expect(workResourceSelection({ ...empty(), resourceOverrides: ['knowledgeBases'] }, 'knowledgeBases')).toEqual([])
  expect(workResourceSelection(empty(), 'knowledgeBases')).toBeUndefined()
})

test('Work persistent knowledge permits plain follow-up after tool consumption and detects knowledge revocation', () => {
  const running = { skills: ['skill'], mcpServers: ['server'], knowledgeBases: ['library'] }
  expect(workResourceFollowupChanges({ ...empty(), knowledgeBases: ['library'] }, running)).toBe(false)
  expect(workResourceFollowupChanges({ knowledgeBases: ['library'] }, running)).toBe(false)
  expect(workResourceFollowupChanges({ knowledgeBases: [] }, running)).toBe(true)
  expect(workResourceFollowupChanges({ knowledgeBases: ['new'] }, running)).toBe(true)
  expect(workResourceFollowupChanges({ knowledgeBases: undefined }, running)).toBe(false)
  expect(workResourceFollowupChanges({ skills: [], mcpServers: ['server'], knowledgeBases: ['library'] }, running)).toBe(true)
  expect(workResourceFollowupChanges({ skills: ['new'], knowledgeBases: ['library'] }, running)).toBe(true)
})

test('failed send restoration merges its resources with new choices without duplicates or unrelated category patches', () => {
  const sent = draft([['skill', 'sent'], ['mcp', 'server'], ['skill', 'sent']])
  const current: ResourceBindings = { skills: ['selected-later', 'sent'], mcpServers: ['new-server'], knowledgeBases: ['untouched-library'] }
  const snapshot = structuredClone(current)
  expect(restoredResourcePatch(current, sent)).toEqual({ skills: ['selected-later', 'sent'], mcpServers: ['new-server', 'server'] })
  expect(restoredResourcePatch({}, sent)).toEqual({ skills: ['sent'], mcpServers: ['server'] })
  expect(current).toEqual(snapshot)
  expect(restoredResourcePatch(current, { text: sent.text, mentions: [] })).toEqual({})
  expect(restoredResourcePatch(current, plain)).toEqual({})
})

test('sending before legacy labels load consumes the admitted snapshot while preserving later resource selections', () => {
  const admitted: Partial<ResourceBindings> = { skills: ['legacy-skill'], mcpServers: ['legacy-server'] }
  const current: ResourceBindings = { skills: ['legacy-skill', 'selected-after-send'], mcpServers: ['legacy-server'], knowledgeBases: ['untouched-library'] }
  const original = structuredClone({ admitted, current, plain })
  expect(plain.mentions).toEqual([])
  expect(consumedResourcePatch(current, plain, admitted)).toEqual({ skills: ['selected-after-send'], mcpServers: [] })
  expect({ admitted, current, plain }).toEqual(original)
})

test('consumed next-turn selections do not change the running resources for a plain-text follow-up', () => {
  const running: ResourceBindings = { skills: ['active-skill'], mcpServers: ['active-server'], knowledgeBases: ['active-library'] }
  for (const selection of [{}, empty(), { skills: [] }, { mcpServers: [], knowledgeBases: [] }]) {
    expect(resourceFollowupChanges(selection, running)).toBe(false)
    expect(resourceFollowupChanges(selection, undefined)).toBe(false)
  }
})

test('matching selected resources allow immediate follow-up regardless of selection order', () => {
  const running: ResourceBindings = { skills: ['first', 'second'], mcpServers: ['server'], knowledgeBases: ['library'] }
  const selection: ResourceBindings = { skills: ['second', 'first'], mcpServers: ['server'], knowledgeBases: ['library'] }
  const snapshot = structuredClone({ selection, running })
  expect(resourceFollowupChanges(selection, running)).toBe(false)
  expect({ selection, running }).toEqual(snapshot)
})

test('new and replaced selections change follow-up resources in every category', () => {
  for (const [, key] of kinds) {
    expect(resourceFollowupChanges({ [key]: ['new'] }, undefined)).toBe(true)
    expect(resourceFollowupChanges({ [key]: ['new'] }, { [key]: ['running'] })).toBe(true)
    expect(resourceFollowupChanges({ [key]: ['running', 'new'] }, { [key]: ['running'] })).toBe(true)
  }
})

test('a selected MCP plus an explicit skill removal changes the running resource configuration', () => {
  const running = { skills: ['active-skill'], mcpServers: ['active-server'] }
  expect(resourceFollowupChanges({ skills: [], mcpServers: ['active-server'] }, running)).toBe(true)
  expect(resourceFollowupChanges({ skills: [], mcpServers: ['active-server'] }, { mcpServers: ['active-server'] })).toBe(false)
})

test('unspecified resource categories inherit without blocking a matching follow-up', () => {
  const running: ResourceBindings = { skills: ['active-skill'], mcpServers: ['active-server'], knowledgeBases: ['active-library'] }
  expect(resourceFollowupChanges({ mcpServers: ['active-server'] }, running)).toBe(false)
  expect(resourceFollowupChanges({ skills: undefined, mcpServers: ['active-server'], knowledgeBases: undefined }, running)).toBe(false)
})
