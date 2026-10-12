/** Pure browser-timer regression: exercise the real scheduler's default clock,
 * including Chromium-style receiver checks. No Node timer globals are patched. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import * as ts from 'typescript'

const filename = resolve(__dirname, '../src/renderer/src/contrib/work/work-draft-persistence.ts')
const source = readFileSync(filename, 'utf8')
type Scheduler = ReturnType<
  typeof import('../src/renderer/src/contrib/work/work-draft-persistence').createDraftPersistenceScheduler
>

interface Fixture {
  scheduler: Scheduler
  advance: (duration: number) => void
  pending: () => number
  writes: () => number
}

function fixture(): Fixture {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  let now = 0
  let sequence = 0
  let writes = 0
  const jobs = new Map<number, { at: number; callback: () => void }>()
  function nativeSetTimeout(this: unknown, callback: () => void, delay: number): number {
    // A bare strict call defaults to the browser global; a clock-object receiver
    // fails Web IDL's receiver check. Arrow mocks cannot detect this regression.
    if (this !== undefined && this !== browserGlobal) throw new TypeError('Illegal invocation')
    const handle = ++sequence
    jobs.set(handle, { at: now + delay, callback })
    return handle
  }
  function nativeClearTimeout(this: unknown, handle: number): void {
    if (this !== undefined && this !== browserGlobal) throw new TypeError('Illegal invocation')
    jobs.delete(handle)
  }
  const module = { exports: {} }
  const context = createContext({
    module,
    exports: module.exports,
    setTimeout: nativeSetTimeout,
    clearTimeout: nativeClearTimeout
  })
  const browserGlobal: unknown = runInContext('globalThis', context)
  runInContext(code, context, { filename })
  const { createDraftPersistenceScheduler } =
    module.exports as typeof import('../src/renderer/src/contrib/work/work-draft-persistence')
  // Omitting the second argument is essential: injected clocks miss the bug.
  const scheduler = createDraftPersistenceScheduler(() => {
    writes++
  })
  return {
    scheduler,
    pending: () => jobs.size,
    writes: () => writes,
    advance: (duration: number): void => {
      const target = now + duration
      while (true) {
        const next = [...jobs]
          .filter(([, job]) => job.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        jobs.delete(next[0])
        now = next[1].at
        next[1].callback()
      }
      now = target
    }
  }
}

test('默认浏览器clock保留合法接收者，debounce/deadline和flush/cancel没有迟到写入', () => {
  const clock = fixture()
  const save = clock.scheduler
  save.schedule()
  clock.advance(200)
  save.schedule()
  expect(clock.pending()).toBe(2)
  clock.advance(299)
  expect(clock.writes()).toBe(0)
  clock.advance(1)
  expect(clock.writes()).toBe(1)
  expect(clock.pending()).toBe(0)

  for (let index = 0; index < 19; index++) {
    save.schedule()
    clock.advance(100)
  }
  expect(clock.writes()).toBe(1)
  save.schedule()
  clock.advance(99)
  expect(clock.writes()).toBe(1)
  clock.advance(1)
  expect(clock.writes()).toBe(2)
  expect(clock.pending()).toBe(0)

  save.schedule()
  save.flush()
  save.flush()
  expect(clock.writes()).toBe(3)
  expect(clock.pending()).toBe(0)
  clock.advance(3_000)
  expect(clock.writes()).toBe(3)
  save.schedule()
  save.cancel()
  save.cancel()
  clock.advance(3_000)
  expect(clock.writes()).toBe(3)
  expect(clock.pending()).toBe(0)
})
