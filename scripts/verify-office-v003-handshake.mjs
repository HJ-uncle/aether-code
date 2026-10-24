/** Read-only verification of a v003/v004 decision/ACK/closure graph.
 * Format, business correctness, and model execution are separate acceptance.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRejectedIdentityLedger } from './office-rejected-identities.mjs'

const roles = ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance']
const recipients = roles.filter(role => role !== 'pmo')
const digest = value => typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value)
  ? value.replace(/^sha256:/i, '').toLowerCase() : null
const sha = value => createHash('sha256').update(value).digest('hex')
const within = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') }
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value)
const record = value => value && typeof value === 'object' && !Array.isArray(value)
class Fault extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code } }
const incomplete = (code, message) => { throw new Fault('incomplete', code, message) }
const bad = (code, message) => { throw new Fault('failed', code, message) }
const requireThat = (ok, code, message) => { if (!ok) bad(code, message) }

export async function verifyOfficeV003Handshake({ companyRoot, previousSnapshot, closurePaths = {}, limits = {},
  targetRevision = 'v003', sourceRevision = 'v002', baseRevision = 'v002', rejectedIdentityLedger }) {
  assert.ok(['v003', 'v004'].includes(targetRevision), 'Only v003 and v004 target revisions are supported')
  assert.ok(sourceRevision === 'v002' && baseRevision === 'v002', 'Source and base revisions must both remain v002')
  assert.ok(targetRevision === 'v004' || rejectedIdentityLedger === undefined, 'Rejected identity ledgers apply only to an explicitly selected v004 target')
  const root = await realpath(resolve(companyRoot))
  const caps = { files: 2000, fileBytes: 64 * 1024 * 1024, jsonBytes: 4 * 1024 * 1024, directoryEntries: 512, ...limits }
  for (const value of Object.values(caps)) assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 256 * 1024 * 1024)
  const checks = [], seenFiles = new Map(), messages = [], manifests = new Map(), accepted = new Map()
  const historicalManifests = new Map(), legacyFindings = []
  let rejectedLedger
  async function check(id, action) {
    try { const value = await action(); checks.push({ id, status: 'passed' }); return value }
    catch (error) { checks.push({ id, status: error.status || 'failed', code: error.code || 'invalid-contract', message: error.message }); return undefined }
  }
  function pathAt(name, scope = root) {
    requireThat(typeof name === 'string' && name.length > 0 && name.length <= 4096, 'path.invalid', 'Missing or invalid file path')
    const path = resolve(scope, name)
    requireThat(within(scope, path), 'path.escape', 'Reference escapes its declared owner: ' + name)
    return path
  }
  async function file(name, scope = root, refresh = false) {
    const path = pathAt(name, scope)
    if (!refresh && seenFiles.has(path)) {
      const proof = seenFiles.get(path)
      requireThat(within(await realpath(scope), proof.actualPath), 'path.link-escape', 'Cached reference is outside its declared owner')
      return proof
    }
    let actual, before
    try { actual = await realpath(path); before = await stat(path) }
    catch (error) { if (error.code === 'ENOENT') incomplete('file.missing', 'Not published: ' + path); throw error }
    const realScope = await realpath(scope)
    requireThat(within(realScope, actual), 'path.link-escape', 'Reference resolves outside its owner: ' + path)
    requireThat(before.isFile() && before.size <= caps.fileBytes, 'file.limit', 'Not a bounded regular file: ' + path)
    if (!seenFiles.has(path)) requireThat(seenFiles.size < caps.files, 'files.limit', 'Audit file limit reached')
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of createReadStream(actual)) { bytes += chunk.length; requireThat(bytes <= caps.fileBytes, 'file.limit', 'File grew beyond audit bound'); hash.update(chunk) }
    const after = await stat(actual)
    requireThat(bytes === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs, 'file.changed-during-read', 'File changed during verification: ' + path)
    const value = { path, actualPath: actual, ownerScope: scope, workspaceRelativePath: relative(root, path).replaceAll('\\', '/'), sha256: hash.digest('hex'), bytes }
    if (!refresh) seenFiles.set(path, value)
    return value
  }
  async function json(name, scope = root) {
    const proof = await file(name, scope)
    requireThat(proof.bytes <= caps.jsonBytes, 'json.limit', 'JSON exceeds audit bound: ' + proof.path)
    const bytes = await readFile(proof.path)
    requireThat(sha(bytes) === proof.sha256, 'file.changed-during-read', 'JSON changed between hash and parsing')
    let value
    try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) }
    catch { bad('json.invalid', 'Malformed JSON: ' + proof.path) }
    return { ...proof, value }
  }
  async function matches(name, hash, scope = root) {
    requireThat(Boolean(digest(hash)), 'sha.invalid', 'Missing valid SHA-256 for ' + name)
    const proof = await file(name, scope)
    requireThat(proof.sha256 === digest(hash), 'sha.mismatch', 'Actual bytes differ from pinned SHA: ' + proof.path)
    return proof
  }
  async function artifact(role, revision, reference) {
    requireThat(record(reference), 'artifact.invalid', 'Missing artifact reference')
    const scope = reference.scope === 'workspace' ? resolve(root, role) : resolve(root, 'published', role, revision)
    requireThat(reference.scope === undefined || ['workspace', 'publication', 'published'].includes(reference.scope), 'artifact.scope', 'Unknown artifact scope')
    return matches(reference.relativePath ?? reference.path, reference.sha256, scope)
  }
  async function readHistoricalManifest(role) {
    const proof = await json(`published/${role}/${sourceRevision}/manifest.json`), m = proof.value
    // A source fingerprint identifies historical bytes, not acceptance of an old
    // schema or its declarations. Never coerce or repair the published source.
    requireThat(record(m) && m.role === role && m.revision === sourceRevision && m.baseRevision === 'v001', 'history.identity', 'Historical manifest owner/version mismatch: ' + role)
    const finding = (code, message, reference) => legacyFindings.push({ role, revision: sourceRevision, manifestPath: proof.workspaceRelativePath,
      manifestSha256: proof.sha256, code, message, ...(reference ? { reference } : {}) })
    if (m.schemaVersion !== 1) finding('legacy.schema-version', 'Observed schemaVersion is not numeric 1; original value retained: ' + JSON.stringify(m.schemaVersion))
    if (!Array.isArray(m.artifacts) || !m.artifacts.length) finding('legacy.artifacts-empty', 'Historical artifacts are absent or empty')
    else {
      const paths = new Set()
      for (const entry of m.artifacts) {
        try {
          const a = await artifact(role, sourceRevision, entry)
          requireThat(Number.isSafeInteger(entry.bytes) && entry.bytes === a.bytes && a.bytes > 0, 'artifact.bytes', 'Historical artifact size mismatch or empty file')
          requireThat(!paths.has(a.path), 'artifact.duplicate', 'Historical manifest repeats an artifact'); paths.add(a.path)
        } catch (error) {
          // Diagnose only the declared path; no aliases, stripped owner prefixes,
          // basename lookup or guessed replacement may turn a defect into proof.
          finding('legacy.' + (error.code || 'invalid-artifact'), error.message,
            record(entry) ? { path: entry.relativePath ?? entry.path, scope: entry.scope, sha256: entry.sha256 } : { value: entry })
        }
      }
    }
    const value = { ...proof, historicalAcceptance: 'not-validated' }
    historicalManifests.set(role, value); return value
  }
  async function readManifest(role, revision) {
    const proof = await json(`published/${role}/${revision}/manifest.json`)
    const m = proof.value
    requireThat(m.schemaVersion === 1 && m.role === role && m.revision === revision && m.baseRevision === baseRevision, 'manifest.identity', 'Manifest identity/version mismatch: ' + role + '/' + revision)
    requireThat(Array.isArray(m.artifacts) && m.artifacts.length > 0, 'manifest.empty', 'Manifest has no actual artifacts')
    const artifacts = []
    for (const entry of m.artifacts) {
      const a = await artifact(role, revision, entry)
      requireThat(Number.isSafeInteger(entry.bytes) && entry.bytes === a.bytes && a.bytes > 0, 'artifact.bytes', 'Artifact size mismatch or empty file')
      artifacts.push(a)
    }
    requireThat(new Set(artifacts.map(a => a.path)).size === artifacts.length, 'artifact.duplicate', 'Manifest repeats an artifact')
    const value = { ...proof, artifacts }; manifests.set(role + '/' + revision, value); return value
  }
  async function listJson(directory) {
    const path = pathAt(directory)
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    requireThat(entries.length <= caps.directoryEntries, 'directory.limit', 'Too many entries: ' + directory)
    return entries.filter(e => e.name.endsWith('.json') && (e.isFile() || e.isSymbolicLink())).map(e => directory + '/' + e.name).sort()
  }

  if (targetRevision === 'v004') rejectedLedger = await check('rejected-identities.ledger', () => loadRejectedIdentityLedger({
    ledgerPath: rejectedIdentityLedger, companyRoot: root
  }))
  function freshIdentity(value) {
    if (targetRevision !== 'v004') return
    if (!rejectedLedger) incomplete('rejected-identities.unverified', 'No validated rejected-v003 identity ledger is available')
    rejectedLedger.assertFresh(value)
  }

  for (const role of roles) {
    await check(`history.${role}.${sourceRevision}.identity-bytes`, () => readHistoricalManifest(role))
    await check(`manifest.${role}.${targetRevision}`, () => readManifest(role, targetRevision))
  }
  const decision = await check('decision.identity-and-sources', async () => {
    const proof = await json(`published/pmo/${targetRevision}/decisions.json`), d = proof.value
    freshIdentity(d)
    requireThat(d.schemaVersion === 1 && d.revision === targetRevision && d.baseRevision === baseRevision && d.status === 'approved', 'decision.revision', `Decision is not approved ${targetRevision} based on ${baseRevision}`)
    requireThat(typeof d.decisionId === 'string' && d.decisionId.length > 0 && nonce(d.decisionNonce), 'decision.identity', 'Missing decision identity/nonce')
    requireThat(Array.isArray(d.sourceRevisions) && d.sourceRevisions.length === 6 && new Set(d.sourceRevisions.map(r => r.role)).size === 6, 'decision.sources', 'Decision must pin six different source roles')
    for (const source of d.sourceRevisions) {
      requireThat(roles.includes(source.role) && source.revision === sourceRevision && source.manifestPath === `published/${source.role}/${sourceRevision}/manifest.json`, 'decision.source-owner', 'Source manifest points at another owner/version')
      if (!historicalManifests.has(source.role)) incomplete('decision.history-unverified', 'Historical owner/version has not passed identity checks: ' + source.role)
      await matches(source.manifestPath, source.manifestSha256)
    }
    requireThat(Array.isArray(d.conflicts) && d.conflicts.length > 0, 'decision.proposals-missing', 'Decision must retain real conflict proposals')
    for (const conflict of d.conflicts) {
      requireThat(record(conflict) && Array.isArray(conflict.proposals) && conflict.proposals.length >= 2
        && new Set(conflict.proposals.map(p => p?.role)).size >= 2, 'decision.proposal-roles', 'Conflict must retain proposals from at least two different roles')
      for (const proposal of conflict.proposals) {
        requireThat(record(proposal) && roles.includes(proposal.role) && proposal.revision === sourceRevision
          && Number.isFinite(proposal.amount), 'decision.proposal-identity', `Proposal must identify a real ${sourceRevision} source role and numeric amount`)
        requireThat(Array.isArray(proposal.evidence) && proposal.evidence.length > 0, 'decision.proposal-evidence', 'Proposal has no source file evidence')
        for (const reference of proposal.evidence) {
          requireThat(record(reference) && reference.scope !== 'workspace', 'decision.proposal-private', 'Proposal evidence must use public source files, not another role private workspace')
          // These are new target-revision references. Legacy path defects are never an
          // exception here; real public bytes must match the explicit path/SHA.
          await artifact(proposal.role, proposal.revision, reference)
        }
      }
    }
    const manifest = manifests.get('pmo/' + targetRevision)
    if (!manifest) incomplete('decision.manifest-missing', 'PMO manifest has not passed verification')
    requireThat(manifest.artifacts.some(a => a.path === proof.path && a.sha256 === proof.sha256), 'decision.unmanifested', 'Decision is absent from the frozen PMO artifact manifest')
    return proof
  })
  for (const role of roles) await check(`messages.read.${role}`, async () => {
    for (const path of await listJson(`published/${role}/messages`)) {
      const proof = await json(path), value = proof.value
      // Old v001/v002 message schemas are not rewritten by this verifier.
      if (value.revision !== targetRevision && value.observedRevision !== targetRevision) continue
      freshIdentity(value)
      requireThat(value.fromRole === role, 'message.sender', 'Message is stored under a different sender owner')
      messages.push({ ...proof, role })
    }
  })
  await check('messages.immutable-identity', () => {
    const ids = new Map(), requests = new Map()
    for (const proof of messages) {
      const m = proof.value
      requireThat(typeof m.messageId === 'string' && m.messageId, 'message.id', 'Missing message ID')
      const previous = ids.get(m.messageId)
      requireThat(!previous || previous.sha256 === proof.sha256, 'message.retry-changed-body', 'A message ID was reused with different bytes')
      ids.set(m.messageId, proof)
      if (m.kind === 'decision') {
        const key = [m.fromRole, m.toRole, m.correlationId].join('|'), prior = requests.get(key)
        requireThat(!prior || prior.sha256 === proof.sha256, 'message.retry-changed-body', 'Retry changed immutable decision identity/body')
        requests.set(key, proof)
      }
    }
  })
  const originals = new Map(), seenNonces = new Set()
  for (const role of recipients) await check(`decision.recipient.${role}`, async () => {
    if (!decision) incomplete('decision.unverified', 'Decision has not passed its checks')
    const found = messages.filter(p => p.value.kind === 'decision' && p.value.fromRole === 'pmo' && p.value.toRole === role && p.value.revision === targetRevision)
    const distinct = [...new Map(found.map(p => [p.sha256, p])).values()]
    if (!distinct.length) incomplete('decision.recipient-missing', `No ${targetRevision} decision for ${role}`)
    requireThat(distinct.length === 1, 'decision.recipient-ambiguous', `Multiple distinct ${targetRevision} decisions for ${role}`)
    const proof = distinct[0], m = proof.value, d = decision.value
    requireThat(m.schemaVersion === 1 && m.baseRevision === baseRevision && m.receiverBaseRevision === sourceRevision && m.requiresAck === true && typeof m.correlationId === 'string' && m.correlationId && Number.isFinite(Date.parse(m.createdAt)), 'message.contract', 'Decision envelope contract mismatch')
    requireThat(nonce(m.nonce) && !seenNonces.has(m.nonce), 'nonce.invalid-or-reused', 'Recipient nonce missing, malformed or reused'); seenNonces.add(m.nonce)
    requireThat(m.decisionId === d.decisionId && m.decisionNonce === d.decisionNonce && digest(m.decisionSha256) === decision.sha256, 'decision.message-fingerprint', 'Message refers to a different decision')
    requireThat(digest(m.pmoManifestSha256) === manifests.get('pmo/' + targetRevision)?.sha256 && digest(m.receiverBaseManifestSha256) === historicalManifests.get(role)?.sha256, 'decision.base-sha', 'Message sender/receiver manifest SHA is stale')
    requireThat(Array.isArray(m.evidence) && m.evidence.length, 'message.evidence', 'Decision message has no verifiable evidence')
    for (const reference of m.evidence) await artifact('pmo', targetRevision, reference)
    originals.set(role, proof)
  })
  for (const role of recipients) await check(`ack.${role}`, async () => {
    const original = originals.get(role)
    if (!original) incomplete('ack.no-original', 'No validated original decision for ' + role)
    const candidates = messages.filter(p => ['ack', 'nack'].includes(p.value.kind) && p.value.ackOf === original.value.messageId)
    if (!candidates.length) incomplete('ack.missing', 'No actual receiver ACK for ' + role)
    const distinct = [...new Map(candidates.map(p => [p.sha256, p])).values()]
    requireThat(distinct.length === 1, 'ack.ambiguous', 'Multiple nonidentical responses require explicit resolution for ' + role)
    const proof = distinct[0], ack = proof.value, sent = original.value
    requireThat(ack.fromRole === role && ack.toRole === 'pmo' && ack.schemaVersion === 1 && ack.requiresAck === false, 'ack.recipient', 'ACK was authored by the wrong receiver or targets another owner')
    requireThat(ack.observedRevision === targetRevision && ack.correlationId === sent.correlationId, 'ack.observed-revision', 'ACK refers to a different revision/correlation')
    requireThat(digest(ack.ackOfSha256) === original.sha256 && ack.nonce === sent.nonce && ack.decisionId === sent.decisionId && ack.decisionNonce === sent.decisionNonce, 'ack.nonce-or-message-sha', 'ACK nonce or original-message identity does not match')
    for (const key of ['decisionSha256', 'pmoManifestSha256', 'receiverBaseManifestSha256']) requireThat(digest(ack[key]) === digest(sent[key]), 'ack.stale-sha', 'ACK uses stale ' + key)
    if (ack.kind === 'nack' || ack.decision !== 'accepted') incomplete('ack.not-accepted', 'Receiver explicitly has not accepted: ' + role)
    requireThat(ack.revision === targetRevision && ack.baseRevision === baseRevision, 'ack.sender-revision', `Accepted ACK must use its actual ${targetRevision} publication`)
    const m = manifests.get(role + '/' + targetRevision)
    if (!m) incomplete('ack.application-missing', `Receiver ${targetRevision} has not passed manifest checks`)
    const applied = ack.appliedManifest
    requireThat(record(applied) && applied.role === role && applied.revision === targetRevision && applied.manifestPath === `published/${role}/${targetRevision}/manifest.json` && digest(applied.manifestSha256) === m.sha256, 'ack.applied-manifest', `ACK is not bound to its own frozen ${targetRevision} manifest`)
    requireThat(Array.isArray(ack.appliedArtifactReferences) && ack.appliedArtifactReferences.length > 0, 'ack.empty-application', 'Empty ACK cannot prove application')
    const artifacts = []
    for (const reference of ack.appliedArtifactReferences) {
      const a = await artifact(role, targetRevision, reference)
      requireThat(m.artifacts.some(item => item.path === a.path && item.sha256 === a.sha256), 'ack.unmanifested-application', 'Applied artifact is absent from the same role/version manifest')
      artifacts.push(a)
    }
    accepted.set(role, { ...proof, original, appliedManifest: m, artifacts })
  })
  await check(`messages.no-unmatched-${targetRevision}-receipts`, () => {
    const originalIds = new Set([...originals.values()].map(p => p.value.messageId))
    for (const proof of messages) if (['ack', 'nack'].includes(proof.value.kind) && proof.value.toRole === 'pmo' && proof.value.observedRevision === targetRevision)
      requireThat(originalIds.has(proof.value.ackOf), 'ack.unknown-original', `A ${targetRevision} receipt references an unknown/old original message`)
  })

  const verifiedClosures = new Map()
  for (const role of ['pmo', 'compliance']) await check(`closure.${role}`, async () => {
    if (accepted.size !== 5) incomplete('closure.ack-incomplete', 'Five validated receiver applications are required')
    const directory = `published/${role}/closures/${targetRevision}`
    const files = closurePaths[role] ? [closurePaths[role]] : await listJson(directory)
    if (!files.length) incomplete('closure.missing', 'No immutable closure published by ' + role)
    if (files.length !== 1) incomplete('closure.selection-required', 'Multiple immutable closures exist; select the exact reviewed path for ' + role)
    const full = pathAt(files[0]); requireThat(within(resolve(root, directory), full), 'closure.owner', 'Closure must stay in its author prefix')
    const proof = await json(files[0]), c = proof.value
    freshIdentity(c)
    requireThat(c.schemaVersion === 1 && c.authorRole === role && c.subjectRevision === targetRevision && typeof c.closureId === 'string' && c.closureId && Number.isFinite(Date.parse(c.createdAt)), 'closure.identity', 'Closure identity/version is invalid')
    if (c.status !== 'complete') incomplete('closure.incomplete', role + ' explicitly reports an incomplete closure')
    requireThat(c.decisionId === decision.value.decisionId && c.decisionNonce === decision.value.decisionNonce && digest(c.decisionSha256) === decision.sha256 && digest(c.pmoManifestSha256) === manifests.get('pmo/' + targetRevision).sha256, 'closure.stale-decision', 'Closure belongs to an old decision/manifest')
    requireThat(Array.isArray(c.acknowledgements) && c.acknowledgements.length === 5 && new Set(c.acknowledgements.map(a => a.role)).size === 5, 'closure.empty-or-duplicate-acks', 'Closure must identify all five distinct receivers')
    for (const receipt of c.acknowledgements) {
      const actual = accepted.get(receipt.role)
      requireThat(Boolean(actual), 'closure.foreign-receiver', 'Unknown receipt owner')
      requireThat(receipt.messageId === actual.original.value.messageId && receipt.nonce === actual.original.value.nonce && digest(receipt.messageSha256) === actual.original.sha256, 'closure.message-fingerprint', 'Closure message fingerprint is stale')
      requireThat(receipt.ackPath === actual.workspaceRelativePath && digest(receipt.ackSha256) === actual.sha256, 'closure.ack-fingerprint', 'Closure points to another ACK')
      requireThat(record(receipt.appliedManifest) && receipt.appliedManifest.role === receipt.role && receipt.appliedManifest.revision === targetRevision && receipt.appliedManifest.manifestPath === actual.appliedManifest.workspaceRelativePath && digest(receipt.appliedManifest.manifestSha256) === actual.appliedManifest.sha256, 'closure.applied-manifest', 'Closure application manifest is stale')
      requireThat(Array.isArray(receipt.appliedArtifacts) && receipt.appliedArtifacts.length === actual.artifacts.length, 'closure.applied-artifacts', 'Closure must list the actual ACK application artifacts')
      const references = new Set()
      for (const ref of receipt.appliedArtifacts) {
        requireThat(!references.has(ref.workspaceRelativePath), 'closure.duplicate-artifact', 'Duplicate applied artifact'); references.add(ref.workspaceRelativePath)
        requireThat(actual.artifacts.some(a => a.workspaceRelativePath === ref.workspaceRelativePath && a.sha256 === digest(ref.sha256)), 'closure.applied-sha', 'Closure application file SHA is stale')
      }
    }
    requireThat(Array.isArray(c.checks) && c.checks.length > 0 && Array.isArray(c.unresolvedIssues), 'closure.evidence-missing', 'Closure must report actual checks and unresolved issues')
    if (c.unresolvedIssues.length || c.checks.some(item => item.status !== 'passed')) incomplete('closure.unresolved', 'Closure retains unresolved or unverified checks')
    for (const item of c.checks) {
      requireThat(item.id && Array.isArray(item.evidence) && item.evidence.length > 0, 'closure.empty-check', 'A bare passed assertion is not check evidence')
      for (const ref of item.evidence) {
        const target = pathAt(ref.workspaceRelativePath)
        const scope = ['inputs', 'published', role].map(prefix => resolve(root, prefix)).find(candidate => within(candidate, target))
        requireThat(Boolean(scope), 'closure.evidence-owner', 'Closure check cites another role private directory')
        await matches(target, ref.sha256, scope)
      }
    }
    if (role === 'compliance') {
      const pmo = verifiedClosures.get('pmo')
      if (!pmo) incomplete('closure.pmo-unverified', 'PMO closure is not verified')
      requireThat(c.pmoClosure?.workspaceRelativePath === pmo.workspaceRelativePath && digest(c.pmoClosure?.sha256) === pmo.sha256, 'closure.pmo-sha', 'Compliance did not bind the actual PMO closure')
    }
    verifiedClosures.set(role, proof)
  })
  await check('immutability.prior-published-bytes', async () => {
    const snapshot = previousSnapshot?.observedSnapshot ?? previousSnapshot
    if (!snapshot?.files?.length) incomplete('immutability.baseline-missing', 'Provide the independently captured snapshot from decision publication (G2)')
    requireThat(snapshot.files.length <= caps.files, 'snapshot.limit', 'Snapshot too large')
    if (snapshot.targetRevision !== undefined) requireThat(snapshot.targetRevision === targetRevision, 'snapshot.revision', 'Prior baseline belongs to another target revision')
    if (targetRevision === 'v004') {
      if (!snapshot.rejectedIdentityLedgerSha256) incomplete('rejected-identities.baseline-pin-missing', 'The v004 baseline must independently pin the rejected identity ledger SHA')
      if (!rejectedLedger) incomplete('rejected-identities.unverified', 'No verified identity ledger is available to compare with the v004 baseline')
      requireThat(digest(snapshot.rejectedIdentityLedgerSha256) === rejectedLedger.report.ledgerSha256,
        'rejected-identities.baseline-pin-mismatch', 'The rejected identity ledger changed after the v004 baseline was captured')
    }
    const pinned = new Set()
    for (const ref of snapshot.files) {
      const name = ref.workspaceRelativePath ?? ref.path
      const proof = await matches(name, ref.sha256); pinned.add(proof.path)
    }
    const essential = [decision?.path, manifests.get('pmo/' + targetRevision)?.path, ...[...originals.values()].map(p => p.path)].filter(Boolean)
    if (essential.length !== 7 || essential.some(path => !pinned.has(path))) incomplete('immutability.baseline-coverage', 'G2 snapshot must pin the PMO decision, manifest and five original addressed messages')
  })
  await check('snapshot.no-change-during-audit', async () => {
    for (const proof of seenFiles.values()) {
      const after = await file(proof.path, proof.ownerScope, true)
      requireThat(after.sha256 === proof.sha256 && after.bytes === proof.bytes, 'file.changed-during-audit', 'Published file changed while verifying: ' + proof.path)
    }
  })
  if (targetRevision === 'v004') await check('rejected-identities.no-change-during-audit', async () => {
    if (!rejectedLedger) incomplete('rejected-identities.unverified', 'Cannot revalidate an unverified rejected identity ledger')
    await rejectedLedger.revalidate()
  })
  const status = checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'incomplete') ? 'incomplete' : 'passed'
  return { schemaVersion: 1, observedAt: new Date().toISOString(), scope: `${targetRevision} immutable decision / nonce / ACK / closure evidence graph`,
    targetRevision, sourceRevision, baseRevision, status, passed: status === 'passed',
    ...(targetRevision === 'v004' ? { rejectedIdentityLedger: rejectedLedger?.report ?? null } : {}),
    checks, counts: { files: seenFiles.size, acceptedRecipients: accepted.size, verifiedClosures: verifiedClosures.size },
    historicalAcceptance: 'not-validated', legacyFindings,
    historicalInputs: [...historicalManifests.values()].map(p => ({ role: p.value.role, revision: sourceRevision, manifestPath: p.workspaceRelativePath,
      manifestSha256: p.sha256, observedSchemaVersion: p.value.schemaVersion, historicalAcceptance: p.historicalAcceptance })),
    observedSnapshot: { schemaVersion: 1, capturedAt: new Date().toISOString(), targetRevision, sourceRevision, baseRevision,
      ...(targetRevision === 'v004' ? { rejectedIdentityLedgerSha256: rejectedLedger?.report.ledgerSha256 ?? null } : {}), files: [...seenFiles.values()] },
    limitations: ['This does not verify Office rendering, actual business arithmetic, or OS/process isolation.', 'Nonce syntax and uniqueness are checked; randomness generation and sender authentication need runtime evidence.',
      `${sourceRevision} identity/bytes are historical inputs only; legacyFindings remain unaccepted historical defects even if the ${targetRevision} handshake passes.`,
      'Conflict proposal evidence paths and hashes are verified; amounts, claims and other narrative evidence need the independent business audit.',
      'File evidence describes the observed bytes. Pending/missing publications cannot pass.',
      ...(targetRevision === 'v004' ? ['Rejected v003 evidence remains rejected. The v004 baseline cannot establish that historical v003 files were never rewritten.',
        'Retired identities cover the frozen authority set and visible v003 publications, not uncaptured intermediate history.'] : [])] }
}

async function cli() {
  const args = process.argv.slice(2), options = {}
  const allowed = new Set(['company', 'baseline', 'closures', 'output', 'target-revision', 'source-revision', 'base-revision', 'rejected-identities'])
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(args[i].startsWith('--') && args[i + 1]); const key = args[i].slice(2)
    assert.ok(allowed.has(key) && options[key] === undefined, 'Unknown or duplicate option: ' + args[i]); options[key] = args[i + 1]
  }
  assert.ok(options.company, 'Use --company <company root> [--target-revision v003|v004] [--source-revision v002] [--base-revision v002] [--rejected-identities <ledger.json>] [--baseline <audit/snapshot.json>] [--closures <paths.json>] [--output <outside-company.json>]')
  const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  const result = await verifyOfficeV003Handshake({ companyRoot: options.company, previousSnapshot: options.baseline ? await read(options.baseline) : undefined,
    closurePaths: options.closures ? await read(options.closures) : {}, targetRevision: options['target-revision'],
    sourceRevision: options['source-revision'], baseRevision: options['base-revision'], rejectedIdentityLedger: options['rejected-identities'] })
  if (options.output) {
    const root = await realpath(resolve(options.company)), output = resolve(options.output), parent = await realpath(dirname(output))
    assert.ok(!within(root, resolve(parent, output.slice(dirname(output).length + 1))), 'Audit output must stay outside the company workspace')
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  process.stdout.write(JSON.stringify({ status: result.status, counts: result.counts, failed: result.checks.filter(c => c.status !== 'passed') }) + '\n')
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'incomplete' ? 2 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
