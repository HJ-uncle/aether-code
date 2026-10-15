/** Current office-delivery contract against a real streaming HTTP peer. Covers
 * original binary bytes, session rebinding, cancellation and destination races. */
import { expect, test } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { downloadWorkspaceToFile } from '../src/main/engine/workspace-download'

async function scenario(run: (context: {
  directory: string; bytes: Buffer; signal: AbortSignal; controller: AbortController
  changeRoot: () => void; changeIdentity: () => void
  setBody: (callback: (response: ServerResponse) => void) => void
  download: (name?: string) => Promise<{ bytes: number; sha256: string }>
}) => Promise<void>): Promise<void> {
  const parent = resolve(__dirname, '..', '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'office-download-'))
  const bytes = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('中文二进制\0正文', 'utf8'), Buffer.from([0, 255, 254, 128])])
  let root = '/workspace/office-session', current = true
  const controller = new AbortController()
  let body = (response: ServerResponse): void => { response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes) }
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.headers['x-test-owner'] !== 'original-account') { response.writeHead(401); response.end(); return }
    if (url.searchParams.get('sessionId') !== 'work-office-test') { response.writeHead(403); response.end(); return }
    if (url.pathname.endsWith('/directory')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 200, data: { root } })); return
    }
    if (url.pathname.endsWith('/download') && url.searchParams.get('path') === '输出/周报.docx') { body(response); return }
    response.writeHead(404); response.end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await run({ directory, bytes, signal: controller.signal, controller,
      changeRoot: () => { root = '/workspace/other-session' }, changeIdentity: () => { current = false },
      setBody: callback => { body = callback },
      download: (name = '另存 周报.docx') => downloadWorkspaceToFile({ baseUrl: url, headers: { 'X-Test-Owner': 'original-account' },
        sessionId: 'work-office-test', path: '输出/周报.docx', workspaceRoot: '/workspace/office-session',
        destination: join(directory, name), signal: controller.signal,
        assertCurrent: () => { if (!current) throw new Error('identity changed') } })
    })
    expect(readdirSync(directory).some(name => name.startsWith('.aether-download-'))).toBe(false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    const target = resolve(directory)
    if (dirname(target) !== parent || !basename(target).startsWith('office-download-')) throw new Error('Unsafe test cleanup')
    rmSync(target, { recursive: true, force: true })
  }
}

test('原文件以真实二进制落盘，中文路径、大小与SHA256一致', async () => {
  await scenario(async ({ directory, bytes, download }) => {
    const result = await download()
    expect(readFileSync(join(directory, '另存 周报.docx'))).toEqual(bytes)
    expect(result).toEqual({ bytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
  })
})

test('工作区绑定或引擎身份在传输中变化，保留已有目标且无临时残留', async () => {
  for (const reason of ['root', 'identity']) await scenario(async ({ directory, bytes, download, setBody, changeRoot, changeIdentity }) => {
    const destination = join(directory, '另存 周报.docx')
    writeFileSync(destination, 'ORIGINAL')
    setBody(response => {
      response.writeHead(200, { 'content-length': bytes.length })
      response.write(bytes.subarray(0, 4))
      if (reason === 'root') changeRoot(); else changeIdentity()
      response.end(bytes.subarray(4))
    })
    await expect(download()).rejects.toThrow(reason === 'root' ? /任务工作区已变化/ : /identity changed/)
    expect(readFileSync(destination, 'utf8')).toBe('ORIGINAL')
  })
})

test('取消和文件大小超限不会发布半个办公文件', async () => {
  await scenario(async ({ directory, bytes, download, setBody, controller }) => {
    setBody(response => { response.writeHead(200); response.write(bytes.subarray(0, 4)); controller.abort(new Error('user cancelled')) })
    await expect(download()).rejects.toThrow()
    expect(existsSync(join(directory, '另存 周报.docx'))).toBe(false)
  })
  await scenario(async ({ directory, download, setBody }) => {
    setBody(response => { response.writeHead(200, { 'content-length': 50 * 1024 * 1024 + 1 }); response.end() })
    await expect(download()).rejects.toThrow(/50 MiB/)
    expect(existsSync(join(directory, '另存 周报.docx'))).toBe(false)
  })
})

test('下载期间目标被其他程序修改时拒绝覆盖', async () => {
  await scenario(async ({ directory, bytes, download, setBody }) => {
    const destination = join(directory, '另存 周报.docx')
    writeFileSync(destination, 'ORIGINAL')
    setBody(response => {
      response.writeHead(200, { 'content-length': bytes.length })
      writeFileSync(destination, 'CHANGED BY ANOTHER PROGRAM')
      response.end(bytes)
    })
    await expect(download()).rejects.toThrow(/另存位置的文件已变化/)
    expect(readFileSync(destination, 'utf8')).toBe('CHANGED BY ANOTHER PROGRAM')
  })
})
