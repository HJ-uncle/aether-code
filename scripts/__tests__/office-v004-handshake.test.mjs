/** Synthetic v004 recovery graphs and frozen rejected-v003 evidence only.
 * No live company files, models, windows or runner commands are changed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfficeV003Handshake } from '../verify-office-v003-handshake.mjs'
import { loadRejectedIdentityLedger } from '../office-rejected-identities.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = resolve(repository, '.e2e-tmp')
const roles = ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance'], recipients = roles.filter(role => role !== 'pmo')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async path => JSON.parse(await readFile(path, 'utf8'))
async function write(root, path, value) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
  await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), bytes)
  return { workspaceRelativePath: path, sha256: sha(bytes), bytes: bytes.length }
}
async function mutate(path, edit) { const value = await read(path); edit(value); return write(dirname(path), path, value) }
async function seed(root, revision) {
  const manifests = {}, artifacts = {}, originals = {}, acks = {}, pins = [], identityFiles = []
  for (const role of roles) for (const version of ['v002', revision]) {
    artifacts[role + '/' + version] = await write(root, `published/${role}/${version}/sample.csv`, `role,revision\n${role},${version}\n`)
    const artifact = artifacts[role + '/' + version]
    manifests[role + '/' + version] = await write(root, `published/${role}/${version}/manifest.json`, { schemaVersion: 1, role, revision: version,
      baseRevision: version === 'v002' ? 'v001' : 'v002', artifacts: [{ path: 'sample.csv', sha256: artifact.sha256, bytes: artifact.bytes }] })
  }
  const decisionId = randomUUID(), decisionNonce = randomUUID()
  const decision = await write(root, `published/pmo/${revision}/decisions.json`, { schemaVersion: 1, revision, baseRevision: 'v002', status: 'approved', decisionId, decisionNonce,
    sourceRevisions: roles.map(role => ({ role, revision: 'v002', manifestPath: manifests[role + '/v002'].workspaceRelativePath, manifestSha256: manifests[role + '/v002'].sha256 })),
    conflicts: [{ id: 'synthetic-choice', proposals: ['sales', 'operations'].map(role => ({ role, revision: 'v002', amount: 1, evidence: [{ path: 'sample.csv', sha256: artifacts[role + '/v002'].sha256 }] })) }] })
  const pmoManifestPath = `published/pmo/${revision}/manifest.json`, pmoManifest = await read(resolve(root, pmoManifestPath))
  pmoManifest.artifacts.push({ path: 'decisions.json', sha256: decision.sha256, bytes: decision.bytes })
  manifests['pmo/' + revision] = await write(root, pmoManifestPath, pmoManifest)
  pins.push(decision, manifests['pmo/' + revision]); identityFiles.push({ ...decision, kind: 'decision' })
  for (const role of recipients) {
    const message = { schemaVersion: 1, messageId: randomUUID(), createdAt: new Date().toISOString(), fromRole: 'pmo', toRole: role, kind: 'decision',
      revision, baseRevision: 'v002', correlationId: randomUUID(), requiresAck: true, nonce: randomUUID(), decisionId, decisionNonce,
      decisionSha256: decision.sha256, pmoManifestSha256: manifests['pmo/' + revision].sha256, receiverBaseRevision: 'v002', receiverBaseManifestSha256: manifests[role + '/v002'].sha256,
      evidence: [{ path: 'decisions.json', sha256: decision.sha256 }] }
    originals[role] = { ...await write(root, `published/pmo/messages/${revision}-to-${role}.json`, message), value: message }
    pins.push(originals[role]); identityFiles.push({ ...originals[role], kind: 'message' })
    const ack = { schemaVersion: 1, messageId: randomUUID(), createdAt: new Date().toISOString(), fromRole: role, toRole: 'pmo', kind: 'ack',
      revision, baseRevision: 'v002', observedRevision: revision, correlationId: message.correlationId, ackOf: message.messageId, ackOfSha256: originals[role].sha256,
      decision: 'accepted', requiresAck: false, nonce: message.nonce, decisionId, decisionNonce, decisionSha256: decision.sha256,
      pmoManifestSha256: message.pmoManifestSha256, receiverBaseManifestSha256: message.receiverBaseManifestSha256,
      appliedManifest: { role, revision, manifestPath: manifests[role + '/' + revision].workspaceRelativePath, manifestSha256: manifests[role + '/' + revision].sha256 },
      appliedArtifactReferences: [{ path: 'sample.csv', sha256: artifacts[role + '/' + revision].sha256 }] }
    acks[role] = { ...await write(root, `published/${role}/messages/${revision}-ack.json`, ack), value: ack }
    identityFiles.push({ ...acks[role], kind: 'message' })
  }
  const acknowledgements = recipients.map(role => ({ role, messageId: originals[role].value.messageId, nonce: originals[role].value.nonce,
    messageSha256: originals[role].sha256, ackPath: acks[role].workspaceRelativePath, ackSha256: acks[role].sha256,
    appliedManifest: acks[role].value.appliedManifest,
    appliedArtifacts: [{ workspaceRelativePath: artifacts[role + '/' + revision].workspaceRelativePath, sha256: artifacts[role + '/' + revision].sha256 }] }))
  const closure = { schemaVersion: 1, closureId: randomUUID(), createdAt: new Date().toISOString(), subjectRevision: revision, status: 'complete',
    decisionId, decisionNonce, decisionSha256: decision.sha256, pmoManifestSha256: manifests['pmo/' + revision].sha256, acknowledgements,
    checks: [{ id: 'synthetic-reference', status: 'passed', evidence: [{ workspaceRelativePath: decision.workspaceRelativePath, sha256: decision.sha256 }] }], unresolvedIssues: [] }
  const pmoClosure = await write(root, `published/pmo/closures/${revision}/closure.json`, { ...closure, authorRole: 'pmo' })
  await write(root, `published/compliance/closures/${revision}/closure.json`, { ...closure, closureId: randomUUID(), authorRole: 'compliance',
    pmoClosure: { workspaceRelativePath: pmoClosure.workspaceRelativePath, sha256: pmoClosure.sha256 } })
  return { snapshot: { files: pins.map(({ workspaceRelativePath, sha256 }) => ({ workspaceRelativePath, sha256 })) }, identityFiles, originals, acks }
}
async function freezeLedger(company, audit, previous) {
  const sets = { messageIds: new Set(), messageNonces: new Set(), decisionIds: new Set(), decisionNonces: new Set() }, sources = []
  const fields = { messageId: 'messageIds', nonce: 'messageNonces', decisionId: 'decisionIds', decisionNonce: 'decisionNonces' }
  for (const [index, reference] of previous.identityFiles.entries()) {
    const path = 'frozen-v003/' + index + '.json', absolute = resolve(audit, path)
    await mkdir(dirname(absolute), { recursive: true }); await copyFile(resolve(company, reference.workspaceRelativePath), absolute)
    const document = await read(absolute)
    for (const [field, category] of Object.entries(fields)) if (document[field]) sets[category].add(document[field])
    sources.push({ scope: 'ledger', path, sha256: reference.sha256, kind: reference.kind })
  }
  const authority = await write(audit, 'authority.json', { schemaVersion: 1, kind: 'office-rejected-identity-evidence-set', rejectedRevision: 'v003', coverage: 'known-v003-identities', sources })
  const ledgerValue = { schemaVersion: 1, kind: 'office-rejected-identities', rejectedRevision: 'v003', targetRevision: 'v004', sourceRevision: 'v002',
    evidenceSet: { path: 'authority.json', sha256: authority.sha256 }, ...Object.fromEntries(Object.entries(sets).map(([key, value]) => [key, [...value]])) }
  const ledger = await write(audit, 'ledger.json', ledgerValue)
  return { ledgerPath: resolve(audit, 'ledger.json'), ledgerValue, ledger, authorityPath: resolve(audit, 'authority.json') }
}
async function fixture(run) {
  await mkdir(fixtures, { recursive: true }); const base = await mkdtemp(resolve(fixtures, 'v004-handshake-'))
  try {
    const company = resolve(base, 'company'), audit = resolve(base, 'audit')
    await mkdir(company); await mkdir(audit)
    const old = await seed(company, 'v003'), frozen = await freezeLedger(company, audit, old)
    // Preserve a genuinely rejected historical manifest and its earlier snapshot.
    await mutate(resolve(company, 'published/pmo/v003/manifest.json'), value => { value.rejectedRewrite = true })
    const current = await seed(company, 'v004')
    current.snapshot.targetRevision = 'v004'; current.snapshot.rejectedIdentityLedgerSha256 = frozen.ledger.sha256
    const data = { base, company, audit, old, current, ...frozen }
    data.verify = options => verifyOfficeV003Handshake({ companyRoot: company, targetRevision: 'v004', previousSnapshot: current.snapshot, rejectedIdentityLedger: frozen.ledgerPath, ...options })
    await run(data)
  } finally {
    const actual = await realpath(base), relativePath = relative(await realpath(fixtures), actual)
    assert.ok(!isAbsolute(relativePath) && !relativePath.startsWith('..') && /^v004-handshake-[^\\/]+$/.test(relativePath))
    await rm(actual, { recursive: true, force: true })
  }
}
const hasCode = (result, code) => { assert.notEqual(result.status, 'passed'); assert.ok(result.checks.some(item => item.code === code), JSON.stringify(result.checks)) }

test('v004 upgrades all six roles directly from v002 and pins the frozen ledger', () => fixture(async f => {
  const result = await f.verify()
  assert.equal(result.status, 'passed', JSON.stringify(result.checks))
  assert.equal(result.rejectedIdentityLedger.ledgerSha256, f.ledger.sha256)
  assert.equal(result.observedSnapshot.rejectedIdentityLedgerSha256, f.ledger.sha256)
  assert.equal(result.counts.acceptedRecipients, 5); assert.equal(result.counts.verifiedClosures, 2)
  const oldResult = await verifyOfficeV003Handshake({ companyRoot: f.company, previousSnapshot: f.old.snapshot })
  assert.equal(oldResult.status, 'failed'); assert.equal(oldResult.targetRevision, 'v003')
}))

test('v004 cannot pass without an explicitly supplied ledger file', () => fixture(async f => {
  hasCode(await f.verify({ rejectedIdentityLedger: undefined }), 'rejected-identities.required')
}))

for (const category of ['messageIds', 'messageNonces', 'decisionIds', 'decisionNonces']) {
  test('empty retired identity array is rejected: ' + category, () => fixture(async f => {
    await mutate(f.ledgerPath, ledger => { ledger[category] = [] })
    hasCode(await f.verify(), 'rejected-identities.array')
  }))
}

test('retired identities must exactly cover the fixed authority sources', () => fixture(async f => {
  await mutate(f.ledgerPath, ledger => { ledger.messageIds.pop() })
  hasCode(await f.verify(), 'rejected-identities.coverage')
}))
test('unproven extra identity cannot be inserted into a ledger', () => fixture(async f => {
  await mutate(f.ledgerPath, ledger => { ledger.messageIds.push(randomUUID()) })
  hasCode(await f.verify(), 'rejected-identities.coverage')
}))
test('authority source bytes are verified against their pinned hashes', () => fixture(async f => {
  const authority = await read(f.authorityPath), path = resolve(f.audit, authority.sources[1].path)
  await mutate(path, document => { document.nonce = randomUUID() })
  hasCode(await f.verify(), 'rejected-identities.sha-mismatch')
}))
test('absent historical source stays incomplete instead of using a same-basename replacement', () => fixture(async f => {
  const authority = await read(f.authorityPath), original = resolve(f.audit, authority.sources[1].path)
  const alternate = resolve(f.audit, 'same-basename', authority.sources[1].path.split('/').at(-1))
  await mkdir(dirname(alternate), { recursive: true }); await copyFile(original, alternate); await unlink(original)
  hasCode(await f.verify(), 'rejected-identities.source-missing')
}))
test('authority set itself cannot be replaced after its ledger hash was pinned', () => fixture(async f => {
  await mutate(f.authorityPath, authority => { authority.sources.pop() })
  hasCode(await f.verify(), 'rejected-identities.sha-mismatch')
}))
test('conflicting historical bodies retain their source hashes without certifying v003', () => fixture(async f => {
  const duplicate = await write(f.audit, 'frozen-v003/rejected-repin.json', { ...f.old.originals.finance.value, rejectedRewrite: 'same identity, different historical body' })
  await mutate(f.authorityPath, authority => { authority.sources.push({ scope: 'ledger', path: duplicate.workspaceRelativePath, sha256: duplicate.sha256, kind: 'message' }) })
  const authoritySha = sha(await readFile(f.authorityPath))
  await mutate(f.ledgerPath, ledger => { ledger.evidenceSet.sha256 = authoritySha })
  // This synthetic G2 baseline is taken after the complete rejected evidence
  // set is selected, not a replacement for any earlier successful audit.
  f.current.snapshot.rejectedIdentityLedgerSha256 = sha(await readFile(f.ledgerPath))
  const result = await f.verify()
  assert.equal(result.status, 'passed', JSON.stringify(result.checks))
  assert.ok(result.rejectedIdentityLedger.sources.some(source => source.sha256 === duplicate.sha256))
  assert.ok(result.rejectedIdentityLedger.sources.some(source => source.sha256 === f.old.originals.finance.sha256))
  assert.equal((await verifyOfficeV003Handshake({ companyRoot: f.company, previousSnapshot: f.old.snapshot })).status, 'failed')
}))
test('unknown ledger fields and duplicate retired IDs are rejected', () => fixture(async f => {
  await mutate(f.ledgerPath, ledger => { ledger.approveOldRevision = true })
  hasCode(await f.verify(), 'rejected-identities.schema')
  await mutate(f.ledgerPath, ledger => { delete ledger.approveOldRevision; ledger.messageIds.push(ledger.messageIds[0]) })
  hasCode(await f.verify(), 'rejected-identities.array')
}))
test('identity authority cannot use private workspace scope', () => fixture(async f => {
  await mutate(f.authorityPath, authority => { authority.sources[0].scope = 'workspace' })
  const authoritySha = sha(await readFile(f.authorityPath))
  await mutate(f.ledgerPath, ledger => { ledger.evidenceSet.sha256 = authoritySha })
  hasCode(await f.verify(), 'rejected-identities.source-kind')
}))
test('supporting kind cannot hide an original message envelope', () => fixture(async f => {
  await mutate(f.authorityPath, authority => { authority.sources[1].kind = 'supporting' })
  const authoritySha = sha(await readFile(f.authorityPath))
  await mutate(f.ledgerPath, ledger => { ledger.evidenceSet.sha256 = authoritySha })
  hasCode(await f.verify(), 'rejected-identities.source-kind')
}))

for (const [field, category] of [['messageId', 'messageIds'], ['nonce', 'messageNonces'], ['decisionId', 'decisionIds'], ['decisionNonce', 'decisionNonces']]) {
  test('new target cannot reuse retired ' + field, () => fixture(async f => {
    await mutate(resolve(f.company, f.current.originals.finance.workspaceRelativePath), document => { document[field] = f.ledgerValue[category][0] })
    hasCode(await f.verify(), 'rejected-identities.reused')
  }))
}
test('retired IDs cannot be reused under another identity field', () => fixture(async f => {
  await mutate(resolve(f.company, f.current.originals.finance.workspaceRelativePath), document => { document.messageId = f.ledgerValue.decisionNonces[0] })
  hasCode(await f.verify(), 'rejected-identities.reused')
}))
test('visible misplaced or superseded v003 messages cannot be omitted from the ledger', () => fixture(async f => {
  const unexpected = { ...f.old.originals.finance.value, messageId: randomUUID(), nonce: randomUUID() }
  await write(f.company, 'published/pmo/v003/messages/superseded/unlisted.json', unexpected)
  hasCode(await f.verify(), 'rejected-identities.visible-unlisted')
}))
test('v004 target cannot apply a rejected v003 manifest', () => fixture(async f => {
  await mutate(resolve(f.company, f.current.acks.finance.workspaceRelativePath), ack => { ack.appliedManifest.revision = 'v003'; ack.appliedManifest.manifestPath = 'published/finance/v003/manifest.json' })
  hasCode(await f.verify(), 'ack.applied-manifest')
}))
test('v004 manifest base must remain v002, not the numeric predecessor', () => fixture(async f => {
  await mutate(resolve(f.company, 'published/finance/v004/manifest.json'), manifest => { manifest.baseRevision = 'v003' })
  hasCode(await f.verify(), 'manifest.identity')
}))
test('rejected v003 baseline cannot certify v004 publication', () => fixture(async f => {
  hasCode(await f.verify({ previousSnapshot: { ...f.old.snapshot, targetRevision: 'v003' } }), 'snapshot.revision')
}))
test('v004 baseline must pin the ledger as well as seven original files', () => fixture(async f => {
  const snapshot = { ...f.current.snapshot }; delete snapshot.rejectedIdentityLedgerSha256
  hasCode(await f.verify({ previousSnapshot: snapshot }), 'rejected-identities.baseline-pin-missing')
  hasCode(await f.verify({ previousSnapshot: { ...f.current.snapshot, files: f.current.snapshot.files.slice(1) } }), 'immutability.baseline-coverage')
}))
test('self-consistent v004 rewrites still fail the first captured byte baseline', () => fixture(async f => {
  await seed(f.company, 'v004')
  hasCode(await f.verify(), 'sha.mismatch')
}))
test('ledger bytes cannot be repinned by changing only a later audit input', () => fixture(async f => {
  await mutate(f.ledgerPath, ledger => { ledger.messageIds.reverse() })
  hasCode(await f.verify(), 'rejected-identities.baseline-pin-mismatch')
}))
test('rejected source cannot escape the ledger directory', () => fixture(async f => {
  await mutate(f.authorityPath, authority => { authority.sources[0].path = '../company/published/pmo/v003/decisions.json' })
  const authoritySha = sha(await readFile(f.authorityPath))
  await mutate(f.ledgerPath, ledger => { ledger.evidenceSet.sha256 = authoritySha })
  hasCode(await f.verify(), 'rejected-identities.path-escape')
}))
test('identity sources are rechecked at the end of an audit', () => fixture(async f => {
  const loaded = await loadRejectedIdentityLedger({ ledgerPath: f.ledgerPath, companyRoot: f.company })
  await mutate(f.ledgerPath, ledger => { ledger.messageIds.reverse() })
  await assert.rejects(loaded.revalidate(), error => error.code === 'rejected-identities.changed-during-audit')
}))
test('ledger directory must not be an ancestor of the business workspace', () => fixture(async f => {
  const copiedLedger = resolve(f.base, 'ledger.json'); await copyFile(f.ledgerPath, copiedLedger)
  hasCode(await f.verify({ rejectedIdentityLedger: copiedLedger }), 'rejected-identities.location')
}))
test('a previously absent rejected-message directory cannot appear during audit unnoticed', () => fixture(async f => {
  const loaded = await loadRejectedIdentityLedger({ ledgerPath: f.ledgerPath, companyRoot: f.company })
  await write(f.company, 'published/pmo/v003/messages/new.json', { ...f.old.originals.finance.value, messageId: randomUUID() })
  await assert.rejects(loaded.revalidate(), error => error.code === 'rejected-identities.directory-changed')
}))
test('a previously absent rejected decision cannot appear after identity collection unnoticed', () => fixture(async f => {
  const path = resolve(f.company, 'published/pmo/v003/decisions.json'), original = await read(path)
  await unlink(path)
  const loaded = await loadRejectedIdentityLedger({ ledgerPath: f.ledgerPath, companyRoot: f.company })
  await write(f.company, path, original)
  await assert.rejects(loaded.revalidate(), error => error.code === 'rejected-identities.directory-changed')
}))
test('new members in an existing superseded directory invalidate the observed set', () => fixture(async f => {
  await write(f.company, 'published/pmo/v003/messages/superseded/known.json', f.old.originals.finance.value)
  const loaded = await loadRejectedIdentityLedger({ ledgerPath: f.ledgerPath, companyRoot: f.company })
  await write(f.company, 'published/pmo/v003/messages/superseded/unlisted.json', { ...f.old.originals.finance.value, messageId: randomUUID() })
  await assert.rejects(loaded.revalidate(), error => error.code === 'rejected-identities.directory-changed')
}))
test('nested linked directories cannot be silently skipped as covered', t => fixture(async f => {
  const messages = resolve(f.company, 'published/pmo/v003/messages'), privateDirectory = resolve(f.company, 'private')
  await mkdir(messages, { recursive: true }); await mkdir(privateDirectory)
  try { await symlink(privateDirectory, resolve(messages, 'linked'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory link capability is unavailable: ' + error.code); return } throw error }
  hasCode(await f.verify(), 'rejected-identities.directory-link')
}))
test('unsupported target, source and base configurations fail closed', () => fixture(async f => {
  for (const options of [{ targetRevision: 'v005' }, { sourceRevision: 'v003' }, { baseRevision: 'v003' }, { targetRevision: 'v003' }]) {
    await assert.rejects(f.verify(options), /supported|v002|explicitly selected v004/)
  }
}))
