import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { BrowserLocalFileContent, BrowserLocalFileInfo } from '../../shared/browser'
import { hasBinaryFileSignature, hasOfficeFileSignature } from '../../shared/file-signature'

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const SAMPLE_BYTES = 8192
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
  '.avif', '.heic', '.heif', '.apng', '.svg', '.svgz'
])
const OFFICE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm',
  '.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.xltm',
  '.ppt', '.pptx', '.pptm', '.pot', '.potx', '.potm', '.pps', '.ppsx', '.ppsm',
  '.odt', '.ods', '.odp'
])
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function assertRegularFile(stat: BigIntStats): void {
  if (!stat.isFile()) throw new Error('只能预览普通文件，不能预览文件夹或设备')
  if (stat.size > BigInt(MAX_FILE_BYTES)) throw new Error('本地文件预览上限为 32 MiB')
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertUnchangedPath(path: string, expected: BigIntStats): Promise<void> {
  if (await realpath(path) !== path) throw new Error('文件路径已变化，请重新选择文件')
  const current = await lstat(path, { bigint: true })
  if (!current.isFile() || !sameFile(current, expected)) {
    throw new Error('文件已被替换，请重新选择文件')
  }
}

async function withLocalFile<T>(
  path: string,
  read: (handle: FileHandle, stat: BigIntStats) => Promise<T>
): Promise<T> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('本地文件路径无效')
  }
  // The caller grants exactly this canonical file, never a directory or a later symlink target.
  if (await realpath(path) !== path) throw new Error('文件路径已变化，请重新选择文件')
  const before = await lstat(path, { bigint: true })
  assertRegularFile(before)
  // O_NONBLOCK prevents a replacement FIFO from hanging open; O_NOFOLLOW is unavailable on Windows.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(path, flags)
  try {
    const initial = await handle.stat({ bigint: true })
    assertRegularFile(initial)
    if (!sameFile(initial, before)) throw new Error('文件已被替换，请重新选择文件')
    await assertUnchangedPath(path, initial)
    const result = await read(handle, initial)
    const after = await handle.stat({ bigint: true })
    assertRegularFile(after)
    if (after.size !== initial.size || after.mtimeNs !== initial.mtimeNs || after.ctimeNs !== initial.ctimeNs) {
      throw new Error('文件在读取过程中发生变化，请重试')
    }
    await assertUnchangedPath(path, after)
    return result
  } finally {
    await handle.close()
  }
}

async function readPrefix(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

function bomEncoding(sample: Uint8Array): string | undefined {
  if (sample[0] === 0xff && sample[1] === 0xfe) return 'utf-16le'
  if (sample[0] === 0xfe && sample[1] === 0xff) return 'utf-16be'
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return 'utf-8'
  return undefined
}

function fileKind(path: string, sample: Buffer): BrowserLocalFileInfo['kind'] {
  const extension = extname(path).toLowerCase()
  if (extension === '.html' || extension === '.htm') return 'html'
  // SVG must use the image preview rather than an executable document surface.
  if (IMAGE_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension) || hasOfficeFileSignature(sample, path)
    || sample.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)) return 'binary'
  // UTF-16 text naturally contains NUL bytes; its BOM must win over the generic binary heuristic.
  if (bomEncoding(sample)) return 'text'
  return hasBinaryFileSignature(sample) ? 'binary' : 'text'
}

function decodeText(bytes: Buffer, truncated: boolean): { text: string; encoding: string } {
  const explicit = bomEncoding(bytes)
  const decode = (encoding: string): string =>
    new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated })
  if (explicit) return { text: decode(explicit), encoding: explicit }
  try {
    return { text: decode('utf-8'), encoding: 'utf-8' }
  } catch {
    // Legacy Chinese documents commonly omit a BOM. A fatal decoder avoids silently replacing their bytes.
    return { text: decode('gb18030'), encoding: 'gb18030' }
  }
}

export async function inspectLocalFile(path: string): Promise<BrowserLocalFileInfo> {
  return withLocalFile(path, async (handle, stat) => {
    const size = Number(stat.size)
    const length = Math.min(size, SAMPLE_BYTES)
    const sample = await readPrefix(handle, length)
    if (sample.length !== length) throw new Error('文件在读取过程中发生变化，请重试')
    return { path, name: basename(path), kind: fileKind(path, sample), size }
  })
}

export async function readLocalFileContent(info: BrowserLocalFileInfo): Promise<BrowserLocalFileContent> {
  return withLocalFile(info.path, async (handle, stat) => {
    const size = Number(stat.size)
    const sampleLength = Math.min(size, SAMPLE_BYTES)
    const sample = await readPrefix(handle, sampleLength)
    if (sample.length !== sampleLength) throw new Error('文件在读取过程中发生变化，请重试')
    // Reclassify from the handle: a saved preview descriptor is not authority for newly changed bytes.
    const binary = fileKind(info.path, sample) === 'binary'
    const truncated = !binary && size > MAX_TEXT_BYTES
    const length = truncated ? MAX_TEXT_BYTES : size
    // One sentinel byte detects growth without allowing readFile() to allocate an unbounded buffer.
    const bytes = await readPrefix(handle, length + (truncated ? 0 : 1))
    if (bytes.length !== length) throw new Error('文件在读取过程中发生变化，请重试')
    if (binary) return { kind: 'binary', base64: bytes.toString('base64'), size }
    // Streaming decode drops an incomplete final code point when the byte budget cuts through it.
    return { kind: 'text', ...decodeText(bytes, truncated), size, truncated }
  })
}
