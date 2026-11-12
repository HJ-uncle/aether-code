/** Pure resource-chip queue contracts: revocation only; no browser, engine or provider calls. */
import { expect, test } from '@playwright/test'
import { queueMentionToken, queueResourcesAfterDraftEdit } from '../src/shared/next-turn-queue-state'
import type { NextTurnQueueEntry, NextTurnQueueEnvelope, QueueMention, QueueResourceSelection } from '../src/shared/next-turn-queue'
import { editQueueDraft } from '../src/renderer/src/core/engine/work-queue-entry'

type Draft = NextTurnQueueEnvelope['draft']
type Resources = NextTurnQueueEnvelope['resources']
const kinds = [['skill', 'skills'], ['mcp', 'mcpServers'], ['kb', 'knowledgeBases']] as const
function draft(identities: Array<[QueueMention['source'], string]>, prefix = ''): Draft {
  let text = prefix
  const mentions: QueueMention[] = []
  for (const [source, path] of identities) {
    const mention: QueueMention = { source, path, displayText: `名称 ${path}`, textOffset: text.length }
    mentions.push(mention)
    text += `${queueMentionToken(mention)} `
  }
  return { text, revision: 1, mentions }
}
function resources(selection: QueueResourceSelection = { kind: 'override', ids: ['selected', 'unrelated'] }): Resources {
  return { skills: structuredClone(selection), mcpServers: structuredClone(selection), knowledgeBases: structuredClone(selection) }
}
const plain: Draft = { text: '普通任务', revision: 2, mentions: [] }

test('removing a resource chip revokes only its existing category binding and leaves other IDs intact', () => {
  for (const [kind, key] of kinds) {
    const original = resources()
    const snapshot = structuredClone(original)
    const result = queueResourcesAfterDraftEdit(draft([[kind, 'selected']]), plain, original)
    expect(result).toEqual({ ...original, [key]: { kind: 'override', ids: ['unrelated'] } })
    for (const [, other] of kinds) if (other !== key) expect(result[other]).toBe(original[other])
    expect(original).toEqual(snapshot)
  }
})

test('removing the last explicit resource selection produces none rather than inheritance', () => {
  for (const [kind, key] of kinds) {
    const original = resources({ kind: 'override', ids: ['selected'] })
    expect(queueResourcesAfterDraftEdit(draft([[kind, 'selected']]), plain, original)[key]).toEqual({ kind: 'none' })
  }
})

test('resource chip removal leaves inherited and disabled selections unchanged', () => {
  for (const selection of [{ kind: 'inherit' }, { kind: 'none' }] as const) {
    const original = resources(selection)
    expect(queueResourcesAfterDraftEdit(draft(kinds.map(([kind]) => [kind, 'selected'])), plain, original)).toBe(original)
  }
})

test('new metadata, pasted slash tokens, renamed labels and moving chips never grant resources', () => {
  const original = resources()
  const chips = draft(kinds.map(([kind]) => [kind, 'selected']))
  expect(queueResourcesAfterDraftEdit(plain, chips, original)).toBe(original)
  const typed = { text: chips.text, mentions: [], revision: 2 }
  expect(queueResourcesAfterDraftEdit(plain, typed, original)).toBe(original)
  const moved = draft([['kb', 'selected'], ['skill', 'selected'], ['mcp', 'selected']], '😀 前置文字 ')
  moved.mentions = moved.mentions.map(mention => ({ ...mention, displayText: '更新名称' }))
  expect(queueResourcesAfterDraftEdit(chips, moved, original)).toBe(original)
  expect(queueResourcesAfterDraftEdit(draft([['skill', 'not-selected']]), plain, original)).toBe(original)
})

test('one repeated chip keeps its captured resource selected while another occurrence is removed', () => {
  const original = resources()
  for (const [kind] of kinds) {
    expect(queueResourcesAfterDraftEdit(draft([[kind, 'selected'], [kind, 'selected']]), draft([[kind, 'selected']]), original)).toBe(original)
  }
})

test('resource and toolkit revocations coexist without changing the existing toolkit inheritance contract', () => {
  const before = draft([['skill', 'selected'], ['mcp', 'selected'], ['kb', 'selected'], ['toolkit', 'agent-management']])
  const original: Resources = { ...resources(), toolkits: { kind: 'override', ids: ['agent-management', 'skill-management'] } }
  const result = queueResourcesAfterDraftEdit(before, plain, original)
  expect(result).toEqual({ skills: { kind: 'override', ids: ['unrelated'] }, mcpServers: { kind: 'override', ids: ['unrelated'] },
    knowledgeBases: { kind: 'override', ids: ['unrelated'] }, toolkits: { kind: 'override', ids: ['skill-management'] } })
  const inherited: Resources = { ...original, toolkits: { kind: 'inherit' } }
  expect(() => queueResourcesAfterDraftEdit(before, plain, inherited)).toThrow('Resolve the inherited')
  expect(queueResourcesAfterDraftEdit(before, plain, inherited, ['agent-management', 'skill-management'])).toEqual(result)
  expect(inherited.toolkits).toEqual({ kind: 'inherit' })
})

test('resource identities reject file fields, invalid offsets and malformed IDs before revocation', () => {
  const original = resources()
  for (const [kind] of kinds) {
    const valid = draft([[kind, 'selected']])
    for (const patch of [{ origin: 'attachment' }, { attachmentId: 'file' }, { content: '' }, { startLine: 1 },
      { textOffset: 1 }, { path: '' }, { path: 'bad\nname' }, { path: 'a'.repeat(2049) }]) {
      const invalid = structuredClone(valid)
      Object.assign(invalid.mentions[0], patch)
      expect(() => queueResourcesAfterDraftEdit(invalid, plain, original)).toThrow()
      expect(() => queueResourcesAfterDraftEdit(plain, invalid, original)).toThrow()
    }
  }
})

for (const toolkitMode of ['absent', 'inherit'] as const) {
  for (const keepOtherResources of [true, false]) {
    test(`Work queue deletes ordinary resources alongside ${toolkitMode} toolkit inheritance and ${keepOtherResources ? 'keeps unrelated selections' : 'explicitly clears the last selections'}`, () => {
      const original: Resources = {
        ...resources({ kind: 'override', ids: keepOtherResources ? ['selected', 'keep'] : ['selected'] }),
        ...(toolkitMode === 'inherit' ? { toolkits: { kind: 'inherit' as const } } : {})
      }
      const entry: NextTurnQueueEntry = {
        id: 'mixed-resource-removal', revision: 1, createdAt: 1, updatedAt: 1, phase: 'pending',
        envelope: {
          code: {}, draft: draft([['skill', 'selected'], ['mcp', 'selected'], ['kb', 'selected'], ['toolkit', 'agent-management']]),
          model: { kind: 'engine-default' }, workspace: { kind: 'local-workspace', identity: 'fixture-workspace' },
          agent: { primaryAgentId: null, collaborators: [] }, resources: original, thinking: { kind: 'inherit' },
          memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: []
        }
      }
      const snapshot = structuredClone(entry)
      const edited = editQueueDraft(entry, '普通文字', [])
      const remaining: QueueResourceSelection = keepOtherResources ? { kind: 'override', ids: ['keep'] } : { kind: 'none' }
      expect(edited.resources).toEqual({
        skills: remaining, mcpServers: remaining, knowledgeBases: remaining,
        ...(toolkitMode === 'inherit' ? { toolkits: { kind: 'inherit' } } : {})
      })
      if (toolkitMode === 'absent') expect(edited.resources).not.toHaveProperty('toolkits')
      expect(edited.draft).toEqual({ text: '普通文字', revision: 2, mentions: [] })
      expect(edited.attachments).toEqual([])
      expect(entry).toEqual(snapshot)
    })
  }
}
