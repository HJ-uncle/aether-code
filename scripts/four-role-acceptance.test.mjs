/** Offline role/dispatch guards: never launches Electron or reads model credentials. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ROLE_MODES, bindRoleSession, roleNeedsConfiguration, parseArguments, retryIntent } from './four-role-acceptance.mjs'

const roles = () => Object.fromEntries(Object.entries(ROLE_MODES).map(([role, mode]) => [role, { mode, submissions: [] }]))

test('four distinct role identities remain stable across same-mode sessions', () => {
  const owners = roles()
  assert.deepEqual(Object.values(ROLE_MODES), ['work', 'work', 'code', 'code'])
  for (const role of Object.keys(owners)) bindRoleSession(owners, role, role + '-session')
  assert.equal(new Set(Object.values(owners).map(owner => owner.sessionId)).size, 4)
  assert.throws(() => bindRoleSession(owners, 'qa', 'development-session'), /already owned/)
  assert.throws(() => bindRoleSession(owners, 'product', 'replacement'), /replace/)
  assert.throws(() => bindRoleSession(owners, 'unknown', 'new'), /Unknown role/)
  assert.throws(() => bindRoleSession(owners, 'qa', 'bad"]'), /Invalid role session/)
  assert.equal(bindRoleSession(owners, 'qa', 'qa-session'), 'qa-session')
})

test('CLI is fresh-round only and preserves explicit isolated build inputs', () => {
  assert.deepEqual(parseArguments(['--start', '--root', 'D:/test', '--round', '2', '--app-entry', 'app.js', '--engine-entry', 'main.js']),
    { start: true, root: 'D:/test', round: '2', 'app-entry': 'app.js', 'engine-entry': 'main.js' })
  for (const args of [['--start', '--check'], ['--resume'], ['--root'], ['--unknown', 'x']]) assert.throws(() => parseArguments(args))
})

test('a session created before preference failure resumes configuration in place', () => {
  const owners = roles()
  assert.equal(roleNeedsConfiguration(owners.development), true)
  bindRoleSession(owners, 'development', 'original-session')
  owners.development.configuration = { phase: 'permission' }
  assert.equal(roleNeedsConfiguration(owners.development), true)
  assert.equal(bindRoleSession(owners, 'development', 'original-session'), 'original-session')
  assert.throws(() => bindRoleSession(owners, 'development', 'replacement'), /replace/)
  owners.development.configuredAt = Date.now()
  assert.equal(roleNeedsConfiguration(owners.development), false)
})

test('retry cannot target another session, stale run, or active execution', () => {
  const owner = { sessionId: 'qa-session' }, input = { id: 'retry-1', role: 'qa', expected: { sessionId: 'qa-session', runId: 'run', turnId: 'turn' }, target: { userMessageId: 'message', turnId: 'turn' } }
  const before = { running: false, run: { ...input.expected, status: 'failed' } }
  assert.equal(retryIntent(input, owner, before).role, 'qa')
  assert.throws(() => retryIntent(input, { sessionId: 'development-session' }, before), /session differs/)
  assert.throws(() => retryIntent(input, owner, { ...before, run: { ...before.run, runId: 'new-run' } }), /run changed/)
  for (const status of ['running', 'waiting', 'preparing', 'cancelling', 'unknown']) assert.throws(() => retryIntent(input, owner, { running: false, run: { ...before.run, status } }), /Cannot retry/)
})
