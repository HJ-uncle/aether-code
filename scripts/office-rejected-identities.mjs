/** Read-only, bounded provenance for identities retired with the rejected v003.
 * This proves coverage of the selected frozen evidence and visible publications,
 * never that every intermediate historical body was captured.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const categories = ['messageIds', 'messageNonces', 'decisionIds', 'decisionNonces']
const fields = { messageId: 'messageIds', nonce: 'messageNonces', decisionId: 'decisionIds', decisionNonce: 'decisionNonces' }
const roles = ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance']
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const within = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') }
const digest = value => typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value) ? value.replace(/^sha256:/i, '').toLowerCase() : null
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value)
class LedgerFault extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code } }
const fail = (code, message) => { throw new LedgerFault('failed', code, message) }
const requireThat = (ok, code, message) => { if (!ok) fail(code, message) }
const exactKeys = (value, keys, label) => requireThat(object(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'rejected-identities.schema', 'Unexpected or missing fields in ' + label)
const emptySets = () => Object.fromEntries(categories.map(key => [key, new Set()]))

function extract(value, kind) {
  requireThat(object(value) && (value.revision === 'v003' || value.observedRevision === 'v003'), 'rejected-identities.source-revision', 'Identity source must explicitly belong to rejected v003')
  if (kind === 'message') requireThat(identifier(value.messageId), 'rejected-identities.source-message', 'A message source must contain its original messageId')
  if (kind === 'decision') requireThat(!Object.hasOwn(value, 'messageId') && identifier(value.decisionId) && nonce(value.decisionNonce), 'rejected-identities.source-decision', 'A decision source must contain the original decision document, not a message envelope')
  if (kind === 'supporting') requireThat(!Object.hasOwn(value, 'messageId'), 'rejected-identities.source-kind', 'Original messages must be declared as message sources')
  // Supporting index/retirement markers are byte evidence; the explicit known
  // identity fields in their index rows must still be included, not hidden by kind.
  const rows = [value]
  if (kind === 'supporting') for (const key of ['messages', 'supersededMessages']) {
    if (Array.isArray(value[key])) rows.push(...value[key].filter(object))
  }
  const identities = emptySets()
  for (const row of rows) for (const [field, category] of Object.entries(fields)) if (Object.hasOwn(row, field)) {
    requireThat(category.endsWith('Nonces') ? nonce(row[field]) : identifier(row[field]), 'rejected-identities.source-value', 'Malformed known identity field: ' + field)
    identities[category].add(row[field])
  }
  return identities
}

export async function loadRejectedIdentityLedger({ ledgerPath, companyRoot }) {
  if (!ledgerPath) throw new LedgerFault('incomplete', 'rejected-identities.required', 'v004 requires an explicit rejected identity ledger file')
  requireThat(typeof ledgerPath === 'string', 'rejected-identities.path', 'Ledger must be a file path, not an in-memory replacement')
  const company = await realpath(resolve(companyRoot)), published = resolve(company, 'published'), publishedCanonical = await realpath(published)
  requireThat(within(company, publishedCanonical), 'rejected-identities.link-escape', 'Publications directory escapes the company workspace')
  const absoluteLedger = resolve(ledgerPath), ledgerDirectory = await realpath(dirname(absoluteLedger))
  let actualLedger
  try { actualLedger = await realpath(absoluteLedger) }
  catch (error) { if (error.code === 'ENOENT') throw new LedgerFault('incomplete', 'rejected-identities.source-missing', 'The explicit frozen ledger file is missing'); throw error }
  requireThat(!within(company, absoluteLedger) && !within(company, ledgerDirectory) && !within(ledgerDirectory, company)
    && !within(company, actualLedger), 'rejected-identities.location', 'The frozen ledger and its independent directory must stay outside the business workspace, not above it')
  const proofs = new Map(), caps = { files: 1024, bytesPerFile: 4 * 1024 * 1024, directoryEntries: 512, sources: 512, identities: 4096 }

  function at(name, scope) {
    requireThat(typeof name === 'string' && name.length > 0 && name.length <= 4096 && !isAbsolute(name), 'rejected-identities.path', 'Source path must be relative to its declared scope')
    const path = resolve(scope, name)
    requireThat(within(scope, path), 'rejected-identities.path-escape', 'Identity evidence escapes its declared directory')
    return path
  }
  async function bytes(path, scope, refresh = false) {
    let actual, before
    try { actual = await realpath(path); before = await stat(actual) }
    catch (error) { if (error.code === 'ENOENT') throw new LedgerFault('incomplete', 'rejected-identities.source-missing', 'Missing exact identity evidence: ' + path); throw error }
    const actualScope = await realpath(scope), fixedScope = scope === published ? publishedCanonical : ledgerDirectory
    requireThat(relative(fixedScope, actualScope) === '' && within(fixedScope, actual), 'rejected-identities.link-escape', 'Identity evidence symlink or owner directory escapes its frozen boundary')
    requireThat(before.isFile() && before.size <= caps.bytesPerFile, 'rejected-identities.file-limit', 'Identity evidence must be a bounded regular JSON file')
    requireThat(proofs.has(path) || proofs.size < caps.files, 'rejected-identities.file-limit', 'Too many identity evidence files')
    const hash = createHash('sha256'), chunks = []; let size = 0
    for await (const chunk of createReadStream(actual)) {
      size += chunk.length
      requireThat(size <= caps.bytesPerFile, 'rejected-identities.file-limit', 'Identity source grew beyond the byte limit')
      hash.update(chunk); if (!refresh) chunks.push(chunk)
    }
    const after = await stat(actual)
    requireThat(before.size === size && after.size === size && before.mtimeMs === after.mtimeMs, 'rejected-identities.changed-during-read', 'Identity source changed during reading')
    const proof = { path, actualPath: actual, scope, sha256: hash.digest('hex'), bytes: size }
    if (!refresh) {
      const prior = proofs.get(path)
      requireThat(!prior || prior.sha256 === proof.sha256, 'rejected-identities.changed-during-read', 'An identity source changed between reads')
      proofs.set(path, proof)
    }
    return { proof, content: refresh ? null : Buffer.concat(chunks) }
  }
  async function json(path, scope, expectedHash) {
    if (expectedHash !== undefined) requireThat(Boolean(digest(expectedHash)), 'rejected-identities.sha-invalid', 'Source reference lacks a valid SHA-256')
    const result = await bytes(path, scope)
    if (expectedHash !== undefined) requireThat(result.proof.sha256 === digest(expectedHash), 'rejected-identities.sha-mismatch', 'Identity source differs from its frozen SHA: ' + path)
    let value
    try { value = JSON.parse(result.content.toString('utf8').replace(/^\uFEFF/, '')) }
    catch { fail('rejected-identities.json-invalid', 'Malformed exact identity source: ' + path) }
    return { ...result.proof, value }
  }

  const ledger = await json(absoluteLedger, ledgerDirectory), value = ledger.value
  exactKeys(value, ['schemaVersion', 'kind', 'rejectedRevision', 'targetRevision', 'sourceRevision', 'evidenceSet', ...categories], 'ledger')
  requireThat(value.schemaVersion === 1 && value.kind === 'office-rejected-identities' && value.rejectedRevision === 'v003'
    && value.targetRevision === 'v004' && value.sourceRevision === 'v002', 'rejected-identities.schema', 'Ledger version/kind does not match the v004 recovery contract')
  const declared = emptySets()
  for (const category of categories) {
    const list = value[category]
    requireThat(Array.isArray(list) && list.length > 0 && list.length <= caps.identities
      && list.every(category.endsWith('Nonces') ? nonce : identifier) && new Set(list).size === list.length,
    'rejected-identities.array', 'Each retired identity array must be nonempty, bounded, valid and unique: ' + category)
    declared[category] = new Set(list)
  }
  exactKeys(value.evidenceSet, ['path', 'sha256'], 'authority evidence-set reference')
  const authority = await json(at(value.evidenceSet.path, ledgerDirectory), ledgerDirectory, value.evidenceSet.sha256)
  exactKeys(authority.value, ['schemaVersion', 'kind', 'rejectedRevision', 'coverage', 'sources'], 'authority evidence set')
  requireThat(authority.value.schemaVersion === 1 && authority.value.kind === 'office-rejected-identity-evidence-set'
    && authority.value.rejectedRevision === 'v003' && authority.value.coverage === 'known-v003-identities',
  'rejected-identities.schema', 'Authority set must describe known rejected-v003 evidence only')
  requireThat(Array.isArray(authority.value.sources) && authority.value.sources.length > 0 && authority.value.sources.length <= caps.sources,
    'rejected-identities.sources', 'Authority evidence set must contain bounded nonempty sources')
  const observed = emptySets(), sourceKeys = new Set(), sourceProofs = []
  for (const source of authority.value.sources) {
    exactKeys(source, ['scope', 'path', 'sha256', 'kind'], 'source reference')
    requireThat(['ledger', 'publication'].includes(source.scope) && ['message', 'decision', 'supporting'].includes(source.kind), 'rejected-identities.source-kind', 'Unknown identity source kind or scope')
    const scope = source.scope === 'ledger' ? ledgerDirectory : published, path = at(source.path, scope)
    requireThat(!sourceKeys.has(path), 'rejected-identities.source-duplicate', 'Authority set repeats a source path'); sourceKeys.add(path)
    const proof = await json(path, scope, source.sha256), identities = extract(proof.value, source.kind)
    for (const category of categories) for (const id of identities[category]) observed[category].add(id)
    sourceProofs.push({ ...source, sha256: proof.sha256, bytes: proof.bytes })
  }
  requireThat(sourceProofs.some(source => source.kind === 'message') && sourceProofs.some(source => source.kind === 'decision'),
    'rejected-identities.sources', 'Known evidence must include actual message and decision originals')
  for (const category of categories) requireThat([...observed[category]].sort().join('\0') === [...declared[category]].sort().join('\0'),
    'rejected-identities.coverage', 'Ledger identities must exactly cover the authority evidence: ' + category)

  // Current rejected files may contain identities absent from the frozen copies.
  // Check both established messages/ and the misplaced v003/messages/ layout;
  // this does not bless either layout as a valid decision publication.
  let visibleFiles = 0
  const directories = new Map()
  function assertKnown(document, kind) {
    const known = extract(document, kind)
    for (const category of categories) for (const id of known[category]) requireThat(declared[category].has(id),
      'rejected-identities.visible-unlisted', 'A visible rejected-v003 identity was omitted: ' + category)
  }
  async function directorySnapshot(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return { actualPath: null, entries: null, fingerprint: null }; throw error }
    const actualPath = await realpath(directory)
    requireThat(relative(publishedCanonical, await realpath(published)) === '' && within(publishedCanonical, actualPath), 'rejected-identities.link-escape', 'Rejected message directory escapes its frozen publications boundary')
    requireThat(entries.length <= caps.directoryEntries, 'rejected-identities.directory-limit', 'Rejected message directory exceeds the entry bound')
    const fingerprint = JSON.stringify(entries.map(entry => [entry.name, entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'other']).sort((a, b) => a[0].localeCompare(b[0])))
    return { actualPath, entries, fingerprint }
  }
  async function walk(directory, depth = 0) {
    requireThat(depth <= 8 && (directories.has(directory) || directories.size < 512), 'rejected-identities.directory-limit', 'Rejected message directory count or depth exceeds the audit bound')
    const snapshot = await directorySnapshot(directory)
    directories.set(directory, { actualPath: snapshot.actualPath, fingerprint: snapshot.fingerprint })
    if (!snapshot.entries) return
    const entries = snapshot.entries
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) { await walk(path, depth + 1); continue }
      if (entry.isSymbolicLink()) requireThat(!(await stat(path)).isDirectory(), 'rejected-identities.directory-link', 'Nested message directory links require explicit evidence and cannot be silently skipped')
      if (!entry.name.endsWith('.json') || (!entry.isFile() && !entry.isSymbolicLink())) continue
      const proof = await json(path, published), document = proof.value
      if (!object(document) || (document.revision !== 'v003' && document.observedRevision !== 'v003')) continue
      assertKnown(document, Object.hasOwn(document, 'messageId') ? 'message' : 'supporting'); visibleFiles++
    }
  }
  for (const role of roles) {
    await walk(resolve(published, role, 'messages'))
    await walk(resolve(published, role, 'v003', 'messages'))
  }
  const oldDecisionPath = resolve(published, 'pmo', 'v003', 'decisions.json')
  let oldDecisionExists = true
  try { await realpath(oldDecisionPath) } catch (error) { if (error.code === 'ENOENT') oldDecisionExists = false; else throw error }
  if (oldDecisionExists) { assertKnown((await json(oldDecisionPath, published)).value, 'decision'); visibleFiles++ }

  const forbidden = new Set(categories.flatMap(category => [...declared[category]]))
  return {
    report: { ledgerPath: ledger.path, ledgerSha256: ledger.sha256, ledgerBytes: ledger.bytes,
      evidenceSetPath: authority.path, evidenceSetSha256: authority.sha256,
      rejectedRevision: 'v003', targetRevision: 'v004', sourceRevision: 'v002', coverage: 'known-v003-identities',
      counts: Object.fromEntries(categories.map(category => [category, declared[category].size])), sources: sourceProofs, visibleRejectedFiles: visibleFiles,
      limitation: 'The selected frozen evidence and visible v003 files are covered; this cannot prove that every intermediate historical body was captured or never rewritten.' },
    assertFresh(document) {
      for (const field of Object.keys(fields)) if (Object.hasOwn(document, field)) requireThat(!forbidden.has(document[field]),
        'rejected-identities.reused', 'Target v004 reuses a retired v003 identity: ' + field)
    },
    async revalidate() {
      let decisionStillExists = true
      try { await realpath(oldDecisionPath) } catch (error) { if (error.code === 'ENOENT') decisionStillExists = false; else throw error }
      requireThat(decisionStillExists === oldDecisionExists, 'rejected-identities.directory-changed', 'Rejected decision presence changed during verification')
      for (const [directory, previous] of directories) {
        const current = await directorySnapshot(directory)
        requireThat(current.actualPath === previous.actualPath && current.fingerprint === previous.fingerprint,
          'rejected-identities.directory-changed', 'Rejected message directory membership changed during verification')
      }
      for (const proof of proofs.values()) {
        const current = (await bytes(proof.path, proof.scope, true)).proof
        requireThat(current.sha256 === proof.sha256 && current.bytes === proof.bytes, 'rejected-identities.changed-during-audit', 'Frozen identity evidence changed during verification')
      }
    }
  }
}
