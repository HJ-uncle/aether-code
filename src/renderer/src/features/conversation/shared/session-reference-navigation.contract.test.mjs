import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(file, imports) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${code}\n})`).runInThisContext()(name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`)
    return imports[name]
  }, exports)
  return exports
}

function mentionFixture({ taskId = 'task-a', homeSessionId = 'home', text = '现有草稿', mentions = [] } = {}) {
  let source = 7, draft = { text, mentions }, writes = 0, flushes = 0
  const contexts = []
  const state = { activeTaskId: taskId, homeSessionId }
  const api = load('./pending-mentions.ts', {
    '@renderer/core/engine/source': { getEngineSource: () => source, getEngineStorageKey: () => 'account-a' },
    '../../sessions/state': {
      getSessionState: () => state,
      getSessionDraft: (storage, task) => { contexts.push([storage, task]); return draft },
      updateSessionDraft: (storage, task, nextText, nextMentions) => { contexts.push([storage, task]); draft = { text: nextText, mentions: nextMentions }; writes++ },
      flushSessionDrafts: storage => { assert.equal(storage, 'account-a'); flushes++ }
    },
    './mention-context': load('./mention-context.ts', { '@shared/toolkits': {} })
  })
  return { api, state, contexts, changeSource: () => source++, get draft() { return draft }, get writes() { return writes }, get flushes() { return flushes } }
}

test('external references persist directly in the current draft without a mounted composer', () => {
  const existing = { source: 'file', path: 'old.txt', displayText: '旧文件', textOffset: 0 }
  const fixture = mentionFixture({ text: '@old.txt 现有草稿', mentions: [existing] })
  const code = { source: 'code', path: 'src/app.ts', displayText: 'app.ts', startLine: 2, endLine: 4, content: 'unsaved snapshot' }
  const terminal = { source: 'terminal', path: 'terminal.txt', displayText: '终端输出' }
  fixture.api.pushPendingMentions([code, terminal], { sessionId: 'task-a', source: 7 })
  assert.equal(fixture.draft.text, '@old.txt 现有草稿 @src/app.ts:2-4 @terminal.txt ')
  assert.equal(fixture.draft.mentions[0], existing)
  assert.equal(fixture.draft.mentions[1].content, 'unsaved snapshot')
  for (const mention of fixture.draft.mentions.slice(1)) assert.equal(fixture.draft.text.slice(mention.textOffset).startsWith(`@${mention.path}`), true)
  assert.deepEqual(fixture.contexts, [['account-a', 'task-a'], ['account-a', 'task-a']])
  assert.equal(fixture.writes, 1)
  assert.equal(fixture.flushes, 1)
})

test('an asynchronous reference from a different session or engine cannot modify a draft', () => {
  const fixture = mentionFixture()
  const mention = { source: 'browser', path: 'page', displayText: '网页' }
  assert.throws(() => fixture.api.pushPendingMention(mention, { sessionId: 'other', source: 7 }), /会话或连接/)
  fixture.changeSource()
  assert.throws(() => fixture.api.pushPendingMention(mention, { sessionId: 'task-a', source: 7 }), /会话或连接/)
  assert.equal(fixture.writes, 0)
  assert.equal(fixture.flushes, 0)
  assert.equal(fixture.draft.text, '现有草稿')
})

test('references before the first send belong to the home draft and empty updates do nothing', () => {
  const fixture = mentionFixture({ taskId: null, homeSessionId: null, text: '' })
  fixture.api.pushPendingMentions([])
  assert.equal(fixture.writes, 0)
  fixture.api.pushPendingMention({ source: 'file', path: 'report.md', displayText: '报告' })
  assert.equal(fixture.draft.text, '@report.md ')
  assert.equal(fixture.draft.mentions[0].textOffset, 0)
  assert.deepEqual(fixture.contexts, [['account-a', null], ['account-a', null]])
})

function fileFixture() {
  let source = 1, currentSession = 'task-a', resolveFile = async () => ({ path: '/work/report.md', target: { sessionId: 'task-a' } })
  const opened = [], localReads = []
  const api = load('./open-file.ts', {
    '@renderer/core/engine/client': { getSnapshot: async () => ({ mode: 'remote' }) },
    '@renderer/core/engine/source': { getEngineSource: () => source, getEngineStorageKey: () => 'account-a', assertEngineSource: value => assert.equal(value, source), isRemoteEngine: () => true, isEngineReady: () => true },
    '@renderer/core/workspace/fs-client': { resolveSessionFilePath: (...args) => resolveFile(...args), paths: { contains: () => true }, workspaceRecoveryCandidates: () => [], readLocalRecoveryFile: path => localReads.push(path) },
    '../../workspace/resource-store': { openSessionFileResource: (...args) => opened.push(args), openExternalSessionPathResource: () => { throw Error('Remote path must not use local fallback') } },
    '../../sessions/state': { getSessionState: () => ({ activeTaskId: currentSession, homeSessionId: null, tasks: [{ id: 'task-a', workspacePath: '/work' }] }) }
  })
  return { api, opened, localReads, setResolve: fn => { resolveFile = fn }, changeSession: () => { currentSession = 'other' }, changeSource: () => source++ }
}

test('message file links open the authenticated target inside the session resource pane', async () => {
  const fixture = fileFixture()
  await fixture.api.openFileFromChat('report.md:12:3')
  assert.deepEqual(fixture.opened, [['/work/report.md', { sessionId: 'task-a' }]])
  assert.deepEqual(fixture.localReads, [])
})

test('file resolution cannot open into a replacement session or account', async () => {
  for (const change of ['changeSession', 'changeSource']) {
    const fixture = fileFixture()
    fixture.setResolve(async () => { fixture[change](); return { path: '/work/report.md', target: {} } })
    await assert.rejects(fixture.api.openFileFromChat('report.md'), /切换|变化/)
    assert.deepEqual(fixture.opened, [])
  }
})

test('artifact links cannot impersonate another message session', async () => {
  const fixture = fileFixture()
  await assert.rejects(fixture.api.openArtifactFromChat({ kind: 'artifact', sessionId: 'other', path: 'report.md' }, { sessionId: 'task-a' }), /不属于/)
  assert.deepEqual(fixture.opened, [])
})
