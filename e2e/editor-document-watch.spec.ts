/** 纯逻辑：StrictMode 重挂载时，旧文件监听清理不能覆盖新监听注册。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'

test('连续安装、卸载、重装后保留新实例监听，最后卸载才清空', async () => {
  const path = 'D:/workspace/file.txt'
  const calls: string[][] = []
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(resolve(__dirname, '../src/renderer/src/core/editor/document-sync.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports, console,
    require: () => ({
      getEditorState: () => ({ docs: new Map([[path, {}]]), saving: new Set() }),
      onEditorChanged: () => () => {}, reloadDocuments: async () => {}, resolveDocumentPath: (value: string) => value,
      isRemoteEngine: () => false
    }),
    window: {
      addEventListener: () => {}, removeEventListener: () => {},
      aether: { fs: {
        watchDocuments: async (paths: string[]) => { calls.push([...paths]) },
        onDocumentsChanged: () => () => {}
      } }
    }
  })
  const service = module.exports as { watchOpenDocuments(): () => void }
  const first = service.watchOpenDocuments()
  first()
  const second = service.watchOpenDocuments()
  await new Promise<void>((done) => setImmediate(done))
  expect(calls).toEqual([[path]])
  second()
  await new Promise<void>((done) => setImmediate(done))
  expect(calls).toEqual([[path], []])
})
