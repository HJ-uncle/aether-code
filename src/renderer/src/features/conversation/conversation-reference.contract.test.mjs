import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise real history replay, root ownership, final presentation and paging.
// Only transport, local task lookup and the OS clipboard are replaced.
const directory = dirname(fileURLToPath(import.meta.url))
const renderer = resolve(directory, '../..')
const shared = resolve(directory, '../../../../shared')
const sessionId = 'reference-source'
const url = `aether://conversation/${sessionId}?mode=work&source=`

function turn(index, { answer = `ANSWER_${index}`, request = `REQUEST_${index}`, status = 'succeeded', progress = false, manifest = false } = {}) {
  const userId = `user-${index}`, assistantId = `assistant-${index}`, runId = `run-${index}`, turnId = `turn-${index}`
  const metadata = { runId, turnId }
  const rows = [{ id: userId, role: 'user', content: request, conversationId: turnId, metadata }]
  if (progress) rows.push({ id: `progress-${index}`, role: 'assistant', content: 'PROGRESS_ONLY', reasoningContent: 'PRIVATE_REASONING',
    conversationId: turnId, metadata, toolCall: { id: `tool-${index}`, name: 'read_file', args: { path: 'PRIVATE_PATH' } } },
  { id: `receipt-${index}`, role: 'tool', content: 'PRIVATE_TOOL_RESULT', toolCallId: `tool-${index}` })
  rows.push({ id: assistantId, role: 'assistant', content: manifest ? 'UNPUBLISHED_TAIL' : answer, conversationId: turnId,
    metadata: { ...metadata, ...(manifest ? { finalResult: { schemaVersion: 1, sessionId, turnId, runId, assistantMessageId: assistantId,
      text: answer, items: [], publishedAt: 12 } } : {}) } })
  return { index: { userMessageId: userId, conversationId: turnId, preview: request }, rows,
    run: { schemaVersion: 1, sessionId, turnId, runId, userMessageId: userId, assistantMessageId: assistantId,
      status, version: 1, seq: index, pending: [], createdAt: 1, updatedAt: 2, finishedAt: 2 } }
}

function fixture(turns, options = {}) {
  let epoch = 1, source = '', settled, snapshotSeen = false
  const requests = [], writes = [], notices = [], cache = new Map()
  const task = { id: sessionId, title: '原会话', workspacePath: 'D:/project' }
  const mocks = {
    '@renderer/core/engine/source': {
      getEngineSource: () => epoch, getEngineStorageKey: () => source,
      assertEngineSource: expected => { if (epoch !== expected) throw new Error('连接已切换') }
    },
    '@renderer/core/engine/client': { request: async input => {
      requests.push(input)
      options.onRequest?.(input, { switchSource() { epoch++; source = ':account:other' } })
      if (input.path === '/chat/snapshot') { snapshotSeen = true; return { ok: true, data: {
        schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true,
        history: turns.flatMap(item => item.rows), projection: [], runs: turns.map(item => item.run), todos: [], changes: [],
        ...(options.executionRun ? { executionRun: options.executionRun } : {})
      } } }
      assert.equal(input.path, '/conversation/display')
      if (options.legacy) return { ok: false, code: 404 }
      const anchor = input.query.anchorMessageId
      const start = anchor ? turns.findIndex(item => item.index.userMessageId === anchor) : Math.max(0, turns.length - 10)
      const selected = turns.slice(start, start + 10)
      return { ok: true, data: { schemaVersion: 1, grouping: 'root', turns: turns.map(item => item.index),
        messages: selected.flatMap(item => item.rows), loadedTurnIds: selected.map(item => item.index.userMessageId),
        revision: anchor && options.mutatePage || snapshotSeen && options.mutateAfterSnapshot ? 'changed' : 'stable', mutationRevision: 'epoch-1', backend: 'jsonl',
        completeness: options.compacted ? 'sqlite_compacted' : 'complete' } }
    } },
    '@renderer/core/toast': { toast: {
      success: message => { notices.push({ kind: 'success', message }); settled?.({ kind: 'success', message }) },
      error: message => { notices.push({ kind: 'error', message }); settled?.({ kind: 'error', message }) }
    } },
    '@renderer/core/workspace/workspace-store': { getWorkspaceState: () => ({ rootPath: 'D:/project' }) }
  }
  function load(path) {
    if (cache.has(path)) return cache.get(path)
    const exports = {}
    cache.set(path, exports)
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(name => {
      if (mocks[name]) return mocks[name]
      if (name === '../sessions/state') return { getSessionState: () => ({ tasks: [task] }) }
      const base = name.startsWith('@renderer/') ? resolve(renderer, name.slice('@renderer/'.length))
        : name.startsWith('@shared/') ? resolve(shared, name.slice('@shared/'.length))
          : name.startsWith('.') ? resolve(dirname(path), name) : undefined
      if (!base) throw new Error(`Unexpected dependency ${name} in ${path}`)
      const target = ['.ts', '.tsx', ''].map(ext => base + ext).find(existsSync)
      if (!target) throw new Error(`Module not found: ${base}`)
      return load(target)
    }, exports)
    return exports
  }
  const helper = load(resolve(directory, './conversation-reference.ts'))
  return { helper, requests, writes, notices, task,
    copy(id) {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { writes.push(text) } } } })
      const result = new Promise(resolve => { settled = resolve })
      helper.sessionTaskCopyMenu(task).children.find(item => item.id === id).onSelect()
      return result.finally(() => {
        if (original) Object.defineProperty(globalThis, 'navigator', original)
        else delete globalThis.navigator
      })
    }
  }
}

test('references replay root runs and carry only requests and published final prose', async () => {
  const value = fixture([turn(0, { progress: true, manifest: true, answer: '<think>HIDDEN_THINKING</think>FINAL_ONLY' })])
  const result = await value.helper.resolveConversationReference(url)
  assert.equal(result.mention.source, 'conversation')
  assert.equal(result.mention.path, url)
  assert.equal(result.mention.displayText, '原会话')
  assert.match(result.mention.content, /用户：REQUEST_0/)
  assert.match(result.mention.content, /助手：FINAL_ONLY/)
  for (const hidden of ['PRIVATE_REASONING', 'PRIVATE_PATH', 'PRIVATE_TOOL_RESULT', 'PROGRESS_ONLY', 'UNPUBLISHED_TAIL', 'HIDDEN_THINKING'])
    assert.equal(result.mention.content.includes(hidden), false, hidden)
  assert.deepEqual(value.requests.map(request => request.path), ['/conversation/display', '/chat/snapshot', '/conversation/display'])
})

test('failed or still-running roots cannot promote a stale final manifest into a quoted answer', async () => {
  for (const status of ['running', 'failed', 'cancelled', 'interrupted']) {
    const source = turn(0, { manifest: true, answer: 'STALE_RESULT' })
    const value = fixture([source], { executionRun: { ...source.run, status, version: 2 } })
    const result = await value.helper.resolveConversationReference(url)
    assert.equal(result.mention.content.includes('STALE_RESULT'), false, status)
    assert.match(result.mention.content, /暂无可引用的最终回复/)
  }
})

test('long references retain the newest answer and explicitly disclose the omitted earlier context', async () => {
  const value = fixture([turn(0, { request: 'OLDEST_HEAD' + '旧'.repeat(65_000) }), turn(1, { answer: 'LATEST_FINAL' })])
  const result = await value.helper.resolveConversationReference(url)
  assert.equal(result.mention.content.includes('OLDEST_HEAD'), false)
  assert.match(result.mention.content, /助手：LATEST_FINAL/)
  assert.match(result.mention.content, /省略/)
  assert.equal(result.mention.content.length < 61_000, true)
})

test('legacy snapshot fallback is explicitly limited and still respects final-answer ownership', async () => {
  const value = fixture([turn(0, { answer: 'LEGACY_FINAL' })], { legacy: true })
  const result = await value.helper.resolveConversationReference(url)
  assert.match(result.notice, /旧版引擎.*可能不包含完整历史/)
  assert.match(result.mention.content, /助手：LEGACY_FINAL/)
})

test('full Markdown includes every turn once and does not count overlapping pages twice', { timeout: 5000 }, async () => {
  // Eleven 130k turns are under 2M, but counting two overlapping 10-turn pages is over.
  const value = fixture(Array.from({ length: 11 }, (_, index) => turn(index, { answer: `UNIQUE_${index}_END\n` + '文'.repeat(130_000) })))
  const result = await value.copy('copy-markdown')
  assert.equal(result.kind, 'success', result.message)
  assert.equal(value.writes.length, 1)
  assert.equal(value.writes[0].length < 2_000_000, true)
  for (let index = 0; index < 11; index++) assert.equal(value.writes[0].split(`UNIQUE_${index}_END`).length - 1, 1)
  assert.deepEqual(value.requests.map(request => request.query.anchorMessageId), [undefined, 'user-0'])
})

test('Markdown refuses an unstable or compacted history instead of copying a partial transcript', { timeout: 5000 }, async () => {
  for (const options of [{ mutatePage: true }, { compacted: true }]) {
    const value = fixture(Array.from({ length: 11 }, (_, index) => turn(index)), options)
    const result = await value.copy('copy-markdown')
    assert.equal(result.kind, 'error')
    assert.equal(value.writes.length, 0)
  }
})

test('source changes during a history request cannot create a reference in the new account', async () => {
  const value = fixture([turn(0)], { onRequest(_input, controls) { controls.switchSource() } })
  await assert.rejects(value.helper.resolveConversationReference(url), /连接已切换/)
  assert.equal(value.requests.length, 1)
})

test('a run completing between display and snapshot cannot turn the earlier progress into a final answer', async () => {
  const source = turn(0, { status: 'running', answer: 'EARLIER_PROGRESS_ONLY' })
  const value = fixture([source], { mutateAfterSnapshot: true, onRequest(input) {
    if (input.path !== '/chat/snapshot') return
    source.run.status = 'succeeded'
    source.run.version = 2
    source.rows[1] = { ...source.rows[1], content: 'LATEST_COMPLETE_FINAL' }
  } })
  await assert.rejects(value.helper.resolveConversationReference(url), /变化.*重新粘贴/)
  assert.deepEqual(value.requests.map(request => request.path), ['/conversation/display', '/chat/snapshot', '/conversation/display'])
})
