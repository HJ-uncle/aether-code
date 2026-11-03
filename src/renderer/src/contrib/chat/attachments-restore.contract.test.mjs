import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
const javascript = ts.transpileModule(readFileSync(join(directory, 'useAttachments.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const settle = () => new Promise(done => setImmediate(done))
const file = (path, remoteUploadId) => ({ path, remoteUploadId, name: path, type: 'text/plain', size: 10 })

/** State/effect harness for the real hook. Transport is forbidden: restore
 * must reuse completed upload descriptors without re-reading or re-uploading. */
function fixture() {
  const hooks = [], listeners = new Set()
  let index = 0, effects = [], source = 1, root = 'D:/project-a', session = 'session-a'
  const same = (a, b) => a?.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useRef(value) {
      const slot = index++
      hooks[slot] ??= { current: value }
      return hooks[slot]
    },
    useState(value) {
      const slot = index++
      if (!hooks[slot]) {
        const state = { value: typeof value === 'function' ? value() : value }
        state.set = next => { state.value = typeof next === 'function' ? next(state.value) : next }
        hooks[slot] = state
      }
      return [hooks[slot].value, hooks[slot].set]
    },
    useCallback(callback, deps) {
      const slot = index++
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { deps, callback }
      return hooks[slot].callback
    },
    useEffect(effect, deps) {
      const slot = index++
      if (same(hooks[slot]?.deps, deps)) return
      const previous = hooks[slot]
      const next = { deps }
      hooks[slot] = next
      effects.push(() => { previous?.cleanup?.(); next.cleanup = effect() })
    }
  }
  const exports = {}
  const forbidden = () => { throw new Error('restore must not use file or upload transport') }
  const imports = {
    react,
    '@renderer/core/engine/source': {
      getEngineSource: () => source, isRemoteEngine: () => false,
      subscribeEngineSource: listener => { listeners.add(listener); return () => listeners.delete(listener) }
    },
    '@renderer/core/ipc-error': { ipcErrorMessage: String },
    '@renderer/core/workspace/fs-client': { copyIntoWorkspace: forbidden },
    '@renderer/core/engine/client': { uploadAttachment: forbidden, cancelAttachmentUpload: forbidden }
  }
  new vm.Script(`(function(require,exports){${javascript}\n})`).runInThisContext()(name => {
    if (!(name in imports)) throw new Error(`Unexpected hook dependency: ${name}`)
    return imports[name]
  }, exports)
  return {
    render(nextRoot = root, nextSession = session, commit = true) {
      root = nextRoot; session = nextSession; index = 0; effects = []
      const result = exports.useAttachments(root, session)
      if (commit) { const pending = effects; effects = []; pending.forEach(effect => effect()) }
      return result
    },
    changeSource() { source++; for (const listener of listeners) listener() },
    unmount() { for (const hook of hooks) hook.cleanup?.() }
  }
}

test('rejection restores completed objects after clear and merges newer attachments without transport', async () => {
  const hook = fixture()
  hook.render(); await settle()
  let view = hook.render()
  const sent = file('sent.txt', 'upload-sent'), another = file('another.txt'), newer = file('newer.txt', 'upload-newer')
  view.restore([sent, another])
  view = hook.render()
  const capturedRestore = view.restore
  view.clear()
  hook.render().restore([newer])
  capturedRestore([sent, another, sent, file('same-upload-different-path.txt', 'upload-newer'), file('newer.txt', 'different-upload')])
  const result = hook.render().attachments
  assert.deepEqual(result, [newer, sent, another])
  assert.equal(result[0], newer)
  assert.equal(result[1], sent)
  capturedRestore([sent, another])
  assert.equal(hook.render().attachments, result)
  hook.unmount()
})

test('old callbacks cannot restore after session or root changes, including navigation back', async () => {
  for (const boundary of ['session', 'root']) {
    const hook = fixture()
    hook.render(); await settle()
    const restore = hook.render().restore
    if (boundary === 'session') hook.render('D:/project-a', 'session-b')
    else hook.render('D:/project-b', 'session-a')
    restore([file('old.txt')])
    await settle()
    assert.deepEqual(hook.render().attachments, [])
    hook.render('D:/project-a', 'session-a')
    await settle()
    restore([file('old.txt')])
    assert.deepEqual(hook.render().attachments, [])
    hook.render().restore([file('current.txt')])
    assert.equal(hook.render().attachments[0].path, 'current.txt')
    hook.unmount()
  }
})

test('source changes and unmount invalidate a captured restore before any rerender', async () => {
  const hook = fixture()
  hook.render(); await settle()
  const restore = hook.render().restore
  hook.changeSource()
  restore([file('old-source.txt')])
  assert.deepEqual(hook.render().attachments, [])
  const currentRestore = hook.render().restore
  hook.unmount()
  currentRestore([file('unmounted.txt')])
  // Reading the hook snapshot without committing effects cannot reactivate
  // the unmounted scope; it only exposes whether a stale setter mutated it.
  assert.deepEqual(hook.render(undefined, undefined, false).attachments, [])
})
