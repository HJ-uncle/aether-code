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
  new vm.Script(`(function(require,exports){${code}\n})`).runInThisContext()(name => imports[name] ?? {}, exports)
  return exports
}
const { gitFilePath } = load('../../core/git/git-target.ts', {})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture() {
  let source = 2, session = 'task-a', capture = async (_session, cwd) => ({ source, root: '/project', cwd, bindingEpoch: 'binding' })
  const stores = [], targets = []
  const api = load('./git-diff-navigation.ts', {
    '@renderer/core/engine/source': { getEngineSource: () => source, getEngineStorageKey: () => 'account-a' },
    '@renderer/core/git/git-target': {
      gitFilePath,
      captureSessionGitTarget: (...args) => capture(...args),
      assertGitTarget: target => { assert.equal(target.source, source); targets.push(target) }
    },
    '@renderer/core/git/session-git-store': { sessionGitStoreFor: (...args) => { stores.push(args); return { key: args.join(':') } } },
    '../sessions/state': { getSessionState: () => ({ activeTaskId: session, homeSessionId: null }) }
  })
  return { api, stores, targets, changeSource: () => source++, changeSession: value => { session = value }, setCapture: fn => { capture = fn } }
}

test('diff navigation retains the exact authenticated session repository and staged file', async () => {
  const fixture = fixtureFactory()
  let notifications = 0
  const unsubscribe = fixture.api.subscribeGitDiffRequests(() => notifications++)
  await fixture.api.openGitDiff('.', 'src\\app.ts', true)
  const request = fixture.api.getGitDiffRequest()
  assert.equal(request.path, 'src/app.ts')
  assert.equal(request.staged, true)
  assert.equal(request.sessionId, 'task-a')
  assert.equal(request.target, fixture.targets[0])
  assert.deepEqual(fixture.stores, [[2, 'task-a', '/project', '']])
  fixture.api.closeGitDiff(request.id + 1)
  assert.equal(fixture.api.getGitDiffRequest(), request)
  fixture.api.closeGitDiff(request.id)
  assert.equal(fixture.api.getGitDiffRequest(), null)
  assert.equal(notifications, 2)
  unsubscribe()
})
const fixtureFactory = fixture

test('a slower previous diff lookup cannot replace the newer user selection', async () => {
  const fixture = fixtureFactory(), first = deferred(), second = deferred()
  fixture.setCapture((_session, cwd) => cwd === 'first' ? first.promise : second.promise)
  const old = fixture.api.openGitDiff('first', 'old.ts'), latest = fixture.api.openGitDiff('second', 'new.ts')
  second.resolve({ source: 2, root: '/project', cwd: 'second' })
  await latest
  first.resolve({ source: 2, root: '/project', cwd: 'first' })
  await old
  assert.equal(fixture.api.getGitDiffRequest().path, 'new.ts')
  assert.deepEqual(fixture.stores, [[2, 'task-a', '/project', 'second']])
})

test('a pending diff is discarded when its owning session changes', async () => {
  const fixture = fixtureFactory(), lookup = deferred()
  fixture.setCapture(() => lookup.promise)
  const pending = fixture.api.openGitDiff('.', 'file.ts')
  fixture.changeSession('other')
  lookup.resolve({ source: 2, root: '/project', cwd: '.' })
  await pending
  assert.equal(fixture.api.getGitDiffRequest(), null)
  assert.deepEqual(fixture.stores, [])
})

test('a changed connection invalidates a pending target instead of using the global repository', async () => {
  const fixture = fixtureFactory(), lookup = deferred()
  fixture.setCapture(() => lookup.promise)
  const pending = fixture.api.openGitDiff('.', 'file.ts')
  fixture.changeSource()
  lookup.resolve({ source: 2, root: '/project', cwd: '.' })
  await assert.rejects(pending)
  assert.equal(fixture.api.getGitDiffRequest(), null)
  assert.deepEqual(fixture.stores, [])
})

test('invalid paths, missing sessions and rejected bindings never create a diff store', async () => {
  const fixture = fixtureFactory()
  for (const path of ['/etc/passwd', '../outside.ts', 'C:\\outside.ts']) await assert.rejects(fixture.api.openGitDiff('.', path))
  fixture.changeSession(null)
  await assert.rejects(fixture.api.openGitDiff('.', 'file.ts'), /所属会话/)
  fixture.changeSession('task-a')
  fixture.setCapture(async () => { throw new Error('not the session repository') })
  await assert.rejects(fixture.api.openGitDiff('/other', 'file.ts'), /session repository/)
  assert.deepEqual(fixture.stores, [])
})
