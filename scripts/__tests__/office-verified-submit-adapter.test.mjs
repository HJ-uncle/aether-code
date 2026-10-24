/** Current UI binding contract + legacy runner bridge + bounded entry VM; no live I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { effectiveOfficePrompt, OFFICE_SUBMIT_FOOTER, validateActiveWorkSnapshot, bridgeVerifiedAdmission, readActiveWorkSnapshot,
  reconcileVerifiedAdmissionProjection, activateVerifiedOfficeRoutes, installOfficeVerifiedSubmit, createVerifiedOfficeRoutes } from '../office-verified-submit-adapter.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const target = { sessionId: 'work-one', agentId: 'agent-one', modelId: 'model-one', workspacePath: path.resolve('.e2e-tmp'), engine: { accountId: 'account-one' } };
function snapshot() {
  const task = { id: target.sessionId, title: 'Owned task', agentId: target.agentId, modelId: target.modelId, workspacePath: target.workspacePath, archived: false };
  return { workVisible: true, editorCount: 1, currentRows: ['Owned task'], storageKey: 'aether.work.state.v1:' + encodeURIComponent(':account:account-one'),
    activeTaskId: target.sessionId, tasks: [task], controller: { task: structuredClone(task), home: false,
      draftSource: ':account:account-one', modelId: target.modelId, ready: true, modelReady: true, error: null,
      loading: false, streaming: false, launching: false, uploading: false, historyReady: true, pendingCount: 0,
      attachments: 0, mentions: 0, queueReady: true, queueSaving: false, queueDispatchError: null } };
}
test('footer is added once and raw versus effective hashes remain distinguishable', () => {
  const first = effectiveOfficePrompt('Exact task'); assert.equal(first.text, 'Exact task' + OFFICE_SUBMIT_FOOTER);
  assert.notEqual(first.rawSha256, first.effectiveSha256);
  const second = effectiveOfficePrompt(first.text); assert.equal(second.text, first.text); assert.equal(second.footerAppended, false);
  assert.throws(() => effectiveOfficePrompt(first.text + OFFICE_SUBMIT_FOOTER), /AMBIGUOUS/);
});
test('a valid actual controller and scoped persistent selection agree', () => {
  assert.equal(validateActiveWorkSnapshot(snapshot(), target, { idle: true }).id, target.sessionId);
});
for (const [name, mutate, code] of [
  ['background task only', value => { value.activeTaskId = 'another'; }, 'DOM'],
  ['stale composer controller', value => { value.controller.task.id = 'another'; }, 'CONTROLLER'],
  ['different account', value => { value.controller.draftSource = ':account:other'; }, 'SOURCE'],
  ['different model control', value => { value.controller.modelId = 'other'; }, 'SELECTION'],
  ['actual queue error', value => { value.controller.queueDispatchError = 'queue failure'; }, 'IDLE'],
  ['model still recovering', value => { value.controller.modelReady = false; }, 'SELECTION'],
  ['second visible composer', value => { value.editorCount = 2; }, 'DOM'],
]) test('rejects ' + name, () => { const value = snapshot(); mutate(value); assert.throws(() => validateActiveWorkSnapshot(value, target, { idle: true }), new RegExp(code)); });

test('legacy command loop cannot treat uncertain admission as completed', () => {
  let saves = 0; const c = { state: { roles: { pmo: { submissions: [] } } }, save: () => saves++ };
  const journal = { lease: { held: true } };
  assert.throws(() => bridgeVerifiedAdmission(c, journal, { admitted: false, code: 'HISTORY_NOT_PROJECTED' }), /UNCERTAIN/);
  assert.equal(journal.lease.held, true); assert.equal(saves, 0); assert.deepEqual(c.state.roles.pmo.submissions, []);
});
test('only a verified publication bridges into legacy role records, idempotently', () => {
  let saves = 0; const c = { state: { roles: { pmo: { submissions: [] } } }, save: () => saves++ };
  const text = JSON.stringify({ commandId: 'test', role: 'pmo', actualAdmittedRun: { runId: 'root-one' } });
  const journal = { submissions: [{ id: 'test', role: 'pmo', phase: 'admitted', bindingPublication: { text, sha256: sha(text) } }] };
  const result = { admitted: true, commandId: 'test', runId: 'root-one', binding: { path: 'synthetic.json' } };
  bridgeVerifiedAdmission(c, journal, result); bridgeVerifiedAdmission(c, journal, result);
  assert.equal(c.state.roles.pmo.submissions.length, 1); assert.equal(saves, 2);
  assert.equal(c.state.roles.pmo.submissions[0].actualAdmittedRun.runId, 'root-one');
  c.state.roles.pmo.submissions[0].runId = 'wrong';
  assert.throws(() => bridgeVerifiedAdmission(c, journal, result), /PROJECTION/);
});

test('bounded renderer VM reads actual composer props and maps the real queue error field', () => {
  const value = snapshot(); const controller = { activeTask: value.controller.task, draftSource: value.controller.draftSource,
    modelId: target.modelId, ready: true, modelReady: true, pending: [], attachments: [], mentions: [], nextTurnQueue: { ready: true, saving: false, error: 'real-error' } };
  const visible = { getClientRects: () => [{}] };
  const editor = { ...visible, innerText: 'draft', '__reactFiber$fixture': { memoizedProps: {}, return: { memoizedProps: { controller, home: false }, return: null } } };
  const row = { ...visible, getAttribute: () => 'Owned task' };
  const surface = { ...visible, getAttribute: () => 'false', querySelectorAll: selector => selector.includes('input-composer') ? [editor] : selector.includes('aria-current') ? [row] : [] };
  const context = vm.createContext({ document: { querySelector: () => surface }, localStorage: { getItem: () => JSON.stringify({ activeTaskId: target.sessionId, tasks: value.tasks }) },
    getComputedStyle: () => ({ visibility: 'visible' }), input: { storageKey: value.storageKey } });
  const observed = new vm.Script(`(${readActiveWorkSnapshot.toString()})(input)`).runInContext(context, { timeout: 1000 });
  assert.equal(observed.controller.task.id, target.sessionId); assert.equal(observed.controller.queueDispatchError, 'real-error');
  assert.equal(observed.editorCount, 1);
});

for (const [file, method] of [['observe-office-verified-submit-installation.mjs', 'observeOfficeVerifiedSubmitInstallation'], ['install-office-verified-submit.mjs', 'installOfficeVerifiedSubmit']])
  test('bounded entry VM routes ' + file + ' only when explicitly called', async () => {
    const calls = [], controller = {}; const source = fs.readFileSync(path.resolve('.e2e-tmp', file), 'utf8').replace('export async function recover', 'async function recover');
    const context = vm.createContext({ process: { getBuiltinModule: name => {
      assert.equal(name, 'node:module'); return { createRequire: () => requested => {
        assert.equal(requested, './office-verified-submit-adapter.mjs'); return { [method]: c => { assert.equal(c, controller); calls.push(method); return { ok: true }; } };
      } };
    } }, controller });
    new vm.Script(source).runInContext(context, { timeout: 1000 }); assert.deepEqual(calls, []);
    await new vm.Script('recover(controller)').runInContext(context, { timeout: 1000 }); assert.deepEqual(calls, [method]);
  });

test('query entry reports partial installation and projection ownership without performing I/O', async () => {
  const inspected = { active: false, pendingOperations: 0, lease: null, submissions: [], routeActive: false,
    projectionPending: 'saved-root', projectionReads: 1 };
  const controller = { state: {}, verifiedSubmitInstallation: { installed: false, status: 'installation-uncertain', errorCode: 'EIO', inspect: () => inspected } };
  const source = fs.readFileSync(path.resolve('.e2e-tmp/query-office-verified-submit.mjs'), 'utf8').replace('export async function recover', 'async function recover');
  const context = vm.createContext({ __officeCampaign: controller, controller, process: { pid: 9080,
    getBuiltinModule: name => { assert.equal(name, 'node:assert/strict'); return assert; } } });
  new vm.Script(source).runInContext(context, { timeout: 1000 });
  const result = await new vm.Script('recover(controller)').runInContext(context, { timeout: 1000 });
  assert.equal(result.installed, false); assert.equal(result.installationError, 'EIO');
  assert.equal(result.projectionPending, 'saved-root'); assert.equal(result.projectionReads, 1);
});

function temporaryDirectory(t) {
  const base = path.resolve('.e2e-tmp'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'verified-adapter-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(base + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function installationFixture(t, { failSaveAt = 0, missingParent = false } = {}) {
  const directory = temporaryDirectory(t), events = [];
  const journal = { schemaVersion: 1, submissions: [], lease: null };
  let saves = 0, observations = 0, oldCalls = 0, newCalls = 0;
  const oldSubmit = async () => { oldCalls++; }, submit = async () => { newCalls++; return 'new'; };
  const unsupported = async () => { throw new Error('unsupported-existing-campaign'); };
  const proof = { ready: true, engine: { instanceId: 'owned' }, expectedTargets: { pmo: { sessionId: 'owned-task' } } };
  const installation = { schemaVersion: 1, status: 'installed-awaiting-live-admission', proof, liveAdmissionVerified: false };
  const artifact = path.join(directory, ...(missingParent ? ['not-created'] : []), 'installation.json');
  const c = { state: { roles: {} }, submit: oldSubmit, createAndStart: oldSubmit,
    save() {
      saves++;
      // Neither save may expose an old or new callable submit before durability.
      assert.notEqual(c.submit, oldSubmit); assert.notEqual(c.submit, submit);
      assert.equal(c.createAndStart, unsupported);
      events.push({ kind: 'save', status: c.state.verifiedSubmitInstallation.status, evidenceExists: fs.existsSync(artifact) });
      if (saves === failSaveAt) throw new Error('injected-save-failure');
    } };
  const options = { journal, installation, artifact, submit, unsupported, reconcile: async () => 'reconciled', inspect: () => journal,
    coordinator: {}, reobserve: async () => { observations++; events.push({ kind: 'read-only-observation' }); return structuredClone(proof); } };
  return { c, options, artifact, events, counters: () => ({ saves, observations, oldCalls, newCalls }) };
}

test('intent save failure leaves routes blocked; explicit resume re-observes before activating', async t => {
  const f = installationFixture(t, { failSaveAt: 1 });
  assert.throws(() => activateVerifiedOfficeRoutes(f.c, f.options), /INSTALLATION_UNCERTAIN/);
  assert.equal(f.c.verifiedSubmitInstallation.status, 'installation-uncertain');
  assert.equal(fs.existsSync(f.artifact), false);
  await assert.rejects(f.c.submit('pmo', {}), /NOT_ACTIVE/);
  await assert.rejects(f.c.createAndStart('pmo', {}), /unsupported-existing-campaign/);
  await assert.rejects(f.c.verifiedSubmitInstallation.reconcile('task'), /NOT_ACTIVE/);
  const result = await f.c.verifiedSubmitInstallation.resumeInstallation();
  assert.equal(result.installed, true); assert.equal(f.c.state.verifiedSubmissionJournal, f.options.journal);
  assert.equal(f.c.state.verifiedSubmitInstallation.status, 'installed-awaiting-live-admission');
  assert.equal(await f.c.submit(), 'new');
  assert.deepEqual(f.counters(), { saves: 4, observations: 1, oldCalls: 0, newCalls: 1 });
  assert.equal(f.events.at(-1).evidenceExists, true);
  await assert.rejects(f.c.verifiedSubmitInstallation.resumeInstallation(), /RESUME_NOT_ALLOWED/);
});

test('evidence publication failure remains blocked until explicit repair and fresh observation', async t => {
  const f = installationFixture(t, { missingParent: true });
  assert.throws(() => activateVerifiedOfficeRoutes(f.c, f.options), /INSTALLATION_UNCERTAIN/);
  await assert.rejects(f.c.submit(), /NOT_ACTIVE/);
  assert.equal(f.c.state.verifiedSubmitInstallation.status, 'installation-uncertain');
  assert.equal(f.counters().oldCalls, 0); assert.equal(f.counters().newCalls, 0);
  fs.mkdirSync(path.dirname(f.artifact));
  const result = await f.c.verifiedSubmitInstallation.resumeInstallation();
  assert.equal(result.sha256, sha(fs.readFileSync(f.artifact)));
  assert.equal(f.counters().observations, 1);
});

test('final save failure keeps completed evidence immutable and restores routes only after resave', async t => {
  const f = installationFixture(t, { failSaveAt: 2 });
  assert.throws(() => activateVerifiedOfficeRoutes(f.c, f.options), /INSTALLATION_UNCERTAIN/);
  const bytes = fs.readFileSync(f.artifact), before = fs.statSync(f.artifact);
  await assert.rejects(f.c.submit(), /NOT_ACTIVE/);
  assert.equal(f.c.verifiedSubmitInstallation.installed, false);
  await f.c.verifiedSubmitInstallation.resumeInstallation();
  assert.deepEqual(fs.readFileSync(f.artifact), bytes);
  assert.equal(fs.statSync(f.artifact).mtimeMs, before.mtimeMs);
  assert.equal(f.counters().oldCalls, 0); assert.equal(f.counters().newCalls, 0);
  assert.equal(f.c.verifiedSubmitInstallation.installed, true);
});

test('resume rejects modified publication bytes and leaves the previous submit unreachable', async t => {
  const f = installationFixture(t, { failSaveAt: 2 });
  assert.throws(() => activateVerifiedOfficeRoutes(f.c, f.options), /INSTALLATION_UNCERTAIN/);
  const text = fs.readFileSync(f.artifact, 'utf8');
  fs.writeFileSync(f.artifact, text.replace('owned', 'wrong'));
  await assert.rejects(f.c.verifiedSubmitInstallation.resumeInstallation(), /PUBLICATION_BYTES_CHANGED/);
  await assert.rejects(f.c.submit(), /NOT_ACTIVE/);
  assert.equal(f.counters().oldCalls, 0); assert.equal(f.c.verifiedSubmitInstallation.installed, false);
});

test('resume rejects engine changes found by the fresh observation', async t => {
  const f = installationFixture(t, { failSaveAt: 1 });
  f.options.reobserve = async () => ({ ready: true, engine: { instanceId: 'changed' }, expectedTargets: f.options.installation.proof.expectedTargets });
  assert.throws(() => activateVerifiedOfficeRoutes(f.c, f.options), /INSTALLATION_UNCERTAIN/);
  await assert.rejects(f.c.verifiedSubmitInstallation.resumeInstallation(), /INSTALLATION_RESUME_ENGINE_CHANGED/);
  assert.equal(fs.existsSync(f.artifact), false); await assert.rejects(f.c.submit(), /NOT_ACTIVE/);
});

test('restart with a persisted installation refuses reconstruction and blocks legacy routes', async () => {
  let legacyCalls = 0;
  const c = { state: { verifiedSubmissionJournal: { submissions: [] } }, submit: async () => legacyCalls++, createAndStart: async () => legacyCalls++, log: () => {} };
  await assert.rejects(installOfficeVerifiedSubmit(c), /PERSISTED_INSTALLATION_REQUIRES_REVIEW/);
  await assert.rejects(c.submit(), /NOT_ACTIVE/); await assert.rejects(c.createAndStart(), /unsupported-existing-campaign/);
  assert.equal(legacyCalls, 0);
});

function projectionFixture(t) {
  const directory = temporaryDirectory(t), file = path.join(directory, 'verified-task.verified-binding.json');
  const targetValue = { ...target, newTask: false };
  const actualAdmittedRun = { runId: 'admitted-root', sessionId: target.sessionId };
  const record = { id: 'verified-task', role: 'pmo', phase: 'admitted', clickRequested: true, target: targetValue,
    runId: actualAdmittedRun.runId, actualAdmittedRun, promptSha256: sha('exact'), beforeRunId: 'old-root' };
  const text = JSON.stringify({ commandId: record.id, role: record.role, target: targetValue, actualAdmittedRun,
    promptSha256: record.promptSha256, beforeRunId: record.beforeRunId }) + '\n';
  record.bindingPublication = { text, bytes: Buffer.byteLength(text), sha256: sha(text) };
  record.binding = { path: file, bytes: Buffer.byteLength(text), sha256: sha(text) }; fs.writeFileSync(file, text);
  const journal = { submissions: [record], lease: null };
  let saves = 0, reads = 0;
  const c = { state: { roles: { pmo: { submissions: [] } } }, save: () => { saves++; } };
  const options = { evidenceDir: directory, readTarget: async role => { assert.equal(role, 'pmo'); reads++; return structuredClone(targetValue); } };
  return { c, journal, options, file, record, counters: () => ({ saves, reads }) };
}

test('admitted projection save failure can recover idempotently without another admission', async t => {
  const f = projectionFixture(t); let saves = 0;
  f.c.save = () => { if (++saves === 1) throw new Error('legacy-save-failure'); };
  await assert.rejects(reconcileVerifiedAdmissionProjection(f.c, f.journal, f.record.id, f.options), /legacy-save-failure/);
  assert.equal(f.c.state.roles.pmo.submissions.length, 1); assert.equal(f.journal.lease, null);
  const result = await reconcileVerifiedAdmissionProjection(f.c, f.journal, f.record.id, f.options);
  assert.equal(result.admitted, true); assert.equal(result.runId, 'admitted-root');
  assert.equal(f.c.state.roles.pmo.submissions.length, 1); assert.equal(saves, 2); assert.equal(f.counters().reads, 2);
});

for (const [name, mutation, code] of [
  ['changed active task', f => { f.options.readTarget = async () => ({ ...f.record.target, sessionId: 'different' }); }, 'PROJECTION_TARGET_CHANGED'],
  ['changed immutable bytes', f => { const text = fs.readFileSync(f.file, 'utf8'); fs.writeFileSync(f.file, text.replace('admitted-root', 'changed--root')); }, 'PUBLICATION_BYTES_CHANGED'],
  ['binding reference changed', f => { f.record.binding.sha256 = sha('wrong'); }, 'PROJECTION_BINDING_CHANGED'],
  ['another submission lease', f => { f.journal.lease = { commandId: 'other' }; }, 'PROJECTION_RECONCILIATION_NOT_ALLOWED'],
]) test('projection recovery refuses ' + name, async t => {
  const f = projectionFixture(t); mutation(f);
  await assert.rejects(reconcileVerifiedAdmissionProjection(f.c, f.journal, f.record.id, f.options), new RegExp(code));
  assert.equal(f.counters().saves, 0); assert.deepEqual(f.c.state.roles.pmo.submissions, []);
});

test('failed legacy projection blocks later submissions until a read-only reconciliation saves it', async t => {
  const f = projectionFixture(t); let submissions = 0, coreReconciliations = 0, saves = 0;
  f.c.save = () => { if (++saves <= 2) throw new Error('legacy-save-failure'); };
  const coordinator = { inspect: () => ({ active: false, pendingOperations: 0, lease: null }),
    submit: async () => { submissions++; return { admitted: true, commandId: f.record.id, runId: f.record.runId, binding: f.record.binding }; },
    reconcile: async () => { coreReconciliations++; throw new Error('must-not-reconcile-an-admitted-core'); } };
  const routes = createVerifiedOfficeRoutes({ c: f.c, journal: f.journal, coordinator, readTarget: f.options.readTarget,
    evidenceDir: f.options.evidenceDir, promptOrigins: new Map() });
  await assert.rejects(routes.submit('pmo', { id: f.record.id, prompt: 'first' }), /legacy-save-failure/);
  assert.equal(routes.inspect().projectionPending, f.record.id);
  await assert.rejects(routes.submit('pmo', { id: 'another', prompt: 'second' }), /PROJECTION_PENDING/);
  await assert.rejects(routes.reconcile('another'), /PROJECTION_PENDING/);
  await assert.rejects(routes.reconcile(f.record.id), /legacy-save-failure/);
  assert.equal(routes.inspect().projectionPending, f.record.id);
  await assert.rejects(routes.submit('pmo', { id: 'another', prompt: 'second' }), /PROJECTION_PENDING/);
  const result = await routes.reconcile(f.record.id);
  assert.equal(result.admitted, true); assert.equal(routes.inspect().projectionPending, null);
  assert.equal(submissions, 1); assert.equal(coreReconciliations, 0); assert.equal(f.c.state.roles.pmo.submissions.length, 1);
});

test('projection read timeout retains a pending operation and never replays a send', async t => {
  const f = projectionFixture(t); let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const coordinator = { inspect: () => ({ active: false, pendingOperations: 0, lease: null }),
    submit: async () => { throw new Error('must-not-send'); }, reconcile: async () => { throw new Error('must-not-core-reconcile'); } };
  const routes = createVerifiedOfficeRoutes({ c: f.c, journal: f.journal, coordinator, readTarget: () => held,
    evidenceDir: f.options.evidenceDir, promptOrigins: new Map(), projectionReadMs: 10 });
  await assert.rejects(routes.reconcile(f.record.id), /PROJECTION_TARGET_READ_TIMEOUT/);
  assert.equal(routes.inspect().projectionPending, f.record.id); assert.equal(routes.inspect().projectionReads, 1);
  await assert.rejects(routes.reconcile(f.record.id), /ADAPTER_OPERATION_PENDING/);
  await assert.rejects(routes.submit('pmo', { id: 'another', prompt: 'second' }), /ADAPTER_OPERATION_PENDING/);
  finish(structuredClone(f.record.target)); await held; await new Promise(resolve => setImmediate(resolve));
  assert.equal(routes.inspect().projectionReads, 0); assert.equal(f.counters().saves, 0);
  await routes.reconcile(f.record.id); assert.equal(f.counters().saves, 1);
});
