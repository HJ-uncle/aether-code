/** 纯逻辑：StrictMode 重挂载时，旧文件监听清理不能覆盖新监听注册。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'

function fixture() {
  const path = 'D:/workspace/file.txt'
  const calls: string[][] = []
  const reloads: { paths: string[]; forced: string[] }[] = []
  let changed: (paths: string[]) => void = () => {}
  let focus: () => void = () => {}
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(resolve(__dirname, '../src/renderer/src/core/editor/document-sync.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports, console,
    require: () => ({
      getEditorState: () => ({ docs: new Map([[path, { path }]]), saving: new Set() }),
      onEditorChanged: () => () => {},
      reloadDocuments: async (paths: string[], forceBinaryPaths: ReadonlySet<string>) => { reloads.push({ paths: [...paths], forced: [...forceBinaryPaths] }) },
      resolveDocumentPath: (value: string) => value, isDocumentConnectionCurrent: () => true,
      isRemoteEngine: () => false, subscribeEngineSource: () => () => {}
    }),
    window: {
      addEventListener: (_name: string, listener: () => void) => { focus = listener }, removeEventListener: () => {},
      aether: { fs: {
        watchDocuments: async (paths: string[]) => { calls.push([...paths]) },
        onDocumentsChanged: (listener: (paths: string[]) => void) => { changed = listener; return () => {} }
      } }
    }
  })
  const service = module.exports as { watchOpenDocuments(): () => void }
  return { service, calls, reloads, path, change: () => changed([path]), focus: () => focus() }
}

test('连续安装、卸载、重装后保留新实例监听，最后卸载才清空', async () => {
  const { service, calls, path } = fixture()
  const first = service.watchOpenDocuments()
  first()
  const second = service.watchOpenDocuments()
  await new Promise<void>((done) => setImmediate(done))
  expect(calls).toEqual([[path]])
  second()
  await new Promise<void>((done) => setImmediate(done))
  expect(calls).toEqual([[path], []])
})

test('注册及焦点复查允许stat跳过，真实文件事件强制二进制内容检查', async () => {
  const { service, reloads, path, change, focus } = fixture()
  const stop = service.watchOpenDocuments()
  try {
    await new Promise<void>((done) => setImmediate(done))
    expect(reloads).toEqual([{ paths: [path], forced: [] }])
    focus()
    await new Promise<void>((done) => setImmediate(done))
    expect(reloads[1]).toEqual({ paths: [path], forced: [] })
    change()
    await new Promise<void>((done) => setImmediate(done))
    expect(reloads[2]).toEqual({ paths: [path], forced: [path] })
  } finally { stop() }
})
