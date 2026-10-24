/** Existing-window UI validation. Import does not inspect, launch, submit or write.
 * Root supplies reviewed company paths in fixtureConfig; all opens use real UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hashResourceSample, observeOfficeResourceIdle, resourceCommandFingerprint as probeCommandFingerprint } from './office-resource-preflight.mjs';
import { createProbeOperationTracker } from './office-context-probe-lifecycle.mjs';

const kinds = ['docx', 'xlsx', 'pptx', 'pdf'];
const owners = new WeakMap();
const now = () => new Date().toISOString();
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const cssAttribute = value => JSON.stringify(String(value));
const errorText = error => String(error?.stack ?? error).slice(0, 6000);
const observeIdle = c => observeOfficeResourceIdle(c, { allowResourceValidation: true });

/** Artifact paths are relative to their owning task, never the runner's cwd. */
export function resolveResourcePath(candidate, workspaceRoot) {
  assert.ok(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot), 'RESOURCE_WORKSPACE_ROOT_REQUIRED');
  assert.ok(typeof candidate === 'string' && candidate.length > 0 && !/^[A-Za-z]:(?![\\/])/.test(candidate), 'RESOURCE_PATH_REQUIRED');
  return path.resolve(workspaceRoot, candidate);
}
const sameResourcePath = (a, b, root) => typeof a === 'string' && typeof b === 'string'
  && (root ? samePath(resolveResourcePath(a, root), resolveResourcePath(b, root))
    : path.isAbsolute(a) && path.isAbsolute(b) && samePath(a, b));

export function matchingArtifactTitle(titles, sample, workspaceRoot) {
  const matches = titles.filter(title => (!sample.artifactTitle || title === sample.artifactTitle)
    && sameResourcePath(title, sample.path, workspaceRoot));
  assert.equal(matches.length, 1, 'ACTUAL_ARTIFACT_PATH_MISSING_OR_AMBIGUOUS');
  return matches[0];
}

/** Current Work onSelect opens the resource and unmounts the artifact pane. */
export async function openResourceArtifactByUi({ page, sample, workspaceRoot, step }) {
  const artifacts = page.getByRole('listbox', { name: '成果文件', exact: true });
  const titles = await step('actual artifact paths', () => artifacts.getByRole('option').evaluateAll(elements => elements.map(element => element.getAttribute('title'))));
  const title = matchingArtifactTitle(titles, sample, workspaceRoot);
  const option = artifacts.locator('[role="option"][title=' + cssAttribute(title) + ']');
  assert.equal(await step('artifact option count', () => option.count()), 1, 'ARTIFACT_OPTION_AMBIGUOUS');
  await step('open artifact resource', () => option.click({ timeout: 10000 }));
}

export async function restoreResourceArtifactSelection({ page, before, workspaceRoot, step, rememberPath }) {
  if (!before.artifactTitle) return;
  const button = page.getByRole('toolbar', { name: '工作区工具', exact: true }).locator('#work-tab-artifacts');
  assert.equal(await step('restore artifacts tool count', () => button.count()), 1);
  await step('restore artifact view', () => button.click({ timeout: 10000 }));
  const selected = page.getByRole('listbox', { name: '成果文件', exact: true }).locator('[role="option"][aria-selected="true"]');
  const current = await step('current artifact selection', () => selected.getAttribute('title'));
  if (current && sameResourcePath(current, before.artifactTitle, workspaceRoot)) return;
  const file = resolveResourcePath(before.artifactTitle, workspaceRoot);
  // onSelect opens a file now; record that temporary restoration resource before
  // clicking so timeout/reconcile can close it without touching baseline tabs.
  rememberPath(file);
  await openResourceArtifactByUi({ page, sample: { path: file, artifactTitle: before.artifactTitle }, workspaceRoot, step });
  await step('restored artifact resource selected', () => page.waitForFunction(resourceFileSelected, { path: file }, { timeout: 34000 }), 35000);
}

export function activeWorkBinding({ storageKey }) {
  const value = localStorage.getItem(storageKey);
  if (!value || value.length > 4 * 1024 * 1024) throw new Error('WORK_STATE_MISSING_OR_OVERSIZED');
  const state = JSON.parse(value), selected = state.tasks?.find(task => task.id === state.activeTaskId);
  const editor = [...document.querySelectorAll('#mode-work .input-composer__input[role="textbox"]')].filter(element => element.getClientRects().length);
  let controller = null, fiber = editor.length === 1 ? editor[0][Object.keys(editor[0]).find(key => key.startsWith('__reactFiber$'))] : null;
  for (let depth = 0; fiber && depth < 48; depth++, fiber = fiber.return) if (fiber.memoizedProps?.controller?.activeTask) { controller = fiber.memoizedProps.controller; break; }
  const project = task => task ? ({ id: task.id, title: task.title, agentId: task.agentId, modelId: task.modelId, workspacePath: task.workspacePath }) : null;
  return { storageKey, editorCount: editor.length, selected: project(selected), controller: project(controller?.activeTask),
    draftSource: controller?.draftSource, modelId: controller?.modelId || controller?.defaultModelId,
    ready: controller?.ready, modelReady: controller?.modelReady };
}
function assertActiveBinding(binding, expected) {
  assert.equal(binding.editorCount, 1); assert.ok(binding.ready && binding.modelReady);
  for (const task of [binding.selected, binding.controller]) {
    assert.equal(task?.id, expected.sessionId, 'ACTIVE_TASK_CHANGED'); assert.equal(task.agentId, expected.agentId);
    assert.equal(task.modelId, expected.modelId); assert.ok(samePath(task.workspacePath, expected.workspacePath));
  }
  assert.equal(binding.modelId, expected.modelId); assert.equal(binding.draftSource, ':account:' + expected.engine.accountId);
}
async function activeRole(c, proof) {
  const binding = await c.page.evaluate(activeWorkBinding, { storageKey: 'aether.work.state.v1:' + encodeURIComponent(':account:' + proof.engine.accountId) });
  const role = Object.keys(proof.expectedTargets).find(key => proof.expectedTargets[key].sessionId === binding.selected?.id);
  assert.ok(role, 'CURRENT_TASK_NOT_OWNED'); assertActiveBinding(binding, proof.expectedTargets[role]); return role;
}

export function validateResourceFixtureConfig(config, { complete = true } = {}) {
  assert.equal(config?.schemaVersion, 1, 'FIXTURE_SCHEMA_REQUIRED');
  assert.ok(Array.isArray(config.samples) && config.samples.length <= 4, 'FIXTURE_SAMPLE_BUDGET');
  const seen = new Set();
  for (const sample of config.samples) {
    assert.ok(kinds.includes(sample.kind) && !seen.has(sample.kind), 'FIXTURE_FORMAT_UNKNOWN_OR_DUPLICATE'); seen.add(sample.kind);
    assert.ok(typeof sample.role === 'string' && path.isAbsolute(sample.path), 'FIXTURE_ROLE_AND_ABSOLUTE_PATH_REQUIRED');
    assert.equal(path.extname(sample.path).toLowerCase(), '.' + sample.kind, 'FIXTURE_EXTENSION_MISMATCH');
    assert.ok(['artifact', 'conversation'].includes(sample.entry ?? 'artifact'), 'FIXTURE_UI_ENTRY_REQUIRED');
    if (sample.entry === 'conversation') assert.ok(sample.linkTitle || sample.linkHref || sample.linkSelector, 'EXACT_EXISTING_CONVERSATION_LINK_REQUIRED');
  }
  if (complete) assert.deepEqual([...seen].sort(), [...kinds].sort(), 'FOUR_REAL_FORMATS_REQUIRED');
  if (config.injectSpreadsheetWorkerError !== undefined) assert.equal(typeof config.injectSpreadsheetWorkerError, 'boolean');
  return config;
}

export function stableResourcePreflight(proof) {
  return { engine: proof.engine, expectedTargets: proof.expectedTargets,
    roles: Object.fromEntries(Object.entries(proof.roles).map(([role, value]) => [role, {
      sessionId: value.sessionId, runId: value.runId, rootStatus: value.rootStatus,
      queueRevision: value.queueRevision, queueSha256: value.queueSha256, scope: value.scope,
    }])) };
}

/** DOM descriptors only, including stable React keys used by the actual tab list. */
export function resourceUiSnapshot() {
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const work = document.querySelector('#mode-work');
  const lists = work ? [...work.querySelectorAll('[role="tablist"][aria-label="打开的资源"]')].filter(visible) : [];
  const tools = work ? [...work.querySelectorAll('[role="toolbar"][aria-label="工作区工具"]')].filter(visible) : [];
  const keyOf = element => {
    const field = Object.keys(element).find(key => key.startsWith('__reactFiber$')); let fiber = field ? element[field] : null;
    for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
      if (typeof fiber.key === 'string' && /^(file|web):/.test(fiber.key)) return fiber.key;
    }
    return null;
  };
  const tabs = lists.length === 1 ? [...lists[0].querySelectorAll('[role="tab"]')].map((tab, index) => ({
    id: keyOf(tab), index, title: tab.getAttribute('title'), name: tab.textContent?.trim() || '',
    selected: tab.getAttribute('aria-selected') === 'true', closeLabel: tab.parentElement?.querySelector('button[aria-label^="关闭"]')?.getAttribute('aria-label') || null,
  })) : [];
  const host = work ? [...work.querySelectorAll('[data-document-session][data-document-path]')].find(visible) : null;
  const preview = host?.querySelector('[data-document-preview]');
  const pageInput = preview?.querySelector('input[aria-label="页码"]');
  const sheet = preview?.querySelector('select[aria-label="工作表"]');
  const scrollable = work ? [...work.querySelectorAll('*')].filter(element => typeof element.className === 'string'
    && (element.scrollHeight > element.clientHeight + 10 || element.scrollWidth > element.clientWidth + 10)) : [];
  return { workVisible: visible(work) && work.getAttribute('aria-hidden') === 'false', resourceListCount: lists.length, toolbarCount: tools.length,
    activeTaskTitles: work ? [...work.querySelectorAll('.work-sidebar__task[aria-current="true"]')].filter(visible).map(row => row.getAttribute('title')) : [],
    selectedTool: tools.length === 1 ? tools[0].querySelector('button[aria-pressed="true"]')?.id || null : null,
    artifactTitle: work?.querySelector('[role="listbox"][aria-label="成果文件"] [role="option"][aria-selected="true"]')?.getAttribute('title') || null,
    artifactDetail: work?.querySelector('[role="tablist"][aria-label="成果内容"] [role="tab"][aria-selected="true"]')?.textContent?.trim() || null,
    tabs, preview: preview ? { kind: preview.getAttribute('data-document-preview'), sessionId: host.getAttribute('data-document-session'), path: host.getAttribute('data-document-path'),
      page: pageInput ? Number(pageInput.value) : null, totalPages: pageInput ? Number(pageInput.max) : null,
      sheet: sheet?.value ?? null, rowStart: preview.querySelector('[data-document-row-start]')?.getAttribute('data-document-row-start') || null,
      columnRange: preview.querySelector('[data-document-column-range]')?.textContent?.trim() || null,
      zoom: preview.querySelector('select[aria-label="缩放"]')?.value ?? null } : null,
    scrolls: scrollable.slice(0, 40).map(element => {
      const peers = scrollable.filter(peer => peer.className === element.className);
      return { className: element.className, index: peers.indexOf(element), count: peers.length, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft };
    }), url: location.href };
}

/** The requested identity and rendered page must match, not a previous ready frame. */
export function resourcePreviewReady(expected) {
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const normalize = value => {
    if (typeof value !== 'string' || !value || /^[A-Za-z]:(?![\\/])/.test(value)) return null;
    const text = value.replace(/\\/g, '/');
    const absolute = /^(?:[A-Za-z]:\/|\/)/.test(text) ? text : expected.workspaceRoot ? expected.workspaceRoot.replace(/\\/g, '/') + '/' + text : null;
    if (!absolute) return null;
    const parts = [];
    for (const part of absolute.split('/')) { if (part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
    return parts.join('/').toLowerCase();
  };
  const expectedPath = normalize(expected.path); if (!expectedPath) return false;
  const hosts = [...document.querySelectorAll('#mode-work [data-document-session][data-document-path]')].filter(element => visible(element)
    && element.getAttribute('data-document-session') === expected.sessionId
    && normalize(element.getAttribute('data-document-path')) === expectedPath);
  if (hosts.length !== 1) return false;
  const root = hosts[0].querySelector('[data-document-preview="' + expected.kind + '"]');
  if (!root) return false;
  if (root.querySelector('[role="alert"]')) return true;
  if (expected.page !== undefined && Number(root.querySelector('input[aria-label="页码"]')?.value) !== expected.page) return false;
  if (expected.kind === 'pdf') {
    const canvas = root.querySelector('canvas[data-document-page]');
    return !!canvas && canvas.width > 0 && canvas.height > 0 && canvas.dataset.renderedPage === canvas.dataset.documentPage
      && (expected.page === undefined || Number(canvas.dataset.renderedPage) === expected.page);
  }
  if (expected.kind === 'xlsx') {
    const body = root.querySelector('[data-document-sheet]');
    if (expected.sheet !== undefined && body?.getAttribute('data-document-sheet') !== String(expected.sheet)) return false;
    if (expected.rowStart !== undefined && body?.getAttribute('data-document-row-start') !== String(expected.rowStart)) return false;
    if (expected.columnRange !== undefined && root.querySelector('[data-document-column-range]')?.textContent?.trim() !== expected.columnRange) return false;
    return !!body?.querySelector('table');
  }
  const frame = root.querySelector('iframe[data-document-page]');
  return !!frame && frame.clientWidth > 0 && frame.clientHeight > 0 && (frame.getAttribute('srcdoc') || '').length > 100
    && (expected.page === undefined || Number(frame.getAttribute('data-document-page')) === expected.page);
}

export function restoreResourceScrolls(records) {
  const work = document.querySelector('#mode-work');
  if (!work) throw new Error('WORK_VIEW_MISSING_DURING_RESTORE');
  const elements = [...work.querySelectorAll('*')].filter(element => typeof element.className === 'string'
    && (element.scrollHeight > element.clientHeight + 10 || element.scrollWidth > element.clientWidth + 10));
  for (const record of records) {
    const peers = elements.filter(element => element.className === record.className);
    if (peers.length !== record.count || !peers[record.index]) throw new Error('SCROLL_TARGET_CHANGED:' + record.className);
    peers[record.index].scrollTop = record.scrollTop; peers[record.index].scrollLeft = record.scrollLeft;
    if (Math.abs(peers[record.index].scrollTop - record.scrollTop) > 1 || Math.abs(peers[record.index].scrollLeft - record.scrollLeft) > 1) throw new Error('SCROLL_POSITION_NOT_RESTORED');
  }
}

export function ownedResourceCleanup(before, after, intendedPaths, webIntents = [], workspaceRoot) {
  const original = new Set(before.tabs.map(tab => tab.id));
  const created = after.tabs.filter(tab => !original.has(tab.id));
  const files = created.filter(tab => tab.id?.startsWith('file:') && intendedPaths.some(file => sameResourcePath(file, tab.title, workspaceRoot)));
  const web = created.filter(tab => tab.id?.startsWith('web:') && webIntents.some(intent => intent.createdId === tab.id));
  const unresolved = webIntents.filter(intent => !intent.createdId);
  if (unresolved.length === 1) {
    const candidates = after.tabs.filter(tab => tab.id?.startsWith('web:') && !unresolved[0].beforeIds.includes(tab.id));
    if (candidates.length === 1 && !original.has(candidates[0].id)) web.push(candidates[0]);
  }
  return [...new Map([...files, ...web].map(tab => [tab.id, tab])).values()].reverse();
}

async function windows(c) {
  return c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id,
    webContentsId: window.webContents.id, url: window.webContents.getURL() })).sort((a, b) => a.id - b.id));
}
function noOtherOwner(c) {
  assert.ok(!c.resourceUiProbePromise && !c.contextProbePromise && !c.uiLoadProbePromise, 'ANOTHER_UI_PROBE_OWNS_RUNNER');
  assert.ok(!c.state.contextCompactionProbeControl?.leaseActive, 'CONTEXT_PROBE_LEASE_HELD');
  const state = c.verifiedSubmitInstallation?.inspect?.();
  assert.ok(!state?.active && !state?.pendingOperations && !state?.lease && !state?.routeActive && !state?.projectionPending && !state?.projectionReads, 'SUBMISSION_RECOVERY_OWNS_RUNNER');
  for (const name of Object.keys(c)) if (/MaintenanceLease/.test(name)) assert.ok(!c[name]?.active, 'MAINTENANCE_OWNS_RUNNER');
}
function validateUi(ui) {
  assert.ok(ui.workVisible && ui.resourceListCount === 1 && ui.toolbarCount === 1 && ui.activeTaskTitles.length === 1, 'UNIFIED_WORK_RESOURCE_UI_UNAVAILABLE');
  assert.ok(ui.tabs.length <= 64 && ui.tabs.every(tab => tab.id && tab.closeLabel) && new Set(ui.tabs.map(tab => tab.id)).size === ui.tabs.length, 'RESOURCE_IDENTITY_AMBIGUOUS');
}

/** Two complete read-only observations must agree before a view is changed. */
export async function prepareOfficeResourceUiValidation(c, fixtureConfig = { schemaVersion: 1, samples: [] }) {
  validateResourceFixtureConfig(fixtureConfig, { complete: false }); noOtherOwner(c);
  const first = await observeIdle(c), commands = probeCommandFingerprint(c), firstRole = await activeRole(c, first);
  const ui = await c.page.evaluate(resourceUiSnapshot); validateUi(ui);
  const inventory = await windows(c); assert.equal(inventory.length, 1, 'EXACTLY_ONE_EXISTING_WINDOW_REQUIRED');
  const originals = fixtureConfig.samples.map(sample => {
    assert.ok(first.expectedTargets[sample.role], 'UNKNOWN_SAMPLE_ROLE');
    return { ...sample, ...hashResourceSample(sample.path, path.join(c.state.runRoot, 'company')) };
  });
  assert.ok(originals.reduce((sum, sample) => sum + sample.bytes, 0) <= 64 * 1024 * 1024, 'TOTAL_SAMPLE_BYTE_BUDGET');
  const second = await observeIdle(c); second.activeRole = await activeRole(c, second);
  assert.deepEqual(stableResourcePreflight(second), stableResourcePreflight(first), 'PREFLIGHT_CHANGED_BETWEEN_READS');
  assert.equal(second.activeRole, firstRole, 'PREFLIGHT_ACTIVE_TASK_CHANGED');
  assert.deepEqual(probeCommandFingerprint(c), commands, 'COMMANDS_CHANGED_DURING_PREFLIGHT');
  return { schemaVersion: 1, preparedAt: now(), proof: second, firstObservedAt: first.observedAt, ui, windows: inventory,
    commandFingerprint: commands, originals, workerUrls: c.page.workers().map(worker => worker.url()).sort() };
}

/** Nonblocking acknowledgement; query/cancel/reconcile are explicit and never send a model request. */
export function startOfficeResourceUiValidation(c, fixtureConfig) {
  validateResourceFixtureConfig(fixtureConfig); noOtherOwner(c);
  const config = structuredClone(fixtureConfig), originalMethods = Object.fromEntries(['submit', 'createAndStart', 'selectTask'].map(name => [name, c[name]]));
  assert.ok(Object.values(originalMethods).every(value => typeof value === 'function'), 'RUNNER_METHODS_REQUIRED');
  const control = { schemaVersion: 1, status: 'preflighting', startedAt: now(), leaseActive: true, cancelled: false, running: true,
    pendingOperations: 0, pendingOperationDetails: [], completedSteps: [], notExercised: [], failures: [], restoreErrors: [], workerEvents: [] };
  control.entries = [...new Set(config.samples.map(sample => sample.entry ?? 'artifact'))];
  for (const entry of ['artifact', 'conversation']) if (!control.entries.includes(entry)) control.notExercised.push({
    scenario: entry + '-entry', reason: 'No reviewed existing ' + entry + ' fixture supplied; no history or artifact is fabricated.' });
  const track = createProbeOperationTracker(control, { readMs: 15000 });
  const lease = { c, config, control, track, originalMethods, beforeByRole: new Map(), webIntents: new Map(), restoreFileIntents: new Map(), workers: new Map(),
    initial: null, directory: null, writeSeq: 0, restoring: false, finishedScenarios: false };
  const guards = Object.fromEntries(Object.keys(originalMethods).map(name => [name, async () => { throw new Error('RESOURCE_UI_VALIDATION_OWNS_RUNNER'); }]));
  lease.guards = guards;
  let resolveSlot; c.resourceUiProbePromise = new Promise(resolve => { resolveSlot = resolve; });
  c.resourceUiProbeControl = control; owners.set(c, lease); Object.assign(c, guards);
  const onWorker = worker => {
    const record = { id: lease.workers.size + 1, url: worker.url(), name: null, createdAt: now(), closedAt: null };
    lease.workers.set(worker, record); control.workerEvents.push(record);
    worker.on('close', () => { record.closedAt = now(); });
    void worker.evaluate(() => self.name).then(name => { record.name = name; }, () => {});
  };
  lease.onWorker = onWorker; c.page.on('worker', onWorker);
  setTimeout(() => { void execute(lease).catch(error => control.failures.push(errorText(error))).finally(async () => {
    control.running = false;
    try { await restoreAndRelease(lease); }
    catch (error) { control.status = 'needs-reconciliation'; control.restoreErrors.push(errorText(error)); }
    resolveSlot(structuredClone(control));
  }); }, 0);
  return { accepted: true, status: control.status, query: 'queryOfficeResourceUiValidation', cancel: 'cancelOfficeResourceUiValidation',
    reconcile: 'reconcileOfficeResourceUiValidation', runnerPid: process.pid };
}

function assertLease(lease) {
  assert.equal(owners.get(lease.c), lease, 'UI_VALIDATION_OWNER_CHANGED');
  for (const [name, guard] of Object.entries(lease.guards)) assert.equal(lease.c[name], guard, 'UI_VALIDATION_GUARD_CHANGED');
  if (lease.initial) assert.deepEqual(probeCommandFingerprint(lease.c), lease.initial.commandFingerprint, 'COMMANDS_CHANGED_DURING_UI_VALIDATION');
}
function call(lease, label, operation, timeout = 15000) {
  assertLease(lease);
  assert.equal(lease.track.pending, 0, 'PREVIOUS_UI_OPERATION_STILL_PENDING');
  if (lease.control.cancelled && !lease.restoring) throw new Error('UI_VALIDATION_CANCELLED');
  return lease.track.run(label, operation, timeout);
}
function evidence(lease, label, value) {
  if (!lease.directory) return;
  const name = String(++lease.writeSeq).padStart(3, '0') + '-' + label.replace(/[^a-z0-9-]/gi, '-') + '.json';
  fs.writeFileSync(path.join(lease.directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
async function snapshot(lease) { const ui = await call(lease, 'UI snapshot', () => lease.c.page.evaluate(resourceUiSnapshot)); validateUi(ui); return ui; }
const list = lease => lease.c.page.getByRole('tablist', { name: '打开的资源', exact: true });
const tools = lease => lease.c.page.getByRole('toolbar', { name: '工作区工具', exact: true });
async function click(lease, locator, label) {
  assert.equal(await call(lease, label + ' count', () => locator.count()), 1, label + ': ambiguous target');
  await call(lease, label, () => locator.click({ timeout: 10000 }));
}
async function selectRole(lease, role) {
  await call(lease, 'select ' + role, () => lease.originalMethods.selectTask(role));
  const expected = lease.initial.proof.expectedTargets[role]; assert.ok(expected, 'UNKNOWN_ROLE');
  await waitDom(lease, sessionId => {
    const editor = [...document.querySelectorAll('#mode-work .input-composer__input[role="textbox"]')].find(element => element.getClientRects().length);
    let fiber = editor ? editor[Object.keys(editor).find(key => key.startsWith('__reactFiber$'))] : null;
    for (let depth = 0; fiber && depth < 48; depth++, fiber = fiber.return) {
      const controller = fiber.memoizedProps?.controller;
      if (controller?.activeTask?.id === sessionId && controller.ready && controller.modelReady) return true;
    }
    return false;
  }, expected.sessionId, 'selected task controller');
  const current = await call(lease, 'active task binding', () => lease.c.page.evaluate(activeWorkBinding, {
    storageKey: 'aether.work.state.v1:' + encodeURIComponent(':account:' + expected.engine.accountId),
  }));
  assertActiveBinding(current, expected);
  if (!lease.beforeByRole.has(role)) lease.beforeByRole.set(role, await snapshot(lease));
}
async function activateTab(lease, id) {
  const ui = await snapshot(lease), tab = ui.tabs.find(item => item.id === id); assert.ok(tab, 'RESOURCE_TAB_MISSING:' + id);
  await click(lease, list(lease).getByRole('tab').nth(tab.index), 'select resource');
}
async function capture(lease, label) {
  const ui = await snapshot(lease), file = path.join(lease.directory, String(++lease.writeSeq).padStart(3, '0') + '-' + label + '.png');
  assert.ok(!fs.existsSync(file)); await call(lease, 'screenshot ' + label, () => lease.c.page.screenshot({ path: file }));
  evidence(lease, label, { at: now(), ui, screenshot: file, workers: [...lease.workers.values()] });
  lease.control.completedSteps.push(label); return ui;
}
async function waitDom(lease, predicate, argument, label, timeout = 35000) {
  await call(lease, label, () => lease.c.page.waitForFunction(predicate, argument, { timeout: timeout - 1000 }), timeout);
}
async function waitWorkersClosed(lease) {
  await call(lease, 'document workers closed', () => new Promise((resolve, reject) => {
    const active = () => [...lease.workers].filter(([, row]) => !row.closedAt && (/^aether-document-/.test(row.name || '') || /pdf\.worker|spreadsheet-preview/i.test(row.url)));
    const check = () => { if (!active().length) { cleanup(); resolve(); } };
    const listened = active().map(([worker]) => worker);
    let timer;
    const cleanup = () => { clearTimeout(timer); listened.forEach(worker => worker.off('close', check)); };
    if (!listened.length) { resolve(); return; }
    listened.forEach(worker => worker.on('close', check));
    timer = setTimeout(() => { cleanup(); reject(new Error('DOCUMENT_WORKERS_NOT_RELEASED')); }, 10000); check();
  }));
}

async function openSample(lease, sample) {
  await selectRole(lease, sample.role);
  const expected = lease.initial.proof.expectedTargets[sample.role];
  if ((sample.entry ?? 'artifact') === 'artifact') {
    await click(lease, tools(lease).locator('#work-tab-artifacts'), 'show artifacts');
    await openResourceArtifactByUi({ page: lease.c.page, sample, workspaceRoot: expected.workspacePath,
      step: (label, operation) => call(lease, label, operation) });
  } else {
    const target = sample.linkSelector ? lease.c.page.locator('#mode-work').locator(sample.linkSelector)
      : sample.linkTitle ? lease.c.page.locator('#mode-work a[title=' + cssAttribute(sample.linkTitle) + ']')
        : lease.c.page.locator('#mode-work a[href=' + cssAttribute(sample.linkHref) + ']');
    await click(lease, target.filter({ visible: true }), 'open conversation file');
  }
  await waitDom(lease, resourceFileSelected, { path: resolveResourcePath(sample.path, expected.workspacePath) }, 'opened resource selected');
  await waitDom(lease, resourcePreviewReady, { kind: sample.kind, path: sample.path,
    workspaceRoot: expected.workspacePath, sessionId: expected.sessionId }, 'session scoped preview');
}
function preview(lease, sample) {
  return lease.c.page.locator('#mode-work [data-document-session=' + cssAttribute(lease.initial.proof.expectedTargets[sample.role].sessionId) + ']')
    .filter({ visible: true }).locator('[data-document-preview=' + cssAttribute(sample.kind) + ']');
}
async function ready(lease, sample, position = {}) {
  const expected = lease.initial.proof.expectedTargets[sample.role];
  await waitDom(lease, resourcePreviewReady, { kind: sample.kind, path: sample.path,
    sessionId: expected.sessionId, workspaceRoot: expected.workspacePath, ...position }, sample.kind + ' rendered');
  const root = preview(lease, sample), alerts = await call(lease, 'preview alerts', () => root.getByRole('alert').allTextContents());
  assert.deepEqual(alerts, [], 'DOCUMENT_PREVIEW_FAILED:' + alerts.join(' '));
  const observed = await snapshot(lease);
  assert.equal(observed.preview?.sessionId, lease.initial.proof.expectedTargets[sample.role].sessionId);
  assert.ok(sameResourcePath(observed.preview.path, sample.path, expected.workspacePath));
  if (sample.kind === 'docx' || sample.kind === 'pptx') {
    const sandbox = await call(lease, 'frame sandbox', () => root.locator('iframe').getAttribute('sandbox'));
    assert.equal(sandbox, '', 'DOCUMENT_FRAME_MUST_BE_SANDBOXED');
    const body = root.frameLocator('iframe').locator('body');
    await call(lease, 'loaded document frame', () => body.waitFor({ state: 'visible', timeout: 10000 }));
    assert.ok(await call(lease, 'nonempty document frame', () => body.evaluate(element => element.childElementCount > 0 && element.clientHeight > 0)), 'DOCUMENT_FRAME_EMPTY');
  }
  return observed.preview;
}
async function navigate(lease, sample) {
  const root = preview(lease, sample);
  if (sample.kind === 'pdf') {
    const before = await ready(lease, sample);
    if (before.totalPages < 2) { lease.control.notExercised.push({ scenario: 'pdf-page-change', reason: 'Selected real PDF has only one page', path: sample.path }); return; }
    await click(lease, root.getByRole('button', { name: '下一页', exact: true }), 'PDF next page');
    const after = await ready(lease, sample, { page: before.page + 1 }); assert.equal(after.page, before.page + 1);
    evidence(lease, 'pdf-navigation', { before, after });
  } else if (sample.kind === 'xlsx') {
    const sheet = root.getByRole('combobox', { name: '工作表', exact: true });
    const options = await call(lease, 'workbook sheets', () => sheet.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, name: element.textContent }))));
    const before = await ready(lease, sample), second = options.find(option => option.value !== before.sheet); let after;
    if (second) {
      await call(lease, 'change worksheet', () => sheet.selectOption(second.value));
      after = await ready(lease, sample, { sheet: second.value, rowStart: 1 }); assert.equal(after.sheet, second.value); evidence(lease, 'worksheet-change', { before, after, options });
    } else lease.control.notExercised.push({ scenario: 'xlsx-sheet-change', reason: 'Selected real workbook has only one worksheet', path: sample.path });
    let paged = false;
    for (const option of options.slice(0, 30)) {
      await call(lease, 'find pageable worksheet', () => sheet.selectOption(option.value));
      const first = await ready(lease, sample, { sheet: option.value, rowStart: 1 });
      if (first.totalPages < 2) continue;
      await click(lease, root.getByRole('button', { name: '下一页', exact: true }), 'workbook next page');
      after = await ready(lease, sample, { sheet: option.value, rowStart: Number(first.rowStart) + 100 }); assert.equal(Number(after.rowStart), Number(first.rowStart) + 100);
      const dimensions = await call(lease, 'bounded worksheet DOM', () => root.locator('table').evaluate(table => ({
        rows: table.querySelectorAll('tbody tr').length, columns: table.querySelector('tbody tr')?.querySelectorAll('td').length ?? 0,
      })));
      assert.ok(dimensions.rows > 0 && dimensions.rows <= 100 && dimensions.columns > 0 && dimensions.columns <= 20);
      evidence(lease, 'worksheet-pagination', { before: first, after, dimensions }); paged = true; break;
    }
    if (!paged) lease.control.notExercised.push({ scenario: 'xlsx-row-pagination', reason: 'No worksheet among the bounded first 30 has more than 100 rows', path: sample.path });
  }
}

async function execute(lease) {
  // The slot prevents another task from submitting while the readonly preflight runs.
  // Temporarily excluding our own marker is unnecessary: use the same observations directly.
  const { c, control, config } = lease;
  const first = await call(lease, 'first idle preflight', () => observeIdle(c), 40000), firstRole = await call(lease, 'original task', () => activeRole(c, first));
  const commands = probeCommandFingerprint(c), ui = await snapshot(lease), inventory = await call(lease, 'window inventory', () => windows(c));
  assert.equal(inventory.length, 1, 'EXACTLY_ONE_EXISTING_WINDOW_REQUIRED');
  const originals = config.samples.map(sample => {
    assert.ok(first.expectedTargets[sample.role], 'UNKNOWN_SAMPLE_ROLE');
    return { ...sample, ...hashResourceSample(sample.path, path.join(c.state.runRoot, 'company')) };
  });
  assert.ok(originals.reduce((sum, sample) => sum + sample.bytes, 0) <= 64 * 1024 * 1024, 'TOTAL_SAMPLE_BYTE_BUDGET');
  const second = await call(lease, 'second idle preflight', () => observeIdle(c), 40000); second.activeRole = await call(lease, 'current task', () => activeRole(c, second));
  assert.deepEqual(stableResourcePreflight(second), stableResourcePreflight(first), 'PREFLIGHT_CHANGED_BETWEEN_READS');
  assert.equal(second.activeRole, firstRole); assert.deepEqual(probeCommandFingerprint(c), commands);
  lease.initial = { proof: second, firstObservedAt: first.observedAt, ui, windows: inventory, originals, commandFingerprint: commands };
  lease.beforeByRole.set(second.activeRole, ui);
  lease.directory = path.join(c.state.evidenceRoot, 'resource-ui-' + Date.now()); fs.mkdirSync(lease.directory);
  control.evidence = lease.directory; control.status = 'running'; evidence(lease, 'prepared', lease.initial);
  await capture(lease, 'before');
  for (const sample of originals) {
    await openSample(lease, sample); await ready(lease, sample); await navigate(lease, sample); await capture(lease, sample.kind + '-rendered');
    await click(lease, tools(lease).locator('#work-tab-activity'), 'hide preview'); await waitWorkersClosed(lease);
    assert.equal(await call(lease, 'hidden preview count', () => c.page.locator('#mode-work [data-document-preview]').count()), 0, 'HIDDEN_PREVIEW_NOT_UNMOUNTED');
    await capture(lease, sample.kind + '-hidden');
  }
  if (config.injectSpreadsheetWorkerError === true) {
    const sample = originals.find(item => item.kind === 'xlsx'); await openSample(lease, sample); await ready(lease, sample);
    const candidates = [];
    for (const worker of c.page.workers()) if (await call(lease, 'worker name', () => worker.evaluate(() => self.name)).catch(() => null) === 'aether-document-spreadsheet') candidates.push(worker);
    assert.equal(candidates.length, 1, 'SPREADSHEET_WORKER_IDENTITY_AMBIGUOUS');
    evidence(lease, 'error-injection-intent', { kind: 'one explicit worker-to-UI parser error', noOriginalWritePerformed: true,
      limitation: 'Fault injection validates error UI and worker disposal; it is not a corrupted-original-file test.', workerUrl: candidates[0].url() });
    await call(lease, 'one parser-error injection', () => candidates[0].evaluate(() => { postMessage({ kind: 'error', message: 'UI validation: deliberate parser failure' }); })).catch(error => {
      // The real UI terminates this worker immediately on its error response.
      if (!/closed|destroyed|terminated/i.test(String(error.message))) throw error;
    });
    await waitDom(lease, () => !!document.querySelector('#mode-work [data-document-preview="xlsx"] [role="alert"]'), null, 'actionable preview error');
    await waitWorkersClosed(lease); await capture(lease, 'expected-preview-error');
    assert.ok((await call(lease, 'preview error text', () => preview(lease, sample).getByRole('alert').innerText())).trim().length > 0);
  } else control.notExercised.push({ scenario: 'parser-error-injection', reason: 'Not requested in fixtureConfig; no corrupted-original claim' });
  await resourceSwitching(lease);
  lease.finishedScenarios = true; control.status = 'restoring';
}

async function resourceSwitching(lease) {
  const sample = lease.initial.originals.find(item => item.kind === 'pdf'), role = sample.role;
  await openSample(lease, sample); await ready(lease, sample);
  const before = await snapshot(lease), document = before.tabs.find(tab => sameResourcePath(tab.title, sample.path, lease.initial.proof.expectedTargets[role].workspacePath)); assert.ok(document);
  const intent = { beforeIds: before.tabs.map(tab => tab.id), createdId: null };
  if (!lease.webIntents.has(role)) lease.webIntents.set(role, []); lease.webIntents.get(role).push(intent);
  await click(lease, list(lease).getByRole('button', { name: '新建网页', exact: true }), 'new built-in webpage');
  await waitDom(lease, newResourceWebSelected, intent.beforeIds, 'new web tab selected');
  const webUi = await snapshot(lease), created = webUi.tabs.filter(tab => !intent.beforeIds.includes(tab.id) && tab.id.startsWith('web:'));
  assert.equal(created.length, 1, 'NEW_WEB_TAB_AMBIGUOUS'); intent.createdId = created[0].id;
  assert.equal(webUi.tabs.find(tab => tab.selected)?.id, intent.createdId);
  assert.deepEqual(webUi.tabs.filter(tab => intent.beforeIds.includes(tab.id)).map(tab => tab.id), intent.beforeIds, 'TAB_ORDER_CHANGED');
  await waitWorkersClosed(lease); await capture(lease, 'document-to-web');
  const anotherRole = Object.keys(lease.initial.proof.expectedTargets).find(item => item !== role); await selectRole(lease, anotherRole);
  const otherUi = await snapshot(lease); assert.ok(!otherUi.tabs.some(tab => tab.id === intent.createdId), 'WEB_RESOURCE_LEAKED_TO_ANOTHER_SESSION');
  await capture(lease, 'other-session'); await selectRole(lease, role); await activateTab(lease, document.id); await ready(lease, sample);
  const back = await snapshot(lease); assert.ok(back.tabs.some(tab => tab.id === intent.createdId));
  await capture(lease, 'return-to-document');
}

export function newResourceWebSelected(beforeIds) {
  const selected = [...document.querySelectorAll('#mode-work [role="tablist"][aria-label="打开的资源"] [role="tab"][aria-selected="true"]')]
    .filter(element => element.getClientRects().length);
  if (selected.length !== 1) return false;
  let fiber = selected[0][Object.keys(selected[0]).find(key => key.startsWith('__reactFiber$'))];
  for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
    if (typeof fiber.key === 'string' && /^web:/.test(fiber.key)) return !beforeIds.includes(fiber.key);
  }
  return false;
}

export function resourceFileSelected(expected) {
  const normalize = value => value?.replace(/\\/g, '/').toLowerCase();
  const selected = [...document.querySelectorAll('#mode-work [role="tablist"][aria-label="打开的资源"] [role="tab"][aria-selected="true"]')]
    .filter(element => element.getClientRects().length);
  return selected.length === 1 && normalize(selected[0].getAttribute('title')) === normalize(expected.path);
}

export function resourceTabAbsent(id) {
  const tabs = [...document.querySelectorAll('#mode-work [role="tablist"][aria-label="打开的资源"] [role="tab"]')];
  return !tabs.some(tab => {
    let fiber = tab[Object.keys(tab).find(key => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) if (fiber.key === id) return true;
    return false;
  });
}

async function restorePreviewPosition(lease, before) {
  const desired = before.preview; if (!desired) return;
  const sample = { kind: desired.kind, path: desired.path, role: Object.keys(lease.initial.proof.expectedTargets)
    .find(role => lease.initial.proof.expectedTargets[role].sessionId === desired.sessionId) };
  assert.ok(sample.role, 'ORIGINAL_PREVIEW_SESSION_UNKNOWN');
  await ready(lease, sample);
  const root = lease.c.page.locator('#mode-work [data-document-preview=' + cssAttribute(desired.kind) + ']').filter({ visible: true });
  if (desired.sheet !== null) {
    const currentSheet = (await snapshot(lease)).preview?.sheet;
    if (currentSheet !== desired.sheet) {
      await call(lease, 'restore worksheet', () => root.getByRole('combobox', { name: '工作表', exact: true }).selectOption(desired.sheet));
      await ready(lease, sample, { sheet: desired.sheet });
    }
  }
  if (desired.page !== null) {
    await call(lease, 'restore document page', () => root.getByRole('spinbutton', { name: '页码', exact: true }).fill(String(desired.page)));
    await ready(lease, sample, { page: desired.page, ...(desired.sheet !== null ? { sheet: desired.sheet, rowStart: Number(desired.rowStart) } : {}) });
  }
  if (desired.columnRange) {
    let matched = false;
    for (let attempt = 0; attempt < 14; attempt++) {
      const current = await snapshot(lease); if (current.preview?.columnRange === desired.columnRange) { matched = true; break; }
      await click(lease, root.getByRole('button', { name: '下一组列', exact: true }), 'restore worksheet columns');
      await waitDom(lease, previous => {
        const preview = document.querySelector('#mode-work [data-document-preview="xlsx"]');
        return preview?.querySelector('[data-document-column-range]')?.textContent?.trim() !== previous && !!preview?.querySelector('table');
      }, current.preview?.columnRange, 'restored column render');
      await ready(lease, sample);
    }
    assert.ok(matched, 'ORIGINAL_COLUMN_RANGE_NOT_RESTORED');
    await ready(lease, sample, { columnRange: desired.columnRange });
  }
  if (desired.zoom !== null) await call(lease, 'restore document zoom', () => root.getByRole('combobox', { name: '缩放', exact: true }).selectOption(desired.zoom));
}

async function restoreAndRelease(lease) {
  const { c, control } = lease; assertLease(lease);
  if (lease.track.pending) { control.status = 'needs-reconciliation'; control.restoreErrors = ['A timed-out UI/read operation is still pending; no automatic replay or restoration.']; return; }
  assert.ok(!lease.restoring, 'RESTORATION_ALREADY_RUNNING'); lease.restoring = true; control.restoreErrors = [];
  const attempt = async (label, action) => { try { await action(); } catch (error) { control.restoreErrors.push(label + ': ' + errorText(error)); } };
  try {
    if (lease.initial) {
      const pre = await call(lease, 'restore identity preflight', () => observeIdle(c), 40000);
      assert.deepEqual(stableResourcePreflight(pre), stableResourcePreflight(lease.initial.proof), 'ENGINE_OR_ROOTS_CHANGED_BEFORE_RESTORE');
      const restorationOrder = [...lease.beforeByRole].sort(([left], [right]) => Number(left === lease.initial.proof.activeRole) - Number(right === lease.initial.proof.activeRole));
      for (const [role, before] of restorationOrder) await attempt('restore ' + role, async () => {
        await selectRole(lease, role);
        const workspaceRoot = lease.initial.proof.expectedTargets[role].workspacePath;
        await restoreResourceArtifactSelection({ page: c.page, before, workspaceRoot,
          step: (label, operation, timeout) => call(lease, label, operation, timeout),
          rememberPath: file => { if (!lease.restoreFileIntents.has(role)) lease.restoreFileIntents.set(role, new Set()); lease.restoreFileIntents.get(role).add(file); } });
        const after = await snapshot(lease), intended = [...lease.initial.originals.filter(sample => sample.role === role).map(sample => sample.path), ...(lease.restoreFileIntents.get(role) || [])];
        for (const tab of ownedResourceCleanup(before, after, intended, lease.webIntents.get(role) || [], workspaceRoot)) {
          const current = await snapshot(lease), actual = current.tabs.find(item => item.id === tab.id); if (!actual) continue;
          await click(lease, list(lease).getByRole('tab').nth(actual.index).locator('..').getByRole('button', { name: actual.closeLabel, exact: true }), 'close test resource');
          await waitDom(lease, resourceTabAbsent, tab.id, 'closed resource removed');
        }
        await click(lease, tools(lease).locator('#work-tab-activity'), 'unmount final preview'); await waitWorkersClosed(lease);
        const selected = before.tabs.find(tab => tab.selected); if (selected) await activateTab(lease, selected.id);
        if (before.selectedTool) await click(lease, tools(lease).locator('#' + before.selectedTool), 'restore workspace tool');
        if (before.selectedTool === 'work-tab-artifacts' && before.artifactDetail) {
          await click(lease, c.page.getByRole('tablist', { name: '成果内容', exact: true }).getByRole('tab', { name: before.artifactDetail, exact: true }), 'restore artifact detail');
        }
        await restorePreviewPosition(lease, before);
        const restored = await snapshot(lease);
        assert.deepEqual(restored.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id), 'RESOURCE_SET_OR_ORDER_NOT_RESTORED');
        assert.equal(restored.tabs.find(tab => tab.selected)?.id, before.tabs.find(tab => tab.selected)?.id, 'SELECTED_RESOURCE_NOT_RESTORED');
        assert.equal(restored.selectedTool, before.selectedTool);
        if (before.selectedTool === 'work-tab-artifacts') {
          assert.equal(restored.artifactTitle, before.artifactTitle, 'ARTIFACT_SELECTION_NOT_RESTORED');
          assert.equal(restored.artifactDetail, before.artifactDetail, 'ARTIFACT_DETAIL_NOT_RESTORED');
        }
        await call(lease, 'restore scroll positions', () => c.page.evaluate(restoreResourceScrolls, before.scrolls));
      });
      await attempt('original task', () => selectRole(lease, lease.initial.proof.activeRole));
      await attempt('original window', async () => assert.deepEqual(await call(lease, 'final native windows', () => windows(c)), lease.initial.windows, 'WINDOW_SET_CHANGED'));
      await attempt('company originals', async () => {
        const after = lease.initial.originals.map(sample => hashResourceSample(sample.path, path.join(c.state.runRoot, 'company')));
        after.forEach((value, index) => assert.equal(value.sha256, lease.initial.originals[index].sha256, 'ORIGINAL_FILE_CHANGED')); evidence(lease, 'originals-after', after);
      });
      await attempt('final readonly proof', async () => {
        const first = await call(lease, 'final idle preflight one', () => observeIdle(c), 40000);
        const second = await call(lease, 'final idle preflight two', () => observeIdle(c), 40000);
        assert.deepEqual(stableResourcePreflight(first), stableResourcePreflight(lease.initial.proof));
        assert.deepEqual(stableResourcePreflight(second), stableResourcePreflight(first));
        evidence(lease, 'final-preflight', { first, second }); await capture(lease, 'restored');
      });
    }
  } catch (error) { control.restoreErrors.push(errorText(error)); }
  finally {
    lease.restoring = false; control.finishedAt = now();
    if (lease.track.pending) control.status = 'needs-reconciliation';
    else {
      // A settled view failure need not block future model work. Restoration
      // failures remain explicit in the result instead of hiding the original error.
      assertLease(lease); Object.assign(c, lease.originalMethods); c.resourceUiProbePromise = null;
      control.leaseActive = false; c.page.off('worker', lease.onWorker);
      control.status = control.cancelled ? 'cancelled' : lease.finishedScenarios && !control.failures.length && !control.restoreErrors.length
        ? control.notExercised.length ? 'passed-with-unexercised-scenarios' : 'passed' : 'failed';
    }
    try { evidence(lease, 'result', control); } catch (error) { control.evidenceError = errorText(error); if (control.status.startsWith('passed')) control.status = 'failed'; }
  }
}

export function queryOfficeResourceUiValidation(c) { return c.resourceUiProbeControl ? structuredClone(c.resourceUiProbeControl) : { started: false }; }
export function cancelOfficeResourceUiValidation(c) {
  const lease = owners.get(c); assert.ok(lease?.control.leaseActive, 'NO_ACTIVE_UI_VALIDATION');
  lease.control.cancelled = true; lease.control.cancelRequestedAt = now(); return { requested: true, noModelCancellation: true };
}
export async function reconcileOfficeResourceUiValidation(c) {
  const lease = owners.get(c); assert.ok(lease?.control.leaseActive && !lease.control.running, 'NO_SETTLED_HELD_UI_VALIDATION');
  assert.equal(lease.track.pending, 0, 'OPERATIONS_STILL_PENDING'); await restoreAndRelease(lease); return queryOfficeResourceUiValidation(c);
}
