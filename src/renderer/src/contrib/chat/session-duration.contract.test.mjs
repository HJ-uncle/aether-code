import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Timing is independent of transport and billing. Exercise the real reducer
// with durable roots, legacy timestamps and overlapping child snapshots.
const directory = dirname(fileURLToPath(import.meta.url))
function load(name) {
  const path = resolve(directory, name), exports = {}
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(specifier => {
    throw new Error(`Unexpected runtime dependency ${specifier}`)
  }, exports)
  return exports
}
const { sessionExecutionTiming, sessionExecutionDuration } = load('session-duration.ts')
const { sumUsage, formatElapsedDuration } = load('usage.ts')
const base = 1_800_000_000_000
const hour = 3_600_000

function root(id, startedAt, finishedAt, overrides = {}) {
  return { schemaVersion: 1, sessionId: 'session-a', runId: id, turnId: `turn-${id}`,
    userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, version: 2, seq: 1,
    status: 'succeeded', createdAt: startedAt, updatedAt: finishedAt ?? startedAt,
    startedAt, finishedAt, pending: [], ...overrides }
}
function message(run, overrides = {}) {
  return { id: run?.assistantMessageId ?? 'legacy-assistant', role: 'assistant', content: 'answer',
    thinking: '', tools: [], items: [], status: 'done', createdAt: run?.createdAt ?? base,
    ...(run ? { run, runId: run.runId, startedAt: run.startedAt, endedAt: run.finishedAt } : {}),
    ...overrides }
}
function child(id, startedAt, finishedAt, overrides = {}) {
  return { schemaVersion: 1, runId: id, tenantId: 'tenant', rootSessionId: 'session-a',
    parentSessionId: 'session-a', parentConversationId: 'turn-parent', parentMessageId: 'assistant-parent',
    parentToolCallId: `tool-${id}`, childSessionId: `child-${id}`, task: 'task', description: 'description',
    modelId: 'model', status: 'succeeded', lastSeq: 2, createdAt: startedAt,
    updatedAt: finishedAt ?? startedAt, startedAt, finishedAt, usage: {}, toolCalls: [], ...overrides }
}
const tool = run => ({ id: `tool-${run.runId}`, name: 'delegate', args: '', result: '', state: 'done', subagent: run })
const duration = (messages, now = base + 24 * hour) => sessionExecutionDuration(sessionExecutionTiming(messages), now)

test('three ten-second turns separated by nearly seven hours total thirty seconds without changing token billing', () => {
  const offsets = [0, 3 * hour, 6 * hour + 54 * 60_000]
  const messages = offsets.flatMap((offset, index) => {
    const run = root(`round-${index}`, base + offset, base + offset + 10_000)
    return [message(run, { id: run.userMessageId, role: 'user', content: `question-${index}` }),
      message(run, { usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })]
  })
  const original = structuredClone(messages), billing = sumUsage(messages)
  const timing = sessionExecutionTiming(messages)
  assert.equal(timing.incomplete, false)
  assert.equal(sessionExecutionDuration(timing, base + 24 * hour), 30_000)
  assert.equal(formatElapsedDuration(duration(messages)), '30s')
  assert.deepEqual(sumUsage(messages), billing)
  assert.equal(billing.total, 330)
  assert.equal(billing.input, 300)
  assert.equal(billing.output, 30)
  assert.deepEqual(messages, original)
  assert.equal(duration(structuredClone(messages)), 30_000)
})

test('steering segments and user rows share one latest durable run, even when stale versions appear last', () => {
  const old = root('steered', base, undefined, { status: 'running', version: 1, updatedAt: base + 1_000 })
  const completed = root('steered', base, base + 18_000, { version: 3 })
  const messages = [
    message(old, { id: old.userMessageId, role: 'user' }),
    message(completed, { id: 'first-segment', startedAt: base - hour, endedAt: base + hour }),
    message(undefined, { id: 'unbound-segment', runId: old.runId, startedAt: base - hour, endedAt: base + hour }),
    message(completed, { id: 'final-segment' }),
    message(old, { id: 'late-stale-copy', status: 'streaming' })
  ]
  assert.equal(sessionExecutionTiming(messages).intervals.length, 1)
  assert.equal(duration(messages), 18_000)
  assert.equal(duration(messages, base + 72 * hour), 18_000)
})

test('equal root versions prefer the newer observation and distinct sessions do not share root identity', () => {
  const early = root('shared-id', base, base + 2_000, { updatedAt: base + 2_000 })
  const later = root('shared-id', base, base + 4_000, { updatedAt: base + 4_000 })
  const other = root('shared-id', base + hour, base + hour + 3_000, { sessionId: 'session-b' })
  assert.equal(duration([message(later), message(early), message(other)]), 7_000)
})

test('overlapping parent and child work counts once, while a late child counts only its own interval', () => {
  const parent = root('parent', base, base + 20_000)
  const first = child('first', base + 2_000, base + 14_000)
  const extending = child('extending', base + 10_000, base + 25_000)
  const late = child('late', base + 7 * hour, base + 7 * hour + 5_000)
  const messages = [message(parent, { tools: [tool(first), tool(extending), tool(late)] }),
    message(parent, { id: 'replayed-parent', tools: [tool({ ...extending, lastSeq: 1, status: 'running', finishedAt: undefined })] })]
  assert.equal(duration(messages), 30_000)
  assert.equal(duration(messages, base + 48 * hour), 30_000)
})

test('a new running turn adds only its own clock and freezes after terminal evidence arrives', () => {
  const previous = message(root('previous', base, base + 10_000))
  const start = base + 7 * hour
  const running = message(root('current', start, undefined, { status: 'running', version: 1 }), { status: 'streaming' })
  const messages = [previous, running]
  assert.equal(duration(messages, start + 5_000), 15_000)
  assert.equal(duration(messages, start + 12_000), 22_000)
  const finished = message(root('current', start, start + 15_000, { status: 'cancelled', version: 2 }), { status: 'aborted' })
  assert.equal(duration([previous, finished], start + 20_000), 25_000)
  assert.equal(duration([previous, finished], start + 20 * hour), 25_000)
})

test('waiting roots include waiting inside their own turn and queued children do not invent execution', () => {
  const waiting = root('waiting', base, undefined, { status: 'waiting', version: 1 })
  const queued = child('queued', undefined, undefined, { status: 'queued', createdAt: base, updatedAt: base })
  const messages = [message(waiting, { status: 'waiting', tools: [tool(queued)] })]
  assert.equal(sessionExecutionTiming(messages).incomplete, false)
  assert.equal(duration(messages, base + 6_000), 6_000)
})

test('legacy messages require explicit start and end, never a later question or the current clock', () => {
  const messages = [message(undefined, { id: 'measured', startedAt: base, endedAt: base + 4_000 }),
    message(undefined, { id: 'only-created', createdAt: base + hour }),
    message(undefined, { id: 'only-start', startedAt: base + 2 * hour }),
    message(undefined, { id: 'next-question', role: 'user', createdAt: base + 9 * hour })]
  assert.equal(sessionExecutionTiming(messages).incomplete, true)
  assert.equal(duration(messages), 4_000)
  assert.equal(duration(messages, base + 48 * hour), 4_000)
  assert.equal(duration([message(undefined, { status: 'streaming', startedAt: base })], base + 3_000), 3_000)
})

test('terminal roots with missing or invalid timestamps remain unknown instead of growing until now', () => {
  const invalid = [
    root('missing-end', base, undefined),
    root('missing-start', undefined, base + 3_000),
    root('nan-start', Number.NaN, base + 4_000),
    root('infinite-end', base, Number.POSITIVE_INFINITY),
    root('negative-start', -1, base),
    root('inverted', base + 5_000, base + 1_000)
  ].map(run => message(run))
  const timing = sessionExecutionTiming(invalid)
  assert.equal(timing.incomplete, true)
  assert.equal(sessionExecutionDuration(timing, base + 48 * hour), undefined)
  assert.equal(duration([...invalid, message(root('valid', base, base + 2_000))]), 2_000)
  assert.equal(formatElapsedDuration(sessionExecutionDuration(timing, base)), null)
})

test('an unmeasurable child never turns its finish timestamp into a parent-to-child wall-clock span', () => {
  const run = root('parent', base, base + 10_000)
  const unknown = child('unknown-start', undefined, base + 12 * hour)
  const messages = [message(run, { tools: [tool(unknown)] })]
  assert.equal(sessionExecutionTiming(messages).incomplete, true)
  assert.equal(duration(messages), 10_000)
})

test('a historical running child cannot keep timing after the latest parent root has terminated', () => {
  for (const parentStatus of ['succeeded', 'cancelled', 'failed', 'interrupted']) {
    for (const childStatus of ['running', 'cancelling']) {
      const oldParent = root('parent', base, undefined, { status: 'running', version: 1, updatedAt: base + 1_000 })
      const finalParent = root('parent', base, base + 20_000, { status: parentStatus, version: 3 })
      const staleChild = child('stale', base + 2_000, undefined, { status: childStatus })
      const earlySegment = message(oldParent, { id: 'historical-owner', status: 'streaming', tools: [tool(staleChild)] })
      const finalSegment = message(finalParent, { id: 'final-owner' })
      for (const messages of [[earlySegment, finalSegment], [finalSegment, earlySegment]]) {
        const timing = sessionExecutionTiming(messages)
        assert.equal(timing.incomplete, true, `${parentStatus}/${childStatus} must disclose the missing child end`)
        assert.equal(sessionExecutionDuration(timing, base + 7 * hour), 20_000)
        assert.equal(sessionExecutionDuration(timing, base + 48 * hour), 20_000)
      }
    }
  }
})

test('a genuinely active parent permits its active child clock without charging the parent span twice', () => {
  for (const parentStatus of ['running', 'waiting']) {
    const parent = root('parent', base, undefined, { status: parentStatus, version: 1 })
    const running = child('running', base + 2_000, undefined, { status: 'running' })
    const cancelling = child('cancelling', base + 6_000, undefined, { status: 'cancelling' })
    const messages = [message(parent, { status: parentStatus === 'waiting' ? 'waiting' : 'streaming', tools: [tool(running), tool(cancelling)] })]
    const timing = sessionExecutionTiming(messages)
    assert.equal(timing.incomplete, false)
    assert.equal(sessionExecutionDuration(timing, base + 25_000), 25_000)
    assert.equal(sessionExecutionDuration(timing, base + 30_000), 30_000)
  }
})

test('legacy child clocks require an actively streaming or waiting parent, not a stale child status alone', () => {
  const running = child('legacy-child', base + 2_000, undefined, { status: 'running' })
  const settled = message(undefined, { startedAt: base, endedAt: base + 10_000, status: 'done', tools: [tool(running)] })
  assert.equal(sessionExecutionTiming([settled]).incomplete, true)
  assert.equal(duration([settled], base + 7 * hour), 10_000)
  for (const status of ['streaming', 'waiting']) {
    const live = { ...settled, status, endedAt: undefined }
    assert.equal(sessionExecutionTiming([live]).incomplete, false)
    assert.equal(duration([live], base + 20_000), 20_000)
  }
})

test('completed children may extend a completed parent but never fill the idle gap before a later child interval', () => {
  const parent = root('parent', base, base + 10_000)
  const extending = child('extends-parent', base + 8_000, base + 15_000)
  const later = child('later-completed', base + 6 * hour, base + 6 * hour + 5_000)
  const messages = [message(parent, { tools: [tool(extending), tool(later)] })]
  assert.equal(sessionExecutionTiming(messages).incomplete, false)
  assert.equal(duration(messages, base + 7 * hour), 20_000)
  assert.equal(duration(messages, base + 48 * hour), 20_000)
})

test('zero measured milliseconds and touching execution intervals retain their exact bounds', () => {
  const zero = message(root('zero', base, base))
  assert.equal(duration([zero]), 0)
  assert.equal(formatElapsedDuration(duration([zero])), '<1s')
  const messages = [zero, message(root('first', base, base + 1_000)),
    message(root('second', base + 1_000, base + 3_000))]
  assert.equal(duration(messages), 3_000)
  assert.equal(formatElapsedDuration(3_661_000), '1h01m')
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) assert.equal(formatElapsedDuration(value), null)
})

test('switching to another message set cannot inherit previous timing, including future-start and missing-clock cases', () => {
  const known = [message(root('known', base, base + 30_000))]
  assert.equal(duration(known), 30_000)
  assert.equal(duration([message(undefined, { createdAt: base + hour })]), undefined)
  assert.equal(duration([]), undefined)
  const future = [message(root('future', base + hour, undefined, { status: 'running' }), { status: 'streaming' })]
  assert.equal(duration(future, base), undefined)
  assert.equal(duration(future, Number.NaN), undefined)
  assert.equal(duration(known, Number.NaN), 30_000)
})
