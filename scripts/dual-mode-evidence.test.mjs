import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { summarizeSnapshot, manifestWorkspace } from './dual-mode-evidence.mjs'

test('intent, failed browser effects and durable success stay distinct without retaining bodies', () => {
  const success = { toolCallId: 'a', toolName: 'browser_click', rootRunId: 'run', success: true, status: 'succeeded', output: 'private body' }
  const result = summarizeSnapshot({ sessionId: 'session', run: { runId: 'run' }, projection: [
    { toolStart: { toolCallId: 'a', toolName: 'browser_click', rootRunId: 'run', args: { password: 'secret' } } },
    { toolResult: success }, { toolEnd: success },
    { toolStart: { toolCallId: 'b', toolName: 'browser_fill', rootRunId: 'run' } },
    { toolResult: { toolCallId: 'c', toolName: 'browser_click', rootRunId: 'run', success: false, status: 'failed', metadata: { code: 'BROWSER_CLIENT_DISCONNECTED', operationPerformed: 'unknown' } } },
  ], history: [{ role: 'tool', toolCallId: 'a', toolName: 'browser_click', content: 'private body', metadata: { rootRunId: 'run', success: true, status: 'succeeded' } }] })
  assert.equal(result.browser.attempted, 3)
  assert.equal(result.browser.succeeded, 1)
  assert.equal(result.browser.durableSucceeded, 1)
  assert.equal(result.browser.failed, 1)
  assert.equal(result.browser.tools.find(item => item.id === 'c').operationPerformed, 'unknown')
  assert.doesNotMatch(JSON.stringify(result), /private body|password|secret/)
})

test('same provider call ID in two runs does not conflate their outcomes', () => {
  const result = summarizeSnapshot({ history: [
    { role: 'tool', toolCallId: 'same', toolName: 'browser_snapshot', metadata: { rootRunId: 'first', success: true, status: 'succeeded' } },
    { role: 'tool', toolCallId: 'same', toolName: 'browser_snapshot', metadata: { rootRunId: 'second', success: false, status: 'failed' } },
  ] })
  assert.equal(result.browser.tools.length, 2)
  assert.equal(result.browser.durableSucceeded, 1)
})

test('submitted requirement is verifiable by digest without retaining user text', () => {
  const content = 'Build an isolated game in the assigned directory.'
  const result = summarizeSnapshot({ history: [{ role: 'user', id: 'requirement', content, metadata: { rootRunId: 'root' } }] })
  assert.equal(result.userMessages[0].contentSha256, createHash('sha256').update(content).digest('hex'))
  assert.equal(result.userMessages[0].rootRunId, 'root')
  assert.equal(result.userMessages[0].contentBytes, Buffer.byteLength(content))
  assert.doesNotMatch(JSON.stringify(result), /Build an isolated/)
})

test('workspace digest detects a foreign write and excludes links, credential files and over-budget files', async () => {
  const parent = resolve('.e2e-tmp')
  await mkdir(parent, { recursive: true })
  const fixture = await mkdtemp(join(parent, 'dual-evidence-'))
  try {
    const workspace = join(fixture, 'game'), other = join(fixture, 'other')
    await mkdir(workspace); await mkdir(other)
    await writeFile(join(workspace, 'index.html'), '<h1>game</h1>')
    const first = await manifestWorkspace(workspace)
    assert.equal(first.partial, false)
    assert.equal(first.files.length, 1)
    await mkdir(join(workspace, '.ae'))
    await writeFile(join(workspace, '.ae', 'runtime.log'), 'engine-owned task state')
    const withRuntime = await manifestWorkspace(workspace)
    assert.equal(withRuntime.partial, false)
    assert.equal(withRuntime.digest, first.digest)
    assert.deepEqual(withRuntime.omitted, [{ path: '.ae', reason: 'engine-runtime-data' }])
    await writeFile(join(workspace, 'index.html'), '<h1>changed</h1>')
    const changed = await manifestWorkspace(workspace)
    assert.notEqual(first.digest, changed.digest)
    await writeFile(join(other, 'outside.txt'), 'must not be read')
    await symlink(other, join(workspace, 'outside'), 'junction')
    await writeFile(join(workspace, '.env'), 'SECRET=do-not-retain')
    await writeFile(join(workspace, 'large.bin'), Buffer.alloc(100))
    const bounded = await manifestWorkspace(workspace, { maxFileBytes: 30 })
    assert.equal(bounded.partial, true)
    assert.deepEqual(bounded.files.map(item => item.path), ['index.html'])
    assert.deepEqual(new Set(bounded.omitted.map(item => item.reason)), new Set(['engine-runtime-data', 'excluded', 'byte-budget', 'symbolic-link']))
  } finally {
    if (!fixture.startsWith(parent + '\\') && !fixture.startsWith(parent + '/')) throw new Error('Unsafe evidence fixture path')
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
