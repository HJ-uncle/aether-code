/** Real work-resource-store.ts compiled in memory; only React/source/file-boundary ports are isolated. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const sourceFile = path.resolve('src/renderer/src/contrib/work/work-resource-store.ts');
function fixture() {
  let source = 1, sourceChanged, rejectTarget = false;
  const calls = [];
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return { useSyncExternalStore: (_subscribe, get) => get() };
    if (name === '@renderer/core/engine/source') return { getEngineSource: () => source,
      getExpectedEngine: () => ({ instanceId: 'engine-' + source }), engineConnectionKey: engine => engine.phase + ':' + engine.instanceId,
      subscribeEngineSource: callback => { sourceChanged = callback; return () => {}; } };
    if (name === '@renderer/core/workspace/fs-client') return { assertSessionFileTarget: target => {
      calls.push(target); if (rejectTarget) throw new Error('scope rejected by product boundary');
    } };
    throw new Error('Unexpected product dependency: ' + name);
  };
  const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    fileName: sourceFile, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  // Host realm keeps Object/Array identity compatible with strict assertions.
  new vm.Script('(function(require,module,exports){' + compiled + '\n})', { filename: sourceFile })
    .runInThisContext({ timeout: 1000 })(require, module, module.exports);
  const target = sessionId => ({ sessionId, root: 'D:/company', source: ':account:fixture', engineSource: source });
  return { store: module.exports, target, calls, reject: () => { rejectTarget = true; },
    switchSource: () => { source++; sourceChanged(); } };
}

test('web resource visibility requires both current engine identity and exact task ownership', () => {
  const { store: s, switchSource } = fixture();
  const tabs = [
    { tabId: 'owned', context: { sessionId: 'one', engineId: 'ready:engine-1' } },
    { tabId: 'wrong-task', context: { sessionId: 'two', engineId: 'ready:engine-1' } },
    { tabId: 'old-engine', context: { sessionId: 'one', engineId: 'ready:engine-0' } },
    { tabId: 'next-engine', context: { sessionId: 'one', engineId: 'ready:engine-2' } },
    { tabId: 'unowned' },
  ];
  assert.deepEqual(s.workResourceBrowserTabs(tabs, 'one').map(tab => tab.tabId), ['owned']);
  assert.deepEqual(s.workResourceBrowserTabs(tabs, 'two').map(tab => tab.tabId), ['wrong-task']);
  switchSource();
  assert.deepEqual(s.workResourceBrowserTabs(tabs, 'one').map(tab => tab.tabId), ['next-engine']);
  assert.equal(tabs.length, 5);
});

test('reopening the same Windows file preserves creation order and refreshes the target descriptor', () => {
  const { store: s, target, calls } = fixture();
  s.openWorkFileResource('D:\\company\\A.docx', target('one'));
  s.openWorkFileResource('D:/company/B.pdf', target('one'));
  const before = s.getWorkResources('one'), ids = before.files.map(file => file.id);
  const replacement = { ...target('one'), root: 'D:/company/new-root' };
  s.openWorkFileResource('d:/COMPANY/a.DOCX', replacement);
  const after = s.getWorkResources('one');
  assert.deepEqual(after.files.map(file => file.id), ids); assert.equal(after.files.length, 2);
  assert.equal(after.selected, ids[0]); assert.ok(after.reveal > before.reveal);
  assert.equal(after.files[0].target, replacement); assert.equal(calls.length, 3);
});

test('external path resources stay read-only and are scoped to the current Work session', () => {
  const { store: s } = fixture();
  s.openExternalWorkPathResource('D:/outside/compliance/brief.pdf', 'one');
  const resource = s.getWorkResources('one').files[0];
  assert.equal(resource.externalPath, 'D:/outside/compliance/brief.pdf');
  assert.equal(resource.target, null);
  assert.equal(resource.externalFile, undefined);
  assert.equal(s.getWorkResources('two').files.length, 0);
  assert.equal(s.getWorkResources('one').selected, resource.id);
});

test('file resources remain isolated by task and engine source changes clear old-account descriptors', () => {
  const f = fixture(), s = f.store; let notifications = 0;
  s.subscribeWorkResources(() => notifications++);
  s.openWorkFileResource('D:/company/one.pdf', f.target('one'));
  s.openWorkFileResource('D:/company/two.pdf', f.target('two'));
  assert.equal(s.getWorkResources('one').files[0].name, 'one.pdf');
  assert.equal(s.getWorkResources('two').files[0].name, 'two.pdf');
  f.switchSource();
  assert.equal(s.getWorkResources('one').files.length, 0); assert.equal(s.getWorkResources('two').selected, null);
  assert.equal(notifications, 3);
});

test('resolution uses only existing selected resources and the current session web ids', () => {
  const { store: s, target } = fixture();
  s.openWorkFileResource('D:/company/one.pdf', target('one'));
  const fileId = s.getWorkResources('one').selected;
  assert.equal(s.resolvedWorkResourceId(s.getWorkResources('one'), ['owned-web'], 'other-session-web'), fileId);
  s.selectWorkResource('one', 'web:owned-web');
  assert.equal(s.resolvedWorkResourceId(s.getWorkResources('one'), ['owned-web'], 'other-session-web'), 'web:owned-web');
  s.selectWorkResource('one', 'file:removed');
  assert.equal(s.resolvedWorkResourceId(s.getWorkResources('one'), ['owned-web'], 'owned-web'), 'web:owned-web');
  assert.equal(s.resolvedWorkResourceId(s.getWorkResources('one'), [], 'other-session-web'), fileId);
  assert.equal(s.resolvedWorkResourceId(s.getWorkResources('empty'), [], 'other-session-web'), null);
});

test('closing an active middle document selects its next neighbor without shuffling remaining documents', () => {
  const { store: s, target } = fixture();
  for (const name of ['a.pdf', 'b.docx', 'c.xlsx']) s.openWorkFileResource('D:/company/' + name, target('one'));
  const ids = s.getWorkResources('one').files.map(file => file.id);
  s.selectWorkResource('one', ids[1]); s.closeWorkResource('one', ids[1]);
  assert.deepEqual(s.getWorkResources('one').files.map(file => file.id), [ids[0], ids[2]]);
  assert.equal(s.getWorkResources('one').selected, ids[2]);
  s.closeWorkResource('one', ids[2]); assert.equal(s.getWorkResources('one').selected, ids[0]);
  s.closeWorkResource('one', ids[0]); assert.equal(s.getWorkResources('one').selected, null);
});

test('closing a background document preserves an active webpage; closing that webpage falls back to a document', () => {
  const { store: s, target } = fixture();
  s.openWorkFileResource('D:/company/a.pdf', target('one')); s.openWorkFileResource('D:/company/b.pdf', target('one'));
  const ids = s.getWorkResources('one').files.map(file => file.id);
  s.selectWorkResource('one', 'web:owned'); s.closeWorkResource('one', ids[0]);
  assert.equal(s.getWorkResources('one').selected, 'web:owned');
  s.closeWorkResource('one', 'web:owned'); assert.equal(s.getWorkResources('one').selected, ids[1]);
});

test('file cap rejects the next document atomically but allows revisiting an already open file', () => {
  const { store: s, target } = fixture(); let notifications = 0;
  s.subscribeWorkResources(() => notifications++);
  for (let i = 0; i < 32; i++) s.openWorkFileResource('D:/company/' + i + '.pdf', target('one'));
  const before = s.getWorkResources('one');
  assert.throws(() => s.openWorkFileResource('D:/company/overflow.pdf', target('one')), /32/);
  assert.equal(s.getWorkResources('one'), before); assert.equal(notifications, 32);
  s.openWorkFileResource('D:/company/0.pdf', target('one'));
  assert.equal(s.getWorkResources('one').files.length, 32); assert.equal(notifications, 33);
});

test('bounded session cache evicts an old session while preserving a recently changed one', () => {
  const { store: s, target } = fixture();
  for (let i = 0; i < 64; i++) s.openWorkFileResource('D:/company/' + i + '.pdf', target('session-' + i));
  s.selectWorkResource('session-0', 'web:recent');
  s.openWorkFileResource('D:/company/new.pdf', target('new-session'));
  assert.equal(s.getWorkResources('session-1').files.length, 0);
  assert.equal(s.getWorkResources('session-0').selected, 'web:recent');
  assert.equal(s.getWorkResources('new-session').files[0].name, 'new.pdf');
});

test('scope rejection makes no store change; unsubscribed listeners receive no further notifications', () => {
  const f = fixture(), s = f.store; let calls = 0;
  const unsubscribe = s.subscribeWorkResources(() => calls++);
  s.openWorkFileResource('D:/company/a.pdf', f.target('one'));
  const before = s.getWorkResources('one'); unsubscribe(); f.reject();
  assert.throws(() => s.openWorkFileResource('D:/company/b.pdf', f.target('one')), /scope rejected/);
  assert.equal(s.getWorkResources('one'), before); s.selectWorkResource('one', 'web:existing');
  assert.equal(calls, 1);
});
