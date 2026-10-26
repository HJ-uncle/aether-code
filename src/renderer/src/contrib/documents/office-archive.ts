import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { DOCUMENT_LIMITS, type DocumentKind } from './document-kind'

interface ZipEntry { name: string; method: number; packed: number; unpacked: number; offset: number }
const invalid = (): never => { throw new Error('文件结构无法安全预览，原文件已保留。') }

/** Admit sizes before a general-purpose ZIP parser can allocate expanded data. */
export function inspectOfficeArchive(buffer: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer)
  if (bytes.length < 22 || bytes.length > DOCUMENT_LIMITS.inputBytes) return invalid()
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break
  }
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) return invalid()
  const count = view.getUint16(end + 10, true), directoryBytes = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) ||
    count < 1 || count > DOCUMENT_LIMITS.entries || directoryOffset + directoryBytes !== end) return invalid()
  const entries: ZipEntry[] = [], names = new Set<string>(), ranges: [number, number][] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let cursor = directoryOffset, total = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) return invalid()
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true)
    const packed = view.getUint32(cursor + 20, true), unpacked = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true)
    const local = view.getUint32(cursor + 42, true)
    if ((flags & 1) || (method !== 0 && method !== 8) || view.getUint16(cursor + 34, true) ||
      cursor + 46 + nameLength + extra + comment > end || local + 30 > directoryOffset ||
      packed > bytes.length || unpacked > DOCUMENT_LIMITS.entryBytes || (total += unpacked) > DOCUMENT_LIMITS.expandedBytes) return invalid()
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (!name || name.length > 512 || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').includes('..') ||
      name.includes(':') || names.has(name.toLowerCase())) return invalid()
    names.add(name.toLowerCase())
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) return invalid()
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true)
    const offset = local + 30 + localNameLength + localExtra
    if (offset + packed > directoryOffset || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) return invalid()
    if (method === 0 && packed !== unpacked) return invalid()
    ranges.push([local, offset + packed]); entries.push({ name, method, packed, unpacked, offset })
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== end) return invalid()
  ranges.sort((a, b) => a[0] - b[0])
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) return invalid()
  return entries
}

export async function expandOfficeEntry(buffer: ArrayBuffer, entry: ZipEntry, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  const packed = buffer.slice(entry.offset, entry.offset + entry.packed)
  if (entry.method === 0) return new Uint8Array(packed)
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const output = new Uint8Array(entry.unpacked)
  const abort = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  let written = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      if (written + chunk.value.byteLength > entry.unpacked) return invalid()
      output.set(chunk.value, written); written += chunk.value.byteLength
    }
    if (written !== entry.unpacked) return invalid()
    return output
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Image headers are checked before a browser decoder allocates pixel buffers. */
export function officeImagePixels(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    width = view.getUint32(16); height = view.getUint32(20)
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at), type = ascii(at + 4, at + 8)
      if (type === 'acTL' || length > bytes.length - at - 12) return invalid()
      at += length + 12
    }
  } else if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 0xff) return invalid()
      while (bytes[at] === 0xff) at++
      const marker = bytes[at++]
      if (marker === 0xda || marker === 0xd9) break
      const length = view.getUint16(at)
      if (length < 2 || at + length > bytes.length) return invalid()
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); break
      }
      at += length
    }
  } else if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const type = ascii(12, 16)
    if (type === 'VP8X') {
      if (bytes[20] & 2) return invalid()
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536
    } else if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff
    } else if (type === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff)
    }
  } else if (bytes.length >= 26 && ascii(0, 2) === 'BM') {
    width = Math.abs(view.getInt32(18, true)); height = Math.abs(view.getInt32(22, true))
  }
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 8_000_000) return invalid()
  return width * height
}

export function passiveOfficePart(name: string): boolean {
  return !/(?:^|\/)(?:vbaProject|vbaData|activeX|embeddings|macros)(?:[/.]|$)/i.test(name)
}

export function passiveOfficeRelationship(target: string, type: string, mode = ''): boolean {
  return mode.toLowerCase() !== 'external' && !/^(?:[a-z][\w+.-]*:|[\\/]{2})/i.test(target) &&
    passiveOfficePart(target.replaceAll('\\', '/')) && !/\/(?:vbaProject|vbaData|oleObject|package|control|activeX|aFChunk)$/i.test(type)
}

function cleanXml(text: string, name: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return invalid()
  let malformed = false
  // The preview worker has no window DOM. Reject parser errors here instead
  // of installing DOM globals or moving this unbounded work back to the UI.
  const xml = new DOMParser({ errorHandler: { error: () => { malformed = true }, fatalError: () => { malformed = true } } }).parseFromString(text, 'application/xml')
  if (malformed || xml.getElementsByTagName('parsererror').length) return invalid()
  // ExcelJS matches SpreadsheetML tag names literally. Prefixes are equivalent
  // in XML, so normalize only elements in that namespace for the preview copy.
  if (/^xl\//i.test(name)) {
    const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    for (const element of Array.from(xml.getElementsByTagNameNS(spreadsheetNamespace, '*'))) {
      if (!element.prefix) continue
      const replacement = xml.createElementNS(spreadsheetNamespace, element.localName)
      for (const attribute of Array.from(element.attributes)) {
        // Chromium keeps the old prefix when its namespace declaration is
        // inherited by the renamed node. Let the serializer emit a default
        // SpreadsheetML namespace instead of copying that declaration.
        if (/^xmlns(?::|$)/.test(attribute.name) && attribute.value === spreadsheetNamespace) continue
        replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
      }
      if (element === xml.documentElement) replacement.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', spreadsheetNamespace)
      while (element.firstChild) replacement.appendChild(element.firstChild)
      element.parentNode?.replaceChild(replacement, element)
    }
  }
  if (name.endsWith('.rels')) {
    for (const relation of Array.from(xml.getElementsByTagNameNS('*', 'Relationship'))) {
      const target = relation.getAttribute('Target') || ''
      if (!passiveOfficeRelationship(target, relation.getAttribute('Type') || '', relation.getAttribute('TargetMode') || '')) relation.remove()
      // ExcelJS indexes tables relative to xl/worksheets, but looks them up
      // using the relationship verbatim. Convert package-absolute table targets
      // to that same relative form without changing external-link filtering.
      else if (/^xl\/worksheets\/_rels\/[^/]+\.xml\.rels$/i.test(name) &&
        (relation.getAttribute('Type') || '').endsWith('/table')) {
        const absolute = /^\/xl\/(.+)$/.exec(target)
        if (absolute && !absolute[1].split('/').includes('..')) relation.setAttribute('Target', '../' + absolute[1])
      }
    }
  }
  if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
    const rows = xml.getElementsByTagNameNS('*', 'row'), cells = xml.getElementsByTagNameNS('*', 'c')
    if (rows.length > DOCUMENT_LIMITS.rows || cells.length > DOCUMENT_LIMITS.cells) return invalid()
    for (const row of Array.from(rows)) if (Number(row.getAttribute('r')) > DOCUMENT_LIMITS.rows) return invalid()
    for (const cell of Array.from(cells)) {
      const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell.getAttribute('r') || '')
      if (!match) return invalid()
      const column = Array.from(match[1]).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
      if (column > DOCUMENT_LIMITS.columns || Number(match[2]) > DOCUMENT_LIMITS.rows) return invalid()
    }
    // ExcelJS rejects a workbook when a producer emitted duplicate or
    // overlapping merge ranges (`Cannot merge already merged cells`).  Such
    // ranges are invalid OOXML, but the rest of the sheet can still be
    // displayed safely.  Keep the first valid range and drop only malformed
    // or conflicting ranges in the sanitized, read-only preview archive.
    const mergeCells = Array.from(xml.getElementsByTagNameNS('*', 'mergeCell'))
    const accepted = sanitizeMergeRefs(mergeCells.map(cell => cell.getAttribute('ref') || ''))
    let acceptedIndex = 0
    for (const cell of mergeCells) {
      const ref = cell.getAttribute('ref') || ''
      if (accepted[acceptedIndex] === ref) acceptedIndex += 1
      else cell.parentNode?.removeChild(cell)
    }
  }
  return new XMLSerializer().serializeToString(xml)
}

interface MergeRange { startColumn: number; endColumn: number; startRow: number; endRow: number }

function mergeRange(ref: string): MergeRange | null {
  const parse = (value: string): [number, number] | null => {
    const match = /^([A-Z]+)([1-9]\d*)$/i.exec(value.trim())
    if (!match) return null
    const column = Array.from(match[1].toUpperCase()).reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0)
    const row = Number(match[2])
    return column > 0 && column <= DOCUMENT_LIMITS.columns && row > 0 && row <= DOCUMENT_LIMITS.rows ? [column, row] : null
  }
  const parts = ref.split(':')
  if (parts.length !== 2) return null
  const start = parse(parts[0]), end = parse(parts[1])
  if (!start || !end) return null
  return {
    startColumn: Math.min(start[0], end[0]), endColumn: Math.max(start[0], end[0]),
    startRow: Math.min(start[1], end[1]), endRow: Math.max(start[1], end[1])
  }
}

function mergeRangesOverlap(left: MergeRange, right: MergeRange): boolean {
  return left.startColumn <= right.endColumn && right.startColumn <= left.endColumn &&
    left.startRow <= right.endRow && right.startRow <= left.endRow
}

/** Keep only valid, non-overlapping OOXML merge refs before ExcelJS parses a sheet. */
export function sanitizeMergeRefs(refs: string[]): string[] {
  const accepted: Array<{ ref: string; range: MergeRange }> = []
  for (const ref of refs) {
    const range = mergeRange(ref)
    if (!range || accepted.some(item => mergeRangesOverlap(item.range, range))) continue
    accepted.push({ ref, range })
  }
  return accepted.map(item => item.ref)
}

/** A fresh STORE archive removes external relationships and unneeded executable
 * payloads. Every deflate stream has an actual byte cap, not only a ZIP header cap. */
export async function prepareOfficeArchive(buffer: ArrayBuffer, kind: Exclude<DocumentKind, 'pdf'>, signal: AbortSignal): Promise<ArrayBuffer> {
  const entries = inspectOfficeArchive(buffer)
  const main = kind === 'docx' ? 'word/document.xml' : kind === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
  if (!entries.some(entry => entry.name === main) || !entries.some(entry => entry.name === '[Content_Types].xml')) return invalid()
  const slides = entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).length
  const sheets = entries.filter(entry => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name)).length
  if (slides > DOCUMENT_LIMITS.pages || sheets > DOCUMENT_LIMITS.sheets) return invalid()
  const zip = new JSZip()
  let elements = 0, imagePixels = 0
  for (const [index, entry] of entries.entries()) {
    signal.throwIfAborted()
    if (entry.name.endsWith('/') || !passiveOfficePart(entry.name)) continue
    const xml = /\.(?:xml|rels)$/i.test(entry.name)
    // Fonts, HTML altChunks, linked workbooks, OLE and unsupported vector media
    // are not needed for a passive preview and never enter the renderer.
    if (!xml && !/\.(?:png|jpe?g|webp|bmp)$/i.test(entry.name)) continue
    if (xml && entry.unpacked > DOCUMENT_LIMITS.xmlBytes) return invalid()
    const bytes = await expandOfficeEntry(buffer, entry, signal)
    if (xml) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      elements += (text.match(/<[A-Za-z_]/g) || []).length
      if (elements > DOCUMENT_LIMITS.xmlElements) return invalid()
      zip.file(entry.name, cleanXml(text, entry.name))
    } else {
      imagePixels += officeImagePixels(bytes)
      if (imagePixels > 16_000_000) return invalid()
      zip.file(entry.name, bytes)
    }
    // Let close/tab-switch handlers abort between bounded parts.
    if (index % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  signal.throwIfAborted()
  const result = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  signal.throwIfAborted()
  return result
}
