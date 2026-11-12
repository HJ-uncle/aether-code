import { type Session } from 'electron'
import '../protocol-schemes'
import { randomBytes } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertAllowed } from '../fs/file-service'
import { localBrowserInput } from '../../shared/browser-local-file'
import type { BrowserLocalFileInfo } from '../../shared/browser'
import { inspectLocalFile } from './local-file-content'
import { authorizeLocalDirectory, type LocalDirectoryGrant } from './local-directory'

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

export interface LocalBrowserGrant { root: string; origin: string; url: string; userSelected?: true }
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

/** This parser is used only after the trusted workbench requests a user file open. */
export function userLocalPath(input: string): string {
  const value = localBrowserInput(input)
  if (!value || /[\u0000-\u001f]/.test(value)) throw new Error('请输入有效的本机文件绝对路径')
  const target = isLocalFileUrl(value) ? localPath(value) : value
  if (!isAbsolute(target) || /[\u0000-\u001f]/.test(target) || /^[\\/]{2}/.test(target)
    || process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(target)
    || target.slice(process.platform === 'win32' ? 2 : 0).includes(':')) throw new Error('不支持网络共享、设备或备用数据流路径')
  if (process.platform === 'win32' && target.slice(3).split(/[\\/]/).some(part =>
    /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    || /[<>"|?*]/.test(part) || /[. ]$/.test(part) && part !== '.' && part !== '..')) {
    throw new Error('不支持设备名称或有歧义的本机文件路径')
  }
  return resolve(target)
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

  async openUserFile(input: string, directoryOnly = false): Promise<{ info: BrowserLocalFileInfo; grant?: LocalBrowserGrant; directory?: LocalDirectoryGrant }> {
    // A picker or explicit address grants only this file, never an engine-wide filesystem root.
    const target = userLocalPath(await realpath(userLocalPath(input)))
    if ((await stat(target)).isDirectory()) {
      const directory = await authorizeLocalDirectory(target)
      if (this.disposed) throw new Error('本地文件预览已关闭')
      return { info: { path: target, name: basename(target) || target, kind: 'directory', size: 0 }, directory }
    }
    if (directoryOnly) throw new Error('请选择本机目录')
    const info = await inspectLocalFile(target)
    if (this.disposed) throw new Error('本地文件预览已关闭')
    if (info.kind !== 'html') return { info }
    if (!publicPath(basename(target))) throw new Error('本地网页名称不支持隐藏文件')
    const origin = `${SCHEME}://${randomBytes(24).toString('hex')}`
    const hash = isLocalFileUrl(localBrowserInput(input) ?? '') ? new URL(localBrowserInput(input)!).hash : ''
    const grant: LocalBrowserGrant = { root: dirname(target), origin, url: `${origin}/${encodeURIComponent(basename(target))}${hash}`, userSelected: true }
    this.grants.set(origin, grant)
    return { info, grant }
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

  /** Copy only a live tab's capability. Preserve its root-relative resources,
   * but give the copy an independent origin and revocation lifetime. */
  duplicate(input: string, grant: LocalBrowserGrant): LocalBrowserGrant {
    if (this.disposed) throw new Error('本地网页预览已关闭')
    const source = new URL(this.normalize(input, grant))
    const origin = `${SCHEME}://${randomBytes(24).toString('hex')}`
    const copy = { root: grant.root, origin, url: `${origin}${source.pathname}${source.search}${source.hash}`, ...(grant.userSelected ? { userSelected: true as const } : {}) }
    this.grants.set(origin, copy)
    return copy
  }

  normalize(input: string, grant: LocalBrowserGrant): string {
    const url = new URL(input.trim())
    if (url.protocol !== `${SCHEME}:` || `${url.protocol}//${url.host}` !== grant.origin || !this.grants.has(grant.origin)
      || url.username || url.password || !publicPath(decodeURIComponent(url.pathname.slice(1)))) throw new Error('本地网页地址不属于此标签的授权目录')
    return url.href
  }

  async fromFile(input: string, grant: LocalBrowserGrant): Promise<string> {
    const path = grant.userSelected ? userLocalPath(input) : assertAllowed(localPath(input))
    const target = await realpath(path)
    if (!within(grant.root, target)) throw new Error('此文件不属于当前网页目录，请用 browser_open 新建本地文件标签')
    const name = relative(grant.root, target)
    if (!publicPath(name) || !['.html', '.htm'].includes(extname(target).toLowerCase())) throw new Error('请选择授权目录中的 HTML 文件')
    return this.normalize(`${grant.origin}/${name.split(sep).map(encodeURIComponent).join('/')}${new URL(input).hash}`, grant)
  }

  async fileInfo(input: string, grant: LocalBrowserGrant): Promise<BrowserLocalFileInfo> {
    const url = new URL(this.normalize(input, grant))
    const target = await realpath(resolve(grant.root, decodeURIComponent(url.pathname.slice(1))))
    if (!within(grant.root, target) || !publicPath(relative(grant.root, target))) throw new Error('文件已离开授权目录')
    return inspectLocalFile(target)
  }

  fileUrl(info: BrowserLocalFileInfo): string { return pathToFileURL(info.path).href }

  revoke(grant: LocalBrowserGrant): void { this.grants.delete(grant.origin) }

  private async respond(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), grant = this.grants.get(`${url.protocol}//${url.host}`)
      if (this.disposed || !grant || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
      this.normalize(request.url, grant)
      const requested = resolve(grant.root, decodeURIComponent(url.pathname.slice(1)))
      const target = await realpath(grant.userSelected ? userLocalPath(requested) : assertAllowed(requested))
      const mime = MIME[extname(target).toLowerCase()]
      if (!within(grant.root, target) || !publicPath(relative(grant.root, target)) || !mime) return new Response('Forbidden', { status: 403 })
      const before = await lstat(target)
      if (!before.isFile()) return new Response('File unavailable', { status: 404 })
      const handle = await open(target, 'r')
      let body: Uint8Array<ArrayBuffer> | undefined
      try {
        const info = await handle.stat()
        if (info.dev !== before.dev || info.ino !== before.ino || await realpath(target) !== target) return new Response('File changed while opening', { status: 409 })
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
        const after = await lstat(target)
        if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino || await realpath(target) !== target) return new Response('File changed while opening', { status: 409 })
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
