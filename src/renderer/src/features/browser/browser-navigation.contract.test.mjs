import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(file, imports, browser) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports,window,crypto){${code}\n})`).runInThisContext()(name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`)
    return imports[name]
  }, exports, { aether: { browser } }, { randomUUID: () => 'reveal-id' })
  return exports
}
const scope = load('../../core/browser/scope.ts', {})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(initial = true) {
  let owner = { mode: 'work', sessionId: 'task-a', engineId: 'engine-a' }
  const tab = { tabId: 'page-a', title: 'A', url: 'https://example.com', presentation: owner }
  const creates = []
  let list = async () => initial ? [tab] : [], create = async () => ({ ...tab, tabId: 'page-b' })
  const api = load('./browser-store.ts', {
    react: { useSyncExternalStore: () => {} },
    '@shared/browser': { DEFAULT_BROWSER_SETTINGS: {} },
    '@renderer/core/toast': { toast: { error: () => {} } },
    '@renderer/core/browser/presentation': { getBrowserSurfaceOwner: () => owner, getBrowserPresentationScope: () => owner, onBrowserPresentationChanged: () => () => {} },
    '@renderer/core/browser/scope': scope
  }, {
    onEvent: () => () => {}, list: () => list(), getSettings: async () => ({}),
    create: input => { creates.push(input); return create() }
  })
  return { api, creates, tab, setList: fn => { list = fn }, setCreate: fn => { create = fn }, switchSession: () => { owner = { ...owner, sessionId: 'other' } } }
}

test('the browser command reveals an existing tab in its owning session resource pane', async () => {
  const fixture = createFixture()
  await fixture.api.openBrowser()
  assert.deepEqual(fixture.creates, [])
  assert.equal(fixture.api.getBrowserState().activeTabId, 'page-a')
  assert.deepEqual(fixture.api.getBrowserState().revealRequest, { tabId: 'page-a', requestId: 'ui:reveal-id' })
})
const createFixture = fixture

test('an embedded navigation can create a tab without requesting a foreground reveal', async () => {
  const fixture = createFixture(false)
  await fixture.api.openBrowser('https://example.org', { reveal: false })
  assert.deepEqual(fixture.creates, [{ url: 'https://example.org' }])
  assert.equal(fixture.api.getBrowserState().activeTabId, 'page-b')
  assert.equal(fixture.api.getBrowserState().revealRequest, null)
})

test('a tab created after the user changes sessions remains owned by its initiating session', async () => {
  const fixture = createFixture(), creation = deferred()
  fixture.setCreate(() => creation.promise)
  await fixture.api.initializeBrowser()
  const opening = fixture.api.openBrowser('https://example.org')
  await Promise.resolve()
  fixture.switchSession()
  creation.resolve({ ...fixture.tab, tabId: 'page-b' })
  await opening
  assert.deepEqual(fixture.api.getBrowserState().tabs, [])
  assert.equal(fixture.api.getBrowserState().revealRequest, null)
})

test('switching sessions while the initial tab inventory loads cancels the command', async () => {
  const fixture = createFixture(), listing = deferred()
  fixture.setList(() => listing.promise)
  const opening = fixture.api.openBrowser('https://example.org')
  fixture.switchSession()
  listing.resolve([fixture.tab])
  await opening
  assert.deepEqual(fixture.creates, [])
  assert.equal(fixture.api.getBrowserState().revealRequest, null)
})
