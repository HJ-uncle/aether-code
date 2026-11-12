/** Selection ownership, trusted frame bridge and asynchronous PDF cancellation.
 * Mouse geometry and the composer are covered separately by the real UI spec. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
function load(name) {
  const source = readFileSync(join(directory, `${name}.ts`), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new vm.Script(`(function(exports, require){${javascript}\n})`, { filename: name }).runInThisContext()(exports, id => {
    if (id === '../../core/editor/document-menu-events') return load(id)
    throw new Error(`Unexpected dependency: ${id}`)
  })
  return exports
}
const { selectionTextWithin, observePreviewSelection, bridgeFrameSelection } = load('document-selection')
const { startPdfTextLayer } = load('pdf-preview-text')

class Target {
  listeners = new Map()
  addEventListener(type, fn) { const set = this.listeners.get(type) ?? new Set(); set.add(fn); this.listeners.set(type, set) }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ target: this, ...event }) }
  dispatchEvent(event) { this.emit(event.type, { detail: event.detail }); return true }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) }
}
function preview() {
  const first = {}, last = {}, outside = {}, document = new Target(), root = new Target()
  root.ownerDocument = document; root.contains = node => [root, first, last].includes(node)
  document.selection = { anchorNode: first, focusNode: last, rangeCount: 1, isCollapsed: false, toString: () => '  selected excerpt  ' }
  document.getSelection = () => document.selection
  document.querySelector = () => root
  return { first, last, outside, root, document }
}

test('only both endpoints inside this preview authorize the actual selected text', () => {
  const { root, document, outside } = preview()
  assert.equal(selectionTextWithin(document.selection, root), 'selected excerpt')
  for (const changed of [{ anchorNode: outside }, { focusNode: outside }, { rangeCount: 0 }, { isCollapsed: true }, { toString: () => ' \n ' }]) {
    assert.equal(selectionTextWithin({ ...document.selection, ...changed }, root), null)
  }
  assert.equal(selectionTextWithin(null, root), null)
})

test('toolbar collapse preserves the quote, explicit preview click/Escape clears it and disposal removes listeners', () => {
  const { root, document, first, outside } = preview(), received = []
  const stop = observePreviewSelection(root, text => received.push(text))
  document.emit('selectionchange')
  document.selection = null; document.emit('selectionchange')
  document.emit('pointerdown', { target: outside })
  assert.deepEqual(received, ['selected excerpt'])
  document.emit('pointerdown', { target: first }); document.emit('keydown', { key: 'Escape' })
  assert.deepEqual(received, ['selected excerpt', '', ''])
  stop(); assert.equal(document.listenerCount + root.listenerCount, 0)
  document.emit('selectionchange'); assert.equal(received.length, 3)
})

test('frame events cannot supply quote text or read another preview/unsafe frame', () => {
  const parent = preview(), child = preview(), received = []
  const frame = { tagName: 'IFRAME', contentDocument: child.document, getAttribute: name => name === 'sandbox' ? 'allow-same-origin' : 'true' }
  const originalContains = parent.root.contains
  parent.root.contains = node => node === frame || originalContains(node)
  const stop = observePreviewSelection(parent.root, text => received.push(text))
  parent.root.emit('aether-document-selection', { target: frame, detail: 'forged whole document' })
  assert.deepEqual(received, ['selected excerpt'])
  parent.root.emit('aether-document-selection', { target: { ...frame }, detail: 'foreign' })
  frame.getAttribute = name => name === 'sandbox' ? 'allow-scripts allow-same-origin' : 'true'
  parent.root.emit('aether-document-selection', { target: frame, detail: 'unsafe' })
  assert.equal(received.length, 1)
  stop()
})

test('scriptless bridge rebinds child navigation and stops all old or hidden-document events', () => {
  const first = preview(), second = preview(), frame = new Target(), events = []
  frame.contentDocument = first.document
  frame.addEventListener('aether-document-selection', event => events.push(event.detail))
  const stop = bridgeFrameSelection(frame)
  first.document.emit('selectionchange'); assert.deepEqual(events, ['selected excerpt'])
  frame.contentDocument = second.document; frame.emit('load')
  assert.equal(first.document.listenerCount, 0)
  second.document.selection.toString = () => 'new page'
  first.document.emit('selectionchange'); second.document.emit('selectionchange')
  assert.deepEqual(events, ['selected excerpt', 'new page'])
  second.document.emit('pointerdown', { target: second.first }); assert.equal(events.at(-1), '')
  stop(); assert.equal(second.document.listenerCount, 0)
  assert.equal(frame.listeners.get('load').size, 0)
})

test('scriptless frame context menus forward coordinates without trusting event-supplied selected text', () => {
  const child = preview(), frame = new Target(), events = []
  frame.contentDocument = child.document
  frame.addEventListener('aether-document-context-menu', event => events.push(event.detail))
  const stop = bridgeFrameSelection(frame)
  let prevented = 0
  child.document.emit('contextmenu', { clientX: 27, clientY: 46, selectedText: 'forged', preventDefault: () => prevented++ })
  assert.deepEqual(events, [{ x: 27, y: 46 }])
  child.document.selection.getRangeAt = () => ({ getBoundingClientRect: () => ({ left: 31, bottom: 58 }) })
  child.document.emit('keydown', { key: 'F10', shiftKey: true, preventDefault: () => prevented++ })
  assert.deepEqual(events.at(-1), { x: 31, y: 58 })
  assert.equal(prevented, 2)
  stop()
  child.document.emit('contextmenu', { clientX: 10, clientY: 10, preventDefault: () => prevented++ })
  assert.equal(events.length, 2)
})

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function textTarget() { return { children: ['old zoom'], replaceChildren() { this.children = [] } } }

test('PDF cancellation before preparation never creates a stream or writes stale nodes', async () => {
  const pending = deferred(), target = textTarget(), statuses = []; let created = 0
  const stop = startPdfTextLayer(target, () => pending.promise, value => statuses.push(value), 1000)
  assert.deepEqual(target.children, []); stop()
  pending.resolve(() => { created++; throw Error('must not create') }); await tick()
  assert.equal(created, 0); assert.deepEqual(statuses, ['loading'])
})

test('PDF cancellation tears down rendered glyphs and ignores a late previous-zoom completion', async () => {
  const rendered = deferred(), target = textTarget(), statuses = []; let cancelled = 0
  const stop = startPdfTextLayer(target, async () => () => ({
    textContentItemsStr: ['old'], render: () => { target.children.push('glyph'); return rendered.promise }, cancel: () => { cancelled++ }
  }), value => statuses.push(value), 1000)
  await tick(); assert.deepEqual(target.children, ['glyph'])
  stop(); rendered.resolve(); await tick()
  assert.equal(cancelled, 1); assert.deepEqual(target.children, []); assert.deepEqual(statuses, ['loading'])
})

test('PDF empty/scanned pages never claim selectable text; valid text reports ready', async () => {
  for (const [items, expected] of [[[], 'empty'], [['  '], 'empty'], [['chosen'], 'ready']]) {
    const statuses = [], stop = startPdfTextLayer(textTarget(), async () => () => ({
      textContentItemsStr: items, render: async () => {}, cancel() {}
    }), value => statuses.push(value), 1000)
    await tick(); assert.deepEqual(statuses, ['loading', expected]); stop()
  }
})

test('PDF text errors and timeouts cancel only their own page, clear partial nodes and report unavailable', async () => {
  for (const timeout of [false, true]) {
    const target = textTarget(), statuses = []; let cancelled = 0
    const finished = deferred()
    const stop = startPdfTextLayer(target, async () => () => ({
      textContentItemsStr: ['partial'], render: () => { target.children.push('partial'); return timeout ? new Promise(() => {}) : Promise.reject(Error('bad text')) }, cancel: () => { cancelled++ }
    }), value => { statuses.push(value); if (value === 'unavailable') finished.resolve() }, 10)
    await finished.promise
    assert.equal(cancelled, 1); assert.deepEqual(target.children, []); assert.deepEqual(statuses, ['loading', 'unavailable']); stop()
  }
})
