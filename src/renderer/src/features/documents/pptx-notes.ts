import { DOCUMENT_LIMITS } from './document-kind'

export interface PptxSlideNotes { text: string; truncated: boolean }
export interface PptxNotesPreview { notes?: PptxSlideNotes[]; notesError?: string }
export const PPTX_NOTES_LIMITS = Object.freeze({ perSlideCharacters: 4000, totalCharacters: 400_000 })
const presentationNamespaces = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'])
const drawingNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'])
const relationshipNamespaces = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
function invalid(): never { throw new Error('此文档的备注结构无法读取，请重新打开文档后重试。') }
const children = (element: Element): Element[] => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1)
const isPresentation = (element: Element, name: string): boolean => element.localName === name && presentationNamespaces.has(element.namespaceURI || '')

function parseXml(value: string): Document {
  if (value.length > DOCUMENT_LIMITS.xmlBytes || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)) invalid()
  const document = new DOMParser().parseFromString(value, 'application/xml')
  if (document.getElementsByTagName('parsererror').length || !document.documentElement) invalid()
  return document
}

function relationshipPath(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
}

function resolvePart(owner: string, target: string, folder: 'slides' | 'notesSlides'): string {
  if (!target || /[\\\x00-\x1f:?#]/.test(target) || target.startsWith('//')) invalid()
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!parts.length) invalid(); parts.pop() }
    else parts.push(segment)
  }
  const result = parts.join('/')
  if (!result.startsWith(`ppt/${folder}/`) || !result.endsWith('.xml')) invalid()
  return result
}

function relations(document: Document, owner: string, kind: 'slide' | 'notesSlide'): Map<string, string> {
  const result = new Map<string, string>(), ids = new Set<string>()
  for (const item of Array.from(document.getElementsByTagNameNS(packageNamespace, 'Relationship'))) {
    const id = item.getAttribute('Id') || '', type = item.getAttribute('Type') || ''
    if (!id || ids.has(id)) invalid()
    ids.add(id)
    if (![...relationshipNamespaces].some(namespace => type === `${namespace}/${kind}`)) continue
    if ((item.getAttribute('TargetMode') || '').toLowerCase() === 'external') invalid()
    result.set(id, resolvePart(owner, item.getAttribute('Target') || '', kind === 'slide' ? 'slides' : 'notesSlides'))
  }
  return result
}

function speakerText(document: Document): PptxSlideNotes {
  if (!isPresentation(document.documentElement, 'notes')) invalid()
  const paragraphs: string[] = []
  for (const shape of Array.from(document.getElementsByTagNameNS('*', 'sp'))) {
    if (!presentationNamespaces.has(shape.namespaceURI || '')) continue
    const placeholder = Array.from(shape.getElementsByTagNameNS('*', 'ph')).find(node => presentationNamespaces.has(node.namespaceURI || ''))
    // The slide image, page number, date, header and footer are notes-page
    // furniture. Only the body placeholder and user-added text shapes are notes.
    if (placeholder && placeholder.getAttribute('type') !== 'body') continue
    const body = children(shape).find(node => isPresentation(node, 'txBody'))
    if (!body) continue
    for (const paragraph of children(body)) {
      if (paragraph.localName !== 'p' || !drawingNamespaces.has(paragraph.namespaceURI || '')) continue
      let value = ''
      for (const run of children(paragraph)) {
        if (!drawingNamespaces.has(run.namespaceURI || '')) continue
        if (run.localName === 'br') value += '\n'
        else if (run.localName === 'r') for (const fragment of children(run)) {
          if (fragment.localName === 't' && drawingNamespaces.has(fragment.namespaceURI || '')) value += fragment.textContent || ''
        }
      }
      paragraphs.push(value)
    }
  }
  const full = paragraphs.join('\n').replace(/\r\n?/g, '\n').trim()
  const limited = full.slice(0, PPTX_NOTES_LIMITS.perSlideCharacters)
  // Avoid splitting an emoji's surrogate pair at the preview boundary.
  const value = /[\uD800-\uDBFF]$/.test(limited) ? limited.slice(0, -1) : limited
  return { text: value, truncated: value.length < full.length }
}

/** Input must be the STORE archive returned by prepareOfficeArchive. That shared
 * boundary validates/limits the original ZIP and sanitizes every XML part first.
 * Read only relationship-selected notes parts; never expand unrelated media again. */
export async function readPptxNotes(preparedArchive: ArrayBuffer, signal: AbortSignal): Promise<PptxSlideNotes[]> {
  signal.throwIfAborted()
  if (preparedArchive.byteLength > DOCUMENT_LIMITS.expandedBytes + DOCUMENT_LIMITS.entries * 2048) invalid()
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(preparedArchive)
  signal.throwIfAborted()
  const read = async (part: string, optional = false): Promise<Document | undefined> => {
    signal.throwIfAborted()
    const entry = archive.file(part)
    if (!entry) { if (optional) return undefined; return invalid() }
    const xml = await entry.async('string')
    signal.throwIfAborted()
    return parseXml(xml)
  }
  const presentation = (await read('ppt/presentation.xml'))!
  const relationshipDocument = (await read('ppt/_rels/presentation.xml.rels'))!
  const slides = relations(relationshipDocument, 'ppt/presentation.xml', 'slide')
  const ids = Array.from(presentation.getElementsByTagNameNS('*', 'sldId')).filter(node => presentationNamespaces.has(node.namespaceURI || ''))
  if (!ids.length || ids.length > DOCUMENT_LIMITS.pages) invalid()
  const result: PptxSlideNotes[] = [], visited = new Set<string>()
  let characters = 0
  for (const id of ids) {
    signal.throwIfAborted()
    const relationshipId = [...relationshipNamespaces].map(namespace => id.getAttributeNS(namespace, 'id')).find(Boolean)
    const slide = relationshipId ? slides.get(relationshipId) : undefined
    if (!slide || visited.has(slide) || !archive.file(slide)) invalid()
    visited.add(slide)
    const slideRelationships = await read(relationshipPath(slide), true)
    const notes = slideRelationships ? [...relations(slideRelationships, slide, 'notesSlide').values()] : []
    if (notes.length > 1) invalid()
    const note = notes.length ? speakerText((await read(notes[0]))!) : { text: '', truncated: false }
    characters += note.text.length
    if (characters > PPTX_NOTES_LIMITS.totalCharacters) invalid()
    result.push(note)
    // Notes remain cancellable between slides instead of blocking tab switches.
    if (result.length % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  signal.throwIfAborted()
  return result
}

/** Ancillary notes must not hide slides that the renderer already converted.
 * Cancellation still belongs to the whole preview and must propagate unchanged. */
export async function readPptxNotesForPreview(preparedArchive: ArrayBuffer, pageCount: number, signal: AbortSignal): Promise<PptxNotesPreview> {
  try {
    const notes = await readPptxNotes(preparedArchive, signal)
    if (notes.length !== pageCount) return { notesError: '此文档的备注页序无法对应，暂不显示备注；幻灯片仍可查看。' }
    return { notes }
  } catch (reason: unknown) {
    signal.throwIfAborted()
    if (reason instanceof Error && reason.name === 'AbortError') throw reason
    return { notesError: '此文档的备注无法读取，请重新打开文档后重试；幻灯片仍可查看。' }
  }
}
