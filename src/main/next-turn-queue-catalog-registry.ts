import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { NextTurnQueueError } from '../shared/next-turn-queue'

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const plain = (path: string, directory: boolean): void => { const stat = lstatSync(path); if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new NextTurnQueueError('SCOPE', 'Native registry is not an ordinary owned path') }
function ordinaryAncestors(path: string): void {
  const absolute = resolve(path), root = parse(absolute).root
  let current = root
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment)
    if (existsSync(current)) plain(current, true)
  }
}
const writeExclusive = (path: string, bytes: string): void => { writeFileSync(path, bytes, { flag: 'wx' }); const handle = openSync(path, 'r+'); try { fsyncSync(handle) } finally { closeSync(handle) } }
interface Head { schemaVersion: 2; root: string; id: string; baseDigest: string; committedRevision: number; committedDigest: string; digest: string }
interface Record { schemaVersion: 2; rootId: string; revision: number; previousDigest: string; key: string; descriptorDigest: string; digest: string }

/** The external head anchors the acknowledged tail as well as the root. A
 * prepared exclusive slot is not an ACK and is never skipped or rolled back
 * automatically after interruption. */
export class QueueCatalogRegistry {
  readonly root: string
  private readonly anchor: string
  private readonly registry: string
  private readonly rootId: string
  private highestRevision = 0
  constructor(root: string, private readonly maximum: number) {
    this.root = resolve(root); this.anchor = this.root + '.anchor.json'; this.registry = join(this.root, '.catalog-registry')
    ordinaryAncestors(this.root)
    mkdirSync(dirname(this.root), { recursive: true })
    if (!existsSync(this.anchor)) {
      if (existsSync(this.root) && readdirSync(this.root).length) throw new NextTurnQueueError('CORRUPT', 'Unanchored native root is not activated automatically')
      mkdirSync(this.root, { recursive: true }); plain(this.root, true); mkdirSync(this.registry)
      const initial = { schemaVersion: 2 as const, root: this.root, id: randomUUID() }, baseDigest = sha(JSON.stringify(initial))
      const unsigned = { ...initial, baseDigest, committedRevision: 0, committedDigest: baseDigest }
      writeExclusive(this.anchor, JSON.stringify({ ...unsigned, digest: sha(JSON.stringify(unsigned)) }) + '\n')
    }
    const head = this.readHead(); this.rootId = head.id
    if (!existsSync(this.root) || !existsSync(this.registry)) throw new NextTurnQueueError('IO', 'Acknowledged native root or registry is missing')
    plain(this.root, true); plain(this.registry, true); this.records()
  }
  private readHead(): Head {
    plain(this.anchor, false)
    if (lstatSync(this.anchor).size > 4096) throw new NextTurnQueueError('CAPACITY', 'Native root anchor exceeds budget')
    let head: Head
    try { head = JSON.parse(readFileSync(this.anchor, 'utf8')) as Head } catch { throw new NextTurnQueueError('CORRUPT', 'Native root anchor is invalid') }
    const { digest, ...unsigned } = head
    if (head.schemaVersion !== 2 || head.root !== this.root || typeof head.id !== 'string' || !head.id || digest !== sha(JSON.stringify(unsigned))
      || head.baseDigest !== sha(JSON.stringify({ schemaVersion: 2, root: head.root, id: head.id }))
      || !Number.isSafeInteger(head.committedRevision) || head.committedRevision < this.highestRevision || head.committedRevision > this.maximum
      || !/^[a-f0-9]{64}$/.test(head.committedDigest) || this.rootId !== undefined && head.id !== this.rootId)
      throw new NextTurnQueueError('CORRUPT', 'Native root anchor changed or moved backwards')
    this.highestRevision = head.committedRevision
    return head
  }
  private records(): { head: Head; rows: Record[] } {
    const head = this.readHead(), files = readdirSync(this.registry).sort()
    if (files.length !== head.committedRevision) throw new NextTurnQueueError('IO', 'Native catalog tail differs from external durable head; retain interrupted registration evidence')
    let previous = head.baseDigest
    const keys = new Set<string>(), rows: Record[] = []
    for (let index = 0; index < files.length; index++) {
      const file = join(this.registry, files[index]); plain(file, false)
      if (files[index] !== String(index + 1).padStart(6, '0') + '.json' || lstatSync(file).size > 4096) throw new NextTurnQueueError('CORRUPT', 'Native registry slot has a gap or invalid size')
      let row: Record
      try { row = JSON.parse(readFileSync(file, 'utf8')) as Record } catch { throw new NextTurnQueueError('CORRUPT', 'Native registry slot is invalid') }
      const { digest, ...unsigned } = row
      if (row.schemaVersion !== 2 || row.rootId !== head.id || row.revision !== index + 1 || row.previousDigest !== previous || !/^[a-f0-9]{64}$/.test(row.key) || !/^[a-f0-9]{64}$/.test(row.descriptorDigest) || keys.has(row.key) || digest !== sha(JSON.stringify(unsigned))) throw new NextTurnQueueError('CORRUPT', 'Native registry chain or identity changed')
      previous = digest; keys.add(row.key); rows.push(row)
    }
    if (previous !== head.committedDigest) throw new NextTurnQueueError('CORRUPT', 'Native registry does not reach acknowledged external tail')
    return { head, rows }
  }
  register(key: string, descriptor: string): void {
    const { head, rows } = this.records()
    if (rows.some(row => row.key === key)) throw new NextTurnQueueError('CONFLICT', 'Native catalog was already registered; no empty reconstruction')
    if (rows.length >= this.maximum) throw new NextTurnQueueError('CAPACITY', 'Native catalog registry reached capacity')
    const unsigned = { schemaVersion: 2 as const, rootId: head.id, revision: rows.length + 1, previousDigest: head.committedDigest, key, descriptorDigest: sha(descriptor) }
    const record: Record = { ...unsigned, digest: sha(JSON.stringify(unsigned)) }
    try { writeExclusive(join(this.registry, String(record.revision).padStart(6, '0') + '.json'), JSON.stringify(record) + '\n') }
    catch { throw new NextTurnQueueError('CAS', 'Native catalog registration conflicted; reload original registry') }
    const current = this.readHead()
    if (current.digest !== head.digest) throw new NextTurnQueueError('CAS', 'Native external head advanced during registration; retain evidence')
    const { digest: _, ...previous } = current
    const nextUnsigned = { ...previous, committedRevision: record.revision, committedDigest: record.digest }
    const next: Head = { ...nextUnsigned, digest: sha(JSON.stringify(nextUnsigned)) }
    const temporary = this.anchor + '.prepared-' + randomUUID()
    // The slot is already exclusively claimed. A second writer sees either an
    // uncommitted tail (and stops) or this complete fresh head, never permission
    // to publish a lower revision. Both original and prepared evidence survive
    // a failed replacement; no delete-before-rename gap is introduced.
    writeExclusive(temporary, JSON.stringify(next) + '\n'); renameSync(temporary, this.anchor)
    const published = this.readHead()
    if (published.committedRevision < record.revision) throw new NextTurnQueueError('IO', 'Native durable head was not confirmed')
  }
  assertCatalogs(): string[] {
    const { rows } = this.records(), keys = rows.map(row => row.key), actual = readdirSync(this.root).filter(name => name !== '.catalog-registry').sort()
    if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw new NextTurnQueueError('IO', 'Registered native catalog is missing or has an unexpected replacement')
    for (const row of rows) {
      const directory = join(this.root, row.key), file = join(directory, 'identity.json'); plain(directory, true)
      if (!existsSync(file)) throw new NextTurnQueueError('IO', 'Acknowledged native catalog descriptor is missing')
      plain(file, false)
      if (lstatSync(file).size > 8192 || sha(readFileSync(file)) !== row.descriptorDigest) throw new NextTurnQueueError('CORRUPT', 'Registered native catalog descriptor changed')
    }
    return keys
  }
}
