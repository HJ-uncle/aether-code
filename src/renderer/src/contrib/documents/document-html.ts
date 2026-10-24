import { DOCUMENT_LIMITS } from './document-kind'

const blocked = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'link', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'source', 'track', 'foreignobject', 'animate', 'animatetransform', 'set'])
const passiveImage = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z\d+/=\s]+$/i

export function passiveDocumentHtml(html: string): string {
  if (html.length > DOCUMENT_LIMITS.htmlBytes) throw new Error('文档版面过于复杂，超出预览范围。')
  // Template content is inert, including image loads. It is never inserted into
  // the application document; the only destination is a scriptless sandbox.
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ALL)
  let count = 0
  while (walker.nextNode()) if (++count > DOCUMENT_LIMITS.domNodes) throw new Error('文档版面过于复杂，超出预览范围。')
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    if (blocked.has(element.localName.toLowerCase())) { element.remove(); continue }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase(), value = attribute.value
      if (name.startsWith('on') || ['srcdoc', 'srcset', 'action', 'formaction', 'target', 'download', 'ping', 'autofocus'].includes(name) ||
        ((name === 'href' || name.endsWith(':href')) && !/^#[\w:.-]+$/.test(value)) ||
        (name === 'src' && !(element.localName === 'img' && passiveImage.test(value)))) element.removeAttribute(attribute.name)
    }
  }
  return template.innerHTML
}

const escape = (text: string): string => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || '')

export function documentFrame(html: string, name: string, scale: number): string {
  const zoom = Number.isFinite(scale) ? Math.min(2, Math.max(0.2, scale)) : 1
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escape(name)}</title><style>html{color-scheme:light}body{margin:0;background:Canvas;color:CanvasText;font-family:system-ui,sans-serif}.document-page{zoom:${zoom};width:max-content;min-width:100%;box-sizing:border-box}.document-page>section.docx{margin:0 auto;box-shadow:none}.document-page>.slide-container{margin:0 auto}a{color:inherit;text-decoration:none;pointer-events:none}img{max-width:100%}</style></head><body><main class="document-page">${html}</main></body></html>`
}
