import { expect, test } from '@playwright/test'
import { createQueuedChatEntry, editQueuedChatEntry } from '../src/renderer/src/core/engine/chat-queue-entry'
import { dispatchChatRequest } from '../src/renderer/src/core/engine/chat-send-request'
import type { ChatAttachment, SendOptions } from '../src/renderer/src/core/engine/useChat'

/** Pure transport contracts: queue edits/merges must change the actual serialized /chat submission. */
const first: ChatAttachment = { path: '.ae/attachments/a.txt', name: 'a.txt', type: 'text/plain', size: 1 }
const second: ChatAttachment = { path: '.ae/attachments/b.png', name: 'b.png', type: 'image/png', size: 2 }
const options: SendOptions = {
  sessionId: 'code-queue-contract', model: 'synthetic-model', agentId: 'synthetic-agent',
  workspacePaths: ['D:/synthetic-queue-workspace'], attachments: [first, second],
  skills: ['synthetic-skill'], mcpServers: ['synthetic-mcp'], knowledgeBases: ['synthetic-kb'],
  thinkingMode: false, memoryScope: 'off', subagentModel: 'synthetic-child', utilityModel: 'synthetic-utility'
}

async function capture(text: string, selection: SendOptions, remote = false): Promise<Record<string, unknown>[]> {
  const received: Record<string, unknown>[] = []
  await dispatchChatRequest(async body => { received.push(JSON.parse(JSON.stringify(body))) }, text, selection, remote)
  return received
}

test('removing one queued attachment removes its bytes selector from the local submission', async () => {
  const original = createQueuedChatEntry('q1', 'before', options)
  const edited = editQueuedChatEntry(original, '  revised instruction  ', [first])
  const received = await capture(edited.text, edited.options)
  expect(received).toHaveLength(1)
  expect(received[0].message).toBe('revised instruction')
  expect(received[0].attachments).toEqual([{ name: first.path, type: first.type }])
  expect(received[0].workspacePaths).toEqual(options.workspacePaths)
  expect(received[0].model).toBe('synthetic-model')
  expect(received[0].agentId).toBe('synthetic-agent')
  expect(received[0].skills).toEqual(['synthetic-skill'])
  expect(received[0].mcpServers).toEqual(['synthetic-mcp'])
  expect(received[0].knowledgeBases).toEqual(['synthetic-kb'])
  expect(received[0].thinkingMode).toBe(false)
  expect(received[0].memoryScope).toBe('off')
  expect(received[0].subagentModel).toBe('synthetic-child')
  expect(received[0].utilityModel).toBe('synthetic-utility')
  expect(original.attachments.map(file => file.path)).toEqual([first.path, second.path])
  expect(options.attachments).toEqual([first, second])
})

test('removing every attachment omits attachments from the actual /chat body', async () => {
  const edited = editQueuedChatEntry(createQueuedChatEntry('q2', 'before', options), 'text only', [])
  const [received] = await capture(edited.text, edited.options)
  expect(received.message).toBe('text only')
  expect(Object.hasOwn(received, 'attachments')).toBe(false)
})

test('replacing a queued attachment submits the replacement instead of the original', async () => {
  const replacement: ChatAttachment = { path: '.ae/attachments/replacement.json', name: 'replacement.json', type: 'application/json', size: 8 }
  const edited = editQueuedChatEntry(createQueuedChatEntry('q3', 'before', options), 'replace', [replacement])
  const [received] = await capture(edited.text, edited.options)
  expect(received.attachments).toEqual([{ name: replacement.path, type: replacement.type }])
})

test('merged enqueue submits both the draft attachment and the earlier queued remote upload', async () => {
  const draft: ChatAttachment = { ...first, remoteUploadId: 'opaque-current' }
  const queued: ChatAttachment = { ...second, remoteUploadId: 'opaque-queued' }
  const draftOptions = { ...options, attachments: [draft] }
  const merged = createQueuedChatEntry('q4', 'current\n\nprevious', draftOptions, [draft, queued])
  const [received] = await capture(merged.text, merged.options, true)
  expect(received.message).toBe('current\n\nprevious')
  expect(received.attachments).toEqual([{ remoteUploadId: 'opaque-current' }, { remoteUploadId: 'opaque-queued' }])
  expect(Object.hasOwn(received, 'workspacePaths')).toBe(false)
  expect(draftOptions.attachments).toEqual([draft])
})

test('removing a remote upload also removes its opaque selector before transport', async () => {
  const left = { ...first, remoteUploadId: 'opaque-left' }
  const removed = { ...second, remoteUploadId: 'opaque-removed' }
  const original = createQueuedChatEntry('q5', 'remote', { ...options, attachments: [left, removed] })
  const edited = editQueuedChatEntry(original, 'remote', [left])
  const [received] = await capture(edited.text, edited.options, true)
  expect(received.attachments).toEqual([{ remoteUploadId: 'opaque-left' }])
})

test('an attachment-only merged enqueue retains restored server-relative attachments', async () => {
  const merged = createQueuedChatEntry('q6', '', { sessionId: options.sessionId }, [first, second])
  const [received] = await capture(merged.text, merged.options, true)
  expect(received.message).toBe('')
  expect(received.attachments).toEqual([{ name: first.path, type: first.type }, { name: second.path, type: second.type }])
})

test('later input-array/object edits cannot alter the attachment selection already enqueued', async () => {
  const draftFile = { ...first }
  const input = [draftFile]
  const entry = createQueuedChatEntry('q7', 'captured', { sessionId: options.sessionId }, input)
  draftFile.path = '.ae/attachments/changed-after-enqueue.txt'
  input.push(second)
  const [received] = await capture(entry.text, entry.options)
  expect(received.attachments).toEqual([{ name: first.path, type: first.type }])
})

test('transport rejection is surfaced once and the entry is not implicitly resent', async () => {
  const entry = editQueuedChatEntry(createQueuedChatEntry('q8', 'before', options), 'keep failure visible', [first])
  const failure = new Error('synthetic transport failure')
  let attempts = 0
  await expect(dispatchChatRequest(async body => {
    attempts++
    expect(body.attachments).toEqual([{ name: first.path, type: first.type }])
    throw failure
  }, entry.text, entry.options, false)).rejects.toBe(failure)
  expect(attempts).toBe(1)
})
