import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

function fixture() {
  const handlers = new Map(), sends = [], windowEvents = new Map(), webEvents = new Map(), cache = new Map()
  let trusted = true, destroyed = false, location = 'file:///app/index.html'
  const owner = { isDestroyed: () => destroyed, on: (event, callback) => windowEvents.set(event, callback), webContents: {
    isDestroyed: () => destroyed, getURL: () => location, send: (...args) => sends.push(args), on: (event, callback) => webEvents.set(event, callback)
  } }
  const dependencies = {
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
    './ipc-security': { assertTrustedRenderer: () => { if (!trusted) throw new Error('Untrusted sender'); return owner }, workbenchEntryUrl: () => 'file:///app/index.html' },
    '../shared/workbench-url': { isTrustedWorkbenchUrl: (url, expected) => url === expected }
  }
  function load(url) {
    const path = fileURLToPath(url)
    if (cache.has(path)) return cache.get(path)
    const exports = {}; cache.set(path, exports)
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    vm.runInNewContext('(function(exports, require) {' + code + '\n})', { URL })(exports, id => {
      if (id in dependencies) return dependencies[id]
      if (id.startsWith('.')) return load(new URL(id + '.ts', url))
      throw new Error(`Unexpected dependency ${id}`)
    })
    return exports
  }
  const api = load(new URL('./conversation-link.ts', import.meta.url))
  api.registerConversationLinkIpc()
  return { api, owner, sends, webEvents, windowEvents, take: () => handlers.get('conversation-links:take')({}),
    setTrusted: value => { trusted = value }, setLocation: value => { location = value }, destroy: () => { destroyed = true } }
}
const link = (id, source = '') => `aether://conversation/${id}?mode=work&source=${encodeURIComponent(source)}`
const plain = value => JSON.parse(JSON.stringify(value))

test('cold-start arguments remain pending until a trusted renderer subscribes and drains', () => {
  const f = fixture()
  f.api.queueConversationLinkArguments(['electron.exe', 'out/main.js', '--new-instance', link('work-1')])
  assert.equal(f.sends.length, 0)
  f.api.bindConversationLinkWindow(f.owner); f.webEvents.get('did-finish-load')()
  assert.deepEqual(f.sends, [['conversation-links:available']])
  assert.deepEqual(plain(f.take()), [{ sessionId: 'work-1', mode: 'work', source: '' }])
  assert.deepEqual(plain(f.take()), [])
})

test('untrusted frames cannot drain or receive ownership requests', () => {
  const f = fixture()
  f.api.bindConversationLinkWindow(f.owner)
  f.setLocation('https://untrusted.test')
  f.api.queueConversationLink(link('work-remote', 'remote:https://example.com:account:user'))
  assert.equal(f.sends.length, 0)
  f.setTrusted(false)
  assert.throws(() => f.take(), /Untrusted sender/)
  f.setTrusted(true)
  assert.equal(f.take().length, 1)
})

test('bounded inbox ignores malformed links, coalesces duplicate pending requests and retains newest', () => {
  const f = fixture()
  assert.equal(f.api.queueConversationLink('aether://conversation/x?mode=work'), false)
  for (let index = 0; index < 40; index++) f.api.queueConversationLink(link(`work-${index}`))
  f.api.queueConversationLink(link('work-39'))
  const pending = f.take()
  assert.equal(pending.length, 32)
  assert.equal(pending[0].sessionId, 'work-8')
  assert.equal(pending.at(-1).sessionId, 'work-39')
  f.api.bindConversationLinkWindow(f.owner); f.destroy(); f.windowEvents.get('closed')()
  f.api.queueConversationLink(link('work-after-close'))
  assert.equal(f.sends.length, 0)
  assert.equal(f.take()[0].sessionId, 'work-after-close')
})
