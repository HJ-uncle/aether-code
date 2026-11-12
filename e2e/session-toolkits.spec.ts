/** Session capability selectors survive direct, queued and remote boundaries. No Electron or provider calls. */
import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { dispatchChatRequest } from '../src/renderer/src/core/engine/chat-send-request'
import { queueSubmission, queueEntryDraft } from '../src/renderer/src/core/engine/session-queue-entry'
import { hasAgentCatalogueChange } from '../src/renderer/src/core/engine/agent-catalogue'
import { prepareRemoteChatBody } from '../src/main/engine/remote-workspace'
import { normalizeRootRunRequestConfig } from '../src/shared/root-run'
import { resolveSessionRequestConfig, saveSessionRequestSelection, loadSessionRequestSelection } from '../src/renderer/src/features/conversation/shared/session-request-config'
import { applyNextTurnQueueMutation, assertQueueEnvelope, assertQueueState, emptyNextTurnQueue } from '../src/shared/next-turn-queue-state'
import type { NextTurnQueueEnvelope, NextTurnQueueScope } from '../src/shared/next-turn-queue'
import { buildMentionMessage, isStoredMention, mentionTitle, mentionToken, parseMentionContent, refToMention, userMessageDraft, type Mention } from '../src/renderer/src/features/conversation/shared/mention-context'
import { buildAgentMentionMessage } from '../src/renderer/src/features/conversation/shared/agent-references'
import { rebindAttachmentClipboard } from '../src/renderer/src/features/conversation/shared/attachment-editor-transfer'

const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 'toolkit-tenant',
  namespace: { id: 'toolkit-db', generation: 'one' }, owner: 'work', taskId: 'toolkit-session' }
const cases = [
  { name: 'explicit enable', ids: ['agent-management'], selection: { kind: 'override', ids: ['agent-management'] } },
  { name: 'explicit removal', ids: [], selection: { kind: 'none' } },
  { name: 'inherit existing session', ids: undefined, selection: undefined }
] as const

function envelope(toolkits: string[] | undefined): NextTurnQueueEnvelope {
  const submission = queueSubmission('Continue the task', { sessionId: scope.taskId, toolkits })
  return { ...submission, workspace: { kind: 'local-scratch', identity: 'session:' + scope.taskId },
    agent: { primaryAgentId: null, collaborators: [] }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] }
}

for (const example of cases) {
  test(`direct serialization preserves toolkit ${example.name}`, async () => {
    for (const remote of [false, true]) {
      let received: Record<string, unknown> | undefined
      await dispatchChatRequest(async body => { received = JSON.parse(JSON.stringify(body)) }, 'Keep this text', {
        sessionId: 'work-toolkit', toolkits: example.ids === undefined ? undefined : [...example.ids], workspacePaths: ['D:/local-only']
      }, remote)
      expect(received).toMatchObject({ message: 'Keep this text', sessionId: 'work-toolkit' })
      if (example.ids === undefined) expect(received).not.toHaveProperty('toolkits')
      else expect(received?.toolkits).toEqual(example.ids)
      expect(received).not.toHaveProperty('collaborators')
      expect(received?.workspacePaths).toEqual(remote ? undefined : ['D:/local-only'])
    }
  })

  test(`queue capture and persisted recovery preserve toolkit ${example.name}`, () => {
    const originalIds: string[] | undefined = example.ids === undefined ? undefined : [...example.ids]
    const captured = envelope(originalIds)
    originalIds?.push('changed-after-enqueue')
    expect(captured.resources.toolkits).toEqual(example.selection)
    assertQueueEnvelope(captured, scope)
    const initial = emptyNextTurnQueue(scope)
    const queued = applyNextTurnQueueMutation(initial, initial.revision, { kind: 'enqueue', id: 'pending', envelope: captured, at: 1 })
    const persisted: unknown = JSON.parse(JSON.stringify(queued))
    assertQueueState(persisted, scope)
    expect(queueEntryDraft(persisted.entries[0]).resources.toolkits).toEqual(example.selection)
    expect(persisted.entries[0].envelope.agent.collaborators).toEqual([])
    if (example.ids === undefined) expect(persisted.entries[0].envelope.resources).not.toHaveProperty('toolkits')
    // Editing another message choice must not silently restore a removed toolkit.
    const edited = structuredClone(persisted.entries[0].envelope)
    edited.draft.text = 'Additional requirement'
    const next = applyNextTurnQueueMutation(persisted, persisted.revision, { kind: 'edit', id: 'pending', entryRevision: 1, envelope: edited, at: 2 })
    expect(next.entries[0].envelope.resources.toolkits).toEqual(example.selection)
  })
}

test('queue rejects ambiguous or executable toolkit selectors before persistence', () => {
  const invalid: unknown[] = [null, [], 'agent-management', { kind: 'none', ids: ['agent-management'] },
    { kind: 'inherit', ids: [] }, { kind: 'override', ids: [] }, { kind: 'override', ids: ['agent-management', 'agent-management'] },
    { kind: 'override', ids: [7] }, { kind: 'override', ids: [''] }, { kind: 'override', ids: ['agent-management'], systemPrompt: 'unexpected' }]
  for (const toolkits of invalid) {
    const value = envelope(undefined)
    const forged = { ...value, resources: { ...value.resources, toolkits } }
    expect(() => assertQueueEnvelope(forged, scope), JSON.stringify(toolkits)).toThrow()
  }
  const inherited = envelope(undefined)
  inherited.resources.toolkits = { kind: 'inherit' }
  expect(() => assertQueueEnvelope(inherited, scope)).not.toThrow()
})

test('remote requests keep toolkit IDs and explicit removal while stripping local private fields', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.end(JSON.stringify({ code: 200, data: { runs: [] } }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const context = { baseUrl: `http://127.0.0.1:${address.port}`, headers: {}, signal: new AbortController().signal, configuredRoot: '/code-only' }
  try {
    for (const example of cases) {
      const result = await prepareRemoteChatBody({ sessionId: 'work-toolkit', message: 'Keep this text', toolkits: example.ids,
        workspacePaths: ['D:/private/project'], systemPrompt: 'local-secret', apiKey: 'local-secret', skillContent: 'local-secret',
        mcpConfig: { token: 'local-secret' }, env: { KEY: 'local-secret' }, attachments: [{ name: 'D:/private/file.txt', type: 'text/plain' }] }, context)
      expect(result.workspacePaths).toEqual([])
      if (example.ids === undefined) expect(result).not.toHaveProperty('toolkits')
      else expect(result.toolkits).toEqual(example.ids)
      expect(Object.keys(result).sort()).toEqual(['message', 'sessionId', 'workspacePaths', ...(example.ids === undefined ? [] : ['toolkits'])].sort())
      expect(JSON.stringify(result)).not.toContain('local-secret')
      expect(JSON.stringify(result)).not.toContain('D:/private')
    }
    const deduplicated = await prepareRemoteChatBody({ sessionId: 'work-toolkit', message: '', toolkits: ['agent-management', 'agent-management'] }, context)
    expect(deduplicated.toolkits).toEqual(['agent-management'])
    const acceptedRequests = requests.length
    for (const toolkits of ['agent-management', [1], [{ id: 'agent-management', prompt: 'not-a-selector' }], ['x'.repeat(257)]]) {
      await expect(prepareRemoteChatBody({ sessionId: 'work-toolkit', toolkits }, context)).rejects.toThrow('toolkits')
    }
    expect(requests).toHaveLength(acceptedRequests)
    expect(requests).toEqual(Array.from({ length: 4 }, () => '/api/v1/chat/runs?sessionId=work-toolkit'))
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
})

test('root request normalization and local session reload keep an explicit empty toolkit selection', () => {
  const enabled = normalizeRootRunRequestConfig({ toolkits: ['agent-management'], systemPrompt: 'not-composer-data' })
  expect(enabled).toEqual({ toolkits: ['agent-management'] })
  expect(normalizeRootRunRequestConfig({ toolkits: [] })).toEqual({ toolkits: [] })
  expect(normalizeRootRunRequestConfig({})).not.toHaveProperty('toolkits')
  expect(normalizeRootRunRequestConfig({ toolkits: ['agent-management', 7] })).not.toHaveProperty('toolkits')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value)
  } })
  try {
    saveSessionRequestSelection('session', 'engine-A', { anchorRunId: 'run', config: { toolkits: [] } })
    const selection = loadSessionRequestSelection('session', 'engine-A')
    expect(selection?.config.toolkits).toEqual([])
    expect(loadSessionRequestSelection('session', 'engine-B')).toBeNull()
    expect(resolveSessionRequestConfig({ runId: 'run', selection, serverConfig: enabled, fallbackConfig: {} }).toolkits).toEqual([])
    expect(resolveSessionRequestConfig({ runId: 'new-run', selection, serverConfig: enabled, fallbackConfig: {} }).toolkits).toEqual(['agent-management'])
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('Agent catalogue invalidation requires a successful structured mutation receipt', () => {
  for (const action of ['create', 'update', 'delete']) for (const prefix of ['agent_', 'agent_do_']) {
    expect(hasAgentCatalogueChange({ name: prefix + action, success: true, metadata: { agentChange: { action, id: 'agent-1' } } })).toBe(true)
  }
  const receipt = { name: 'agent_create', success: true, metadata: { agentChange: { action: 'create', id: 'agent-1' } } }
  for (const invalid of [undefined, null, [], 'Agent created', {}, { ...receipt, success: false }, { ...receipt, success: 'true' },
    { ...receipt, error: 'request failed' }, { ...receipt, metadata: undefined, output: 'Agent created' },
    { ...receipt, metadata: { agentChange: [] } }, { ...receipt, metadata: { agentChange: { action: 'create', id: ' ' } } },
    { ...receipt, metadata: { agentChange: { action: 'read', id: 'agent-1' } } }, { ...receipt, name: 'agent_get' },
    { ...receipt, name: 'agent_prepare_create' }, { ...receipt, name: 'write_file' }]) {
    expect(hasAgentCatalogueChange(invalid), JSON.stringify(invalid)).toBe(false)
  }
})

test('authored toolkit chips use their own namespace and survive message, history and draft roundtrip', () => {
  const toolkit: Mention = { source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理', textOffset: 4 }
  const file: Mention = { source: 'file', path: 'agent-management', displayText: 'agent-management' }
  expect(mentionToken(toolkit)).toBe('@toolkit:agent-management')
  expect(mentionToken(file)).toBe('@agent-management')
  expect(mentionTitle(toolkit)).toBe('工具包：Agent 管理')
  const text = `请使用 ${mentionToken(toolkit)} 创建助手，再读取 ${mentionToken(file)}`
  file.textOffset = text.indexOf(mentionToken(file))
  const wire = buildMentionMessage(text, [toolkit, file])
  const parsed = parseMentionContent(wire)
  expect(parsed.refs.map(ref => [ref.t, ref.p, ref.d])).toEqual([
    ['toolkit', 'agent-management', 'Agent 管理'], ['file', 'agent-management', 'agent-management']
  ])
  const draft = userMessageDraft(wire)
  expect(draft).toEqual({ text, mentions: [toolkit, file] })
  expect(buildMentionMessage(draft.text, draft.mentions)).toBe(wire)
  expect(draft.mentions.every(isStoredMention)).toBe(true)
  expect(refToMention({ ...parsed.refs[0], d: 'stale or supplied label' }).displayText).toBe('Agent 管理')
})

test('toolkit labels and pasted metadata do not grant tools or create collaborator selectors', async () => {
  const mention: Mention = { source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理', textOffset: 0 }
  const text = mentionToken(mention), authored = buildAgentMentionMessage(text, [mention])
  expect(authored.collaborators).toEqual([])
  expect(parseMentionContent(authored.message).refs[0].t).toBe('toolkit')
  for (const plain of [text, '@Agent 管理', '@agent-management']) {
    expect(userMessageDraft(plain).mentions).toEqual([])
    expect(buildAgentMentionMessage(plain, [])).toEqual({ message: plain, collaborators: [] })
  }
  expect(buildAgentMentionMessage(authored.message, []).collaborators).toEqual([])
  let wire: Record<string, unknown> | undefined
  await dispatchChatRequest(async body => { wire = JSON.parse(JSON.stringify(body)) }, authored.message, { sessionId: 'work-toolkit' }, false)
  expect(wire?.message).toBe(authored.message)
  expect(wire).not.toHaveProperty('toolkits')
  expect(wire).not.toHaveProperty('collaborators')
})

test('toolkit metadata rejects paths and attachment semantics, and plain namespace text is never promoted', () => {
  const mention: Mention = { source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理' }
  for (const invalid of [{ ...mention, path: undefined }, { ...mention, path: '../agent-management' }, { ...mention, path: '@toolkit:agent-management' },
    { ...mention, origin: 'workspace' }, { ...mention, attachmentId: 'file-id' }, { ...mention, content: 'file contents' },
    { ...mention, allowedTools: ['agent_create'] }]) {
    expect(isStoredMention(invalid)).toBe(false)
  }
  const body = '@agent-management', ref = { t: 'toolkit', p: 'agent-management', d: 'Agent 管理', s: 0, e: body.length }
  expect(parseMentionContent(`${body}\n<!--aether-refs:${JSON.stringify([ref])}-->`).refs).toEqual([])
  const token = mentionToken(mention)
  expect(parseMentionContent(`${token}\n<!--aether-refs:${JSON.stringify([{ ...ref, e: token.length, o: 'attachment', a: 'file-id' }])}-->`).refs).toEqual([])
  expect(parseMentionContent(`${token}\n<!--aether-refs:${JSON.stringify([{ ...ref, e: token.length, content: 'not-a-file' }])}-->`).refs).toEqual([])
})

test('private same-session clipboard rebinding preserves actual toolkit chips without promoting plain text or Agent tokens', () => {
  const toolkit: Mention = { source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理', textOffset: 2 }
  const text = `前 ${mentionToken(toolkit)} 后`
  expect(rebindAttachmentClipboard({ text, mentions: [toolkit] }, [])).toEqual({ text, mentions: [toolkit] })
  expect(rebindAttachmentClipboard({ text, mentions: [] }, [])).toBeNull()
  expect(rebindAttachmentClipboard({ text, mentions: [{ ...toolkit, textOffset: 3 }] }, [])).toBeNull()
  const agent: Mention = { source: 'agent', path: 'custom-agent', displayText: '助手', textOffset: text.length + 1 }
  const mixed = `${text} ${mentionToken(agent)}`
  expect(rebindAttachmentClipboard({ text: mixed, mentions: [toolkit, agent] }, [])).toEqual({ text: mixed, mentions: [toolkit] })
})
