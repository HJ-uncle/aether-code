/** Pure Node tests for the streaming engine .tgz extractor (no Electron window). */
import { test, expect } from '@playwright/test'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { extractTgz } from '../src/main/engine/tgz-extract'

const block = 512
const fixtures = resolve('.e2e-tmp/engine-tgz-extract')

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(block)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write(`00000000000${size.toString(8)}`.slice(-11) + '\0', 124, 12, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const value of header) checksum += value
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function tarEntry(name: string, data = Buffer.alloc(0), type = '0'): Buffer[] {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const padding = Buffer.alloc((block - (payload.length % block)) % block)
  return [tarHeader(name, payload.length, type), payload, padding]
}

function makeTar(parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.alloc(block * 2)])
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`
  let length = Buffer.byteLength(body) + 2
  while (Buffer.byteLength(body) + String(length).length + 1 !== length) {
    length = Buffer.byteLength(body) + String(length).length + 1
  }
  return Buffer.from(`${length} ${body}`)
}

async function cleanup(root: string): Promise<void> {
  if (!resolve(root).startsWith(fixtures + sep)) throw new Error('unsafe test cleanup path')
  await rm(root, { recursive: true, force: true })
}

async function writeGzip(root: string, name: string, tar: Buffer): Promise<string> {
  const archive = join(root, name)
  await writeFile(archive, gzipSync(tar))
  return archive
}

async function tempPair(): Promise<{ root: string; archiveRoot: string; output: string }> {
  await mkdir(fixtures, { recursive: true })
  const root = await mkdtemp(join(fixtures, 'run-'))
  const archiveRoot = join(root, 'archives')
  const output = join(root, 'out')
  await mkdir(archiveRoot)
  return { root, archiveRoot, output }
}

test.describe('engine tgz extractor', () => {
  test('streams regular files and supports GNU long names and pax paths', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      const long = `package/${'x'.repeat(120)}.json`
      const longMeta = tarEntry('././@LongLink', Buffer.from(`${long}\0`), 'L')
      const paxPath = `package/${'p'.repeat(120)}.txt`
      const pax = tarEntry('PaxHeaders.0/path', paxRecord('path', paxPath), 'x')
      const tar = makeTar([
        ...tarEntry('package/', Buffer.alloc(0), '5'),
        ...longMeta,
        ...tarEntry('placeholder', Buffer.from('long')),
        ...pax,
        ...tarEntry('placeholder', Buffer.from('pax'))
      ])
      const archive = await writeGzip(archiveRoot, 'valid.tgz', tar)
      const count = await extractTgz(archive, output)
      expect(count).toBe(2)
      expect(await readFile(join(output, long), 'utf8')).toBe('long')
      expect(await readFile(join(output, paxPath), 'utf8')).toBe('pax')
    } finally {
      await cleanup(root)
    }
  })

  test('rejects traversal, Windows ADS/device paths and links', async () => {
    for (const entry of [
      tarEntry('../escape.txt', Buffer.from('x')),
      tarEntry('/absolute.txt', Buffer.from('x')),
      tarEntry('C:/absolute.txt', Buffer.from('x')),
      tarEntry('package/../escape.txt', Buffer.from('x')),
      tarEntry('package\\escape.txt', Buffer.from('x')),
      tarEntry('package/config:secret', Buffer.from('x')),
      tarEntry('package/trailing.', Buffer.from('x')),
      tarEntry('package/trailing ', Buffer.from('x')),
      tarEntry('package/CON.txt', Buffer.from('x')),
      tarEntry('package/link', Buffer.from(''), '1'),
      tarEntry('package/link', Buffer.from(''), '2')
    ]) {
      const { root, archiveRoot, output } = await tempPair()
      try {
        const archive = await writeGzip(archiveRoot, 'bad.tgz', makeTar(entry))
        await expect(extractTgz(archive, output)).rejects.toThrow()
      } finally {
        await cleanup(root)
      }
    }
  })

  test('rejects checksum errors, truncation and resource limits', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      const tar = makeTar(tarEntry('package/a.txt', Buffer.from('hello')))
      const corrupt = Buffer.from(tar)
      corrupt[0] ^= 1
      const badChecksum = await writeGzip(archiveRoot, 'checksum.tgz', corrupt)
      await expect(extractTgz(badChecksum, output)).rejects.toThrow(/checksum/)
      const truncated = await writeGzip(
        archiveRoot,
        'truncated.tgz',
        tar.subarray(0, tar.length - block)
      )
      await expect(extractTgz(truncated, output)).rejects.toThrow(/truncated/)
      const limited = await writeGzip(archiveRoot, 'limited.tgz', tar)
      await expect(
        extractTgz(limited, join(output, 'limited'), { limits: { maxFileBytes: 2 } })
      ).rejects.toThrow(/limit/)
      await expect(stat(join(output, 'limited/package/a.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await cleanup(root)
    }
  })

  test('rejects invalid gzip trailers and missing source files', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      const compressed = gzipSync(makeTar(tarEntry('package/a.txt', Buffer.from('hello'))))
      const corrupt = Buffer.from(compressed)
      corrupt[corrupt.length - 8] ^= 1
      await writeFile(join(archiveRoot, 'crc.tgz'), corrupt)
      await expect(extractTgz(join(archiveRoot, 'crc.tgz'), output)).rejects.toThrow(/check/)
      await writeFile(join(archiveRoot, 'short.tgz'), compressed.subarray(0, compressed.length - 4))
      await expect(
        extractTgz(join(archiveRoot, 'short.tgz'), join(output, 'short'))
      ).rejects.toThrow()
      await expect(extractTgz(join(archiveRoot, 'missing.tgz'), output)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await cleanup(root)
    }
  })

  test('rejects malformed pax, sparse metadata, pax traversal and dangling names', async () => {
    const cases = [
      makeTar([
        ...tarEntry('meta', Buffer.from('24 path=package/a.txt\n'), 'x'),
        ...tarEntry('a', Buffer.from('x'))
      ]),
      makeTar([
        ...tarEntry('meta', paxRecord('GNU.sparse.size', '10'), 'x'),
        ...tarEntry('a', Buffer.from('x'))
      ]),
      makeTar([
        ...tarEntry('meta', paxRecord('path', '../escape.txt'), 'x'),
        ...tarEntry('a', Buffer.from('x'))
      ]),
      makeTar(tarEntry('././@LongLink', Buffer.from('package/dangling\0'), 'L')),
      makeTar([
        ...tarEntry('meta', paxRecord('size', '2oops'), 'x'),
        ...tarEntry('a', Buffer.from('x'))
      ])
    ]
    const { root, archiveRoot, output } = await tempPair()
    try {
      for (let i = 0; i < cases.length; i++) {
        const archive = await writeGzip(archiveRoot, `${i}.tgz`, cases[i])
        await expect(extractTgz(archive, join(output, String(i)))).rejects.toThrow()
      }
    } finally {
      await cleanup(root)
    }
  })

  test('supports ustar prefix, multi-record pax byte lengths and pax size overrides', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      const prefixHeader = tarHeader('part.txt', 4)
      prefixHeader.write('package/nested', 345, 155, 'utf8')
      prefixHeader.fill(0x20, 148, 156)
      prefixHeader.write(
        `${prefixHeader
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, '0')}\0 `,
        148,
        8
      )
      const metadata = Buffer.concat([
        paxRecord('mtime', '12.34'),
        paxRecord('path', 'package/中文路径.txt'),
        paxRecord('size', '5')
      ])
      const archive = await writeGzip(
        archiveRoot,
        'pax.tgz',
        makeTar([
          prefixHeader,
          Buffer.from('test'),
          Buffer.alloc(508),
          ...tarEntry('meta', metadata, 'x'),
          tarHeader('wrong-name', 0),
          Buffer.from('hello'),
          Buffer.alloc(507)
        ])
      )
      expect(await extractTgz(archive, output)).toBe(2)
      expect(await readFile(join(output, 'package/nested/part.txt'), 'utf8')).toBe('test')
      expect(await readFile(join(output, 'package/中文路径.txt'), 'utf8')).toBe('hello')
    } finally {
      await cleanup(root)
    }
  })

  test('enforces entry and expanded-byte limits before writing excess files', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      const archive = await writeGzip(
        archiveRoot,
        'limits.tgz',
        makeTar([
          ...tarEntry('package/a', Buffer.from('a')),
          ...tarEntry('package/b', Buffer.from('b'))
        ])
      )
      await expect(extractTgz(archive, output, { limits: { maxEntries: 1 } })).rejects.toThrow(
        /entries/
      )
      expect(await readFile(join(output, 'package/a'), 'utf8')).toBe('a')
      await expect(stat(join(output, 'package/b'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        extractTgz(archive, join(output, 'limited'), { limits: { maxExpandedBytes: 512 } })
      ).rejects.toThrow(/limit/)
      await expect(stat(join(output, 'limited/package/a'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await cleanup(root)
    }
  })

  test('streams many chunks accurately and reports completed file progress', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      const data = randomBytes(4 * 1024 * 1024 + 37)
      const archive = await writeGzip(
        archiveRoot,
        'large.tgz',
        makeTar(tarEntry('package/large.bin', data))
      )
      const progress: { files: number; bytes: number }[] = []
      expect(
        await extractTgz(archive, output, { onProgress: (value) => progress.push(value) })
      ).toBe(1)
      const actual = await readFile(join(output, 'package/large.bin'))
      expect(createHash('sha256').update(actual).digest('hex')).toBe(
        createHash('sha256').update(data).digest('hex')
      )
      expect(progress).toEqual([{ files: 1, bytes: data.length }])
    } finally {
      await cleanup(root)
    }
  })

  test('refuses preexisting directory links and duplicate files', async () => {
    const { root, archiveRoot, output } = await tempPair()
    try {
      await mkdir(output)
      await mkdir(join(root, 'outside'))
      await symlink(join(root, 'outside'), join(output, 'package'), 'junction')
      const archive = await writeGzip(
        archiveRoot,
        'link.tgz',
        makeTar(tarEntry('package/a', Buffer.from('bad')))
      )
      await expect(extractTgz(archive, output)).rejects.toThrow(/symbolic link/)
      await expect(stat(join(root, 'outside/a'))).rejects.toMatchObject({ code: 'ENOENT' })
      const duplicate = await writeGzip(
        archiveRoot,
        'duplicate.tgz',
        makeTar([
          ...tarEntry('package/a', Buffer.from('first')),
          ...tarEntry('package/a', Buffer.from('last'))
        ])
      )
      await expect(extractTgz(duplicate, join(root, 'duplicates'))).rejects.toMatchObject({
        code: 'EEXIST'
      })
      expect(await readFile(join(root, 'duplicates/package/a'), 'utf8')).toBe('first')
    } finally {
      await cleanup(root)
    }
  })

  test('extracts the selected real engine archive', async () => {
    test.skip(
      !process.env.AETHER_TEST_ENGINE_TGZ,
      'Only run when a local engine archive is selected explicitly'
    )
    const { root, output } = await tempPair()
    try {
      const count = await extractTgz(process.env.AETHER_TEST_ENGINE_TGZ!, output)
      expect(count).toBeGreaterThan(100)
      const pkg = JSON.parse(await readFile(join(output, 'package/package.json'), 'utf8')) as {
        version: string
      }
      expect(pkg.version).toBe('2.0.0')
      expect((await stat(join(output, 'package/dist/main.js'))).size).toBeGreaterThan(100)
    } finally {
      await cleanup(root)
    }
  })
})
