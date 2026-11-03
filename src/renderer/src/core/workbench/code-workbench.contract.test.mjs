import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the adapter with controlled editor/file boundaries. Real editor UI
// activation and Electron reads belong to the end-to-end suite.
const source = ts.transpileModule(readFileSync(new URL('./client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const target = { sessionId: 'chat', key: 'current-binding', root: 'D:\\project' }
  const state = { docs: new Map(), activePath: null }
  const identities = new Map(), listeners = new Set(), opens = [], activations = []
  let sequence = 0
  const publish = () => { for (const listener of listeners) listener() }
  const add = (path, extra = {}) => {
    const doc = { path, name: path.split(/[\\/]/).at(-1), content: 'saved', savedContent: 'saved', isBinary: false,
      loading: false, error: null, truncated: false, tooLarge: false, ...extra }
    state.docs.set(path, doc); identities.set(path, { instance: ++sequence }); return doc
  }
  const modules = {
    '../editor/editor-store': {
      documentKey: path => `doc:${path}`, getEditorState: () => state,
      getDocument: path => state.docs.get(path), getDocumentIdentity: path => identities.get(path),
      isDirty: doc => !doc.isBinary && doc.content !== doc.savedContent,
      isDocumentConnectionCurrent: doc => !doc.stale,
      onEditorChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      openFile: async (path, line, _column, _length, owner) => {
        opens.push({ path, line, owner })
        if (!state.docs.has(path)) add(path, { sessionFileTarget: owner })
      }
    },
    '../editor/editor-groups': {
      getEditorGroups: () => ({ focusedGroupId: 'right' }),
      activateGroupTab: (group, key) => { activations.push({ group, key }); state.activePath = key.slice(4); publish() }
    },
    '../workspace/fs-client': { captureSessionFileTarget: async () => target }
  }
  const exports = {}
  new vm.Script(`(function(require,exports){${source}\n})`).runInThisContext()(name => modules[name] ?? {}, exports)
  return { adapter: exports.codeWorkbenchAdapter('chat'), target, state, add, opens, activations, publish, listeners }
}

test('opens and activates an existing dirty Code buffer without changing its owner or contents', async () => {
  const f = fixture(), path = 'D:\\project\\main.ts'
  const doc = f.add(path, { content: 'unsaved user edit' })
  f.state.activePath = 'D:\\project\\other.ts'
  const result = await f.adapter.open(path, 12, () => true)
  assert.equal(f.opens[0].owner, undefined)
  assert.equal(f.opens[0].line, 12)
  assert.equal(f.state.docs.get(path), doc)
  assert.equal(doc.content, 'unsaved user edit')
  assert.deepEqual(f.activations, [{ group: 'right', key: `doc:${path}` }])
  assert.equal(f.state.activePath, path)
  assert.equal(result.opened, true)
  assert.equal(result.dirty, true)
  assert.equal(result.contentSource, 'editor-buffer')
})

test('new files retain the session owner and are activated before the success receipt', async () => {
  const f = fixture(), path = 'D:\\project\\new.ts'
  const result = await f.adapter.open(path, undefined, () => true)
  assert.equal(f.opens[0].owner, f.target)
  assert.equal(f.state.activePath, path)
  assert.equal(result.readStatus, 'ready')
  assert.equal(result.visualVerification, false)
})

test('a loading existing buffer cannot produce an early ready receipt', async () => {
  const f = fixture(), path = 'D:\\project\\loading.ts'
  f.add(path, { loading: true })
  let settled = false
  const opening = f.adapter.open(path, undefined, () => true).then(result => { settled = true; return result })
  await tick()
  assert.equal(settled, false)
  assert.equal(f.activations.length, 0)
  f.state.docs.set(path, { ...f.state.docs.get(path), loading: false }); f.publish()
  assert.equal((await opening).readStatus, 'ready')
  assert.equal(f.listeners.size, 0)
})

test('context omits other roots, sessions, stale connections and old binding generations', async () => {
  const f = fixture()
  f.add('D:\\project\\visible.ts')
  f.add('D:\\PROJECT\\owned.ts', { sessionFileTarget: f.target })
  f.add('D:\\project-other\\private.ts')
  f.add('D:\\project\\other-session.ts', { sessionFileTarget: { ...f.target, sessionId: 'other', key: 'other-key' } })
  f.add('D:\\project\\old-binding.ts', { sessionFileTarget: { ...f.target, key: 'old-binding' } })
  f.add('D:\\project\\stale.ts', { stale: true })
  f.state.activePath = 'D:\\project-other\\private.ts'
  const result = await f.adapter.context()
  assert.deepEqual(result.files.map(file => file.path), ['D:\\project\\visible.ts', 'D:\\PROJECT\\owned.ts'])
  assert.equal(result.activePath, null)
})

test('foreign ownership and outside paths cannot be opened or rebound', async () => {
  const f = fixture(), path = 'D:\\project\\foreign.ts'
  f.add(path, { sessionFileTarget: { ...f.target, key: 'other-session' } })
  await assert.rejects(f.adapter.open(path, undefined, () => true), /其他工作区会话/)
  await assert.rejects(f.adapter.open('D:\\project-other\\file.ts', undefined, () => true), /不属于/)
  await assert.rejects(f.adapter.open('D:\\project\\..\\private.ts', undefined, () => true), /不属于/)
  assert.equal(f.opens.length, 0)
  assert.equal(f.activations.length, 0)
})

test('a closed and reopened loading document does not inherit the old open receipt', async () => {
  const f = fixture(), path = 'D:\\project\\loading.ts'
  f.add(path, { loading: true })
  const opening = f.adapter.open(path, undefined, () => true)
  await tick()
  const rejected = assert.rejects(opening, /关闭或重新打开/)
  f.add(path); f.publish()
  await rejected
  assert.equal(f.activations.length, 0)
  assert.equal(f.listeners.size, 0)
})
