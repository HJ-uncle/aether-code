/** Pure production-function contracts: cancel notifications never replace timeout/cancel errors with unhandled transport rejections. */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

function harness() {
  const file = join(process.cwd(), 'src/renderer/src/core/lsp/ts-client.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set(['lspRequest', 'lspNotify'])
  const functions = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text))
  if (functions.length !== names.size) throw new Error('Production LSP cancellation functions not found')
  const code = ts.transpileModule(functions.map(statement => statement.getText(source)).join('\n') + '\nglobalThis.request = lspRequest', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const timers = new Map<number, () => void>()
  let timerId = 0
  const pendingRequests = new Map()
  const notifications: Array<{ method: string; params: { id: number } }> = []
  let cancellation: (() => void) | undefined
  let disposed = 0
  const context = vm.createContext({
    nextId: 1, REQUEST_TIMEOUT_MS: 100, pendingRequests, remoteTransport: true,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId },
    clearTimeout: (id: number) => { timers.delete(id) },
    sendMessage: (message: { method: string; params: { id: number } }) => {
      if (message.method === '$/cancelRequest') {
        notifications.push(message)
        return Promise.reject(new Error('Cancellation notification transport unavailable'))
      }
      return new Promise(() => {})
    }
  }) as vm.Context & { request: (method: string, params: unknown, token?: unknown) => Promise<unknown> }
  vm.runInContext(code, context)
  return {
    request: context.request,
    timers, pendingRequests, notifications,
    token: { isCancellationRequested: false, onCancellationRequested: (callback: () => void) => {
      cancellation = callback
      return { dispose: () => { disposed++ } }
    } },
    cancel: () => { if (!cancellation) throw new Error('No cancellation listener'); cancellation() },
    disposed: () => disposed
  }
}

test('timeout settles its owned request and handles a failed cancel notification', async () => {
  const state = harness()
  const request = state.request('textDocument/hover', { textDocument: { uri: 'file:///owned/index.ts' } })
  const outcome = request.catch(error => error.message as string)
  state.timers.get(1)!()
  expect(await outcome).toBe('LSP request timed out: textDocument/hover')
  await new Promise(resolve => setImmediate(resolve))
  expect(state.notifications).toEqual([{ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } }])
  expect(state.pendingRequests.size).toBe(0)
})

test('user cancellation clears its timer/listener and handles a failed notification', async () => {
  const state = harness()
  const request = state.request('textDocument/definition', {}, state.token)
  const outcome = request.catch(error => error.message as string)
  state.cancel()
  expect(await outcome).toBe('LSP request cancelled')
  await new Promise(resolve => setImmediate(resolve))
  expect(state.notifications).toEqual([{ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } }])
  expect(state.timers.size).toBe(0)
  expect(state.pendingRequests.size).toBe(0)
  expect(state.disposed()).toBe(1)
})

test('an already cancelled request creates no timer, transport or pending entry', async () => {
  const state = harness()
  const outcome = await state.request('textDocument/hover', {}, { isCancellationRequested: true }).then(
    () => ({ status: 'resolved' }), error => ({ status: 'rejected', message: error.message })
  )
  expect(outcome).toEqual({ status: 'rejected', message: 'LSP request cancelled' })
  expect(state.timers.size).toBe(0)
  expect(state.pendingRequests.size).toBe(0)
  expect(state.notifications).toEqual([])
})
