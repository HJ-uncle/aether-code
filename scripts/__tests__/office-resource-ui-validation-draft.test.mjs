/** Offline draft contracts only; no live runner, model, Inspector, page or company files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resourceUiScenarioPlan, hashResourceSample, runOfficeResourceUiValidation } from '../office-resource-ui-validation-draft.mjs';

const samples = ['docx', 'xlsx', 'pptx', 'pdf'].map((kind, i) => ({ kind, role: 'role-' + i,
  path: path.resolve('.e2e-tmp/company/sample.' + kind), entry: i % 2 ? 'conversation' : 'artifact' }));

test('draft plan covers four formats and both real UI entry kinds', () => {
  const plan = resourceUiScenarioPlan(samples);
  assert.deepEqual(plan.formats, ['docx', 'xlsx', 'pptx', 'pdf']);
  assert.ok(plan.requiredHooks.includes('exerciseResourceAndSessionSwitching'));
  assert.equal(plan.status, 'draft-awaiting-final-preview-selectors');
});

test('duplicate and disguised format samples cannot become a complete plan', () => {
  assert.throws(() => resourceUiScenarioPlan([samples[0], samples[0]]), /DUPLICATE_SAMPLE_FORMAT/);
  assert.throws(() => resourceUiScenarioPlan([{ ...samples[0], path: 'sample.txt' }]), /EXTENSION_MISMATCH/);
  assert.throws(() => resourceUiScenarioPlan([{ ...samples[0], entry: 'ipc' }]), /REAL_ARTIFACT_OR_CONVERSATION/);
});

test('execution without final hooks refuses before consulting any live controller', async () => {
  const c = new Proxy({}, { get() { throw new Error('must-not-touch-controller'); } });
  await assert.rejects(runOfficeResourceUiValidation(c, { samples }), /FINAL_SELECTOR_HOOK_REQUIRED/);
});

test('sample fingerprint is bounded and leaves the real bytes and timestamps unchanged', t => {
  const base = path.resolve('.e2e-tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'resource-ui-fingerprint-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'fixture.pdf'), bytes = Buffer.from('%PDF-synthetic-only'); fs.writeFileSync(file, bytes);
  const before = fs.statSync(file), result = hashResourceSample(file, root);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.bytes, bytes.length); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.throws(() => hashResourceSample(file, root, 1), /SAMPLE_SIZE_BUDGET/);
  assert.throws(() => hashResourceSample(path.join(base, 'outside.pdf'), root), /SAMPLE_OUTSIDE_COMPANY/);
});
