import { Marked } from 'marked'
import { readFile, stat, paths } from '@renderer/core/workspace/fs-client'
import { getDocument } from '@renderer/core/editor/editor-store'
import { resolvePreviewResource } from '@renderer/core/editor/preview-resource-path'
import { fileIdentity } from '@renderer/core/editor/file-identity'

const MAX_RESOURCE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm'
}

function encodedText(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(binary)
}

async function replaceAsync(value: string, regex: RegExp, replace: (match: RegExpMatchArray) => Promise<string>): Promise<string> {
  const matches = [...value.matchAll(regex)]
  const results = await Promise.all(matches.map(replace))
  let result = '', offset = 0
  matches.forEach((match, index) => {
    const start = match.index ?? 0
    result += value.slice(offset, start) + results[index]
    offset = start + match[0].length
  })
  return result + value.slice(offset)
}

export interface PreviewDocumentInput {
  content: string
  filePath: string
  workspaceRoot: string
  kind: 'markdown' | 'html'
  channel: string
  bridgeScript: string
  colors: { background: string; foreground: string; muted: string; border: string; accent: string }
}

/** Static resources use the existing workspace-checked IPC; the iframe gets only self-contained bytes. */
export async function buildSourcePreviewDocument(input: PreviewDocumentInput): Promise<string> {
  const parser = new Marked({ gfm: true, breaks: false })
  const html = input.kind === 'markdown' ? await parser.parse(input.content) : input.content
  const document = new DOMParser().parseFromString(html, 'text/html')
  const resources = new Map<string, Promise<Awaited<ReturnType<typeof readFile>> | null>>()
  let totalBytes = 0
  const load = (path: string): Promise<Awaited<ReturnType<typeof readFile>> | null> => {
    const key = fileIdentity(path)
    const existing = resources.get(key)
    if (existing) return existing
    if (resources.size >= 64) return Promise.resolve(null)
    const job = (async () => {
      try {
        const info = await stat(path)
        if (info.size > MAX_RESOURCE_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) return null
        totalBytes += info.size
        const edited = getDocument(path)
        if (edited && !edited.isBinary && !edited.truncated) return { path, content: edited.content, isBinary: false, size: info.size, truncated: false }
        const file = await readFile(path)
        return file.tooLarge || file.truncated ? null : file
      } catch { return null }
    })()
    resources.set(key, job)
    return job
  }
  const resourceUrl = async (reference: string, fromPath: string): Promise<string> => {
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml|avif)|font\/[^;,]+|audio\/[^;,]+|video\/[^;,]+)[;,]/i.test(reference)) return reference
    const path = resolvePreviewResource(fromPath, reference, input.workspaceRoot)
    if (!path) return ''
    const mime = MIME[paths.basename(path).split('.').pop()?.toLowerCase() ?? '']
    if (!mime) return ''
    const file = await load(path)
    if (!file) return ''
    return `data:${mime};base64,${file.base64 ?? encodedText(file.content)}`
  }
  const rewriteCss = async (css: string, fromPath: string, ancestors: string[] = []): Promise<string> => {
    const expanded = await replaceAsync(css, /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/gi, async (match) => {
      const path = resolvePreviewResource(fromPath, match[1], input.workspaceRoot)
      if (!path || ancestors.includes(fileIdentity(path)) || ancestors.length >= 4 || !/\.css$/i.test(path)) return ''
      const file = await load(path)
      if (!file || file.isBinary) return ''
      const imported = await rewriteCss(file.content, path, [...ancestors, fileIdentity(path)])
      return match[2]?.trim() ? `@media ${match[2]} {${imported}}` : imported
    })
    return replaceAsync(expanded, /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi, async (match) => {
      const reference = (match[2] ?? match[3] ?? '').trim()
      if (reference.startsWith('#')) return `url("${reference.replace(/"/g, '')}")`
      return `url("${await resourceUrl(reference, fromPath)}")`
    })
  }

  // Preview is static: user scripts, nested browsing contexts and navigation cannot gain app privileges.
  document.querySelectorAll('script,iframe,frame,frameset,object,embed,base,meta[http-equiv],meta[charset],meta[name="aether-preview-channel"]').forEach((element) => element.remove())
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ['srcdoc', 'nonce', 'integrity', 'crossorigin', 'formaction', 'action', 'ping'].includes(attribute.name)) element.removeAttribute(attribute.name)
    }
  }
  await Promise.all([...document.querySelectorAll('link')].map(async (link) => {
    if (link.rel !== 'stylesheet') { link.remove(); return }
    const path = resolvePreviewResource(input.filePath, link.getAttribute('href') ?? '', input.workspaceRoot)
    const file = path && /\.css$/i.test(path) ? await load(path) : null
    if (!path || !file || file.isBinary) { link.remove(); return }
    const style = document.createElement('style')
    style.textContent = (await rewriteCss(file.content, path, [fileIdentity(path)])).replace(/<\/style/gi, '<\\/style')
    link.replaceWith(style)
  }))
  await Promise.all([...document.querySelectorAll('style')].map(async (style) => {
    style.textContent = (await rewriteCss(style.textContent ?? '', input.filePath)).replace(/<\/style/gi, '<\\/style')
  }))
  await Promise.all([...document.querySelectorAll('[style]')].map(async (element) => {
    element.setAttribute('style', await rewriteCss(element.getAttribute('style') ?? '', input.filePath))
  }))
  await Promise.all([...document.querySelectorAll('[src], [poster], image[href], image[xlink\\:href]')].map(async (element) => {
    for (const attribute of ['src', 'poster', 'href', 'xlink:href']) {
      if (!element.hasAttribute(attribute)) continue
      const rewritten = await resourceUrl(element.getAttribute(attribute) ?? '', input.filePath)
      if (rewritten) element.setAttribute(attribute, rewritten)
      else element.removeAttribute(attribute)
    }
  }))
  // srcset grammar also permits commas inside data URLs; use src as the deterministic local fallback.
  document.querySelectorAll('[srcset]').forEach((element) => element.removeAttribute('srcset'))
  document.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) return
    const path = resolvePreviewResource(input.filePath, href, input.workspaceRoot)
    anchor.removeAttribute('href')
    anchor.removeAttribute('target')
    if (path) { anchor.setAttribute('data-aether-local-path', path); anchor.setAttribute('href', '#') }
  })
  // DOM serialization hides nonce attributes; an exact content hash survives srcdoc serialization.
  const bridgeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.bridgeScript))
  const bridgeHash = btoa(String.fromCharCode(...new Uint8Array(bridgeDigest)))
  const csp = document.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; script-src 'sha256-${bridgeHash}'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`
  document.head.prepend(csp)
  if (input.kind === 'html') {
    const defaults = document.createElement('style')
    defaults.textContent = 'html{color-scheme:light;background:Canvas;color:CanvasText}img,video{max-width:100%}'
    csp.after(defaults)
  }
  const channel = document.createElement('meta')
  channel.name = 'aether-preview-channel'
  channel.content = input.channel
  document.head.append(channel)
  if (input.kind === 'markdown') {
    const style = document.createElement('style')
    const colors = input.colors
    style.textContent = `html{color-scheme:light dark}body{box-sizing:border-box;max-width:920px;margin:0 auto;padding:24px 28px;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:${colors.background};color:${colors.foreground};overflow-wrap:anywhere}h1,h2,h3{line-height:1.3}h1,h2{padding-bottom:.35em;border-bottom:1px solid ${colors.border}}a{color:${colors.accent}}img,video{max-width:100%}pre,code{font-family:Consolas,monospace}pre{overflow:auto;padding:12px;border:1px solid ${colors.border};border-radius:6px}blockquote{margin-left:0;padding-left:16px;border-left:3px solid ${colors.border};color:${colors.muted}}table{border-collapse:collapse}th,td{border:1px solid ${colors.border};padding:6px 10px}hr{border:0;border-top:1px solid ${colors.border}}input{pointer-events:none}`
    document.head.append(style)
  }
  const script = document.createElement('script')
  script.textContent = input.bridgeScript
  document.body.append(script)
  return '<!doctype html>' + document.documentElement.outerHTML
}
