/** Pure IPC contracts: bounded batching, terminal flushes and preload compatibility.
 * Runs the actual main/preload wiring with inert Electron dependencies. No window is launched. */
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import { IPC, type EngineLogBatch, type EngineLogEntry } from '../src/shared/ipc'
import { createEngineLogBatcher, ENGINE_LOG_BATCH_LIMITS } from '../src/main/engine/log-batch'
import { createEngineLogBuffer } from '../src/renderer/src/core/engine/log-buffer'
import type { AetherIdeApi } from '../src/preload'

interface TestClock {
  schedule: (callback: () => void, delay: number) => () => void
  advance: (delay: number) => void
  timers: Map<number, { at: number; callback: () => void }>
}

function clock(): TestClock {
  let now = 0
  let serial = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const schedule = (callback: () => void, delay: number): (() => void) => {
    const id = ++serial
    timers.set(id, { at: now + delay, callback })
    return () => {
      timers.delete(id)
    }
  }
  const advance = (delay: number): void => {
    const end = now + delay
    while (true) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0])
      now = next[1].at
      next[1].callback()
    }
    now = end
  }
  return { schedule, advance, timers }
}

function entry(line: string, ts = 10): EngineLogEntry {
  return { level: 'info', line, ts }
}

function evaluateModule(
  filename: string,
  dependencies: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): unknown {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      // Other services are inert because this fixture only invokes log wiring.
      require: (name: string) => dependencies[name] ?? {},
      ...extra
    },
    { filename }
  )
  return module.exports
}

test('100条日志合成一条IPC，100ms计时从首行开始且顺序不变', () => {
  const fixture = clock()
  const sent: EngineLogBatch[] = []
  const batcher = createEngineLogBatcher((batch) => sent.push(batch), {
    schedule: fixture.schedule
  })
  const originals = Array.from({ length: 100 }, (_, index) => entry(`line-${index}`, index))
  batcher.append(originals[0])
  fixture.advance(90)
  for (const value of originals.slice(1)) batcher.append(value)
  expect(fixture.timers.size).toBe(1)
  fixture.advance(9)
  expect(sent).toEqual([])
  fixture.advance(1)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toEqual(originals)
  expect(fixture.timers.size).toBe(0)
  batcher.flush()
  expect(sent).toHaveLength(1)
})

test('数量预算提前发送，10,000条突发没有超大批次或重排', () => {
  const fixture = clock()
  const sent: EngineLogBatch[] = []
  const batcher = createEngineLogBatcher((batch) => sent.push(batch), {
    schedule: fixture.schedule
  })
  const count = 10_000
  for (let index = 0; index < count; index++) batcher.append(entry(`line-${index}`, index))
  expect(sent).toHaveLength(Math.floor(count / ENGINE_LOG_BATCH_LIMITS.entries))
  expect(fixture.timers.size).toBe(1)
  batcher.dispose()
  expect(sent).toHaveLength(Math.ceil(count / ENGINE_LOG_BATCH_LIMITS.entries))
  expect(sent.every((batch) => batch.length <= ENGINE_LOG_BATCH_LIMITS.entries)).toBe(true)
  expect(sent.flat().map((value) => value.ts)).toEqual(
    Array.from({ length: count }, (_, index) => index)
  )
  expect(fixture.timers.size).toBe(0)
  fixture.advance(100)
  batcher.append(entry('after dispose'))
  batcher.dispose()
  expect(sent.flat()).toHaveLength(count)
})

test('字符预算和超长行限制覆盖UTF16边界，并保留渲染端截断说明', () => {
  const fixture = clock()
  const sent: EngineLogBatch[] = []
  const batcher = createEngineLogBatcher((batch) => sent.push(batch), {
    entries: 10,
    characters: 8,
    lineCharacters: 4,
    schedule: fixture.schedule
  })
  batcher.append(entry('123'))
  batcher.append(entry('5678'))
  batcher.append(entry('ab😀c'))
  expect(sent).toHaveLength(1)
  expect(sent[0].map((value) => value.line)).toEqual(['123', '5678'])
  batcher.flush()
  expect(sent[1]).toEqual([{ ...entry('ab…'), truncated: true }])
  expect(sent.every((batch) => batch.reduce((sum, value) => sum + value.line.length, 0) <= 8)).toBe(
    true
  )
  const buffer = createEngineLogBuffer()
  buffer.append(sent[1][0])
  expect(buffer.getSnapshot().entries[0]).toMatchObject({ line: 'ab…', truncated: true })

  const single = createEngineLogBatcher((batch) => sent.push(batch), { characters: 1 })
  single.append(entry('😀'))
  expect(sent.at(-1)).toEqual([{ ...entry('…'), truncated: true }])
  single.dispose()
})

test('真实主进程接线在终态与退出前发送末批，退出取消订阅和计时器', () => {
  const fixture = clock()
  const app = new EventEmitter()
  const engine = new EventEmitter()
  const logs = new EventEmitter()
  const sent: Array<{ channel: string; payload: unknown }> = []
  const destroyedSends: unknown[] = []
  const module = evaluateModule(resolve(__dirname, '../src/main/ipc.ts'), {
    electron: {
      app,
      ipcMain: { handle: () => {} },
      webContents: {
        getAllWebContents: () => [
          {
            isDestroyed: () => false,
            send: (channel: string, payload: unknown) => sent.push({ channel, payload })
          },
          { isDestroyed: () => true, send: (...args: unknown[]) => destroyedSends.push(args) }
        ]
      }
    },
    '../shared/ipc': { IPC },
    './account/service': { configureAccountService: () => {} },
    './graphics': { onGraphicsChanged: () => () => {} },
    './engine/host': { engineHost: engine },
    './engine/logger': {
      onEngineLog: (listener: (value: EngineLogEntry) => void) => {
        logs.on('log', listener)
        return () => {
          logs.removeListener('log', listener)
        }
      }
    },
    './engine/log-batch': {
      createEngineLogBatcher: (send: (batch: EngineLogBatch) => void) =>
        createEngineLogBatcher(send, { schedule: fixture.schedule })
    }
  }) as typeof import('../src/main/ipc')
  module.registerIpcHandlers()
  logs.emit('log', entry('startup failure'))
  expect(sent).toHaveLength(0)
  engine.emit('snapshot', { phase: 'error' })
  expect(sent.map((value) => value.channel)).toEqual([
    IPC.event.engineLogs,
    IPC.event.engineSnapshot
  ])
  expect(sent[0].payload).toEqual([entry('startup failure')])
  logs.emit('log', entry('stopped'))
  engine.emit('snapshot', { phase: 'idle' })
  expect(sent[2]).toEqual({ channel: IPC.event.engineLogs, payload: [entry('stopped')] })
  logs.emit('log', entry('before quit'))
  app.emit('before-quit')
  expect(sent.at(-1)?.payload).toEqual([entry('before quit')])
  // The first quit may be prevented while the owned engine is still stopping.
  logs.emit('log', entry('cleanup tail'))
  app.emit('before-quit')
  expect(sent.at(-1)?.payload).toEqual([entry('cleanup tail')])
  logs.emit('log', entry('final tail'))
  app.emit('will-quit')
  expect(sent.at(-1)?.payload).toEqual([entry('final tail')])
  expect(logs.listenerCount('log')).toBe(0)
  expect(app.listenerCount('before-quit')).toBe(0)
  expect(fixture.timers.size).toBe(0)
  expect(destroyedSends).toHaveLength(0)
  expect(sent.some((value) => value.channel === IPC.event.engineLog)).toBe(false)
  const total = sent.length
  logs.emit('log', entry('too late'))
  fixture.advance(100)
  expect(sent).toHaveLength(total)
})

test('真实preload按原onLog接口展开批次，兼容旧通道并完整解除监听', () => {
  const ipc = new EventEmitter()
  const worlds = new Map<string, unknown>()
  evaluateModule(
    resolve(__dirname, '../src/preload/index.ts'),
    {
      electron: {
        contextBridge: {
          exposeInMainWorld: (name: string, value: unknown) => worlds.set(name, value)
        },
        ipcRenderer: ipc
      },
      '@electron-toolkit/preload': { electronAPI: {} },
      '../shared/ipc': { IPC },
      '../shared/browser-api': { BROWSER_IPC: {} }
    },
    { process: { contextIsolated: true }, console }
  )
  const api = worlds.get('aether') as AetherIdeApi
  const received: EngineLogEntry[] = []
  const off = api.engine.onLog((value) => received.push(value))
  expect(ipc.listenerCount(IPC.event.engineLog)).toBe(1)
  expect(ipc.listenerCount(IPC.event.engineLogs)).toBe(1)
  const values = [entry('legacy'), entry('first batch'), entry('second batch')]
  ipc.emit(IPC.event.engineLog, {}, values[0])
  ipc.emit(IPC.event.engineLogs, {}, values.slice(1))
  ipc.emit(IPC.event.engineLogs, {}, [])
  expect(received).toEqual(values)
  off()
  off()
  expect(ipc.listenerCount(IPC.event.engineLog)).toBe(0)
  expect(ipc.listenerCount(IPC.event.engineLogs)).toBe(0)
  ipc.emit(IPC.event.engineLog, {}, entry('late legacy'))
  ipc.emit(IPC.event.engineLogs, {}, [entry('late batch')])
  expect(received).toEqual(values)
})
