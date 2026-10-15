import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, linkSync, lstatSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

interface DownloadOptions {
  baseUrl: string
  headers: Record<string, string>
  sessionId: string
  path: string
  workspaceRoot: string
  destination: string
  signal: AbortSignal
  assertCurrent: () => void
}

/** Canonical roots come from the session API, never from a local folder picker. */
function sameRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = normalize(left), b = normalize(right)
  return /^[A-Za-z]:\//.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
}

function destinationVersion(destination: string): string {
  try {
    const stat = lstatSync(destination, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('另存位置必须是普通文件')
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/** Stream to a sibling temporary file. The native destination is published only
 * after the complete bytes, session binding and connection have been checked. */
export async function downloadWorkspaceToFile(options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const { signal, assertCurrent } = options
  const assertLive = (): void => { signal.throwIfAborted(); assertCurrent() }
  const checkBinding = async (): Promise<void> => {
    assertLive()
    const query = new URLSearchParams({ sessionId: options.sessionId, path: '.' })
    const response = await fetch(`${options.baseUrl}/api/v1/workspace/directory?${query}`, {
      headers: options.headers, redirect: 'error', signal
    })
    if (!response.ok) throw new Error(`无法确认任务工作区（HTTP ${response.status}）`)
    const result = await response.json() as { code?: number; data?: { root?: unknown } }
    assertLive()
    if ((result.code !== 0 && result.code !== 200) || typeof result.data?.root !== 'string' ||
        !sameRoot(result.data.root, options.workspaceRoot)) throw new Error('任务工作区已变化，请重新打开成果后下载')
  }
  const original = destinationVersion(options.destination)
  const temporary = join(dirname(options.destination), `.aether-download-${randomUUID()}.tmp`)
  let bytes = 0
  const hash = createHash('sha256')
  try {
    await checkBinding()
    const query = new URLSearchParams({ sessionId: options.sessionId, path: options.path })
    const response = await fetch(`${options.baseUrl}/api/v1/workspace/file/download?${query}`, {
      headers: options.headers, redirect: 'error', signal
    })
    assertLive()
    if (!response.ok) { await response.body?.cancel(); throw new Error(`原文件下载失败（HTTP ${response.status}）`) }
    if (!response.body) throw new Error('引擎没有返回文件数据')
    const length = response.headers.get('content-length')
    const declared = length !== null && /^\d+$/.test(length) ? Number(length) : undefined
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared > MAX_DOWNLOAD_BYTES)) {
      await response.body.cancel()
      throw new Error('原文件超过 50 MiB，无法在此下载')
    }
    const body = response.body
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const reader = body.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          assertLive()
          bytes += chunk.value.byteLength
          if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('原文件超过 50 MiB，已停止下载')
          hash.update(chunk.value)
          yield chunk.value
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    await pipeline(Readable.from(chunks()), createWriteStream(temporary, { flags: 'wx' }), { signal })
    if (declared !== undefined && bytes !== declared) throw new Error('原文件传输不完整，未保存文件')
    await checkBinding()
    assertLive()
    if (destinationVersion(options.destination) !== original) throw new Error('另存位置的文件已变化，已保留现有文件')
    // No await between the final destination check and publication. A native
    // save dialog supplied this destination; renderers cannot choose it directly.
    if (original === 'missing') linkSync(temporary, options.destination)
    else renameSync(temporary, options.destination)
    return { bytes, sha256: `sha256:${hash.digest('hex')}` }
  } finally {
    if (!basename(temporary).startsWith('.aether-download-')) throw new Error('Invalid owned download path')
    rmSync(temporary, { force: true })
  }
}
