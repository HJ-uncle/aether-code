import { app, protocol, type Session } from 'electron'
import { randomBytes } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAllowed } from '../fs/file-service'

const SCHEME = 'aether-local'
const MAX_BYTES = 32 * 1024 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf'
}

// A standard origin supports module scripts and relative assets without a listening HTTP server.
if (!app.isReady()) protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

export interface LocalBrowserGrant { root: string; origin: string; url: string }
export const isLocalFileUrl = (value: string): boolean => /^file:/i.test(value.trim())
function within(root: string, target: string): boolean {
  const name = relative(root, target)
  return name === '' || !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`)
}
function publicPath(value: string): boolean {
  return !value.includes('\0') && !value.includes(':') && value.split(/[\\/]/).every(part => part !== '..' && !part.startsWith('.'))
}
function localPath(input: string): string {
  const url = new URL(input.trim())
  if (url.protocol !== 'file:' || url.hostname || url.username || url.password || url.search) throw new Error('请选择本机 HTML 文件，不支持网络共享或带凭据的文件地址')
  const target = fileURLToPath(url)
  if (!isAbsolute(target) || target.startsWith('\\\\') || target.includes('\0') || /:/.test(target.slice(process.platform === 'win32' ? 2 : 0))) throw new Error('本地文件地址无效')
  return target
}

/** Each random origin exposes one selected HTML's directory, with revocation when its tab closes. */
export class BrowserLocalFiles {
  private readonly grants = new Map<string, LocalBrowserGrant>()
  private attached?: Session
  private disposed = false

  async open(input: string): Promise<LocalBrowserGrant> {
    const target = await realpath(assertAllowed(localPath(input)))
    assertAllowed(target)
    const info = await stat(target)
    if (!info.isFile() || info.size > MAX_BYTES || !['.html', '.htm'].includes(extname(target).toLowerCase()) || !publicPath(basename(target))) throw new Error('本地浏览器仅打开不超过 32 MiB 的 HTML 文件；办公文档请使用资源预览')
    if (this.disposed) throw new Error('本地网页预览已关闭')
    const origin = `${SCHEME}://${randomBytes(24).toString('hex')}`
    const grant = { root: dirname(target), origin, url: `${origin}/${encodeURIComponent(basename(target))}${new URL(input).hash}` }
    this.grants.set(origin, grant)
    return grant
  }

  attach(browserSession: Session, owns: (webContentsId: number, url: string) => boolean): void {
    if (this.attached === browserSession) return
    if (this.attached) throw new Error('本地文件协议会话不匹配')
    this.attached = browserSession
    browserSession.webRequest.onBeforeRequest({ urls: [`${SCHEME}://*/*`, 'file://*/*'] }, (details, done) => {
      // Protocol capability tokens must also belong to the requesting tab, not merely be known to its page.
      done({ cancel: details.url.startsWith('file:') || details.webContentsId === undefined || !owns(details.webContentsId, details.url) })
    })
    browserSession.protocol.handle(SCHEME, request => this.respond(request))
  }

  normalize(input: string, grant: LocalBrowserGrant): string {
    const url = new URL(input.trim())
    if (url.protocol !== `${SCHEME}:` || `${url.protocol}//${url.host}` !== grant.origin || !this.grants.has(grant.origin)
      || url.username || url.password || !publicPath(decodeURIComponent(url.pathname.slice(1)))) throw new Error('本地网页地址不属于此标签的授权目录')
    return url.href
  }

  async fromFile(input: string, grant: LocalBrowserGrant): Promise<string> {
    const target = await realpath(assertAllowed(localPath(input)))
    if (!within(grant.root, target)) throw new Error('此文件不属于当前网页目录，请用 browser_open 新建本地文件标签')
    const name = relative(grant.root, target)
    if (!publicPath(name) || !['.html', '.htm'].includes(extname(target).toLowerCase())) throw new Error('请选择授权目录中的 HTML 文件')
    return this.normalize(`${grant.origin}/${name.split(sep).map(encodeURIComponent).join('/')}${new URL(input).hash}`, grant)
  }

  revoke(grant: LocalBrowserGrant): void { this.grants.delete(grant.origin) }

  private async respond(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), grant = this.grants.get(`${url.protocol}//${url.host}`)
      if (this.disposed || !grant || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
      this.normalize(request.url, grant)
      const target = await realpath(assertAllowed(resolve(grant.root, decodeURIComponent(url.pathname.slice(1)))))
      const mime = MIME[extname(target).toLowerCase()]
      if (!within(grant.root, target) || !publicPath(relative(grant.root, target)) || !mime) return new Response('Forbidden', { status: 403 })
      const handle = await open(target, 'r')
      let body: Uint8Array<ArrayBuffer> | undefined
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > MAX_BYTES) return new Response('File unavailable', { status: 413 })
        // A concurrent writer cannot make a whole-file read allocate beyond the documented preview budget.
        if (request.method !== 'HEAD') {
          const bytes = Buffer.alloc(info.size + 1)
          let bytesRead = 0
          while (bytesRead < bytes.length) {
            const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
            if (!chunk.bytesRead) break
            bytesRead += chunk.bytesRead
          }
          if (bytesRead > info.size) return new Response('File changed while opening', { status: 409 })
          body = Uint8Array.from(bytes.subarray(0, bytesRead))
        }
      } finally { await handle.close() }
      if (this.disposed || !this.grants.has(grant.origin) || (body?.byteLength ?? 0) > MAX_BYTES) return new Response('File unavailable', { status: 404 })
      return new Response(body, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" } })
    } catch { return new Response('File unavailable', { status: 404 }) }
  }

  dispose(): void {
    this.disposed = true; this.grants.clear(); this.attached?.protocol.unhandle(SCHEME)
    this.attached?.webRequest.onBeforeRequest(null)
  }
}
