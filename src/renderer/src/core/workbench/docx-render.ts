/** docx-preview sections can contain several screens of content without a page
 * break. Measure the rendered content before choosing inspection regions. */
import { prepareOfficeArchiveOffThread } from '../../contrib/documents/office-archive-client'
import { passiveDocumentHtml } from '../../contrib/documents/document-html'
import { docxPreviewRegions } from './docx-preview-regions'

export async function renderDocxPages(data: ArrayBuffer, signal: AbortSignal): Promise<string[]> {
  const [prepared, { parseAsync, renderDocument }] = await Promise.all([
    prepareOfficeArchiveOffThread(data, 'docx', signal), import('docx-preview'),
  ])
  const options = { inWrapper: false, ignoreFonts: true, useBase64URL: true,
    renderAltChunks: false, renderComments: false, experimental: false,
    breakPages: true, ignoreLastRenderedPageBreak: false }
  const model = await parseAsync(prepared, options)
  signal.throwIfAborted()
  const nodes = await renderDocument(model, options)
  const styles = nodes.filter((node): node is HTMLStyleElement => node instanceof HTMLStyleElement).map(node => node.outerHTML).join('')
  const sections = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'SECTION')
    .map(node => passiveDocumentHtml(styles + node.outerHTML))
  return docxPreviewRegions(sections, signal)
}
