/** Independent, read-only acceptance of the generated Code Gomoku project's
 * inspected pure modules. Does not launch a server/browser or touch its saves. */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const plain = value => JSON.parse(JSON.stringify(value))
const opposite = color => color === 'black' ? 'white' : 'black'

/** Selectors verified against the generated initial UI. Root must re-read DOM
 * before native input; these scenarios never inject the game's internal state. */
export const uiScenarios = [
  { name: 'baseline alternating/duplicate', selectors: { board: '#board', points: '#board .point', stones: '#board .stone',
    black: '#board .point[data-stone="black"]', white: '#board .point[data-stone="white"]', count: '#status-moves', status: '#status-turn .status__text' },
  clicks: ['#btn-restart', '#board .point[data-row="7"][data-col="7"]', '#board .point[data-row="7"][data-col="8"]', '#board .point[data-row="7"][data-col="7"]'],
  expected: '225 points, exactly two stones, one black at H8 and one white at I8; duplicate leaves move count at two.' },
  { name: 'baseline/G01/G09 victory and undo', black: [[2, 2], [2, 3], [2, 4], [2, 5], [2, 6]],
    white: [[14, 0], [14, 2], [14, 4], [12, 1]], selectors: { undo: '#btn-undo', restart: '#btn-restart', highlight: '#board .point.is-win' },
  expected: 'Alternate actual point clicks; black wins on move nine with five highlighted stones. Another point is refused. Undo clears winner, then black can play a different empty point.' },
  { name: 'G07 keyboard and accessibility', selectors: { board: '#board', points: '#board .point' },
  expected: 'From restart focus the real board; Enter, ArrowRight, Space produces two alternating stones. Tab away and back, then ArrowDown/Enter remains usable. Exactly one board entry is in the Tab order, with coordinate/occupancy names and a live status region.' },
  { name: 'G08 responsive input', viewports: [[360, 800], [390, 844], [768, 1024], [1440, 900]],
  expected: 'At each viewport read document scrollWidth/clientWidth and board bounds; physically click a chosen corner-adjacent point and verify its data-row/data-col, undo and restart. Theme changes preserve the position.' },
  { name: 'G02 replay isolation', selectors: { first: '#rv-first', previous: '#rv-prev', next: '#rv-next', last: '#rv-last', exit: '#rv-exit', choose: '#rv-select', status: '#replay-now', list: '#replay-list' },
    expected: 'Create three real moves, select the first move, verify only that stone remains visible. A board click must not alter the live game. Exit restores all three moves. Undo/redo and changing replay indices must preserve the original chronological colors and coordinates.' },
]

/** This oracle uses only the last move and never calls the project's detector. */
function lineAt(grid, row, col, color) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const points = [[row, col]]
    for (const sign of [-1, 1]) {
      for (let step = 1; step < 15; step++) {
        const r = row + dr * step * sign, c = col + dc * step * sign
        if (r < 0 || r >= 15 || c < 0 || c >= 15 || grid[r][c] !== color) break
        points.push([r, c])
      }
    }
    if (points.length >= 5) return points
  }
  return []
}

function winningSequence(game, target, white = false) {
  // Opposite-side fillers cannot form five and never share the target region.
  const fillers = [[14, 0], [14, 2], [14, 4], [12, 1], [12, 3], [12, 5]]
  if (white) assert.equal(game.play(13, 14).ok, true)
  for (let index = 0; index < target.length; index++) {
    assert.equal(game.play(...target[index]).ok, true)
    if (index + 1 < target.length) assert.equal(game.play(...fillers[index]).ok, true)
  }
}

export async function auditRules(workspace) {
  const checks = [], limitations = [], root = await realpath(resolve(workspace))
  const file = await realpath(resolve(root, 'src/rules.js'))
  const rel = relative(root, file)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Rules module escapes the audited workspace')
  const source = await readFile(file, 'utf8')
  const fingerprint = createHash('sha256').update(source).digest('hex')
  const sandbox = vm.createContext({ module: { exports: {} }, exports: {},
    require: name => { throw new Error(`Unreviewed dependency: ${name}; inspect it before extending the audit`) } },
  { codeGeneration: { strings: false, wasm: false } })
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(`(function(exports,module,require){${compiled}\n})(module.exports,module,require)`, sandbox, { timeout: 2000, filename: file })
  const rules = sandbox.module.exports
  for (const name of ['createGame', 'currentPlayer', 'hasFiveInRow', 'findWinningLines']) assert.equal(typeof rules[name], 'function', `Missing inspected API ${name}`)
  const check = (name, execute) => {
    try {
      sandbox.__auditCheck = execute
      const evidence = vm.runInContext('__auditCheck()', sandbox, { timeout: 5000 })
      checks.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) })
    } catch (error) { checks.push({ name, passed: false, error: String(error?.stack ?? error) }) }
    finally { delete sandbox.__auditCheck }
  }

  check('baseline: empty 15×15 board, black starts and alternating moves', () => {
    const game = rules.createGame()
    assert.equal(game.board.size, 15); assert.equal(game.board.grid.length, 15)
    assert.equal(game.board.grid.flat().length, 225); assert.equal(game.board.grid.flat().every(cell => cell === null), true)
    assert.equal(game.currentPlayer(), 'black')
    assert.equal(game.play(7, 7).ok, true); assert.equal(game.board.grid[7][7], 'black')
    assert.equal(game.currentPlayer(), 'white')
    assert.equal(game.play(7, 8).ok, true); assert.equal(game.board.grid[7][8], 'white')
    assert.equal(game.currentPlayer(), 'black'); assert.equal(game.board.moves.length, 2)
  })
  check('baseline: duplicate, negative, outside, fractional, string and non-finite coordinates are atomic rejects', () => {
    const game = rules.createGame(); game.play(7, 7)
    const before = JSON.stringify(game.board)
    for (const point of [[7, 7], [-1, 0], [0, -1], [15, 0], [0, 15], [0.5, 1], ['1', 2], [NaN, 2], [Infinity, 0], [undefined, 0], [null, 0]]) {
      assert.equal(game.play(...point).ok, false, `unexpected accepted point ${String(point)}`)
      assert.equal(JSON.stringify(game.board), before)
    }
  })
  const directions = {
    horizontal: [[2, 2], [2, 3], [2, 4], [2, 5], [2, 6]],
    vertical: [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2]],
    diagonal: [[2, 2], [3, 3], [4, 4], [5, 5], [6, 6]],
    antidiagonal: [[2, 8], [3, 7], [4, 6], [5, 5], [6, 4]],
  }
  for (const [direction, points] of Object.entries(directions)) {
    check(`baseline: ${direction} five wins and highlights only the real connected stones`, () => {
      const game = rules.createGame(); winningSequence(game, points)
      assert.equal(game.board.status, 'won'); assert.equal(game.board.winner, 'black')
      const actual = plain(game.board.winningLine).map(point => `${point.row},${point.col}`).sort()
      assert.deepEqual(actual, points.map(point => point.join(',')).sort())
      const before = JSON.stringify(game.board); assert.equal(game.play(0, 0).ok, false); assert.equal(JSON.stringify(game.board), before)
    })
  }
  check('baseline: white can win on the tenth move without first-player bias', () => {
    const game = rules.createGame(); winningSequence(game, directions.horizontal, true)
    assert.equal(game.board.status, 'won'); assert.equal(game.board.winner, 'white'); assert.equal(game.board.moves.length, 10)
  })
  check('baseline: four and broken lines stay live; a legal gap fill producing six counts as a win', () => {
    const game = rules.createGame()
    const stones = [[7, 3], [7, 4], [7, 5], [7, 7], [7, 8]]
    const fillers = [[0, 0], [0, 2], [0, 4], [2, 1], [2, 3]]
    stones.forEach((point, index) => {
      assert.equal(game.play(...point).ok, true); assert.equal(game.board.status, 'playing')
      assert.equal(game.play(...fillers[index]).ok, true); assert.equal(game.board.status, 'playing')
    })
    assert.equal(game.play(7, 6).ok, true); assert.equal(game.board.winner, 'black'); assert.equal(game.board.winningLine.length, 6)
  })
  check('baseline/G01: undo victory releases terminal state; restart clears all rules state', () => {
    const game = rules.createGame(); winningSequence(game, directions.horizontal)
    assert.deepEqual(plain(game.undo()), { row: 2, col: 6, color: 'black' })
    assert.equal(game.board.status, 'playing'); assert.equal(game.board.winner, null)
    assert.equal(game.currentPlayer(), 'black'); assert.equal(game.play(1, 1).ok, true)
    game.restart(); assert.equal(game.board.moves.length, 0); assert.equal(game.board.status, 'playing')
    assert.equal(game.board.winner, null); assert.equal(game.board.winningLine.length, 0)
    assert.equal(game.board.grid.flat().every(cell => cell === null), true); assert.equal(game.undo(), null)
  })
  check('baseline: independent last-move oracle agrees across deterministic legal complete games', () => {
    let moves = 0
    for (let seed = 1; seed <= 32; seed++) {
      let random = seed, color = 'black'
      const draw = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random }
      const coordinates = Array.from({ length: 225 }, (_, index) => [Math.floor(index / 15), index % 15])
      for (let index = coordinates.length - 1; index > 0; index--) { const other = draw() % (index + 1); [coordinates[index], coordinates[other]] = [coordinates[other], coordinates[index]] }
      const expected = Array.from({ length: 15 }, () => Array(15).fill(null)), game = rules.createGame()
      for (const [index, [row, col]] of coordinates.entries()) {
        assert.equal(game.play(row, col).ok, true); expected[row][col] = color; moves++
        const winner = lineAt(expected, row, col, color).length ? color : null
        assert.deepEqual(plain(game.board.grid), expected)
        assert.equal(game.board.status, winner ? 'won' : index === 224 ? 'draw' : 'playing')
        assert.equal(game.board.winner, winner)
        if (winner || index === 224) break
        color = opposite(color)
      }
    }
    return { games: 32, legalMovesChecked: moves }
  })
  check('baseline: two independent rule instances do not share board, history or terminal state', () => {
    const first = rules.createGame(), second = rules.createGame()
    assert.notEqual(first.board, second.board); assert.notEqual(first.board.grid, second.board.grid)
    const empty = JSON.stringify(second.board)
    winningSequence(first, directions.horizontal)
    assert.equal(JSON.stringify(second.board), empty)
    const firstWon = JSON.stringify(first.board)
    assert.equal(second.play(2, 2).ok, true); assert.equal(second.board.grid[2][2], 'black')
    assert.equal(second.play(2, 3).ok, true); assert.equal(second.board.grid[2][3], 'white')
    assert.equal(JSON.stringify(first.board), firstWon)
    const secondPlaying = JSON.stringify(second.board)
    first.undo(); first.restart()
    assert.equal(JSON.stringify(second.board), secondPlaying)
    return { isolated: ['grid rows', 'move history', 'winner', 'undo', 'restart'], scope: 'rule instances only; process/session isolation is audited separately' }
  })
  check('baseline: a legal full board draws, rejects further play and reopens on undo', () => {
    // This balanced periodic coloring has no five in any direction. Interleave
    // its 113 black / 112 white points as real legal moves, without installing
    // a fabricated terminal board or using the production win detector.
    const expected = Array.from({ length: 15 }, (_, row) =>
      Array.from({ length: 15 }, (_, col) => (row + 2 * col) % 4 < 2 ? 'black' : 'white'))
    const coordinates = { black: [], white: [] }
    expected.forEach((row, r) => row.forEach((color, c) => {
      assert.equal(lineAt(expected, r, c, color).length, 0)
      coordinates[color].push([r, c])
    }))
    assert.equal(coordinates.black.length, 113); assert.equal(coordinates.white.length, 112)
    const game = rules.createGame()
    for (let index = 0; index < 225; index++) {
      const color = index % 2 ? 'white' : 'black'
      assert.equal(game.play(...coordinates[color][Math.floor(index / 2)]).ok, true)
      assert.equal(game.board.status, index === 224 ? 'draw' : 'playing')
      assert.equal(game.board.winner, null)
    }
    assert.deepEqual(plain(game.board.grid), expected)
    assert.equal(game.board.winningLine.length, 0)
    const full = JSON.stringify(game.board)
    assert.equal(game.play(0, 0).ok, false); assert.equal(JSON.stringify(game.board), full)
    assert.notEqual(game.undo(), null)
    assert.equal(game.board.status, 'playing'); assert.equal(game.board.moves.length, 224)
    assert.equal(game.currentPlayer(), 'black'); assert.equal(game.board.grid.flat().filter(Boolean).length, 224)
    if (typeof game.redo === 'function') {
      assert.notEqual(game.redo(), null); assert.equal(JSON.stringify(game.board), full)
    }
    return { legalMovesChecked: 225, winner: null, restoredDraw: typeof game.redo === 'function' }
  })
  const capabilities = ['baseline-rules']
  if (typeof rules.createGame().redo === 'function') {
    capabilities.push('G01-undo-redo')
    check('G01: undo three and redo three reproduces the exact board, chronology, turn and redo availability', () => {
      const game = rules.createGame()
      for (const point of [[7, 3], [7, 8], [8, 5]]) assert.equal(game.play(...point).ok, true)
      const original = JSON.stringify(game.board)
      assert.equal(game.canUndo(), true); assert.equal(game.canRedo(), false)
      for (let remaining = 2; remaining >= 0; remaining--) {
        assert.notEqual(game.undo(), null); assert.equal(game.board.moves.length, remaining)
        assert.equal(game.currentPlayer(), remaining % 2 ? 'white' : 'black')
        assert.equal(game.board.grid.flat().filter(Boolean).length, remaining)
      }
      assert.equal(game.canUndo(), false); assert.equal(game.canRedo(), true)
      const empty = JSON.stringify(game.board); assert.equal(game.undo(), null); assert.equal(JSON.stringify(game.board), empty)
      for (let count = 1; count <= 3; count++) {
        assert.notEqual(game.redo(), null); assert.equal(game.board.moves.length, count)
        assert.equal(game.currentPlayer(), count % 2 ? 'white' : 'black')
      }
      assert.equal(JSON.stringify(game.board), original); assert.equal(game.canRedo(), false)
      assert.equal(game.redo(), null); assert.equal(JSON.stringify(game.board), original)
    })
    check('G01: a valid alternate move drops the old redo branch; rejected moves preserve it', () => {
      const game = rules.createGame(); game.play(7, 7); game.play(7, 8); game.play(8, 8)
      game.undo(); game.undo()
      const beforeRejected = JSON.stringify(game.board)
      assert.equal(game.play(7, 7).ok, false); assert.equal(game.play(-1, 0).ok, false)
      assert.equal(JSON.stringify(game.board), beforeRejected); assert.equal(game.canRedo(), true)
      assert.equal(game.play(6, 6).ok, true); assert.equal(game.board.grid[6][6], 'white')
      assert.equal(game.canRedo(), false); assert.equal(game.redo(), null)
      assert.equal(game.board.grid[7][8], null); assert.equal(game.board.grid[8][8], null)
      assert.equal(game.board.moves.length, 2)
    })
    check('G01: restoring a winning move re-enters the exact terminal board and highlight', () => {
      const game = rules.createGame(); winningSequence(game, directions.antidiagonal)
      const won = JSON.stringify(game.board)
      game.undo(); assert.equal(game.board.status, 'playing'); assert.equal(game.board.winner, null)
      assert.equal(game.currentPlayer(), 'black'); assert.equal(game.canRedo(), true)
      assert.notEqual(game.redo(), null); assert.equal(JSON.stringify(game.board), won)
      assert.equal(game.canRedo(), false); assert.equal(game.play(0, 0).ok, false)
    })
    check('G01: repeated full history rollback/replay remains stable and restart discards redo', () => {
      const game = rules.createGame()
      const moves = [[0, 0], [1, 0], [0, 2], [1, 2], [0, 4], [1, 4], [0, 6], [1, 6]]
      for (const point of moves) game.play(...point)
      const original = JSON.stringify(game.board)
      for (let cycle = 0; cycle < 10; cycle++) {
        for (let index = 0; index < moves.length; index++) assert.notEqual(game.undo(), null)
        assert.equal(game.board.grid.flat().filter(Boolean).length, 0)
        for (let index = 0; index < moves.length; index++) assert.notEqual(game.redo(), null)
        assert.equal(JSON.stringify(game.board), original)
      }
      game.undo(); game.restart()
      assert.equal(game.canRedo(), false); assert.equal(game.redo(), null)
      assert.equal(game.board.moves.length, 0); assert.equal(game.currentPlayer(), 'black')
    })
  }
  if (typeof rules.reconstructAt === 'function') {
    capabilities.push('G02-replay-rule-snapshots')
    check('G02: every replay prefix reconstructs the matching board and last move without changing the game', () => {
      const game = rules.createGame(); winningSequence(game, directions.vertical)
      const original = JSON.stringify(game.board), records = plain(game.moveList())
      for (let count = 0; count <= records.length; count++) {
        const prefix = records.slice(0, count), replay = rules.reconstructAt(prefix)
        const expected = Array.from({ length: 15 }, () => Array(15).fill(null))
        for (const point of prefix) expected[point.row][point.col] = point.color
        assert.deepEqual(plain(replay.grid), expected); assert.equal(replay.moveCount, count)
        if (count) assert.deepEqual(plain(replay.lastMove), prefix[count - 1])
        else assert.equal(replay.lastMove, null)
        assert.equal(replay.status, count === records.length ? 'won' : 'playing')
        assert.equal(JSON.stringify(game.board), original)
      }
    })
    check('G02: mutating a replay or move-list copy cannot corrupt the live board, history or redo branch', () => {
      const game = rules.createGame(); game.play(7, 7); game.play(7, 8); game.play(8, 8); game.undo()
      const original = JSON.stringify(game.board), list = game.moveList(), replay = rules.reconstructAt(list)
      replay.grid[7][7] = 'white'; replay.lastMove.row = 0; list[0].color = 'white'; list.pop()
      assert.equal(JSON.stringify(game.board), original); assert.equal(game.canRedo(), true)
      assert.equal(game.moveCount(), 2); assert.equal(game.moveList()[0].color, 'black')
      game.redo(); assert.equal(game.board.grid[8][8], 'black')
    })
    check('G02: move list supplies correct chronological indices and all four corner labels', () => {
      const game = rules.createGame()
      for (const point of [[0, 0], [0, 14], [14, 0], [14, 14]]) assert.equal(game.play(...point).ok, true)
      assert.deepEqual(plain(game.moveList()).map(move => [move.index, move.label, move.color]),
        [[1, 'A15', 'black'], [2, 'O15', 'white'], [3, 'A1', 'black'], [4, 'O1', 'white']])
    })
  }
  limitations.push('Only capabilities listed in coveredCapabilities were exercised. AI/clock/import/save/practice assertions await their actual modules; absence is not a passing result.')
  limitations.push('Pure module assertions do not verify DOM, keyboard focus, responsive layout, actual storage or browser responsiveness; root performs native-browser checks separately.')
  // An audit of a stale in-memory module must not attest to files a model has
  // replaced while it was running. Preserve both hashes for review on failure.
  const finalFingerprint = createHash('sha256').update(await readFile(file, 'utf8')).digest('hex')
  check('audit provenance: inspected rules source remained unchanged during execution', () => {
    assert.equal(finalFingerprint, fingerprint, 'Rules changed during the audit; rerun after the owning task settles')
  })
  return { passed: checks.length > 0 && checks.every(item => item.passed), checks, limitations, coveredCapabilities: capabilities,
    source: { file, sha256: fingerprint, finalSha256: finalFingerprint } }
}
