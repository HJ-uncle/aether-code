/** Real PPTX notes relationships, placeholder filtering and bounded plain-text extraction; no window or engine. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { DOMParser } from '@xmldom/xmldom'

const previousParser = globalThis.DOMParser
globalThis.DOMParser = DOMParser
after(() => { if (previousParser) globalThis.DOMParser = previousParser; else delete globalThis.DOMParser })
const directory = dirname(fileURLToPath(import.meta.url)), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(join(directory, `${name}.ts`), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${javascript}\n})`, { filename: name }).runInThisContext()(specifier => {
    if (specifier === './document-kind') return load('document-kind')
    if (specifier === 'jszip') return JSZip
    throw new Error(`Unexpected import ${specifier}`)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { readPptxNotes, readPptxNotesForPreview, PPTX_NOTES_LIMITS } = load('pptx-notes')
const signal = () => new AbortController().signal
const bytes = archive => archive.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
async function fixture(notes = ['第一页的真实备注', '第二页的真实备注']) {
  const deck = new PptxGenJS()
  for (const [index, note] of notes.entries()) { const slide = deck.addSlide(); slide.addText(`标题 ${index + 1}`); if (note !== null) slide.addNotes(note) }
  return JSZip.loadAsync(await deck.write({ outputType: 'arraybuffer' }))
}
const xmlText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const shape = (placeholder, text) => `<p:sp><p:nvSpPr><p:cNvPr id="42" name="fixture"/><p:cNvSpPr/><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlText(text)}</a:t></a:r></a:p></p:txBody></p:sp>`

test('follows presentation order and slide-to-notes relationships, including nonmatching filenames', async () => {
  const zip = await fixture()
  const presentation = await zip.file('ppt/presentation.xml').async('string')
  const ids = presentation.match(/<p:sldId\b[^>]*\/>/g)
  zip.file('ppt/presentation.xml', presentation.replace(ids.join(''), ids.toReversed().join('')))
  const notes = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string')
  zip.remove('ppt/notesSlides/notesSlide1.xml'); zip.file('ppt/notesSlides/custom-note.xml', notes)
  const rel = 'ppt/slides/_rels/slide1.xml.rels'
  zip.file(rel, (await zip.file(rel).async('string')).replace('../notesSlides/notesSlide1.xml', '../notesSlides/custom-note.xml'))
  assert.deepEqual(await readPptxNotes(await bytes(zip), signal()), [
    { text: '第二页的真实备注', truncated: false }, { text: '第一页的真实备注', truncated: false },
  ])
})

test('keeps speaker paragraphs and free text while excluding slide numbers, headers, footers, dates and images', async () => {
  const zip = await fixture(['真正备注', null])
  const part = 'ppt/notesSlides/notesSlide1.xml'
  const original = await zip.file(part).async('string')
  zip.file(part, original.replace('</p:spTree>', [shape('hdr', '页眉不能显示'), shape('ftr', '页脚不能显示'),
    shape('dt', '日期不能显示'), shape('sldImg', '幻灯片缩略图不能显示'), shape('', '自由备注文字'), '</p:spTree>'].join('')))
  const result = await readPptxNotes(await bytes(zip), signal())
  assert.equal(result[0].text, '真正备注\n自由备注文字')
  assert.deepEqual(result[1], { text: '', truncated: false })
})

test('returns escaped-looking content as inert plain text and preserves explicit paragraph breaks', async () => {
  const zip = await fixture(['第一段\n第二段 <img src=x onerror=alert(1)> & 完成'])
  const result = await readPptxNotes(await bytes(zip), signal())
  assert.equal(result[0].text, '第一段\n第二段 <img src=x onerror=alert(1)> & 完成')
  assert.equal(typeof result[0].text, 'string')
})

test('bounds each slide and the overall note payload without splitting surrogate pairs', async () => {
  const long = '中'.repeat(PPTX_NOTES_LIMITS.perSlideCharacters - 1) + '😀尾部'
  const zip = await fixture([long, '第二页正常'])
  const result = await readPptxNotes(await bytes(zip), signal())
  assert.equal(result[0].truncated, true)
  assert.equal(result[0].text.length, PPTX_NOTES_LIMITS.perSlideCharacters - 1)
  assert.equal(result[1].text, '第二页正常')
  assert.ok(result.reduce((total, row) => total + row.text.length, 0) <= PPTX_NOTES_LIMITS.totalCharacters)
})

test('does not guess a note from its filename when the relationship is absent', async () => {
  const zip = await fixture(['孤立备注不显示'])
  const part = 'ppt/slides/_rels/slide1.xml.rels'
  zip.file(part, (await zip.file(part).async('string')).replace(/<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*\/>/, ''))
  assert.deepEqual(await readPptxNotes(await bytes(zip), signal()), [{ text: '', truncated: false }])
})

test('rejects external, missing or traversal notes targets and honors cancellation', async () => {
  const source = await fixture(['不能远程读取'])
  const original = await bytes(source), rel = 'ppt/slides/_rels/slide1.xml.rels'
  for (const target of ['https://example.invalid/notes.xml', '../../../outside.xml', '../notesSlides/missing.xml']) {
    const zip = await JSZip.loadAsync(original)
    zip.file(rel, (await zip.file(rel).async('string')).replace('../notesSlides/notesSlide1.xml', target))
    await assert.rejects(readPptxNotes(await bytes(zip), signal()), /备注结构/)
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readPptxNotes(original, controller.signal), { name: 'AbortError' })
})

test('returns an optional-notes error without rejecting valid slide source when notes are broken or page count differs', async () => {
  const zip = await fixture(['原始备注'])
  const part = 'ppt/slides/_rels/slide1.xml.rels'
  zip.file(part, (await zip.file(part).async('string')).replace('../notesSlides/notesSlide1.xml', '../notesSlides/missing.xml'))
  const source = await bytes(zip)
  const slideBefore = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(slideBefore, /标题 1/)
  const before = Buffer.from(source)
  const unavailable = await readPptxNotesForPreview(source, 1, signal())
  assert.equal(unavailable.notes, undefined)
  assert.match(unavailable.notesError, /备注无法读取.*幻灯片仍可查看/)
  assert.deepEqual(Buffer.from(source), before)
  const valid = await bytes(await fixture(['有效备注']))
  const mismatch = await readPptxNotesForPreview(valid, 2, signal())
  assert.equal(mismatch.notes, undefined)
  assert.match(mismatch.notesError, /备注页序无法对应/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readPptxNotesForPreview(valid, 1, controller.signal), { name: 'AbortError' })
})
