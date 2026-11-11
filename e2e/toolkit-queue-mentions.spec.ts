/** Pure queue protocol tests: no browser, Electron, engine, files or provider calls. */
import { expect, test } from '@playwright/test'
import { applyNextTurnQueueMutation, assertQueueEnvelope, assertQueueState, emptyNextTurnQueue, queueMentionToken, queueResourcesAfterDraftEdit } from '../src/shared/next-turn-queue-state'
import { mergeQueueAttachmentReferences, remapQueueAttachmentReferences } from '../src/shared/queue-attachment-references'
import type { NextTurnQueueEntry, NextTurnQueueEnvelope, NextTurnQueueScope, QueueAttachmentReceipt, QueueMention, QueueResourceSelection } from '../src/shared/next-turn-queue'
import { editCodeQueueDraft } from '../src/renderer/src/core/engine/code-queue-entry'

const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: null },
  tenantId: 'toolkit-fixture', namespace: { id: 'fixture-db', generation: 'one' }, owner: 'work', taskId: 'work-toolkit-fixture' }
const token = '@toolkit:agent-management'
const mention: QueueMention = { source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理', textOffset: 0 }
function envelope(selection?: QueueResourceSelection): NextTurnQueueEnvelope {
  return { draft: { text: `${token} 创建一个调研助手`, revision: 1, mentions: [{ ...mention }] },
    model: { kind: 'engine-default' }, workspace: { kind: 'local-scratch', identity: `session:${scope.taskId}` },
    agent: { primaryAgentId: null, collaborators: [] },
    resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' },
      ...(selection === undefined ? {} : { toolkits: selection }) },
    thinking: { kind: 'inherit' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] }
}

test('a toolkit chip has its own machine token and survives queue persistence and text editing', () => {
  expect(queueMentionToken(mention)).toBe(token)
  expect(queueMentionToken({ ...mention, displayText: '自定义显示名称' })).toBe(token)
  const entry = envelope({ kind: 'override', ids: ['agent-management'] })
  assertQueueEnvelope(entry, scope)
  let state = emptyNextTurnQueue(scope)
  state = applyNextTurnQueueMutation(state, state.revision, { kind: 'enqueue', id: 'entry-1', envelope: entry, at: 1 })
  const restored: unknown = JSON.parse(JSON.stringify(state))
  assertQueueState(restored, scope)
  expect(restored.entries[0].envelope.draft.mentions).toEqual([mention])
  const edited = structuredClone(restored.entries[0].envelope)
  edited.draft = { text: `😀 补充要求 ${token} 保持已有配置`, revision: 2,
    mentions: [{ ...mention, textOffset: '😀 补充要求 '.length }] }
  const changed = applyNextTurnQueueMutation(restored, restored.revision,
    { kind: 'edit', id: 'entry-1', entryRevision: 1, envelope: edited, at: 2 })
  expect(changed.entries[0].envelope.draft).toEqual(edited.draft)
  expect(changed.entries[0].envelope.resources.toolkits).toEqual({ kind: 'override', ids: ['agent-management'] })
  expect(changed.entries[0].envelope.agent.collaborators).toEqual([])
})

test('only the structured resource selector carries permissions, not a chip or a pasted token', () => {
  for (const selection of [undefined, { kind: 'inherit' }, { kind: 'none' }, { kind: 'override', ids: ['agent-management'] }] as const) {
    for (const authored of [true, false]) {
      const entry = envelope(selection === undefined ? undefined : structuredClone(selection) as QueueResourceSelection)
      if (!authored) entry.draft.mentions = []
      const initial = emptyNextTurnQueue(scope)
      const queued = applyNextTurnQueueMutation(initial, initial.revision, { kind: 'enqueue', id: 'selection', envelope: entry, at: 1 })
      expect(queued.entries[0].envelope.resources.toolkits).toEqual(selection)
      expect(queued.entries[0].envelope.agent.collaborators).toEqual([])
      if (selection === undefined) expect(queued.entries[0].envelope.resources).not.toHaveProperty('toolkits')
    }
  }
})

test('rejects unknown or malformed toolkit identities instead of treating them as ordinary paths', () => {
  for (const path of [undefined, '', 'unknown', 'AGENT-MANAGEMENT', 'agent-management ', 'toolkit:agent-management', '../agent-management']) {
    const value = envelope()
    value.draft.mentions[0] = { ...mention, path }
    expect(() => assertQueueEnvelope(value, scope), String(path)).toThrow('Toolkit mention ID')
  }
  for (const text of ['@agent-management', '@toolkit:unknown', 'Agent 管理', `prefix ${token}`]) {
    const value = envelope()
    value.draft.text = text
    expect(() => assertQueueEnvelope(value, scope), text).toThrow('Mention position')
  }
})

test('rejects file, snapshot or attachment metadata on a toolkit chip', () => {
  for (const patch of [{ origin: 'workspace' }, { origin: 'attachment' }, { attachmentId: 'same-file-id' },
    { content: '' }, { startLine: 1 }, { endLine: 2 }, { startColumn: 1 }, { endColumn: 2 }]) {
    const value = envelope()
    Object.assign(value.draft.mentions[0], patch)
    expect(() => assertQueueEnvelope(value, scope), JSON.stringify(patch)).toThrow('Toolkit mention cannot carry')
  }
})

test('attachment freezing shifts toolkit offsets without rewriting its identity or plain token text', () => {
  const text = `😀 @input.txt ${token} 保留文本 ${token} @other.txt`
  const draft = { text, revision: 2, mentions: [
    { source: 'file' as const, path: 'input.txt', displayText: '资料', textOffset: text.indexOf('@input.txt') },
    { ...mention, textOffset: text.indexOf(token) },
    { source: 'file' as const, path: 'other.txt', displayText: '其他', textOffset: text.indexOf('@other.txt') }
  ] }
  const snapshot = structuredClone(draft)
  const remapped = remapQueueAttachmentReferences(draft, new Map([
    ['input.txt', '.ae/attachments/next-turn-long-file.txt'], ['other.txt', 'b.txt'],
    ['agent-management', 'must-not-become-a-file.txt']
  ]))
  expect(remapped.text).toBe(`😀 @.ae/attachments/next-turn-long-file.txt ${token} 保留文本 ${token} @b.txt`)
  expect(remapped.mentions[1]).toEqual({ ...mention, textOffset: remapped.text.indexOf(token) })
  expect(remapped.mentions.filter(item => item.source === 'toolkit')).toHaveLength(1)
  assertQueueEnvelope({ ...envelope(), draft: remapped }, scope)
  expect(draft).toEqual(snapshot)
})

test('attachment merging cannot relabel or remap a toolkit with a colliding path', () => {
  const receipt: QueueAttachmentReceipt = { kind: 'local-scratch', scope, path: 'agent-management', name: 'file.txt',
    mime: 'text/plain', bytes: 1, receiptId: 'file-1', sha256: 'a'.repeat(64), attachmentId: 'file-id' }
  const duplicate = { ...receipt, path: 'duplicate.txt', receiptId: 'file-2' }
  const draft = { text: `${token} @duplicate.txt`, revision: 1, mentions: [mention,
    { source: 'file' as const, path: 'duplicate.txt', attachmentId: 'file-id', displayText: '附件9', textOffset: token.length + 1 }] }
  const merged = mergeQueueAttachmentReferences(draft, [receipt, duplicate])
  expect(merged.attachments).toHaveLength(1)
  expect(merged.draft.text).toBe(`${token} @agent-management`)
  expect(merged.draft.mentions[0]).toEqual(mention)
  expect(merged.draft.mentions[1]).toMatchObject({ source: 'file', path: 'agent-management', displayText: '附件1' })
  assertQueueEnvelope({ ...envelope(), draft: merged.draft }, scope)
})

test('removing an authored toolkit chip revokes only its captured resource and persists the removal', () => {
  const original = envelope({ kind: 'override', ids: ['agent-management'] })
  original.resources.skills = { kind: 'override', ids: ['skill-1'] }
  original.resources.mcpServers = { kind: 'none' }
  const draft = { text: `改为普通工作；只是文字 ${token}`, revision: 2, mentions: [] }
  const resources = queueResourcesAfterDraftEdit(original.draft, draft, original.resources)
  expect(resources).toEqual({ ...original.resources, toolkits: { kind: 'none' } })
  expect(original.resources.toolkits).toEqual({ kind: 'override', ids: ['agent-management'] })
  let state = emptyNextTurnQueue(scope)
  state = applyNextTurnQueueMutation(state, state.revision, { kind: 'enqueue', id: 'remove', envelope: original, at: 1 })
  state = applyNextTurnQueueMutation(state, state.revision, { kind: 'edit', id: 'remove', entryRevision: 1,
    envelope: { ...original, draft, resources }, at: 2 })
  const restored: unknown = JSON.parse(JSON.stringify(state))
  assertQueueState(restored, scope)
  expect(restored.entries[0].envelope.resources.toolkits).toEqual({ kind: 'none' })
  expect(restored.entries[0].envelope.draft.mentions).toEqual([])
})

test('revocation filters an explicit selection without replacing unrelated captured resource IDs', () => {
  const original = envelope({ kind: 'override', ids: ['agent-management', 'another-captured-package'] })
  const resources = queueResourcesAfterDraftEdit(original.draft, { text: '普通任务', revision: 2, mentions: [] }, original.resources)
  expect(resources.toolkits).toEqual({ kind: 'override', ids: ['another-captured-package'] })
  expect(resources.skills).toBe(original.resources.skills)
  expect(resources.mcpServers).toBe(original.resources.mcpServers)
  expect(resources.knowledgeBases).toBe(original.resources.knowledgeBases)
})

test('inherited removal requires a trusted selection and preserves other enabled packages', () => {
  for (const selection of [undefined, { kind: 'inherit' }, { kind: 'none' }] as const) {
    const original = envelope(selection)
    const draft = { text: '取消工具包', revision: 2, mentions: [] }
    if (selection?.kind !== 'none') {
      expect(() => queueResourcesAfterDraftEdit(original.draft, draft, original.resources)).toThrow('Resolve the inherited')
      expect(queueResourcesAfterDraftEdit(original.draft, draft, original.resources,
        ['agent-management', 'skill-management', 'automation']).toolkits).toEqual({ kind: 'override', ids: ['skill-management', 'automation'] })
    }
    const resources = queueResourcesAfterDraftEdit(original.draft, draft, original.resources, ['agent-management'])
    expect(resources.toolkits).toEqual({ kind: 'none' })
  }
})

test('text edits and newly supplied chip metadata never grant a package or replace an unchanged selection', () => {
  for (const selection of [undefined, { kind: 'inherit' }, { kind: 'none' }, { kind: 'override', ids: ['agent-management'] }] as const) {
    const original = envelope(selection === undefined ? undefined : structuredClone(selection) as QueueResourceSelection)
    const shifted = { text: `😀 ${original.draft.text}；追加说明`, revision: 2,
      mentions: [{ ...mention, textOffset: '😀 '.length }] }
    expect(queueResourcesAfterDraftEdit(original.draft, shifted, original.resources)).toBe(original.resources)
    const plain = { text: `手工输入 ${token}`, revision: 1, mentions: [] }
    expect(queueResourcesAfterDraftEdit(plain, original.draft, original.resources)).toBe(original.resources)
    expect(queueResourcesAfterDraftEdit(plain, { ...plain, text: `再加一次 ${token} ${token}` }, original.resources)).toBe(original.resources)
  }
})

test('removing one repeated chip does not revoke the package while another authored chip remains', () => {
  const original = envelope({ kind: 'override', ids: ['agent-management'] })
  original.draft = { text: `${token} 和 ${token}`, revision: 1,
    mentions: [{ ...mention }, { ...mention, textOffset: token.length + ' 和 '.length }] }
  const retained = { text: `保留 ${token}`, revision: 2, mentions: [{ ...mention, textOffset: '保留 '.length }] }
  expect(queueResourcesAfterDraftEdit(original.draft, retained, original.resources)).toBe(original.resources)
})

test('revocation validates both old and edited drafts before trusting toolkit metadata', () => {
  const original = envelope({ kind: 'override', ids: ['agent-management'] })
  const plain = { text: '普通任务', revision: 2, mentions: [] }
  for (const invalid of [
    { ...original.draft, mentions: [{ ...mention, textOffset: 1 }] },
    { ...original.draft, mentions: [{ ...mention, origin: 'attachment' as const }] },
    { ...original.draft, mentions: [{ ...mention, path: 'unknown-package' }] },
    { ...original.draft, mentions: [{ ...mention, content: 'not-authority' }] },
  ]) {
    expect(() => queueResourcesAfterDraftEdit(invalid, plain, original.resources)).toThrow()
    expect(() => queueResourcesAfterDraftEdit(plain, invalid, original.resources)).toThrow()
  }
  expect(original.resources.toolkits).toEqual({ kind: 'override', ids: ['agent-management'] })
})

test('Code textarea edits share revocation while pasted token text stays unprivileged', () => {
  const entry: NextTurnQueueEntry = { id: 'code-fixture', revision: 1, createdAt: 1, updatedAt: 1, phase: 'pending',
    envelope: { ...envelope({ kind: 'override', ids: ['agent-management'] }), code: {} } }
  const kept = editCodeQueueDraft(entry, `${entry.envelope.draft.text}；追加说明`, [])
  expect(kept.resources.toolkits).toEqual(entry.envelope.resources.toolkits)
  expect(kept.draft.mentions).toEqual([mention])
  const removed = editCodeQueueDraft(entry, '继续普通任务', [])
  expect(removed.resources.toolkits).toEqual({ kind: 'none' })
  expect(removed.draft.mentions).toEqual([])
  const plain = { ...entry, envelope: { ...envelope(), code: {}, draft: { text: '普通任务', revision: 1, mentions: [] } } }
  const pasted = editCodeQueueDraft(plain, `普通任务 ${token}`, [])
  expect(pasted.resources).not.toHaveProperty('toolkits')
  expect(pasted.draft.mentions).toEqual([])
  const inherited = { ...entry, envelope: { ...entry.envelope, resources: { ...entry.envelope.resources, toolkits: { kind: 'inherit' as const } } } }
  const deferred = editCodeQueueDraft(inherited, '移除标签后保持其他工具包', [])
  expect(deferred.resources.toolkits).toEqual({ kind: 'inherit' })
  expect(deferred.draft.mentions).toEqual([])
})
