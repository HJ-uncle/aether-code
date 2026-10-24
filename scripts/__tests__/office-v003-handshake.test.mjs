/** Synthetic local evidence graphs, never the six live company workspaces. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfficeV003Handshake } from '../verify-office-v003-handshake.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = resolve(repository, '.e2e-tmp')
const roles = ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance'], recipients = roles.filter(r => r !== 'pmo')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function write(root, path, value) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
  await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), bytes)
  return { workspaceRelativePath: path, sha256: sha(bytes), bytes: bytes.length }
}
const read = async (root, path) => JSON.parse(await readFile(resolve(root, path), 'utf8'))
async function seed(root, note = 'first frozen decision', options = {}) {
  const manifest = {}, artifacts = {}, originals = {}, acks = {}, pinned = []
  for (const role of roles) for (const revision of ['v002', 'v003']) {
    artifacts[role + '/' + revision] = await write(root, `published/${role}/${revision}/sample.csv`, 'id,role,revision\n1,' + role + ',' + revision + '\n')
    const value = { schemaVersion: 1, role, revision,
      baseRevision: revision === 'v002' ? 'v001' : 'v002', artifacts: [{ path: 'sample.csv', sha256: artifacts[role + '/' + revision].sha256, bytes: artifacts[role + '/' + revision].bytes }] }
    if (revision === 'v002') options.historical?.(value, role)
    manifest[role + '/' + revision] = await write(root, `published/${role}/${revision}/manifest.json`, value)
  }
  const decisionId = randomUUID(), decisionNonce = randomUUID()
  const decision = await write(root, 'published/pmo/v003/decisions.json', { schemaVersion: 1, revision: 'v003', baseRevision: 'v002', status: 'approved',
    decisionId, decisionNonce, note, sourceRevisions: roles.map(role => ({ role, revision: 'v002', manifestPath: manifest[role + '/v002'].workspaceRelativePath, manifestSha256: manifest[role + '/v002'].sha256 })),
    conflicts: [{ id: 'synthetic-budget-choice', proposals: ['sales', 'operations'].map(role => ({ role, revision: 'v002', amount: 1,
      evidence: [{ path: 'sample.csv', sha256: artifacts[role + '/v002'].sha256 }] })) }] })
  const pmoManifest = await read(root, 'published/pmo/v003/manifest.json')
  pmoManifest.artifacts.push({ path: 'decisions.json', sha256: decision.sha256, bytes: decision.bytes })
  manifest['pmo/v003'] = await write(root, 'published/pmo/v003/manifest.json', pmoManifest)
  pinned.push(decision, manifest['pmo/v003'])
  for (const role of recipients) {
    const value = { schemaVersion: 1, messageId: randomUUID(), createdAt: new Date().toISOString(), fromRole: 'pmo', toRole: role, kind: 'decision',
      revision: 'v003', baseRevision: 'v002', correlationId: randomUUID(), requiresAck: true, claims: [], evidence: [{ path: 'decisions.json', sha256: decision.sha256 }],
      nonce: randomUUID(), decisionId, decisionNonce, decisionSha256: decision.sha256, pmoManifestSha256: manifest['pmo/v003'].sha256,
      receiverBaseRevision: 'v002', receiverBaseManifestSha256: manifest[role + '/v002'].sha256 }
    originals[role] = { ...await write(root, `published/pmo/messages/to-${role}.json`, value), value }; pinned.push(originals[role])
    const ack = { schemaVersion: 1, messageId: randomUUID(), createdAt: new Date().toISOString(), fromRole: role, toRole: 'pmo', kind: 'ack',
      revision: 'v003', baseRevision: 'v002', ackOf: value.messageId, ackOfSha256: originals[role].sha256, observedRevision: 'v003', correlationId: value.correlationId,
      decision: 'accepted', requiresAck: false, reason: 'Synthetic evidence graph only', nonce: value.nonce, decisionId, decisionNonce,
      decisionSha256: decision.sha256, pmoManifestSha256: value.pmoManifestSha256, receiverBaseManifestSha256: value.receiverBaseManifestSha256,
      appliedManifest: { role, revision: 'v003', manifestPath: manifest[role + '/v003'].workspaceRelativePath, manifestSha256: manifest[role + '/v003'].sha256 },
      appliedArtifactReferences: [{ path: 'sample.csv', sha256: artifacts[role + '/v003'].sha256 }] }
    acks[role] = { ...await write(root, `published/${role}/messages/ack.json`, ack), value: ack }
  }
  const acknowledgements = recipients.map(role => ({ role, messageId: originals[role].value.messageId, nonce: originals[role].value.nonce,
    messageSha256: originals[role].sha256, ackPath: acks[role].workspaceRelativePath, ackSha256: acks[role].sha256,
    appliedManifest: acks[role].value.appliedManifest, appliedArtifacts: [{ workspaceRelativePath: artifacts[role + '/v003'].workspaceRelativePath, sha256: artifacts[role + '/v003'].sha256 }] }))
  const common = { schemaVersion: 1, closureId: randomUUID(), createdAt: new Date().toISOString(), subjectRevision: 'v003', status: 'complete',
    decisionId, decisionNonce, decisionSha256: decision.sha256, pmoManifestSha256: manifest['pmo/v003'].sha256, acknowledgements,
    checks: [{ id: 'synthetic-graph-reference', status: 'passed', evidence: [{ workspaceRelativePath: decision.workspaceRelativePath, sha256: decision.sha256 }] }], unresolvedIssues: [] }
  const pmoClosure = await write(root, 'published/pmo/closures/v003/closure.json', { ...common, authorRole: 'pmo' })
  await write(root, 'published/compliance/closures/v003/closure.json', { ...common, closureId: randomUUID(), authorRole: 'compliance', pmoClosure: { workspaceRelativePath: pmoClosure.workspaceRelativePath, sha256: pmoClosure.sha256 } })
  return { snapshot: { files: pinned.map(({ workspaceRelativePath, sha256 }) => ({ workspaceRelativePath, sha256 })) } }
}

async function fixture(run, options) {
  await mkdir(fixtures, { recursive: true }); const root = await mkdtemp(resolve(fixtures, 'v003-handshake-'))
  try { const data = await seed(root, undefined, options); await run(root, data) }
  finally {
    // Only this uniquely created fixture can be removed, never a live campaign.
    const actual = await realpath(root), base = await realpath(fixtures), rel = relative(base, actual)
    assert.ok(!isAbsolute(rel) && !rel.startsWith('..') && /^v003-handshake-[^\\/]+$/.test(rel))
    await rm(actual, { recursive: true, force: true })
  }
}
async function mutate(root, path, action) { const value = await read(root, path); action(value); await write(root, path, value) }
const verify = (root, snapshot) => verifyOfficeV003Handshake({ companyRoot: root, previousSnapshot: snapshot })
function rejected(result, code) { assert.equal(result.status, 'failed'); assert.equal(result.passed, false); assert.ok(result.checks.some(c => c.code === code), JSON.stringify(result.checks)) }

test('complete synthetic evidence graph passes with all five receivers and both closures', () => fixture(async (root, { snapshot }) => {
  const result = await verify(root, snapshot); assert.equal(result.status, 'passed', JSON.stringify(result.checks)); assert.equal(result.counts.acceptedRecipients, 5); assert.equal(result.counts.verifiedClosures, 2)
}))
test('unpublished receiver remains incomplete, never pass', () => fixture(async (root, { snapshot }) => {
  await unlink(resolve(root, 'published/people/v003/manifest.json')); const result = await verify(root, snapshot)
  assert.equal(result.status, 'incomplete'); assert.equal(result.passed, false)
}))
test('cross-recipient ACK is rejected', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/finance/messages/ack.json', ack => { ack.fromRole = 'sales' }); rejected(await verify(root, snapshot), 'message.sender')
}))
test('stale decision SHA is rejected', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/finance/messages/ack.json', ack => { ack.decisionSha256 = '0'.repeat(64) }); rejected(await verify(root, snapshot), 'ack.stale-sha')
}))
test('accepted ACK from an old sender revision is rejected', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/finance/messages/ack.json', ack => { ack.revision = 'v002'; ack.baseRevision = 'v001' }); rejected(await verify(root, snapshot), 'ack.sender-revision')
}))
test('wrong nonce is rejected', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/finance/messages/ack.json', ack => { ack.nonce = randomUUID() }); rejected(await verify(root, snapshot), 'ack.nonce-or-message-sha')
}))
test('retry cannot retain identity while changing body', () => fixture(async (root, { snapshot }) => {
  const request = await read(root, 'published/pmo/messages/to-finance.json'); request.claims = [{ changed: true }]
  await write(root, 'published/pmo/messages/retry.json', request); rejected(await verify(root, snapshot), 'message.retry-changed-body')
}))
test('empty ACK application list is rejected', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/finance/messages/ack.json', ack => { ack.appliedArtifactReferences = [] }); rejected(await verify(root, snapshot), 'ack.empty-application')
}))
test('self-consistent replacement of an already published graph fails prior byte pinning', () => fixture(async (root, { snapshot }) => {
  await seed(root, 'same paths, changed published decision'); const result = await verify(root, snapshot)
  rejected(result, 'sha.mismatch'); assert.ok(result.checks.some(c => c.id === 'immutability.prior-published-bytes' && c.status === 'failed'))
}))
test('recipient nonce reuse is rejected', () => fixture(async (root, { snapshot }) => {
  const first = await read(root, 'published/pmo/messages/to-finance.json')
  await mutate(root, 'published/pmo/messages/to-people.json', message => { message.nonce = first.nonce }); rejected(await verify(root, snapshot), 'nonce.invalid-or-reused')
}))
test('closure cannot bind an old decision SHA', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/pmo/closures/v003/closure.json', closure => { closure.decisionSha256 = 'f'.repeat(64) }); rejected(await verify(root, snapshot), 'closure.stale-decision')
}))
test('explicit incomplete closure is not pass', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/pmo/closures/v003/closure.json', closure => { closure.status = 'incomplete' }); const result = await verify(root, snapshot)
  assert.equal(result.status, 'incomplete'); assert.equal(result.passed, false)
}))
test('missing independent publication baseline is incomplete', () => fixture(async root => {
  const result = await verify(root, undefined); assert.equal(result.status, 'incomplete'); assert.ok(result.checks.some(c => c.code === 'immutability.baseline-missing'))
}))
test('application reference cannot escape its role directory', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/finance/messages/ack.json', ack => { ack.appliedArtifactReferences[0].path = '../people/v003/sample.csv' }); rejected(await verify(root, snapshot), 'path.escape')
}))
test('closure needs actual evidence for its passed checks', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/pmo/closures/v003/closure.json', closure => { closure.checks[0].evidence = [] }); rejected(await verify(root, snapshot), 'closure.empty-check')
}))
test('unmatched v003 ACK cannot be hidden beside valid receipts', () => fixture(async (root, { snapshot }) => {
  const ack = await read(root, 'published/finance/messages/ack.json'); ack.messageId = randomUUID(); ack.ackOf = 'unrelated-old-decision'
  await write(root, 'published/finance/messages/replayed.json', ack); rejected(await verify(root, snapshot), 'ack.unknown-original')
}))
test('closure cannot cite another role private evidence as its own review', () => fixture(async (root, { snapshot }) => {
  const proof = await write(root, 'finance/private.csv', 'private,synthetic\n1,2\n')
  await mutate(root, 'published/compliance/closures/v003/closure.json', closure => { closure.checks[0].evidence = [proof] })
  rejected(await verify(root, snapshot), 'closure.evidence-owner')
}))
test('separate cross-department v002 handoff ACK does not impersonate a PMO decision ACK', () => fixture(async (root, { snapshot }) => {
  await write(root, 'published/sales/messages/other-handoff-ack.json', { schemaVersion: 1, messageId: randomUUID(), fromRole: 'sales', toRole: 'operations',
    kind: 'ack', revision: 'v003', baseRevision: 'v002', observedRevision: 'v002', ackOf: 'separate-operations-v002-handoff', decision: 'accepted' })
  assert.equal((await verify(root, snapshot)).status, 'passed')
}))

test('historical schemas and broken declarations remain visible without certifying old artifacts', () => fixture(async (root, { snapshot }) => {
  const result = await verify(root, snapshot)
  assert.equal(result.status, 'passed', JSON.stringify(result.checks))
  assert.equal(result.historicalAcceptance, 'not-validated')
  assert.equal(result.historicalInputs.length, 6)
  assert.ok(result.historicalInputs.every(input => input.historicalAcceptance === 'not-validated'))
  assert.equal(result.legacyFindings.filter(item => item.code === 'legacy.schema-version').length, 5)
  assert.ok(result.legacyFindings.some(item => item.role === 'sales' && item.code === 'legacy.file.missing'))
  assert.ok(result.legacyFindings.some(item => item.role === 'people' && item.code === 'legacy.artifact.scope'))
  assert.ok(result.legacyFindings.some(item => item.role === 'pmo' && item.code === 'legacy.file.missing'))
  assert.ok(result.checks.some(item => item.id === 'history.sales.v002.identity-bytes' && item.status === 'passed'))
  assert.ok(!result.checks.some(item => item.id === 'manifest.sales.v002'))
  assert.equal((await read(root, 'published/compliance/v002/manifest.json')).schemaVersion, '2.0.0')
}, { historical: (m, role) => {
  if (role !== 'operations') m.schemaVersion = role === 'compliance' ? '2.0.0' : '1.0'
  if (role === 'sales') m.artifacts[0].scope = 'workspace'
  if (role === 'people') m.artifacts[0].scope = 'version'
  if (role === 'pmo') { m.artifacts[0].scope = 'workspace'; m.artifacts[0].path = 'pmo/deliverables/v002/sample.csv' }
} }))

for (const [field, value] of [['role', 'other-role'], ['revision', 'v001'], ['baseRevision', 'v000']]) {
  test('historical identity still rejects wrong ' + field, () => fixture(async (root, { snapshot }) => {
    await mutate(root, 'published/sales/v002/manifest.json', m => { m[field] = value })
    const result = await verify(root, snapshot); rejected(result, 'history.identity')
    assert.ok(result.checks.some(item => item.id === 'history.sales.v002.identity-bytes' && item.status === 'failed'))
  }))
}

for (const [path, code] of [
  ['published/people/v003/manifest.json', 'manifest.identity'],
  ['published/pmo/v003/decisions.json', 'decision.revision'],
  ['published/pmo/messages/to-finance.json', 'message.contract'],
  ['published/finance/messages/ack.json', 'ack.recipient'],
  ['published/pmo/closures/v003/closure.json', 'closure.identity'],
]) {
  test('new contract rejects string schemaVersion in ' + path, () => fixture(async (root, { snapshot }) => {
    await mutate(root, path, value => { value.schemaVersion = '1.0' })
    rejected(await verify(root, snapshot), code)
  }))
}

test('new manifest does not inherit historical scope aliases', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/people/v003/manifest.json', m => { m.artifacts[0].scope = 'version' })
  rejected(await verify(root, snapshot), 'artifact.scope')
}))

test('changed historical bytes cannot reuse the old source fingerprint', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/sales/v002/manifest.json', m => { m.legacyNote = 'changed after source pinning' })
  const result = await verify(root, snapshot); rejected(result, 'sha.mismatch')
  assert.ok(result.checks.some(item => item.id === 'decision.identity-and-sources' && item.code === 'sha.mismatch'))
}))

for (const [name, edit, code] of [
  ['wrong source SHA', ref => { ref.sha256 = '0'.repeat(64) }, 'sha.mismatch'],
  ['cross-role public path', ref => { ref.path = '../operations/v002/sample.csv' }, 'path.escape'],
  ['private workspace scope', ref => { ref.scope = 'workspace' }, 'decision.proposal-private'],
  ['unknown legacy scope', ref => { ref.scope = 'version' }, 'artifact.scope'],
]) {
  test('proposal evidence rejects ' + name, () => fixture(async (root, { snapshot }) => {
    await mutate(root, 'published/pmo/v003/decisions.json', d => { edit(d.conflicts[0].proposals[0].evidence[0]) })
    const result = await verify(root, snapshot); rejected(result, code)
    assert.ok(result.checks.some(item => item.id === 'decision.identity-and-sources' && item.code === code))
  }))
}

test('a same-basename public file never repairs a missing exact proposal path', () => fixture(async (root, { snapshot }) => {
  await mutate(root, 'published/pmo/v003/decisions.json', d => { d.conflicts[0].proposals[0].evidence[0].path = 'missing/sample.csv' })
  const result = await verify(root, snapshot)
  assert.equal(result.passed, false)
  assert.ok(result.checks.some(item => item.id === 'decision.identity-and-sources' && item.status === 'incomplete' && item.code === 'file.missing'))
}))

test('legacy artifact mismatch does not excuse a changed file actually cited by the decision', () => fixture(async (root, { snapshot }) => {
  await write(root, 'published/sales/v002/sample.csv', 'changed source content\n')
  const result = await verify(root, snapshot); rejected(result, 'sha.mismatch')
  assert.ok(result.legacyFindings.some(item => item.role === 'sales' && item.code === 'legacy.sha.mismatch'))
  assert.ok(result.checks.some(item => item.id === 'decision.identity-and-sources' && item.code === 'sha.mismatch'))
}))

for (const [name, edit, code] of [
  ['old source revision', d => { d.conflicts[0].proposals[0].revision = 'v001' }, 'decision.proposal-identity'],
  ['unknown source role', d => { d.conflicts[0].proposals[0].role = 'outsider' }, 'decision.proposal-identity'],
  ['two copies of one source role', d => { d.conflicts[0].proposals[1].role = 'sales' }, 'decision.proposal-roles'],
  ['empty source evidence', d => { d.conflicts[0].proposals[0].evidence = [] }, 'decision.proposal-evidence'],
  ['missing conflict proposals', d => { d.conflicts = [] }, 'decision.proposals-missing'],
]) {
  test('decision rejects ' + name, () => fixture(async (root, { snapshot }) => {
    await mutate(root, 'published/pmo/v003/decisions.json', edit)
    const result = await verify(root, snapshot); rejected(result, code)
    assert.ok(result.checks.some(item => item.id === 'decision.identity-and-sources' && item.code === code))
  }))
}
