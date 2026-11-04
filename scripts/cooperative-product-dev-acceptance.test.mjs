/** Controller safety preflight only. Never launches Electron or reads model credentials. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkedResume, parseArguments, retryIntent } from './cooperative-product-dev-acceptance.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(repo, '.e2e-tmp')
const sha = value => createHash('sha256').update(value).digest('hex')

function fixture() {
  mkdirSync(fixtures, { recursive: true })
  const campaign = mkdtempSync(join(fixtures, 'cooperative-controller-'))
  const root = join(campaign, 'round-1'), workspace = join(root, 'workspace'), profile = join(root, 'profile')
  const evidence = join(campaign, 'evidence', 'round-1'), engine = join(campaign, 'build', 'engine'), app = join(campaign, 'build', 'app')
  for (const path of [workspace, profile, evidence, app, join(engine, 'runtime')]) mkdirSync(path, { recursive: true })
  const appEntry = join(app, 'index.js'), engineEntry = join(engine, 'main.js')
  writeFileSync(appEntry, 'throw new Error("fixture must never launch")')
  writeFileSync(engineEntry, 'throw new Error("fixture must never launch")')
  const manifest = { buildId: 'sha256:' + '1'.repeat(64) }
  writeFileSync(join(engine, 'runtime', 'build-manifest.json'), JSON.stringify(manifest))
  const state = { schemaVersion: 1, root, campaign, round: 1, workspace, profile, evidence,
    builds: { appEntry, engineEntry, appSha256: sha(readFileSync(appEntry)), engineSha256: sha(readFileSync(engineEntry)), manifest },
    modelId: 'saved-only-model', modelRecordId: 'saved-record', startedAt: '2026-01-01T00:00:00.000Z', phase: 'closed',
    roles: { product: { mode: 'work', sessionId: 'work-session', submissions: [{ id: 'old', at: 10 }] }, development: { mode: 'code', sessionId: 'code-session', submissions: [] } },
    engine: { mode: 'embedded', instanceId: 'old-instance', accountId: 'saved-account', buildId: manifest.buildId }, errors: [] }
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', lastFolder: workspace, lastSessionId: 'pre-account-session' }))
  const observation = { at: 100, engine: state.engine, roles: Object.fromEntries(Object.entries(state.roles).map(([role, owner]) => [role, {
    ...owner, status: { running: false, run: { sessionId: owner.sessionId, runId: role + '-run', turnId: role + '-turn', status: 'succeeded' } }
  }])) }
  writeFileSync(join(evidence, 'status.jsonl'), JSON.stringify(observation) + '\n')
  const save = () => writeFileSync(join(root, 'state.json'), JSON.stringify(state, null, 2))
  save()
  return { state, observation, save, options: { root: campaign, round: '1', 'resume-inspection': true }, cleanup: () => {
    const target = resolve(campaign), parent = resolve(fixtures)
    assert.ok(target.startsWith(parent + sep) && target !== parent, 'Fixture cleanup must stay within .e2e-tmp')
    rmSync(target, { recursive: true, force: true })
  } }
}

function treeDigest(root) {
  const files = []
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else files.push([path, sha(readFileSync(path))])
  } }
  walk(root)
  return files
}

test('resume CLI modes require explicit intent and reject ambiguous flags', () => {
  assert.deepEqual(parseArguments(['--check', '--resume-inspection', '--round', '1']), { check: true, 'resume-inspection': true, round: '1' })
  assert.equal(parseArguments(['--start', '--resume-inspection', '--allow-model-actions'])['allow-model-actions'], true)
  assert.equal(parseArguments(['--start', '--resume']).resume, true)
  assert.throws(() => parseArguments(['--start', '--check']), /Choose/)
  assert.throws(() => parseArguments(['--resume', '--resume-inspection']), /Choose/)
  assert.throws(() => parseArguments(['--allow-model-actions']), /requires/)
})

test('closed round preflight reads saved identity/builds without changing any saved byte', () => {
  const data = fixture()
  try {
    const before = treeDigest(data.state.campaign), checked = checkedResume(data.options)
    assert.equal(checked.original.startedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(checked.original.modelId, 'saved-only-model')
    assert.deepEqual(checked.original.roles, data.state.roles)
    assert.deepEqual(treeDigest(data.state.campaign), before)
    assert.equal(existsSync(join(data.state.root, 'inspections')), false)
  } finally { data.cleanup() }
})

test('resume rejects active/unknown roots and observations older than the last send', () => {
  const data = fixture()
  try {
    data.state.phase = 'ready'; data.save()
    assert.throws(() => checkedResume(data.options), /Close the old controller/)
    data.state.phase = 'closed'; data.state.finalStatus = structuredClone(data.observation)
    data.state.finalStatus.roles.product.status.run.status = 'running'; data.save()
    assert.throws(() => checkedResume(data.options), /must be observed terminal/)
    data.state.finalStatus.roles.product.status.run.status = 'unknown'; data.save()
    assert.throws(() => checkedResume(data.options), /must be observed terminal/)
    delete data.state.finalStatus; data.state.roles.product.submissions[0].at = 200; data.save()
    assert.throws(() => checkedResume(data.options), /predates/)
  } finally { data.cleanup() }
})

test('resume rejects modified builds, manifest, identity and profile paths', () => {
  const data = fixture()
  try {
    assert.throws(() => checkedResume({ ...data.options, 'model-db': 'must-not-open.sqlite' }), /saved model/)
    assert.throws(() => checkedResume({ ...data.options, 'app-entry': join(data.state.campaign, 'different.js') }), /original build paths/)
    writeFileSync(data.state.builds.appEntry, 'changed')
    assert.throws(() => checkedResume(data.options), /Client entry changed/)
    writeFileSync(data.state.builds.appEntry, 'throw new Error("fixture must never launch")')
    const manifestFile = join(dirname(data.state.builds.engineEntry), 'runtime', 'build-manifest.json')
    writeFileSync(manifestFile, JSON.stringify({ buildId: 'sha256:' + '2'.repeat(64) }))
    assert.throws(() => checkedResume(data.options), /manifest changed/)
    writeFileSync(manifestFile, JSON.stringify(data.state.builds.manifest))
    data.state.profile = join(data.state.campaign, 'different-profile'); data.save()
    assert.throws(() => checkedResume(data.options), /Saved profile/)
  } finally { data.cleanup() }
})

test('retry preflight rejects stale identity and every active/unknown root status', () => {
  const owner = { sessionId: 'session' }, input = { id: 'retry-1', role: 'product',
    expected: { sessionId: 'session', runId: 'run-before', turnId: 'turn-before' }, target: { userMessageId: 'user-target', turnId: 'target-turn' } }
  const before = { running: false, run: { ...input.expected, status: 'cancelled' } }
  assert.deepEqual(retryIntent(input, owner, before), { role: 'product', expected: input.expected, target: input.target })
  for (const status of ['preparing', 'running', 'waiting', 'cancelling', 'unknown']) {
    assert.throws(() => retryIntent(input, owner, { ...before, run: { ...before.run, status } }), /Cannot retry/)
  }
  assert.throws(() => retryIntent(input, owner, { ...before, running: true }), /Cannot retry/)
  assert.throws(() => retryIntent(input, owner, { ...before, run: { ...before.run, runId: 'new-run' } }), /root run changed/)
  assert.throws(() => retryIntent({ ...input, target: { ...input.target, userMessageId: 'bad"] selector' } }, owner, before), /userMessageId required/)
})
