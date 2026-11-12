/** PDF render identity and real cache accounting; no Electron or live canvases. */
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
  new vm.Script(`(function(exports){${javascript}\n})`, { filename: name }).runInThisContext()(exports)
  return exports
}
const { pdfPreviewRenderIdentity } = load('pdf-preview-render')

function canvas(width = 0, height = 0, pixels = 'page') {
  const value = { width, height, pixels, copies: 0 }
  value.getContext = () => ({ drawImage: source => { value.copies++; value.pixels = source.pixels } })
  return value
}
function withCache(action) {
  const previous = globalThis.document, snapshots = []
  globalThis.document = { createElement: () => { const value = canvas(); snapshots.push(value); return value } }
  try { action(load('pdf-page-bitmap-cache'), snapshots) }
  finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
}

test('fixed PDF percentage retains its paint identity through container resizing', () => {
  for (const zoom of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    const original = pdfPreviewRenderIdentity(zoom, 800, 600, 800, 1.5)
    for (const width of [0, 480, 900, 1200]) assert.deepEqual(pdfPreviewRenderIdentity(zoom, width, 600, 800, 1.5), original)
    assert.equal(original.scale, zoom)
  }
  assert.notEqual(pdfPreviewRenderIdentity(1, 800, 600, 800, 1).key, pdfPreviewRenderIdentity(1, 800, 600, 800, 2).key)
  assert.equal(pdfPreviewRenderIdentity(1, 800, 600, 800, 2).key, pdfPreviewRenderIdentity(1, 800, 600, 800, 3).key)
})

test('fit PDF identity follows effective page scale, waiting for a width and preserving the scale cap', () => {
  assert.equal(pdfPreviewRenderIdentity(0, 0, 600, 800, 1).key, '')
  assert.equal(pdfPreviewRenderIdentity(0, 632, 600, 800, 1).scale, 1)
  assert.notEqual(pdfPreviewRenderIdentity(0, 600, 600, 800, 1).key, pdfPreviewRenderIdentity(0, 900, 600, 800, 1).key)
  assert.equal(pdfPreviewRenderIdentity(0, 2000, 600, 800, 1).key, pdfPreviewRenderIdentity(0, 2500, 600, 800, 1).key)
  assert.equal(pdfPreviewRenderIdentity(0, 800, 0, 0, 1).key, '')
})

test('large PDF bitmaps obey the 64 MiB budget and explicitly release evicted backing stores', () => withCache((cache, snapshots) => {
  const source = {}, page = canvas(2000, 2000)
  for (let index = 1; index <= 12; index++) {
    cache.retainPdfPageBitmap(source, index, page, '100%')
    const stats = cache.pdfPageBitmapCacheStats()
    assert.ok(stats.bytes <= 64 * 1024 * 1024)
    assert.equal(snapshots.reduce((sum, entry) => sum + entry.width * entry.height * 4, 0), stats.bytes)
  }
  assert.equal(cache.pdfPageBitmapCacheStats().entries, 4)
  assert.ok(snapshots.slice(0, 8).every(entry => entry.width === 0 && entry.height === 0))
  assert.equal(cache.restorePdfPageBitmap(source, 8, canvas(), '100%'), false)
  assert.equal(cache.restorePdfPageBitmap(source, 12, canvas(), '100%'), true)
  const allocations = snapshots.length
  cache.retainPdfPageBitmap(source, 20, canvas(5000, 5000), 'huge')
  assert.equal(snapshots.length, allocations)
}))

test('restoring a cached PDF page refreshes LRU without consuming or copying the snapshot again', () => withCache((cache, snapshots) => {
  const source = {}
  for (let page = 1; page <= 12; page++) cache.retainPdfPageBitmap(source, page, canvas(20, 30, `page-${page}`), 'fit')
  const restored = canvas()
  assert.equal(cache.restorePdfPageBitmap(source, 1, restored, 'fit'), true)
  assert.deepEqual([restored.width, restored.height, restored.pixels, restored.copies], [20, 30, 'page-1', 1])
  cache.retainPdfPageBitmap(source, 13, canvas(20, 30), 'fit')
  assert.equal(cache.restorePdfPageBitmap(source, 2, canvas(), 'fit'), false)
  assert.equal(cache.restorePdfPageBitmap(source, 1, canvas(), 'fit'), true)
  assert.equal(snapshots[1].width, 0)
  assert.equal(snapshots[0].copies, 1)
  const untouched = canvas(5, 5, 'unchanged')
  assert.equal(cache.restorePdfPageBitmap(source, 1, untouched, 'other-scale'), false)
  assert.deepEqual([untouched.width, untouched.height, untouched.pixels, untouched.copies], [5, 5, 'unchanged', 0])
}))

test('unchanged PDF snapshots do not allocate or copy again, while a new scale replaces and releases the old bitmap', () => withCache((cache, snapshots) => {
  const source = {}, drawn = canvas(100, 100, 'first')
  cache.retainPdfPageBitmap(source, 1, drawn, '100%')
  cache.retainPdfPageBitmap(source, 1, drawn, '100%')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].copies, 1)
  cache.retainPdfPageBitmap(source, 1, canvas(200, 200, 'second'), '200%')
  assert.deepEqual([snapshots[0].width, snapshots[0].height], [0, 0])
  assert.deepEqual(cache.pdfPageBitmapCacheStats(), { entries: 1, bytes: 200 * 200 * 4 })
  const restored = canvas()
  assert.equal(cache.restorePdfPageBitmap(source, 1, restored, '200%'), true)
  assert.equal(restored.pixels, 'second')
}))

test('failed snapshot allocation remains best effort and does not retain a pixel store', () => withCache((cache, snapshots) => {
  globalThis.document.createElement = () => {
    const failed = canvas()
    failed.getContext = () => ({ drawImage: () => { throw Error('Canvas allocation failed') } })
    snapshots.push(failed)
    return failed
  }
  assert.doesNotThrow(() => cache.retainPdfPageBitmap({}, 1, canvas(100, 100), 'fit'))
  assert.deepEqual(cache.pdfPageBitmapCacheStats(), { entries: 0, bytes: 0 })
  assert.deepEqual([snapshots[0].width, snapshots[0].height], [0, 0])
}))
