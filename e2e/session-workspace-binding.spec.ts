/** Work workspace binding: concurrent panels share one session lease request. No Electron or models. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import { bindSessionWorkspace } from '../src/renderer/src/core/workspace/fs-client'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let previousWindow: PropertyDescriptor | undefined
let calls: EngineRequestInput[]

test.beforeEach(() => {
  calls = []
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: `binding-${Date.now()}-${Math.random()}` })
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
})

test.afterEach(() => {
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'idle', instanceId: undefined })
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('并发绑定同一 Work 会话只发送一次请求，两个面板都得到工作区', async () => {
  const bindGate = deferred<void>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      calls.push(input)
      if (input.path === '/workspace/bind') {
        await bindGate.promise
        return { ok: true, code: 200, data: {} }
      }
      if (input.path === '/workspace/directory') return { ok: true, code: 200, data: { root: 'D:/projects/acme', entries: [] } }
      throw new Error(`unexpected ${input.path}`)
    }
  } } } })

  const first = bindSessionWorkspace('work-acme', 'D:/projects/acme')
  const second = bindSessionWorkspace('work-acme', 'D:/projects/acme')
  await Promise.resolve()
  expect(calls.filter(input => input.path === '/workspace/bind')).toHaveLength(1)
  bindGate.resolve()
  await expect(Promise.all([first, second])).resolves.toEqual([
    { sessionId: 'work-acme', root: 'D:/projects/acme' },
    { sessionId: 'work-acme', root: 'D:/projects/acme' }
  ])
  expect(calls.filter(input => input.path === '/workspace/directory')).toHaveLength(1)
})

test('绑定失败后清理合并缓存，下一次显式绑定可以重试', async () => {
  let bindCount = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      calls.push(input)
      if (input.path === '/workspace/bind') {
        bindCount += 1
        if (bindCount === 1) return { ok: false, code: 40900, message: 'busy' }
        return { ok: true, code: 200, data: {} }
      }
      if (input.path === '/workspace/directory') return { ok: true, code: 200, data: { root: 'D:/projects/acme', entries: [] } }
      throw new Error(`unexpected ${input.path}`)
    }
  } } } })

  await expect(bindSessionWorkspace('work-acme', 'D:/projects/acme')).rejects.toThrow('busy')
  await expect(bindSessionWorkspace('work-acme', 'D:/projects/acme')).resolves.toEqual({ sessionId: 'work-acme', root: 'D:/projects/acme' })
  expect(calls.filter(input => input.path === '/workspace/bind')).toHaveLength(2)
})
