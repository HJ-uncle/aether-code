import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { EngineWorkspaceAttachmentInput } from '../../shared/ipc'
import { hasEncodedPathTraversal } from '../../shared/path-safety'
import { assertAllowed } from '../fs/file-service'
import { engineHost } from './host'
import { engineIdentityOf, engineTargetError } from './protocol'
import { validateRemoteWorkspaceRoot } from './remote-workspace'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_BINDING_BYTES = 4 * 1024 * 1024

function relativeAttachmentPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 ||
      /[\u0000-\u001f\u007f:]/.test(value) || /^(?:\/|\\)/.test(value) || hasEncodedPathTraversal(value))
    throw new Error('资料路径无效')
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('资料路径必须属于原工作区')
  return normalized
}

function sameRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = normalize(left), b = normalize(right)
  return /^(?:[a-z]:\/|\/\/)/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason); else resolve(value)
    }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}

async function responseBytes(response: Response, maximum: number, assertLive: () => void): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`无法读取原始资料（HTTP ${response.status}）`)
  }
  const length = response.headers.get('content-length')
  const declared = length !== null && /^\d+$/.test(length) ? Number(length) : undefined
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared > maximum)) {
    await response.body.cancel()
    throw new Error('资料超过读取容量限制')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      assertLive()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maximum) throw new Error('资料超过读取容量限制')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (declared !== undefined && declared !== bytes) throw new Error('资料传输不完整，原草稿保持不变')
  return Uint8Array.from(Buffer.concat(chunks, bytes))
}

/** Preserve raw bytes for draft migration; preview reads decode/truncate text.
 * Never grant paths or rebind a session as a side effect of this read. */
export async function readWorkspaceAttachment(input: EngineWorkspaceAttachmentInput, callerSignal?: AbortSignal): Promise<Uint8Array> {
  if (!input || typeof input !== 'object' || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.sessionId))
    throw new Error('资料所属会话无效')
  const path = relativeAttachmentPath(input.path)
  if (input.workspaceRoot !== undefined && (typeof input.workspaceRoot !== 'string' || !input.workspaceRoot.trim())) throw new Error('资料工作区无效')
  if (input.bindingEpoch !== undefined && (typeof input.bindingEpoch !== 'string' || !input.bindingEpoch.trim() || input.bindingEpoch.length > 512))
    throw new Error('资料工作区版本无效')
  const snapshot = engineHost.getSnapshot(), expected = input.expectedEngine ?? engineIdentityOf(snapshot)
  const transportSignal = engineHost.requestSignal
  const signal = AbortSignal.any([transportSignal, AbortSignal.timeout(30_000), ...(callerSignal ? [callerSignal] : [])])
  const assertLive = (): void => {
    signal.throwIfAborted()
    const current = engineHost.getSnapshot()
    const changed = engineTargetError(current, expected)
    if (changed || current.phase !== 'ready') throw new Error(changed || '引擎尚未就绪，未读取资料')
  }
  assertLive()
  if (snapshot.mode === 'embedded' && input.workspaceRoot !== undefined) {
    if (!isAbsolute(input.workspaceRoot)) throw new Error('本地工作区必须是绝对目录')
    const root = await fs.realpath(assertAllowed(input.workspaceRoot))
    const candidate = join(root, path), safe = await fs.realpath(assertAllowed(candidate))
    const contained = relative(root, safe)
    if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw new Error('资料不属于原工作区')
    assertLive()
    const handle = await fs.open(safe, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > MAX_ATTACHMENT_BYTES) throw new Error('资料必须是至多 20 MB 的普通文件')
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        assertLive()
        const read = await untilAborted(handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset), signal)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await handle.stat(), current = await fs.stat(safe)
      const real = await fs.realpath(assertAllowed(candidate))
      assertLive()
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          current.dev !== before.dev || current.ino !== before.ino || !sameRoot(real, safe)) throw new Error('资料在读取时已变化，请重试')
      return Uint8Array.from(bytes.subarray(0, offset))
    } finally { await handle.close() }
  }
  const requiredRoot = input.workspaceRoot === undefined ? undefined : validateRemoteWorkspaceRoot(input.workspaceRoot)
  const headers = await untilAborted(engineHost.prepareRequestHeaders(snapshot.baseUrl, 'general'), signal)
  assertLive()
  const binding = async (): Promise<{ root: string; epoch: string }> => {
    const query = new URLSearchParams({ sessionId: input.sessionId, path: '.' })
    const response = await fetch(`${snapshot.baseUrl}/api/v1/workspace/directory?${query}`, { headers, signal, redirect: 'error' })
    const result = JSON.parse(new TextDecoder().decode(await responseBytes(response, MAX_BINDING_BYTES, assertLive))) as {
      code?: number; data?: { root?: unknown; bindingEpoch?: unknown }
    }
    assertLive()
    if ((result.code !== 0 && result.code !== 200) || typeof result.data?.root !== 'string' ||
        typeof result.data.bindingEpoch !== 'string' || !result.data.bindingEpoch.trim()) throw new Error('引擎未返回有效的资料工作区版本')
    const root = validateRemoteWorkspaceRoot(result.data.root)
    if (!root || requiredRoot && !sameRoot(root, requiredRoot) || input.bindingEpoch && input.bindingEpoch !== result.data.bindingEpoch)
      throw new Error('资料工作区已变化，请重新选择目录')
    return { root, epoch: result.data.bindingEpoch }
  }
  const before = await binding()
  const query = new URLSearchParams({ sessionId: input.sessionId, path, expectedRoot: before.root, bindingEpoch: before.epoch })
  const response = await fetch(`${snapshot.baseUrl}/api/v1/workspace/file/download?${query}`, { headers, signal, redirect: 'error' })
  const bytes = await responseBytes(response, MAX_ATTACHMENT_BYTES, assertLive)
  const after = await binding()
  assertLive()
  if (!sameRoot(before.root, after.root) || before.epoch !== after.epoch) throw new Error('资料工作区在读取时已变化，原草稿保持不变')
  return bytes
}
