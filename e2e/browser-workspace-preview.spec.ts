/** Session-scoped HTML preview capabilities and file boundaries against the real
 * HTTP preview server. No Electron launch, engine process or model calls. */
import { expect, test } from '@playwright/test'
import { rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { get } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { BrowserPreviewServer } from '../src/main/browser-preview'

const repository = resolve(__dirname, '..'), parent = join(repository, '.e2e-tmp')
const source = ts.transpileModule(readFileSync(join(repository, 'src/main/browser-preview.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function fixture() {
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'browser-workspace-preview-'))
  const workspace = join(directory, 'private-session'), codeRoot = join(directory, 'code-project'), outside = join(directory, 'outside')
  for (const path of [join(workspace, 'docs'), join(workspace, 'assets'), join(workspace, '.private'), codeRoot, outside]) {
    mkdirSync(path, { recursive: true })
  }
  const htmlFile = join(workspace, 'docs', '五子棋.html')
  const html = '<!doctype html><title>SESSION_HTML_MARKER</title><link rel="stylesheet" href="../assets/style.css"><script type="module" src="../assets/main.js"></script>'
  writeFileSync(htmlFile, html)
  writeFileSync(join(workspace, 'assets', 'style.css'), '/* SESSION_CSS_MARKER */ body{color:green}')
  writeFileSync(join(workspace, 'assets', 'main.js'), 'globalThis.previewMarker="SESSION_MODULE_MARKER"')
  writeFileSync(join(workspace, '.private', 'hidden.html'), '<h1>HIDDEN_SECRET_MARKER</h1>')
  writeFileSync(join(outside, 'private.html'), '<h1>OUTSIDE_SECRET_MARKER</h1>')
  writeFileSync(join(codeRoot, 'index.html'), '<h1>CODE_HTML_MARKER</h1>')

  const reads: string[] = []
  const hooks: { afterRead?: (path: string) => void } = {}
  const allowed = (path: string): string => {
    const absolute = resolve(path), rel = relative(codeRoot, absolute)
    if (rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) return absolute
    throw new Error('拒绝访问工作区之外的路径')
  }
  const moduleExports = {} as { BrowserPreviewServer: typeof BrowserPreviewServer }
  runInNewContext(source, { exports: moduleExports, URL, Buffer, process,
    require: (id: string) => id === './fs/file-service' ? { assertAllowed: allowed }
      : id === 'node:fs/promises' ? { ...fsPromises, readFile: async (path: string) => {
        const value = await fsPromises.readFile(path)
        reads.push(path)
        hooks.afterRead?.(path)
        return value
      } } : require(id)
  })
  const preview = new moduleExports.BrowserPreviewServer()
  const capability = (key = 'engine/account/session-one/epoch-one') => {
    let current = true
    return {
      access: { key, root: workspace, validate: async () => {
        if (!current) throw new Error('任务工作区绑定已变化')
      } },
      revoke: () => { current = false }
    }
  }
  return { workspace, codeRoot, outside, htmlFile, html, preview, capability, hooks, reads,
    cleanup: () => {
      preview.dispose()
      if (dirname(resolve(directory)) !== parent || !basename(directory).startsWith('browser-workspace-preview-')) throw new Error('Unsafe workspace-preview cleanup')
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}

async function response(url: string): Promise<{ status: number; body: string }> {
  const result = await fetch(url)
  return { status: result.status, body: await result.text() }
}

// Keep encoded traversal intact: URL constructors otherwise normalize dot
// segments before the request can reach the server's boundary checks.
async function rawResponse(origin: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(origin, { path }, result => {
      const chunks: Buffer[] = []
      result.on('data', chunk => chunks.push(Buffer.from(chunk)))
      result.on('end', () => resolve({ status: result.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      result.on('error', reject)
    }).on('error', reject)
  })
}

test('独立会话工作区运行嵌套 HTML，父目录 CSS 与模块使用会话实际根目录', async () => {
  const f = fixture()
  try {
    const { access } = f.capability()
    // The renderer hint can be a subdirectory; only the verified session root
    // defines the capability, so ../assets stays inside the intended workspace.
    const url = await f.preview.open(f.htmlFile, dirname(f.htmlFile), access)
    expect(decodeURIComponent(new URL(url).pathname)).toContain('/docs/五子棋.html')
    expect(await response(url)).toEqual({ status: 200, body: f.html })
    expect(await response(new URL('../assets/style.css', url).href)).toEqual({ status: 200, body: '/* SESSION_CSS_MARKER */ body{color:green}' })
    expect(await response(new URL('../assets/main.js', url).href)).toEqual({ status: 200, body: 'globalThis.previewMarker="SESSION_MODULE_MARKER"' })
    // A preview capability must not register the private root with the generic
    // desktop allow-list, even after serving its content successfully.
    await rejects(f.preview.open(f.htmlFile, f.workspace), /拒绝访问工作区之外/)
  } finally { f.cleanup() }
})

test('Code 运行保留目录白名单：未授权会话根被拒绝，已打开项目仍可运行', async () => {
  const f = fixture()
  try {
    await rejects(f.preview.open(f.htmlFile, f.workspace), /拒绝访问工作区之外/)
    const url = await f.preview.open(join(f.codeRoot, 'index.html'), f.codeRoot)
    expect(await response(url)).toEqual({ status: 200, body: '<h1>CODE_HTML_MARKER</h1>' })
  } finally { f.cleanup() }
})

test('会话许可拒绝越界 HTML、隐藏文件和编码穿越资源请求', async () => {
  const f = fixture()
  try {
    const { access } = f.capability()
    await rejects(f.preview.open(join(f.outside, 'private.html'), f.outside, access))
    await rejects(f.preview.open(join(f.workspace, '.private', 'hidden.html'), f.workspace, access))
    const url = new URL(await f.preview.open(f.htmlFile, f.workspace, access))
    const prefix = `/${url.pathname.split('/')[1]}/`
    for (const path of [`${prefix}.private/hidden.html`, `${prefix}%2e%2e%2foutside%2fprivate.html`]) {
      const result = await rawResponse(url.origin, path)
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.body).not.toContain('SECRET_MARKER')
    }
    expect(f.reads).toEqual([])
  } finally { f.cleanup() }
})

test('看似位于工作区的目录链接不能读取外部或隐藏目标', async () => {
  const f = fixture()
  try {
    const outsideLink = join(f.workspace, 'public-outside'), hiddenLink = join(f.workspace, 'public-hidden')
    try {
      symlinkSync(f.outside, outsideLink, process.platform === 'win32' ? 'junction' : 'dir')
      symlinkSync(join(f.workspace, '.private'), hiddenLink, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) test.skip(true, '环境不支持目录符号链接')
      throw error
    }
    const { access } = f.capability()
    await rejects(f.preview.open(join(outsideLink, 'private.html'), f.workspace, access))
    await rejects(f.preview.open(join(hiddenLink, 'hidden.html'), f.workspace, access))
    const url = await f.preview.open(f.htmlFile, f.workspace, access)
    for (const path of ['../public-outside/private.html', '../public-hidden/hidden.html']) {
      const result = await response(new URL(path, url).href)
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.body).not.toContain('SECRET_MARKER')
    }
    expect(f.reads).toEqual([])
  } finally { f.cleanup() }
})

test('会话绑定失效后旧 URL 不能继续读文件，也不能重新打开 HTML', async () => {
  const f = fixture()
  try {
    const grant = f.capability(), url = await f.preview.open(f.htmlFile, f.workspace, grant.access)
    expect((await response(url)).body).toContain('SESSION_HTML_MARKER')
    f.reads.length = 0
    grant.revoke()
    const result = await response(url)
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.body).not.toContain('SESSION_HTML_MARKER')
    expect(f.reads).toEqual([])
    await rejects(f.preview.open(f.htmlFile, f.workspace, grant.access), /绑定已变化/)
  } finally { f.cleanup() }
})

test('文件读完但响应发出前绑定改变，不泄露已经读取的内容', async () => {
  const f = fixture()
  try {
    const grant = f.capability(), url = await f.preview.open(f.htmlFile, f.workspace, grant.access)
    f.hooks.afterRead = () => grant.revoke()
    const result = await response(url)
    expect(f.reads).toEqual([f.htmlFile])
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.body).not.toContain('SESSION_HTML_MARKER')
  } finally { f.cleanup() }
})

test('两个会话即使使用同一目录也不复用 URL 许可，撤销互不影响', async () => {
  const f = fixture()
  try {
    const first = f.capability(), second = f.capability('engine/account/session-two/epoch-one')
    const one = await f.preview.open(f.htmlFile, f.workspace, first.access)
    const two = await f.preview.open(f.htmlFile, f.workspace, second.access)
    expect(one).not.toBe(two)
    expect(new URL(one).pathname.split('/')[1]).not.toBe(new URL(two).pathname.split('/')[1])
    first.revoke()
    expect((await response(one)).status).toBeGreaterThanOrEqual(400)
    expect(await response(two)).toEqual({ status: 200, body: f.html })
  } finally { f.cleanup() }
})
