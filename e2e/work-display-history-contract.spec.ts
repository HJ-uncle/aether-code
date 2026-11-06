/** New complete-turn display contract: boundaries, live preservation, mutation invalidation and compact restore. */
import { expect, test } from '@playwright/test'
import { cacheDisplayHistory, checkDisplayHistory, mergeDisplayHistory, type DisplayHistoryPage } from '../src/renderer/src/core/engine/display-history'
import { replayMessages, type EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

function turn(index: number, tools = 0): EngineHistoryRow[] {
  const conversationId = `turn-${index}`
  return [
    { id: `user-${index}`, role: 'user', content: `Question ${index}`, conversationId },
    ...Array.from({ length: tools }, (_, call): EngineHistoryRow[] => [
      { id: `assistant-${index}-${call}`, role: 'assistant', content: `Step ${call}`, conversationId,
        toolCall: { id: `tool-${index}-${call}`, name: 'read_file', args: { path: `file-${call}` } } },
      { id: `result-${index}-${call}`, role: 'tool', content: `Evidence ${call}`, toolCallId: `tool-${index}-${call}`, conversationId }
    ]).flat(),
    { id: `answer-${index}`, role: 'assistant', content: `Answer ${index}`, conversationId }
  ]
}

function page(all: EngineHistoryRow[][], start = Math.max(0, all.length - 2), mutationRevision = 'm1'): DisplayHistoryPage {
  const selected = all.slice(start, start + 2)
  return { schemaVersion: 1, turns: all.map(rows => ({ userMessageId: rows[0].id!, conversationId: rows[0].conversationId,
    preview: String(rows[0].content) })), messages: selected.flat(), loadedTurnIds: selected.map(rows => rows[0].id!),
    revision: 'r1', mutationRevision, backend: 'jsonl', completeness: 'complete' }
}

test('a 135-tool turn restores all evidence and both navigation users without raw page truncation', () => {
  const all = [turn(1, 135), turn(2)]
  const checked = checkDisplayHistory(page(all))
  const cache = cacheDisplayHistory('session', checked)
  const original = replayMessages(all[1])
  const visible = mergeDisplayHistory(cache, original, new Set())
  expect(visible.filter(message => message.role === 'user').map(message => message.id)).toEqual(['user-1', 'user-2'])
  const first = visible.find(message => message.role === 'assistant' && message.conversationId === 'turn-1')!
  expect(first.tools).toHaveLength(135)
  expect(first.tools[0].result).toBe('Evidence 0')
  expect(first.tools[134].result).toBe('Evidence 134')
  expect(first.content).toContain('Step 0')
  expect(first.content).toContain('Answer 1')
  expect(original).toEqual(replayMessages(all[1]))
})

test('complete turn replaces a compact orphan assistant rather than duplicate overlapping fragments', () => {
  const all = [turn(1, 135), turn(2)]
  const cache = cacheDisplayHistory('session', checkDisplayHistory(page(all)))
  const compact = replayMessages([...all[0].slice(-3), ...all[1]])
  const visible = mergeDisplayHistory(cache, compact, new Set())
  expect(visible.filter(message => message.conversationId === 'turn-1' && message.role === 'assistant')).toHaveLength(1)
  expect(visible.find(message => message.conversationId === 'turn-1' && message.role === 'assistant')!.tools).toHaveLength(135)
  expect(visible.filter(message => message.role === 'user')).toHaveLength(2)
})

test('reading earlier turns preserves live content, status, cursor-bound tool set and cleared evidence', () => {
  const all = [turn(1, 3), turn(2, 2)]
  const cache = cacheDisplayHistory('session', checkDisplayHistory(page(all)))
  const live = replayMessages(all[1].slice(0, 3))
  live[1] = { ...live[1], status: 'streaming', content: 'Still streaming partial text',
    tools: live[1].tools.map(tool => ({ ...tool, result: '[tool result cleared]', state: 'running' as const })) }
  const before = JSON.stringify(live)
  const visible = mergeDisplayHistory(cache, live, new Set(['user-2']))
  const current = visible.find(message => message.id === live[1].id)!
  expect(current.content).toBe('Still streaming partial text')
  expect(current.status).toBe('streaming')
  expect(current.tools.map(tool => tool.id)).toEqual(['tool-2-0'])
  expect(current.tools[0].result).toBe('[tool result cleared]')
  expect(JSON.stringify(live)).toBe(before)
})

test('compacted live tools 130–135 regain only 1–129 before the observed boundary, never future disk output', () => {
  const rows = turn(1, 136)
  const cache = cacheDisplayHistory('session', checkDisplayHistory(page([rows])))
  const liveRows = [rows[0], ...rows.slice(1 + 129 * 2, 1 + 135 * 2)]
  const live = replayMessages(liveRows)
  live[1] = { ...live[1], content: live[1].content + '\n\nStill replying', thinking: 'Current thinking', status: 'streaming',
    tools: live[1].tools.map((tool, index) => index === 5 ? { ...tool, state: 'running' as const, result: '' } : tool),
    items: [...live[1].items, { kind: 'thinking', text: 'Current thinking' }, { kind: 'content', text: 'Still replying' }] }
  const visible = mergeDisplayHistory(cache, live, new Set(['user-1']))
  const assistant = visible[1]
  expect(assistant.tools.map(tool => tool.id)).toEqual(Array.from({ length: 135 }, (_, index) => `tool-1-${index}`))
  expect(assistant.tools[0].result).toBe('Evidence 0')
  expect(assistant.tools[134]).toMatchObject({ state: 'running', result: '' })
  expect(assistant.content).toContain('Step 0')
  expect(assistant.content).toContain('Step 134')
  expect(assistant.content).not.toContain('Step 135')
  expect(assistant.content).not.toContain('Answer 1')
  expect(assistant.content.match(/Step 129\b/g)).toHaveLength(1)
  expect(assistant.content.endsWith('Still replying')).toBe(true)
  expect(assistant.thinking).toBe('Current thinking')
  expect(assistant.status).toBe('streaming')
  expect(assistant.items.filter(item => item.kind === 'tool')).toHaveLength(135)
})

test('settled live evidence cleared by compaction can be restored without changing tool state', () => {
  const rows = turn(1, 1), cache = cacheDisplayHistory('session', checkDisplayHistory(page([rows])))
  const live = replayMessages(rows)
  live[1].tools[0] = { ...live[1].tools[0], state: 'done', result: '[tool result cleared]' }
  expect(mergeDisplayHistory(cache, live, new Set(['user-1']))[1].tools[0]).toMatchObject({ state: 'done', result: 'Evidence 0' })
})

test('normal append and snapshot restoration keep previously loaded complete old turns in index order', () => {
  const all = [turn(1, 2), turn(2), turn(3), turn(4)]
  let cache = cacheDisplayHistory('session', checkDisplayHistory(page(all)))
  cache = cacheDisplayHistory('session', checkDisplayHistory(page(all, 0), 'user-1'), cache)
  const appended = [...all, turn(5)]
  cache = cacheDisplayHistory('session', checkDisplayHistory({ ...page(appended), revision: 'r2' }), cache)
  const visible = mergeDisplayHistory(cache, replayMessages(appended[4]), new Set())
  expect(visible.filter(message => message.role === 'user').map(message => message.id)).toEqual(['user-1', 'user-2', 'user-3', 'user-4', 'user-5'])
  expect(visible.find(message => message.conversationId === 'turn-1' && message.role === 'assistant')!.tools).toHaveLength(2)
})

test('a destructive mutation clears unloaded cached bodies and excludes deleted snapshot messages', () => {
  const all = [turn(1), turn(2), turn(3), turn(4)]
  let cache = cacheDisplayHistory('session', checkDisplayHistory(page(all, 0), 'user-1'))
  const changed = [turn(1), turn(3), turn(4)]
  changed[0][1].content = 'Edited answer'
  cache = cacheDisplayHistory('session', checkDisplayHistory(page(changed, 1, 'm2'), 'user-3'), cache)
  expect([...cache.bodies.keys()]).toEqual(['user-3', 'user-4'])
  const visible = mergeDisplayHistory(cache, replayMessages(all.flat()), new Set())
  expect(visible.filter(message => message.role === 'user').map(message => message.id)).toEqual(['user-3', 'user-4'])
  cache = cacheDisplayHistory('session', checkDisplayHistory(page(changed, 0, 'm2'), 'user-1'), cache)
  expect(mergeDisplayHistory(cache, replayMessages(all.flat()), new Set()).find(message => message.id === 'answer-1')?.content).toBe('Edited answer')
})

test('strict protocol rejects split turns, wrong anchors, duplicate identities and malformed index metadata', () => {
  const valid = page([turn(1, 3), turn(2)])
  expect(() => checkDisplayHistory({ ...valid, messages: valid.messages.slice(1) })).toThrow('格式')
  expect(() => checkDisplayHistory(valid, 'missing')).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, loadedTurnIds: ['user-2'] })).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, messages: [...valid.messages, valid.messages[1]] })).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, turns: [...valid.turns, valid.turns[0]] })).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, mutationRevision: '' })).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, turns: [{ ...valid.turns[0], createdAt: Infinity }, valid.turns[1]] })).toThrow('格式')
})

test('user-only current turn and migrated partial JSONL history remain explicit and usable', () => {
  const all = [turn(1), [turn(2)[0]]]
  const checked = checkDisplayHistory({ ...page(all), completeness: 'sqlite_compacted' })
  const cache = cacheDisplayHistory('session', checked)
  expect(cache.page.completeness).toBe('sqlite_compacted')
  expect(cache.bodies.get('user-2')?.map(message => message.role)).toEqual(['user'])
  expect(mergeDisplayHistory(cache, [], new Set()).filter(message => message.role === 'user')).toHaveLength(2)
})

test('separate user supplements stay separate even when the same root owns their assistant segments', () => {
  const all = [turn(1), turn(2)]
  const cache = cacheDisplayHistory('session', checkDisplayHistory(page(all)))
  const current = replayMessages(all.flat())
  current[3] = { ...current[3], content: 'Live supplement', status: 'streaming' }
  expect(mergeDisplayHistory(cache, current, new Set(['user-2'])).map(message => message.content))
    .toEqual(['Question 1', 'Answer 1', 'Question 2', 'Live supplement'])
})
