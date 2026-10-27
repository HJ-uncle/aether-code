/** Session lifecycle, continuous rectangular ranges, real dimensions and merge ownership; no Electron. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import ssf from 'ssf'

const directory = dirname(fileURLToPath(import.meta.url)), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(join(directory, name + '.ts'), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('import.meta.url', 'JSON.stringify("worker.ts")')
  const exports = {}
  new vm.Script('(function(require,exports){' + javascript + '\n})', { filename: name }).runInThisContext()(specifier => {
    if (name === 'spreadsheet-preview-session' && specifier === './spreadsheet-preview.worker.ts') return {}
    if (specifier.startsWith('./')) return load(specifier.slice(2))
    if (specifier === 'ssf') return ssf
    throw new Error('Unexpected dependency: ' + specifier)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { buildSpreadsheetPage, buildSpreadsheetAxis, spreadsheetAxisIndex, spreadsheetRequestValid } = load('spreadsheet-page')
const { spreadsheetThemeColors, spreadsheetColor } = load('spreadsheet-style')
const { SpreadsheetPreviewSession, acquireSpreadsheetSession, releaseSpreadsheetSession } = load('spreadsheet-preview-session')

class FakeWorker {
  messages = []
  terminated = false
  onmessage = null
  onerror = null
  postMessage(message) { this.messages.push(message) }
  terminate() { this.terminated = true }
  emit(data) { this.onmessage?.({ data }) }
}
const bytes = value => Uint8Array.from(value).buffer
const page = (sheet, row, column, text = '') => ({ sheet, row, column, cells: [[{ text }]], formatFallbacks: 0, layout: { rows: [30], columns: [110] } })

test('latest page wins, stale success and errors cannot replace the selection', () => {
  const worker = new FakeWorker(), session = new SpreadsheetPreviewSession(worker, bytes([1]))
  worker.emit({ kind: 'loaded', sheets: [{ name: '数据', rows: 50000, columns: 256 }] })
  session.select(0, 0, 0)
  const first = worker.messages.at(-1).requestId
  session.select(0, 100, 0)
  const second = worker.messages.at(-1).requestId
  assert.ok(second > first)
  worker.emit({ kind: 'page', requestId: first, page: page(0, 0, 0, 'first') })
  assert.equal(session.page, null)
  worker.emit({ kind: 'error', requestId: first, message: '所选表格区域无效。' })
  assert.equal(session.pageError, '')
  worker.emit({ kind: 'page', requestId: second, page: page(0, 100, 0, 'second') })
  assert.equal(session.page.cells[0][0].text, 'second')
  worker.emit({ kind: 'page', requestId: first, page: page(0, 0, 0, 'cached first') })
  assert.equal(session.page.cells[0][0].text, 'second')
  const requests = worker.messages.length
  session.select(0, 0, 0)
  assert.equal(session.page.cells[0][0].text, 'cached first')
  assert.equal(worker.messages.length, requests)
  session.select(0, 100, 0)
  assert.equal(worker.messages.length, requests)
  session.close()
})

test('a page error is isolated and another selection can continue', () => {
  const worker = new FakeWorker(), session = new SpreadsheetPreviewSession(worker, bytes([1]))
  worker.emit({ kind: 'loaded', sheets: [{ name: '数据', rows: 300, columns: 20 }] })
  session.select(0, 0, 0)
  const failed = worker.messages.at(-1).requestId
  session.select(0, 100, 0)
  const current = worker.messages.at(-1).requestId
  worker.emit({ kind: 'error', requestId: failed, message: '所选表格区域无效。' })
  assert.equal(session.pageError, '')
  worker.emit({ kind: 'error', requestId: current, message: '所选表格区域无效。' })
  assert.match(session.pageError, /所选表格区域无效/)
  assert.equal(session.error, '')
  session.select(0, 200, 0)
  assert.equal(session.pageError, '')
  assert.equal(worker.terminated, false)
  worker.emit({ kind: 'page', requestId: worker.messages.at(-1).requestId, page: page(0, 200, 0, 'recovered') })
  assert.equal(session.page.cells[0][0].text, 'recovered')
  session.close()
})

test('page cache is bounded and revisits do not rebuild pages', () => {
  const worker = new FakeWorker(), session = new SpreadsheetPreviewSession(worker, bytes([1]))
  worker.emit({ kind: 'loaded', sheets: [{ name: '数据', rows: 50000, columns: 20 }] })
  for (let index = 0; index < 14; index++) {
    session.select(0, index * 100, 0)
    worker.emit({ kind: 'page', requestId: worker.messages.at(-1).requestId, page: page(0, index * 100, 0, String(index)) })
  }
  assert.equal(session.pages.size, 12)
  const requests = worker.messages.length
  session.select(0, 1300, 0)
  assert.equal(worker.messages.length, requests)
  session.select(0, 0, 0)
  assert.equal(worker.messages.length, requests + 1)
  session.close()
})

test('same key with changed bytes retires but does not kill an active old lease', () => {
  const key = 'replace-active-' + Date.now()
  const oldWorker = new FakeWorker(), newWorker = new FakeWorker()
  const oldLease = acquireSpreadsheetSession(key, bytes([1]), () => oldWorker)
  const newLease = acquireSpreadsheetSession(key, bytes([2]), () => newWorker)
  assert.equal(oldWorker.terminated, false)
  assert.notEqual(oldLease.session, newLease.session)
  oldLease.release()
  assert.equal(oldWorker.terminated, true)
  assert.equal(newWorker.terminated, false)
  newLease.release()
  releaseSpreadsheetSession(key)
  assert.equal(newWorker.terminated, true)
})

test('four workbook tours retain their idle workers instead of rebuilding every tab', () => {
  const workers = [], sources = Array.from({ length: 4 }, (_, index) => bytes([index + 1]))
  for (let round = 0; round < 2; round++) for (const [index, source] of sources.entries()) {
    const lease = acquireSpreadsheetSession(`tour:${index}`, source, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    lease.release()
  }
  assert.equal(workers.length, 4)
  assert.equal(workers.some(worker => worker.terminated), false)
  for (const [index, source] of sources.entries()) {
    const lease = acquireSpreadsheetSession(`tour:${index}`, source, () => { throw new Error('unexpected rebuild') })
    lease.session.close()
    lease.release()
    releaseSpreadsheetSession(`tour:${index}`)
  }
  assert.equal(workers.every(worker => worker.terminated), true)
})

test('a clipped merge keeps its master value on the first page only', () => {
  const cells = new Map()
  for (const [row, column] of [[99, 1], [101, 1], [99, 2], [101, 2]]) cells.set(`${row}:${column}`, {
    isMerged: true, value: null, text: '', numFmt: 'General', style: {},
    master: { value: '归属首格', text: '归属首格', numFmt: 'General' },
  })
  cells.get('99:1').value = '归属首格'
  cells.get('99:1').text = '归属首格'
  const source = {
    rowCount: 150, columnCount: 2, model: { merges: ['A99:B101'] },
    getCell: (row, column) => cells.get(`${row}:${column}`) || {
      isMerged: false, value: null, text: '', numFmt: 'General', style: {}, master: { value: null, text: '', numFmt: 'General' },
    },
    getColumn: () => ({}), getRow: () => ({}),
  }
  const first = buildSpreadsheetPage(source, 0, 0, 0, [], false)
  const second = buildSpreadsheetPage(source, 0, 100, 0, [], false)
  assert.equal(first.cells[98][0].text, '归属首格')
  assert.deepEqual([first.cells[98][0].rowSpan, first.cells[98][0].colSpan], [2, 2])
  assert.equal(second.cells[0][0].text, '')
  assert.deepEqual([second.cells[0][0].rowSpan, second.cells[0][0].colSpan], [1, 2])
  assert.equal(second.cells[0][1].covered, true)
})

test('continuous ranges dedupe requests, ignore unrelated failures and reuse exact rectangles', () => {
  const worker = new FakeWorker(), session = new SpreadsheetPreviewSession(worker, bytes([1]))
  session.requestRange(0, 18, 2, 58, 9)
  assert.equal(worker.messages.length, 1) // load only: range waits for the workbook
  worker.emit({ kind: 'loaded', sheets: [{ name: '数据', rows: 12000, columns: 12 }], layouts: [] })
  assert.equal(worker.messages.length, 2)
  const request = worker.messages.at(-1)
  assert.deepEqual([request.endRow, request.endColumn], [58, 9])
  session.requestRange(0, 18, 2, 58, 9)
  assert.equal(worker.messages.length, 2)
  worker.emit({ kind: 'page', requestId: request.requestId, page: { ...page(0, 18, 2, 'visible'), endRow: 58, endColumn: 9 } })
  assert.equal(session.getRange(0, 18, 2, 58, 9).cells[0][0].text, 'visible')
  session.requestRange(0, 18, 2, 58, 9)
  assert.equal(worker.messages.length, 2)
  session.requestRange(0, 58, 2, 98, 9)
  const failed = worker.messages.at(-1)
  worker.emit({ kind: 'error', requestId: failed.requestId, message: '所选表格区域无效。' })
  assert.match(session.getRangeError(0, 58, 2, 98, 9), /所选表格区域无效/)
  assert.equal(session.getRangeError(0, 18, 2, 58, 9), '')
  assert.equal(session.pageError, '')
  session.close()
})

test('range cache uses a cell budget and LRU rather than retaining every viewport', () => {
  const worker = new FakeWorker(), session = new SpreadsheetPreviewSession(worker, bytes([1]))
  worker.emit({ kind: 'loaded', sheets: [{ name: '数据', rows: 12000, columns: 12 }], layouts: [] })
  const ranges = Array.from({ length: 130 }, (_, index) => [index * 20, 0, index * 20 + 20, 12])
  for (const [index, [row, column, endRow, endColumn]] of ranges.entries()) {
    session.requestRange(0, row, column, endRow, endColumn)
    worker.emit({ kind: 'page', requestId: worker.messages.at(-1).requestId, page: {
      ...page(0, row, column, String(index)), endRow, endColumn,
      cells: Array.from({ length: 20 }, () => Array.from({ length: 12 }, () => ({ text: String(index) }))),
      layout: { rows: Array(20).fill(30), columns: Array(12).fill(110) },
    } })
  }
  assert.ok(session.ranges.size < ranges.length)
  assert.ok(session.rangeCells <= 24000)
  assert.equal(session.getRange(0, 0, 0, 20, 12), null)
  assert.equal(session.getRange(0, 2580, 0, 2600, 12).cells[0][0].text, '129')
  session.close()
})

test('a rectangular viewport preserves merges across both legacy page boundaries and real dimensions', () => {
  const source = {
    rowCount: 150, columnCount: 30, model: { merges: ['A99:C101'] },
    getCell: (row, column) => ({
      isMerged: row >= 99 && row <= 101 && column <= 3,
      value: row === 99 && column === 1 ? '合并值' : null,
      text: row === 99 && column === 1 ? '合并值' : '', numFmt: 'General', style: {},
      master: { value: '合并值', text: '合并值', numFmt: 'General' },
    }),
    getColumn: column => ({ width: column === 1 ? 20 : 10 }),
    getRow: row => ({ height: row === 99 ? 45 : 20 }),
  }
  const range = buildSpreadsheetPage(source, 0, 90, 0, [], false, 110, 25)
  assert.deepEqual([range.endRow, range.endColumn], [110, 25])
  assert.equal(range.cells[8][0].text, '合并值')
  assert.deepEqual([range.cells[8][0].rowSpan, range.cells[8][0].colSpan], [3, 3])
  assert.equal(range.cells[8][1].covered, true)
  assert.equal(range.layout.rows[8], 60)
  assert.equal(range.layout.columns[0], 140)
  assert.equal(spreadsheetRequestValid(0, 90, 0, source, 110, 25), true)
  assert.equal(spreadsheetRequestValid(0, 1, 0, source), false) // legacy select remains aligned
  assert.equal(spreadsheetRequestValid(0, 0, 0, source, 150, 30), true)
  assert.equal(spreadsheetRequestValid(0, 0, 0, { ...source, rowCount: 50000, columnCount: 256 }, 50000, 256), false)
})

test('real row and column offsets support direct continuous jumps', () => {
  const axis = buildSpreadsheetAxis([20, 40, 30, 50])
  assert.equal(axis.total, 140)
  assert.deepEqual(Array.from(axis.offsets), [0, 20, 60, 90, 140])
  assert.equal(spreadsheetAxisIndex(axis, 0), 0)
  assert.equal(spreadsheetAxisIndex(axis, 20), 1)
  assert.equal(spreadsheetAxisIndex(axis, 59.9), 1)
  assert.equal(spreadsheetAxisIndex(axis, 90), 3)
  assert.equal(spreadsheetAxisIndex(axis, 140), 3)
})

test('missing theme slots preserve later accent indexes', () => {
  const theme = '<a:theme xmlns:a="urn:test"><a:clrScheme><a:dk1><a:srgbClr val="111111"/></a:dk1><a:accent1><a:srgbClr val="abcdef"/></a:accent1></a:clrScheme></a:theme>'
  const colors = spreadsheetThemeColors(theme)
  assert.equal(colors.length, 12)
  assert.equal(spreadsheetColor({ theme: 4 }, colors), '#abcdef')
  assert.equal(spreadsheetColor({ theme: 1 }, colors), '#111111')
})
