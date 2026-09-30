/**
 * Small, dependency-free tar.gz reader used for importing an engine bundle.
 * The archive is consumed and written incrementally so a 160 MB/720 MB bundle
 * does not become one giant in-memory Buffer.
 */
import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const BLOCK_SIZE = 512
const CHECKSUM_OFFSET = 148
const CHECKSUM_SIZE = 8
const NAME_OFFSET = 0
const NAME_SIZE = 100
const SIZE_OFFSET = 124
const SIZE_SIZE = 12
const TYPEFLAG_OFFSET = 156
const LINKNAME_OFFSET = 157
const LINKNAME_SIZE = 100
const PREFIX_OFFSET = 345
const PREFIX_SIZE = 155

const DEFAULT_LIMITS: Required<ExtractLimits> = {
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxEntries: 100_000,
  maxPaxBytes: 8 * 1024 * 1024
}

export interface ExtractProgress {
  files: number
  bytes: number
}
export interface ExtractLimits {
  maxExpandedBytes?: number
  maxFileBytes?: number
  maxEntries?: number
  maxPaxBytes?: number
}
export interface ExtractOptions {
  /** 解压进度回调；每个普通文件写完后调用一次。 */
  onProgress?: (progress: ExtractProgress) => void
  limits?: ExtractLimits
}

function field(buf: Buffer, offset: number, size: number): string {
  const end = Math.min(buf.length, offset + size)
  let stop = offset
  while (stop < end && buf[stop] !== 0) stop++
  return buf.toString('utf8', offset, stop)
}

/** Tar numbers are normally octal, but GNU tar may use base-256 numbers. */
function numberField(buf: Buffer, offset: number, size: number): number {
  if (offset + size > buf.length) throw new Error('invalid tar numeric field')
  const first = buf[offset]
  if ((first & 0x80) !== 0) {
    let value = BigInt(first & 0x7f)
    for (let i = offset + 1; i < offset + size; i++) value = (value << 8n) | BigInt(buf[i])
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('tar number is too large')
    return Number(value)
  }
  const raw = field(buf, offset, size).trim()
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar octal number: ${raw}`)
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value)) throw new Error('tar number is too large')
  return value
}

function allZero(buf: Buffer): boolean {
  for (const value of buf) if (value !== 0) return false
  return true
}

function verifyChecksum(header: Buffer): void {
  const actual = numberField(header, CHECKSUM_OFFSET, CHECKSUM_SIZE)
  let expected = 0
  for (let i = 0; i < header.length; i++)
    expected += i >= CHECKSUM_OFFSET && i < CHECKSUM_OFFSET + CHECKSUM_SIZE ? 0x20 : header[i]
  if (actual !== expected) throw new Error('invalid tar header checksum')
}

/** An async byte queue. It copies only requested bytes, never the whole archive. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>
  private readonly chunks: Buffer[] = []
  private headOffset = 0
  private buffered = 0
  private ended = false
  private received = 0
  constructor(
    stream: AsyncIterable<Buffer>,
    private readonly maxBytes: number
  ) {
    this.iterator = stream[Symbol.asyncIterator]()
  }
  private async fill(minimum: number): Promise<void> {
    while (this.buffered < minimum && !this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
        break
      }
      if (next.value.length !== 0) {
        this.received += next.value.length
        if (this.received > this.maxBytes)
          throw new Error('tar archive exceeds extraction size limit')
        this.chunks.push(next.value)
        this.buffered += next.value.length
      }
    }
  }
  async readExactly(length: number): Promise<Buffer | null> {
    if (length === 0) return Buffer.alloc(0)
    await this.fill(length)
    if (this.buffered < length) return null
    const result = Buffer.allocUnsafe(length)
    let copied = 0
    while (copied < length) {
      const chunk = this.chunks[0]
      const available = chunk.length - this.headOffset
      const take = Math.min(available, length - copied)
      chunk.copy(result, copied, this.headOffset, this.headOffset + take)
      copied += take
      this.headOffset += take
      this.buffered -= take
      if (this.headOffset === chunk.length) {
        this.chunks.shift()
        this.headOffset = 0
      }
    }
    return result
  }
  async discard(length: number): Promise<void> {
    while (length > 0) {
      const chunk = await this.readExactly(Math.min(length, 64 * 1024))
      if (!chunk) throw new Error('truncated tar entry')
      length -= chunk.length
    }
  }
  async finish(): Promise<void> {
    // Consume gzip through EOF: stopping at the tar end marker would miss a
    // damaged gzip trailer and leave the source file open on Windows.
    while (true) {
      await this.fill(1)
      if (this.buffered === 0) return
      const chunk = await this.readExactly(Math.min(this.buffered, 64 * 1024))
      if (!chunk || !allZero(chunk)) throw new Error('unexpected data after tar end marker')
    }
  }
}

function parsePax(data: Buffer): Map<string, string> {
  const result = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space <= offset) throw new Error('invalid pax record length')
    const rawLength = data.toString('ascii', offset, space)
    if (!/^[1-9][0-9]*$/.test(rawLength)) throw new Error('invalid pax record length')
    const length = Number(rawLength)
    if (
      !Number.isSafeInteger(length) ||
      length < space - offset + 4 ||
      offset + length > data.length ||
      data[offset + length - 1] !== 0x0a
    )
      throw new Error('invalid pax record length')
    const body = data.toString('utf8', space + 1, offset + length - 1)
    const equals = body.indexOf('=')
    if (equals <= 0 || body.includes('\0')) throw new Error('invalid pax record')
    const key = body.slice(0, equals)
    if (
      key.startsWith('GNU.sparse') ||
      key === 'SCHILY.realsize' ||
      (key === 'SCHILY.filetype' && body.slice(equals + 1) === 'sparse')
    )
      throw new Error('sparse tar entries are not allowed')
    if (key === 'linkpath') throw new Error('tar links and special files are not allowed')
    result.set(key, body.slice(equals + 1))
    offset += length
  }
  return result
}

function validateEntryName(name: string, directory: boolean): string {
  const normalized = name.replace(/\/+$/, '')
  if (
    !normalized ||
    (!directory && normalized !== name) ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  )
    throw new Error(`unsafe tar entry path: ${name}`)
  for (const part of normalized.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part)
    )
      throw new Error(`unsafe tar entry path: ${name}`)
    const device = part.split('.')[0].trimEnd().toUpperCase()
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(device))
      throw new Error(`unsafe Windows device path: ${name}`)
  }
  return normalized
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
  const relative = directory.slice(root.length).replace(/^[/\\]+/, '')
  let current = root
  for (const part of relative ? relative.split(sep) : []) {
    current = resolve(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`tar path traverses a symbolic link: ${part}`)
      if (!stat.isDirectory()) throw new Error(`tar path is not a directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

async function writeEntry(path: string, reader: ByteReader, size: number): Promise<void> {
  // Exclusive creation refuses duplicate archive paths and existing hard links.
  const handle = await open(path, 'wx')
  try {
    let remaining = size
    while (remaining > 0) {
      const chunk = await reader.readExactly(Math.min(remaining, 64 * 1024))
      if (!chunk) throw new Error('truncated tar entry')
      remaining -= chunk.length
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
        if (!bytesWritten) throw new Error('could not write extracted tar entry')
        offset += bytesWritten
      }
    }
  } finally {
    await handle.close()
  }
}

/** Extract a .tgz archive into targetDir, with path and resource-limit checks. */
export async function extractTgz(
  tgzPath: string,
  targetDir: string,
  options: ExtractOptions = {}
): Promise<number> {
  const root = resolve(targetDir)
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 0))
    throw new Error('invalid tar extraction limits')
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink())
    throw new Error('tar target directory is a symbolic link')
  const gunzip = createGunzip()
  const source = createReadStream(tgzPath)
  source.on('error', (error) => gunzip.destroy(error))
  source.pipe(gunzip)
  const reader = new ByteReader(gunzip as AsyncIterable<Buffer>, limits.maxExpandedBytes)
  let files = 0
  let entries = 0
  let expanded = 0
  let longName: string | null = null
  let pax = new Map<string, string>()
  const globalPax = new Map<string, string>()
  try {
    while (true) {
      const header = await reader.readExactly(BLOCK_SIZE)
      if (!header) throw new Error('truncated tar header')
      if (allZero(header)) {
        const end = await reader.readExactly(BLOCK_SIZE)
        if (!end || !allZero(end)) throw new Error('truncated tar end marker')
        if (longName !== null || pax.size !== 0) throw new Error('orphaned tar metadata')
        await reader.finish()
        break
      }
      verifyChecksum(header)
      const headerSize = numberField(header, SIZE_OFFSET, SIZE_SIZE)
      const type = header.toString('ascii', TYPEFLAG_OFFSET, TYPEFLAG_OFFSET + 1) || '\0'
      const dataSize = headerSize + ((BLOCK_SIZE - (headerSize % BLOCK_SIZE)) % BLOCK_SIZE)
      if (dataSize < headerSize) throw new Error('invalid tar entry size')
      entries++
      if (entries > limits.maxEntries) throw new Error('tar archive has too many entries')
      if (type === 'L') {
        if (headerSize > limits.maxPaxBytes) throw new Error('tar long name is too large')
        const data = await reader.readExactly(headerSize)
        if (!data) throw new Error('truncated GNU long name')
        await reader.discard(dataSize - headerSize)
        longName = data.toString('utf8').replace(/\0+$/, '')
        continue
      }
      if (type === 'x' || type === 'g') {
        if (headerSize > limits.maxPaxBytes) throw new Error('pax header is too large')
        const data = await reader.readExactly(headerSize)
        if (!data) throw new Error('truncated pax header')
        await reader.discard(dataSize - headerSize)
        const parsed = parsePax(data)
        if (type === 'g') for (const [key, value] of parsed) globalPax.set(key, value)
        else for (const [key, value] of parsed) pax.set(key, value)
        continue
      }
      if ('123467'.includes(type)) {
        throw new Error(
          `tar links and special files are not allowed: ${field(header, LINKNAME_OFFSET, LINKNAME_SIZE)}`
        )
      }
      if (type !== '\0' && type !== '0' && type !== '5') {
        throw new Error(`unsupported tar entry type: ${type}`)
      }
      const rawName = field(header, NAME_OFFSET, NAME_SIZE)
      const prefix = field(header, PREFIX_OFFSET, PREFIX_SIZE)
      const inherited = new Map([...globalPax, ...pax])
      const rawEntryName =
        inherited.get('path') ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
      const name = validateEntryName(rawEntryName, type === '5')
      const paxSize = inherited.get('size')
      if (paxSize !== undefined && !/^[0-9]+$/.test(paxSize))
        throw new Error('invalid pax entry size')
      const size = paxSize !== undefined ? Number(paxSize) : headerSize
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid pax entry size')
      if (size > limits.maxFileBytes || expanded + size > limits.maxExpandedBytes)
        throw new Error('tar archive exceeds extraction size limit')
      const entryDataSize = size + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE)
      const target = resolve(root, name)
      if (target !== root && !target.startsWith(root + sep))
        throw new Error(`tar entry escapes target directory: ${name}`)
      if (type === '5') {
        if (size !== 0) throw new Error('directory tar entry has data')
        await reader.discard(entryDataSize)
        await ensureDirectory(root, target)
      } else {
        await ensureDirectory(root, dirname(target))
        const existing = await lstat(target).catch(() => undefined)
        if (existing?.isSymbolicLink() || existing?.isDirectory())
          throw new Error(`tar target is not a regular file: ${name}`)
        await writeEntry(target, reader, size)
        await reader.discard(entryDataSize - size)
        files++
        expanded += size
        options.onProgress?.({ files, bytes: expanded })
      }
      longName = null
      pax = new Map()
    }
  } catch (error) {
    source.destroy()
    gunzip.destroy()
    throw error
  }
  return files
}
