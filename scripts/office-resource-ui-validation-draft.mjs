/** Offline draft for root's single owned Electron runner. Import has no live effects.
 * No app launch, Inspector attachment, HTTP server, direct open-file IPC or model send.
 * Final preview selectors are deliberately supplied by root after the product build.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { observeOfficeVerifiedSubmitInstallation } from './office-verified-submit-adapter.mjs';
import { probeCommandFingerprint, createProbeOperationTracker } from './office-context-probe-lifecycle.mjs';

const formats = ['docx', 'xlsx', 'pptx', 'pdf'];
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const now = () => new Date().toISOString();
const requiredHooks = ['openSampleByUi', 'assertPreview', 'exercisePdfPages', 'exerciseWorkbookPagesAndSheets', 'exercisePreviewError', 'exerciseResourceAndSessionSwitching'];

/** Renderer-only bounded observation. Does not select a tab or invoke a controller. */
export function readWorkResourceUi() {
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const work = document.querySelector('#mode-work');
  const lists = work ? [...work.querySelectorAll('[role="tablist"][aria-label="打开的资源"]')].filter(visible) : [];
  const tools = work ? [...work.querySelectorAll('[role="toolbar"][aria-label="工作区工具"]')].filter(visible) : [];
  const rows = work ? [...work.querySelectorAll('.work-sidebar__task[aria-current="true"]')].filter(visible) : [];
  const tabs = lists.length === 1 ? [...lists[0].querySelectorAll('[role="tab"]')].map(tab => ({
    title: tab.getAttribute('title'), name: tab.textContent?.trim() ?? '', selected: tab.getAttribute('aria-selected') === 'true',
    closeLabel: tab.parentElement?.querySelector('button[aria-label^="关闭"]')?.getAttribute('aria-label') ?? null,
  })) : [];
  return { workVisible: visible(work) && work.getAttribute('aria-hidden') === 'false', resourceListCount: lists.length,
    toolbarCount: tools.length, activeTaskTitles: rows.map(row => row.getAttribute('title')), tabs,
    selectedTool: tools.length === 1 ? tools[0].querySelector('button[aria-pressed="true"]')?.id ?? null : null,
    previewTitles: work ? [...work.querySelectorAll('.work-artifact-panel-v2__title')].filter(visible).map(row => row.getAttribute('title')) : [],
    frames: work ? [...work.querySelectorAll('iframe')].filter(visible).slice(0, 16).map(frame => ({
      title: frame.title, sandbox: frame.getAttribute('sandbox'), src: frame.getAttribute('src'),
      hasSrcdoc: frame.hasAttribute('srcdoc'), width: frame.clientWidth, height: frame.clientHeight,
    })) : [],
    url: location.href };
}

/** Read exact selected files only. Never discover recursively or modify company originals. */
export function hashResourceSample(file, companyRoot, maxBytes = 32 * 1024 * 1024) {
  const root = path.resolve(companyRoot), resolved = path.resolve(file), relative = path.relative(root, resolved);
  assert.ok(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'SAMPLE_OUTSIDE_COMPANY');
  assert.ok(samePath(fs.realpathSync(root), root) && samePath(fs.realpathSync(resolved), resolved), 'SAMPLE_REDIRECTED');
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false, 'SAMPLE_SYMLINK');
  const fd = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(fd);
    assert.ok(before.isFile() && before.size > 0 && before.size <= maxBytes, 'SAMPLE_SIZE_BUDGET');
    const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(64 * 1024, before.size));
    for (let offset = 0; offset < before.size;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      assert.ok(count > 0, 'SAMPLE_SHORT_READ'); digest.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fs.statSync(resolved);
    for (const key of ['dev', 'ino', 'birthtimeMs', 'mtimeMs', 'size']) assert.equal(after[key], before[key], 'SAMPLE_CHANGED_DURING_HASH');
    return { path: resolved, bytes: before.size, sha256: digest.digest('hex'), mtimeMs: before.mtimeMs };
  } finally { fs.closeSync(fd); }
}

export function resourceUiScenarioPlan(samples) {
  assert.ok(Array.isArray(samples) && samples.length <= 4, 'FOUR_FORMATS_MAXIMUM');
  for (const sample of samples) {
    assert.ok(formats.includes(sample.kind) && typeof sample.role === 'string' && typeof sample.path === 'string', 'SAMPLE_IDENTITY_REQUIRED');
    assert.ok(['artifact', 'conversation'].includes(sample.entry), 'REAL_ARTIFACT_OR_CONVERSATION_ENTRY_REQUIRED');
    assert.equal(path.extname(sample.path).toLowerCase(), '.' + sample.kind, 'SAMPLE_EXTENSION_MISMATCH');
  }
  assert.equal(new Set(samples.map(sample => sample.kind)).size, samples.length, 'DUPLICATE_SAMPLE_FORMAT');
  return { schemaVersion: 1, status: 'draft-awaiting-final-preview-selectors', formats: samples.map(sample => sample.kind),
    requiredFormats: formats, requiredHooks, scenarios: [
      'Four original files opened through real artifact/conversation clicks and session authorization',
      'DOCX/PPTX visible render; XLSX sheet change and row pagination; PDF page change',
      'Document and built-in webpage share the resource tablist; preserve opening order',
      'Document to webpage to another existing session; previews hidden and new workers closed',
      'Return to original session and resource selection; close only resources created by this test',
      'Actionable preview failure and worker cleanup without shell, native Office or HTTP server',
      'Original SHA-256, root run IDs, queue state, engine identity and native-window inventory unchanged',
    ] };
}

function assertNoOtherOwner(c) {
  assert.ok(!c.contextProbePromise && !c.uiLoadProbePromise && !c.resourceUiProbePromise, 'ANOTHER_UI_PROBE_OWNS_RUNNER');
  assert.ok(!c.state.contextCompactionProbeControl?.leaseActive, 'CONTEXT_PROBE_LEASE_HELD');
  const submit = c.verifiedSubmitInstallation?.inspect?.();
  assert.ok(!submit?.active && !submit?.pendingOperations && !submit?.lease && !submit?.routeActive && !submit?.projectionPending && !submit?.projectionReads, 'SUBMISSION_RECOVERY_OWNS_RUNNER');
  for (const name of Object.keys(c)) if (/MaintenanceLease/.test(name)) assert.ok(!c[name]?.active, 'MAINTENANCE_OWNS_RUNNER');
}

async function windowInventory(c) {
  return c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id,
    webContentsId: window.webContents.id, url: window.webContents.getURL() })).sort((a, b) => a.id - b.id));
}

/** Explicit read-only preparation. An empty sample list returns a selector/coverage plan. */
export async function prepareOfficeResourceUiValidation(c, { samples = [] } = {}) {
  const plan = resourceUiScenarioPlan(samples); assertNoOtherOwner(c);
  const proof = await observeOfficeVerifiedSubmitInstallation(c);
  const ui = await c.page.evaluate(readWorkResourceUi);
  assert.ok(ui.workVisible && ui.resourceListCount === 1 && ui.toolbarCount === 1, 'UNIFIED_RESOURCE_UI_NOT_BUILT');
  assert.ok(ui.activeTaskTitles.length === 1 && ui.tabs.length <= 64, 'RESOURCE_UI_AMBIGUOUS');
  assert.ok(ui.tabs.every(tab => tab.title && tab.closeLabel) && new Set(ui.tabs.map(tab => tab.title)).size === ui.tabs.length, 'RESOURCE_RESTORE_IDENTITY_AMBIGUOUS');
  const originals = samples.map(sample => {
    assert.ok(proof.expectedTargets[sample.role], 'UNKNOWN_SAMPLE_ROLE');
    return { ...sample, ...hashResourceSample(sample.path, path.join(c.state.runRoot, 'company')) };
  });
  assert.ok(originals.reduce((sum, row) => sum + row.bytes, 0) <= 64 * 1024 * 1024, 'TOTAL_SAMPLE_BYTE_BUDGET');
  return { schemaVersion: 1, preparedAt: now(), plan, proof, ui, originals,
    commandFingerprint: probeCommandFingerprint(c), windows: await windowInventory(c),
    workerUrls: c.page.workers().map(worker => worker.url()).sort() };
}

/** Draft execution scaffold. Missing final renderer hooks refuses before any live read.
 * Hooks receive only the existing Playwright page plus observed sample metadata;
 * openSampleByUi must click an existing artifact or conversation link, never IPC.
 */
export async function runOfficeResourceUiValidation(c, { samples, hooks } = {}) {
  resourceUiScenarioPlan(samples);
  assert.deepEqual([...samples.map(sample => sample.kind)].sort(), [...formats].sort(), 'ALL_FOUR_REAL_SAMPLES_REQUIRED');
  assert.equal(new Set(samples.map(sample => sample.entry)).size, 2, 'BOTH_ARTIFACT_AND_CONVERSATION_ENTRY_REQUIRED');
  for (const name of requiredHooks) assert.equal(typeof hooks?.[name], 'function', 'FINAL_SELECTOR_HOOK_REQUIRED:' + name);
  const prepared = await prepareOfficeResourceUiValidation(c, { samples });
  const directory = path.join(c.state.evidenceRoot, 'resource-ui-' + Date.now());
  assert.ok(samePath(fs.realpathSync(c.state.evidenceRoot), c.state.evidenceRoot), 'EVIDENCE_ROOT_REDIRECTED');
  fs.mkdirSync(directory);
  const control = { schemaVersion: 1, status: 'running', startedAt: now(), evidence: directory, leaseActive: true,
    pendingOperations: 0, pendingOperationDetails: [], steps: [], restoreErrors: [] };
  const track = createProbeOperationTracker(control, { readMs: 15000 });
  const originals = Object.fromEntries(['submit', 'createAndStart', 'selectTask'].map(name => [name, c[name]]));
  const guards = Object.fromEntries(Object.keys(originals).map(name => [name, async () => { throw new Error('RESOURCE_UI_PROBE_OWNS_RUNNER'); }]));
  const liveWorkers = new Set(), workerEvents = [], created = new Map();
  const onWorker = worker => {
    liveWorkers.add(worker); workerEvents.push({ type: 'created', at: now(), url: worker.url() });
    worker.on('close', () => { liveWorkers.delete(worker); workerEvents.push({ type: 'closed', at: now(), url: worker.url() }); });
  };
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const call = (label, fn) => {
    assert.deepEqual(probeCommandFingerprint(c), prepared.commandFingerprint, 'COMMANDS_CHANGED_DURING_UI_PROBE');
    for (const [name, guard] of Object.entries(guards)) assert.equal(c[name], guard, 'UI_PROBE_GUARD_REPLACED');
    return track.run(label, fn);
  };
  const ui = () => call('resource-ui-snapshot', () => c.page.evaluate(readWorkResourceUi));
  const capture = async label => {
    assert.ok(/^[a-z0-9-]+$/.test(label), 'EVIDENCE_LABEL_INVALID');
    const state = await ui(), screenshot = path.join(directory, label + '.png');
    assert.ok(!fs.existsSync(screenshot), 'SCREENSHOT_ALREADY_EXISTS');
    await call('screenshot-' + label, () => c.page.screenshot({ path: screenshot }));
    const row = { label, at: now(), ui: state, liveNewWorkers: [...liveWorkers].map(worker => worker.url()) };
    write(label + '.json', row); control.steps.push(row); return row;
  };
  const waitReleased = () => call('preview-workers-closed', async () => {
    // Event-driven wait: an elapsed timeout is not proof of worker termination.
    await new Promise((resolve, reject) => {
      if (!liveWorkers.size) { resolve(); return; }
      const watched = [...liveWorkers]; let timer;
      const check = () => { if (!liveWorkers.size) { clearTimeout(timer); resolve(); } };
      watched.forEach(worker => worker.once('close', check));
      timer = setTimeout(() => reject(new Error('PREVIEW_WORKERS_STILL_ALIVE')), 10000);
    });
  });
  const tablist = () => c.page.getByRole('tablist', { name: '打开的资源', exact: true });
  const clickOnly = async (locator, label) => {
    assert.equal(await call(label + '-count', () => locator.count()), 1, label + '-AMBIGUOUS');
    await call(label, () => locator.click());
  };
  const selectRole = role => call('select-' + role, () => originals.selectTask(role));
  let resolveSlot;
  c.resourceUiProbePromise = new Promise(resolve => { resolveSlot = resolve; });
  c.resourceUiProbeControl = control; Object.assign(c, guards); c.page.on('worker', onWorker);
  try {
    write('prepared.json', prepared);
    await capture('before');
    for (const sample of prepared.originals) {
      await selectRole(sample.role);
      const before = await ui();
      await call('open-ui-' + sample.kind, () => hooks.openSampleByUi({ page: c.page, sample }));
      const preview = await call('preview-' + sample.kind, () => hooks.assertPreview({ page: c.page, sample,
        expectedSessionId: prepared.proof.expectedTargets[sample.role].sessionId }));
      assert.equal(preview?.ready, true, 'PREVIEW_NOT_READY');
      assert.equal(preview.sessionId, prepared.proof.expectedTargets[sample.role].sessionId, 'PREVIEW_SESSION_NOT_PROVEN');
      assert.ok(samePath(preview.path, sample.path), 'PREVIEW_FILE_NOT_PROVEN');
      const after = await ui(), added = after.tabs.filter(tab => !before.tabs.some(prior => prior.title === tab.title));
      const selected = after.tabs.filter(tab => tab.selected);
      assert.equal(selected.length, 1, 'RESOURCE_SELECTION_AMBIGUOUS'); assert.ok(samePath(selected[0].title, sample.path), 'WRONG_FILE_RESOURCE');
      if (!created.has(sample.role)) created.set(sample.role, []); created.get(sample.role).push(...added);
      write(sample.kind + '-render.json', preview);
      if (sample.kind === 'pdf') {
        const pages = await call('pdf-pages', () => hooks.exercisePdfPages({ page: c.page, sample }));
        assert.ok(Number.isSafeInteger(pages?.beforePage) && Number.isSafeInteger(pages?.afterPage) && pages.afterPage !== pages.beforePage
          && pages.beforePage >= 1 && pages.afterPage >= 1 && pages.afterPage <= pages.totalPages, 'PDF_PAGE_CHANGE_NOT_PROVEN');
        write('pdf-navigation.json', pages);
      }
      if (sample.kind === 'xlsx') {
        const workbook = await call('xlsx-pages-sheets', () => hooks.exerciseWorkbookPagesAndSheets({ page: c.page, sample }));
        assert.ok(typeof workbook?.beforeSheet === 'string' && typeof workbook?.afterSheet === 'string' && workbook.beforeSheet !== workbook.afterSheet
          && Number.isSafeInteger(workbook.beforeRowStart) && Number.isSafeInteger(workbook.afterRowStart)
          && workbook.beforeRowStart !== workbook.afterRowStart && workbook.renderedRows > 0 && workbook.renderedRows <= 100
          && workbook.renderedColumns > 0 && workbook.renderedColumns <= 20, 'WORKBOOK_NAVIGATION_NOT_PROVEN');
        write('xlsx-navigation.json', workbook);
      }
      await capture(sample.kind + '-visible');
      await clickOnly(c.page.getByRole('toolbar', { name: '工作区工具', exact: true }).locator('#work-tab-activity'), 'hide-' + sample.kind);
      await waitReleased(); await capture(sample.kind + '-hidden');
    }
    // Root supplies the error fixture through the real UI; it must not overwrite originals.
    write('preview-error.json', await call('preview-error', () => hooks.exercisePreviewError({ page: c.page, samples: prepared.originals })));
    // Document/web/session switching is deliberately a required final hook until
    // the native BrowserView reveal and document selectors are frozen in the build.
    write('resource-switching.json', await call('resource-switching', () => hooks.exerciseResourceAndSessionSwitching({
      page: c.page, samples: prepared.originals, selectRole, capture, created, tablist,
    })));
    control.status = 'verified-awaiting-restore';
  } catch (error) { control.status = 'failed'; control.error = String(error?.stack ?? error).slice(0, 8000); }
  finally {
    // A timed-out operation can still change the page. Keep the guard; root must
    // explicitly reconcile after it settles before attempting any UI restoration.
    if (track.pending) control.restoreErrors.push('PENDING_OPERATION_REQUIRES_EXPLICIT_RECONCILIATION');
    else try {
      for (const [role, tabs] of created) {
        await selectRole(role);
        for (const tab of [...tabs].reverse()) {
          const current = await ui();
          if (current.tabs.some(row => row.title === tab.title)) await clickOnly(tablist().getByRole('button', { name: tab.closeLabel, exact: true }), 'close-created-resource');
        }
      }
      await waitReleased();
      await selectRole(prepared.proof.activeRole);
      const selected = prepared.ui.tabs.find(tab => tab.selected);
      if (selected) await clickOnly(tablist().locator('[role="tab"][title=' + JSON.stringify(selected.title) + ']'), 'restore-resource');
      if (prepared.ui.selectedTool) await clickOnly(c.page.locator('#' + prepared.ui.selectedTool), 'restore-workspace-tool');
      const finalUi = await ui();
      assert.deepEqual(finalUi.activeTaskTitles, prepared.ui.activeTaskTitles, 'ACTIVE_TASK_NOT_RESTORED');
      assert.equal(finalUi.selectedTool, prepared.ui.selectedTool, 'WORKSPACE_TOOL_NOT_RESTORED');
      assert.deepEqual(await call('windows-after', () => windowInventory(c)), prepared.windows, 'NATIVE_WINDOW_INVENTORY_CHANGED');
      const afterHashes = prepared.originals.map(sample => hashResourceSample(sample.path, path.join(c.state.runRoot, 'company')));
      afterHashes.forEach((row, index) => assert.equal(row.sha256, prepared.originals[index].sha256, 'COMPANY_ORIGINAL_CHANGED'));
      write('originals-after.json', afterHashes);
      const afterProof = await call('roots-and-queues-after', () => observeOfficeVerifiedSubmitInstallation(c));
      assert.deepEqual(afterProof.engine, prepared.proof.engine, 'ENGINE_CHANGED_DURING_UI_PROBE');
      for (const role of Object.keys(prepared.proof.roles)) {
        assert.equal(afterProof.roles[role].runId, prepared.proof.roles[role].runId, 'UNEXPECTED_NEW_ROOT');
        assert.equal(afterProof.roles[role].queueSha256, prepared.proof.roles[role].queueSha256, 'QUEUE_CHANGED_DURING_UI_PROBE');
      }
      write('after-proof.json', afterProof); await capture('restored');
    } catch (error) { control.restoreErrors.push(String(error?.stack ?? error).slice(0, 8000)); }
    control.finishedAt = now(); control.workerEvents = workerEvents;
    if (!control.restoreErrors.length && track.pending === 0) {
      Object.assign(c, originals); c.resourceUiProbePromise = null; control.leaseActive = false;
      control.status = control.status === 'verified-awaiting-restore' ? 'passed' : 'failed-restored';
    } else control.status = 'needs-reconciliation';
    c.page.off('worker', onWorker); write('result.json', control); resolveSlot(structuredClone(control));
  }
  return structuredClone(control);
}
