/** Pure contracts: inline resource selection, replay, snapshot deduplication and home persistence. */
import { expect, test } from '@playwright/test'
import type { ChatAttachment, ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { Mention } from '../src/renderer/src/contrib/chat/mention-context'
import { draftAttachments, mergeWorkAttachments, restoreWorkAttachments, workMessageAttachments } from '../src/renderer/src/contrib/work/work-attachments'
import { normalizeWorkState } from '../src/renderer/src/contrib/work/work-state'

const file = (path: string, name = path): ChatAttachment => ({ path, name, type: 'text/plain;charset=utf-8', size: 2048 })
const reference = (path: string, origin: Mention['origin'] = 'attachment'): Mention => ({ source: 'file', origin, path, displayText: '粘贴的文本', textOffset: 0 })

test('only referenced resources join explicit pending attachments, with one receipt per path', () => {
  const pending = { ...file('.ae/attachments/pending.txt'), remoteUploadId: 'live-token' }
  const selected = file('.ae/attachments/pasted.txt'), unused = file('.ae/attachments/unused.txt')
  const result = draftAttachments([pending], [pending, selected, unused], [reference(selected.path), reference(pending.path), reference(selected.path)])
  expect(result).toEqual([pending, selected])
  expect(draftAttachments([], [selected, unused], [])).toEqual([])
  expect(result[0].remoteUploadId).toBe('live-token')
})

test('resource references do not attach workspace/artifact bytes or duplicate snapshots', () => {
  const snapshot = file('snapshot.txt'), workspace = file('workspace.txt'), artifact = file('artifact.txt'), legacy = file('legacy.txt')
  const mentions: Mention[] = [
    { ...reference(snapshot.path), content: 'captured original text' },
    reference(workspace.path, 'workspace'), reference(artifact.path, 'artifact'),
    { source: 'file', path: legacy.path, displayText: legacy.name }
  ]
  expect(draftAttachments([snapshot], [snapshot, workspace, artifact, legacy], mentions)).toEqual([legacy])
  expect(draftAttachments([snapshot], [], [{ ...reference(snapshot.path), content: '' }])).toEqual([])
})

test('restoring a sent turn preserves inline resources without adding a second attachment chip', () => {
  const pending = file('new-upload.txt'), pasted = file('.ae/attachments/paste.txt'), oldUpload = file('original-upload.txt')
  const restored = restoreWorkAttachments([pending], [], [pasted, oldUpload], [reference(pasted.path)])
  expect(restored.attachments).toEqual([pending, oldUpload])
  expect(restored.sources).toEqual([pasted, oldUpload])
  expect(draftAttachments(restored.attachments, restored.sources, [reference(pasted.path)])).toEqual([pending, oldUpload, pasted])
  expect(draftAttachments(restored.attachments, restored.sources, [])).toEqual([pending, oldUpload])
})

test('source reconciliation uses user attachment receipts and keeps richer existing upload metadata', () => {
  const existing = { ...file('.ae/attachments/a.txt', 'Original title.txt'), remoteUploadId: 'token' }
  const replayed = file('.ae\\attachments\\a.txt', 'a.txt'), second = file('b.txt'), generated = file('generated.txt')
  const messages = [
    { role: 'user', attachments: [replayed, second] },
    { role: 'assistant', attachments: [generated] },
    { role: 'user', attachments: [second] }
  ] as ChatMessage[]
  const recovered = workMessageAttachments(messages)
  expect(recovered).toEqual([replayed, second])
  expect(mergeWorkAttachments([existing], recovered)).toEqual([existing, second])
})

test('home resources survive persistence independently from pending uploads and invalid receipts are rejected', () => {
  const pasted = { ...file('.ae/attachments/paste.txt'), remoteUploadId: 'ephemeral' }
  const pending = file('upload.txt')
  const state = normalizeWorkState({ homeSources: [pasted, { ...pasted, size: -1 }, { path: 'incomplete' }], homeAttachments: [pending] })
  expect(state.homeSources).toEqual([file(pasted.path)])
  expect(state.homeAttachments).toEqual([pending])
  expect(normalizeWorkState(JSON.parse(JSON.stringify(state))).homeSources).toEqual(state.homeSources)
  expect(normalizeWorkState({}).homeSources).toEqual([])
})
