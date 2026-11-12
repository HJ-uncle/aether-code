import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the real component handlers with inert hooks and a plain JSX tree.
// No DOM, Electron, model, upload, or connection is created by these tests.
const directory = dirname(fileURLToPath(import.meta.url))
const react = {
  forwardRef: render => props => render(props, null),
  useRef: value => ({ current: value }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useMemo: compute => compute(),
  useEffect: () => {}
}
const jsx = (type, props) => ({ type, props })
function load(file, imports = {}) {
  const code = ts.transpileModule(readFileSync(resolve(directory, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${code}\n})`).runInThisContext()(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    return imports[name] ?? {}
  }, exports)
  return exports
}
const composer = load('InputComposer.tsx')
function nodes(value, found = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found
  seen.add(value)
  if ('type' in value && 'props' in value) found.push(value)
  for (const child of Object.values(value)) nodes(child, found, seen)
  return found
}
const settle = () => new Promise(done => setImmediate(done))

test('sending and stopping remain distinct actions and busy buttons cannot dispatch again', () => {
  let sends = 0, stops = 0
  const send = composer.ComposerSend({ label: '排到下一轮', disabled: false, onClick: () => sends++ })
  const stop = composer.ComposerStop({ disabled: false, onClick: () => stops++ })
  send.props.onClick()
  assert.equal(sends, 1)
  assert.equal(stops, 0)
  stop.props.onClick()
  assert.equal(stops, 1)
  assert.equal(send.props['aria-label'], '排到下一轮')
  assert.equal(send.props.title, '排到下一轮（Enter）')
  assert.equal(stop.props.title, '停止生成')
  for (const button of [
    composer.ComposerSend({ loading: true, loadingLabel: '正在加入下一轮…', disabled: false, onClick: () => sends++ }),
    composer.ComposerStop({ loading: true, disabled: false, onClick: () => stops++ })
  ]) {
    assert.equal(button.props.disabled, true)
    assert.equal(button.props['aria-busy'], true)
    assert.equal(button.props.title.includes('Enter'), false)
    button.props.onClick()
  }
  assert.equal(sends, 1)
  assert.equal(stops, 1)
})

test('the shared input always has an accessible name and preserves a contextual label', () => {
  assert.equal(composer.ComposerInput({ value: '' }).props.ariaLabel, '消息')
  assert.equal(composer.ComposerInput({ value: '', ariaLabel: undefined }).props.ariaLabel, '消息')
  assert.equal(composer.ComposerInput({ value: '', ariaLabel: '任务目标' }).props.ariaLabel, '任务目标')
  assert.equal(composer.ComposerInput({ value: '', ariaLabel: '' }).props.ariaLabel, '')
})

function sessionFixture(overrides = {}, upload) {
  const uploads = [], notices = []
  const controller = {
    activeTask: { id: 'task-a', status: 'running' },
    draftSource: 'test-source', messages: [], models: [], pending: [], attachments: [],
    resources: { skills: [], mcpServers: [], knowledgeBases: [] },
    streaming: true, uploading: false, loading: false, historyReady: true, ready: true,
    pendingInitialStart: false, nextTurnQueue: { pendingCount: 0, ready: true, saving: false, state: { entries: [] } },
    agentLocked: true, workspaceLocked: true,
    attachmentsForMentions: () => [],
    addFiles: async files => { uploads.push(files); await upload?.() },
    ...overrides
  }
  const { Composer } = load('../../composer/Composer.tsx', {
    '@renderer/features/conversation/shared/InputComposer': composer,
    '@renderer/features/conversation/shared/context-presentation': { contextPresentation: () => ({ primary: null }), contextPresentationLimit: () => 0 },
    '@renderer/core/engine/source': { getEngineSource: () => 1, isRemoteEngine: () => false },
    '../conversation/ReferenceNavigation': { useSessionReferenceNavigation: () => null },
    '../conversation/shared/image-conversation': { useImageConversation: () => null },
    '../conversation/shared/resource-mentions': { hasNonResourceContent: () => true },
    '../conversation/shared/attachment-references': { attachmentReferences: () => [] },
    './attachments': { mergeSessionAttachments: () => [] },
    '../workspace/resource-selection': { sessionResourceSelection: () => [], sessionResourceFollowupChanges: () => false },
    '@renderer/features/conversation/shared/root-followup': { rootFollowupRun: () => null, rootFollowupLimitation: () => '' },
    '@renderer/features/conversation/shared/RootFollowup': { useRootFollowup: () => ({ delivery: 'next', busy: false, pending: null }) },
    '../conversation/shared/useResourceMentions': { useResourceMentions: () => {} },
    '@renderer/core/toast': { toast: { info: message => notices.push(message) } },
    '../sessions/state': { useSessionDraft: () => ({ text: '补充要求', mentions: [] }) }
  })
  const tree = nodes(Composer({ controller }))
  return {
    uploads, notices, tree,
    button: tree.find(node => node.props['aria-label'] === '添加资料'),
    paste: tree.find(node => node.type === composer.ComposerInput).props.onPasteFiles,
    drop: files => tree.find(node => node.type === composer.InputComposer).props.onDrop({ dataTransfer: { files }, preventDefault() {} }),
    pick: files => tree.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files, value: 'chosen' } })
  }
}

test('a running Work task accepts next-turn attachments through picker, paste and drop', async () => {
  const files = [{ name: 'sample.txt', size: 12 }]
  for (const route of ['pick', 'paste', 'drop']) {
    const fixture = sessionFixture()
    assert.equal(fixture.button.props.disabled, false)
    fixture[route](files)
    await settle()
    assert.equal(fixture.uploads.length, 1)
    assert.deepEqual(fixture.uploads[0], files)
  }
})

test('all attachment routes respect connection, upload, history and queue readiness', async () => {
  for (const overrides of [
    { ready: false }, { uploading: true }, { historyReady: false }, { loading: true }, { pendingInitialStart: true },
    { nextTurnQueue: { pendingCount: 0, saving: true, ready: true } },
    { nextTurnQueue: { pendingCount: 0, saving: false, ready: false } }
  ]) {
    const fixture = sessionFixture(overrides)
    assert.equal(fixture.button.props.disabled, true)
    for (const route of ['pick', 'paste', 'drop']) fixture[route]([{ name: 'sample.txt', size: 12 }])
    await settle()
    assert.equal(fixture.uploads.length, 0)
    assert.equal(fixture.notices.length, 3)
  }
})

test('an upload in flight blocks a same-frame second route before controller state updates', async () => {
  let finish
  const pending = new Promise(done => { finish = done })
  const fixture = sessionFixture({}, () => pending)
  fixture.paste([{ name: 'first.txt', size: 12 }])
  fixture.drop([{ name: 'second.txt', size: 12 }])
  assert.equal(fixture.uploads.length, 1)
  assert.deepEqual(fixture.notices, ['资料正在添加，请稍候。'])
  finish()
  await settle()
  fixture.drop([{ name: 'second.txt', size: 12 }])
  assert.equal(fixture.uploads.length, 2)
})
