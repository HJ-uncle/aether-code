/** Product journal parsing with temporary files; no live campaign, IPC or engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadonlyWorkQueueReader } from '../office-readonly-work-queue.mjs';

const fixtures = path.resolve('.e2e-tmp');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const scope = { source: { mode: 'embedded', endpoint: '', accountId: 'account' }, tenantId: 'tenant',
  namespace: { id: 'namespace', generation: 'generation' }, owner: 'work', taskId: 'work-task' };
const key = sha(JSON.stringify(['embedded', '', 'account', 'tenant', 'namespace', 'generation', 'work', 'work-task']));
const state = () => ({ schemaVersion: 1, scope: structuredClone(scope), revision: 0, paused: false, entries: [], removed: [] });
async function using(fn) {
  fs.mkdirSync(fixtures, { recursive: true });
  const profile = fs.mkdtempSync(path.join(fixtures, 'readonly-work-queue-'));
  const bucket = path.join(profile, 'next-turn-queue-v1', key);
  const write = (change = value => value) => {
    fs.mkdirSync(bucket, { recursive: true });
    const unsigned = change({ schemaVersion: 1, bucketKey: key, previousDigest: null, operationId: 'bootstrap',
      operationDigest: 'a'.repeat(64), committedAt: 1, state: state() });
    const record = { ...unsigned, snapshotDigest: sha(canonical(unsigned)) };
    fs.writeFileSync(path.join(bucket, 'r0000000000.json'), JSON.stringify(record) + '\n');
  };
  try { await fn({ profile, bucket, write, reader: options => createReadonlyWorkQueueReader({ profile, backend: 'json-journal', ...options }) }); }
  finally {
    const resolved = fs.realpathSync(profile);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(fixtures).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('readonly-work-queue-'));
    fs.rmSync(resolved, { recursive: true });
  }
}
test('missing bucket reads actual empty product state without creating files', () => using(async f => {
  assert.deepEqual((await f.reader().read(scope)).state, state());
  assert.deepEqual(fs.readdirSync(f.profile), []);
}));
test('actual journal checksum and shared state contract produce a bounded read receipt', () => using(async f => {
  f.write(); const reader = f.reader(); const result = await reader.read(scope);
  assert.deepEqual(result.state, state()); assert.equal(result.readEvidence.files.length, 1);
  assert.equal(Object.keys(result.sourceHashes).length, 3);
  assert.throws(() => reader.validateQueueState({ ...state(), paused: 'false' }, scope));
  assert.deepEqual(fs.readdirSync(f.bucket), ['r0000000000.json']);
}));
test('corrupt journal is refused and diagnostics cannot create an error file', () => using(async f => {
  f.write(); const file = path.join(f.bucket, 'r0000000000.json'); const value = JSON.parse(fs.readFileSync(file));
  value.snapshotDigest = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(value)); const before = fs.readFileSync(file);
  await assert.rejects(() => f.reader().read(scope), /checksum/);
  assert.deepEqual(fs.readdirSync(f.bucket), ['r0000000000.json']); assert.deepEqual(fs.readFileSync(file), before);
}));
test('valid checksum cannot bypass real product state validation', () => using(async f => {
  f.write(value => ({ ...value, state: { ...value.state, revision: -1 } }));
  await assert.rejects(() => f.reader().read(scope), /invalid/);
  assert.deepEqual(fs.readdirSync(f.bucket), ['r0000000000.json']);
}));
test('configured I/O budget refuses an incomplete prefix and leaves disk unchanged', () => using(async f => {
  f.write(); await assert.rejects(() => f.reader({ limits: { bytes: 1 } }).read(scope));
  assert.deepEqual(fs.readdirSync(f.bucket), ['r0000000000.json']);
}));
test('native backend, catalog and wrong source pins are rejected', () => using(async f => {
  assert.throws(() => f.reader({ backend: 'sqlite' }), /BACKEND/);
  assert.throws(() => f.reader({ sourcePins: {} }), /PIN/);
  fs.mkdirSync(path.join(f.profile, 'next-turn-queue-native-v1'));
  await assert.rejects(() => f.reader().read(scope), /NATIVE/);
}));
