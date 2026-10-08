import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { assertAllowed } from './fs/file-service'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function publicPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/')
  // Code artifacts deliberately live in .ae. Other hidden files stay private,
  // including when a public-looking symlink resolves to a hidden target.
  return parts.every((part, index) => !part.startsWith('.') ||
    (index === 0 && part === '.ae' && ['brainstorm', 'tmp'].includes(parts[1])))
}

interface PreviewEntry { server: Server; origin: string; token: string }

function closePreview(entry: PreviewEntry): void {
  entry.server.closeAllConnections()
  if (entry.server.listening) entry.server.close()
}

/** Short-lived workspace servers run scripts without exposing an unrestricted file:// origin. */
export class BrowserPreviewServer {
  private servers = new Map<string, Promise<PreviewEntry>>()
  private disposed = false

  async open(filePath: string, workspaceRoot: string): Promise<string> {
    if (this.disposed) throw new Error('网页预览服务已关闭')
    const root = await realpath(assertAllowed(workspaceRoot))
    const target = await realpath(assertAllowed(filePath))
    if (this.disposed) throw new Error('网页预览服务已关闭')
    if (!within(root, target) || !['.html', '.htm'].includes(extname(target).toLowerCase())) {
      throw new Error('请选择当前工作区中的 HTML 文件，应用项目请使用开发服务器地址')
    }
    if (!publicPath(relative(root, target))) throw new Error('此目录不用于网页预览，请使用工作区中的网页或 .ae 产物目录')
    let pending = this.servers.get(root)
    if (!pending) {
      // Publish the promise before awaiting listen: simultaneous file opens
      // must share one server so disposal cannot lose the earlier instance.
      pending = this.start(root)
      this.servers.set(root, pending)
      const current = pending
      void pending.catch(() => {
        if (this.servers.get(root) === current) this.servers.delete(root)
      })
    }
    const entry = await pending
    if (this.disposed) {
      closePreview(entry)
      throw new Error('网页预览服务已关闭')
    }
    return `${entry.origin}/${entry.token}/${relative(root, target).split(sep).map(encodeURIComponent).join('/')}`
  }

  private async start(root: string): Promise<PreviewEntry> {
      const token = randomBytes(24).toString('hex')
      const cookieName = `aether_preview_${token.slice(0, 12)}`
      const server = createServer((request, response) => {
        void (async () => {
          if (this.disposed) { response.writeHead(503); response.end('Preview closed'); return }
          if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return }
          const raw = request.url ?? '/'
          const url = new URL(raw, 'http://preview.invalid')
          const prefix = `/${token}/`
          const capabilityUrl = url.pathname.startsWith(prefix)
          const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim())
          if (!capabilityUrl && !cookies.includes(`${cookieName}=${token}`)) { response.writeHead(404); response.end('Not found'); return }
          const path = decodeURIComponent(url.pathname.slice(capabilityUrl ? prefix.length : 1))
          if (path.includes('\0') || !publicPath(path)) {
            response.writeHead(403); response.end('Forbidden'); return
          }
          const candidate = await realpath(assertAllowed(resolve(root, path)))
          if (!within(root, candidate) || !publicPath(relative(root, candidate))) { response.writeHead(403); response.end('Forbidden'); return }
          const info = await stat(candidate)
          if (!info.isFile() || info.size > 32 * 1024 * 1024) { response.writeHead(413); response.end('File unavailable'); return }
          response.writeHead(200, { 'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            // Root-relative resources need the same capability after the initial
            // token URL. HttpOnly keeps the capability out of page JavaScript.
            ...(capabilityUrl ? { 'Set-Cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict` } : {}) })
          response.end(request.method === 'HEAD' ? undefined : await readFile(candidate))
        })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end('File unavailable') })
      })
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); throw new Error('无法启动本地网页预览') }
      const entry = { server, origin: `http://127.0.0.1:${address.port}`, token }
      // listen may finish after the window was closed; a late server must
      // never outlive the owning browser surface.
      if (this.disposed) { closePreview(entry); throw new Error('网页预览服务已关闭') }
      return entry
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.servers.values()) void pending.then(closePreview, () => {})
    this.servers.clear()
  }
}
