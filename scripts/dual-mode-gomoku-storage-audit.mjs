/** Independent public storage-boundary checks for the inspected G05 module.
 * This creates in-memory Storage objects only. It never writes browser storage,
 * imports generated tests, starts a browser, or changes the generated project.
 */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const plain = value => JSON.parse(JSON.stringify(value))

export async function auditStorage(workspace) {
  const root = await realpath(workspace), sources = [], modules = new Map(), checks = []
  async function load(name) {
    const file = await realpath(resolve(root, 'src', name)), rel = relative(root, file)
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel), 'Audited source escaped the game workspace')
    const source = await readFile(file, 'utf8')
    sources.push({ file, sha256: createHash('sha256').update(source).digest('hex') })
    const context = vm.createContext({ module: { exports: {} }, require: name => {
      assert.equal(name, './rules.js', 'Unexpected generated module dependency')
      return modules.get('rules.js')
    } }, { codeGeneration: { strings: false, wasm: false } })
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInContext(`(function(exports,module,require){${compiled}\n})(module.exports,module,require)`, context, { timeout: 2000, filename: file })
    modules.set(name, context.module.exports)
    return context.module.exports
  }
  const rules = await load('rules.js'), api = await load('storage.js')
  const check = (name, run) => {
    try { checks.push({ name, passed: true, detail: run() }) }
    catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }) }
  }
  const fixture = () => ({ size: rules.SIZE, moves: [
    { row: 7, col: 7, color: rules.BLACK }, { row: 7, col: 8, color: rules.WHITE }, { row: 8, col: 8, color: rules.BLACK }
  ], status: rules.STATUS.PLAYING, winner: null, endReason: null, mode: 'pve', difficulty: 'hard', humanColor: rules.WHITE,
  clock: { presetId: 'fast', unlimited: false, remainingMs: { black: 57421, white: 53217 }, status: 'paused', timedOutColor: null } })
  const save = () => plain(api.buildSave(fixture()))

  check('G05: a saved live game round-trips exact history, owner settings and paused milliseconds', () => {
    const backend = api.createMemoryStorage(), input = fixture()
    const written = api.writeSave(backend, input)
    assert.equal(written.ok, true)
    const text = backend.getItem(api.SAVE_KEY), restored = api.readSave(backend)
    assert.equal(restored.status, 'ok'); assert.equal(restored.save.version, api.SAVE_VERSION)
    assert.equal(restored.save.namespace, api.STORAGE_NAMESPACE)
    for (const key of Object.keys(input)) assert.deepEqual(plain(restored.save[key]), plain(input[key]), key)
    assert.equal(backend.getItem(api.SAVE_KEY), text, 'Reading must not silently rewrite the stored game')
    const replay = rules.createGame()
    for (const move of restored.save.moves) assert.equal(replay.play(move.row, move.col).ok, true)
    assert.equal(replay.currentPlayer(), rules.WHITE)
    return { moves: restored.save.moves.length, nextColor: replay.currentPlayer(), remainingMs: plain(restored.save.clock.remainingMs) }
  })

  check('G05: all save/backup/clear operations preserve foreign namespaces', () => {
    const foreign = { 'weiqi-web:save': 'FOREIGN-GO-SAVE', 'gomoku15-other:save': 'PREFIX-NEIGHBOUR', 'settings': 'USER-SETTINGS' }
    const backend = api.createMemoryStorage(foreign)
    assert.match(api.SAVE_KEY, new RegExp('^' + api.STORAGE_NAMESPACE + ':'))
    assert.match(api.BACKUP_KEY, new RegExp('^' + api.STORAGE_NAMESPACE + ':'))
    assert.notEqual(api.SAVE_KEY, api.BACKUP_KEY)
    assert.equal(api.writeSave(backend, fixture()).ok, true)
    assert.equal(api.backupCorrupt(backend, '{broken').ok, true)
    assert.deepEqual(plain(api.listNamespaceKeys(backend)).sort(), [api.SAVE_KEY, api.BACKUP_KEY].sort())
    assert.equal(api.clearSave(backend).ok, true); assert.equal(backend.getItem(api.SAVE_KEY), null)
    assert.equal(backend.getItem(api.BACKUP_KEY), '{broken')
    for (const [key, value] of Object.entries(foreign)) assert.equal(backend.getItem(key), value)
    return { retainedForeignKeys: Object.keys(foreign), isolatedKeys: [api.SAVE_KEY, api.BACKUP_KEY] }
  })

  check('G05: v1 migration retains moves, defaults legacy clock and never mutates original bytes', () => {
    const legacy = save(); legacy.version = 1; delete legacy.clock; delete legacy.endReason; delete legacy.humanColor
    const source = JSON.stringify(legacy), backend = api.createMemoryStorage({ [api.SAVE_KEY]: source })
    const restored = api.readSave(backend)
    assert.equal(restored.status, 'ok'); assert.equal(restored.save.version, api.SAVE_VERSION)
    assert.deepEqual(plain(restored.save.moves), legacy.moves)
    assert.equal(restored.save.humanColor, rules.BLACK)
    assert.equal(restored.save.clock.presetId, 'none'); assert.equal(restored.save.clock.unlimited, true)
    assert.equal(backend.getItem(api.SAVE_KEY), source)
  })

  check('G05: future schema versions are explicitly unsupported and retain the original payload', () => {
    const value = save(); value.version = api.SAVE_VERSION + 1
    const source = JSON.stringify(value), backend = api.createMemoryStorage({ [api.SAVE_KEY]: source })
    const result = api.readSave(backend)
    assert.equal(result.status, 'unsupported'); assert.ok(result.reason.length > 0); assert.equal(result.raw, source)
    assert.equal(backend.getItem(api.SAVE_KEY), source)
  })

  const invalid = [
    ['wrong namespace', value => { value.namespace = 'weiqi-web' }],
    ['wrong board size', value => { value.size = 19 }],
    ['negative coordinate', value => { value.moves[1].row = -1 }],
    ['coordinate beyond board', value => { value.moves[1].col = 15 }],
    ['fractional coordinate', value => { value.moves[1].row = 7.5 }],
    ['duplicate point', value => { value.moves[1].row = 7; value.moves[1].col = 7 }],
    ['incorrect move color', value => { value.moves[1].color = 'black' }],
    ['unknown game status', value => { value.status = 'network-pending' }],
    ['winner absent from finished game', value => { value.status = 'won'; value.winner = null }],
    ['unknown finish reason', value => { value.endReason = 'admin-win' }],
    ['invalid mode', value => { value.mode = 'ranked-server' }],
    ['invalid difficulty', value => { value.difficulty = 'grandmaster' }],
    ['human owner absent in AI game', value => { delete value.humanColor }],
    ['unknown time preset', value => { value.clock.presetId = 'one-day' }],
    ['negative remaining time', value => { value.clock.remainingMs.black = -1 }],
    ['string remaining time', value => { value.clock.remainingMs.white = '100' }],
    ['null remaining time', value => { value.clock.remainingMs.white = null }],
    ['invalid clock state', value => { value.clock.status = 'paused-and-running' }],
    ['invalid timed-out owner', value => { value.clock.timedOutColor = 'spectator' }]
  ]
  for (const [name, corrupt] of invalid) check('G05: reject corrupt save — ' + name, () => {
    const value = save(); corrupt(value)
    const source = JSON.stringify(value), backend = api.createMemoryStorage({ [api.SAVE_KEY]: source })
    const result = api.readSave(backend)
    assert.equal(result.status, 'corrupt'); assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
    assert.equal(backend.getItem(api.SAVE_KEY), source, 'Invalid input must remain available for recoverable diagnosis')
    return { reason: result.reason }
  })

  check('G05: saved history rejects a tenth move after an independently obvious black five', () => {
    const value = save(), moves = []
    for (let index = 0; index < 5; index += 1) {
      moves.push({ row: 5, col: 5 + index, color: 'black' })
      if (index < 4) moves.push({ row: 0, col: index * 2, color: 'white' })
    }
    const live = rules.createGame()
    for (const move of moves) assert.equal(live.play(move.row, move.col).ok, true)
    assert.equal(live.board.status, 'won'); assert.equal(live.board.winner, 'black')
    assert.equal(live.play(14, 14).ok, false, 'The normal play API correctly rejects the tenth move')
    value.moves = [...moves, { row: 14, col: 14, color: 'white' }]
    const source = JSON.stringify(value), backend = api.createMemoryStorage({ [api.SAVE_KEY]: source })
    const result = api.readSave(backend)
    const restored = rules.createGame(), applied = result.status === 'ok' ? restored.importState(result.save) : null
    assert.equal(result.status, 'corrupt', JSON.stringify({ readStatus: result.status, applied,
      restoredStatus: restored.board.status, restoredMoves: restored.board.moves.length,
      blackFive: restored.board.grid[5].slice(5, 10) }))
    assert.equal(backend.getItem(api.SAVE_KEY), source)
  })

  check('G05: malformed JSON is recoverable and can be backed up without destroying the original', () => {
    const source = '{"version":2,', backend = api.createMemoryStorage({ [api.SAVE_KEY]: source })
    const result = api.readSave(backend)
    assert.equal(result.status, 'corrupt'); assert.equal(result.raw, source)
    assert.equal(api.backupCorrupt(backend, result.raw).ok, true)
    assert.equal(backend.getItem(api.SAVE_KEY), source); assert.equal(backend.getItem(api.BACKUP_KEY), source)
  })
  check('G05: unavailable storage reports failure instead of claiming persistence succeeded', () => {
    const blocked = { getItem() { throw new Error('Access denied') }, setItem() { throw new Error('Quota exceeded') }, removeItem() { throw new Error('Access denied') } }
    assert.equal(api.writeSave(blocked, fixture()).ok, false)
    assert.equal(api.readSave(blocked).status, 'corrupt')
    assert.equal(api.backupCorrupt(blocked, 'bad').ok, false); assert.equal(api.clearSave(blocked).ok, false)
  })
  for (const source of sources) {
    source.finalSha256 = createHash('sha256').update(await readFile(source.file, 'utf8')).digest('hex')
    check('G05: audited source remained stable — ' + source.file, () => assert.equal(source.finalSha256, source.sha256))
  }
  return { passed: checks.every(check => check.passed), checks, sources,
    limitations: ['Public module checks use isolated in-memory Storage; native refresh, corrupted-save recovery UI and browser isolation still require separate UI acceptance.',
      'G06 text-record validation is covered separately by auditRecord; it does not establish that the automatic-save path shares the same validation.'] }
}
