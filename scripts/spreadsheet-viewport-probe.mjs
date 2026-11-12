// CPU-only viewport benchmark using the installed ExcelJS and actual product
// helpers. No app, GUI, disk workbook, or model endpoint is opened. Preparation
// is measured separately; ZIP parsing and browser layout are outside this probe.
// Run from any directory: node scripts/spreadsheet-viewport-probe.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import vm from 'node:vm'
import { performance } from 'node:perf_hooks'
import ExcelJS from 'exceljs'
import ts from 'typescript'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(project, 'src/renderer/src/features/documents')
const require = createRequire(import.meta.url)
const modules = new Map(), sourceHashes = {}
function load(name) {
  if (modules.has(name)) return modules.get(name)
  assert.match(name, /^[a-z][a-z0-9-]*$/, 'Only local document helper modules may be loaded')
  const source = readFileSync(path.join(directory, `${name}.ts`), 'utf8')
  sourceHashes[`src/renderer/src/features/documents/${name}.ts`] = createHash('sha256').update(source).digest('hex')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  modules.set(name, exports)
  new vm.Script(`(function(require,exports){${javascript}\n})`, { filename: `${name}.ts` }).runInThisContext()(
    specifier => specifier.startsWith('./') ? load(specifier.slice(2)) : require(specifier), exports)
  return exports
}

const { buildSpreadsheetPage, prepareSpreadsheetPageSource } = load('spreadsheet-page')
const rowCount = 12000, columnCount = 20, viewportRows = 40, viewportColumns = 12, samples = 45, warmups = 3
const workbook = new ExcelJS.Workbook(), worksheet = workbook.addWorksheet('视口性能夹具')
for (let row = 1; row <= rowCount; row++) worksheet.addRow(Array.from({ length: columnCount }, (_, column) => row * columnCount + column))

const getters = { model: 0, rowCount: 0, columnCount: 0 }
const prototype = Object.getPrototypeOf(worksheet)
for (const name of Object.keys(getters)) {
  const getter = Object.getOwnPropertyDescriptor(prototype, name)?.get
  assert.equal(typeof getter, 'function', `ExcelJS Worksheet.${name} must remain a getter`)
  Object.defineProperty(worksheet, name, { get() { getters[name]++; return getter.call(this) } })
}
const resetGetters = () => { for (const name of Object.keys(getters)) getters[name] = 0 }
const read = (source, row) => buildSpreadsheetPage(source, 0, row, 0, [], false, row + viewportRows, viewportColumns)
const round = value => Number(value.toFixed(3))

resetGetters()
const preparingAt = performance.now()
const prepared = prepareSpreadsheetPageSource(worksheet)
const preparation = { elapsedMs: round(performance.now() - preparingAt), getterReads: { ...getters } }
// Warm both routes before timing to exclude module setup and first-call JIT.
for (let index = 0; index < warmups; index++) { read(worksheet, index); read(prepared, index) }

function measure(source) {
  resetGetters()
  const timings = [], pages = []
  for (let index = 0; index < samples; index++) {
    const startedAt = performance.now()
    const page = read(source, index)
    timings.push(performance.now() - startedAt)
    pages.push(page)
  }
  const sorted = [...timings].sort((left, right) => left - right)
  return { pages, metrics: {
    samples, medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    totalMs: round(timings.reduce((sum, value) => sum + value, 0)),
    getterReads: { ...getters }, sampleMs: timings.map(round)
  } }
}

const baseline = measure(worksheet), optimized = measure(prepared)
const differences = []
for (let index = 0; index < samples; index++) {
  try { assert.deepEqual(optimized.pages[index], baseline.pages[index]) }
  catch (error) { differences.push({ viewport: index, error: error instanceof Error ? error.message.slice(0, 1200) : String(error) }) }
}
const digest = pages => createHash('sha256').update(JSON.stringify(pages)).digest('hex')
const report = {
  timestamp: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, exceljs: require('exceljs/package.json').version },
  scenario: { rowCount, columnCount, viewportRows, viewportColumns, samples, warmups, values: 'row * 20 + zero-based column', traversal: '45 adjacent viewports starting at rows 0 through 44' },
  scope: 'In-memory Node CPU microbenchmark. Same installed ExcelJS worksheet and actual product buildSpreadsheetPage helper. Preparation excludes workbook construction. No ZIP decoding, worker transfer, browser layout, or GUI latency is measured. Local timings are not a frame-rate guarantee.',
  preparation,
  baseline: { route: 'Worksheet directly passed to buildSpreadsheetPage', ...baseline.metrics },
  optimized: { route: 'prepareSpreadsheetPageSource snapshot passed to buildSpreadsheetPage', ...optimized.metrics },
  equality: { passed: differences.length === 0, comparedViewports: samples, comparedCells: samples * viewportRows * viewportColumns,
    baselineSha256: digest(baseline.pages), optimizedSha256: digest(optimized.pages), differences },
  sourceHashes
}
const output = path.join(project, '.e2e-tmp', 'spreadsheet-viewport', `report-${Date.now()}.json`)
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: output, preparation, baseline: { ...baseline.metrics, sampleMs: undefined }, optimized: { ...optimized.metrics, sampleMs: undefined }, equality: report.equality }, null, 2))
if (!report.equality.passed) process.exitCode = 1
