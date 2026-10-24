/** Independent G06 contract checks. Only public modules run in an isolated VM;
 * no generated tests, project writes, browser state or native windows are used.
 */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const plain = value => JSON.parse(JSON.stringify(value))
const move = (row, col, index) => ({ row, col, color: index % 2 ? 'white' : 'black' })
const fixture = () => [[7, 7], [7, 8], [8, 8]].map(([row, col], index) => move(row, col, index))

// This oracle deliberately does not use the generated rules or record parser.
function replay(moves) {
  const grid = Array.from({ length: 15 }, () => Array(15).fill(null))
  let status = 'playing', winner = null, endReason = null
  for (const [index, item] of moves.entries()) {
    assert.equal(status, 'playing', 'Move after terminal position')
    assert.ok(Number.isInteger(item.row) && Number.isInteger(item.col))
    assert.ok(item.row >= 0 && item.row < 15 && item.col >= 0 && item.col < 15)
    assert.equal(item.color, index % 2 ? 'white' : 'black')
    assert.equal(grid[item.row][item.col], null)
    grid[item.row][item.col] = item.color
    const wins = [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dr, dc]) => {
      let length = 1
      for (const direction of [-1, 1]) {
        for (let distance = 1; distance < 15; distance += 1) {
          const row = item.row + direction * distance * dr, col = item.col + direction * distance * dc
          if (grid[row]?.[col] !== item.color) break
          length += 1
        }
      }
      return length >= 5
    })
    if (wins) { status = 'won'; winner = item.color; endReason = 'five' }
    else if (index === 224) { status = 'draw'; endReason = 'draw' }
  }
  return { status, winner, endReason, grid }
}

export async function auditRecord(workspace) {
  const root = await realpath(workspace), sources = [], modules = new Map(), checks = []
  async function load(name) {
    const file = await realpath(resolve(root, 'src', name)), rel = relative(root, file)
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel), 'Audited module escaped workspace')
    const source = await readFile(file, 'utf8')
    sources.push({ file, sha256: createHash('sha256').update(source).digest('hex') })
    const context = vm.createContext({ module: { exports: {} }, require: dependency => {
      assert.equal(dependency, './rules.js', 'Unexpected generated dependency')
      return modules.get('rules.js')
    } }, { codeGeneration: { strings: false, wasm: false } })
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInContext(`(function(exports,module,require){${compiled}\n})(module.exports,module,require)`, context, { timeout: 2000, filename: file })
    modules.set(name, context.module.exports)
    return context.module.exports
  }
  const rules = await load('rules.js'), api = await load('record.js')
  const check = (name, run) => {
    try { checks.push({ name, passed: true, detail: run() }) }
    catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }) }
  }
  const record = moves => ({ format: 'gomoku15-record', version: 1, size: 15, moves: plain(moves), moveCount: moves.length })
  const requireValid = moves => {
    const expected = replay(moves), value = record(moves), before = JSON.stringify(value)
    const result = api.parseRecord(value)
    assert.equal(result.status, 'ok'); assert.equal(result.moveCount, moves.length)
    assert.equal(JSON.stringify(value), before, 'Parsing must not rewrite caller input')
    assert.deepEqual(plain(result.state.moves), moves)
    for (const key of ['status', 'winner', 'endReason']) assert.equal(result.state[key], expected[key], key)
    const game = rules.createGame()
    assert.equal(game.importState(result.state).ok, true)
    assert.deepEqual(plain(game.board.grid), expected.grid)
    return { moves: moves.length, status: result.state.status, winner: result.state.winner }
  }

  check('G06: text export and parse round-trip exact history with an independent board oracle', () => {
    const moves = fixture(), state = { size: 15, moves, status: 'playing', winner: null, endReason: null }
    const text = api.serializeRecord(state, { savedAt: '2026-10-23T10:00:00.000Z' }), data = JSON.parse(text)
    assert.equal(data.format, 'gomoku15-record'); assert.equal(data.version, 1); assert.equal(data.size, 15)
    assert.equal(data.exportedAt, '2026-10-23T10:00:00.000Z'); assert.equal(data.moveCount, 3)
    assert.deepEqual(data.moves.map(({ row, col, color }) => ({ row, col, color })), moves)
    assert.deepEqual(data.moves.map(item => item.index), [1, 2, 3])
    assert.deepEqual(data.moves.map(item => item.coord), ['H8', 'I8', 'I7'])
    const parsed = api.parseRecord(text)
    assert.equal(parsed.status, 'ok'); assert.deepEqual(plain(parsed.state.moves), moves)
    return requireValid(moves)
  })
  check('G06: empty valid record is a legitimate new game', () => requireValid([]))

  for (const [name, step] of [['horizontal', [0, 1]], ['vertical', [1, 0]], ['diagonal', [1, 1]], ['anti-diagonal', [1, -1]]]) {
    const moves = []
    for (let index = 0; index < 5; index += 1) {
      moves.push(move(5 + index * step[0], 7 + index * step[1], moves.length))
      if (index < 4) moves.push(move(0, index * 2, moves.length))
    }
    check(`G06: ${name} winning record reconstructs the actual terminal position`, () => {
      const result = requireValid(moves)
      assert.equal(result.winner, 'black'); assert.equal(result.status, 'won')
      return result
    })
    check(`G06: ${name} record rejects an otherwise legal extra move after victory`, () => {
      const value = record([...moves, move(14, 14, moves.length)]), before = JSON.stringify(value)
      const parsed = api.parseRecord(value)
      assert.equal(parsed.status, 'invalid'); assert.equal(parsed.index, 10)
      assert.equal(parsed.state, undefined, 'Rejected record must not expose an applicable partial position')
      assert.match(parsed.reason, /终局/); assert.equal(JSON.stringify(value), before)
      return { rejectedMove: parsed.index, reason: parsed.reason }
    })
  }

  check('G06: an independently verified full-board draw is reconstructed', () => {
    const byColor = [[], []]
    for (let row = 0; row < 15; row += 1) for (let col = 0; col < 15; col += 1) byColor[(row + 2 * col) % 4 < 2 ? 0 : 1].push([row, col])
    assert.equal(byColor[0].length, 113); assert.equal(byColor[1].length, 112)
    const moves = Array.from({ length: 225 }, (_, index) => move(...byColor[index % 2][Math.floor(index / 2)], index))
    const result = requireValid(moves)
    assert.equal(result.status, 'draw'); assert.equal(result.winner, null)
    return result
  })

  const invalid = [
    ['wrong format', value => { value.format = 'weiqi-sgf' }],
    ['missing format', value => { delete value.format }],
    ['missing version', value => { delete value.version }],
    ['zero version', value => { value.version = 0 }],
    ['fractional version', value => { value.version = 1.5 }],
    ['wrong board size', value => { value.size = 19 }],
    ['missing history', value => { delete value.moves }],
    ['first move white', value => { value.moves[0].color = 'white' }],
    ['later color mismatch', value => { value.moves[2].color = 'white' }],
    ['unknown color', value => { value.moves[1].color = 'blue' }],
    ['negative coordinate', value => { value.moves[2].row = -1 }],
    ['coordinate beyond board', value => { value.moves[2].col = 15 }],
    ['fractional coordinate', value => { value.moves[1].row = 0.25 }],
    ['string coordinate', value => { value.moves[1].row = '7' }],
    ['missing coordinate', value => { delete value.moves[1].col }],
    ['duplicate point', value => { value.moves[2].row = 7; value.moves[2].col = 7 }],
    ['null move', value => { value.moves[1] = null }]
  ]
  for (const [name, corrupt] of invalid) check('G06: reject entire record — ' + name, () => {
    const value = record(fixture()); corrupt(value)
    const before = JSON.stringify(value), parsed = api.parseRecord(value)
    assert.equal(parsed.status, 'invalid'); assert.ok(parsed.reason?.length)
    assert.equal(parsed.state, undefined, 'Invalid record must not expose a partial state')
    assert.equal(JSON.stringify(value), before, 'Validation must preserve the original input for diagnosis')
    return { reason: parsed.reason, rejectedMove: parsed.index }
  })
  check('G06: malformed JSON and non-object roots return useful errors without throwing', () => {
    for (const input of ['{"format":', '[]', 'true', '42', 'null']) {
      const parsed = api.parseRecord(input)
      assert.equal(parsed.status, 'invalid'); assert.ok(parsed.reason?.length); assert.equal(parsed.state, undefined)
    }
  })
  check('G06: empty paste is distinct from an invalid file', () => {
    for (const input of [null, undefined, '', ' \n\t ']) assert.equal(api.parseRecord(input).status, 'empty')
  })
  check('G06: future versions are explicitly unsupported', () => {
    const value = record(fixture()); value.version = 2
    const parsed = api.parseRecord(value)
    assert.equal(parsed.status, 'unsupported'); assert.equal(parsed.state, undefined); assert.ok(parsed.reason?.length)
  })
  check('G06: forged descriptive result does not bypass replay-derived status', () => {
    const value = record(fixture()); value.result = { status: 'won', winner: 'white', endReason: 'five' }
    const parsed = api.parseRecord(value)
    assert.equal(parsed.status, 'ok'); assert.equal(parsed.state.status, 'playing'); assert.equal(parsed.state.winner, null)
  })
  check('G06: declared move-count mismatch is surfaced as a reviewable warning', () => {
    const value = record(fixture()); value.moveCount = 999
    const parsed = api.parseRecord(value)
    assert.equal(parsed.status, 'ok'); assert.equal(parsed.moveCount, 3)
    assert.ok(parsed.warnings.some(value => /999.*3/.test(value)))
    assert.match(api.describeImport(parsed), /999.*3/)
  })
  check('G06: exported filename is stable and safe on Windows', () => {
    assert.equal(api.recordFileName(new Date('2026-10-23T15:16:17.000Z')), 'gomoku15-2026-10-23T15-16-17.json')
  })
  for (const source of sources) {
    source.finalSha256 = createHash('sha256').update(await readFile(source.file, 'utf8')).digest('hex')
    check('G06: audited source remained stable — ' + source.file, () => assert.equal(source.finalSha256, source.sha256))
  }
  return { passed: checks.every(check => check.passed), checks, sources,
    limitations: ['The module parser has no live game reference. Retention of the current live game on rejected import must also pass the native text-control audit.',
      'Native file picker, clipboard OS permission and downloaded file bytes are not certified by these pure module checks.'] }
}
