/** Independent tactical oracle for future G10 catalog acceptance.
 * This module has no generated-project imports and never accesses a browser.
 * Its own fixtures validate the oracle only; they do not count as game coverage.
 */
import assert from 'node:assert/strict'

const directions = [[0, 1], [1, 0], [1, 1], [1, -1]]
const opponent = color => color === 'black' ? 'white' : 'black'
const validColor = color => color === 'black' || color === 'white'

export function validateGrid(grid) {
  assert.ok(Array.isArray(grid) && grid.length === 15, 'Expected a 15-row grid')
  for (const row of grid) {
    assert.ok(Array.isArray(row) && row.length === 15, 'Expected 15 intersections per row')
    assert.ok(row.every(value => value === null || validColor(value)), 'Invalid intersection content')
  }
}

function lineThrough(grid, row, col, color, dr, dc) {
  const line = [[row, col]]
  for (const sign of [-1, 1]) {
    const side = []
    for (let distance = 1; distance < 15; distance += 1) {
      const r = row + dr * sign * distance, c = col + dc * sign * distance
      if (grid[r]?.[c] !== color) break
      side.push([r, c])
    }
    if (sign < 0) line.unshift(...side.reverse())
    else line.push(...side)
  }
  return line
}

export function winningLines(grid, color) {
  validateGrid(grid); assert.ok(validColor(color))
  const result = new Map()
  for (let row = 0; row < 15; row += 1) for (let col = 0; col < 15; col += 1) {
    if (grid[row][col] !== color) continue
    for (const [dr, dc] of directions) {
      if (grid[row - dr]?.[col - dc] === color) continue
      const line = lineThrough(grid, row, col, color, dr, dc)
      if (line.length >= 5) result.set(JSON.stringify(line), line)
    }
  }
  return [...result.values()]
}

function immediateWins(grid, color) {
  const wins = []
  for (let row = 0; row < 15; row += 1) for (let col = 0; col < 15; col += 1) {
    if (grid[row][col] !== null) continue
    // Counting through an empty candidate is equivalent to temporarily placing
    // this stone, and avoids modifying the catalog or browser-derived matrix.
    const lines = directions.map(([dr, dc]) => lineThrough(grid, row, col, color, dr, dc)).filter(line => line.length >= 5)
    if (lines.length) wins.push({ row, col, lines })
  }
  return wins
}

export function inspectTactic(grid, toMove) {
  validateGrid(grid); assert.ok(validColor(toMove), 'Invalid side to move')
  const before = JSON.stringify(grid), black = grid.flat().filter(color => color === 'black').length,
    white = grid.flat().filter(color => color === 'white').length
  const terminal = { black: winningLines(grid, 'black'), white: winningLines(grid, 'white') }
  assert.equal(terminal.black.length + terminal.white.length, 0, 'Exercise begins after a game has already ended')
  assert.ok(black === white || black === white + 1, 'Position cannot arise from alternating black-first play')
  assert.equal(toMove, black === white ? 'black' : 'white', 'Exercise side to move disagrees with stone counts')
  const wins = immediateWins(grid, toMove), threats = immediateWins(grid, opponent(toMove))
  const compulsoryBlocks = threats.length === 1 ? [{ row: threats[0].row, col: threats[0].col }] : []
  assert.equal(JSON.stringify(grid), before, 'Independent oracle must not alter its input')
  return { toMove, black, white, legalPoints: 225 - black - white,
    wins, threats, compulsoryBlocks,
    kind: wins.length ? 'one-move-win' : threats.length === 1 ? 'must-block' : threats.length > 1 ? 'unblockable-immediate-threats' : 'no-immediate-tactic' }
}

export function selfCheckTacticsOracle() {
  const grid = () => Array.from({ length: 15 }, () => Array(15).fill(null)), checks = []
  const check = (name, run) => {
    try { run(); checks.push({ name, passed: true }) }
    catch (error) { checks.push({ name, passed: false, error: error.message }) }
  }
  for (const [name, dr, dc] of [['horizontal', 0, 1], ['vertical', 1, 0], ['diagonal', 1, 1], ['anti-diagonal', 1, -1]]) {
    check('oracle only: ' + name + ' has two exact immediate endpoints', () => {
      const value = grid()
      for (let index = 0; index < 4; index += 1) { value[5 + dr * index][7 + dc * index] = 'black'; value[0][index * 2] = 'white' }
      const result = inspectTactic(value, 'black')
      assert.equal(result.kind, 'one-move-win')
      assert.deepEqual(result.wins.map(({ row, col }) => [row, col]).sort(), [[5 - dr, 7 - dc], [5 + dr * 4, 7 + dc * 4]].sort())
      assert.equal(result.threats.length, 0)
    })
  }
  check('oracle only: a closed white four has one compulsory black block', () => {
    const value = grid(); value[7][2] = 'black'
    for (const col of [3, 4, 5, 6]) value[7][col] = 'white'
    for (const col of [0, 2, 4]) value[0][col] = 'black'
    const result = inspectTactic(value, 'black')
    assert.equal(result.kind, 'must-block'); assert.deepEqual(result.compulsoryBlocks, [{ row: 7, col: 7 }])
  })
  check('oracle only: open enemy four cannot be advertised as one legal defensive answer', () => {
    const value = grid()
    for (let index = 0; index < 4; index += 1) { value[7][3 + index] = 'white'; value[0][2 * index] = 'black' }
    const result = inspectTactic(value, 'black')
    assert.equal(result.kind, 'unblockable-immediate-threats'); assert.equal(result.compulsoryBlocks.length, 0)
  })
  check('oracle only: an own immediate win takes priority over an enemy threat', () => {
    const value = grid()
    for (let index = 0; index < 4; index += 1) { value[7][3 + index] = 'black'; value[3][3 + index] = 'white' }
    const result = inspectTactic(value, 'black')
    assert.equal(result.kind, 'one-move-win'); assert.equal(result.threats.length, 2); assert.equal(result.wins.length, 2)
  })
  check('oracle only: pre-won and impossible-turn positions are refused', () => {
    const value = grid()
    for (let index = 0; index < 5; index += 1) value[7][index] = 'black'
    assert.throws(() => inspectTactic(value, 'white'), /already ended/)
    const empty = grid()
    assert.throws(() => inspectTactic(empty, 'white'), /stone counts/)
    empty[1][1] = 'white'
    assert.throws(() => inspectTactic(empty, 'black'), /alternating/)
  })
  check('oracle only: overlines retain the exact maximal winning coordinates', () => {
    const value = grid()
    for (let index = 3; index <= 8; index += 1) value[6][index] = 'black'
    assert.deepEqual(winningLines(value, 'black'), [[[6, 3], [6, 4], [6, 5], [6, 6], [6, 7], [6, 8]]])
  })
  return { scope: 'Independent oracle implementation only; zero generated-game requirement coverage',
    passed: checks.every(check => check.passed), checks }
}
