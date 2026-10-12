/** Pure lifecycle contracts: real graphics-module recovery records and capability
 * broadcasts, plus the real renderer hook's material/OS transitions. Electron,
 * disk writes and React rendering are replaced by deterministic adapters. */
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import * as graphicsPolicy from '../src/shared/graphics'
import type {
  GraphicsMode,
  GraphicsSnapshot,
  GraphicsRecovery,
  VisualEffects
} from '../src/shared/graphics'

interface RecoveryRecord {
  version: 1
  pendingSince?: string
  failure?: GraphicsRecovery
}

interface Timer {
  at: number
  callback: () => void
  unref: () => void
}

interface Clock {
  setTimeout: (callback: () => void, delay: number) => Timer
  clearTimeout: (timer: Timer | undefined) => void
  advance: (delay: number) => void
  timers: Set<Timer>
  unrefs: () => number
}

function clock(): Clock {
  let now = 0
  let unrefs = 0
  const timers = new Set<Timer>()
  const setTimeout = (callback: () => void, delay: number): Timer => {
    const timer = {
      at: now + delay,
      callback,
      unref: (): void => {
        unrefs++
      }
    }
    timers.add(timer)
    return timer
  }
  const clearTimeout = (timer: Timer | undefined): void => {
    if (timer) timers.delete(timer)
  }
  const advance = (delay: number): void => {
    const end = now + delay
    while (true) {
      const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      timers.delete(next)
      now = next.at
      next.callback()
    }
    now = end
  }
  return { setTimeout, clearTimeout, advance, timers, unrefs: () => unrefs }
}

function evaluateModule(
  filename: string,
  dependencies: Record<string, unknown>,
  globals: Record<string, unknown> = {}
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
      require: (name: string) => {
        if (!(name in dependencies)) throw new Error(`Unexpected graphics dependency: ${name}`)
        return dependencies[name]
      },
      ...globals
    },
    { filename }
  )
  return module.exports
}

class GraphicsApp extends EventEmitter {
  ready = false
  feature: string | undefined = 'enabled'
  disableCalls = 0
  featureReads = 0
  switches: string[] = []
  commandLine = {
    appendSwitch: (name: string): void => {
      this.switches.push(name)
    }
  }
  getPath(): string {
    return 'virtual-graphics-profile'
  }
  isReady(): boolean {
    return this.ready
  }
  getGPUFeatureStatus(): { gpu_compositing?: string } {
    this.featureReads++
    return { gpu_compositing: this.feature }
  }
  disableHardwareAcceleration(): void {
    this.disableCalls++
  }
}

interface GraphicsFixture {
  api: typeof import('../src/main/graphics')
  app: GraphicsApp
  clock: Clock
  files: Map<string, string>
  settings: { graphicsMode: GraphicsMode }
  recoveryPath: string
  writes: () => number
  record: () => RecoveryRecord
}

function graphicsFixture(
  options: {
    mode?: GraphicsMode
    record?: RecoveryRecord | string
    files?: Map<string, string>
    feature?: string | null
    override?: string
  } = {}
): GraphicsFixture {
  const app = new GraphicsApp()
  if (options.feature !== undefined) app.feature = options.feature ?? undefined
  const timer = clock()
  const files = options.files ?? new Map<string, string>()
  const recoveryPath = join(app.getPath(), 'graphics-recovery.json')
  if (options.record !== undefined)
    files.set(
      recoveryPath,
      typeof options.record === 'string' ? options.record : JSON.stringify(options.record)
    )
  let writes = 0
  const settings = { graphicsMode: options.mode ?? 'auto' }
  const api = evaluateModule(
    resolve(__dirname, '../src/main/graphics.ts'),
    {
      electron: { app },
      'node:path': { join },
      'node:fs': {
        mkdirSync: () => {},
        readFileSync: (path: string): string => {
          const value = files.get(path)
          if (value === undefined) throw new Error('ENOENT')
          return value
        },
        writeFileSync: (path: string, content: string): void => {
          writes++
          files.set(path, content)
        },
        renameSync: (from: string, to: string): void => {
          const content = files.get(from)
          if (content === undefined) throw new Error('ENOENT')
          files.set(to, content)
          files.delete(from)
        },
        rmSync: (path: string): void => {
          files.delete(path)
        }
      },
      './settings-store': { getSettings: () => settings },
      '../shared/graphics': graphicsPolicy
    },
    {
      process: { platform: 'win32', env: { AETHER_ENABLE_GPU: options.override }, pid: 42 },
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout
    }
  ) as typeof import('../src/main/graphics')
  return {
    api,
    app,
    clock: timer,
    files,
    settings,
    recoveryPath,
    writes: () => writes,
    record: (): RecoveryRecord => JSON.parse(files.get(recoveryPath) ?? 'null')
  }
}

const previousFailure: GraphicsRecovery = {
  reason: 'gpu-process-failed',
  at: '2026-10-12T00:00:00.000Z',
  exitCode: -1
}

test('图形模块加载不会写入启动标记，只有获锁实例初始化才记录尝试', () => {
  const fixture = graphicsFixture()
  fixture.api.configureGraphics()
  expect(fixture.writes()).toBe(0)
  expect(fixture.files.has(fixture.recoveryPath)).toBe(false)
  expect(fixture.app.listenerCount('gpu-info-update')).toBe(0)
  expect(fixture.app.disableCalls).toBe(0)
  fixture.api.initializeGraphicsRecovery()
  expect(fixture.writes()).toBe(1)
  expect(fixture.record()).toMatchObject({ version: 1, pendingSince: expect.any(String) })
  expect(fixture.record().failure).toBeUndefined()
  expect(fixture.app.listenerCount('gpu-info-update')).toBe(1)
})

test('健康确认前正常退出会清理标记和计时器，不把下次启动误判为异常', () => {
  const fixture = graphicsFixture()
  fixture.api.initializeGraphicsRecovery()
  fixture.app.ready = true
  fixture.api.confirmGraphicsStartup()
  expect(fixture.clock.timers.size).toBe(1)
  expect(fixture.clock.unrefs()).toBe(1)
  fixture.app.emit('will-quit')
  expect(fixture.clock.timers.size).toBe(0)
  expect(fixture.record()).toEqual({ version: 1 })
  const restart = graphicsFixture({ files: fixture.files })
  restart.app.ready = true
  expect(restart.api.getGraphicsSnapshot()).toMatchObject({
    hardwareAcceleration: true,
    recovery: null
  })
})

test('未完成启动保守归类为interrupted，持久软件回退直到用户明确重试', () => {
  const at = '2026-10-12T00:00:00.000Z'
  const fixture = graphicsFixture({ record: { version: 1, pendingSince: at } })
  fixture.api.configureGraphics()
  expect(fixture.app.disableCalls).toBe(1)
  expect(fixture.app.switches).toEqual(['in-process-gpu'])
  fixture.api.initializeGraphicsRecovery()
  fixture.api.confirmGraphicsStartup()
  expect(fixture.clock.timers.size).toBe(0)
  expect(fixture.record()).toEqual({ version: 1, failure: { reason: 'startup-interrupted', at } })
  expect(fixture.api.getGraphicsSnapshot()).toMatchObject({
    hardwareAcceleration: false,
    restartRequired: false
  })
  const unchanged = graphicsFixture({ files: fixture.files })
  expect(unchanged.api.getGraphicsSnapshot().recovery?.reason).toBe('startup-interrupted')

  const reset = fixture.api.resetGraphicsRecovery()
  expect(reset).toMatchObject({
    recovery: null,
    restartRequired: true,
    hardwareAcceleration: false
  })
  expect(fixture.record()).toEqual({ version: 1 })
  const retry = graphicsFixture({ files: fixture.files })
  retry.api.configureGraphics()
  retry.api.initializeGraphicsRecovery()
  retry.app.ready = true
  retry.api.confirmGraphicsStartup()
  retry.clock.advance(5_000)
  expect(retry.app.disableCalls).toBe(0)
  expect(retry.record()).toEqual({ version: 1 })
  expect(retry.api.getGraphicsSnapshot()).toMatchObject({
    recovery: null,
    hardwareAcceleration: true
  })
})

test('真实GPU故障持久化确认原因，忽略正常GPU退出和其它进程故障', () => {
  const fixture = graphicsFixture()
  fixture.api.initializeGraphicsRecovery()
  fixture.app.ready = true
  fixture.api.confirmGraphicsStartup()
  fixture.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 })
  fixture.app.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: -2 })
  expect(fixture.record().failure).toBeUndefined()
  expect(fixture.clock.timers.size).toBe(1)
  fixture.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: -7 })
  expect(fixture.record()).toMatchObject({
    version: 1,
    failure: { reason: 'gpu-process-failed', exitCode: -7 }
  })
  expect(fixture.record().pendingSince).toBeUndefined()
  expect(fixture.clock.timers.size).toBe(0)
  expect(fixture.api.getGraphicsSnapshot().restartRequired).toBe(true)
  fixture.clock.advance(5_000)
  expect(fixture.record().failure?.reason).toBe('gpu-process-failed')
  const restart = graphicsFixture({ files: fixture.files })
  restart.api.configureGraphics()
  restart.app.ready = true
  expect(restart.app.disableCalls).toBe(1)
  expect(restart.api.getGraphicsSnapshot()).toMatchObject({
    hardwareAcceleration: false,
    recovery: { reason: 'gpu-process-failed', exitCode: -7 }
  })
})

test('明确启用加速可重试旧故障，只有持续健康确认才清除回退记录', () => {
  const fixture = graphicsFixture({
    mode: 'enabled',
    record: { version: 1, failure: previousFailure }
  })
  const changes: GraphicsSnapshot[] = []
  fixture.api.onGraphicsChanged((snapshot) => changes.push(snapshot))
  fixture.api.initializeGraphicsRecovery()
  fixture.app.ready = true
  fixture.api.confirmGraphicsStartup()
  fixture.api.confirmGraphicsStartup()
  expect(fixture.clock.timers.size).toBe(1)
  fixture.clock.advance(4_999)
  expect(fixture.record()).toMatchObject({
    pendingSince: expect.any(String),
    failure: previousFailure
  })
  expect(changes).toHaveLength(0)
  fixture.clock.advance(1)
  expect(fixture.record()).toEqual({ version: 1 })
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ hardwareAcceleration: true, recovery: null })

  const unavailable = graphicsFixture({
    mode: 'enabled',
    feature: 'disabled_software',
    record: { version: 1, failure: previousFailure }
  })
  unavailable.api.initializeGraphicsRecovery()
  unavailable.app.ready = true
  unavailable.api.confirmGraphicsStartup()
  unavailable.clock.advance(5_000)
  expect(unavailable.record().failure).toEqual(previousFailure)
  expect(unavailable.api.getGraphicsSnapshot().hardwareAcceleration).toBe(false)
})

test('清除旧故障不会清掉仍在健康确认中的启动标记', () => {
  const fixture = graphicsFixture({
    mode: 'enabled',
    record: { version: 1, failure: previousFailure }
  })
  fixture.api.initializeGraphicsRecovery()
  const pending = fixture.record().pendingSince
  fixture.api.resetGraphicsRecovery()
  expect(fixture.record()).toEqual({ version: 1, pendingSince: pending })
  const interrupted = graphicsFixture({ files: fixture.files })
  expect(interrupted.api.getGraphicsSnapshot().recovery).toEqual({
    reason: 'startup-interrupted',
    at: pending
  })
})

test('GPU-info动态发布未知、硬件和软件能力，故障时旧状态随后被纠正', () => {
  const fixture = graphicsFixture({ feature: null })
  const changes: GraphicsSnapshot[] = []
  const off = fixture.api.onGraphicsChanged((snapshot) => changes.push(snapshot))
  expect(fixture.api.getGraphicsSnapshot()).toMatchObject({
    gpuCompositing: 'unavailable',
    hardwareAcceleration: false
  })
  expect(fixture.app.featureReads).toBe(0)
  fixture.api.initializeGraphicsRecovery()
  fixture.app.ready = true
  fixture.app.emit('gpu-info-update')
  expect(changes.at(-1)).toMatchObject({
    gpuCompositing: 'unavailable',
    hardwareAcceleration: false
  })
  fixture.app.feature = 'enabled'
  fixture.app.emit('gpu-info-update')
  expect(changes.at(-1)).toMatchObject({ gpuCompositing: 'enabled', hardwareAcceleration: true })
  fixture.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: -7 })
  expect(changes.at(-1)?.recovery?.reason).toBe('gpu-process-failed')
  fixture.app.feature = 'disabled_software'
  fixture.app.emit('gpu-info-update')
  expect(changes).toHaveLength(4)
  expect(changes.at(-1)).toMatchObject({
    gpuCompositing: 'disabled_software',
    hardwareAcceleration: false
  })
  off()
  fixture.app.feature = 'enabled'
  fixture.app.emit('gpu-info-update')
  expect(changes).toHaveLength(4)
})

interface SnapshotRequest {
  resolve: (value: GraphicsSnapshot) => void
  reject: (error: Error) => void
}

interface HookFixture {
  render: (preference: VisualEffects) => void
  unmount: () => void
  emit: (snapshot: GraphicsSnapshot) => void
  resolveInitial: (value: GraphicsSnapshot, index?: number) => Promise<void>
  rejectInitial: (error: Error, index?: number) => Promise<void>
  transparency: (reduce: boolean) => void
  dataset: { visualEffects?: string }
  subscribers: Set<(snapshot: GraphicsSnapshot) => void>
  mediaListeners: Set<() => void>
  requests: SnapshotRequest[]
}

function capability(hardwareAcceleration: boolean): GraphicsSnapshot {
  return {
    configuredMode: 'auto',
    bootMode: 'auto',
    hardwareAcceleration,
    gpuCompositing: hardwareAcceleration ? 'enabled' : 'disabled_software',
    environmentOverride: false,
    restartRequired: false,
    recovery: null
  }
}

/** The adapters run subscriptions and dependency-sensitive effects from the
 * actual hook; they do not duplicate the material policy or revision guards. */
function hookFixture(): HookFixture {
  const dataset: { visualEffects?: string } = {}
  const subscribers = new Set<(snapshot: GraphicsSnapshot) => void>()
  const mediaListeners = new Set<() => void>()
  const requests: SnapshotRequest[] = []
  const media = {
    matches: false,
    addEventListener: (_name: string, listener: () => void): void => {
      mediaListeners.add(listener)
    },
    removeEventListener: (_name: string, listener: () => void): void => {
      mediaListeners.delete(listener)
    }
  }
  let preference: VisualEffects = 'full'
  let unsubscribe: (() => void) | undefined
  let effectCleanup: (() => void) | undefined
  let effectDependencies: readonly unknown[] | undefined
  const render = (next: VisualEffects): void => {
    preference = next
    runEffects(next)
  }
  const module = evaluateModule(
    resolve(__dirname, '../src/renderer/src/core/useVisualEffects.ts'),
    {
      '@shared/graphics': graphicsPolicy,
      react: {
        useSyncExternalStore: (
          subscribe: (listener: () => void) => () => void,
          getSnapshot: () => unknown
        ): unknown => {
          unsubscribe ??= subscribe(() => render(preference))
          return getSnapshot()
        },
        useEffect: (effect: () => (() => void) | void, dependencies: readonly unknown[]): void => {
          if (
            effectDependencies?.length === dependencies.length &&
            dependencies.every((value, index) => value === effectDependencies?.[index])
          )
            return
          effectCleanup?.()
          effectDependencies = dependencies
          effectCleanup = effect() ?? undefined
        }
      }
    },
    {
      document: { documentElement: { dataset } },
      window: {
        matchMedia: () => media,
        aether: {
          graphics: {
            onChanged: (listener: (value: GraphicsSnapshot) => void): (() => void) => {
              subscribers.add(listener)
              return () => {
                subscribers.delete(listener)
              }
            },
            getSnapshot: (): Promise<GraphicsSnapshot> =>
              new Promise((resolve, reject) => requests.push({ resolve, reject }))
          }
        }
      }
    }
  ) as typeof import('../src/renderer/src/core/useVisualEffects')
  const runEffects = module.useVisualEffects
  return {
    render,
    dataset,
    subscribers,
    mediaListeners,
    requests,
    unmount: (): void => {
      unsubscribe?.()
      unsubscribe = undefined
      effectCleanup?.()
      effectCleanup = undefined
      effectDependencies = undefined
    },
    emit: (value: GraphicsSnapshot): void => {
      for (const listener of subscribers) listener(value)
    },
    resolveInitial: async (value: GraphicsSnapshot, index = 0): Promise<void> => {
      requests[index].resolve(value)
      await Promise.resolve()
      await Promise.resolve()
    },
    rejectInitial: async (error: Error, index = 0): Promise<void> => {
      requests[index].reject(error)
      await Promise.resolve()
      await Promise.resolve()
    },
    transparency: (reduce: boolean): void => {
      media.matches = reduce
      for (const listener of mediaListeners) listener()
    }
  }
}

test('真实材质hook从安全首帧切换full/reduced/auto，OS透明度与GPU丢失即时降级', async () => {
  const fixture = hookFixture()
  fixture.render('full')
  expect(fixture.dataset.visualEffects).toBe('solid')
  await fixture.resolveInitial(capability(true))
  expect(fixture.dataset.visualEffects).toBe('full')
  fixture.render('reduced')
  expect(fixture.dataset.visualEffects).toBe('reduced')
  fixture.render('solid')
  expect(fixture.dataset.visualEffects).toBe('solid')
  fixture.render('auto')
  expect(fixture.dataset.visualEffects).toBe('reduced')
  fixture.transparency(true)
  expect(fixture.dataset.visualEffects).toBe('solid')
  fixture.transparency(false)
  expect(fixture.dataset.visualEffects).toBe('reduced')
  fixture.render('full')
  fixture.emit(capability(false))
  expect(fixture.dataset.visualEffects).toBe('solid')
  fixture.emit(capability(true))
  expect(fixture.dataset.visualEffects).toBe('full')
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.subscribers.size).toBe(1)
  expect(fixture.mediaListeners.size).toBe(1)
  fixture.unmount()
  expect(fixture.subscribers.size).toBe(0)
  expect(fixture.mediaListeners.size).toBe(0)
})

test('初次IPC查询的迟到快照不能覆盖较新的能力事件', async () => {
  const fixture = hookFixture()
  fixture.render('full')
  fixture.emit(capability(true))
  expect(fixture.dataset.visualEffects).toBe('full')
  await fixture.resolveInitial(capability(false))
  expect(fixture.dataset.visualEffects).toBe('full')
  fixture.unmount()
})

test('卸载后的查询被拒绝，重新挂载使用新生命周期快照', async () => {
  const fixture = hookFixture()
  fixture.render('full')
  fixture.unmount()
  fixture.render('reduced')
  expect(fixture.requests).toHaveLength(2)
  expect(fixture.subscribers.size).toBe(1)
  await fixture.resolveInitial(capability(true), 0)
  expect(fixture.dataset.visualEffects).toBe('solid')
  await fixture.resolveInitial(capability(true), 1)
  expect(fixture.dataset.visualEffects).toBe('reduced')
  fixture.unmount()
})

test('能力查询失败仍保持安全实色，后续能力事件可恢复偏好', async () => {
  const fixture = hookFixture()
  fixture.render('full')
  await fixture.rejectInitial(new Error('IPC unavailable'))
  expect(fixture.dataset.visualEffects).toBe('solid')
  fixture.emit(capability(true))
  expect(fixture.dataset.visualEffects).toBe('full')
  fixture.unmount()
})
