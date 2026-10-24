/** Offline contracts and negative controls: no live runner, browser, model or company files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { validateResourceFixtureConfig, stableResourcePreflight, ownedResourceCleanup,
  resourcePreviewReady, newResourceWebSelected, resourceTabAbsent, restoreResourceScrolls,
  matchingArtifactTitle, resolveResourcePath, resourceFileSelected,
  startOfficeResourceUiValidation, queryOfficeResourceUiValidation, cancelOfficeResourceUiValidation,
} from '../office-resource-ui-validation.mjs';
import { hashResourceSample } from '../office-resource-preflight.mjs';

const config = () => ({ schemaVersion: 1, samples: ['docx', 'xlsx', 'pptx', 'pdf'].map(kind => ({
  kind, role: 'pmo', path: path.resolve('.e2e-tmp/company/sample.' + kind), entry: 'artifact',
})) });
const browser = (fn, input, document) => vm.runInNewContext('(' + fn.toString() + ')(input)', {
  input, document, getComputedStyle: () => ({ visibility: 'visible' }),
}, { timeout: 1000 });
const node = (attributes = {}, selectors = {}, extra = {}) => ({
  getAttribute: key => attributes[key] ?? null, querySelector: key => selectors[key] ?? null,
  getClientRects: () => [{}], ...extra,
});
function previewFixture(kind, { page = 1, rendered = page, sheet = '0', row = '1', table = {}, hostCount = 1 } = {}) {
  const body = node({ 'data-document-sheet': sheet, 'data-document-row-start': row }, { table });
  const root = node({}, {
    'input[aria-label="页码"]': { value: String(page) },
    'canvas[data-document-page]': { width: 100, height: 100, dataset: { documentPage: String(page), renderedPage: String(rendered) } },
    '[data-document-sheet]': body,
    '[data-document-column-range]': { textContent: 'A–T' },
    'iframe[data-document-page]': node({ 'data-document-page': String(page), srcdoc: '<p>' + 'x'.repeat(110) + '</p>' }, {}, { clientWidth: 500, clientHeight: 300 }),
  });
  const host = node({ 'data-document-session': 's1', 'data-document-path': 'D:\\company\\sample.' + kind }, { ['[data-document-preview="' + kind + '"]']: root });
  return { querySelectorAll: () => Array(hostCount).fill(host) };
}
const expected = kind => ({ kind, sessionId: 's1', path: 'd:/company/sample.' + kind });
const tab = (id, title = id) => ({ id, title });

test('four actual artifact entries are valid; conversation coverage is explicit, not fabricated', () => {
  assert.equal(validateResourceFixtureConfig(config()).samples.length, 4);
  const mixed = config(); mixed.samples[0] = { ...mixed.samples[0], entry: 'conversation', linkHref: 'actual-existing-file.docx' };
  assert.equal(validateResourceFixtureConfig(mixed).samples[0].entry, 'conversation');
  delete mixed.samples[0].linkHref;
  assert.throws(() => validateResourceFixtureConfig(mixed), /EXACT_EXISTING_CONVERSATION_LINK_REQUIRED/);
});
test('unknown, duplicate, disguised, relative and incomplete formats are refused', () => {
  for (const mutate of [c => { c.samples[0].kind = 'html'; }, c => { c.samples[1] = c.samples[0]; },
    c => { c.samples[0].path = path.resolve('wrong.exe'); }, c => { c.samples[0].path = 'relative.docx'; }, c => { c.samples.pop(); }]) {
    const input = config(); mutate(input); assert.throws(() => validateResourceFixtureConfig(input));
  }
  assert.doesNotThrow(() => validateResourceFixtureConfig({ schemaVersion: 1, samples: [] }, { complete: false }));
});
test('preflight compares engine/run/queue/binding state independently of timestamps', () => {
  const proof = { engine: { pid: 1 }, expectedTargets: { pmo: { sessionId: 's1' } }, roles: { pmo: { runId: 'r1', queueSha256: 'sha1' } }, observedAt: 'one' };
  assert.deepEqual(stableResourcePreflight(proof), stableResourcePreflight({ ...proof, observedAt: 'two' }));
  assert.notDeepEqual(stableResourcePreflight(proof), stableResourcePreflight({ ...proof, engine: { pid: 2 } }));
  assert.notDeepEqual(stableResourcePreflight(proof), stableResourcePreflight({ ...proof, roles: { pmo: { runId: 'r2', queueSha256: 'sha1' } } }));
});
test('cleanup closes only newly created intended resources and preserves baseline/unknown tabs', () => {
  const old = tab('file:old', path.resolve('old.pdf')), fixture = path.resolve('new.pdf');
  const before = { tabs: [old, tab('web:existing')] };
  const after = { tabs: [...before.tabs, tab('file:new', fixture), tab('file:unknown', path.resolve('other.pdf')), tab('web:known'), tab('web:unknown')] };
  assert.deepEqual(ownedResourceCleanup(before, after, [fixture], [{ createdId: 'web:known' }]).map(t => t.id), ['web:known', 'file:new']);
});
test('artifact titles resolve against the owning task root, never the runner cwd', () => {
  const root = 'D:/company';
  assert.equal(resolveResourcePath('deliverables/v004/a.pdf', root), path.resolve(root, 'deliverables/v004/a.pdf'));
  assert.equal(matchingArtifactTitle(['deliverables/v004/a.pdf', 'other/a.pdf'], { path: 'D:/company/deliverables/v004/a.pdf' }, root), 'deliverables/v004/a.pdf');
  assert.throws(() => matchingArtifactTitle(['deliverables/v004/a.pdf', 'D:/company/deliverables/v004/a.pdf'], { path: 'D:/company/deliverables/v004/a.pdf' }, root), /AMBIGUOUS/);
  assert.throws(() => matchingArtifactTitle(['D:/elsewhere/a.pdf'], { path: 'D:/company/a.pdf' }, root), /MISSING/);
});
test('partial web creation is cleaned only when exactly one new candidate is attributable', () => {
  const before = { tabs: [tab('web:old')] }, intent = [{ beforeIds: ['web:old'], createdId: null }];
  assert.deepEqual(ownedResourceCleanup(before, { tabs: [...before.tabs, tab('web:new')] }, [], intent).map(t => t.id), ['web:new']);
  assert.deepEqual(ownedResourceCleanup(before, { tabs: [...before.tabs, tab('web:new'), tab('web:unknown')] }, [], intent), []);
});
test('PDF waits for requested page and rendered canvas, rejecting stale frames', () => {
  assert.equal(browser(resourcePreviewReady, { ...expected('pdf'), page: 2 }, previewFixture('pdf')), false);
  assert.equal(browser(resourcePreviewReady, { ...expected('pdf'), page: 2 }, previewFixture('pdf', { page: 2, rendered: 1 })), false);
  assert.equal(browser(resourcePreviewReady, { ...expected('pdf'), page: 2 }, previewFixture('pdf', { page: 2 })), true);
});
test('preview belongs to the exact session/path and refuses duplicate matching hosts', () => {
  assert.equal(browser(resourcePreviewReady, { ...expected('pdf'), sessionId: 's2' }, previewFixture('pdf')), false);
  assert.equal(browser(resourcePreviewReady, { ...expected('pdf'), path: 'D:/other.pdf' }, previewFixture('pdf')), false);
  assert.equal(browser(resourcePreviewReady, expected('pdf'), previewFixture('pdf', { hostCount: 2 })), false);
});
test('sheet/row waits reject old table data and accept an intentionally empty rendered table', () => {
  const target = { ...expected('xlsx'), sheet: '1', rowStart: 101 };
  assert.equal(browser(resourcePreviewReady, target, previewFixture('xlsx')), false);
  assert.equal(browser(resourcePreviewReady, target, previewFixture('xlsx', { sheet: '1', row: '101', table: null })), false);
  assert.equal(browser(resourcePreviewReady, target, previewFixture('xlsx', { sheet: '1', row: '101' })), true);
  assert.equal(browser(resourcePreviewReady, { ...target, columnRange: 'U–AN' }, previewFixture('xlsx', { sheet: '1', row: '101' })), false);
});
test('Office frame requires actual page dimensions and matching requested page', () => {
  assert.equal(browser(resourcePreviewReady, { ...expected('pptx'), page: 2 }, previewFixture('pptx')), false);
  assert.equal(browser(resourcePreviewReady, { ...expected('pptx'), page: 2 }, previewFixture('pptx', { page: 2 })), true);
});
test('new-web and close waits follow stable React keys instead of duplicate titles', () => {
  const make = id => node({}, {}, { __reactFiber$test: { return: { key: id } } });
  assert.equal(browser(newResourceWebSelected, ['web:old'], { querySelectorAll: () => [make('file:doc')] }), false);
  assert.equal(browser(newResourceWebSelected, ['web:old'], { querySelectorAll: () => [make('web:old')] }), false);
  assert.equal(browser(newResourceWebSelected, ['web:old'], { querySelectorAll: () => [make('web:new')] }), true);
  assert.equal(browser(resourceTabAbsent, 'web:new', { querySelectorAll: () => [make('web:new')] }), false);
  assert.equal(browser(resourceTabAbsent, 'web:new', { querySelectorAll: () => [make('web:old')] }), true);
});
test('resource file selection uses the actual tab title and visible selected tab', () => {
  const make = (title, selected = 'true') => node({ title, 'aria-selected': selected }, {}, { getAttribute: key => ({ title, 'aria-selected': selected })[key] ?? null });
  const document = { querySelectorAll: () => [make('D:/company/a.pdf', 'true')] };
  assert.equal(browser(resourceFileSelected, { path: 'd:/company/a.pdf' }, document), true);
  assert.equal(browser(resourceFileSelected, { path: 'D:/company/b.pdf' }, document), false);
});
test('scroll restoration preserves zero offsets and rejects ambiguous changed targets', () => {
  const item = { className: 'body', scrollHeight: 100, clientHeight: 20, scrollTop: 10, scrollLeft: 3 };
  const record = { className: 'body', count: 1, index: 0, scrollTop: 0, scrollLeft: 0 };
  const doc = { querySelector: () => ({ querySelectorAll: () => [item] }) };
  browser(restoreResourceScrolls, [record], doc); assert.equal(item.scrollTop, 0); assert.equal(item.scrollLeft, 0);
  assert.throws(() => browser(restoreResourceScrolls, [{ ...record, count: 2 }], doc), /SCROLL_TARGET_CHANGED/);
});
function offlineController() {
  let reads = 0;
  const original = async () => { throw new Error('No live action authorized in offline tests'); };
  return { state: {}, submit: original, createAndStart: original, selectTask: original,
    page: { on() {}, off() {}, evaluate() { reads++; throw new Error('Unexpected live read'); } },
    readCount: () => reads };
}
test('start acknowledges before live access; wrong runner preflight fails and releases the guard', async () => {
  const c = offlineController(), original = c.submit, ack = startOfficeResourceUiValidation(c, config()), pending = c.resourceUiProbePromise;
  assert.equal(ack.accepted, true); assert.equal(c.readCount(), 0); assert.notEqual(c.submit, original);
  await assert.rejects(c.submit(), /RESOURCE_UI_VALIDATION_OWNS_RUNNER/);
  const result = await pending;
  assert.equal(result.status, 'failed'); assert.match(result.failures.join(' '), /OWNED_RUNNER_PID_CHANGED/);
  assert.equal(c.submit, original); assert.equal(c.resourceUiProbePromise, null); assert.equal(c.readCount(), 0);
});
test('cancellation before first observation releases guards without model cancellation or UI access', async () => {
  const c = offlineController(), original = c.submit;
  startOfficeResourceUiValidation(c, config()); const pending = c.resourceUiProbePromise;
  assert.equal(cancelOfficeResourceUiValidation(c).noModelCancellation, true);
  const result = await pending; assert.equal(result.status, 'cancelled'); assert.equal(c.submit, original);
  assert.equal(queryOfficeResourceUiValidation(c).leaseActive, false); assert.equal(c.readCount(), 0);
});
test('another probe or malformed config cannot acquire guards', () => {
  const c = offlineController(), original = c.submit; c.contextProbePromise = Promise.resolve();
  assert.throws(() => startOfficeResourceUiValidation(c, config()), /ANOTHER_UI_PROBE_OWNS_RUNNER/);
  assert.equal(c.submit, original);
  const inaccessible = new Proxy({}, { get() { throw new Error('Must not inspect controller'); } });
  assert.throws(() => startOfficeResourceUiValidation(inaccessible, { schemaVersion: 1, samples: [] }), /FOUR_REAL_FORMATS_REQUIRED/);
});
test('preflight and final helper dependency graph never imports the verified-submit adapter or draft', () => {
  const seen = new Set();
  const inspect = file => {
    if (seen.has(file)) return; seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(match[1], /verified-submit-adapter|resource-ui-validation-draft/);
      if (match[1].startsWith('.')) inspect(path.resolve(path.dirname(file), match[1]));
    }
  };
  inspect(path.resolve('scripts/office-resource-preflight.mjs')); inspect(path.resolve('scripts/office-resource-ui-validation.mjs'));
  assert.ok(seen.size >= 4);
});
test('bounded sample hash preserves original bytes and timestamps and refuses outside paths', t => {
  const base = path.resolve('.e2e-tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'resource-final-offline-'));
  t.after(() => { assert.ok(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'fixture.pdf'), bytes = Buffer.from('%PDF-synthetic-offline-only'); fs.writeFileSync(file, bytes);
  const before = fs.statSync(file), result = hashResourceSample(file, root);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(result.bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.throws(() => hashResourceSample(file, root, 1), /SAMPLE_SIZE_BUDGET/);
  assert.throws(() => hashResourceSample(path.join(base, 'outside.pdf'), root), /SAMPLE_OUTSIDE_COMPANY/);
});
