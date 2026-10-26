#!/usr/bin/env node
/** Independent, read-only audit of a current office company's actual files.
 * Usage: node scripts/audit-office-current.mjs <company-root> [--revision v1|v2|all]
 * Reports are written only to the sibling evidence directory. No application,
 * model, shell command from a document, or document macro is ever executed.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { SaxesParser } from 'saxes'

const LIMITS = { files: 1500, fileBytes: 32 * 1024 ** 2, totalBytes: 512 * 1024 ** 2,
  entries: 4000, expandedBytes: 128 * 1024 ** 2, partBytes: 16 * 1024 ** 2,
  xmlChars: 16 * 1024 ** 2, cells: 100000, pdfPages: 100, textChars: 250000,
  retainedExtractBytes: 64 * 1024 ** 2 }
const SUPPORTED = new Set(['.docx', '.pptx', '.xlsx', '.pdf', '.csv', '.md', '.txt', '.json', '.html'])
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const digest = value => typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value) ? value.replace(/^sha256:/i, '').toLowerCase() : null
const slash = value => String(value).replaceAll('\\', '/')
const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) }
const cleanText = text => String(text).replaceAll('\u0000', '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
const local = name => String(name).split(':').at(-1)
const add = (item, id, status, detail, extra = {}) => item.checks.push({ id, status, detail, ...extra })
const capped = (items, maximum = 100) => ({ count: items.length, items: items.slice(0, maximum), omitted: Math.max(0, items.length - maximum) })
const scalar = value => value instanceof Date ? value.toISOString() : value && typeof value === 'object'
  ? 'result' in value ? scalar(value.result) : 'richText' in value ? value.richText.map(t => t.text).join('') : value.text ?? value.error ?? null : value

function xml(data, handlers = {}) {
  if (data.length > LIMITS.xmlChars) throw Error('XML part exceeds audit budget')
  const parser = new SaxesParser({ xmlns: false })
  parser.on('doctype', () => { throw Error('DTD/entity declarations are not accepted') })
  parser.on('error', error => { throw error })
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler)
  parser.write(data).close()
}

function officeText(source, wanted = new Set(['t'])) {
  const pieces = [], stack = []
  xml(source, { opentag: node => stack.push(local(node.name)), text: text => {
    if (wanted.has(stack.at(-1))) pieces.push(text)
  }, closetag: node => { if (['p', 'tr'].includes(local(node.name))) pieces.push('\n'); stack.pop() } })
  return cleanText(pieces.join(''))
}

/** Only unmerged, explicitly labelled additive table columns qualify; text matches
 * elsewhere on a slide must not hide a wrong amount in a particular total cell. */
function presentationTableTotals(source, part) {
  const tables = [], stack = []
  let table = null, row = null, cell = null
  xml(source, { opentag: node => {
    const name = local(node.name); stack.push(name)
    if (name === 'tbl') table = { rows: [], merged: false }
    if (table && name === 'tr') row = []
    if (row && name === 'tc') {
      cell = ''
      if (Object.keys(node.attributes).some(key => /^(?:gridSpan|rowSpan|hMerge|vMerge)$/.test(local(key)))) table.merged = true
    }
  }, text: text => { if (cell !== null && stack.at(-1) === 't') cell += text }, closetag: node => {
    const name = local(node.name)
    if (name === 'p' && cell !== null) cell += '\n'
    if (name === 'tc' && row) { row.push(cell.trim()); cell = null }
    if (name === 'tr' && table) { table.rows.push(row); row = null }
    if (name === 'tbl') { tables.push(table); table = null }
    stack.pop()
  } })
  const numeric = value => {
    const text = String(value ?? '').trim()
    if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null
    const number = Number(text.replaceAll(',', '')); return Number.isFinite(number) ? number : null
  }
  const checks = []
  for (const [index, table] of tables.entries()) {
    const rows = table.rows, header = rows[0], total = rows.at(-1), body = rows.slice(1, -1)
    if (table.merged || rows.length < 3 || !/^(?:合计|总计|total)$/i.test(total?.[0] ?? '') || rows.some(row => row.length !== header.length)) continue
    for (let column = 1; column < header.length; column++) {
      if (/比率|比例|概率|率|占比|ratio|rate|percent|average|均值|平均/i.test(header[column])) continue
      const actual = numeric(total[column]), values = body.map(row => numeric(row[column]))
      if (actual === null || values.some(value => value === null)) continue
      const expected = values.reduce((sum, value) => sum + value, 0)
      checks.push({ id: 'pptx.table-total', status: Math.abs(actual - expected) <= 0.005 ? 'passed' : 'failed', part, table: index + 1,
        row: rows.length, column: column + 1, heading: header[column], actual, expected, operands: values,
        detail: 'Independent sum of all numeric detail rows in an unmerged table ending with an explicit total row; does not establish broader business semantics' })
    }
  }
  return checks
}

/** Validate central-directory budgets before asking a ZIP library to inflate. */
function zipDirectory(data) {
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break }
  }
  if (end < 0) throw Error('ZIP end record is missing or has trailing bytes')
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16)
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8)) throw Error('Split ZIP is unsupported')
  if (count === 65535 || start === 0xffffffff || size === 0xffffffff) throw Error('ZIP64 is outside this audit budget')
  if (count > LIMITS.entries || start + size > end) throw Error('ZIP directory exceeds audit budget or file bounds')
  let position = start, expanded = 0
  const names = new Set(), entries = []
  for (let index = 0; index < count; index++) {
    if (position + 46 > start + size || data.readUInt32LE(position) !== 0x02014b50) throw Error('Invalid ZIP central entry')
    const flags = data.readUInt16LE(position + 8), compressed = data.readUInt32LE(position + 20), bytes = data.readUInt32LE(position + 24)
    const nameSize = data.readUInt16LE(position + 28), extra = data.readUInt16LE(position + 30), comment = data.readUInt16LE(position + 32)
    const offset = data.readUInt32LE(position + 42), next = position + 46 + nameSize + extra + comment
    if (next > start + size || flags & 1 || [compressed, bytes, offset].includes(0xffffffff)) throw Error('Encrypted, ZIP64 or truncated ZIP entry')
    const name = data.subarray(position + 46, position + 46 + nameSize).toString('utf8')
    if (/^[\\/]|^[a-z]:|\x00/i.test(name) || name.includes('\\') || name.split('/').includes('..') || names.has(name)) throw Error('Unsafe or duplicate ZIP path')
    if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50) throw Error('ZIP local entry is outside package')
    const localName = data.readUInt16LE(offset + 26), localExtra = data.readUInt16LE(offset + 28)
    if (offset + 30 + localName + localExtra + compressed > start) throw Error('ZIP compressed data exceeds package bounds')
    expanded += bytes
    if (bytes > LIMITS.partBytes || expanded > LIMITS.expandedBytes) throw Error('ZIP expansion exceeds audit budget')
    names.add(name); entries.push({ name, bytes }); position = next
  }
  if (position !== start + size) throw Error('ZIP central-directory length mismatch')
  return { entries, expanded }
}

async function openOffice(data, required) {
  const metadata = zipDirectory(data), zip = await JSZip.loadAsync(data, { checkCRC32: false })
  for (const name of ['[Content_Types].xml', '_rels/.rels', required]) if (!zip.file(name)) throw Error('OOXML required part missing: ' + name)
  const read = async name => {
    const part = zip.file(name)
    if (!part) throw Error('OOXML part missing: ' + name)
    const value = await part.async('string')
    if (Buffer.byteLength(value) > LIMITS.partBytes) throw Error('Actual inflated part exceeds audit budget')
    return value
  }
  const contentTypes = await read('[Content_Types].xml')
  xml(contentTypes); xml(await read('_rels/.rels'))
  return { zip, read, metadata, contentTypes }
}

function parseCsv(text) {
  const rows = [], row = []
  let cell = '', quoted = false, closed = false
  text = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++ } else { quoted = false; closed = true } }
      else cell += char
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell); cell = ''; closed = false
      if (char !== ',') { rows.push(row.splice(0)); if (char === '\r' && text[index + 1] === '\n') index++ }
    } else if (char === '"' && cell === '' && !closed) quoted = true
    else { if (closed || char === '"') throw Error('CSV quote syntax is invalid'); cell += char }
  }
  if (quoted) throw Error('CSV contains an unclosed quote')
  if (cell !== '' || row.length || closed) { row.push(cell); rows.push(row) }
  return rows
}

async function inspectSpreadsheet(data, item, source) {
  const rawErrors = [], missingCaches = [], formulaParts = []
  let count = 0
  for (const name of Object.keys(source.zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    let cell = null, inFormula = false, inValue = false
    xml(await source.read(name), { opentag: node => {
      if (local(node.name) === 'c') { if (++count > LIMITS.cells) throw Error('Workbook cell budget exceeded'); cell = { part: name, address: node.attributes.r, type: node.attributes.t, formula: '', cache: '', hasFormula: false, hasCache: false } }
      if (cell && local(node.name) === 'f') { inFormula = true; cell.hasFormula = true }
      if (cell && local(node.name) === 'v') { inValue = true; cell.hasCache = true }
    }, text: text => { if (cell && inFormula) cell.formula += text; if (cell && inValue) cell.cache += text }, closetag: node => {
      const tag = local(node.name)
      if (tag === 'f') inFormula = false
      if (tag === 'v') inValue = false
      if (tag === 'c' && cell) {
        if (cell.type === 'e') rawErrors.push({ part: name, address: cell.address, value: cell.cache })
        if (cell.hasFormula) { formulaParts.push(cell); if (!cell.hasCache || cell.cache === '' && cell.type !== 'str') missingCaches.push({ part: name, address: cell.address, formula: cell.formula }) }
        cell = null
      }
    } })
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(data)
  item.sheets = []; item._cells = new Map(); item._text = ''
  const duplicates = [], formulas = []
  for (const sheet of workbook.worksheets) {
    const cells = [], idValues = new Map()
    sheet.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      const value = scalar(cell.value), entry = { address: cell.address, value }
      if (cell.value && typeof cell.value === 'object' && 'error' in cell.value) entry.error = cell.value.error
      if (cell.value instanceof Date) entry.dateSerial = (cell.value.getTime() - Date.UTC(workbook.properties.date1904 ? 1904 : 1899, workbook.properties.date1904 ? 0 : 11, workbook.properties.date1904 ? 1 : 30)) / 86400000
      if (cell.formula) { entry.formula = cell.formula; formulas.push({ sheet: sheet.name, ...entry }) }
      if (value !== null && value !== undefined) item._text += String(value) + '\n'
      item._cells.set(sheet.name + '!' + cell.address.toUpperCase(), entry)
      cells.push(entry)
      // Repeated IDs are observations, because a valid detail table may repeat a foreign key.
      if (typeof value === 'string' && /^[A-Z]{1,5}[-_]?\d{3,}$/.test(value)) idValues.set(value, [...(idValues.get(value) || []), cell.address])
    }))
    for (const [value, addresses] of idValues) if (addresses.length > 1) duplicates.push({ sheet: sheet.name, value, addresses })
    item.sheets.push({ name: sheet.name, state: sheet.state, rows: sheet.rowCount, columns: sheet.columnCount, actualCells: cells.length, cells: cells.slice(0, 300), cellsOmitted: Math.max(0, cells.length - 300) })
  }
  item.formulas = capped(formulas, 200); item.savedErrors = capped(rawErrors); item.missingFormulaCaches = capped(missingCaches)
  item.formulaEvaluation = evaluateWorkbookFormulas(item._cells, formulas, workbook.properties.date1904, workbook.worksheets.map(sheet => sheet.name))
  item.duplicateIdObservations = capped(duplicates)
  add(item, 'xlsx.parse', 'passed', `${workbook.worksheets.length} worksheets; ${count} XML cells`)
  add(item, 'xlsx.saved-errors', rawErrors.length ? 'failed' : 'passed', `${rawErrors.length} saved error cells (including hidden worksheets)`)
  add(item, 'xlsx.formula-caches', missingCaches.length ? 'not-verified' : 'passed', `${formulaParts.length} formula cells; ${missingCaches.length} missing/empty caches; saved values are not a recalculation`)
  const mismatches = item.formulaEvaluation.filter(x => x.status === 'failed'), supported = item.formulaEvaluation.filter(x => x.computed !== undefined)
  add(item, 'xlsx.independent-formula-evaluation', mismatches.length ? 'failed' : supported.length ? 'passed' : 'not-verified', `${supported.length}/${formulas.length} formulas evaluated from expressions and dependencies without saved intermediate caches; ${mismatches.length} saved-result mismatches`)
  add(item, 'xlsx.full-recalculation', 'not-verified', 'A bounded formula subset was evaluated independently; no Excel-compatible full calculation engine or input perturbation was executed')
}

/** A deliberately small interpreter, never eval/Function. Unsupported Excel
 * semantics remain unverified instead of silently trusting a cached result. */
function evaluateWorkbookFormulas(cells, formulas, date1904 = false, sheetNames = []) {
  const memo = new Map(), visiting = new Set(), epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)
  const names = new Map([...sheetNames, ...formulas.map(entry => entry.sheet), ...[...cells.keys()].map(key => key.slice(0, key.lastIndexOf('!')))].map(name => [name.toLowerCase(), name]))
  const numeric = value => { if (value === null || value === '') return 0; if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Non-numeric arithmetic input'); return value }
  const refValue = (sheet, address) => {
    const canonicalSheet = names.get(sheet.toLowerCase())
    if (!canonicalSheet) throw Error('Unknown worksheet: ' + sheet)
    const key = canonicalSheet + '!' + address.replaceAll('$', '').toUpperCase(), entry = cells.get(key)
    if (!entry) return null
    if (entry.error) throw Error('Referenced error cell: ' + entry.error)
    if (!entry.formula) return entry.dateSerial ?? entry.value
    if (memo.has(key)) return memo.get(key)
    if (visiting.has(key) || visiting.size >= 100) throw Error('Cyclic or excessively deep formula dependencies')
    visiting.add(key)
    try { const value = parse(entry.formula, canonicalSheet); memo.set(key, value); return value } finally { visiting.delete(key) }
  }
  const column = name => [...name.toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
  const columnName = number => { let name = ''; for (; number > 0; number = Math.floor((number - 1) / 26)) name = String.fromCharCode(65 + (number - 1) % 26) + name; return name }
  const range = (sheet, first, last) => {
    const a = first.replaceAll('$', '').match(/^([A-Z]+)(\d+)$/i), b = last.replaceAll('$', '').match(/^([A-Z]+)(\d+)$/i)
    const c1 = column(a[1]), c2 = column(b[1]), r1 = Number(a[2]), r2 = Number(b[2])
    if (c2 < c1 || r2 < r1 || (c2 - c1 + 1) * (r2 - r1 + 1) > 10000) throw Error('Unsupported reversed or excessive range')
    const values = []; for (let row = r1; row <= r2; row++) for (let col = c1; col <= c2; col++) values.push(refValue(sheet, columnName(col) + row)); return values
  }
  const call = (name, args, sources) => {
    const flat = args.flat(), numbers = flat.filter(x => typeof x === 'number')
    // References ignore text/logicals, while direct arguments have different Excel coercions.
    // Keep unknown coercions unverified instead of issuing a false formula mismatch.
    if (['SUM', 'COUNT', 'MIN', 'MAX', 'AVERAGE'].includes(name.toUpperCase())) {
      for (const [index, value] of args.entries()) if (!Array.isArray(value) && typeof value !== 'number'
        && !/^(?:(?:'(?:[^']|'')+'|[\p{L}\p{N}_. ]+)!)?\$?[A-Z]{1,3}\$?[1-9]\d*$/iu.test(sources[index].trim())) throw Error('Direct nonnumeric aggregate coercion is outside independent audit support')
    }
    switch (name.toUpperCase()) {
      case 'SUM': return numbers.reduce((a, b) => a + b, 0)
      case 'COUNT': return numbers.length
      case 'COUNTA': return flat.filter(x => x !== null && x !== undefined).length
      case 'MIN': return numbers.length ? Math.min(...numbers) : 0
      case 'MAX': return numbers.length ? Math.max(...numbers) : 0
      case 'AVERAGE': if (!numbers.length) throw Error('Empty AVERAGE'); return numbers.reduce((a, b) => a + b, 0) / numbers.length
      case 'ROUND': { const n = numeric(args[0]), power = 10 ** numeric(args[1]); return Math.sign(n) * Math.round(Math.abs(n) * power + Number.EPSILON * Math.abs(n) * power) / power }
      case 'IF': if (args.length !== 3) throw Error('Only three-argument IF supported'); return args[0] ? args[1] : args[2]
      case 'AND': return flat.every(Boolean)
      case 'OR': return flat.some(Boolean)
      case 'DATE': {
        if (numeric(args[0]) < 1901 || numeric(args[0]) > 9999) throw Error('Historical DATE semantics are outside independent audit support')
        const date = Date.UTC(numeric(args[0]), numeric(args[1]) - 1, numeric(args[2]))
        if (date < Date.UTC(1901, 0, 1)) throw Error('Historical DATE overflow is outside independent audit support')
        return (date - epoch) / 86400000
      }
      case 'TEXT': {
        if (String(args[1]).toLowerCase() !== 'yyyy-mm-dd') throw Error('Only ISO date TEXT formatting supported')
        if (typeof args[0] === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(args[0])) return args[0].slice(0, 10)
        if (numeric(args[0]) < (date1904 ? 0 : 61)) throw Error('Historical TEXT date semantics are outside independent audit support')
        return new Date(epoch + numeric(args[0]) * 86400000).toISOString().slice(0, 10)
      }
      default: throw Error('Unsupported Excel function: ' + name)
    }
  }
  function parse(formula, currentSheet) {
    let input = formula.replace(/^=/, ''), index = 0, operations = 0
    const whitespace = () => { while (/\s/.test(input[index] || '') && index < input.length) index++ }
    const take = token => { whitespace(); if (input.startsWith(token, index)) { index += token.length; return true } return false }
    const primary = () => {
      if (++operations > 5000) throw Error('Formula operation budget exceeded')
      whitespace()
      if (take('(')) { const value = comparison(); if (!take(')')) throw Error('Missing parenthesis'); return value }
      if (take('+')) return numeric(primary())
      if (take('-')) return -numeric(primary())
      const tail = input.slice(index), str = tail.match(/^"((?:[^"]|"")*)"/)
      if (str) { index += str[0].length; return str[1].replaceAll('""', '"') }
      const number = tail.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)
      if (number) { index += number[0].length; return Number(number[0]) }
      const reference = tail.match(/^(?:(?:'((?:[^']|'')+)'|([\p{L}\p{N}_. ]+))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)/iu)
      if (reference) {
        index += reference[0].length; const sheet = reference[1]?.replaceAll("''", "'") ?? reference[2]?.trim() ?? currentSheet
        if (take(':')) { const end = input.slice(index).match(/^\$?[A-Z]{1,3}\$?[1-9]\d*/i); if (!end) throw Error('Invalid range end'); index += end[0].length; return range(sheet, reference[3], end[0]) }
        return refValue(sheet, reference[3])
      }
      const identifier = tail.match(/^[A-Za-z_][A-Za-z_\d.]*/)
      if (!identifier) throw Error('Unsupported formula syntax at ' + tail.slice(0, 40))
      index += identifier[0].length
      if (identifier[0].toUpperCase() === 'TRUE') return true
      if (identifier[0].toUpperCase() === 'FALSE') return false
      if (!take('(')) throw Error('Named ranges are not supported')
      const args = [], sources = []
      if (!take(')')) { do { const start = index; args.push(comparison()); sources.push(input.slice(start, index)) } while (take(',')); if (!take(')')) throw Error('Missing function closing parenthesis') }
      return call(identifier[0], args, sources)
    }
    const percent = () => { let value = primary(); while (take('%')) value = numeric(value) / 100; return value }
    const product = () => { let value = percent(); for (;;) { if (take('*')) value = numeric(value) * numeric(percent()); else if (take('/')) { const divisor = numeric(percent()); if (!divisor) throw Error('Division by zero'); value = numeric(value) / divisor } else break } return value }
    const addition = () => { let value = product(); for (;;) { if (take('+')) value = numeric(value) + numeric(product()); else if (take('-')) value = numeric(value) - numeric(product()); else if (take('&')) value = String(value ?? '') + String(product() ?? ''); else break } return value }
    const comparison = () => { let value = addition(); for (const operator of ['<>', '<=', '>=', '=', '<', '>']) if (take(operator)) { const right = addition(); if (typeof value !== 'number' || typeof right !== 'number') throw Error('Nonnumeric comparison is outside independent audit support'); value = operator === '<>' ? value !== right : operator === '<=' ? value <= right : operator === '>=' ? value >= right : operator === '=' ? value === right : operator === '<' ? value < right : value > right; break } return value }
    const value = comparison(); whitespace(); if (index !== input.length || Array.isArray(value)) throw Error('Unsupported trailing syntax or top-level range')
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Non-finite result')
    return value === null ? 0 : value
  }
  return formulas.map(entry => {
    try {
      const computed = refValue(entry.sheet, entry.address), cached = entry.value
      const present = cached !== null && cached !== undefined && cached !== ''
      const equal = typeof computed === 'number' && typeof cached === 'number' ? Math.abs(computed - cached) <= Math.max(1e-7, Math.abs(computed) * 1e-10) : computed === cached
      return { ...entry, computed, status: !present ? 'not-verified' : equal ? 'passed' : 'failed', detail: !present ? 'Expression independently evaluated; no saved cache to compare' : equal ? 'Saved result matches independently evaluated expression' : 'Saved cache differs from independently evaluated expression' }
    } catch (error) { return { ...entry, status: 'not-verified', detail: error.message } }
  })
}

async function inspectPdf(data, item) {
  if (!/^%PDF-\d\.\d/.test(data.subarray(0, 16).toString('ascii'))) throw Error('PDF header is invalid')
  add(item, 'pdf.header', 'passed', 'PDF signature present')
  add(item, 'pdf.eof', /%%EOF\s*$/.test(data.subarray(Math.max(0, data.length - 2048)).toString('latin1')) ? 'passed' : 'failed', 'Checked final PDF end marker')
  let task, document, timeout
  try {
    const library = await import('pdfjs-dist/legacy/build/pdf.mjs')
    task = library.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 })
    const extraction = async () => {
      document = await task.promise
      item.pageCount = document.numPages; item.pages = []
      if (document.numPages > LIMITS.pdfPages) throw Error('PDF page count exceeds text-extraction budget')
      let total = 0
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), content = await page.getTextContent()
        const text = cleanText(content.items.map(x => 'str' in x ? x.str + (x.hasEOL ? '\n' : ' ') : '').join(''))
        total += text.length
        if (total > LIMITS.textChars) throw Error('PDF extracted-text budget exceeded')
        item.pages.push({ number, text }); page.cleanup()
      }
      item._text = item.pages.map(p => p.text).join('\n')
      add(item, 'pdf.text-extraction', item._text.trim() ? 'passed' : 'not-verified', `${document.numPages} parsed pages; ${item._text.length} text characters; image-only pages require visual review`)
    }
    await Promise.race([extraction(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('PDF extraction exceeded 30 seconds')), 30000) })])
  } catch (error) { add(item, 'pdf.text-extraction', ['InvalidPDFException', 'FormatError'].includes(error.name) ? 'failed' : 'not-verified', error.message) }
  finally { clearTimeout(timeout); await task?.destroy().catch(() => {}) }
}

async function inspectFile(root, relativePath) {
  const absolute = path.join(root, relativePath), extension = path.extname(relativePath).toLowerCase()
  const item = { path: slash(relativePath), extension, checks: [] }
  let data
  try {
    const before = await fs.lstat(absolute)
    if (!before.isFile() || before.isSymbolicLink()) throw Error('Only ordinary files are inspected')
    item.bytes = before.size
    if (before.size > LIMITS.fileBytes) { add(item, 'file.budget', 'not-verified', 'File exceeds 32 MiB audit limit'); return item }
    data = await fs.readFile(absolute); item.sha256 = sha(data)
    if (!data.length) throw Error('File is empty')
    if (['.docx', '.pptx', '.xlsx'].includes(extension)) {
      const required = { '.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml', '.xlsx': 'xl/workbook.xml' }[extension]
      const source = await openOffice(data, required)
      item.package = { entries: source.metadata.entries.length, expandedBytes: source.metadata.expanded }
      xml(await source.read(required))
      add(item, 'office.package', 'passed', 'OOXML package, required XML and ZIP budgets verified; package CRC is not verified')
      if (extension === '.xlsx') await inspectSpreadsheet(data, item, source)
      else {
        const parts = extension === '.docx' ? ['word/document.xml'] : Object.keys(source.zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]))
        item.pages = []
        for (const part of parts) {
          const sourceText = await source.read(part)
          item.pages.push({ part, text: officeText(sourceText) })
          if (extension === '.pptx') item.checks.push(...presentationTableTotals(sourceText, part))
        }
        item._text = item.pages.map(p => p.text).join('\n')
        if (extension === '.pptx') item.slideCount = parts.length
        add(item, 'office.text', item._text.trim() ? 'passed' : 'not-verified', `${item._text.length} text characters extracted; DOCX XML is not pagination and PPTX numeric part order is not asserted slide order`)
        add(item, 'office.visual', 'not-verified', 'Independent rendered page/slide review is required; extraction does not verify layout')
      }
    } else if (extension === '.pdf') await inspectPdf(data, item)
    else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      item._text = text
      if (extension === '.csv') {
        const rows = parseCsv(text); item._rows = rows; item.headers = rows[0] || []; item.rowCount = Math.max(0, rows.length - 1)
        const ragged = rows.map((r, i) => ({ row: i + 1, cells: r.length })).filter(r => r.cells !== item.headers.length)
        item.raggedRows = capped(ragged); item.sampleRows = rows.slice(0, 15)
        add(item, 'csv.parse', rows.length && !ragged.length ? 'passed' : 'failed', `${item.rowCount} data rows; ${ragged.length} rows differ from header width`)
        add(item, 'csv.line-endings', /\r\r\n/.test(text) ? 'failed' : 'passed', 'Checked for CRCRLF corruption')
      } else if (extension === '.json') { item._json = JSON.parse(text); add(item, 'json.parse', 'passed', 'JSON parsed independently') }
      else add(item, 'text.decode', 'passed', 'Nonempty UTF-8 text decoded')
    }
    if (item._text?.length > LIMITS.textChars) { item.textTruncated = true; item.textExcerpt = item._text.slice(0, 6000) }
    else item.textExcerpt = item._text?.slice(0, 6000) ?? null
    if (item.pages) item.pages = item.pages.map(p => ({ ...p, text: p.text.slice(0, 6000), textTruncated: p.text.length > 6000 }))
    add(item, 'file.parse', 'passed', 'The format-specific reader completed; this is not overall business acceptance')
  } catch (error) { add(item, 'file.parse', 'failed', error.message) }
  if (data) {
    try { const after = await fs.readFile(absolute); item.sourceUnchanged = sha(after) === item.sha256; add(item, 'file.stable-read', item.sourceUnchanged ? 'passed' : 'not-verified', item.sourceUnchanged ? 'SHA-256 unchanged across inspection' : 'File changed during inspection; rerun after writers finish') }
    catch (error) { item.sourceUnchanged = false; add(item, 'file.stable-read', 'not-verified', error.message) }
  }
  return item
}

function collectExpected(scenario) {
  const result = []
  const walk = (value, context = {}) => {
    if (typeof value === 'string') { result.push({ ...context, revision: context.revision ?? slash(value).split('/').find(x => /^v[12]$/.test(x)), path: value }); return }
    if (Array.isArray(value)) { for (const x of value) walk(x, context); return }
    if (!value || typeof value !== 'object') return
    if (value.path || value.relativePath || value.file) { result.push({ ...context, ...value, path: value.path ?? value.relativePath ?? value.file }); return }
    for (const [key, child] of Object.entries(value)) walk(child, /^v\d+$/.test(key) ? { ...context, revision: key } : { ...context, role: key })
  }
  walk(scenario.expectedArtifacts)
  for (const role of scenario.roles || []) {
    walk(role.expectedArtifacts, { role: role.id })
    for (const version of ['v1', 'v2']) for (const name of role.oracle?.evidenceFiles || []) walk(`departments/${role.id}/${version}/${name}`, { role: role.id, revision: version, purpose: 'role-reported evidence, requires separate provenance' })
    for (const name of role.oracle?.reviewFiles || []) walk(`departments/${role.id}/${name}`, { role: role.id, revision: /\bv2\b/.test(name) ? 'v2' : 'v1', purpose: 'review text, child execution requires runtime evidence' })
    if (role.oracle?.revisionEvidenceFile) walk(`departments/${role.id}/v2/${role.oracle.revisionEvidenceFile}`, { role: role.id, revision: 'v2' })
  }
  return result.filter((x, index) => result.findIndex(y => y.path === x.path && y.role === x.role && y.revision === x.revision) === index)
}

function expectedPath(root, entry) {
  let file = slash(entry.path)
  // Scenario paths containing directories are already company-relative.
  if (!path.isAbsolute(file) && entry.role && !file.includes('/')) file = `departments/${entry.role}/${entry.revision ? entry.revision + '/' : ''}${file}`
  const resolved = path.resolve(root, file)
  if (!inside(root, resolved)) throw Error('Expected artifact escapes company root: ' + entry.path)
  return slash(path.relative(root, resolved))
}

function verifyOracle(check, files, root, context = {}) {
  const entry = { id: check.id || check.name || 'oracle', role: check.role ?? context.role, revision: check.revision ?? context.revision, ...check }
  let file
  try { file = entry.path || entry.file || entry.relativePath ? expectedPath(root, { ...entry, path: entry.path ?? entry.file ?? entry.relativePath }) : null }
  catch (error) { return { ...entry, status: 'failed', detail: error.message } }
  const item = files.find(f => f.path === file), expected = Object.hasOwn(entry, 'expected') ? entry.expected : Object.hasOwn(entry, 'equals') ? entry.equals : entry.value
  if (!item) return { ...entry, path: file, status: 'not-verified', detail: file ? 'Oracle file not found' : 'No independently located source cell/field supplied' }
  let actual
  if (entry.sheet && entry.cell) actual = item._cells?.get(entry.sheet + '!' + entry.cell.toUpperCase())?.value
  else if (Number.isInteger(entry.row) && entry.column !== undefined && item._rows) {
    const column = typeof entry.column === 'number' ? entry.column : item.headers.indexOf(entry.column)
    actual = item._rows[entry.row]?.[column]
  } else if (entry.jsonPath && item._json) actual = String(entry.jsonPath).replace(/^\$\.?/, '').split('.').filter(Boolean).reduce((v, key) => v?.[key], item._json)
  else if (entry.contains !== undefined || entry.textIncludes !== undefined) {
    const needles = [entry.contains ?? entry.textIncludes].flat(), present = needles.every(value => item._text?.includes(String(value)))
    return { ...entry, path: file, status: present ? 'passed' : 'failed', detail: 'Exact text presence only; not semantic correctness', actual: present }
  } else return { ...entry, path: file, status: 'not-verified', detail: 'Oracle has no supported cell/CSV/JSON/text locator' }
  if ((actual === undefined || actual === null || actual === '') && expected === null && entry.sheet && entry.cell) return { ...entry, path: file, status: 'passed', actual: actual ?? null, detail: 'Expected empty date cell is blank' }
  if (actual === undefined || (actual === null && expected !== null)) return { ...entry, path: file, status: 'failed', actual: actual ?? null, detail: 'Located value is missing or its formula has no saved cache' }
  const matches = typeof expected === 'number' ? Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= (entry.tolerance ?? 0.005) : JSON.stringify(actual) === JSON.stringify(expected)
  return { ...entry, path: file, status: matches ? 'passed' : 'failed', actual, detail: 'Independent located saved-value comparison; formulas have not been recalculated' }
}

function oracleChecks(oracle, context = {}) {
  if (!oracle || typeof oracle !== 'object') return []
  if (Array.isArray(oracle)) return oracle.flatMap(value => oracleChecks(value, context))
  if (oracle.path || oracle.file || oracle.relativePath || oracle.cell || oracle.jsonPath || oracle.contains || oracle.textIncludes) return [{ ...context, ...oracle }]
  return Object.entries(oracle).flatMap(([key, value]) => key === 'checks' ? oracleChecks(value, context) : /^v\d+$/.test(key) ? oracleChecks(value, { ...context, revision: key }) : value && typeof value === 'object' ? oracleChecks(value, { ...context, role: context.role ?? key }) : [{ ...context, id: key, expected: value }])
}

function scenarioRoleChecks(scenario, files, root, revision) {
  const checks = []
  const compare = (id, actual, expected, extra = {}) => {
    const same = typeof expected === 'number' ? typeof actual === 'number' && Math.abs(actual - expected) <= 0.01 : actual === expected
    checks.push({ id, ...extra, expected, actual: actual ?? null, status: same ? 'passed' : 'failed', detail: 'Independent comparison against scenario business oracle' })
  }
  for (const role of scenario.roles || []) for (const version of ['v1', 'v2']) {
    if (revision !== 'all' && revision !== version) continue
    const metrics = role.oracle?.[version]
    if (!metrics) continue
    const prefix = `departments/${role.id}/${version}/`, summary = files.find(f => f.path === prefix + 'summary.json')
    if (!summary?._json) checks.push({ id: `${role.id}.${version}.summary`, path: prefix + 'summary.json', status: 'failed', detail: 'Structured handoff summary is missing or invalid' })
    else {
      for (const [key, expected] of Object.entries({ role: role.id, version, period: role.oracle.period, currency: role.oracle.currency })) compare(`${role.id}.${version}.summary.${key}`, summary._json[key], expected, { path: summary.path, evidenceClass: 'handoff-summary' })
      for (const [key, expected] of Object.entries(metrics)) compare(`${role.id}.${version}.summary.metrics.${key}`, summary._json.metrics?.[key], expected, { path: summary.path, evidenceClass: 'handoff-summary-only' })
    }
    const located = (role.artifactChecks || []).filter(x => x.revision === version)
    for (const artifact of located) for (const check of artifact.checks || []) {
      checks.push(verifyOracle({ ...check, id: `${role.id}.${version}.workbook.${check.metric}`, role: role.id, revision: version, path: artifact.path }, files, root))
      if (check.labelCell) checks.push(verifyOracle({ id: `${role.id}.${version}.workbook.${check.metric}.label`, path: artifact.path, sheet: check.sheet, cell: check.labelCell, expected: check.metric }, files, root))
    }
    if (!located.some(x => x.checks?.length)) checks.push({ id: `${role.id}.${version}.formal-business-semantics`, status: 'not-verified', detail: 'Summary is not formal-document proof; PDF/PPTX/DOCX narrative metrics require independent semantic/visual review' })
    const slides = files.filter(f => f.path.startsWith(prefix) && f.extension === '.pptx')
    for (const slide of slides) if (role.id === 'sales' || role.id === 'product') compare(`${role.id}.${version}.slides`, slide.slideCount, role.id === 'sales' ? 6 : 5, { path: slide.path })
    if (role.id === 'sales') {
      const file = files.find(f => f.path === prefix + 'account-actions.csv')
      if (file?._rows) {
        const required = ['entity_id', 'customer', 'owner', 'next_action', 'due_date', 'net_amount', 'probability', 'weighted_amount', 'status']
        const missing = required.filter(key => !file.headers.includes(key))
        checks.push({ id: `sales.${version}.csv.headers`, status: missing.length ? 'failed' : 'passed', path: file.path, detail: missing.length ? `Missing ${missing.join(', ')}` : 'All required action columns are present' })
        const rows = file._rows.slice(1).map(row => Object.fromEntries(file.headers.map((key, index) => [key, row[index]])))
        const ids = ['C101', 'C102', 'C103', 'O201', 'O202', 'O203']
        for (const id of ids) compare(`sales.${version}.csv.unique.${id}`, rows.filter(row => row.entity_id === id).length, 1, { path: file.path })
        const contracts = rows.filter(row => /^C10[123]$/.test(row.entity_id)), opportunities = rows.filter(row => /^O20[123]$/.test(row.entity_id))
        compare(`sales.${version}.csv.signed-net`, contracts.reduce((sum, row) => sum + Number(row.net_amount), 0), metrics.signedNetTotal, { path: file.path })
        compare(`sales.${version}.csv.weighted-pipeline`, opportunities.reduce((sum, row) => sum + Number(row.net_amount) * Number(row.probability), 0), metrics.weightedPipeline, { path: file.path })
        for (const row of opportunities) compare(`sales.${version}.csv.weighted.${row.entity_id}`, Number(row.weighted_amount), Number(row.net_amount) * Number(row.probability), { path: file.path })
        const paymentColumn = ['remaining_due_date', 'receivable_due_date'].find(key => file.headers.includes(key))
        if (paymentColumn) compare(`sales.${version}.csv.c103-date`, contracts.find(row => row.entity_id === 'C103')?.[paymentColumn], metrics.c103DueDate, { path: file.path })
        else checks.push({ id: `sales.${version}.csv.c103-date`, path: file.path, status: 'not-verified', actual: contracts.find(row => row.entity_id === 'C103')?.due_date, expected: metrics.c103DueDate, detail: 'Scenario due_date is an action deadline, not explicitly a payment date. Do not misdiagnose launch/action dates as incorrect receivables; verify payment date in the original presentation separately.' })
      } else checks.push({ id: `sales.${version}.csv`, status: 'failed', detail: 'Actual sales CSV could not be read' })
    }
    if (role.id === 'legal') {
      const file = files.find(f => f.path === prefix + 'document-register.txt')
      if (file?._text) {
        const rows = file._text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split('\t')), headers = rows[0]
        const required = ['document_id', 'owner_role', 'title', 'classification', 'expected_version'], missing = required.filter(key => !headers.includes(key))
        checks.push({ id: `legal.${version}.register.headers`, status: missing.length ? 'failed' : 'passed', path: file.path, detail: missing.length ? `Missing TSV columns: ${missing.join(', ')}` : 'Required TSV register columns exist' })
        const records = rows.slice(1).map(row => Object.fromEntries(headers.map((key, index) => [key, row[index]])))
        compare(`legal.${version}.register.count`, records.length, metrics.registeredDocumentCount, { path: file.path })
        for (let n = 1; n <= 12; n++) { const id = `D${String(n).padStart(3, '0')}`; compare(`legal.${version}.register.unique.${id}`, records.filter(row => row.document_id === id).length, 1, { path: file.path }) }
        compare(`legal.${version}.register.version`, records.filter(row => row.expected_version === version).length, 12, { path: file.path })
      } else checks.push({ id: `legal.${version}.register`, status: 'failed', detail: 'Actual document-register TSV could not be read' })
    }
    const crud = files.find(f => f.path === prefix + 'crud.json'), browser = files.find(f => f.path === prefix + 'browser-evidence.json')
    checks.push({ id: `${role.id}.${version}.crud-provenance`, status: 'not-verified', path: crud?.path ?? prefix + 'crud.json', detail: 'Role-written CRUD report does not prove actual create/read/update/delete tool activity; correlate runtime events separately' })
    checks.push({ id: `${role.id}.${version}.browser-provenance`, status: 'not-verified', path: browser?.path ?? prefix + 'browser-evidence.json', detail: 'Role-written browser report does not prove the native browser actually opened/rendered the correct local resource' })
    const review = files.find(f => f.path === `departments/${role.id}/audit/${version}-review.md`)
    checks.push({ id: `${role.id}.${version}.child-review-provenance`, status: 'not-verified', path: review?.path ?? `departments/${role.id}/audit/${version}-review.md`, detail: 'Review text requires independently bound child session, terminal result and tool-read evidence' })
  }
  return checks
}

async function readJsonOptional(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

async function externalOfficeEvidence(evidence) {
  const calls = [], snapshots = [], pattern = /(?:new-object\s+-comobject|win32com|(?:KWps|KWpp|Ket|Excel|Word|PowerPoint)\.Application|(?:soffice|libreoffice)(?:\.exe)?)/i
  const automation = /(?:new-object\s+-comobject|(?:DispatchEx|Dispatch|EnsureDispatch)\s*\(|(?:soffice|libreoffice)(?:\.exe)?)/i
  const files = (await fs.readdir(evidence)).filter(name => name.endsWith('-pre-builtin-retest.json')).sort()
  for (const name of files) {
    const file = path.join(evidence, name), stat = await fs.stat(file)
    if (stat.size > 32 * 1024 ** 2) { snapshots.push({ file: name, status: 'not-verified', reason: 'Snapshot exceeds audit budget' }); continue }
    const data = await fs.readFile(file), snapshot = JSON.parse(data), history = snapshot.history || [], role = name.replace('-pre-builtin-retest.json', '')
    snapshots.push({ file: name, sha256: sha(data), role, sessionId: snapshot.sessionId, rootRunId: snapshot.run?.runId, rootStatus: snapshot.run?.status, projectionTruncated: snapshot.projectionTruncated })
    const scripts = new Map()
    for (const message of history) {
      const call = message.toolCall, args = call?.args
      if (!call || !args) continue
      const target = args.path ?? args.filePath, text = typeof args.data === 'string' ? args.data : typeof args.content === 'string' ? args.content : ''
      if (target && /\.(?:py|ps1|mjs|cjs|js)$/i.test(target) && pattern.test(text)) scripts.set(slash(target).toLowerCase(), { path: target, scriptCreationCallId: call.id, containsAutomation: automation.test(text) })
    }
    for (const message of history) {
      const call = message.toolCall, args = call?.args
      if (!call || !['execute_cmd', 'run_command', 'run_terminal_command', 'terminal_exec'].includes(call.name) || !args) continue
      const argumentText = JSON.stringify(args), normalized = slash(argumentText).toLowerCase()
      const linked = [...scripts.values()].filter(script => normalized.includes(path.basename(script.path).toLowerCase()))
      if (!pattern.test(argumentText) && !linked.length) continue
      const result = history.find(row => row.role === 'tool' && row.toolCallId === call.id)
      const technologies = [...new Set((argumentText.match(/(?:KWps|KWpp|Ket|Excel|Word|PowerPoint)\.Application|win32com|soffice|libreoffice/gi) || []))]
      calls.push({ role, snapshot: name, callId: call.id, tool: call.name, at: new Date(message.createdAt).toISOString(), rootRunId: message.metadata?.rootRunId,
        actionKind: automation.test(argumentText) || linked.some(x => x.containsAutomation) ? 'external-office-automation-attempt' : 'external-office-dependency-probe',
        executable: args.command ?? args.executable ?? null, directExternalOfficeCode: pattern.test(argumentText), technologies, scripts: linked,
        resultObserved: Boolean(result), reportedToolSuccess: result?.metadata?.success ?? null, reportedToolStatus: result?.metadata?.status ?? null,
        finding: 'External Office/COM execution attempt is excluded from Aether built-in acceptance; a tool invocation does not alone prove COM completed successfully' })
    }
  }
  return { policy: 'WPS, Office COM and external office applications do not qualify as Aether built-in capabilities. These are preserved pre-retest historical snapshots, not proof about future runs.', snapshots, executionAttempts: calls, automationAttempts: calls.filter(x => x.actionKind === 'external-office-automation-attempt').length, dependencyProbes: calls.filter(x => x.actionKind === 'external-office-dependency-probe').length, rolesWithAttempts: [...new Set(calls.map(x => x.role))], status: calls.length ? 'excluded-from-builtin-acceptance' : 'no-observed-attempts-in-supplied-snapshots' }
}

async function nativeToolPolicyEvidence(evidence, policy, scope = {}) {
  if (policy?.mode !== 'aether-native-only') return { status: 'not-requested', detail: 'Scenario does not declare the strict native-only policy', snapshots: [], violations: [] }
  const allowed = new Set(policy.allowedTools || []), forbidden = new Set(policy.forbiddenTools || []), calls = new Map(), snapshots = [], violations = [], childRuns = new Map()
  const roleBySession = new Map(Object.entries(scope.roles || {}).flatMap(([roleId, role]) => [role, ...(role.priorSessions || [])].filter(session => session.sessionId).map(session => [session.sessionId, roleId])))
  let incompleteSnapshots = 0, bytesRead = 0
  const names = (await fs.readdir(evidence)).filter(name => /(?:snapshot[^/]*|pre-builtin-retest|builtin-retest|builtin-final|native-final|native-latest)\.json$/i.test(name)).sort()
  for (const name of names) {
    if (scope.revision === 'v1' && !/-v1(?:-|\.)/.test(name)) continue
    const file = path.join(evidence, name), size = (await fs.stat(file)).size
    if (size > 32 * 1024 ** 2 || bytesRead + size > 128 * 1024 ** 2) { snapshots.push({ path: name, status: 'not-verified', detail: 'Runtime snapshot exceeds individual/aggregate audit budget' }); incompleteSnapshots++; continue }
    bytesRead += size
    const bytes = await fs.readFile(file), snapshot = JSON.parse(bytes)
    if (!Array.isArray(snapshot.history)) continue
    snapshots.push({ path: name, sha256: sha(bytes), sessionId: snapshot.sessionId, rootRunId: snapshot.run?.runId, rootStatus: snapshot.run?.status, projectionTruncated: snapshot.projectionTruncated, historyCompacted: snapshot.historyCompacted, messages: snapshot.history.length })
    if (snapshot.projectionTruncated || snapshot.historyCompacted) incompleteSnapshots++
    for (const run of snapshot.subagentRuns || []) if (run.runId && (!childRuns.has(run.runId) || (run.updatedAt ?? 0) >= (childRuns.get(run.runId).updatedAt ?? 0))) {
      const role = roleBySession.get(run.rootSessionId) ?? roleBySession.get(run.parentSessionId)
      childRuns.set(run.runId, { role, runId: run.runId, childSessionId: run.childSessionId, parentSessionId: run.parentSessionId, rootSessionId: run.rootSessionId,
        status: run.status, stopReason: run.stopReason, updatedAt: run.updatedAt, readOnly: run.continuation?.readOnly, toolNames: run.continuation?.toolNames || [], snapshot: name,
        parentToolCallId: run.parentToolCallId, resumeFromRunId: run.resumeFromRunId ?? null,
        toolCallIds: (run.toolCalls || []).map(call => call.id).filter(Boolean) })
    }
    const results = new Map(snapshot.history.filter(row => row.role === 'tool' && row.toolCallId).map(row => [row.toolCallId, row]))
    for (const message of snapshot.history) {
      const call = message.toolCall
      if (!call?.name || !call.id) continue
      const rootRunId = message.metadata?.rootRunId ?? snapshot.run?.runId ?? null
      const identity = JSON.stringify([snapshot.sessionId, call.id]), previous = calls.get(identity)
      const args = call.args || {}, result = results.get(call.id), metadata = result?.metadata ?? {}
      const target = metadata.path ?? metadata.change?.path ?? args.path ?? args.filePath
      if (previous?.resultObserved && !result) continue
      const proof = { snapshot: name, sessionId: snapshot.sessionId, rootRunId, callId: call.id, tool: call.name,
        path: typeof target === 'string' ? target : null, requestPath: args.path ?? args.filePath ?? null,
        pathAuthority: metadata.path || metadata.change?.path ? 'tool-receipt' : typeof target === 'string' && path.isAbsolute(target) ? 'absolute-request' : 'unresolved-relative-request',
        resultObserved: Boolean(result), reportedToolSuccess: metadata.success ?? null, reportedToolStatus: metadata.status ?? null,
        reportedCode: metadata.code ?? null,
        returnedSha256: digest(metadata.expectedHash ?? metadata.change?.newHash ?? metadata.newHash),
        operation: call.name === 'office_inspect' ? 'inspect' : args.operation ?? null, format: typeof target === 'string' ? path.extname(target).slice(1).toLowerCase() : null }
      if (call.name === 'calculate') proof.calculation = { expression: args.expression ?? null, output: typeof result?.content === 'string' ? result.content.slice(0,1000) : null }
      if (call.name.startsWith('browser_')) {
        let body = null
        try { if (typeof result?.content === 'string') body = JSON.parse(result.content) } catch { /* Truncated observations remain explicitly partial. */ }
        proof.browser = { requestedUrl: args.url ?? null, requestedTabId: args.tabId ?? null, operationPerformed: metadata.operationPerformed ?? null,
          tabId: body?.tabId ?? body?.tab?.tabId ?? null, url: body?.url ?? body?.tab?.url ?? null, title: body?.title ?? body?.tab?.title ?? null,
          contextSessionId: body?.context?.sessionId ?? null, outputTruncated: Boolean(metadata.outputTruncated),
          screenshotReceiptPresent: call.name === 'browser_screenshot' && typeof body?.dataUrl === 'string' && body.dataUrl.startsWith('data:image/') }
      }
      if (previous && (previous.tool !== proof.tool || previous.requestPath !== proof.requestPath || previous.operation !== proof.operation)) proof.identityConflict = true
      if (previous?.identityConflict) proof.identityConflict = true
      calls.set(identity, proof)
    }
  }
  const observed = [...calls.values()]
  for (const proof of observed) {
    if (forbidden.has(proof.tool) || !allowed.has(proof.tool)) violations.push({ ...proof, reason: 'Actual tool invocation is outside the scenario native-only allowlist' })
    if (['write_file', 'edit_file'].includes(proof.tool) && /\.(?:py|ps1|sh|bat|cmd|vbs|mjs|cjs|js|vba)$/i.test(proof.requestPath ?? '')) violations.push({ ...proof, reason: 'Scenario forbids generating executable scripts or macros as an Office workaround' })
    if (proof.identityConflict) violations.push({ ...proof, reason: 'Conflicting call identity across supplied runtime snapshots' })
    const child = [...childRuns.values()].find(run => run.childSessionId === proof.sessionId), role = roleBySession.get(proof.sessionId) ?? child?.role
    const mutation = ['write_file', 'edit_file', 'delete_file', 'create_dir'].includes(proof.tool) || proof.tool === 'office_document' && proof.operation !== 'inspect'
    if (mutation && child?.readOnly) violations.push({ ...proof, reason: 'Read-only child attempted a mutating operation' })
    if (mutation && role && scope.root && typeof proof.path === 'string' && path.isAbsolute(proof.path)) {
      const department = path.join(scope.root, 'departments', role)
      if (!inside(department, path.resolve(proof.path))) violations.push({ ...proof, reason: 'Mutation target is outside the owning department' })
      if (proof.tool === 'delete_file' && !inside(path.join(department, 'scratch'), path.resolve(proof.path))) violations.push({ ...proof, reason: 'Scenario permits deleting only the owning department scratch files; formal/version file deletion is forbidden' })
    }
  }
  const children = [...childRuns.values()].map(run => ({ ...run, childSnapshotObserved: snapshots.some(snapshot => snapshot.sessionId === run.childSessionId), calculateAvailable: run.toolNames.includes('calculate'), toolsOutsidePolicy: run.toolNames.filter(tool => !allowed.has(tool)),
    originalReadReceipts: run.toolCallIds.map(id => calls.get(JSON.stringify([run.childSessionId, id]))).filter(call => call && (call.tool === 'read_file' || call.tool === 'office_inspect' || call.tool === 'office_document' && call.operation === 'inspect') && /\.(?:xlsx|docx|pptx|pdf|csv|txt)$/i.test(call.path ?? '')),
    calculateReceipts: run.toolCallIds.map(id => calls.get(JSON.stringify([run.childSessionId, id]))).filter(call => call?.tool === 'calculate') }))
  return { status: violations.length ? 'failed' : !observed.length || incompleteSnapshots ? 'not-verified' : 'no-violations-observed', observedCalls: observed.length, incompleteSnapshots, snapshots, violations,
    childCoverage: { runs: children, distinctSessions: new Set(children.map(child => child.childSessionId)).size, missingSessionSnapshots: [...new Set(children.filter(child => !child.childSnapshotObserved).map(child => child.childSessionId))], limitation: 'Runtime child configuration and observed snapshots establish supplied coverage only; availability of a tool is distinct from an actual successful invocation.' },
    nativeOfficeCalls: observed.filter(call => ['office_document', 'office_inspect'].includes(call.tool)), fileReadCalls: observed.filter(call => call.tool === 'read_file' || call.tool === 'office_inspect' || call.tool === 'office_document' && call.operation === 'inspect'),
    browserCalls: observed.filter(call => call.tool.startsWith('browser_')),
    limitations: 'Deduplicated actual calls from supplied snapshots only. A clean parent snapshot does not prove unobserved child history or complete runtime coverage; child snapshots and file/tool result binding require separate evidence. Native calls alone do not prove successful file mutation.' }
}

function handoffChecks(scenario, files, root, roles, reads) {
  const checks = [], normalized = value => slash(path.resolve(value)).toLowerCase()
  const receiverSessions = roleId => [roles[roleId], ...(roles[roleId]?.priorSessions || [])].map(session => session?.sessionId).filter(Boolean)
  const successfulRead = (roleId, relative) => reads.filter(call => receiverSessions(roleId).includes(call.sessionId) && call.resultObserved && call.reportedToolSuccess === true
    && call.reportedToolStatus === 'succeeded' && !call.identityConflict && typeof call.path === 'string' && path.isAbsolute(call.path) && normalized(call.path) === normalized(path.join(root, relative)))
  const push = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra })
  for (const role of scenario.roles || []) {
    const ackPath = `departments/${role.id}/v2/ack.json`, ack = files.find(file => file.path === ackPath)?._json
    if (!ack) { push(`${role.id}.v2.ack`, 'failed', 'ACK is missing or not valid JSON', { path: ackPath }); continue }
    push(`${role.id}.v2.ack.identity`, ack.role === role.id && ack.revision === 'CC-2026-11-02' ? 'passed' : 'failed', 'ACK role and revision identity checked', { path: ackPath })
    const expected = (role.handoffSources || []).map(source => ({ path: slash(source), fromRole: slash(source).split('/')[1] }))
    const received = Array.isArray(ack.received) ? ack.received : []
    for (const entry of received) {
      const sender = expected.find(source => source.fromRole === entry.fromRole), id = `${role.id}.v2.ack.${entry.fromRole ?? 'unknown'}`
      let relative
      try { relative = expectedPath(root, { path: entry.path }) } catch { relative = null }
      const file = files.find(file => file.path === relative)
      const assignedSource = Boolean(sender && relative?.startsWith(`departments/${entry.fromRole}/v1/`))
      const ownSource = entry.fromRole === role.id && relative?.startsWith(`departments/${role.id}/v1/`)
      const revisionSource = [role.id, 'company-inputs'].includes(entry.fromRole) && relative === 'inputs/v2/revision.json'
      // Additional self-review/input receipts are useful provenance but cannot substitute for a required handoff.
      const valid = Boolean((assignedSource || ownSource || revisionSource) && ['accepted', 'needs-update', 'blocked'].includes(entry.decision))
      push(id + '.source', valid ? 'passed' : 'failed', 'ACK source must identify an assigned v1 department, its own v1 source or the v2 revision input, with a valid decision', { path: relative ?? entry.path, sourceKind: assignedSource ? 'handoff' : revisionSource ? 'revision' : ownSource ? 'self-review' : 'invalid' })
      if (!valid) continue
      push(id + '.version', entry.observedVersion === (revisionSource ? 'v2' : 'v1') ? 'passed' : 'failed', 'Machine-readable observedVersion must be v1 for original sources or v2 for the revision input; descriptive notes belong in a separate field', { path: relative, observedVersion: entry.observedVersion })
      if (entry.sha256 == null) push(id + '.hash', Array.isArray(entry.missingEvidence) && entry.missingEvidence.length ? 'not-verified' : 'failed', 'Missing receipt hash must be disclosed; it is not verified provenance', { path: relative })
      else push(id + '.hash', !file?.sha256 ? 'not-verified' : digest(entry.sha256) === file.sha256.toLowerCase() ? 'passed' : 'failed', 'ACK receipt hash compared with independently read source bytes; excluded/missing source must be audited separately', { path: relative, expectedSha256: file?.sha256 ?? null, reportedSha256: entry.sha256 })
      const read = successfulRead(role.id, relative)
      push(id + '.runtime-read', read.length ? 'passed' : 'not-verified', read.length ? 'Matching successful read by this role current/prior parent session was observed' : 'No matching successful parent read in supplied runtime evidence', { path: relative, callIds: read.map(call => call.callId), receiverSessions: [...new Set(read.map(call => call.sessionId))] })
      if (entry.decision !== 'blocked') push(id + '.facts-present', Array.isArray(entry.factsUsed) && entry.factsUsed.length ? 'passed' : 'failed', 'Accepted/needs-update ACK must identify concrete facts used; their meaning needs manual comparison')
    }
    for (const source of expected) {
      const entries = received.filter(entry => entry.fromRole === source.fromRole)
      push(`${role.id}.v2.handoff.${source.fromRole}.ack`, entries.length ? 'passed' : 'failed', `${entries.length} ACK entries for required sender ${source.fromRole}`)
      const summaryReads = successfulRead(role.id, source.path)
      push(`${role.id}.v2.handoff.${source.fromRole}.summary-read`, summaryReads.length ? 'passed' : 'not-verified', 'Required handoff summary read requires a successful receiver-session receipt', { path: source.path, callIds: summaryReads.map(call => call.callId) })
      const artifacts = (scenario.roles || []).find(candidate => candidate.id === source.fromRole)?.expectedArtifacts?.filter(file => slash(file).includes('/v1/')) || []
      const originalReads = artifacts.flatMap(file => successfulRead(role.id, file))
      push(`${role.id}.v2.handoff.${source.fromRole}.original-read`, originalReads.length ? 'passed' : 'not-verified', 'At least one assigned sender original artifact must also be read, beyond summary.json', { callIds: originalReads.map(call => call.callId) })
    }
    push(`${role.id}.v2.ack.semantic-review`, 'not-verified', 'ACK facts, differences and decisions require independent comparison with source content and revision; schema/hash/read receipts alone do not prove correct coordination')
  }
  return checks
}

async function versionPreservation(root, evidence, scenario) {
  const baseline = await readJsonOptional(path.join(evidence, 'v1-baseline-hashes.json')), checks = []
  if (!baseline) return { checks: [{ id: 'versions.v1-baseline', status: 'not-verified', detail: 'Capture v1-baseline-hashes.json independently after v1 completion and before submitting v2; current hashes cannot prove prior bytes' }] }
  const entries = Array.isArray(baseline.files) ? baseline.files : []
  if (entries.length > LIMITS.files) return { checks: [{ id: 'versions.v1-baseline', status: 'not-verified', detail: 'Baseline exceeds audit file budget' }] }
  checks.push({ id: 'versions.v1-baseline-phase', status: baseline.phase === 'v1-complete-before-v2' && Number.isFinite(Date.parse(baseline.capturedAt)) ? 'passed' : 'not-verified', detail: 'Baseline must identify the v1-complete-before-v2 capture phase and timestamp' })
  const required = collectExpected(scenario).filter(entry => entry.revision === 'v1').map(entry => expectedPath(root, entry))
  for (const relative of required) checks.push({ id: 'versions.v1-baseline-coverage', path: relative, status: entries.some(entry => slash(entry.path) === relative) ? 'passed' : 'not-verified', detail: 'Expected v1 delivery must be covered by independent pre-v2 baseline' })
  for (const entry of entries) {
    try {
      const relative = expectedPath(root, entry), absolute = path.join(root, relative)
      if (!/^(?:departments\/[^/]+\/(?:v1\/|audit\/v1-review\.md$)|inputs\/v1\/)/.test(relative)) throw Error('Baseline path is outside a v1 delivery, v1 input or v1 child review')
      const stat = await fs.lstat(absolute)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes || !inside(root, await fs.realpath(absolute))) throw Error('Baseline target is missing, unsafe or exceeds file budget')
      const actualSha256 = sha(await fs.readFile(absolute))
      checks.push({ id: 'versions.v1-byte-preservation', path: relative, status: /^[a-f\d]{64}$/i.test(entry.sha256 ?? '') && actualSha256 === entry.sha256.toLowerCase() && (entry.bytes === undefined || entry.bytes === stat.size) ? 'passed' : 'failed', detail: 'Current original bytes compared with pre-v2 baseline', expectedSha256: entry.sha256, actualSha256, bytes: stat.size })
    } catch (error) { checks.push({ id: 'versions.v1-byte-preservation', path: entry.path, status: 'failed', detail: error.message }) }
  }
  return { capturedAt: baseline.capturedAt, phase: baseline.phase, checks }
}

async function walkFiles(root) {
  const files = [], issues = []; let bytes = 0
  const walk = async relative => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const rel = path.join(relative, entry.name)
      if (entry.isSymbolicLink()) { issues.push({ path: slash(rel), status: 'not-verified', detail: 'Symlink excluded from audit' }); continue }
      if (entry.isDirectory()) { if (!['.git', 'node_modules', '.venv', '__pycache__'].includes(entry.name)) await walk(rel); continue }
      if (!entry.isFile() || !SUPPORTED.has(path.extname(entry.name).toLowerCase())) continue
      const stat = await fs.stat(path.join(root, rel)); bytes += stat.size
      if (files.length >= LIMITS.files || bytes > LIMITS.totalBytes) throw Error('Company scan exceeds audit budget')
      files.push(rel)
    }
  }
  await walk(''); return { files, issues, bytes }
}

async function checkSeeds(root, evidence, scenario) {
  const supplied = await readJsonOptional(path.join(evidence, 'seed-hashes.json'))
  let entries = []
  if (supplied) {
    const raw = supplied.files ?? supplied.hashes ?? supplied
    entries = Array.isArray(raw) ? raw.map(item => ({ path: item.path ?? item.relativePath, sha256: item.sha256 ?? item.hash })) : Object.entries(raw).filter(([, v]) => typeof v === 'string' && /^[a-f\d]{64}$/i.test(v) || v?.sha256).map(([file, value]) => ({ path: file, sha256: typeof value === 'string' ? value : value.sha256 }))
  } else if (Array.isArray(scenario.seedFiles)) entries = scenario.seedFiles.filter(x => typeof x.content === 'string').map(x => ({ path: x.path, sha256: sha(Buffer.from(x.content)) }))
  const checks = []
  for (const entry of entries) {
    try {
      const file = path.resolve(root, entry.path)
      if (!inside(root, file) || (await fs.lstat(file)).isSymbolicLink() || !inside(root, await fs.realpath(file))) throw Error('Input path leaves company root or is a symlink')
      const actual = sha(await fs.readFile(file)); checks.push({ path: slash(entry.path), expectedSha256: entry.sha256, actualSha256: actual, status: actual === entry.sha256 ? 'passed' : 'failed' })
    } catch (error) { checks.push({ path: entry.path, status: 'failed', detail: error.message }) }
  }
  return { source: supplied ? 'seed-hashes.json' : entries.length ? 'scenario.seedFiles content' : 'unavailable', checks }
}

function markdown(report) {
  const rows = report.expected.map(x => `| ${x.path} | ${x.status} | ${String(x.detail).replaceAll('|', '\\|')} |`).join('\n')
  const issues = report.files.flatMap(file => file.checks.filter(c => c.status !== 'passed').map(c => `- ${file.path}: **${file.temporaryCandidate ? 'temporary-file observation' : c.status}** — ${c.id}: ${c.detail}`))
  const external = report.externalOfficeEvidence
  const externalRows = external.rolesWithAttempts.map(role => `- ${role}: ${external.executionAttempts.filter(x => x.role === role).length} actual tool execution attempts (call IDs, source script links and snapshot hashes in JSON).`).join('\n')
  const policy = report.nativeToolPolicyEvidence
  const policySummary = policy.status === 'not-requested' ? 'Strict native tool policy was not declared by this scenario.' : `Strict native tool policy: **${policy.status}**; ${policy.observedCalls} distinct tool calls, ${policy.violations.length} violations. Supplied snapshots do not establish unobserved child coverage.`
  return `# Office independent file audit\n\nGenerated: ${report.generatedAt}\n\nStatus: **${report.status}**; current file assessment: **${report.assessmentStatus}**. This is a file/content audit, not UI, engine reliability or visual acceptance. An in-progress snapshot is not a final delivery verdict.\n\n- Parsed files: ${report.files.length}\n- Failed checks: ${report.summary.failed}\n- Not verified: ${report.summary.notVerified}\n- Source input hash checks: ${report.seeds.checks.length}\n- Temporary files observed: ${report.temporaryFiles.length} (observations, not automatic failures)\n\n## Built-in capability acceptance boundary\n\n**WPS, Office COM and external office applications are disqualified from Aether built-in acceptance.** Historical external generation, recalculation, export and rendering steps must be repeated through Aether-owned capabilities. A tool invocation proves an attempt, not that COM succeeded.\n\n${externalRows || '- No external Office execution observed in the supplied pre-retest snapshots; absence here is not proof that all tools were covered.'}\n\n${policySummary}\n\n## Promised artifacts\n\n| Path | Status | Evidence |\n| --- | --- | --- |\n${rows || '| No expectations | not-verified | scenario expectedArtifacts absent |'}\n\n## Oracle checks\n\n${report.oracle.map(x => `- ${x.id}: **${x.status}** — ${x.detail}${x.actual !== undefined ? '; actual=' + JSON.stringify(x.actual) : ''}`).join('\n') || '- No business oracle available.'}\n\n## Remaining checks\n\n${issues.join('\n') || '- No format-level issue observed.'}\n\n## Limits\n\n${report.limitations.map(x => '- ' + x).join('\n')}\n`
}

export async function auditOfficeCurrent(companyRoot, options = {}) {
  const root = await fs.realpath(path.resolve(companyRoot)), evidence = path.join(path.dirname(root), 'evidence')
  const scenario = await readJsonOptional(path.join(evidence, 'scenario.json')) || {}
  const revision = options.revision || 'all'
  if (!['all', 'v1', 'v2'].includes(revision)) throw Error('revision must be v1, v2 or all')
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), companyRoot: root, revision, limits: LIMITS, snapshotPhase: options.inProgress ? 'in-progress' : 'audit-requested',
    status: 'not-verified', checks: [], expected: [], files: [], oracle: [], temporaryFiles: [],
    limitations: ['No writes to company files; reports only in sibling evidence.', 'No document macros, external links, generated scripts, app or model calls are executed.', 'Source SHA stability proves the two observed reads, not the absence of transient writes.', 'Formula interpreter covers arithmetic, cell/range references, SUM/COUNT/COUNTA/MIN/MAX/AVERAGE/ROUND/IF/AND/OR/DATE and ISO-date TEXT. It is not a complete Excel calculation engine; unsupported formulas remain unverified. IF arguments are evaluated eagerly, so unsupported unused branches may be conservatively unverified.', 'Saved formula results and a zero saved-error count do not establish business correctness or the intended semantic reference. Formula evaluation does not write caches or perturb inputs.', 'DOCX/PPTX/PDF text extraction does not verify page layout; independent visual and real Work UI acceptance remain required.', 'Unlocated oracle values are not treated as verified merely because matching digits occur somewhere.', 'Deletion/CRUD provenance, session isolation, browser and Git behavior, and 7×24 reliability require separate runtime evidence.'] }
  let scan
  try { scan = await walkFiles(root); report.checks.push(...scan.issues); report.scannedBytes = scan.bytes }
  catch (error) { report.checks.push({ id: 'scan.complete', status: 'not-verified', detail: error.message }); scan = { files: [] } }
  let retainedExtractBytes = 0
  for (const file of scan.files) {
    const temporaryCandidate = /(^|\/)(?:tmp|temp|scratch|crud|\.work)(\/|$)|(?:\.tmp|\.bak)(?:\.|$)|(^|\/)~\$/i.test(slash(file))
    if (temporaryCandidate) report.temporaryFiles.push(slash(file))
    const observedRevision = slash(file).split('/').find(x => /^v[12]$/.test(x))
    if (revision !== 'all' && observedRevision && observedRevision !== revision) continue
    const inspected = await inspectFile(root, file)
    inspected.temporaryCandidate = temporaryCandidate
    retainedExtractBytes += (inspected._text?.length || 0) * 2 + (inspected._cells?.size || 0) * 200 + (inspected._json ? JSON.stringify(inspected._json).length * 2 : 0)
    if (retainedExtractBytes > LIMITS.retainedExtractBytes) {
      for (const key of Object.keys(inspected)) if (key.startsWith('_')) delete inspected[key]
      add(inspected, 'audit.extraction-retention', 'not-verified', 'Aggregate extracted-data retention budget reached; structured oracle data not retained')
    }
    report.files.push(inspected)
  }
  for (const entry of collectExpected(scenario)) {
    if (revision !== 'all' && entry.revision && entry.revision !== revision) continue
    try {
      const file = expectedPath(root, entry), actual = report.files.find(f => f.path === file)
      const failed = actual?.checks.some(c => c.status === 'failed'), parsed = actual?.checks.some(c => c.id === 'file.parse' && c.status === 'passed')
      report.expected.push({ ...entry, path: file, status: !actual || failed ? 'failed' : parsed ? 'passed' : 'not-verified', detail: !actual ? 'Promised file is missing' : failed ? 'File exists but independent format/content checks failed' : parsed ? 'Format readback completed; see outstanding formula/visual/business checks' : 'File exists but format readback is incomplete', sha256: actual?.sha256 })
    } catch (error) { report.expected.push({ ...entry, status: 'failed', detail: error.message }) }
  }
  if (!report.expected.length) add(report, 'scenario.expected-artifacts', 'not-verified', 'No applicable expected artifacts were supplied')
  report.oracle = [...oracleChecks(scenario.oracle).filter(x => revision === 'all' || !x.revision || x.revision === revision).map(check => verifyOracle(check, report.files, root)), ...scenarioRoleChecks(scenario, report.files, root, revision)]
  if (!report.oracle.length) add(report, 'scenario.oracle', 'not-verified', 'No business oracle supplied')
  report.seeds = await checkSeeds(root, evidence, scenario)
  report.externalOfficeEvidence = await externalOfficeEvidence(evidence)
  const state = await readJsonOptional(path.join(path.dirname(root), 'state.json'))
  report.nativeToolPolicyEvidence = await nativeToolPolicyEvidence(evidence, scenario.toolPolicy, { root, roles: state?.roles || {}, revision })
  report.versionPreservation = await versionPreservation(root, evidence, scenario)
  report.checks.push(...report.versionPreservation.checks)
  if (revision !== 'v1') {
    report.handoffs = handoffChecks(scenario, report.files, root, state?.roles || {}, report.nativeToolPolicyEvidence.fileReadCalls || [])
    report.oracle.push(...report.handoffs)
  }
  if (scenario.toolPolicy?.mode === 'aether-native-only') {
    add(report, 'capability.native-only-tool-policy', report.nativeToolPolicyEvidence.violations.length ? 'failed' : 'not-verified', report.nativeToolPolicyEvidence.violations.length ? `${report.nativeToolPolicyEvidence.violations.length} tool/identity/write-scope/deletion policy violations observed; inspect individual reasons` : 'No violations observed in supplied snapshots; full parent/child coverage still requires independent runtime evidence')
  }
  if (report.externalOfficeEvidence.executionAttempts.length) add(report, 'capability.external-office-excluded', 'not-verified', `${report.externalOfficeEvidence.executionAttempts.length} historical external Office/COM attempts across ${report.externalOfficeEvidence.rolesWithAttempts.join(', ')} are disqualified as built-in evidence; repeat affected operations using Aether-only capabilities`)
  if (!report.seeds.checks.length) add(report, 'inputs.baseline', 'not-verified', 'No independent seed hash baseline available')
  const checks = [...report.checks, ...report.expected, ...report.oracle, ...report.seeds.checks, ...report.files.filter(f => !f.temporaryCandidate).flatMap(f => f.checks)]
  report.summary = { passed: checks.filter(x => x.status === 'passed').length, failed: checks.filter(x => x.status === 'failed').length, notVerified: checks.filter(x => x.status === 'not-verified').length }
  report.assessmentStatus = report.summary.failed ? 'failed' : report.summary.notVerified ? 'incomplete' : 'passed-file-checks-only'
  report.status = options.inProgress ? 'in-progress' : report.assessmentStatus
  for (const file of report.files) for (const key of Object.keys(file)) if (key.startsWith('_')) delete file[key]
  await fs.mkdir(evidence, { recursive: true })
  for (const [name, content] of [['file-audit.json', JSON.stringify(report, null, 2) + '\n'], ['file-audit.md', markdown(report)]]) {
    const temporary = path.join(evidence, name + '.' + process.pid + '.tmp')
    await fs.writeFile(temporary, content); await fs.rename(temporary, path.join(evidence, name))
  }
  return { ...report.summary, status: report.status, assessmentStatus: report.assessmentStatus, files: report.files.length, expected: report.expected.length, json: path.join(evidence, 'file-audit.json'), markdown: path.join(evidence, 'file-audit.md') }
}

/** Fresh, in-memory adversarial checks; never reads old campaign fixtures. */
async function selfTest() {
  const { default: assert } = await import('node:assert/strict')
  const results = []
  const test = async (name, operation) => { await operation(); results.push(name) }
  await test('CSV quoted comma/newline/escaped quote and BOM', () => assert.deepEqual(parseCsv('\uFEFFid,text\r\na,"b,c"\r\nd,"e\n""f"""\r\n'), [['id', 'text'], ['a', 'b,c'], ['d', 'e\n"f"']]))
  await test('CSV rejects unterminated and misplaced quotes', () => { assert.throws(() => parseCsv('a,"b')); assert.throws(() => parseCsv('a,b"c')); assert.throws(() => parseCsv('a,"b"oops')) })
  await test('XML extracts text and rejects invalid entities/DTD', () => { assert.equal(officeText('<w:document xmlns:w="w"><w:p><w:t>中&amp;文</w:t></w:p></w:document>'), '中&文'); assert.throws(() => officeText('<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>')); assert.throws(() => officeText('<a><b></a>')) })
  await test('PPTX table totals bind the total cell rather than matching repeated amounts elsewhere', () => {
    const cell = value => `<a:tc><a:p><a:r><a:t>${value}</a:t></a:r></a:p></a:tc>`
    const row = values => `<a:tr>${values.map(cell).join('')}</a:tr>`
    const source = '<a:tbl>' + [['合同', '已收含税', '应收余额'], ['C1', '63,600.00', '63600'], ['C2', '31800', '31800'], ['C3', '47700', '31800'], ['合计', '127200.00', '127200']].map(row).join('') + '</a:tbl>'
    const checks = presentationTableTotals(source, 'ppt/slides/slide3.xml')
    assert.equal(checks.length, 2); assert.equal(checks[0].status, 'failed'); assert.equal(checks[0].expected, 143100)
    assert.equal(checks[0].row, 5); assert.equal(checks[0].column, 2); assert.equal(checks[1].status, 'passed')
    assert.equal(presentationTableTotals(source.replace('127200.00', '143100.00'), 's')[0].status, 'passed')
    assert.equal(presentationTableTotals(source.replace('<a:tc>', '<a:tc gridSpan="2">'), 's').length, 0)
    assert.equal(presentationTableTotals(source.replace('已收含税', '概率'), 's').length, 1)
  })
  await test('OOXML cannot be a renamed text file', async () => { await assert.rejects(openOffice(Buffer.from('not a real workbook'), 'xl/workbook.xml')) })
  await test('ZIP expansion budget is enforced before decompression', async () => {
    const zip = new JSZip(); zip.file('test.xml', 'x'); const data = await zip.generateAsync({ type: 'nodebuffer' })
    const end = data.length - 22, start = data.readUInt32LE(end + 16); data.writeUInt32LE(LIMITS.partBytes + 1, start + 24)
    assert.throws(() => zipDirectory(data), /expansion/)
  })
  await test('Expected full paths preserve company-relative department path', () => {
    const root = path.resolve('memory-audit-root'), list = collectExpected({ roles: [{ id: 'finance', expectedArtifacts: ['departments/finance/v1/book.xlsx', 'departments/finance/v2/book.xlsx'] }] })
    assert.equal(list[0].revision, 'v1'); assert.equal(list[1].revision, 'v2'); assert.equal(expectedPath(root, list[0]), 'departments/finance/v1/book.xlsx')
    assert.throws(() => expectedPath(root, { path: '../outside.txt' }), /escapes/)
  })
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('经营摘要')
  sheet.addRow(['指标', '值']); sheet.addRow(['expenseTotal', 45000]); sheet.addRow(['computed', { formula: 'B2+1000', result: 46000 }]); sheet.addRow(['missing', { formula: 'B2+1' }]); sheet.addRow(['blankDate', null])
  const hidden = workbook.addWorksheet('hidden'); hidden.state = 'veryHidden'; hidden.getCell('Z1000').value = { error: '#REF!' }
  const data = Buffer.from(await workbook.xlsx.writeBuffer()), source = await openOffice(data, 'xl/workbook.xml'), item = { path: 'departments/operations/v1/operations-plan.xlsx', checks: [] }
  await inspectSpreadsheet(data, item, source)
  await test('Real ExcelJS package includes hidden saved-error cells', () => assert.equal(item.savedErrors.count, 1))
  await test('Real workbook missing cached formula result is not silently passed', () => { assert.equal(item.missingFormulaCaches.count, 1); assert.equal(item.checks.find(x => x.id === 'xlsx.formula-caches').status, 'not-verified') })
  await test('Independent workbook oracle checks exact cell rather than matching digits', () => {
    const root = path.resolve('memory-audit-root')
    assert.equal(verifyOracle({ path: item.path, sheet: '经营摘要', cell: 'B3', expected: 46000 }, [item], root).status, 'passed')
    assert.equal(verifyOracle({ path: item.path, sheet: '经营摘要', cell: 'B2', expected: 46000 }, [item], root).status, 'failed')
    assert.equal(verifyOracle({ path: item.path, sheet: '经营摘要', cell: 'B4', expected: 45001 }, [item], root).status, 'failed')
    assert.equal(verifyOracle({ path: item.path, sheet: '经营摘要', cell: 'B5', expected: null }, [item], root).status, 'passed')
  })
  await test('Formula dependency evaluation does not use stale caches', () => {
    const cells = new Map([['数表!A1', { value: 10 }], ['数表!A2', { value: 20 }], ['数表!B1', { value: 999, formula: 'SUM(A1:A2)' }], ['数表!B2', { value: null, formula: "ROUND('数表'!B1*1.12,2)" }]])
    const evaluated = evaluateWorkbookFormulas(cells, [{ sheet: '数表', address: 'B1', value: 999, formula: 'SUM(A1:A2)' }, { sheet: '数表', address: 'B2', value: null, formula: "ROUND('数表'!B1*1.12,2)" }])
    assert.equal(evaluated[0].computed, 30); assert.equal(evaluated[0].status, 'failed'); assert.equal(evaluated[1].computed, 33.6); assert.equal(evaluated[1].status, 'not-verified')
  })
  await test('Unsupported or cyclic formulas stay unverified without execution', () => {
    const cells = new Map([['S!A1', { value: 1, formula: 'A1+1' }], ['S!A2', { value: 1, formula: 'process.exit(9)' }]])
    assert.ok(evaluateWorkbookFormulas(cells, [{ sheet: 'S', address: 'A1' }, { sheet: 'S', address: 'A2' }]).every(x => x.status === 'not-verified'))
  })
  await test('Formula date, comparison and IF calculate independently', () => {
    const formula = 'IF(AND(DATE(2026,11,20)>=DATE(2026,11,1),1<>2),TEXT(DATE(2026,11,20),"yyyy-mm-dd"),"bad")'
    const cells = new Map([['S!A1', { value: '2026-11-20', formula }]])
    assert.equal(evaluateWorkbookFormulas(cells, [{ sheet: 'S', address: 'A1', value: '2026-11-20', formula }])[0].status, 'passed')
  })
  await test('Audit formula subset cannot falsely diagnose unsupported coercions, historical dates or comparison', () => {
    const cases = [
      ["SUM('dAtA'!A1:A2)", 12, 'passed'], ['SUM("12",3)', 15, 'not-verified'],
      ['MIN(Z20:Z22)', 0, 'passed'], ['MAX(Z20:Z22)', 0, 'passed'],
      ['"a"="A"', true, 'not-verified'], ['DATE(1900,2,29)', 60, 'not-verified'],
      ['COUNTA("")', 1, 'passed'], ['Z20', 0, 'passed'], ['SUM(Z1)', 0, 'not-verified'],
    ]
    const formulas = cases.map(([formula, value], index) => ({ sheet: 'S', address: `A${index + 1}`, value, formula }))
    const cells = new Map([['Data!A1', { value: 12 }], ['Data!A2', { value: '12' }], ['S!Z1', { value: '#REF!', error: '#REF!' }], ...formulas.map(entry => ['S!' + entry.address, entry])])
    const result = evaluateWorkbookFormulas(cells, formulas)
    for (const [index, testcase] of cases.entries()) assert.equal(result[index].status, testcase[2], testcase[0])
  })
  await test('A saved empty string formula cache is not a missing XML cache', async () => {
    const book = new ExcelJS.Workbook(); book.addWorksheet('S').getCell('A1').value = { formula: 'IF(1=1,"",0)', result: 'old' }
    const zip = await JSZip.loadAsync(Buffer.from(await book.xlsx.writeBuffer()))
    const part = await zip.file('xl/worksheets/sheet1.xml').async('string')
    zip.file('xl/worksheets/sheet1.xml', part.replace('<v>old</v>', '<v></v>'))
    const data = await zip.generateAsync({ type: 'nodebuffer' }), item = { checks: [] }
    await inspectSpreadsheet(data, item, await openOffice(data, 'xl/workbook.xml'))
    assert.equal(item.missingFormulaCaches.count, 0)
  })
  await test('ACK compares source bytes and binds read evidence to the receiving parent session', () => {
    const root = path.resolve('memory-audit-root'), source = 'departments/operations/v1/summary.json'
    const scenario = { roles: [{ id: 'finance', handoffSources: [source] }, { id: 'operations', expectedArtifacts: ['departments/operations/v1/plan.xlsx'] }] }
    const files = [{ path: source, sha256: 'a'.repeat(64) }, { path: 'departments/finance/v2/ack.json', _json: { role: 'finance', revision: 'CC-2026-11-02', received: [{ fromRole: 'operations', path: source, sha256: 'b'.repeat(64), observedVersion: 'v1', decision: 'accepted', factsUsed: ['费用 45000'] }] } }]
    const read = { sessionId: 'other-session', tool: 'read_file', callId: 'read-1', path: path.join(root, source), resultObserved: true, reportedToolSuccess: true, reportedToolStatus: 'succeeded' }
    let checks = handoffChecks(scenario, files, root, { finance: { sessionId: 'receiver' } }, [read])
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.operations.hash').status, 'failed')
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.operations.runtime-read').status, 'not-verified')
    files[1]._json.received[0].sha256 = 'a'.repeat(64); read.sessionId = 'receiver'
    checks = handoffChecks(scenario, files, root, { finance: { sessionId: 'receiver' } }, [read])
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.operations.hash').status, 'passed')
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.operations.runtime-read').status, 'passed')
    assert.equal(checks.find(check => check.id === 'finance.v2.handoff.operations.original-read').status, 'not-verified')
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.semantic-review').status, 'not-verified')
    read.sessionId = 'prior-receiver'
    checks = handoffChecks(scenario, files, root, { finance: { sessionId: 'receiver', priorSessions: [{ sessionId: 'prior-receiver' }] } }, [read])
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.operations.runtime-read').status, 'passed')
    read.sessionId = 'unrelated-receiver'
    checks = handoffChecks(scenario, files, root, { finance: { sessionId: 'receiver', priorSessions: [{ sessionId: 'prior-receiver' }] } }, [read])
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.operations.runtime-read').status, 'not-verified')
  })
  await test('Supplemental self-review and revision receipts do not replace required handoffs', () => {
    const root = path.resolve('memory-audit-root')
    const scenario = { roles: [{ id: 'finance', handoffSources: ['departments/sales/v1/summary.json'] }] }
    const receipt = (fromRole, file, observedVersion) => ({ fromRole, path: file, observedVersion, sha256: 'a'.repeat(64), decision: 'accepted', factsUsed: ['source checked'] })
    const received = [receipt('finance', 'departments/finance/v1/model.xlsx', 'v1'), receipt('company-inputs', 'inputs/v2/revision.json', 'v2'), receipt('people', 'departments/people/v1/workforce.xlsx', 'v1')]
    const files = [{ path: 'departments/finance/v2/ack.json', _json: { role: 'finance', revision: 'CC-2026-11-02', received } }]
    const checks = handoffChecks(scenario, files, root, {}, [])
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.finance.source').status, 'passed')
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.company-inputs.source').status, 'passed')
    assert.equal(checks.find(check => check.id === 'finance.v2.ack.people.source').status, 'failed')
    assert.equal(checks.find(check => check.id === 'finance.v2.handoff.sales.ack').status, 'failed')
  })
  await test('Summary-only oracle cannot become formal-document acceptance', () => {
    const role = { id: 'product', oracle: { v1: { featureCount: 3 }, period: '2026-11', currency: 'CNY' } }
    const summary = { path: 'departments/product/v1/summary.json', _json: { role: 'product', version: 'v1', period: '2026-11', currency: 'CNY', metrics: { featureCount: 3 } } }
    const checks = scenarioRoleChecks({ roles: [role] }, [summary], path.resolve('memory-audit-root'), 'v1')
    assert.equal(checks.find(x => x.id === 'product.v1.summary.metrics.featureCount').status, 'passed')
    assert.equal(checks.find(x => x.id === 'product.v1.formal-business-semantics').status, 'not-verified')
  })
  await test('Fresh PDF uses the actual PDF.js text parser', async () => {
    const stream = 'BT /F1 12 Tf 30 70 Td (INDEPENDENT-PDF-12345) Tj ET'
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
    let pdf = '%PDF-1.4\n'; const offsets = [0]
    for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n` }
    const start = Buffer.byteLength(pdf)
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
    const item = { checks: [] }; await inspectPdf(Buffer.from(pdf), item)
    assert.equal(item.pageCount, 1); assert.match(item._text, /INDEPENDENT-PDF-12345/)
  })
  return { passed: results.length, checks: results, filesWritten: 0 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) selfTest().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1 })
  else if (!args[0] || args.includes('--help')) console.log('Usage: node scripts/audit-office-current.mjs <company-root> [--revision v1|v2|all] [--in-progress]\nReads sibling evidence/scenario.json and seed-hashes.json; writes only evidence/file-audit.json and file-audit.md. Exit 1: failed; 2: incomplete/in-progress; 0: all automated file checks passed.\n--self-test runs fresh, in-memory checks without writing files.')
  else {
    const revision = args.includes('--revision') ? args[args.indexOf('--revision') + 1] : 'all'
    auditOfficeCurrent(args[0], { revision, inProgress: args.includes('--in-progress') }).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.status === 'failed' ? 1 : ['incomplete', 'in-progress'].includes(result.status) ? 2 : 0 }).catch(error => { console.error(error.stack); process.exitCode = 1 })
  }
}
