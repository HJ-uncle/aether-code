import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Workspace retention must not reassign conversation cards or keep assets
// withdrawn by an authoritative history read. No renderer or engine is mocked.
const directory = dirname(fileURLToPath(import.meta.url)), cache = new Map()
function load(path) {
  if (cache.has(path)) return cache.get(path)
  const exports = {}
  cache.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(specifier => {
    if (specifier.startsWith('.')) return load(resolve(dirname(path), `${specifier}.ts`))
    throw new Error(`Unexpected runtime dependency ${specifier}`)
  }, exports)
  return exports
}
const { workFinalResultCatalog } = load(resolve(directory, 'work-final-results.ts'))
const { getMessageFinalResult, applyHistoryFinalResult } = load(resolve(directory, '../../core/engine/final-result.ts'))
const sessionId = 'work-artifact-retention', base = 1_800_000_000_000

function file(id, name = `${id}.txt`, assetId = `asset-${id}`) {
  return { id, assetId, name, path: `delivery/${name}`, kind: 'file', mimeType: 'text/plain', size: 10, sha256: 'a'.repeat(64) }
}
function turn(id, items, publishedAt, options = {}) {
  const owner = options.sessionId ?? sessionId
  const result = { schemaVersion: 1, sessionId: owner, runId: `run-${id}`, turnId: `turn-${id}`,
    assistantMessageId: `assistant-${id}`, text: `Answer ${id}`, items, publishedAt }
  const run = { schemaVersion: 1, sessionId: owner, runId: result.runId, turnId: result.turnId,
    userMessageId: `user-${id}`, assistantMessageId: result.assistantMessageId,
    seq: 1, version: 2, status: options.runStatus ?? 'succeeded', createdAt: publishedAt - 1000,
    updatedAt: publishedAt, startedAt: publishedAt - 1000, finishedAt: publishedAt, pending: [] }
  const common = { content: '', thinking: '', tools: [], items: [], status: 'done', runId: run.runId,
    conversationId: run.turnId, run, createdAt: run.createdAt }
  return [
    { ...common, id: run.userMessageId, role: 'user', content: `Question ${id}` },
    { ...common, id: run.assistantMessageId, role: 'assistant', status: options.messageStatus ?? 'done',
      content: result.text, ...(options.manifest === false ? {} : { finalResult: result }) }
  ]
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}
const catalog = messages => workFinalResultCatalog(messages, sessionId)

test('a text-only final turn retains the previous two files without moving their conversation ownership', () => {
  const earlier = turn('files', [file('report'), file('notes')], base)
  const followup = turn('text', [], base + 10_000)
  const messages = freeze([...earlier, ...followup]), before = structuredClone(messages)
  const initial = catalog(earlier), result = catalog(messages)
  assert.equal(result.latestDelivery, earlier[1].finalResult)
  assert.equal(result.current, followup[1].finalResult)
  assert.equal(result.current.items.length, 0)
  assert.deepEqual(result.latestDelivery.items.map(item => item.id), ['report', 'notes'])
  assert.equal(result.deliveryKey, initial.deliveryKey)
  assert.equal(getMessageFinalResult(messages[1], sessionId), earlier[1].finalResult)
  assert.equal(getMessageFinalResult(messages[3], sessionId), followup[1].finalResult)
  assert.deepEqual(messages, before)
})

test('a new question and unpublished, running or failed outputs cannot replace a successful delivery', () => {
  const earlier = turn('ready', [file('ready')], base), original = catalog(earlier)
  const pending = turn('pending', [file('intermediate')], base + 10_000,
    { runStatus: 'running', messageStatus: 'streaming' })
  const justAsked = catalog([...earlier, pending[0]])
  assert.equal(justAsked.current, undefined)
  assert.equal(justAsked.deliveryKey, original.deliveryKey)
  for (const later of [
    pending,
    turn('unpublished', [file('not-published')], base + 20_000, { manifest: false }),
    turn('failed', [file('failed')], base + 30_000, { runStatus: 'failed', messageStatus: 'error' }),
    turn('cancelled', [file('cancelled')], base + 40_000, { runStatus: 'cancelled', messageStatus: 'aborted' })
  ]) {
    const result = catalog([...earlier, ...later])
    assert.equal(result.current, undefined)
    assert.equal(result.latestDelivery, earlier[1].finalResult)
    assert.equal(result.deliveryKey, original.deliveryKey)
    assert.equal(result.results.length, 1)
  }
})

test('several empty turns preserve the newest actual delivery, including after history restoration', () => {
  const older = turn('older', [file('older')], base)
  const delivered = turn('latest-file', [file('latest-file')], base + 10_000)
  const empty = [1, 2, 3].flatMap(index => turn(`text-${index}`, [], base + (index + 1) * 10_000))
  const messages = [...older, ...delivered, ...empty], result = catalog(messages)
  assert.equal(result.latestDelivery.runId, 'run-latest-file')
  assert.equal(result.current.runId, 'run-text-3')
  assert.equal(result.deliveryKey, catalog([...older, ...delivered]).deliveryKey)
  assert.deepEqual(catalog(structuredClone(messages)), result)
  assert.deepEqual(result.results.map(item => item.runId),
    ['run-text-3', 'run-text-2', 'run-text-1', 'run-latest-file', 'run-older'])
})

test('a new successful nonempty publication updates the default while keeping the earlier result selectable', () => {
  const earlier = turn('first', [file('first')], base)
  const empty = turn('clarification', [], base + 10_000)
  const newer = turn('new-delivery', [file('new-delivery')], base + 20_000)
  const before = catalog([...earlier, ...empty]), after = catalog([...earlier, ...empty, ...newer])
  assert.equal(after.current, newer[1].finalResult)
  assert.equal(after.latestDelivery, newer[1].finalResult)
  assert.notEqual(after.deliveryKey, before.deliveryKey)
  assert.equal(after.results.find(item => item.runId === earlier[1].runId), earlier[1].finalResult)
  assert.equal(getMessageFinalResult(earlier[1], sessionId).items[0].id, 'first')
})

test('same-name files in another delivery or a replaced asset identity invalidate the retained selection key', () => {
  const earlier = turn('first', [file('same-item', 'report.txt', 'asset-old')], base)
  const newer = turn('second', [file('same-item', 'report.txt', 'asset-new')], base + 10_000)
  assert.notEqual(catalog(earlier).deliveryKey, catalog([...earlier, ...newer]).deliveryKey)
  const replacement = { ...earlier[1].finalResult, items: [file('same-item', 'report.txt', 'asset-replaced')] }
  const refreshed = applyHistoryFinalResult(earlier, replacement)
  assert.equal(catalog(refreshed).latestDelivery.items[0].assetId, 'asset-replaced')
  assert.notEqual(catalog(refreshed).deliveryKey, catalog(earlier).deliveryKey)
})

test('foreign sessions and mismatched root identities cannot supply retained artifacts', () => {
  const own = turn('own', [file('own')], base)
  const foreign = turn('foreign', [file('foreign')], base + 10_000, { sessionId: 'work-other' })
  const invalid = turn('mismatch', [file('mismatch')], base + 20_000)
  invalid[1].run = { ...invalid[1].run, assistantMessageId: 'another-assistant' }
  const result = catalog([...own, ...foreign, ...invalid])
  assert.equal(result.latestDelivery, own[1].finalResult)
  assert.deepEqual(result.results.map(item => item.runId), ['run-own'])
  const other = workFinalResultCatalog([...own, ...foreign], 'work-other')
  assert.equal(other.latestDelivery, foreign[1].finalResult)
  assert.deepEqual(other.results.map(item => item.runId), ['run-foreign'])
  assert.equal(workFinalResultCatalog(own, 'work-empty').latestDelivery, undefined)
})

test('a session with no published file keeps an empty state without borrowing process files', () => {
  const text = turn('only-text', [], base), result = catalog(text)
  assert.equal(result.latestDelivery, undefined)
  assert.equal(result.current, text[1].finalResult)
  assert.equal(result.deliveryKey, 'empty')
  assert.equal(catalog([]).latestDelivery, undefined)
  assert.deepEqual(catalog([]).results, [])
  const unfinalized = turn('process', [file('process')], base + 1000, { manifest: false })
  assert.equal(catalog(unfinalized).latestDelivery, undefined)
  assert.equal(catalog(unfinalized).deliveryKey, 'empty')
})

test('authoritative withdrawal at the same publication time cannot leave cached assets in the catalog', () => {
  const older = turn('fallback', [file('fallback')], base)
  const latest = turn('latest', [file('keep'), file('withdraw')], base + 10_000)
  const messages = freeze([...older, ...latest]), before = structuredClone(messages)
  const initial = catalog(messages)
  const narrowed = applyHistoryFinalResult(messages, { ...latest[1].finalResult, items: [latest[1].finalResult.items[0]] })
  const partial = catalog(narrowed)
  assert.deepEqual(partial.latestDelivery.items.map(item => item.id), ['keep'])
  assert.notEqual(partial.deliveryKey, initial.deliveryKey)
  assert.equal(partial.results.some(result => result.items.some(item => item.assetId === 'asset-withdraw')), false)
  const withdrawn = applyHistoryFinalResult(narrowed, { ...latest[1].finalResult, items: [] })
  const result = catalog(withdrawn)
  assert.equal(result.latestDelivery.runId, 'run-fallback')
  assert.equal(result.current.runId, 'run-latest')
  assert.equal(result.current.items.length, 0)
  assert.notEqual(result.deliveryKey, partial.deliveryKey)
  assert.deepEqual(messages, before)
  const allWithdrawn = applyHistoryFinalResult(withdrawn, { ...older[1].finalResult, items: [] })
  assert.equal(catalog(allWithdrawn).latestDelivery, undefined)
  assert.equal(catalog(allWithdrawn).deliveryKey, 'empty')
})
