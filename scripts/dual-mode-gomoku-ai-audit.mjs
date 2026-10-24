/** Independent checks of the generated AI's public pure APIs; no browser or game writes. */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import ts from 'typescript'

export async function auditAi(workspace) {
  const root = await realpath(workspace), sources = [], checks = [], modules = new Map()
  async function load(name) {
    const path = await realpath(resolve(root, 'src', name)), rel = relative(root, path)
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel), 'Audited module escaped workspace')
    const source = await readFile(path, 'utf8')
    const record = { file: path, sha256: createHash('sha256').update(source).digest('hex') }; sources.push(record)
    const sandbox = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout,
      require: dep => { assert.equal(dep, './rules.js', 'Unexpected dependency in inspected AI'); return modules.get('rules.js') }
    }, { codeGeneration: { strings: false, wasm: false } })
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInContext(`(function(exports,module,require){${code}\n})(module.exports,module,require)`, sandbox, { timeout: 2000, filename: path })
    modules.set(name, sandbox.module.exports)
    return sandbox.module.exports
  }
  const rules = await load('rules.js'), ai = await load('ai.js')
  const check = async (name, run) => {
    try { checks.push({ name, passed: true, detail: await run() }) }
    catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }) }
  }
  const gameWith = moves => { const game = rules.createGame(); for (const p of moves) assert.equal(game.play(...p).ok, true); return game }
  for (const difficulty of ['easy', 'hard']) {
    await check(`G03: ${difficulty} takes its own win before blocking the opponent`, () => {
      const game = gameWith([[7,3],[2,3],[7,4],[2,4],[7,5],[2,5],[7,6],[2,6]])
      const before = JSON.stringify(game.board), result = ai.chooseMove(game.board, 'black', { difficulty })
      assert.equal(result.row, 7); assert.ok([2,7].includes(result.col)); assert.equal(result.reason, 'win')
      assert.equal(JSON.stringify(game.board), before)
      assert.equal(game.play(result.row,result.col).ok, true); assert.equal(game.board.winner, 'black')
      return result
    })
    await check(`G03: ${difficulty} blocks a unique opponent winning point`, () => {
      const game = gameWith([[7,2],[7,3],[0,0],[7,4],[0,2],[7,5],[0,4],[7,6]])
      const before = JSON.stringify(game.board), result = ai.chooseMove(game.board, 'black', { difficulty })
      assert.equal(result.row, 7); assert.equal(result.col, 7); assert.equal(result.reason, 'block')
      assert.equal(JSON.stringify(game.board), before)
      return result
    })
    await check(`G03: ${difficulty} empty-board move is legal and terminal board returns no move`, () => {
      const game = rules.createGame(), move = ai.chooseMove(game.board, 'black', { difficulty })
      assert.equal(game.play(move.row,move.col).ok, true)
      const won = gameWith([[2,2],[14,0],[2,3],[14,2],[2,4],[14,4],[2,5],[12,1],[2,6]])
      assert.equal(ai.chooseMove(won.board, 'white', { difficulty }), null)
      return { opening: move, terminalRejected: true }
    })
  }
  await check('G03: cancelling a pending AI request settles without an obsolete move', async () => {
    const request = ai.createAiRequest(rules.createGame().board, 'black', { delayMs: 20 })
    request.cancel(); request.cancel()
    const result = await Promise.race([request.promise, delay(150).then(() => ({ timedOut: true }))])
    assert.equal(result.timedOut, undefined, 'cancel() cleared the timer but left the public promise unresolved')
    assert.equal(result.cancelled, true); assert.equal(result.move, null)
    return result
  })
  await check('G03: an async AI request uses the submitted board snapshot', async () => {
    const game = rules.createGame(), request = ai.createAiRequest(game.board, 'black', { delayMs: 1 })
    game.play(7,7)
    const result = await Promise.race([request.promise, delay(2000).then(() => ({ timedOut: true }))])
    assert.equal(result.timedOut, undefined); assert.equal(result.cancelled, false)
    assert.equal(result.move.row, 7); assert.equal(result.move.col, 7)
    assert.equal(game.board.moves.length, 1)
    return result
  })
  for (const source of sources) {
    source.finalSha256 = createHash('sha256').update(await readFile(source.file, 'utf8')).digest('hex')
    await check('G03: audited source did not change: ' + source.file, () => assert.equal(source.finalSha256, source.sha256))
  }
  return { passed: checks.every(item => item.passed), checks, sources,
    limitations: ['Pure module checks do not prove main-thread responsiveness or old-result suppression in UI; native browser checks are separate.'] }
}
