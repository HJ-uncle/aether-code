/** Existing six-role campaign adapter. Imports do not inspect or operate a live runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVerifiedOfficeSubmit } from './office-verified-submit.mjs';
import { createReadonlyWorkQueueReader } from './office-readonly-work-queue.mjs';

const ROOT = 'D:/dev/aether-code/.ae/office-company-20261023163242581';
const RUNNER = 'D:/dev/aether-code/scripts/run-office-company-campaign.mjs';
const UPGRADE_SHA = 'dc65951458b21c13b99da1da7dad5d5b45445b44dac4fe715f36380985915464';
const ENGINE_ID = '92b7da1d-8051-4f3d-8f5d-648f2381d9d0';
const BUILD = 'sha256:b19361d1502197a1297555ab610c4f7054bdacf5256b00100fcd3b23534a3722';
const QUEUE_PINS = { 'src/shared/next-turn-queue.ts': '7810556a265d81938d9ae8dcba30d8ae57f088d71a41c50e4d1e335967a83918',
  'src/shared/next-turn-queue-state.ts': '679efcdbfda7fc5f47438877e6436d610deaa7e204ffe07c347de4da5aa498eb',
  'src/main/next-turn-queue-store.ts': 'b5520f295b12fbaf34463db63387e32bfaac6a39897e6dfc115c7e63f6040f32' };
export const OFFICE_SUBMIT_FOOTER = '\n核验定位要求：manifest claims 使用 {id,value,unit,period,basis,status,evidence:[{path,sha256,kind,sheet,cell}]}；按实际产物填写，不编造渲染或计算通过。先使用可用的内置办公skill，缺能力时尝试本会话真实可用工具并如实记录。';
const sha = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const need = (yes, code) => { if (!yes) throw Object.assign(new Error(code), { code }); };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const preparations = new WeakMap();
const installations = new WeakMap();
const engineKeys = ['mode', 'phase', 'adopted', 'instanceId', 'accountId', 'pid', 'buildId', 'baseUrl', 'dataDir', 'entryPath'];
const engineIdentity = value => Object.fromEntries(engineKeys.map(key => [key, value[key]]));

export function effectiveOfficePrompt(raw) {
  need(typeof raw === 'string' && raw.trim().length > 0 && Buffer.byteLength(raw) <= 1024 * 1024, 'STAGE_PROMPT_INVALID');
  // Raw stages may already carry exactly the standard suffix. Never append twice
  // or silently strip a different instruction from the user's actual text.
  const effective = raw.endsWith(OFFICE_SUBMIT_FOOTER) ? raw : raw + OFFICE_SUBMIT_FOOTER;
  need(!effective.slice(0, -OFFICE_SUBMIT_FOOTER.length).includes(OFFICE_SUBMIT_FOOTER), 'STAGE_FOOTER_AMBIGUOUS');
  return { text: effective, rawSha256: sha(raw), effectiveSha256: sha(effective), footerAppended: effective !== raw };
}

/** Executes inside the renderer. Reads only DOM/localStorage and existing React props. */
export function readActiveWorkSnapshot({ storageKey }) {
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const surface = document.querySelector('#mode-work');
  const editors = surface ? [...surface.querySelectorAll('.input-composer__input[role="textbox"]')].filter(visible) : [];
  const currentRows = surface ? [...surface.querySelectorAll('.work-sidebar__task[aria-current="true"]')].filter(visible) : [];
  const raw = localStorage.getItem(storageKey);
  if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) throw new Error('WORK_STORAGE_MISSING_OR_OVERSIZED');
  const state = JSON.parse(raw);
  if (!Array.isArray(state.tasks) || state.tasks.length > 1024) throw new Error('WORK_STORAGE_TASKS_INVALID');
  const project = task => task ? ({ id: task.id, title: task.title, agentId: task.agentId, modelId: task.modelId,
    workspacePath: task.workspacePath, archived: task.archived === true }) : null;
  const editor = editors.length === 1 ? editors[0] : null;
  const key = editor && Object.keys(editor).find(name => name.startsWith('__reactFiber$'));
  let fiber = key ? editor[key] : null, controller = null, workHome = null;
  for (let depth = 0; fiber && depth < 48; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props?.controller?.activeTask && typeof props.controller.draftSource === 'string') {
      controller = props.controller; workHome = props.home === true; break;
    }
  }
  return { workVisible: surface?.getAttribute('aria-hidden') === 'false' && visible(surface), editorCount: editors.length,
    currentRows: currentRows.map(row => row.getAttribute('title')), storageKey, activeTaskId: state.activeTaskId,
    tasks: state.tasks.map(project), controller: controller ? { task: project(controller.activeTask), home: workHome,
      draftSource: controller.draftSource, modelId: controller.modelId || controller.defaultModelId,
      ready: controller.ready, modelReady: controller.modelReady, error: controller.error ?? null,
      loading: controller.loading, streaming: controller.streaming, launching: controller.launching,
      uploading: controller.uploading, historyReady: controller.historyReady, pendingCount: controller.pending?.length,
      attachments: controller.attachments?.length, mentions: controller.mentions?.length,
      queueReady: controller.nextTurnQueue?.ready, queueSaving: controller.nextTurnQueue?.saving,
      queueDispatchError: controller.nextTurnQueue?.error ?? null } : null,
    editorText: editor?.innerText ?? null,
    sendLabels: surface ? [...surface.querySelectorAll('button.chat__send')].filter(visible).map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })) : [] };
}

export function validateActiveWorkSnapshot(snapshot, expected, { idle = false } = {}) {
  const persisted = snapshot?.tasks?.filter(task => task.id === expected.sessionId) ?? [];
  need(persisted.length === 1 && !persisted[0].archived, 'WORK_TASK_MISSING_OR_AMBIGUOUS');
  need(snapshot.workVisible && snapshot.editorCount === 1 && snapshot.activeTaskId === expected.sessionId
    && snapshot.currentRows.length === 1 && snapshot.currentRows[0] === persisted[0].title, 'WORK_ACTIVE_DOM_MISMATCH');
  const controller = snapshot.controller;
  need(controller && !controller.home && controller.task?.id === expected.sessionId, 'WORK_ACTIVE_CONTROLLER_MISMATCH');
  need(snapshot.storageKey === 'aether.work.state.v1:' + encodeURIComponent(':account:' + expected.engine.accountId)
    && controller.draftSource === ':account:' + expected.engine.accountId, 'WORK_ACTIVE_SOURCE_MISMATCH');
  for (const task of [persisted[0], controller.task]) need(task.agentId === expected.agentId && task.modelId === expected.modelId
    && samePath(task.workspacePath, expected.workspacePath), 'WORK_ACTIVE_BINDING_MISMATCH');
  need(controller.modelId === expected.modelId && controller.ready === true && controller.modelReady === true
    && controller.attachments === 0 && controller.mentions === 0, 'WORK_COMPOSER_SELECTION_MISMATCH');
  if (idle) need(controller.loading === false && controller.streaming === false && controller.launching === false
    && controller.uploading === false && controller.historyReady === true && controller.pendingCount === 0
    && !controller.error && !controller.queueDispatchError && controller.queueReady === true && controller.queueSaving === false, 'WORK_COMPOSER_NOT_IDLE');
  return persisted[0];
}

/** A false admission must throw because the legacy command loop treats returns as success. */
export function bridgeVerifiedAdmission(c, journal, result) {
  need(result?.admitted === true, 'VERIFIED_ADMISSION_UNCERTAIN:' + (result?.code ?? 'UNKNOWN'));
  const records = journal.submissions.filter(row => row.id === result.commandId);
  need(records.length === 1 && records[0].phase === 'admitted', 'VERIFIED_RECORD_NOT_ADMITTED');
  const record = records[0], publication = record.bindingPublication;
  need(publication && sha(publication.text) === publication.sha256, 'VERIFIED_PUBLICATION_CHANGED');
  const binding = JSON.parse(publication.text), owner = c.state.roles[record.role];
  need(owner && binding.commandId === record.id && binding.role === record.role && binding.actualAdmittedRun.runId === result.runId, 'VERIFIED_PROJECTION_IDENTITY_CHANGED');
  const projection = { id: record.id, kind: record.kind, revision: record.revision, phase: 'admitted',
    beforeRunId: record.beforeRunId, runId: binding.actualAdmittedRun.runId, actualAdmittedRun: binding.actualAdmittedRun,
    promptSha256: record.promptSha256, rawStagePromptSha256: record.rawStagePromptSha256, effectivePromptSha256: record.effectivePromptSha256,
    startedAt: record.startedAt, admittedAt: record.admittedAt, recordedAt: binding.recordedAt, bindingPath: result.binding,
    admissionSemantics: 'verified-single-ui-click-and-unique-persisted-user' };
  const matches = owner.submissions.filter(row => row.id === record.id);
  need(matches.length <= 1, 'LEGACY_PROJECTION_AMBIGUOUS');
  if (matches.length) for (const [key, value] of Object.entries(projection)) assert.deepEqual(matches[0][key], value, 'LEGACY_PROJECTION_CHANGED');
  else owner.submissions.push(projection);
  c.save(); return result;
}

function verifyPublishedBytes(file, publication, limit = 8 * 1024 * 1024) {
  need(typeof publication?.text === 'string' && Buffer.byteLength(publication.text) === publication.bytes
    && publication.bytes > 0 && publication.bytes <= limit && sha(publication.text) === publication.sha256, 'PUBLICATION_INTENT_INVALID');
  need(samePath(fs.realpathSync(path.dirname(file)), path.dirname(file)) && samePath(fs.realpathSync(file), file)
    && !fs.lstatSync(file).isSymbolicLink(), 'PUBLICATION_REDIRECTED');
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    need(before.isFile() && before.size === publication.bytes, 'PUBLICATION_SIZE_CHANGED');
    const bytes = Buffer.alloc(publication.bytes);
    for (let offset = 0; offset < bytes.length;) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      need(count > 0, 'PUBLICATION_SHORT_READ'); offset += count;
    }
    const after = fs.statSync(file);
    for (const key of ['dev', 'ino', 'birthtimeMs', 'mtimeMs', 'size']) need(before[key] === after[key], 'PUBLICATION_CHANGED_DURING_READ');
    need(samePath(fs.realpathSync(file), file) && bytes.equals(Buffer.from(publication.text)) && sha(bytes) === publication.sha256, 'PUBLICATION_BYTES_CHANGED');
  } finally { fs.closeSync(fd); }
}

/** Re-project an already admitted record after legacy save failure; never send again. */
export async function reconcileVerifiedAdmissionProjection(c, journal, commandId, { readTarget, evidenceDir }) {
  const matches = journal.submissions.filter(row => row.id === commandId);
  need(matches.length === 1 && matches[0].phase === 'admitted' && journal.lease === null, 'PROJECTION_RECONCILIATION_NOT_ALLOWED');
  const record = matches[0];
  need(record.clickRequested === true && /^[a-zA-Z0-9_-]{1,160}$/.test(record.id), 'PROJECTION_RECORD_INVALID');
  const actual = await readTarget(record.role);
  const normalize = value => ({ ...value, workspacePath: path.resolve(value.workspacePath) });
  assert.deepEqual(normalize(actual), normalize(record.target), 'PROJECTION_TARGET_CHANGED');
  const publication = record.bindingPublication, file = path.join(evidenceDir, record.id + '.verified-binding.json');
  need(samePath(record.binding?.path, file) && record.binding.sha256 === publication?.sha256
    && record.binding.bytes === publication?.bytes, 'PROJECTION_BINDING_CHANGED');
  verifyPublishedBytes(file, publication);
  const binding = JSON.parse(publication.text);
  need(binding.commandId === record.id && binding.role === record.role && binding.promptSha256 === record.promptSha256
    && binding.beforeRunId === record.beforeRunId && binding.actualAdmittedRun?.runId === record.runId, 'PROJECTION_PUBLICATION_CHANGED');
  assert.deepEqual(normalize(binding.target), normalize(record.target), 'PROJECTION_PUBLICATION_TARGET_CHANGED');
  assert.deepEqual(binding.actualAdmittedRun, record.actualAdmittedRun, 'PROJECTION_PUBLICATION_RUN_CHANGED');
  return bridgeVerifiedAdmission(c, journal, { admitted: true, id: record.role, commandId: record.id,
    sessionId: record.target.sessionId, runId: record.runId, binding: record.binding, clickCount: 1 });
}

const blockSubmit = async () => { need(false, 'VERIFIED_ADAPTER_NOT_ACTIVE'); };

/** Keep the old lexical submit unreachable until both intent and evidence are durable. */
export function activateVerifiedOfficeRoutes(c, { journal, installation, artifact, submit, unsupported, reconcile, inspect, coordinator, reobserve }) {
  need(!installations.has(c) && !c.verifiedSubmitInstallation && !c.state.verifiedSubmissionJournal && !c.state.verifiedSubmitInstallation, 'VERIFIED_ADAPTER_ALREADY_PRESENT');
  const text = JSON.stringify(installation, null, 2) + '\n';
  const publication = Object.freeze({ path: artifact, text, bytes: Buffer.byteLength(text), sha256: sha(text) });
  const control = { ...installation, status: 'installing', installed: false, coordinator, inspect,
    reconcile: async commandId => { need(control.installed, 'VERIFIED_ADAPTER_NOT_ACTIVE'); return reconcile(commandId); } };
  let publicationAttempted = false, resuming = false;
  const uncertain = error => {
    c.submit = blockSubmit; c.createAndStart = unsupported; control.installed = false;
    control.status = 'installation-uncertain';
    control.errorCode = error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0].slice(0, 240)
      : error?.code ?? String(error?.message ?? error).slice(0, 240);
    c.state.verifiedSubmitInstallation = { schemaVersion: 1, status: control.status, publication, errorCode: control.errorCode };
    try { c.save(); control.persistenceFailed = false; } catch { control.persistenceFailed = true; }
    throw Object.assign(new Error('INSTALLATION_UNCERTAIN:' + control.errorCode), { code: 'INSTALLATION_UNCERTAIN', cause: error });
  };
  const finish = () => {
    c.submit = blockSubmit; c.createAndStart = unsupported; control.status = 'installing';
    try {
      need(c.verifiedSubmitInstallation === control && c.state.verifiedSubmissionJournal === journal, 'INSTALLATION_CONTROLLER_REPLACED');
      c.state.verifiedSubmitInstallation = { schemaVersion: 1, status: 'installing', publication };
      c.save();
      // A resumed publication may already exist after a final state save failed.
      // Its original bytes are the only accepted recovery evidence.
      need(publicationAttempted || !fs.existsSync(artifact), 'INSTALLATION_EVIDENCE_ALREADY_EXISTS');
      publicationAttempted = true;
      if (!fs.existsSync(artifact)) fs.writeFileSync(artifact, text, { flag: 'wx' });
      verifyPublishedBytes(artifact, publication);
      c.state.verifiedSubmitInstallation = { ...installation, publication: { path: artifact, sha256: publication.sha256, bytes: publication.bytes } };
      c.save();
      c.submit = submit; c.createAndStart = unsupported;
      control.installed = true; control.status = installation.status; control.errorCode = null; control.persistenceFailed = false;
      return { installed: true, artifact, sha256: publication.sha256, status: installation.status, liveAdmissionVerified: false };
    } catch (error) { return uncertain(error); }
  };
  control.resumeInstallation = async () => {
    need(!control.installed && control.status === 'installation-uncertain' && !resuming, 'INSTALLATION_RESUME_NOT_ALLOWED');
    resuming = true;
    try {
      const proof = await reobserve();
      assert.deepEqual(proof.engine, installation.proof.engine, 'INSTALLATION_RESUME_ENGINE_CHANGED');
      assert.deepEqual(proof.expectedTargets, installation.proof.expectedTargets, 'INSTALLATION_RESUME_TARGETS_CHANGED');
      need(proof.ready === true, 'INSTALLATION_RESUME_NOT_READY');
      return finish();
    } catch (error) { if (error?.code === 'INSTALLATION_UNCERTAIN') throw error; return uncertain(error); }
    finally { resuming = false; }
  };
  // Install the block before the first save, including failures in the intent save.
  c.submit = blockSubmit; c.createAndStart = unsupported;
  c.verifiedSubmitInstallation = control; installations.set(c, control);
  c.state.verifiedSubmissionJournal = journal;
  return finish();
}

/** The adapter owns projection recovery until its synchronous save succeeds. */
export function createVerifiedOfficeRoutes({ c, journal, coordinator, readTarget, evidenceDir, promptOrigins, projectionReadMs = 7000 }) {
  need(Number.isSafeInteger(projectionReadMs) && projectionReadMs > 0 && projectionReadMs <= 7000, 'PROJECTION_READ_BUDGET_INVALID');
  let routeActive = false, projectionPending = null, projectionReads = 0;
  const exclusive = async operation => {
    const current = coordinator.inspect();
    need(!routeActive && projectionReads === 0 && !current.active && current.pendingOperations === 0, 'ADAPTER_OPERATION_PENDING');
    routeActive = true;
    try { return await operation(); } finally { routeActive = false; }
  };
  const readProjectionTarget = async role => {
    projectionReads++; let timer;
    const operation = Promise.resolve().then(() => readTarget(role)).finally(() => { projectionReads--; });
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('PROJECTION_TARGET_READ_TIMEOUT')), projectionReadMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const bridge = result => {
    try {
      const projected = bridgeVerifiedAdmission(c, journal, result);
      if (projectionPending === result.commandId) projectionPending = null;
      return projected;
    } catch (error) { if (result?.admitted === true) projectionPending = result.commandId; throw error; }
  };
  return {
    submit: (role, stage) => exclusive(async () => {
      need(projectionPending === null, 'VERIFIED_PROJECTION_PENDING');
      const prompt = effectiveOfficePrompt(stage.prompt);
      promptOrigins.set(stage.id, { rawStagePromptSha256: prompt.rawSha256, effectivePromptSha256: prompt.effectiveSha256, footerAppended: prompt.footerAppended });
      return bridge(await coordinator.submit(role, { ...stage, prompt: prompt.text }));
    }),
    reconcile: commandId => exclusive(async () => {
      need(projectionPending === null || projectionPending === commandId, 'VERIFIED_PROJECTION_PENDING');
      const record = journal.submissions.find(row => row.id === commandId);
      if (record?.phase === 'admitted') {
        projectionPending = commandId;
        const result = await reconcileVerifiedAdmissionProjection(c, journal, commandId, { readTarget: readProjectionTarget, evidenceDir });
        projectionPending = null; return result;
      }
      return bridge(await coordinator.reconcile(commandId));
    }),
    inspect: () => ({ ...coordinator.inspect(), routeActive, projectionPending, projectionReads }),
  };
}

function frozenConfig(c) {
  need(process.pid === 9080 && samePath(process.argv[1], RUNNER) && c === globalThis.__officeCampaign, 'OWNED_RUNNER_MISMATCH');
  need(samePath(c?.state?.runRoot, ROOT) && samePath(c.state.profile, path.join(ROOT, 'profile'))
    && samePath(c.state.evidenceRoot, path.join(ROOT, 'evidence')) && !c.page.isClosed(), 'CAMPAIGN_BINDING_MISMATCH');
  const file = path.join(ROOT, 'evidence/microcompact-index-upgrade-after.json');
  need(samePath(fs.realpathSync(file), file) && fs.statSync(file).size <= 2 * 1024 * 1024, 'UPGRADE_EVIDENCE_INVALID');
  const bytes = fs.readFileSync(file); need(sha(bytes) === UPGRADE_SHA, 'UPGRADE_EVIDENCE_CHANGED');
  const upgrade = JSON.parse(bytes);
  need(upgrade.status === 'passed' && upgrade.next.instanceId === ENGINE_ID && upgrade.next.buildId === BUILD && upgrade.next.pid === 33400, 'UPGRADE_NOT_VERIFIED');
  const expectedTargets = Object.fromEntries(upgrade.after.tasks.map(task => {
    const scope = upgrade.after.queues[task.role].scope;
    return [task.role, { owner: 'work', active: true, sessionId: task.id, agentId: task.agentId, modelId: task.modelId,
      workspacePath: task.workspacePath, tenantId: scope.tenantId, namespace: scope.namespace, engine: engineIdentity(upgrade.next) }];
  }));
  need(Object.keys(expectedTargets).length === 6, 'ROLE_SET_CHANGED');
  for (const [role, target] of Object.entries(expectedTargets)) need(c.state.roles[role]?.sessionId === target.sessionId
    && c.state.roles[role]?.agentId === target.agentId, 'ROLE_BINDING_CHANGED');
  for (const key of ['mode', 'baseUrl', 'instanceId', 'accountId']) need(c.state.engine[key] === upgrade.next[key], 'RUNNER_ENGINE_CHANGED');
  return { expectedTargets, upgrade, profile: c.state.profile, evidenceDir: c.state.evidenceRoot };
}

/** Preparation reads only; no route replacement, queue IPC, UI selection or composer fill. */
export async function observeOfficeVerifiedSubmitInstallation(c) {
  const current = preparations.get(c);
  need(!current?.active && !(current?.pending > 0), 'INSTALL_OBSERVATION_PENDING');
  const control = { active: true, pending: 0 }; preparations.set(c, control);
  const deadline = Date.now() + 35000;
  const read = async (label, operation) => {
    need(Date.now() < deadline, 'INSTALL_OBSERVATION_DEADLINE'); control.pending++;
    let timer; const operationPromise = Promise.resolve().then(operation).finally(() => { control.pending--; });
    try { return await Promise.race([operationPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('INSTALL_READ_TIMEOUT:' + label)), Math.min(7000, deadline - Date.now())); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const config = frozenConfig(c), first = Object.values(config.expectedTargets)[0];
    need(c.microcompactIndexUpgrade?.status === 'passed' && c.microcompactIndexMaintenanceLease?.active === false, 'MAINTENANCE_NOT_RELEASED');
    const commandsFile = path.join(ROOT, 'commands.json'); need(fs.statSync(commandsFile).size < 2 * 1024 * 1024, 'RUNNER_QUEUE_OVERSIZED');
    const commands = JSON.parse(fs.readFileSync(commandsFile, 'utf8')).commands;
    need(Array.isArray(commands) && commands.length <= 2048 && Array.isArray(c.state.commands), 'RUNNER_QUEUE_UNKNOWN');
    need(new Set(commands.map(row => row.id)).size === commands.length && commands.every(row => c.state.commands.some(record => record.id === row.id && ['completed', 'failed'].includes(record.status))), 'RUNNER_QUEUE_NOT_DRAINED');
    const host = await read('host', () => c.app.evaluate(({ app }) => ({ userData: app.getPath('userData'), queueBackend: process.env.AETHER_NEXT_TURN_BACKEND ?? null })));
    need(samePath(host.userData, config.profile) && host.queueBackend !== 'sqlite-worker-opt-in', 'HOST_PROFILE_OR_QUEUE_BACKEND_MISMATCH');
    const snapshot = await read('engine', () => c.page.evaluate(() => window.aether.engine.getSnapshot()));
    assert.deepEqual(engineIdentity(snapshot), first.engine, 'ENGINE_IDENTITY_CHANGED');
    const reader = createReadonlyWorkQueueReader({ profile: config.profile, backend: 'json-journal', sourcePins: QUEUE_PINS });
    const roles = {};
    for (const [role, target] of Object.entries(config.expectedTargets)) {
      const status = await read('status-' + role, () => c.request('GET', '/chat/status', undefined, { sessionId: target.sessionId }));
      need(status?.running === false && status.run?.sessionId === target.sessionId && terminal.has(status.run.status)
        && Array.isArray(status.run.pending) && status.run.pending.length === 0, 'ROOT_NOT_IDLE');
      need(status.run.serverAdmissionReceipt?.tenantId === target.tenantId, 'ROOT_TENANT_CHANGED');
      assert.deepEqual(status.run.serverAdmissionReceipt.namespace, target.namespace, 'ROOT_NAMESPACE_CHANGED');
      const scope = { source: { mode: 'embedded', endpoint: '', accountId: target.engine.accountId }, tenantId: target.tenantId,
        namespace: target.namespace, owner: 'work', taskId: target.sessionId };
      const queue = await read('queue-' + role, () => reader.read(scope));
      need(queue.state.entries.every(entry => entry.phase === 'terminal' && terminal.has(entry.outcome)), 'WORK_QUEUE_NOT_DRAINED');
      roles[role] = { sessionId: target.sessionId, runId: status.run.runId, rootStatus: status.run.status,
        queueRevision: queue.state.revision, queueSha256: sha(JSON.stringify(queue.state)), scope };
    }
    const active = await read('active-ui', () => c.page.evaluate(readActiveWorkSnapshot, { storageKey: 'aether.work.state.v1:' + encodeURIComponent(':account:' + first.engine.accountId) }));
    const activeRole = Object.keys(config.expectedTargets).find(role => config.expectedTargets[role].sessionId === active.activeTaskId);
    need(activeRole, 'ACTIVE_ROLE_UNKNOWN'); validateActiveWorkSnapshot(active, config.expectedTargets[activeRole], { idle: true });
    assert.deepEqual(engineIdentity(await read('engine-after', () => c.page.evaluate(() => window.aether.engine.getSnapshot()))), first.engine, 'ENGINE_CHANGED_DURING_OBSERVATION');
    need(control.pending === 0 && Date.now() <= deadline, 'INSTALL_OBSERVATION_INCOMPLETE');
    return { schemaVersion: 1, observedAt: new Date().toISOString(), ready: true, upgradeSha256: UPGRADE_SHA,
      engine: first.engine, roles, activeRole, activeSessionId: active.activeTaskId,
      queueSourceHashes: reader.sourceHashes, queueBackend: reader.backend, expectedTargets: config.expectedTargets,
      scope: 'Read-only pre-install observation; no submission, UI change, queue recovery or route installation.' };
  } finally { control.active = false; }
}

export async function installOfficeVerifiedSubmit(c) {
  const existing = installations.get(c);
  if (existing) {
    need(c.verifiedSubmitInstallation === existing, 'INSTALLATION_CONTROLLER_REPLACED');
    return existing.resumeInstallation();
  }
  const unsupported = async role => {
    c.log('unsupported-existing-campaign', { role, reason: 'Six roles already exist; start-role never enters legacy lexical submit.' });
    need(false, 'unsupported-existing-campaign');
  };
  if (c.verifiedSubmitInstallation || c.state.verifiedSubmissionJournal || c.state.verifiedSubmitInstallation) {
    // A restarted runner cannot recreate an in-memory owner from a partial journal.
    c.submit = blockSubmit; c.createAndStart = unsupported;
    need(false, 'PERSISTED_INSTALLATION_REQUIRES_REVIEW');
  }
  const proof = await observeOfficeVerifiedSubmitInstallation(c), config = frozenConfig(c);
  const reader = createReadonlyWorkQueueReader({ profile: config.profile, backend: 'json-journal', sourcePins: QUEUE_PINS });
  const journal = { schemaVersion: 1, submissions: [], lease: null }, promptOrigins = new Map();
  const storageKey = 'aether.work.state.v1:' + encodeURIComponent(':account:' + proof.engine.accountId);
  const targetFor = sessionId => Object.values(config.expectedTargets).find(target => target.sessionId === sessionId);
  const checkEngine = async () => {
    frozenConfig(c); const actual = await c.page.evaluate(() => window.aether.engine.getSnapshot());
    assert.deepEqual(engineIdentity(actual), proof.engine, 'VERIFIED_ENGINE_CHANGED'); return engineIdentity(actual);
  };
  const readTarget = async role => {
    const expected = config.expectedTargets[role]; need(expected, 'UNKNOWN_ROLE');
    const engine = await checkEngine();
    const observed = await c.page.evaluate(readActiveWorkSnapshot, { storageKey });
    validateActiveWorkSnapshot(observed, expected);
    return { ...expected, engine, newTask: false };
  };
  const ports = {
    async prepareTarget(role, _stage, options) {
      need(!options.startRole, 'unsupported-existing-campaign'); await checkEngine();
      await c.selectTask(role);
      const observed = await c.page.evaluate(readActiveWorkSnapshot, { storageKey });
      validateActiveWorkSnapshot(observed, config.expectedTargets[role], { idle: true });
      return readTarget(role);
    }, readTarget,
    async prepareComposer(role, prompt) {
      await readTarget(role);
      const editor = c.page.locator('#mode-work .input-composer__input[role="textbox"]').filter({ visible: true });
      need(await editor.count() === 1, 'COMPOSER_AMBIGUOUS'); await editor.fill(prompt);
      const observed = await c.page.evaluate(readActiveWorkSnapshot, { storageKey });
      validateActiveWorkSnapshot(observed, config.expectedTargets[role], { idle: true }); return observed.editorText;
    },
    async clickSend(role) {
      const observed = await c.page.evaluate(readActiveWorkSnapshot, { storageKey });
      validateActiveWorkSnapshot(observed, config.expectedTargets[role], { idle: true });
      need(observed.sendLabels.length === 1 && observed.sendLabels[0].label === '发送' && !observed.sendLabels[0].disabled, 'SEND_ACTION_NOT_IDLE_SEND');
      await checkEngine();
      const send = c.page.locator('#mode-work').getByRole('button', { name: '发送', exact: true }).filter({ visible: true });
      need(await send.count() === 1, 'SEND_BUTTON_AMBIGUOUS'); await send.click({ timeout: 5000 });
    },
    async readStatus(sessionId) { need(targetFor(sessionId), 'STATUS_SESSION_UNKNOWN'); await checkEngine(); return c.request('GET', '/chat/status', undefined, { sessionId }); },
    async readQueue(sessionId) {
      const target = targetFor(sessionId); need(target, 'QUEUE_SESSION_UNKNOWN'); await checkEngine();
      return reader.read({ source: { mode: 'embedded', endpoint: '', accountId: target.engine.accountId }, tenantId: target.tenantId,
        namespace: target.namespace, owner: 'work', taskId: sessionId });
    }, validateQueueState: reader.validateQueueState,
    hasCommand: commandId => Object.values(c.state.roles).some(owner => owner.submissions.some(row => row.id === commandId)),
    persist(value) {
      need(value === journal && c.state.verifiedSubmissionJournal === journal, 'VERIFIED_JOURNAL_REPLACED');
      for (const record of journal.submissions) if (promptOrigins.has(record.id)) Object.assign(record, promptOrigins.get(record.id));
      c.save();
    },
  };
  const coordinator = createVerifiedOfficeSubmit({ ports, journal, expectedTargets: config.expectedTargets,
    evidenceDir: config.evidenceDir, historyRoot: path.join(path.dirname(proof.engine.dataDir), 'sessions') });
  const routes = createVerifiedOfficeRoutes({ c, journal, coordinator, readTarget, evidenceDir: config.evidenceDir, promptOrigins });
  const artifact = path.join(config.evidenceDir, 'independent-audit/verified-submit-installation-20261024.json');
  const installation = { schemaVersion: 1, installedAt: new Date().toISOString(), status: 'installed-awaiting-live-admission',
    proof, footerSha256: sha(OFFICE_SUBMIT_FOOTER), footerRule: 'Append once unless the exact suffix is already present; record raw and actual prompt SHA.',
    unsupported: ['start-role'], noLegacySubmitWrapper: true, liveAdmissionVerified: false };
  return activateVerifiedOfficeRoutes(c, { journal, installation, artifact, ...routes, unsupported,
    coordinator, reobserve: () => observeOfficeVerifiedSubmitInstallation(c) });
}
