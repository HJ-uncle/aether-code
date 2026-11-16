/** Pure declarative document and contribution lifecycle tests; no Electron or data access. */
import { expect, test } from '@playwright/test'
import path from 'node:path'
import ts from 'typescript'
import { nativeInitialValues, parseNativeDocument, resolveNativeArgs, type NativeNode } from '../src/renderer/src/features/extensions/native-document'
import { ExtensionRegistry } from '../src/renderer/src/features/extensions/registry'
import type { ExtensionRegistration } from '../src/renderer/src/features/extensions/types'

test('native document preserves controlled typed values and substitutes only explicit field references', () => {
  const document = parseNativeDocument(JSON.stringify({ version: 1, root: { type: 'card', children: [{ type: 'input', bind: 'notes', value: '中文 ${process.env.SECRET}' }, { type: 'checkbox', bind: 'enabled', value: false }, { type: 'select', bind: 'mode', options: [{ label: 'Strict', value: 'strict' }] }] } }))
  const values = nativeInitialValues(document.root)
  expect(values).toEqual({ notes: '中文 ${process.env.SECRET}', enabled: false, mode: '' })
  expect(resolveNativeArgs({ text: { $field: 'notes' }, nested: [{ $field: 'enabled' }], literal: '${notes}' }, values)).toEqual({ text: values.notes, nested: [false], literal: '${notes}' })
  expect(() => resolveNativeArgs({ text: { $field: 'missing' } }, values)).toThrow('字段不存在')
})

test('native document rejects executable properties, remote images and ambiguous actions while accepting larger trees', () => {
  const parse = (root: unknown) => parseNativeDocument(JSON.stringify({ version: 1, root }))
  for (const root of [{ type: 'script', text: 'alert(1)' }, { type: 'button', onClick: 'process.exit()' }, { type: 'image', src: 'https://example.com/private' }, { type: 'button', action: { tool: 'one', command: 'two' } }, { type: 'card', children: [{ type: 'input', bind: 'x' }, { type: 'textarea', bind: 'x' }] }]) expect(() => parse(root)).toThrow()
  let nested: NativeNode = { type: 'text', text: 'leaf' }
  for (let depth = 0; depth < 14; depth++) nested = { type: 'stack', children: [nested] }
  expect(parse(nested).root).toEqual(nested)
  expect(parse({ type: 'stack', children: Array.from({ length: 1024 }, () => ({ type: 'text' })) }).root.children).toHaveLength(1024)
})

test('native selects preserve options beyond the former 256 limit', () => {
  const options = Array.from({ length: 256 }, (_, index) => ({ label: `Option ${index}`, value: String(index) }))
  const parse = (items: typeof options) => parseNativeDocument(JSON.stringify({ version: 1, root: { type: 'select', bind: 'choice', options: items } }))
  expect(parse(options).root.options).toEqual(options)
  expect(parse([...options, { label: 'Option 256', value: '256' }]).root.options).toHaveLength(257)
})

test('native document processing traverses deep trees iteratively without plugin depth budgets', () => {
  let root: NativeNode = { type: 'input', bind: 'deep', value: 'leaf' }
  for (let depth = 1; depth < 100; depth++) root = { type: 'stack', children: [root] }
  const parse = (node: NativeNode) => parseNativeDocument(JSON.stringify({ version: 1, root: node }))
  expect(parse(root).root).toEqual(root)
  expect(nativeInitialValues(parse({ type: 'stack', children: [root] }).root)).toEqual({ deep: 'leaf' })
  const large = '中'.repeat(800_000)
  expect(parse({ type: 'text', text: large }).root.text).toBe(large)
  const circular: Record<string, unknown> = {}; circular.self = circular
  expect(() => resolveNativeArgs(circular, {})).toThrow('循环引用')
})

test('native documents reject repeated field bindings across separate branches', () => {
  const root: NativeNode = { type: 'row', children: [
    { type: 'card', children: [{ type: 'input', bind: 'name', value: 'Alice' }] },
    { type: 'card', children: [{ type: 'textarea', bind: 'notes', value: 'Review' }] }
  ] }
  const parse = () => parseNativeDocument(JSON.stringify({ version: 1, root }))
  expect(nativeInitialValues(parse().root)).toEqual({ name: 'Alice', notes: 'Review' })
  root.children![1].children![0].bind = 'name'
  expect(parse).toThrow('表单字段标识无效或重复')
})

test('hooks accept engine agent lifecycle events without admitting them as host event names', ({}, info) => {
  // Playwright transpiles specs without checking types, so exercise the public contract with TypeScript itself.
  const filename = info.outputPath('event-contract.ts').replaceAll('\\', '/')
  const modulePath = path.resolve('src/shared/plugin-contributions').replaceAll('\\', '/')
  const events = ['agent.started', 'agent.completed', 'agent.failed', 'agent.cancelled']
  const source = `import type { PluginHookContribution, PluginHostEventName } from ${JSON.stringify(modulePath)};\n` + events.map((event, index) => `
    const hook${index}: PluginHookContribution = { id: 'hook-${index}', title: 'Hook', event: '${event}', tool: 'record' };
    const host${index}: PluginHostEventName = '${event}';
  `).join('\n')
  const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, types: [] }
  const host = ts.createCompilerHost(options)
  const readSource = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === filename
    ? ts.createSourceFile(file, source, languageVersion, true)
    : readSource(file, languageVersion, onError, shouldCreateNewSourceFile)
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host))
  expect(diagnostics.map(item => ({ category: item.category, file: item.file?.fileName, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }))).toEqual(events.map(event => ({
    category: ts.DiagnosticCategory.Error, file: filename, message: expect.stringContaining(`Type '"${event}"' is not assignable to type 'PluginHostEventName'.`)
  })))
})

test('new contribution slots resolve within plugin identity and revoke together on replacement', () => {
  const registry = new ExtensionRegistry()
  const value: ExtensionRegistration = { identity: { pluginId: 'all-slots', source: 1, revision: 1, hash: 'hash', instanceId: 'one' }, contributes: {
    pages: [{ id: 'settings', title: 'Settings', kind: 'native', entry: 'ui.json', tools: [] }], commands: [{ id: 'open', title: 'Open', page: 'settings' }],
    menus: [{ id: 'action', title: 'Action', location: 'message.actions', command: 'open' }], views: [{ id: 'inline', title: 'Inline', location: 'message.inline', page: 'settings' }],
    settings: [{ id: 'options', title: 'Options', page: 'settings' }], statusBar: [{ id: 'status', title: 'Status', command: 'open' }], editorDecorations: [{ id: 'warning', title: 'Warning', text: 'Check', severity: 'warning' }],
  } }
  const off = registry.register(value)
  for (const kind of ['commands', 'menus', 'views', 'settings', 'statusBar', 'editorDecorations'] as const) expect(registry.getSnapshot()[kind][0].identity).toBe(value.identity)
  const next = { ...value, identity: { ...value.identity, instanceId: 'two', revision: 2 } }
  registry.register(next); off()
  expect(registry.getSnapshot().menus[0].identity.instanceId).toBe('two')
  registry.unregister('all-slots')
  for (const kind of ['commands', 'menus', 'views', 'settings', 'statusBar', 'editorDecorations'] as const) expect(registry.getSnapshot()[kind]).toHaveLength(0)
  expect(() => registry.register({ ...value, contributes: { ...value.contributes, menus: [{ id: 'bad', title: 'Bad', command: 'missing', location: 'app.menu' }] } })).toThrow('命令不存在')
})
