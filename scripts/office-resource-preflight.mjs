/** Standalone readonly refresh gate: intentionally does not import submit adapters or UI modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadonlyWorkQueueReader } from './office-readonly-work-queue.mjs';

const ROOT = 'D:/dev/aether-code/.ae/office-company-20261023163242581';
const RUNNER = 'D:/dev/aether-code/scripts/run-office-company-campaign.mjs';
const UPGRADE_SHA = 'dc65951458b21c13b99da1da7dad5d5b45445b44dac4fe715f36380985915464';
const sha = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const engineKeys = ['mode', 'phase', 'adopted', 'instanceId', 'accountId', 'pid', 'buildId', 'baseUrl', 'dataDir', 'entryPath'];
const identity = value => Object.fromEntries(engineKeys.map(key => [key, value[key]]));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const observations = new WeakMap();

export function resourceCommandFingerprint(c) {
  const file = path.join(c.state.runRoot, 'commands.json'); assert.ok(fs.statSync(file).size <= 1024 * 1024);
  const bytes = fs.readFileSync(file), rows = JSON.parse(bytes).commands;
  assert.ok(Array.isArray(rows) && rows.length <= 2048 && Array.isArray(c.state.commands), 'COMMAND_QUEUE_UNKNOWN');
  const records = new Map(c.state.commands.map(row => [row.id, row.status]));
  assert.equal(records.size, c.state.commands.length, 'COMMAND_HISTORY_DUPLICATE');
  assert.ok([...records.values()].every(status => ['completed', 'failed'].includes(status)), 'RUNNER_COMMAND_STILL_ACTIVE');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'COMMAND_QUEUE_DUPLICATE');
  assert.ok(rows.every(row => ['completed', 'failed'].includes(records.get(row.id))), 'RUNNER_QUEUE_NOT_DRAINED');
  return { sha256: sha(bytes), history: [...records].map(([id, status]) => ({ id, status })) };
}

export async function observeOfficeResourceIdle(c, { allowResourceValidation = false } = {}) {
  assert.equal(process.pid, 9080, 'OWNED_RUNNER_PID_CHANGED'); assert.ok(samePath(process.argv[1], RUNNER));
  assert.equal(c, globalThis.__officeCampaign); assert.ok(samePath(c.state.runRoot, ROOT) && !c.page.isClosed());
  assert.ok(!c.contextProbePromise && !c.uiLoadProbePromise && !c.state.contextCompactionProbeControl?.leaseActive, 'OTHER_UI_PROBE_ACTIVE');
  if (!allowResourceValidation) assert.ok(!c.resourceUiProbePromise, 'RESOURCE_VALIDATION_ACTIVE');
  for (const name of Object.keys(c)) if (/MaintenanceLease/.test(name)) assert.ok(!c[name]?.active, 'MAINTENANCE_ACTIVE');
  const previous = observations.get(c); assert.ok(!previous?.active && !previous?.pending, 'READONLY_PREFLIGHT_STILL_PENDING');
  const control = { active: true, pending: 0 }; observations.set(c, control);
  const deadline = Date.now() + 35000;
  const read = async (label, operation) => {
    assert.ok(Date.now() < deadline, 'PREFLIGHT_DEADLINE'); control.pending++; let timer;
    const promise = Promise.resolve().then(operation).finally(() => { control.pending--; });
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PREFLIGHT_READ_TIMEOUT:' + label)), Math.min(7000, deadline - Date.now())); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const file = path.join(ROOT, 'evidence/microcompact-index-upgrade-after.json');
    assert.ok(samePath(fs.realpathSync(file), file) && fs.statSync(file).size <= 2 * 1024 * 1024);
    const bytes = fs.readFileSync(file); assert.equal(sha(bytes), UPGRADE_SHA, 'UPGRADE_EVIDENCE_CHANGED');
    const upgrade = JSON.parse(bytes); assert.equal(upgrade.status, 'passed');
    const expectedEngine = identity(upgrade.next), commands = resourceCommandFingerprint(c);
    const profile = path.join(ROOT, 'profile'); assert.ok(samePath(c.state.profile, profile));
    const host = await read('host', () => c.app.evaluate(({ app, BrowserWindow }) => ({ profile: app.getPath('userData'),
      native: process.env.AETHER_NEXT_TURN_BACKEND === 'sqlite-worker-opt-in',
      windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, webContentsId: window.webContents.id, url: window.webContents.getURL() })).sort((a, b) => a.id - b.id) })));
    assert.ok(samePath(host.profile, profile) && !host.native, 'READONLY_QUEUE_BACKEND_OR_PROFILE_CHANGED');
    assert.equal(host.windows.length, 1, 'EXACTLY_ONE_EXISTING_WINDOW_REQUIRED');
    assert.deepEqual(identity(await read('engine', () => c.page.evaluate(() => window.aether.engine.getSnapshot()))), expectedEngine, 'ENGINE_IDENTITY_CHANGED');
    const reader = createReadonlyWorkQueueReader({ profile, backend: 'json-journal' });
    const roles = {}, expectedTargets = {};
    assert.equal(upgrade.after.tasks.length, 6);
    for (const task of upgrade.after.tasks) {
      const role = task.role, scope = upgrade.after.queues[role].scope;
      assert.equal(c.state.roles[role]?.sessionId, task.id); assert.equal(c.state.roles[role]?.agentId, task.agentId);
      const status = await read('root-' + role, () => c.request('GET', '/chat/status', undefined, { sessionId: task.id }));
      assert.ok(status.running === false && status.run?.sessionId === task.id && terminal.has(status.run.status)
        && Array.isArray(status.run.pending) && status.run.pending.length === 0, 'ROOT_NOT_IDLE:' + role);
      assert.equal(status.run.serverAdmissionReceipt?.tenantId, scope.tenantId); assert.deepEqual(status.run.serverAdmissionReceipt.namespace, scope.namespace);
      const queue = await read('queue-' + role, () => reader.read(scope));
      assert.ok(queue.state.entries.every(entry => entry.phase === 'terminal' && terminal.has(entry.outcome)), 'WORK_QUEUE_NOT_DRAINED');
      roles[role] = { sessionId: task.id, runId: status.run.runId, rootStatus: status.run.status,
        queueRevision: queue.state.revision, queueSha256: sha(JSON.stringify(queue.state)), scope };
      expectedTargets[role] = { sessionId: task.id, agentId: task.agentId, modelId: task.modelId, workspacePath: task.workspacePath,
        tenantId: scope.tenantId, namespace: scope.namespace, engine: expectedEngine };
    }
    assert.deepEqual(identity(await read('engine-after', () => c.page.evaluate(() => window.aether.engine.getSnapshot()))), expectedEngine);
    assert.deepEqual(resourceCommandFingerprint(c), commands, 'COMMANDS_CHANGED_DURING_PREFLIGHT');
    assert.equal(control.pending, 0);
    return { schemaVersion: 1, ready: true, observedAt: new Date().toISOString(), engine: expectedEngine, roles, expectedTargets,
      windows: host.windows, commandFingerprint: commands, queueSourceHashes: reader.sourceHashes,
      semantics: 'GET status, existing window inventory and strict readonly queue disk reads; no UI selection or submit-adapter import.' };
  } finally { control.active = false; }
}

export function stableIdleObservation(value) {
  return { engine: value.engine, roles: value.roles, expectedTargets: value.expectedTargets, windows: value.windows,
    commandFingerprint: value.commandFingerprint, queueSourceHashes: value.queueSourceHashes };
}
export async function prepareOfficeResourceRefresh(c) {
  const first = await observeOfficeResourceIdle(c), second = await observeOfficeResourceIdle(c);
  assert.deepEqual(stableIdleObservation(first), stableIdleObservation(second), 'READONLY_PREFLIGHT_NOT_STABLE');
  return { ready: true, firstObservedAt: first.observedAt, ...second, passes: 2, unifiedUiRequired: false };
}

/** Read bounded original bytes without loading documents into memory or writing them. */
export function hashResourceSample(file, companyRoot, maxBytes = 32 * 1024 * 1024) {
  const root = path.resolve(companyRoot), resolved = path.resolve(file), relative = path.relative(root, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'SAMPLE_OUTSIDE_COMPANY');
  assert.ok(samePath(fs.realpathSync(root), root) && samePath(fs.realpathSync(resolved), resolved), 'SAMPLE_REDIRECTED');
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
  const fd = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(fd); assert.ok(before.isFile() && before.size > 0 && before.size <= maxBytes, 'SAMPLE_SIZE_BUDGET');
    const buffer = Buffer.alloc(Math.min(64 * 1024, before.size)), digest = createHash('sha256');
    for (let offset = 0; offset < before.size;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset); assert.ok(count > 0);
      digest.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fs.statSync(resolved); for (const key of ['dev', 'ino', 'birthtimeMs', 'mtimeMs', 'size']) assert.equal(before[key], after[key], 'SAMPLE_CHANGED_DURING_HASH');
    return { path: resolved, bytes: before.size, sha256: digest.digest('hex'), mtimeMs: before.mtimeMs };
  } finally { fs.closeSync(fd); }
}
