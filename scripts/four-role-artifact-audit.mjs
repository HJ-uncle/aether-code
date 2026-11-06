#!/usr/bin/env node
/** Independent read-only artifact audit. No model, application, delivered code,
 * macro or external Office process is executed. Writes only to --evidence.
 * node scripts/four-role-artifact-audit.mjs --workspace <path> --evidence <path>
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { SaxesParser } from 'saxes'

const limits = { files: 3000, fileBytes: 32 * 1024 ** 2, totalBytes: 512 * 1024 ** 2,
  zipEntries: 4000, partBytes: 16 * 1024 ** 2, expandedBytes: 128 * 1024 ** 2,
  cells: 100000, pdfPages: 100, textChars: 1000000 }
const nativeFormats = ['docx', 'xlsx', 'pptx', 'pdf']
const textFormats = new Set(['md', 'txt', 'csv', 'json', 'html', 'svg'])
const ignoredDirectories = new Set(['.git', 'node_modules', '.ae', '.aether', '.e2e-tmp', 'coverage', 'playwright-report', 'test-results'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const slash = value => value.replaceAll('\\', '/')
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const local = name => String(name).split(':').at(-1)
const clean = text => String(text).replaceAll('\u0000', '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
const check = (item, id, status, detail, extra = {}) => item.checks.push({ id, status, detail, ...extra })
const limited = (values, count = 200) => ({ count: values.length, items: values.slice(0, count), omitted: Math.max(0, values.length - count) })

function xml(source, handlers = {}) {
  if (Buffer.byteLength(source) > limits.partBytes) throw Error('XML part exceeds audit budget')
  const parser = new SaxesParser({ xmlns: false })
  parser.on('doctype', () => { throw Error('DTD/entity declarations are not accepted') })
  parser.on('error', error => { throw error })
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler)
  parser.write(source).close()
}

function extractOfficeText(source) {
  const stack = [], pieces = []
  xml(source, { opentag: node => stack.push(local(node.name)), text: text => { if (stack.at(-1) === 't') pieces.push(text) },
    closetag: node => { if (['p', 'tr'].includes(local(node.name))) pieces.push('\n'); stack.pop() } })
  return clean(pieces.join(''))
}

function zipDirectory(data) {
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break }
  }
  if (end < 0) throw Error('ZIP end record missing or trailing bytes present')
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16)
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8)) throw Error('Split ZIP unsupported')
  if (count === 65535 || start === 0xffffffff || size === 0xffffffff || count > limits.zipEntries || start + size > end) throw Error('ZIP directory exceeds audit budget or file bounds')
  let position = start, expandedBytes = 0
  const names = new Set()
  for (let index = 0; index < count; index++) {
    if (position + 46 > start + size || data.readUInt32LE(position) !== 0x02014b50) throw Error('Invalid ZIP central entry')
    const flags = data.readUInt16LE(position + 8), compressed = data.readUInt32LE(position + 20), bytes = data.readUInt32LE(position + 24)
    const nameSize = data.readUInt16LE(position + 28), extra = data.readUInt16LE(position + 30), comment = data.readUInt16LE(position + 32)
    const offset = data.readUInt32LE(position + 42), next = position + 46 + nameSize + extra + comment
    if (next > start + size || flags & 1 || [compressed, bytes, offset].includes(0xffffffff)) throw Error('Encrypted, ZIP64 or truncated ZIP entry')
    const name = data.subarray(position + 46, position + 46 + nameSize).toString('utf8')
    if (/^[\\/]|^[a-z]:|\x00/i.test(name) || name.includes('\\') || name.split('/').includes('..') || names.has(name)) throw Error('Unsafe or duplicate ZIP path')
    if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50) throw Error('Invalid ZIP local entry')
    if (offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28) + compressed > start) throw Error('ZIP data exceeds package bounds')
    expandedBytes += bytes
    if (bytes > limits.partBytes || expandedBytes > limits.expandedBytes) throw Error('ZIP expansion exceeds audit budget')
    names.add(name); position = next
  }
  if (position !== start + size) throw Error('ZIP directory length mismatch')
  return { entries: count, expandedBytes }
}

async function openOffice(data, format) {
  const metadata = zipDirectory(data), zip = await JSZip.loadAsync(data, { checkCRC32: true })
  const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[format]
  const read = async name => {
    const entry = zip.file(name)
    if (!entry) throw Error('Required OOXML part missing: ' + name)
    const text = await entry.async('string'); xml(text); return text
  }
  const types = await read('[Content_Types].xml')
  await read('_rels/.rels'); await read(main)
  const type = { docx: 'wordprocessingml.document.main+xml', xlsx: 'spreadsheetml.sheet.main+xml', pptx: 'presentationml.presentation.main+xml' }[format]
  if (!types.includes(type)) throw Error('OOXML main content type does not match extension')
  return { zip, read, main, metadata }
}

async function inspectWord(source, item) {
  const main = await source.read(source.main)
  let paragraphs = 0, tables = 0
  xml(main, { opentag: node => { if (local(node.name) === 'p') paragraphs++; if (local(node.name) === 'tbl') tables++ } })
  item.structure = { paragraphs, tables, headers: Object.keys(source.zip.files).filter(n => /^word\/header\d+\.xml$/.test(n)).length,
    footers: Object.keys(source.zip.files).filter(n => /^word\/footer\d+\.xml$/.test(n)).length }
  return extractOfficeText(main)
}

async function inspectPresentation(source, item) {
  const ordered = [], relationships = new Map()
  xml(await source.read(source.main), { opentag: node => { if (local(node.name) === 'sldId') ordered.push(node.attributes['r:id']) } })
  xml(await source.read('ppt/_rels/presentation.xml.rels'), { opentag: node => {
    if (local(node.name) === 'Relationship' && String(node.attributes.Type).endsWith('/slide')) {
      if (node.attributes.TargetMode === 'External') throw Error('External slide relationship is not a local slide')
      const target = String(node.attributes.Target), resolved = path.posix.normalize(path.posix.join('ppt', target))
      if (!resolved.startsWith('ppt/') || target.startsWith('/') || target.includes('\\')) throw Error('Slide relationship escapes presentation')
      relationships.set(node.attributes.Id, resolved)
    }
  } })
  item.slides = []
  for (const [index, id] of ordered.entries()) {
    const part = relationships.get(id)
    if (!part) throw Error('Slide relationship is missing: ' + id)
    const text = extractOfficeText(await source.read(part))
    item.slides.push({ number: index + 1, part, characters: text.length, excerpt: text.slice(0, 2000) })
  }
  if (!item.slides.length) throw Error('Presentation contains no displayed slides')
  const text = []
  for (const slide of item.slides) text.push(extractOfficeText(await source.read(slide.part)))
  return text.join('\n\n')
}

async function inspectWorkbook(data, source, item) {
  const formulas = [], errors = [], missingCaches = [], formulaLikeText = []
  let cells = 0
  for (const name of Object.keys(source.zip.files).filter(value => /^xl\/worksheets\/[^/]+\.xml$/.test(value))) {
    let cell = null, inFormula = false, inValue = false
    xml(await source.read(name), { opentag: node => {
      const tag = local(node.name)
      if (tag === 'c') { if (++cells > limits.cells) throw Error('Workbook cell count exceeds audit budget'); cell = { part: name, address: node.attributes.r, type: node.attributes.t, formula: '', cache: '', hasFormula: false, hasCache: false } }
      if (cell && tag === 'f') { inFormula = true; cell.hasFormula = true }
      if (cell && tag === 'v') { inValue = true; cell.hasCache = true }
    }, text: text => { if (cell && inFormula) cell.formula += text; if (cell && inValue) cell.cache += text }, closetag: node => {
      const tag = local(node.name)
      if (tag === 'f') inFormula = false
      if (tag === 'v') inValue = false
      if (tag === 'c' && cell) {
        if (cell.type === 'e') errors.push({ part: name, address: cell.address, code: cell.cache })
        if (cell.hasFormula) { formulas.push(cell); if (!cell.hasCache || cell.cache === '' && cell.type !== 'str') missingCaches.push(cell) }
        cell = null
      }
    } })
  }
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(data)
  const text = []; item.sheets = []
  for (const sheet of workbook.worksheets) {
    let contentCells = 0
    text.push('## ' + sheet.name)
    sheet.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      // ExcelJS's formula text getter drops numeric zero and boolean false caches.
      const display = cell.type === ExcelJS.ValueType.Formula && cell.result !== undefined ? String(cell.result) : cell.text
      if (display) { contentCells++; text.push(cell.address + ': ' + display) }
      if (typeof cell.value === 'string' && cell.value.startsWith('=')) formulaLikeText.push({ sheet: sheet.name, address: cell.address, text: cell.value })
    }))
    item.sheets.push({ name: sheet.name, state: sheet.state, rows: sheet.rowCount, columns: sheet.columnCount, contentCells })
  }
  item.formulas = limited(formulas); item.savedErrors = limited(errors); item.missingFormulaCaches = limited(missingCaches); item.formulaLikeText = limited(formulaLikeText)
  check(item, 'xlsx.sheets', workbook.worksheets.length ? 'passed' : 'failed', `${workbook.worksheets.length} worksheets; ${cells} XML cells`)
  check(item, 'xlsx.errors', errors.length ? 'failed' : 'passed', `${errors.length} saved error cells across all parsed worksheets, including hidden sheets`)
  check(item, 'xlsx.cache', missingCaches.length ? 'failed' : 'passed', `${formulas.length} formulas; ${missingCaches.length} missing caches; saved caches do not prove fresh recalculation`)
  if (!formulas.length) check(item, 'xlsx.formulas', 'warning', 'No actual formulas; this campaign requests meaningful budget/plan formulas')
  if (formulaLikeText.length) check(item, 'xlsx.formula-like-text', 'warning', `${formulaLikeText.length} text cells begin with = and will not calculate`)
  check(item, 'xlsx.recalculation', 'not-verified', 'Static audit never recalculates or changes source files; runtime recalculate receipts and independent business assertions are required')
  return text.join('\n')
}

async function inspectPdf(data, item) {
  if (!/^%PDF-\d\.\d/.test(data.subarray(0, 16).toString('ascii'))) throw Error('Invalid PDF signature')
  if (!/%%EOF\s*$/.test(data.subarray(Math.max(0, data.length - 2048)).toString('latin1'))) throw Error('Missing PDF end marker')
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdf.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 })
  let timer
  try {
    const read = async () => {
      const document = await task.promise
      if (!document.numPages || document.numPages > limits.pdfPages) throw Error('PDF page count exceeds audit budget')
      item.pages = []; const texts = []; let total = 0
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), content = await page.getTextContent()
        const text = clean(content.items.map(value => 'str' in value ? value.str + (value.hasEOL ? '\n' : ' ') : '').join(''))
        total += text.length
        if (total > limits.textChars) throw Error('PDF text exceeds audit budget')
        item.pages.push({ number, characters: text.length, cjkCharacters: (text.match(/[\u3400-\u9fff]/g) || []).length })
        texts.push(text); page.cleanup()
      }
      return texts.join('\n\n')
    }
    return await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PDF extraction exceeded 30 seconds')), 30000) })])
  } finally { clearTimeout(timer); await task.destroy().catch(() => {}) }
}

function parseCsv(text) {
  const rows = [], row = []; let field = '', quoted = false, closed = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) { if (char === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (char === '"') { quoted = false; closed = true } else field += char }
    else if (char === '"') { if (field || closed) throw Error('Invalid CSV quote'); quoted = true }
    else if (char === ',' || char === '\n' || char === '\r') { row.push(field); field = ''; closed = false; if (char !== ',') { rows.push(row.splice(0)); if (char === '\r' && text[i + 1] === '\n') i++ } }
    else { if (closed) throw Error('Text after closed CSV quote'); field += char }
  }
  if (quoted) throw Error('Unclosed CSV quote')
  if (field || row.length || closed) { row.push(field); rows.push(row) }
  if (!rows.length || rows.some(row => row.length !== rows[0].length)) throw Error('CSV is empty or has inconsistent row widths')
  return rows
}

async function inspectFile(workspace, relative, evidence) {
  const absolute = path.join(workspace, relative), item = { path: slash(relative), format: path.extname(relative).slice(1).toLowerCase(), checks: [] }
  const before = await fs.lstat(absolute)
  item.bytes = before.size; item.modifiedAt = before.mtime.toISOString()
  if (before.isSymbolicLink() || !before.isFile()) { check(item, 'file.type', 'not-verified', 'Link or nonregular file not followed'); item.status = 'incomplete'; return item }
  if (before.size > limits.fileBytes) { check(item, 'file.size', 'not-verified', 'File exceeds 32 MiB inspection budget'); item.status = 'incomplete'; return item }
  const data = await fs.readFile(absolute); item.sha256 = sha(data)
  try {
    if (!data.length) throw Error('File is empty')
    let text
    if (['docx', 'xlsx', 'pptx'].includes(item.format)) {
      const source = await openOffice(data, item.format); item.package = source.metadata
      check(item, 'office.package', 'passed', 'ZIP directory, CRC32, required XML and matching OOXML main content type verified')
      text = item.format === 'docx' ? await inspectWord(source, item) : item.format === 'pptx' ? await inspectPresentation(source, item) : await inspectWorkbook(data, source, item)
    } else if (item.format === 'pdf') text = await inspectPdf(data, item)
    else if (textFormats.has(item.format)) {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      if (item.format === 'json') { JSON.parse(text); check(item, 'json.parse', 'passed', 'Valid JSON') }
      if (item.format === 'csv') { const rows = parseCsv(text.replace(/^\uFEFF/, '')); item.csv = { rows: rows.length - 1, columns: rows[0].length, headers: rows[0] } }
    }
    if (text !== undefined) {
      item.characters = text.length; item.cjkCharacters = (text.match(/[\u3400-\u9fff]/g) || []).length
      check(item, 'content.nonempty', text.trim() ? 'passed' : 'failed', `${text.length} extracted characters`)
      if (nativeFormats.includes(item.format)) check(item, 'content.chinese', item.cjkCharacters ? 'passed' : 'failed', `${item.cjkCharacters} CJK characters; this campaign requires Chinese documents`)
      item.excerpt = text.slice(0, 1500); item.extractionTruncated = text.length > limits.textChars
      const textFile = path.join(evidence, 'artifact-text', item.sha256 + '.txt')
      await fs.mkdir(path.dirname(textFile), { recursive: true }); await fs.writeFile(textFile, text.slice(0, limits.textChars), 'utf8'); item.extractedText = textFile
    }
    if (nativeFormats.includes(item.format)) check(item, 'visual.layout', 'not-verified', 'Text/package parsing does not verify page layout or preview performance; requires real client evidence')
    check(item, 'file.parse', 'passed', 'Format-specific static parsing completed')
  } catch (error) { check(item, 'file.parse', 'failed', error.message) }
  try { const after = await fs.readFile(absolute); check(item, 'file.stable', sha(after) === item.sha256 ? 'passed' : 'not-verified', 'Compared SHA-256 before and after parsing; rerun when writers stop if changed') }
  catch (error) { check(item, 'file.stable', 'not-verified', error.message) }
  item.status = item.checks.some(value => value.status === 'failed') ? 'failed' : item.checks.some(value => value.status === 'not-verified' && value.id.startsWith('file.')) ? 'incomplete' : item.checks.some(value => value.status === 'warning') ? 'warning' : 'passed'
  return item
}

export async function auditFourRoleArtifacts({ workspace, evidence }) {
  workspace = await fs.realpath(path.resolve(workspace)); evidence = path.resolve(evidence)
  if (inside(workspace, evidence)) throw Error('Evidence must be outside the generated workspace')
  await fs.mkdir(evidence, { recursive: true }); evidence = await fs.realpath(evidence)
  if (inside(workspace, evidence)) throw Error('Evidence realpath must be outside generated workspace')
  const entries = [], skipped = []; let totalBytes = 0
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(workspace, absolute)
      if (entry.isSymbolicLink()) { skipped.push({ path: slash(relative), reason: 'symbolic-link-not-followed' }); continue }
      if (entry.isDirectory()) { if (ignoredDirectories.has(entry.name)) skipped.push({ path: slash(relative), reason: 'generated-or-private-directory' }); else await walk(absolute) }
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute); totalBytes += stat.size
        if (entries.length >= limits.files || totalBytes > limits.totalBytes) throw Error('Workspace inventory exceeds audit budget')
        entries.push(relative)
      }
    }
  }
  await walk(workspace)
  const files = []
  for (const relative of entries.sort()) files.push(await inspectFile(workspace, relative, evidence))
  const formats = Object.fromEntries([...new Set(files.map(file => file.format))].sort().map(format => [format, files.filter(file => file.format === format).length]))
  const accepted = file => ['passed', 'warning'].includes(file.status)
  const formatChecks = nativeFormats.map(format => ({ format, status: files.some(file => file.format === format && accepted(file)) ? 'passed' : 'failed' }))
  const roleFormats = Object.fromEntries(['product', 'operations'].map(role => [role, nativeFormats.map(format => ({ format,
    status: files.some(file => file.path.startsWith(role + '/') && file.format === format && accepted(file)) ? 'passed' : 'failed' }))]))
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), workspace, evidence, status: files.some(file => file.status === 'failed') || formatChecks.some(check => check.status === 'failed') || Object.values(roleFormats).flat().some(check => check.status === 'failed') ? 'failed' : files.some(file => file.status === 'incomplete') ? 'incomplete' : 'passed',
    scope: 'Read-only static format/content/cache checks; no business/visual/full recalculation claim', limits, inventory: { fileCount: files.length, totalBytes, formats, skipped }, nativeFormatCoverage: formatChecks, roleFormatCoverage: roleFormats,
    failures: files.flatMap(file => file.checks.filter(check => check.status === 'failed').map(check => ({ path: file.path, ...check }))), warnings: files.flatMap(file => file.checks.filter(check => check.status === 'warning').map(check => ({ path: file.path, ...check }))), files }
  const reportPath = path.join(evidence, 'artifact-audit.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  const markdown = ['# 四角色办公产物静态验收', '', `生成时间：${report.createdAt}`, '', `状态：${report.status}；文件 ${files.length} 个；总大小 ${totalBytes} 字节。`, '',
    '本报告只证明格式、可提取内容、保存的公式缓存与错误检查；不证明业务数字正确、已执行重算、视觉布局或秒开。', '',
    '| 文件 | 格式 | 字节 | 内容字符 | 中文字符 | 静态结果 |', '| --- | --- | ---: | ---: | ---: | --- |',
    ...files.filter(file => nativeFormats.includes(file.format)).map(file => `| ${file.path.replaceAll('|', '\\|')} | ${file.format} | ${file.bytes} | ${file.characters ?? '-'} | ${file.cjkCharacters ?? '-'} | ${file.status} |`), '',
    '## 问题', '', ...report.failures.map(value => `- ${value.path}: ${value.id} — ${value.detail}`), ...report.warnings.map(value => `- 待复核 ${value.path}: ${value.detail}`),
    ...Object.entries(roleFormats).flatMap(([role, values]) => values.filter(value => value.status === 'failed').map(value => `- ${role} 缺少通过静态检查的 ${value.format} 文件。`)), '',
    '完整检查、哈希和文本提取路径见 artifact-audit.json。', '']
  await fs.writeFile(path.join(evidence, 'artifact-audit.md'), markdown.join('\n'), 'utf8')
  return { status: report.status, reportPath, fileCount: files.length, formats, failures: report.failures.length, warnings: report.warnings.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  if (args.includes('--help')) console.log('node scripts/four-role-artifact-audit.mjs --workspace <path> --evidence <directory>\nRead-only sources; evidence must be outside workspace. Exit 1 means failed/missing static acceptance.')
  else if (!option('--workspace') || !option('--evidence')) { console.error('--workspace and --evidence are required'); process.exitCode = 1 }
  else auditFourRoleArtifacts({ workspace: option('--workspace'), evidence: option('--evidence') }).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.status === 'passed' ? 0 : 1 }).catch(error => { console.error(error.stack); process.exitCode = 1 })
}
