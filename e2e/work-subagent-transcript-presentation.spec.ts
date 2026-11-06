// Pure archive presentation contracts: safe call/result grouping, ordering,
// page boundaries, complete payloads and quiet conversation identities.
import { expect, test } from '@playwright/test'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { workTranscriptItems } from '../src/renderer/src/contrib/work/work-subagent-transcript-presentation'

const call = (id = 'call'): EngineHistoryRow => ({ id: `${id}-row`, role: 'assistant', toolCall: { id, name: 'read_file', args: { path: 'notes.md' } } })
const result = (id = 'call'): EngineHistoryRow => ({ id: `${id}-result`, role: 'tool', toolCallId: id, content: 'complete output' })
const allIds = (rows: EngineHistoryRow[]): (string | undefined)[] => workTranscriptItems(rows).flatMap(item => [item.row.id, ...(item.result ? [item.result.id] : [])])

test('a unique adjacent call/result forms one item without changing any original payload', () => {
  const invocation: EngineHistoryRow = { ...call(), content: 'I will inspect this file.', reasoningContent: 'Keep this reasoning.', error: { message: 'Keep this warning.' }, metadata: { attachments: [{ name: 'reference.txt' }], turnId: 'turn', runId: 'run' } }
  const outcome: EngineHistoryRow = { ...result(), content: [{ type: 'text', text: 'x'.repeat(12_200) }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], metadata: { turnId: 'turn', runId: 'run' } }
  const rows = [invocation, outcome]
  const before = JSON.stringify(rows)
  const items = workTranscriptItems(rows)
  expect(items).toHaveLength(1)
  expect(items[0].row).toBe(invocation)
  expect(items[0].result).toBe(outcome)
  expect(items[0].row.content).toBe('I will inspect this file.')
  expect(items[0].row.reasoningContent).toBe('Keep this reasoning.')
  expect(items[0].row.metadata?.attachments).toEqual([{ name: 'reference.txt' }])
  expect(items[0].result?.content).toBe(outcome.content)
  expect(items[0].toolName).toBe('read_file')
  expect(items[0].showIdentity).toBe(true)
  expect(allIds(rows)).toEqual(rows.map(row => row.id))
  expect(JSON.stringify(rows)).toBe(before)
})

test('orphan results survive page boundaries and use their own tool name', () => {
  const invocation = call(), outcome = { ...result(), metadata: { toolName: 'search_files' } }
  const orphan = workTranscriptItems([outcome], [invocation, outcome])
  expect(orphan).toHaveLength(1)
  expect(orphan[0].row).toBe(outcome)
  expect(orphan[0].result).toBeUndefined()
  expect(orphan[0].toolName).toBe('search_files')
  expect(orphan[0].showIdentity).toBe(false)
  expect(workTranscriptItems([result()], [invocation, result()])[0].toolName).toBe('read_file')
  expect(workTranscriptItems([result()])[0].row.content).toBe('complete output')
  expect(workTranscriptItems([{ ...call(), toolCall: { id: 'call' } }, outcome])[0].toolName).toBe('search_files')
})

test('missing, conflicting and duplicate identifiers never merge records', () => {
  const cases: EngineHistoryRow[][] = [
    [{ ...call(), toolCall: { name: 'read_file' } }, result()],
    [{ ...call(), toolCall: { id: ' ', name: 'read_file' } }, { ...result(), toolCallId: ' ' }],
    [call(), { ...result(), toolCallId: undefined }],
    [call('first'), result('second')],
    [call(), { ...call(), id: 'duplicate-call' }, result()],
    [call(), result(), { ...result(), id: 'duplicate-result' }],
    [{ ...call(), conversationId: 'first-turn' }, { ...result(), metadata: { turnId: 'second-turn' } }],
    [{ ...call(), metadata: { runId: 'first-run' } }, { ...result(), metadata: { rootRunId: 'second-run' } }]
  ]
  for (const rows of cases) {
    expect(workTranscriptItems(rows).every(item => item.result === undefined)).toBe(true)
    expect(allIds(rows)).toEqual(rows.map(row => row.id))
  }
})

test('intervening user, assistant prose and unrelated results retain their exact order', () => {
  for (const middle of [
    { id: 'middle', role: 'user', content: 'A new task' },
    { id: 'middle', role: 'assistant', content: 'An intervening note' },
    result('another-tool')
  ]) {
    const rows = [call(), middle, result()]
    expect(workTranscriptItems(rows)).toHaveLength(3)
    expect(allIds(rows)).toEqual(rows.map(row => row.id))
  }
})

test('resident duplicate IDs prevent accidental pairing at a visible window boundary', () => {
  const visible = [call(), result()]
  const previousCall = { ...call(), id: 'older-call' }
  const previousResult = { ...result(), id: 'older-result' }
  for (const resident of [[previousCall, ...visible], [previousResult, ...visible]]) {
    const items = workTranscriptItems(visible, resident)
    expect(items).toHaveLength(2)
    expect(items.map(item => item.row.id)).toEqual(visible.map(row => row.id))
    expect(items[0].result).toBeUndefined()
  }
})

test('identity is shown once per assistant context and resets for user, turn, run or model', () => {
  const assistant = (id: string, modelId: string | undefined = 'model-one'): EngineHistoryRow => ({ id, role: 'assistant', content: id, conversationId: 'turn-one', modelId, metadata: { runId: 'run-one' } })
  const rows = [
    assistant('first'), call(), result(), assistant('continued'),
    { ...assistant('missing-model'), modelId: undefined }, assistant('same-model'),
    assistant('new-model', 'model-two'),
    { ...assistant('new-turn', 'model-two'), conversationId: 'turn-two' },
    { ...assistant('new-run', 'model-two'), conversationId: 'turn-two', metadata: { runId: 'run-two' } },
    { id: 'user', role: 'user', content: 'Follow up' },
    { ...assistant('after-user', 'model-two'), conversationId: 'turn-two', metadata: { runId: 'run-two' } }
  ]
  expect(workTranscriptItems(rows).map(item => [item.row.id, item.showIdentity])).toEqual([
    ['first', true], ['call-row', false], ['continued', false], ['missing-model', false], ['same-model', false],
    ['new-model', true], ['new-turn', true], ['new-run', true], ['user', true], ['after-user', true]
  ])
})
