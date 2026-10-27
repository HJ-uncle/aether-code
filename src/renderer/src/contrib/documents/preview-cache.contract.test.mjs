/** Bounded Office/PDF preview lifetimes; runs without Electron. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
function load(name) {
  const source = readFileSync(join(directory, name + '.ts'), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new vm.Script('(function(exports){' + javascript + '\n})', { filename: name }).runInThisContext()(exports)
  return exports
}
const { acquirePdfDocument, pdfPreviewSessionCount } = load('pdf-preview-session')
const { getOfficePreview, cacheOfficePreview, officePreviewCacheStats } = load('office-preview-cache')
const { retainPdfPageBitmap, restorePdfPageBitmap } = load('pdf-page-bitmap-cache')
const bytes = value => Uint8Array.from(value).buffer
const loaded = (label, destroyed) => async () => ({ document: { numPages: 1, label }, destroy: () => { destroyed.push(label) } })
const key = name => `preview-cache-contract-${name}`

test('PDF leases share parsing and never release the same reference twice', async () => {
  const destroyed = [], source = bytes([1, 2, 3])
  let loads = 0
  const load = async () => { loads++; return loaded('shared', destroyed)() }
  const first = await acquirePdfDocument(key('shared'), source, load)
  const second = await acquirePdfDocument(key('shared'), bytes([1, 2, 3]), load)
  assert.equal(loads, 1)
  assert.equal(first.document, second.document)
  first.release(true)
  assert.equal(destroyed.length, 0)
  first.release(true)
  second.release(true)
  assert.deepEqual(destroyed, ['shared'])
  assert.equal(pdfPreviewSessionCount(), 0)
})

test('a changed PDF retires but does not destroy an active old generation', async () => {
  const destroyed = []
  const oldLease = await acquirePdfDocument(key('generation'), bytes([1]), loaded('old', destroyed))
  const newLease = await acquirePdfDocument(key('generation'), bytes([2]), loaded('new', destroyed))
  assert.deepEqual(destroyed, [])
  oldLease.release()
  assert.deepEqual(destroyed, ['old'])
  newLease.release(true)
  assert.deepEqual(destroyed, ['old', 'new'])
  assert.equal(pdfPreviewSessionCount(), 0)
})

test('failed PDF loads do not leave a document or poison the next attempt', async () => {
  const destroyed = []
  await assert.rejects(acquirePdfDocument(key('retry'), bytes([3]), async () => { throw new Error('invalid PDF') }))
  const lease = await acquirePdfDocument(key('retry'), bytes([3]), loaded('valid', destroyed))
  assert.equal(lease.document.label, 'valid')
  lease.release(true)
  assert.deepEqual(destroyed, ['valid'])
})

test('a superseded PDF waits for the previous loading task before parsing', async () => {
  const order = []
  let finishFirst
  const first = acquirePdfDocument(key('serial'), bytes([1]), () => new Promise(resolve => {
    finishFirst = () => { order.push('first loaded'); resolve(loaded('first', [])()) }
  }))
  const second = acquirePdfDocument(key('serial'), bytes([2]), async () => {
    order.push('second loaded')
    return loaded('second', [])()
  })
  await Promise.resolve()
  assert.deepEqual(order, [])
  finishFirst()
  const [oldLease, newLease] = await Promise.all([first, second])
  assert.deepEqual(order, ['first loaded', 'second loaded'])
  oldLease.release(true)
  newLease.release(true)
})

test('PDF bitmap snapshots survive detached pages and bounded eviction', () => {
  const previousDocument = globalThis.document
  const canvas = () => ({ width: 1, height: 1, getContext: () => ({ drawImage: () => {} }) })
  globalThis.document = { createElement: canvas }
  try {
    const session = key('bitmap')
    for (let page = 1; page <= 13; page++) retainPdfPageBitmap(session, page, canvas(), 'fit:800')
    assert.equal(restorePdfPageBitmap(session, 1, canvas(), 'fit:800'), false)
    assert.equal(restorePdfPageBitmap(session, 13, canvas(), 'fit:800'), true)
    assert.equal(restorePdfPageBitmap(session, 13, canvas(), '125%'), false)
    assert.equal(restorePdfPageBitmap(session, 13, canvas(), 'fit:800'), true)
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('five Office documents survive a complete tab tour within the byte budget', () => {
  const sources = Array.from({ length: 5 }, (_, index) => bytes([index + 11]))
  for (let round = 0; round < 2; round++) for (const [index, source] of sources.entries()) {
    assert.deepEqual(getOfficePreview(`tour:${index}`, source), round ? [`page:${index}`] : null)
    cacheOfficePreview(`tour:${index}`, source, [`page:${index}`])
  }
})

test('Office cache reuses only the same content and bounds retained HTML', async () => {
  const source = bytes([4])
  cacheOfficePreview(key('office'), source, ['first', 'second'])
  assert.deepEqual(getOfficePreview(key('office'), source), ['first', 'second'])
  // A newly read buffer is a new generation even when its sampled bytes match.
  cacheOfficePreview(key('office'), bytes([4]), ['new'])
  assert.deepEqual(getOfficePreview(key('office'), source), null)
  assert.deepEqual(getOfficePreview(key('office'), bytes([4])), null)
  cacheOfficePreview(key('office-large'), source, ['x'.repeat(26 * 1024 * 1024)])
  cacheOfficePreview(key('office-other'), source, ['small'])
  assert.equal(getOfficePreview(key('office'), source), null)
  assert.ok(officePreviewCacheStats().bytes <= 48 * 1024 * 1024)
})
