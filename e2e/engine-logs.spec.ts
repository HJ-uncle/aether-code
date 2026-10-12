/** Pure log contracts: bounded retention, batched notifications, stable IDs,
 * clear and capture ownership. No Electron window, engine or network is used. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { EngineLogEntry } from '../src/shared/ipc'
import {
  createEngineLogBuffer,
  ENGINE_LOG_LIMITS
} from '../src/renderer/src/core/engine/log-buffer'

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

const entry = (line: string, level: EngineLogEntry['level'] = 'info'): EngineLogEntry => ({
  line,
  level,
  ts: 10
})

test('日志突发只在100ms批次通知，快照和既有日志ID保持稳定', () => {
  const fixture = clock()
  const buffer = createEngineLogBuffer({ schedule: fixture.schedule })
  let notifications = 0
  const off = buffer.subscribe(() => notifications++)
  const empty = buffer.getSnapshot()
  expect(buffer.getSnapshot()).toBe(empty)
  for (let index = 0; index < 50; index++) buffer.append(entry(`log-${index}`))
  expect(notifications).toBe(0)
  expect(fixture.timers.size).toBe(1)
  fixture.advance(99)
  expect(notifications).toBe(0)
  const first = buffer.getSnapshot()
  expect(first.entries).toHaveLength(50)
  expect(buffer.getSnapshot()).toBe(first)
  fixture.advance(1)
  expect(notifications).toBe(1)
  buffer.append(entry('next', 'error'))
  fixture.advance(100)
  const next = buffer.getSnapshot()
  expect(notifications).toBe(2)
  expect(next.entries[0]).toBe(first.entries[0])
  expect(next.entries.at(-1)).toMatchObject({ id: 51, level: 'error', line: 'next' })
  expect(first.entries).toHaveLength(50)
  off()
})

test('日志没有可见订阅时继续保留最新500行且不创建发布定时器', () => {
  const fixture = clock()
  const buffer = createEngineLogBuffer({ schedule: fixture.schedule })
  for (let index = 0; index < 550; index++) buffer.append(entry(`log-${index}`))
  const snapshot = buffer.getSnapshot()
  expect(snapshot.entries).toHaveLength(ENGINE_LOG_LIMITS.entries)
  expect(snapshot.entries[0]).toMatchObject({ id: 51, line: 'log-50' })
  expect(snapshot.entries.at(-1)).toMatchObject({ id: 550, line: 'log-549' })
  expect(snapshot.discarded).toBe(50)
  expect(fixture.timers.size).toBe(0)

  let notifications = 0
  const off = buffer.subscribe(() => notifications++)
  buffer.append(entry('pending'))
  expect(fixture.timers.size).toBe(1)
  off()
  expect(fixture.timers.size).toBe(0)
  fixture.advance(100)
  expect(notifications).toBe(0)
  expect(buffer.getSnapshot().entries.at(-1)?.line).toBe('pending')
})

test('总字符与单行上限独立生效，截断不分裂UTF16字符', () => {
  const buffer = createEngineLogBuffer({ entries: 5, characters: 8, lineCharacters: 4 })
  buffer.append(entry('1234'))
  buffer.append(entry('5678'))
  const previous = buffer.getSnapshot()
  buffer.append(entry('ab😀c', 'warn'))
  const next = buffer.getSnapshot()
  expect(next.entries.map((log) => log.line)).toEqual(['5678', 'ab…'])
  expect(next.entries.at(-1)).toMatchObject({ truncated: true, level: 'warn' })
  expect(next.entries.reduce((sum, log) => sum + log.line.length, 0)).toBeLessThanOrEqual(8)
  expect(next.discarded).toBe(1)
  expect(previous.entries.map((log) => log.line)).toEqual(['1234', '5678'])
  expect(next.entries[0]).toBe(previous.entries[1])
})

test('清空立即发布并取消待发批次，新的日志不复用旧ID', () => {
  const fixture = clock()
  const buffer = createEngineLogBuffer({ entries: 2, schedule: fixture.schedule })
  let notifications = 0
  const off = buffer.subscribe(() => notifications++)
  buffer.append(entry('first'))
  buffer.append(entry('second'))
  buffer.append(entry('third'))
  buffer.clear()
  expect(notifications).toBe(1)
  expect(buffer.getSnapshot()).toEqual({ entries: [], discarded: 0 })
  expect(fixture.timers.size).toBe(0)
  fixture.advance(100)
  expect(notifications).toBe(1)
  buffer.clear()
  expect(notifications).toBe(1)
  buffer.append(entry('fourth'))
  fixture.advance(100)
  expect(buffer.getSnapshot().entries[0]).toMatchObject({ id: 4, line: 'fourth' })
  expect(notifications).toBe(2)
  off()
})

interface CaptureFixture {
  store: typeof import('../src/renderer/src/core/engine/log-store')
  fixture: TestClock
  callbacks: Array<(entry: EngineLogEntry) => void>
  connections: () => number
  disconnections: () => number
  emit: (value: EngineLogEntry) => void
}

function captureFixture(): CaptureFixture {
  const fixture = clock()
  const buffer = createEngineLogBuffer({ schedule: fixture.schedule })
  const listeners = new Set<(entry: EngineLogEntry) => void>()
  const callbacks: Array<(entry: EngineLogEntry) => void> = []
  let connections = 0
  let disconnections = 0
  const filename = resolve(__dirname, '../src/renderer/src/core/engine/log-store.ts')
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === 'react')
          return {
            useSyncExternalStore: () => {
              throw new Error('Pure capture test must not render')
            }
          }
        if (name === './log-buffer') return { createEngineLogBuffer: () => buffer }
        if (name === './client')
          return {
            onEngineLog: (listener: (entry: EngineLogEntry) => void) => {
              connections++
              listeners.add(listener)
              callbacks.push(listener)
              return () => {
                disconnections++
                listeners.delete(listener)
              }
            }
          }
        throw new Error(`Unexpected log capture dependency: ${name}`)
      }
    },
    { filename }
  )
  return {
    store: module.exports as typeof import('../src/renderer/src/core/engine/log-store'),
    fixture,
    callbacks,
    connections: () => connections,
    disconnections: () => disconnections,
    emit: (value: EngineLogEntry) => {
      for (const listener of listeners) listener(value)
    }
  }
}

test('日志捕获共用一次IPC订阅，最后持有者释放并拒绝旧生命周期回调', () => {
  const fixture = captureFixture()
  const first = fixture.store.captureEngineLogs()
  const second = fixture.store.captureEngineLogs()
  expect(fixture.connections()).toBe(1)
  const off = fixture.store.subscribeEngineLogs(() => {})
  fixture.emit(entry('captured'))
  expect(fixture.fixture.timers.size).toBe(1)
  first()
  first()
  expect(fixture.disconnections()).toBe(0)
  second()
  expect(fixture.disconnections()).toBe(1)
  expect(fixture.fixture.timers.size).toBe(0)
  fixture.callbacks[0](entry('late old callback'))
  const restart = fixture.store.captureEngineLogs()
  expect(fixture.connections()).toBe(2)
  fixture.callbacks[0](entry('old callback after restart'))
  fixture.emit(entry('new lifecycle'))
  expect(fixture.store.getEngineLogs().entries.map((log) => log.line)).toEqual([
    'captured',
    'new lifecycle'
  ])
  fixture.store.clearEngineLogs()
  expect(fixture.store.getEngineLogs().entries).toHaveLength(0)
  restart()
  expect(fixture.disconnections()).toBe(2)
  off()
})

test('引擎日志不会写入生命周期React状态或改变其共享返回对象', () => {
  const capture = captureFixture()
  let cursor = 0
  let stateWrites = 0
  const slots: Array<{ value: unknown; deps?: readonly unknown[] }> = []
  const effects: Array<() => (() => void) | void> = []
  const cleanups: Array<() => void> = []
  const memo = (factory: () => unknown, deps: readonly unknown[]): unknown => {
    const index = cursor++
    const previous = slots[index]
    if (
      !previous ||
      !previous.deps ||
      previous.deps.length !== deps.length ||
      previous.deps.some((value, key) => value !== deps[key])
    ) {
      slots[index] = { value: factory(), deps }
    }
    return slots[index].value
  }
  const filename = resolve(__dirname, '../src/renderer/src/core/engine/useEngine.ts')
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const clients = {
    getSnapshot: () => new Promise<never>(() => {}),
    onSnapshot: () => () => {},
    startEngine: async () => {},
    stopEngine: async () => {},
    restartEngine: async () => {}
  }
  runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === 'react')
          return {
            useState: (initial: unknown) => {
              const index = cursor++
              slots[index] ??= { value: initial }
              return [
                slots[index].value,
                (value: unknown) => {
                  slots[index].value = value
                  stateWrites++
                }
              ]
            },
            useMemo: memo,
            useCallback: (callback: unknown, deps: readonly unknown[]) =>
              memo(() => callback, deps),
            useEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) =>
              memo(() => {
                effects.push(effect)
              }, deps)
          }
        if (name === './client') return clients
        if (name === './source') return { publishEngineSource: () => {} }
        if (name === './log-store') return capture.store
        throw new Error(`Unexpected engine lifecycle dependency: ${name}`)
      }
    },
    { filename }
  )
  const { useEngine: runEngineHook } =
    module.exports as typeof import('../src/renderer/src/core/engine/useEngine')
  const render = (): ReturnType<typeof runEngineHook> => {
    cursor = 0
    return runEngineHook()
  }
  const first = render()
  for (const effect of effects) {
    const cleanup = effect()
    if (cleanup) cleanups.push(cleanup)
  }
  expect(capture.connections()).toBe(1)
  for (let index = 0; index < 100; index++) capture.emit(entry(`background-${index}`))
  expect(stateWrites).toBe(0)
  expect(capture.store.getEngineLogs().entries).toHaveLength(100)
  expect(render()).toBe(first)
  expect(Object.keys(first).sort()).toEqual(['restart', 'snapshot', 'start', 'stop'])
  for (const cleanup of cleanups) cleanup()
  expect(capture.disconnections()).toBe(1)
})
