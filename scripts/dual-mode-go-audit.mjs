/** Independent rule audit. Reads the generated pure Go model into a restricted
 * VM; never imports its server, UI entrypoint, test runner, or live saved games. */
import assert from 'node:assert/strict'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const sha = value => createHash('sha256').update(value).digest('hex')
const copy = value => JSON.parse(JSON.stringify(value))
const stable = value => JSON.stringify(value)
const within = (root, file) => { const part = relative(root, file); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) }
const accepted = result => assert.equal(result?.ok, true, 'Expected a legal accepted move: ' + stable(result))

async function loadPureGame(workspace) {
  const root = await realpath(workspace), path = await realpath(resolve(root, 'src/game.js'))
  assert.ok(within(root, path), 'Rule module must stay within the owned game workspace')
  assert.ok((await stat(path)).size <= 1024 * 1024, 'Pure module is unexpectedly large')
  const source = await readFile(path, 'utf8')
  // The currently inspected game model has named declarations and no imports.
  // Reject an evolved dependency graph until it is reviewed instead of granting
  // arbitrary generated code Node/filesystem/network capability.
  assert.ok(!/^\s*import\s/m.test(source), 'Rule module dependencies changed; review loader before executing')
  const exports = [...source.matchAll(/^export\s+(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1])
  assert.ok(exports.includes('GoGame'), 'Inspected GoGame export is missing')
  const transformed = source.replace(/^export\s+(?=(?:const|let|class|function)\s)/gm, '')
  const context = vm.createContext({ console: Object.freeze({ log() {}, warn() {}, error() {} }) }, { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(`${transformed}\n;globalThis.__auditExports = {${exports.join(',')}};`, { filename: path }).runInContext(context, { timeout: 2000 })
  return { api: context.__auditExports, source, path, digest: sha(source), context }
}

/** Known-board fixtures belong only to fresh VM model instances. They never
 * inject state into the user's browser or overwrite project source/storage. */
function fixture(api, stones, turn = api.BLACK, options = {}) {
  const game = new api.GoGame({ size: 9, ...options })
  game.board.fill(api.EMPTY)
  for (const [row, col, color] of stones) game.board[row * game.size + col] = color
  game.turn = turn
  game.captures = { [api.BLACK]: 0, [api.WHITE]: 0 }
  game.koPoint = null; game.passes = 0; game.ended = false; game.lastMove = null
  game.history = new Set([game.positionKey()])
  return game
}
function koStones(api, row, col, attacker) {
  const victim = attacker === api.BLACK ? api.WHITE : api.BLACK
  return [[row, col, victim], [row - 1, col, attacker], [row, col - 1, attacker], [row + 1, col, attacker],
    [row - 1, col + 1, victim], [row + 1, col + 1, victim], [row, col + 2, victim]]
}
function visibleState(game) {
  return stable({ board: [...game.board], turn: game.turn, captures: { ...game.captures }, passes: game.passes,
    ended: game.ended, phase: game.phase, winner: game.winner, score: game.score, lastMove: game.lastMove,
    moveCount: game.moveStack?.length, koPoint: game.koPoint, history: [...game.history],
    deadStones: game.deadStones ? [...game.deadStones] : undefined, confirmed: game.confirmed,
    resignedBy: game.resignedBy })
}

/** Independent flood-fill oracle. It uses no GoGame helpers and models the
 * requested positional superko contract, including atomic rejected moves. */
function oracleBoard(size) {
  let board = Array(size * size).fill(''), turn = 'black'
  const seen = new Set([board.join('.')])
  const neighbors = index => {
    const row = Math.floor(index / size), col = index % size, result = []
    if (row) result.push(index - size)
    if (row + 1 < size) result.push(index + size)
    if (col) result.push(index - 1)
    if (col + 1 < size) result.push(index + 1)
    return result
  }
  const group = (grid, index) => {
    const stones = new Set([index]), liberties = new Set(), pending = [index]
    for (const current of pending) for (const next of neighbors(current)) {
      if (!grid[next]) liberties.add(next)
      else if (grid[next] === grid[index] && !stones.has(next)) { stones.add(next); pending.push(next) }
    }
    return { stones, liberties }
  }
  return {
    get board() { return [...board] }, get turn() { return turn },
    play(index) {
      if (!Number.isInteger(index) || index < 0 || index >= board.length || board[index]) return { ok: false }
      const next = [...board], other = turn === 'black' ? 'white' : 'black', captured = new Set()
      next[index] = turn
      for (const adjacent of neighbors(index)) if (next[adjacent] === other) {
        const enemy = group(next, adjacent)
        if (!enemy.liberties.size) for (const stone of enemy.stones) captured.add(stone)
      }
      for (const stone of captured) next[stone] = ''
      const key = next.join('.')
      if (!group(next, index).liberties.size || seen.has(key)) return { ok: false }
      board = next; turn = other; seen.add(key)
      return { ok: true, captured: [...captured].sort((a, b) => a - b) }
    }
  }
}

export async function auditRules(workspace, { baselineOnly = false, requirements = null } = {}) {
  if (requirements !== null && (!Array.isArray(requirements) || requirements.some(value => typeof value !== 'string'))) throw new Error('requirements must be an array of requirement IDs')
  const requested = requirements === null ? null : new Set(requirements)
  const checks = [], limitations = ['Pure rule fixtures are separate VM instances; this report does not replace native-browser UI, clock visibility, responsive layout or persistent-storage acceptance.']
  let loaded
  try { loaded = await loadPureGame(workspace) } catch (error) { return { passed: false, checks: [{ name: 'load reviewed pure rule module', passed: false, error: error.message }], limitations } }
  const { api } = loaded, { GoGame, BLACK, WHITE, EMPTY } = api
  const check = (name, run, requirement = 'baseline') => {
    if (requested && !requested.has(requirement)) return
    try {
      loaded.context.__auditCheck = run
      const evidence = vm.runInContext('__auditCheck()', loaded.context, { timeout: 5000 })
      checks.push({ name, requirement, passed: true, ...(evidence === undefined ? {} : { evidence: copy(evidence) }) })
    }
    catch (error) { checks.push({ name, requirement, passed: false, error: error.message }) }
    finally { delete loaded.context.__auditCheck }
  }
  check('9x9 fresh state, first player, corner and center liberties', () => {
    const game = new GoGame({ size: 9 })
    assert.equal(game.board.length, 81); assert.ok(game.board.every(value => value === EMPTY)); assert.equal(game.turn, BLACK)
    accepted(game.play(0)); assert.equal(game.libertiesAt(0), 2)
    const center = new GoGame({ size: 9 }); accepted(center.play(40)); assert.equal(center.libertiesAt(40), 4)
  })
  check('invalid and occupied moves reject atomically without switching turn', () => {
    const game = new GoGame({ size: 9 }); accepted(game.play(40))
    for (const index of [-1, 81, 1.5, NaN, null, '1', 40]) {
      const before = visibleState(game); assert.equal(game.play(index).ok, false, `Invalid point ${String(index)}`); assert.equal(visibleState(game), before)
    }
  })
  check('legal three-move corner capture removes white and counts one prisoner', () => {
    const game = new GoGame({ size: 9 }); accepted(game.play(1)); accepted(game.play(0))
    const move = game.play(9); accepted(move)
    assert.equal(game.at(0), EMPTY); assert.equal(game.captures[BLACK], 1); assert.equal(stable([...move.captured].sort((a, b) => a - b)), '[0]')
    return { moves: [1, 0, 9], captured: move.captured }
  })
  check('one move captures two distinct adjacent enemy blocks', () => {
    const stones = [[1, 2, WHITE], [2, 1, WHITE], [0, 2, BLACK], [1, 1, BLACK], [1, 3, BLACK], [2, 0, BLACK], [3, 1, BLACK]]
    const game = fixture(api, stones); const result = game.play(20); accepted(result)
    assert.equal(game.at(11), EMPTY); assert.equal(game.at(19), EMPTY); assert.equal(game.captures[BLACK], 2)
  })
  check('capture before suicide check permits surrounded capturing move', () => {
    const whitePoints = [[1, 2], [2, 1], [2, 3], [3, 2]], stones = whitePoints.map(([r, c]) => [r, c, WHITE])
    const black = new Set()
    for (const [r, c] of whitePoints) for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (!(r + dr === 2 && c + dc === 2)) black.add((r + dr) * 9 + c + dc)
    for (const index of black) stones.push([Math.floor(index / 9), index % 9, BLACK])
    const game = fixture(api, stones); accepted(game.play(20)); assert.equal(game.captures[BLACK], 4); assert.equal(game.libertiesAt(20), 4)
  })
  check('pure suicide rejects without mutating prisoners, turn or history', () => {
    const game = fixture(api, [[1, 2, WHITE], [2, 1, WHITE], [2, 3, WHITE], [3, 2, WHITE]])
    const before = visibleState(game); assert.equal(game.play(20).ok, false); assert.equal(visibleState(game), before)
  })
  check('connected block counts shared liberties only once', () => {
    const game = fixture(api, [[0, 0, BLACK], [0, 1, BLACK]])
    assert.equal(game.group(0).stones.length, 2); assert.equal(game.libertiesAt(0), 3); assert.equal(game.libertiesAt(1), 3)
  })
  check('simple ko immediately rejects recapture atomically', () => {
    const game = fixture(api, koStones(api, 2, 2, BLACK)); accepted(game.play(21))
    assert.equal(game.at(20), EMPTY); const before = visibleState(game)
    assert.equal(game.play(20).ok, false); assert.equal(visibleState(game), before)
  })
  check('ko after a real threat and reply is legal because the whole board changed', () => {
    const game = fixture(api, koStones(api, 2, 2, BLACK)); accepted(game.play(21)); accepted(game.play(80)); accepted(game.play(72))
    accepted(game.play(20)); assert.equal(game.at(21), EMPTY); assert.equal(game.at(20), WHITE)
  })
  check('pass switches player, a move clears consecutive passes, two passes settle', () => {
    const game = new GoGame({ size: 9 }); accepted(game.pass()); assert.equal(game.turn, WHITE); assert.equal(game.passes, 1)
    accepted(game.play(40)); assert.equal(game.passes, 0); accepted(game.pass()); assert.equal(game.ended, false)
    accepted(game.pass()); assert.ok(game.ended || game.phase === 'scoring' || game.phase === 'counting', 'Two passes must enter ending/scoring')
    assert.equal(game.play(41).ok, false, 'No ordinary placement in scoring/ended phase')
  })
  check('reset clears a prior winner, result, board and ko history', () => {
    const game = new GoGame({ size: 9 }); accepted(game.play(0)); accepted(game.pass()); accepted(game.pass()); game.reset()
    assert.ok(game.board.every(value => value === EMPTY)); assert.equal(game.turn, BLACK); assert.equal(game.ended, false)
    assert.ok(game.winner == null, 'Previous winner must not survive a new game'); assert.equal(game.captures[BLACK], 0)
    assert.equal(game.history.size, 1)
  })
  check('returned snapshot cannot mutate the underlying board or prisoners', () => {
    const game = new GoGame({ size: 9 }), snapshot = game.snapshot()
    snapshot.board[0] = WHITE; snapshot.captures[BLACK] = 999
    assert.equal(game.at(0), EMPTY); assert.equal(game.captures[BLACK], 0)
  })
  if (!baselineOnly) {
    check('9, 13 and 19 board sizes and configured komi remain distinct', () => {
      for (const size of [9, 13, 19]) { const game = new GoGame({ size, komi: 7.5 }); assert.equal(game.board.length, size * size); assert.equal(game.size, size); assert.equal(game.areaScore().komi, 7.5) }
    }, 'W01')
    check('all supported sizes preserve corner coordinates and independently configured names', () => {
      for (const size of [9, 13, 19]) {
        const game = new GoGame({ size, komi: 7.5, blackName: '甲', whiteName: '乙' })
        const corners = [[0, 0], [0, size - 1], [size - 1, 0], [size - 1, size - 1]]
        for (const [row, col] of corners) {
          const index = row * size + col
          assert.equal(game.index(row, col), index); assert.deepEqual(copy(game.coord(index)), { row, col })
          accepted(game.play(index)); assert.equal(game.libertiesAt(index), 2)
        }
        game.reset()
        assert.equal(game.size, size); assert.equal(game.komi, 7.5)
        assert.equal(game.nameOf(BLACK), '甲'); assert.equal(game.nameOf(WHITE), '乙')
      }
    }, 'W01')
    check('positional superko rejects the sixth capture in a three-ko cycle', () => {
      const game = fixture(api, [...koStones(api, 2, 2, BLACK), ...koStones(api, 2, 6, WHITE), ...koStones(api, 6, 2, BLACK)])
      const initial = game.positionKey(), moves = [21, 25, 57, 20, 24]
      for (const point of moves) accepted(game.play(point))
      const before = visibleState(game), repeated = game.play(56)
      if (repeated.ok) assert.equal(game.positionKey(), initial, 'Audit fixture must actually return to its complete starting board')
      assert.equal(repeated.ok, false, 'Sixth capture repeats the initial complete board and must be rejected')
      assert.equal(visibleState(game), before); assert.ok(game.history.has(initial))
      return { acceptedMoves: moves, rejectedMove: 56 }
    }, 'W02')
    check('undo restores captured stones, prisoners, passes and the exact retained positional history', () => {
      const game = new GoGame({ size: 9 }), checkpoints = []
      for (const action of [1, 0, 9, 'pass', 40, 'pass', 'pass']) {
        checkpoints.push(visibleState(game))
        accepted(action === 'pass' ? game.pass() : game.play(action))
      }
      assert.equal(game.captures[BLACK], 1)
      for (let index = checkpoints.length - 1; index >= 0; index--) {
        accepted(game.undo()); assert.equal(visibleState(game), checkpoints[index], `Undo action ${index + 1}`)
      }
      assert.equal(game.canUndo(), false); assert.equal(game.undo().ok, false)
      assert.equal(game.history.size, 1)
      return { actions: [1, 0, 9, 'pass', 40, 'pass', 'pass'], restoredCheckpoints: checkpoints.length }
    }, 'W02')
    check('undo removes revoked superko positions so the same legal capture can be played again', () => {
      const game = new GoGame({ size: 9, initialStones: koStones(api, 2, 2, BLACK) })
      const initial = visibleState(game)
      accepted(game.play(21)); const captured = visibleState(game), captureKey = game.positionKey()
      assert.ok(game.history.has(captureKey))
      accepted(game.undo()); assert.equal(visibleState(game), initial)
      assert.equal(game.history.has(captureKey), false)
      accepted(game.play(21)); assert.equal(visibleState(game), captured)
      const before = visibleState(game); assert.equal(game.play(20).ok, false); assert.equal(visibleState(game), before)
    }, 'W02')
    check('Chinese area scoring counts stones, surrounded empties and neutral dame', () => {
      const stones = []
      for (let row = 0; row < 9; row++) for (let col = 0; col < 9; col++) {
        if (col === 4 || row === 4 && (col === 2 || col === 6)) continue
        stones.push([row, col, col < 4 ? BLACK : WHITE])
      }
      const score = fixture(api, stones, BLACK, { komi: 7.5 }).areaScore()
      assert.equal(score.black, 36, '35 live stones + one black-only enclosed point')
      assert.equal(score.whiteArea, 36, '35 live stones + one white-only enclosed point; nine middle dame excluded')
      assert.equal(score.white, 43.5, 'The reviewed API includes komi in white total')
      assert.equal(score.komi, 7.5); assert.equal(score.winner, WHITE)
      return score
    }, 'W01')
    check('board edges enclose valid territory rather than forcing every edge point neutral', () => {
      const stones = [[0, 2, BLACK], [1, 2, BLACK], [2, 0, BLACK], [2, 1, BLACK], [2, 2, BLACK], [8, 7, WHITE], [8, 8, WHITE]]
      const score = fixture(api, stones, BLACK, { komi: 7.5 }).areaScore()
      assert.equal(score.black, 9, 'Five black stones enclose four corner empties using the board edges')
      assert.equal(score.whiteArea, 2, 'Outer mixed-border empty region remains neutral')
      return score
    }, 'W01')
    check('Chinese area territory is independent of corner size and board orientation', () => {
      const checked = []
      for (const [width, height] of [[2, 2], [3, 3], [4, 2], [2, 4]]) for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
        const orient = ([row, col, color]) => [corner.startsWith('bottom') ? 8 - row : row, corner.endsWith('right') ? 8 - col : col, color]
        const stones = [[8, 7, WHITE], [8, 8, WHITE]]
        for (let row = 0; row < height; row++) stones.push([row, width, BLACK])
        for (let col = 0; col <= width; col++) stones.push([height, col, BLACK])
        const score = fixture(api, stones.map(orient), BLACK, { komi: 7.5 }).areaScore()
        assert.equal(score.blackTerritory, width * height, `${corner} ${width}x${height} enclosed empty region has only black stone boundaries and board edges`)
        assert.equal(score.black, width + height + 1 + width * height); assert.equal(score.whiteArea, 2)
        checked.push({ corner, width, height, blackTerritory: score.blackTerritory })
      }
      return { fixtures: checked }
    }, 'W03')
    check('enclosed side territory can span several empty points along every board edge', () => {
      const base = [[8, 7, WHITE], [8, 8, WHITE]]
      for (let row = 0; row <= 2; row++) { base.push([row, 1, BLACK]); base.push([row, 5, BLACK]) }
      for (let col = 2; col <= 4; col++) base.push([2, col, BLACK])
      const checked = []
      for (let rotation = 0; rotation < 4; rotation++) {
        const stones = base.map(([initialRow, initialCol, color]) => {
          let row = initialRow, col = initialCol
          for (let step = 0; step < rotation; step++) [row, col] = [col, 8 - row]
          return [row, col, color]
        })
        const score = fixture(api, stones, BLACK, { komi: 7.5 }).areaScore()
        assert.equal(score.blackStones, 9); assert.equal(score.blackTerritory, 6, `Side enclosure rotation ${rotation} has six empty points`)
        assert.equal(score.black, 15); assert.equal(score.whiteArea, 2)
        checked.push({ rotation, blackStones: 9, blackTerritory: 6 })
      }
      return { fixtures: checked }
    }, 'W03')
    check('deterministic legal play agrees with an independent capture, suicide and superko oracle', () => {
      let attempts = 0, legalMoves = 0, captures = 0
      for (const size of [9, 13, 19]) for (let seed = 1; seed <= 4; seed++) {
        const game = new GoGame({ size }), oracle = oracleBoard(size)
        let random = seed
        for (let step = 0; step < 250; step++) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0
          const point = random % (size * size), expected = oracle.play(point), actual = game.play(point)
          attempts++
          assert.equal(actual.ok, expected.ok, `size=${size} seed=${seed} step=${step} point=${point}`)
          assert.deepEqual([...game.board], oracle.board); assert.equal(game.turn, oracle.turn)
          if (expected.ok) {
            legalMoves++; captures += expected.captured.length
            assert.deepEqual([...actual.captured].sort((a, b) => a - b), expected.captured)
          }
        }
      }
      return { games: 12, attempts, legalMoves, capturedStones: captures }
    }, 'W02')
    check('two passes enter review without a winner and require both independent confirmations', () => {
      const game = new GoGame({ size: 9, komi: 7.5 })
      accepted(game.pass()); assert.equal(game.phase, 'playing')
      accepted(game.pass()); assert.equal(game.phase, 'scoring'); assert.equal(game.ended, false); assert.equal(game.winner, null)
      assert.equal(game.score.black, 0); assert.equal(game.score.white, 7.5)
      for (const action of [() => game.play(40), () => game.pass()]) {
        const before = visibleState(game); assert.equal(action().ok, false); assert.equal(visibleState(game), before)
      }
      accepted(game.confirmScore(BLACK)); assert.equal(game.ended, false); assert.equal(game.confirmed[WHITE], false)
      accepted(game.confirmScore(BLACK)); assert.equal(game.ended, false, 'A repeated black confirmation cannot substitute for white')
      const final = game.confirmScore(WHITE); accepted(final); assert.equal(final.locked, true)
      assert.equal(game.phase, 'ended'); assert.equal(game.ended, true); assert.equal(game.winner, WHITE)
      return { provisionalWinner: null, confirmationsRequired: [BLACK, WHITE], finalWhiteScore: game.score.white }
    }, 'W03')
    check('dead-stone review recomputes Chinese corner territory and invalidates earlier consent', () => {
      const stones = [[0, 2, BLACK], [1, 2, BLACK], [2, 0, BLACK], [2, 1, BLACK], [2, 2, BLACK], [0, 0, WHITE], [8, 7, WHITE], [8, 8, WHITE]]
      const game = fixture(api, stones, BLACK, { komi: 7.5 })
      accepted(game.pass()); accepted(game.pass())
      const board = [...game.board], prisoners = stable(game.captures), history = [...game.history], originalScore = copy(game.score)
      accepted(game.confirmScore(BLACK)); assert.equal(game.confirmed[BLACK], true)
      accepted(game.toggleDead(0)); assert.equal(game.deadStones.has(0), true)
      assert.equal(game.confirmed[BLACK], false); assert.equal(game.confirmed[WHITE], false)
      assert.equal(game.score.blackStones, 5); assert.equal(game.score.blackTerritory, 4); assert.equal(game.score.black, 9)
      assert.equal(game.score.whiteStones, 2); assert.equal(game.score.white, 9.5)
      assert.deepEqual([...game.board], board); assert.equal(stable(game.captures), prisoners); assert.deepEqual([...game.history], history)
      accepted(game.toggleDead(0)); assert.equal(game.deadStones.has(0), false); assert.deepEqual(copy(game.score), originalScore)
      accepted(game.toggleDead(0)); accepted(game.confirmScore(WHITE)); accepted(game.clearDead())
      assert.equal(game.deadStones.size, 0); assert.equal(game.confirmed[WHITE], false); assert.deepEqual(copy(game.score), originalScore)
      return { deadPoint: 0, blackStones: 5, blackTerritoryAfterRemoval: 4, originalPositionPreserved: true }
    }, 'W03')
    check('dead markers reject empty and malformed points without altering score or consent', () => {
      const game = new GoGame({ size: 9 }); accepted(game.play(0)); accepted(game.pass()); accepted(game.pass()); accepted(game.confirmScore(BLACK))
      for (const index of [-1, 81, 1.5, NaN, null, '0', 40]) {
        const before = visibleState(game); assert.equal(game.toggleDead(index).ok, false, `Invalid dead point ${String(index)}`)
        assert.equal(visibleState(game), before)
      }
    }, 'W03')
    check('resuming review preserves stones, prisoners and superko while clearing scoring state', () => {
      const game = new GoGame({ size: 9 }); for (const point of [1, 0, 9]) accepted(game.play(point))
      const before = { board: [...game.board], turn: game.turn, captures: copy(game.captures), history: [...game.history] }
      accepted(game.pass()); accepted(game.pass()); accepted(game.toggleDead(1)); accepted(game.confirmScore(BLACK)); accepted(game.resume())
      assert.equal(game.phase, 'playing'); assert.equal(game.ended, false); assert.equal(game.winner, null); assert.equal(game.score, null)
      assert.equal(game.passes, 0); assert.equal(game.deadStones.size, 0); assert.equal(game.confirmed[BLACK], false); assert.equal(game.confirmed[WHITE], false)
      assert.deepEqual([...game.board], before.board); assert.equal(game.turn, before.turn)
      assert.deepEqual(copy(game.captures), before.captures); assert.deepEqual([...game.history], before.history)
      accepted(game.play(40)); assert.equal(game.phase, 'playing'); assert.equal(game.at(40), WHITE)
      accepted(game.pass()); assert.equal(game.phase, 'playing', 'One new pass after resuming cannot immediately return to scoring')
    }, 'W03')
    check('confirmed scores lock review controls and ordinary moves', () => {
      const game = new GoGame({ size: 9 }); accepted(game.play(0)); accepted(game.pass()); accepted(game.pass())
      accepted(game.confirmScore(BLACK)); accepted(game.confirmScore(WHITE))
      for (const action of [() => game.play(40), () => game.pass(), () => game.toggleDead(0), () => game.clearDead(), () => game.confirmScore(BLACK), () => game.resume(), () => game.resign(BLACK)]) {
        const before = visibleState(game); assert.equal(action().ok, false); assert.equal(visibleState(game), before)
      }
    }, 'W03')
    check('resignation from play or score review awards the opponent without inventing an area result', () => {
      for (const color of [BLACK, WHITE]) for (const fromScoring of [false, true]) {
        const game = new GoGame({ size: 9 }); accepted(game.play(40))
        if (fromScoring) { accepted(game.pass()); accepted(game.pass()) }
        const board = [...game.board], history = [...game.history]
        accepted(game.resign(color)); assert.equal(game.resignedBy, color); assert.equal(game.winner, color === BLACK ? WHITE : BLACK)
        assert.equal(game.ended, true); assert.equal(game.phase, 'ended'); assert.equal(game.score, null)
        assert.deepEqual([...game.board], board); assert.deepEqual([...game.history], history)
        const before = visibleState(game); assert.equal(game.play(41).ok, false); assert.equal(visibleState(game), before)
        game.reset(); assert.equal(game.phase, 'playing'); assert.equal(game.resignedBy, null); assert.equal(game.winner, null); assert.equal(game.score, null)
        assert.equal(game.deadStones.size, 0); assert.equal(game.confirmed[BLACK], false); assert.equal(game.confirmed[WHITE], false)
      }
      return { colors: [BLACK, WHITE], startingPhases: ['playing', 'scoring'] }
    }, 'W03')
    check('continuous undo and redo exactly restore every capture and pass checkpoint', () => {
      const game = new GoGame({ size: 9 }), states = [visibleState(game)], records = [copy(game.moveRecord)]
      const actions = [1, 0, 9, 'pass', 40, 'pass', 'pass']
      for (const action of actions) {
        accepted(action === 'pass' ? game.pass() : game.play(action))
        states.push(visibleState(game)); records.push(copy(game.moveRecord))
      }
      for (let index = actions.length - 1; index >= 0; index--) {
        accepted(game.undo()); assert.equal(visibleState(game), states[index]); assert.deepEqual(copy(game.moveRecord), records[index])
      }
      assert.equal(game.canUndo(), false); assert.equal(game.canRedo(), true)
      for (let index = 1; index <= actions.length; index++) {
        accepted(game.redo()); assert.equal(visibleState(game), states[index], `Redo checkpoint ${index}`)
        assert.deepEqual(copy(game.moveRecord), records[index], `Move record at checkpoint ${index}`)
        assert.equal(game.canRedo(), index < actions.length, 'One redo must retain every later redo action')
      }
      assert.equal(game.redo().ok, false)
      return { actions, exactStatesRecreated: actions.length, capturesAtEnd: game.captures[BLACK], phaseAtEnd: game.phase }
    }, 'W04')
    check('rejected moves preserve redo while either a new placement or pass discards the old branch', () => {
      for (const branch of ['play', 'pass']) {
        const game = new GoGame({ size: 9 }); for (const point of [1, 0, 9, 40]) accepted(game.play(point))
        accepted(game.undo()); accepted(game.undo()); assert.equal(game.redoStack.length, 2)
        const before = visibleState(game), recordBefore = copy(game.moveRecord)
        assert.equal(game.play(1).ok, false); assert.equal(visibleState(game), before); assert.deepEqual(copy(game.moveRecord), recordBefore)
        assert.equal(game.redoStack.length, 2)
        accepted(branch === 'play' ? game.play(10) : game.pass())
        assert.equal(game.canRedo(), false); assert.equal(game.redo().ok, false); assert.equal(game.moveRecord.length, 3)
        assert.equal(game.moveRecord.at(-1).type, branch === 'play' ? 'play' : 'pass')
      }
    }, 'W04')
    check('replaying every move reconstructs captures, ko, passes and provisional score without changing the official game', () => {
      const game = new GoGame({ size: 9 }), states = [JSON.parse(visibleState(game))]
      const actions = [1, 0, 9, 'pass', 40, 'pass', 'pass']
      for (const action of actions) { accepted(action === 'pass' ? game.pass() : game.play(action)); states.push(JSON.parse(visibleState(game))) }
      const official = visibleState(game), record = copy(game.moveRecord)
      for (let index = 0; index < states.length; index++) {
        const replay = game.replayTo(index), expected = states[index]
        assert.deepEqual([...replay.board], expected.board); assert.deepEqual(copy(replay.captures), expected.captures)
        for (const key of ['turn', 'passes', 'lastMove', 'koPoint', 'ended', 'winner']) assert.equal(replay[key], expected[key], `Replay move ${index}: ${key}`)
        assert.deepEqual(copy(replay.score), expected.score, `Replay move ${index}: provisional score`)
        assert.equal(visibleState(game), official); assert.deepEqual(copy(game.moveRecord), record)
      }
      const detached = game.replayTo(2); detached.board[0] = BLACK; detached.captures[BLACK] = 1000
      assert.equal(visibleState(game), official); assert.equal(game.replayTo(2).board[0], WHITE)
      return { replayedCheckpoints: states.length, officialMoveCount: record.length }
    }, 'W04')
    check('review navigation stays within history and exits back to the exact official position', () => {
      const game = new GoGame({ size: 9 }); for (const point of [1, 0, 9, 40]) accepted(game.play(point))
      const official = visibleState(game), record = copy(game.moveRecord)
      accepted(game.enterReview()); assert.equal(game.isReviewing(), true); assert.equal(game.reviewCursor, 4); assert.equal(game.totalMoves(), 4)
      accepted(game.reviewJump(0)); accepted(game.reviewPrev()); assert.equal(game.reviewCursor, 0)
      for (let index = 1; index <= 4; index++) { accepted(game.reviewNext()); assert.equal(game.reviewCursor, index) }
      accepted(game.reviewNext()); assert.equal(game.reviewCursor, 4)
      accepted(game.reviewJump(2)); assert.equal(game.reviewCursor, 2)
      assert.equal(visibleState(game), official); assert.deepEqual(copy(game.moveRecord), record)
      accepted(game.exitReview()); assert.equal(game.isReviewing(), false); assert.equal(game.reviewCursor, null)
      assert.equal(visibleState(game), official); accepted(game.play(41)); assert.equal(game.totalMoves(), 5)
    }, 'W04')
    check('replay distinguishes a legal snapback capture from a one-stone ko', () => {
      const game = new GoGame({ size: 9 }), setup = [1, 0, 10, 9, 3, 19, 72, 20, 74, 12, 76, 2]
      for (const point of setup) accepted(game.play(point))
      const capture = game.play(11); accepted(capture)
      assert.equal(capture.captured.length, 1); assert.equal(game.group(11).stones.length, 3); assert.equal(game.libertiesAt(11), 1)
      assert.equal(game.koPoint, null, 'A three-stone capturing group is not a simple ko')
      assert.equal(game.replayTo(13).koPoint, null, 'Replay cannot invent a ko marker absent from the actual legal history')
      const snapback = game.play(2); accepted(snapback); assert.equal(snapback.captured.length, 3)
      assert.deepEqual([...game.replayTo(14).board], [...game.board]); assert.deepEqual(copy(game.replayTo(14).captures), copy(game.captures))
      return { setup, blackCapture: 11, whiteSnapback: 2, recapturedStones: 3 }
    }, 'W04')
  }
  const after = await readFile(loaded.path, 'utf8')
  if (sha(after) !== loaded.digest) checks.push({ name: 'source remained stable throughout this audit', passed: false, error: 'The real model edited src/game.js during audit; rerun against a settled stage' })
  if (baselineOnly) limitations.push('Only baseline rules were requested; W01-W10 feature completeness has not been evaluated.')
  if (requested) limitations.push(`Only requested rule scopes were evaluated: ${[...requested].join(', ')}`)
  const uncovered = ['W05', 'W06', 'W07', 'W08', 'W09', 'W10'].map(id => ({ id,
    reason: 'Requested feature has not been generated and reviewed; no speculative API or substitute instance-only assertion is counted as acceptance.' }))
  limitations.push('W03 uses the reviewed phase, toggleDead, clearDead, confirmScore, resume and resign API; pure-rule coverage does not confirm native scoring controls or visual clarity.')
  limitations.push('W04 undo/redo, branching and replay APIs are reviewed; browser controls and explicit replay superko-history reconstruction still need separate evidence.')
  return { passed: checks.length > 0 && checks.every(item => item.passed), checks, limitations, uncovered,
    coveredCapabilities: [...new Set(checks.filter(item => item.passed).map(item => item.requirement))].map(id => `${id}-rule-subset`),
    source: { path: loaded.path, sha256: loaded.digest }, api: { exports: Object.keys(api), methods: Object.getOwnPropertyNames(GoGame.prototype) } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('Usage: node scripts/dual-mode-go-audit.mjs <work-go-directory> [--baseline]'); process.exitCode = 2 }
  else { const result = await auditRules(process.argv[2], { baselineOnly: process.argv.includes('--baseline') }); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1 }
}
