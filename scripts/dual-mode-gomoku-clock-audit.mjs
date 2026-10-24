/** Independent timestamp scenarios against the generated public clock API. */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

export async function auditClock(workspace) {
  const root = await realpath(workspace), file = await realpath(resolve(root, 'src/clock.js'))
  const rel = relative(root, file); assert.ok(!rel.startsWith('..') && !isAbsolute(rel))
  const source = await readFile(file, 'utf8'), sha256 = createHash('sha256').update(source).digest('hex')
  const sandbox = vm.createContext({ module: { exports: {} } }, { codeGeneration: { strings: false, wasm: false } })
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(`(function(exports,module){${code}\n})(module.exports,module)`, sandbox, { timeout: 2000, filename: file })
  const api = sandbox.module.exports, checks = []
  const check = (name, run) => { try { checks.push({ name, passed: true, detail: run() }) } catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }) } }
  check('G04: unlimited and two genuinely distinct finite clock presets', () => {
    const presets = Object.values(api.TIME_PRESETS)
    assert.ok(presets.some(preset => preset.unlimited))
    assert.ok(new Set(presets.filter(preset => !preset.unlimited).map(preset => preset.totalMs)).size >= 2)
  })
  for (const preset of Object.values(api.TIME_PRESETS).filter(value => !value.unlimited)) {
    check(`G04: ${preset.id} charges only the current player across turn changes`, () => {
      let time = 1000; const now = () => time, clock = api.createClock({ preset: preset.id })
      api.startTurn(clock, 'black', now); time += 1750
      assert.equal(api.getRemaining(clock, 'black', now), preset.totalMs - 1750)
      assert.equal(api.getRemaining(clock, 'white', now), preset.totalMs)
      api.startTurn(clock, 'white', now); time += 2250
      assert.equal(api.getRemaining(clock, 'black', now), preset.totalMs - 1750)
      assert.equal(api.getRemaining(clock, 'white', now), preset.totalMs - 2250)
      return { elapsedBlackMs: 1750, elapsedWhiteMs: 2250 }
    })
    check(`G04: ${preset.id} repeated pause/resume excludes a long pause without double charging`, () => {
      let time = 1000; const now = () => time, clock = api.createClock({ preset: preset.id })
      api.startTurn(clock, 'black', now); time += 2300; api.pause(clock, now); api.pause(clock, now)
      time += 3_600_000
      assert.equal(api.getRemaining(clock, 'black', now), preset.totalMs - 2300)
      assert.equal(api.isPaused(clock), true)
      api.resume(clock, now); api.resume(clock, now); time += 1700
      assert.equal(api.getRemaining(clock, 'black', now), preset.totalMs - 4000)
      assert.equal(api.getRemaining(clock, 'white', now), preset.totalMs)
    })
    check(`G04: ${preset.id} background gap reaches timeout without any refresh ticks`, () => {
      let time = 1000; const now = () => time, clock = api.createClock({ preset: preset.id })
      api.startTurn(clock, 'white', now); time += preset.totalMs + 7000
      const result = api.calibrate(clock, now)
      assert.equal(result.timedOut, true); assert.equal(result.color, 'white')
      assert.equal(api.hasTimedOut(clock), true); assert.equal(api.getRemaining(clock, 'white', now), 0)
      assert.equal(api.getRemaining(clock, 'black', now), preset.totalMs)
      api.resetClock(clock, 'black', now)
      assert.equal(api.hasTimedOut(clock), false)
      assert.equal(api.getRemaining(clock, 'black', now), preset.totalMs)
      assert.equal(api.getRemaining(clock, 'white', now), preset.totalMs)
      return { backgroundGapMs: preset.totalMs + 7000, loser: result.color }
    })
  }
  check('G04: unlimited play never gains a finite timeout', () => {
    const clock = api.createClock({ preset: 'none' })
    api.startTurn(clock, 'black', () => 1000)
    assert.equal(api.calibrate(clock, () => 1_000_000_000).timedOut, false)
    assert.equal(api.getRemaining(clock, 'black', () => 1_000_000_000), Infinity)
  })
  if (typeof api.exportClock === 'function' && typeof api.importClock === 'function') {
    check('G05: taking a save snapshot must not freeze the running live clock', () => {
      let time = 1000; const now = () => time, clock = api.createClock({ preset: 'fast' })
      api.startTurn(clock, 'black', now); time += 1800
      const saved = api.exportClock(clock, now)
      assert.equal(saved.remainingMs.black, 58_200); assert.equal(saved.remainingMs.white, 60_000)
      time += 1200
      assert.equal(api.getRemaining(clock, 'black', now), 57_000, 'Autosave must not silently stop the source clock')
      assert.equal(api.getRemaining(clock, 'white', now), 60_000)
      return { savedBlackMs: saved.remainingMs.black, liveBlackMs: api.getRemaining(clock, 'black', now) }
    })
    check('G05: restoring a clock waits for explicit resume and retains exact millisecond balances', () => {
      let time = 20_000; const now = () => time, clock = api.createClock({ preset: 'none' })
      const restored = api.importClock(clock, { presetId: 'fast', unlimited: false,
        remainingMs: { black: 50_321, white: 58_999 }, status: 'running', activeColor: 'white', timedOutColor: null })
      assert.equal(restored.ok, true); assert.equal(api.isPaused(clock), true)
      time += 3_600_000
      assert.equal(api.getRemaining(clock, 'black', now), 50_321); assert.equal(api.getRemaining(clock, 'white', now), 58_999)
      api.resume(clock, now); time += 1111
      assert.equal(api.getRemaining(clock, 'white', now), 57_888); assert.equal(api.getRemaining(clock, 'black', now), 50_321)
    })
    check('G05: restoring an expired clock preserves the loser and zero balance', () => {
      const clock = api.createClock({ preset: 'none' })
      const restored = api.importClock(clock, { presetId: 'fast', unlimited: false,
        remainingMs: { black: 41_203, white: 0 }, status: 'paused', activeColor: 'white', timedOutColor: 'white' })
      assert.equal(restored.ok, true); assert.equal(api.hasTimedOut(clock), true)
      assert.equal(clock.timedOutColor, 'white'); assert.equal(api.getRemaining(clock, 'white', () => 9_000_000), 0)
      assert.equal(api.getRemaining(clock, 'black', () => 9_000_000), 41_203)
    })
    check('G05: a rejected clock restore does not partially reset a live game', () => {
      let time = 1000; const now = () => time, clock = api.createClock({ preset: 'standard' })
      api.startTurn(clock, 'black', now); time += 1000
      const before = JSON.stringify(clock)
      const result = api.importClock(clock, { presetId: 'fast', unlimited: false,
        remainingMs: { black: 30000, white: -1 }, status: 'paused', activeColor: 'white', timedOutColor: null })
      assert.equal(result.ok, false); assert.equal(JSON.stringify(clock), before, 'Rejected input must not reset or partially overwrite a live clock')
    })
  }
  const finalSha256 = createHash('sha256').update(await readFile(file, 'utf8')).digest('hex')
  check('G04: audited source remained stable', () => assert.equal(finalSha256, sha256))
  return { passed: checks.every(item => item.passed), checks, source: { file, sha256, finalSha256 },
    limitations: ['Pure timestamp inputs verify arithmetic and throttled-tick behavior. Native pause/blocked placement and real background visibility require UI acceptance.'] }
}
