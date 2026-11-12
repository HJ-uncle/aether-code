/** Resource store and browser ownership helpers compiled in memory; React, settings and file-boundary ports are isolated. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const sourceFile = path.resolve('src/renderer/src/features/workspace/resource-store.ts');
function fixture() {
  let source = 1, rejectTarget = false;
  const calls = [];
  const modules = new Map();
  const moduleFiles = {
    resource: sourceFile,
    source: path.resolve('src/renderer/src/core/engine/source.ts'),
    scope: path.resolve('src/renderer/src/core/browser/scope.ts'),
    presentation: path.resolve('src/renderer/src/core/browser/presentation.ts'),
  };
  const aliases = { '@renderer/core/engine/source': 'source', '../engine/source': 'source',
    '@renderer/core/browser/scope': 'scope', './scope': 'scope', '@renderer/core/browser/presentation': 'presentation' };
  const requireModule = name => {
    if (name === 'react') return { useSyncExternalStore: (_subscribe, get) => get() };
    if (name === '../app-provider') return { getAppSettings: () => ({ engineMode: 'embedded', remoteBaseUrl: '' }) };
    if (name === './connection') return { getBrowserSessionId: () => null };
    if (name === '@renderer/core/workspace/fs-client') return { assertSessionFileTarget: target => {
      calls.push(target); if (rejectTarget) throw new Error('scope rejected by product boundary');
    } };
    const key = aliases[name] ?? name, file = moduleFiles[key];
    if (!file) throw new Error('Unexpected product dependency: ' + name);
    if (modules.has(key)) return modules.get(key).exports;
    const module = { exports: {} };
    modules.set(key, module);
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    // Host realm keeps Object/Array identity compatible with strict assertions.
    new vm.Script('(function(require,module,exports){' + compiled + '\n})', { filename: file })
      .runInThisContext({ timeout: 1000 })(requireModule, module, module.exports);
    return module.exports;
  };
  const engine = requireModule('source');
  const snapshot = index => ({ mode: 'embedded', baseUrl: 'http://localhost:12345', phase: 'ready', instanceId: 'engine-' + index, accountId: 'fixture' });
  engine.publishEngineSource(snapshot(source));
  const store = requireModule('resource');
  const target = sessionId => ({ sessionId, root: 'D:/company', source: ':account:fixture', engineSource: engine.getEngineSource() });
  const presentation = (sessionId, index = source, mode = 'work') => ({ mode, sessionId, engineId: engine.engineConnectionKey(snapshot(index)) });
  return { store, target, calls, presentation, reject: () => { rejectTarget = true; },
    switchSource: () => { engine.publishEngineSource(snapshot(++source)); } };
}

test('web resource visibility requires both current engine identity and exact task ownership', () => {
  const { store: s, switchSource, presentation } = fixture();
  const tabs = [
    { tabId: 'owned', presentation: presentation('one') },
    { tabId: 'wrong-task', presentation: presentation('two') },
    { tabId: 'old-engine', presentation: presentation('one', 0) },
    { tabId: 'next-engine', presentation: presentation('one', 2) },
    { tabId: 'wrong-mode', presentation: presentation('one', 1, 'code') },
    { tabId: 'context-only', context: { sessionId: 'one', engineId: presentation('one').engineId } },
    { tabId: 'unowned' },
  ];
  assert.deepEqual(s.sessionResourceBrowserTabs(tabs, 'one').map(tab => tab.tabId), ['owned']);
  assert.deepEqual(s.sessionResourceBrowserTabs(tabs, 'two').map(tab => tab.tabId), ['wrong-task']);
  switchSource();
  assert.deepEqual(s.sessionResourceBrowserTabs(tabs, 'one').map(tab => tab.tabId), ['next-engine']);
  assert.equal(tabs.length, 7);
});

test('reopening the same Windows file preserves creation order and refreshes the target descriptor', () => {
  const { store: s, target, calls } = fixture();
  s.openSessionFileResource('D:\\company\\A.docx', target('one'));
  s.openSessionFileResource('D:/company/B.pdf', target('one'));
  const before = s.getSessionResources('one'), ids = before.files.map(file => file.id);
  const replacement = { ...target('one'), root: 'D:/company/new-root' };
  s.openSessionFileResource('d:/COMPANY/a.DOCX', replacement);
  const after = s.getSessionResources('one');
  assert.deepEqual(after.files.map(file => file.id), ids); assert.equal(after.files.length, 2);
  assert.equal(after.selected, ids[0]); assert.ok(after.reveal > before.reveal);
  assert.equal(after.files[0].target, replacement); assert.equal(calls.length, 3);
});

test('external path resources stay read-only and are scoped to the current Work session', () => {
  const { store: s } = fixture();
  s.openExternalSessionPathResource('D:/outside/compliance/brief.pdf', 'one');
  const resource = s.getSessionResources('one').files[0];
  assert.equal(resource.externalPath, 'D:/outside/compliance/brief.pdf');
  assert.equal(resource.target, null);
  assert.equal(resource.externalFile, undefined);
  assert.equal(s.getSessionResources('two').files.length, 0);
  assert.equal(s.getSessionResources('one').selected, resource.id);
});

test('file resources remain isolated by task and engine source changes clear old-account descriptors', () => {
  const f = fixture(), s = f.store; let notifications = 0;
  s.subscribeSessionResources(() => notifications++);
  s.openSessionFileResource('D:/company/one.pdf', f.target('one'));
  s.openSessionFileResource('D:/company/two.pdf', f.target('two'));
  assert.equal(s.getSessionResources('one').files[0].name, 'one.pdf');
  assert.equal(s.getSessionResources('two').files[0].name, 'two.pdf');
  f.switchSource();
  assert.equal(s.getSessionResources('one').files.length, 0); assert.equal(s.getSessionResources('two').selected, null);
  assert.equal(notifications, 3);
});

test('resolution uses only existing selected resources and the current session web ids', () => {
  const { store: s, target } = fixture();
  s.openSessionFileResource('D:/company/one.pdf', target('one'));
  const fileId = s.getSessionResources('one').selected;
  assert.equal(s.resolvedSessionResourceId(s.getSessionResources('one'), ['owned-web'], 'other-session-web'), fileId);
  s.selectSessionResource('one', 'web:owned-web');
  assert.equal(s.resolvedSessionResourceId(s.getSessionResources('one'), ['owned-web'], 'other-session-web'), 'web:owned-web');
  s.selectSessionResource('one', 'file:removed');
  assert.equal(s.resolvedSessionResourceId(s.getSessionResources('one'), ['owned-web'], 'owned-web'), 'web:owned-web');
  assert.equal(s.resolvedSessionResourceId(s.getSessionResources('one'), [], 'other-session-web'), fileId);
  assert.equal(s.resolvedSessionResourceId(s.getSessionResources('empty'), [], 'other-session-web'), null);
});

test('closing an active middle document selects its next neighbor without shuffling remaining documents', () => {
  const { store: s, target } = fixture();
  for (const name of ['a.pdf', 'b.docx', 'c.xlsx']) s.openSessionFileResource('D:/company/' + name, target('one'));
  const ids = s.getSessionResources('one').files.map(file => file.id);
  s.selectSessionResource('one', ids[1]); s.closeSessionResource('one', ids[1]);
  assert.deepEqual(s.getSessionResources('one').files.map(file => file.id), [ids[0], ids[2]]);
  assert.equal(s.getSessionResources('one').selected, ids[2]);
  s.closeSessionResource('one', ids[2]); assert.equal(s.getSessionResources('one').selected, ids[0]);
  s.closeSessionResource('one', ids[0]); assert.equal(s.getSessionResources('one').selected, null);
});

test('closing a background document preserves an active webpage; closing that webpage falls back to a document', () => {
  const { store: s, target } = fixture();
  s.openSessionFileResource('D:/company/a.pdf', target('one')); s.openSessionFileResource('D:/company/b.pdf', target('one'));
  const ids = s.getSessionResources('one').files.map(file => file.id);
  s.selectSessionResource('one', 'web:owned'); s.closeSessionResource('one', ids[0]);
  assert.equal(s.getSessionResources('one').selected, 'web:owned');
  s.closeSessionResource('one', 'web:owned'); assert.equal(s.getSessionResources('one').selected, ids[1]);
});

test('file cap rejects the next document atomically but allows revisiting an already open file', () => {
  const { store: s, target } = fixture(); let notifications = 0;
  s.subscribeSessionResources(() => notifications++);
  for (let i = 0; i < 32; i++) s.openSessionFileResource('D:/company/' + i + '.pdf', target('one'));
  const before = s.getSessionResources('one');
  assert.throws(() => s.openSessionFileResource('D:/company/overflow.pdf', target('one')), /32/);
  assert.equal(s.getSessionResources('one'), before); assert.equal(notifications, 32);
  s.openSessionFileResource('D:/company/0.pdf', target('one'));
  assert.equal(s.getSessionResources('one').files.length, 32); assert.equal(notifications, 33);
});

test('bounded session cache evicts an old session while preserving a recently changed one', () => {
  const { store: s, target } = fixture();
  for (let i = 0; i < 64; i++) s.openSessionFileResource('D:/company/' + i + '.pdf', target('session-' + i));
  s.selectSessionResource('session-0', 'web:recent');
  s.openSessionFileResource('D:/company/new.pdf', target('new-session'));
  assert.equal(s.getSessionResources('session-1').files.length, 0);
  assert.equal(s.getSessionResources('session-0').selected, 'web:recent');
  assert.equal(s.getSessionResources('new-session').files[0].name, 'new.pdf');
});

test('scope rejection makes no store change; unsubscribed listeners receive no further notifications', () => {
  const f = fixture(), s = f.store; let calls = 0;
  const unsubscribe = s.subscribeSessionResources(() => calls++);
  s.openSessionFileResource('D:/company/a.pdf', f.target('one'));
  const before = s.getSessionResources('one'); unsubscribe(); f.reject();
  assert.throws(() => s.openSessionFileResource('D:/company/b.pdf', f.target('one')), /scope rejected/);
  assert.equal(s.getSessionResources('one'), before); s.selectSessionResource('one', 'web:existing');
  assert.equal(calls, 1);
});
