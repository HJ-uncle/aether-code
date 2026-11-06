import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real React DOM/effects in jsdom; child panels and the menu shell are inert ports.
// No Electron, HTTP listener, provider, browser process or user workspace is opened.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), boundary = join(root, '.e2e-tmp')
mkdirSync(boundary, { recursive: true })
const folder = mkdtempSync(join(boundary, 'session-tray-contract-')), bundle = join(folder, 'tray.cjs')
const require = createRequire(import.meta.url)
const { JSDOM } = createRequire(join(root, '../ai-agent-engine/package.json'))('jsdom')
await build({ entryPoints: [join(root, 'src/renderer/src/contrib/chat/SessionTray.tsx')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], plugins: [{ name: 'component-ports', setup(build) {
  build.onResolve({ filter: /^(?:@renderer\/core\/workspace\/fs-client|@renderer\/workbench\/(?:icons|ActionMenu|ConfirmDialog)|\.\/(?:ChangesPanel|TodoTray)|.*\.css)$/ }, args => ({ path: args.path, namespace: 'component-ports' }))
  build.onLoad({ filter: /.*/, namespace: 'component-ports' }, ({ path }) => {
    if (path.endsWith('ActionMenu')) return { loader: 'js', contents: `import {createElement as h,useState} from 'react'; export function ActionMenu({items,label,disabled}){const [open,setOpen]=useState(false);return h('div',null,h('button',{'aria-label':label,disabled,onClick:()=>setOpen(!open)},'更多'),open?items.map(item=>h('button',{key:item.id,disabled:item.disabled,onClick:()=>{setOpen(false);void item.onSelect()}},item.label)):null)}` }
    if (path.endsWith('icons')) return { contents: 'export const Icon=()=>null;' }
    if (path.endsWith('ConfirmDialog')) return { contents: 'export const confirmDialog=async()=>true;' }
    if (path.endsWith('fs-client')) return { contents: "export const readFile=async()=>{throw new Error('file reads are not part of this contract')};" }
    if (path.endsWith('ChangesPanel')) return { contents: 'export const ChangesPanel=()=>null;' }
    if (path.endsWith('TodoTray')) return { contents: 'export const TodoTray=()=>null;' }
    return { contents: '' }
  })
} }] })
const { SessionTray } = require(bundle), { act, createElement } = require('react')
let dom, mounted, props, originalGlobals
const item = (id, phase = 'pending') => ({ id, phase, text: `private authored text ${id}`, attachments: [] })
const base = () => ({ sessionId: 'A', streaming: true, todos: [], queue: [item('a')], workspaceRoot: null,
  queueState: { ready: true, saving: false, paused: false, unknown: false, error: null },
  onUpdateQueued: async () => {}, onMoveQueued: async () => {}, onRemoveQueued: async () => {}, onClearQueue: async () => {},
  onMergeQueue: async () => {}, onPauseQueue: async () => {}, onReconcileQueue: async () => {}, onMergePending: async () => {} })
async function mount(patch = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://fixture.invalid', pretendToBeVisual: true })
  originalGlobals = new Map()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const { createRoot } = require('react-dom/client')
  mounted = createRoot(document.getElementById('root')); props = { ...base(), ...patch }
  await render()
}
async function render(patch = {}) { props = { ...props, ...patch }; await act(async () => { mounted.render(createElement(SessionTray, props)) }) }
const button = name => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === name || node.textContent.trim() === name)
async function click(name) { const found = button(name); assert.ok(found, `missing button: ${name}`); await act(async () => found.click()) }
async function type(value) { const field = document.querySelector('textarea'); assert.ok(field); await act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}) }
afterEach(async () => {
  if (mounted) await act(async () => mounted.unmount())
  dom?.window.close(); mounted = null; dom = null
  for (const [name, descriptor] of originalGlobals ?? []) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
})
after(() => { if (dirname(folder) !== boundary || !basename(folder).startsWith('session-tray-contract-')) throw new Error('fixture boundary'); rmSync(folder, { recursive: true, force: true }) })

test('queue stays collapsed and compact; only pending rows expose edits and drag handles', async () => {
  await mount({ queue: [item('accepted', 'accepted'), item('pending'), item('unknown', 'admission-unknown'), item('dispatch', 'dispatching')], queueState: { ...base().queueState, unknown: true } })
  assert.equal(document.querySelector('.session-tray__queue'), null)
  assert.equal(document.querySelector('.session-tray__summary').textContent, '提交结果待核对')
  assert.equal(document.querySelector('.session-tray__summary').textContent.includes('private'), false)
  await click('展开托盘')
  const rows = [...document.querySelectorAll('.session-tray__queue-item')]
  assert.deepEqual(rows.map(row => row.draggable), [false, true, false, false])
  assert.deepEqual(rows.map(row => row.querySelector('.session-tray__queue-attach').textContent), ['已接纳', '待发', '待核对', '提交中'])
  assert.equal(document.querySelectorAll('[aria-label^="编辑第"]').length, 1)
  assert.equal(document.querySelectorAll('[aria-label^="移除第"]').length, 1)
})

test('failed asynchronous edit retains authored text; success closes only after durable completion', async () => {
  const saves = []; await mount({ onUpdateQueued: async (...args) => { saves.push(args); throw new Error('磁盘暂时不可写') } })
  await click('展开托盘'); await click('编辑第 1 条排队消息'); await type('retained user revision'); await click('保存')
  assert.equal(document.querySelector('textarea').value, 'retained user revision')
  assert.match(document.querySelector('[role="alert"]').textContent, /磁盘暂时不可写/)
  assert.deepEqual(saves[0], ['a', 'retained user revision', []])
  let finish; await render({ onUpdateQueued: () => new Promise(resolve => { finish = resolve }) }); await click('保存')
  assert.equal(button('保存中').disabled, true); assert.ok(document.querySelector('textarea'))
  await act(async () => finish()); assert.equal(document.querySelector('textarea'), null)
})

test('both menu and drop reorder by pending subset, excluding accepted/unknown entries', async () => {
  const moves = []; await mount({ queue: [item('accepted', 'accepted'), item('a'), item('unknown', 'admission-unknown'), item('b')], onMoveQueued: async (...args) => { moves.push(args) } })
  await click('展开托盘'); await click('调整第 4 条待发消息顺序'); await click('上移')
  assert.deepEqual(moves, [[1, 0]])
  let rows = [...document.querySelectorAll('.session-tray__queue-item')]
  await act(async () => rows[1].dispatchEvent(new dom.window.Event('dragstart', { bubbles: true, cancelable: true })))
  rows = [...document.querySelectorAll('.session-tray__queue-item')]
  await act(async () => rows[3].dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true })))
  assert.deepEqual(moves, [[1, 0], [0, 1]])
})

test('unknown submission offers distinct read-only reconciliation and exact retry, with failures handled', async () => {
  const retries = []; await mount({ queue: [item('unknown', 'admission-unknown')], queueState: { ...base().queueState, unknown: true, paused: true },
    onReconcileQueue: async retry => { retries.push(retry); if (retry) throw new Error('回执暂时不可用') } })
  await click('核对'); assert.deepEqual(retries, [false])
  await click('队列更多操作'); await click('核对并重试')
  assert.deepEqual(retries, [false, true]); assert.match(document.querySelector('[role="alert"]').textContent, /回执暂时不可用/)
  assert.equal(document.querySelectorAll('[aria-label^="移除第"]').length, 0)
})

test('pause/resume and explicit merge never enable the removed automatic batch mode', async () => {
  let pauses = 0, resumes = 0, merges = 0
  await mount({ queue: [item('a'), item('b')], onPauseQueue: async () => { pauses++ }, onMergeQueue: async () => { resumes++ }, onMergePending: async () => { merges++ } })
  await click('队列更多操作'); assert.equal(button('改为合并发送'), undefined); await click('暂停队列'); assert.equal(pauses, 1)
  await render({ queueState: { ...base().queueState, paused: true } }); await click('继续'); assert.equal(resumes, 1)
  await click('队列更多操作'); await click('合并待发消息'); assert.equal(merges, 1)
  assert.equal(resumes, 1)
})

test('empty queue read failure remains visible and can reconcile without clearing anything', async () => {
  let reads = 0; await mount({ queue: [], queueState: { ...base().queueState, ready: false, error: '队列读取失败' }, onReconcileQueue: async () => { reads++ } })
  assert.equal(document.querySelector('.session-tray').hidden, false); await click('核对'); assert.equal(reads, 1)
  await click('队列更多操作'); assert.equal(button('清空待发').disabled, true)
})

test('late A response after A/B/A cannot overwrite the current session feedback or lock its editor', async () => {
  let reject; await mount({ onRemoveQueued: () => new Promise((_resolve, failure) => { reject = failure }) })
  await click('展开托盘'); await click('移除第 1 条排队消息')
  await render({ sessionId: 'B' }); await render({ sessionId: 'A' })
  await act(async () => reject(new Error('obsolete A failure')))
  assert.equal(document.querySelector('[role="alert"]'), null)
  await click('展开托盘'); await click('编辑第 1 条排队消息'); assert.ok(document.querySelector('textarea'))
})

test('background removal preserves an unsaved editor instead of silently losing its draft', async () => {
  await mount(); await click('展开托盘'); await click('编辑第 1 条排队消息'); await type('unsaved local change')
  await render({ queue: [] })
  assert.equal(document.querySelector('textarea').value, 'unsaved local change'); assert.equal(button('保存').disabled, true)
  assert.match(document.querySelector('[role="alert"]').textContent, /编辑内容未保存/)
  await click('取消'); assert.equal(document.querySelector('textarea'), null)
})
