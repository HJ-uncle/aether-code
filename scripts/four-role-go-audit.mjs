/** Four-role campaign: independent Go oracle and user-input acceptance.
 * Native mode reuses an existing idle Electron guest; it never launches Electron,
 * installs game state, imports generated code or writes to the game workspace.
 * CLI mode uses separate headless Chromium and is explicitly reported as such.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 800, mobile: true, deviceScaleFactor: 1 },
  { name: 'phone-390', width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true, deviceScaleFactor: 1 },
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
]
/** Reviewed against the round-1 baseline DOM on 2026-11-04. Additional controls
 * are discovered from observed labels or supplied after their source review. */
export const YIZHOU_SELECTORS = Object.freeze({ board: '#grid', points: '.point', restart: '#restart', pass: '#pass',
  status: '.status,#hint,#result-panel', turn: '#turn-label', moves: '#move-count', captures: ['#capture-black', '#capture-white'] })
const active = new Set(['preparing', 'running', 'waiting', 'cancelling'])
const clone = value => JSON.parse(JSON.stringify(value))
const slug = value => String(value).replace(/[^a-z0-9_-]/gi, '-').slice(0, 80)
const originOf = value => { try { return new URL(value).origin } catch { return '' } }

async function poll(read, accept, description, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  let value
  do { value = await read(); if (accept(value)) return value; await delay(60) } while (Date.now() < until)
  throw new Error(`${description}: ${JSON.stringify(value).slice(0, 1200)}`)
}

/** Separate flood-fill implementation, derived from the existing independent
 * dual-mode-go-audit oracle. Simple ko is the minimum; superko is configurable. */
export function createGoOracle({ size = 9, ko = 'simple' } = {}) {
  assert.equal(size, 9)
  assert.ok(['simple', 'positional'].includes(ko))
  let board, turn, passes, ended, captured, previousPosition, seen
  const adjacent = index => [index >= size ? index - size : -1, index < size * (size - 1) ? index + size : -1,
    index % size ? index - 1 : -1, index % size < size - 1 ? index + 1 : -1].filter(value => value >= 0)
  const group = (grid, start) => {
    const stones = new Set([start]), liberties = new Set(), pending = [start]
    for (const at of pending) for (const next of adjacent(at)) {
      if (!grid[next]) liberties.add(next)
      else if (grid[next] === grid[start] && !stones.has(next)) { stones.add(next); pending.push(next) }
    }
    return { stones, liberties }
  }
  const key = grid => grid.map(value => value || '.').join(',')
  const reset = () => { board = Array(81).fill(null); turn = 'black'; passes = 0; ended = false; captured = { black: 0, white: 0 }; previousPosition = null; seen = new Set([key(board)]) }
  reset()
  return {
    snapshot: () => clone({ board, turn, passes, ended, captured }), reset,
    play(index) {
      if (ended || !Number.isInteger(index) || index < 0 || index >= 81 || board[index]) return { ok: false, reason: ended ? 'ended' : 'occupied-or-invalid' }
      const next = [...board], other = turn === 'black' ? 'white' : 'black', prisoners = new Set()
      next[index] = turn
      for (const at of adjacent(index)) if (next[at] === other) {
        const enemy = group(next, at)
        if (!enemy.liberties.size) for (const stone of enemy.stones) prisoners.add(stone)
      }
      for (const stone of prisoners) next[stone] = null
      if (!group(next, index).liberties.size) return { ok: false, reason: 'suicide' }
      const position = key(next)
      if (ko === 'simple' ? position === previousPosition : seen.has(position)) return { ok: false, reason: 'ko' }
      previousPosition = key(board); seen.add(position); board = next; captured[turn] += prisoners.size
      turn = other; passes = 0
      return { ok: true, captured: [...prisoners].sort((a, b) => a - b) }
    },
    pass() {
      if (ended) return { ok: false, reason: 'ended' }
      previousPosition = key(board); turn = turn === 'black' ? 'white' : 'black'; passes++; ended = passes === 2
      return { ok: true }
    },
  }
}

/** These are legal UI sequences, not injected board fixtures. */
export const SCENARIOS = Object.freeze({
  capture: { setup: [1, 0], move: 9, captured: [0] },
  suicide: { setup: [80, 11, 78, 19, 76, 21, 74, 29], rejected: 20 },
  ko: { setup: [11, 20, 19, 12, 29, 30, 72, 22, 21], rejected: 20, threatAndReply: [80, 78], recapture: 20 },
})

/** Source-reviewed adapter for the generated rules.js pure-function contract.
 * Fresh isolated VM instances only; no module import can start its server/UI. */
export async function auditRules(workspace, { rulesPath = 'js/rules.js' } = {}) {
  const root = realpathSync(workspace), file = realpathSync(resolve(root, rulesPath)), part = relative(root, file)
  assert.ok(!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep), 'Rules must belong to the audited workspace')
  const source = readFileSync(file, 'utf8'), hash = createHash('sha256').update(source).digest('hex')
  assert.ok(source.length <= 1024 * 1024 && !/^\s*import\s/m.test(source), 'Review evolved module dependencies before execution')
  const names = [...source.matchAll(/^export\s+(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1])
  for (const name of ['createGame', 'tryPlay', 'pass', 'BLACK', 'WHITE', 'EMPTY']) assert.ok(names.includes(name), 'Pure rule contract changed: ' + name)
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(source.replace(/^export\s+(?=(?:const|let|class|function)\s)/gm, '') + `\nglobalThis.api={${names.join(',')}}`, { filename: file }).runInContext(context, { timeout: 2000 })
  const api = context.api, checks = []
  const check = (name, run) => {
    try { context.runAudit = run; const detail = vm.runInContext('runAudit()', context, { timeout: 5000 }); checks.push({ name, passed: true, detail }) }
    catch (error) { checks.push({ name, passed: false, error: error.message }) }
    finally { delete context.runAudit }
  }
  const advance = (state, index) => api.tryPlay(state, Math.floor(index / 9) + 1, index % 9 + 1)
  const board = state => [...state.board].map(color => color === api.BLACK ? 'black' : color === api.WHITE ? 'white' : null)
  const setup = values => { let state = api.createGame(); for (const index of values) { const result = advance(state, index); assert.equal(result.ok, true, 'Setup move ' + index); state = result.state }; return state }
  check('Corner capture matches the independent oracle', () => { const state = setup([1, 0, 9]); assert.equal(state.board[0], api.EMPTY); assert.equal(state.captures[api.BLACK], 1); return { sequence: [1, 0, 9], captured: 1 } })
  check('Suicide rejection is atomic', () => { const state = setup(SCENARIOS.suicide.setup), before = JSON.stringify(state), result = advance(state, 20); assert.equal(result.ok, false); assert.equal(JSON.stringify(state), before); assert.equal(JSON.stringify(result.state), before); return { sequence: SCENARIOS.suicide.setup, rejected: 20 } })
  check('Simple ko rejects immediate recapture without committing it', () => { const state = setup(SCENARIOS.ko.setup), before = JSON.stringify(state), result = advance(state, 20); assert.equal(result.ok, false, 'Immediate recapture of the previous board must reject'); assert.equal(JSON.stringify(state), before); assert.equal(JSON.stringify(result.state), before); return { sequence: SCENARIOS.ko.setup, rejected: 20 } })
  check('Threat and response allow legal recapture', () => { const state = setup([...SCENARIOS.ko.setup, ...SCENARIOS.ko.threatAndReply, 20]); assert.equal(state.board[20], api.WHITE); assert.equal(state.board[21], api.EMPTY); return { sequence: [...SCENARIOS.ko.setup, ...SCENARIOS.ko.threatAndReply, 20] } })
  check('Pass resets on placement, two passes stop further placement', () => {
    let state = api.pass(api.createGame()).state; assert.equal(state.currentPlayer, api.WHITE)
    state = advance(state, 40).state; assert.equal(state.passes, 0)
    state = api.pass(api.pass(state).state).state; const before = JSON.stringify(state)
    assert.equal(advance(state, 41).ok, false); assert.equal(JSON.stringify(state), before)
  })
  check('Deterministic independent oracle comparison across 2400 move attempts', () => {
    let accepted = 0, captured = 0
    for (let seed = 1; seed <= 4; seed++) {
      let state = api.createGame(), random = seed; const oracle = createGoOracle()
      for (let attempt = 0; attempt < 600; attempt++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const index = random % 81
        const before = JSON.stringify(state), expected = oracle.play(index), actual = advance(state, index)
        assert.equal(actual.ok, expected.ok, `seed=${seed} attempt=${attempt} index=${index}`)
        if (expected.ok) { accepted++; captured += expected.captured.length; state = actual.state }
        else { assert.equal(JSON.stringify(state), before); assert.equal(JSON.stringify(actual.state), before) }
        assert.deepEqual(board(state), oracle.snapshot().board); assert.equal(state.currentPlayer === api.BLACK ? 'black' : 'white', oracle.snapshot().turn)
      }
    }
    return { attempted: 2400, accepted, captured }
  })
  return { passed: checks.every(item => item.passed), file, sha256: hash, checks, limitation: 'Read-only pure-function checks; not a substitute for visible UI or browser interoperability.' }
}

function discoverDOM(overrides = {}) {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible'
  const css = el => {
    if (el.id) return '#' + CSS.escape(el.id)
    const parts = []
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break }
      let segment = node.tagName.toLowerCase()
      const siblings = [...node.parentElement.children].filter(other => other.tagName === node.tagName)
      if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      parts.unshift(segment)
    }
    return parts.join(' > ')
  }
  const label = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim()
  const pointQueries = overrides.points ? [overrides.points] : ['[data-row][data-col]', '[data-index]', '[role="gridcell"]', '.point', 'button']
  const boards = overrides.board ? [...document.querySelectorAll(overrides.board)] : [...document.querySelectorAll('[role="grid"],#board,[data-testid="board"],[class*="board"]')]
  const candidates = []
  for (const board of boards.filter(visible)) for (const query of pointQueries) {
    const points = [...board.querySelectorAll(query)].filter(visible)
    if (points.length === 81) { candidates.push({ board, points, query }); break }
  }
  candidates.sort((a, b) => a.board.querySelectorAll('*').length - b.board.querySelectorAll('*').length)
  if (!candidates.length) return { error: 'No visible 9x9 DOM point grid discovered. Review source and supply a DOM adapter; canvas pixels are not guessed.',
    canvases: document.querySelectorAll('canvas').length, buttons: [...document.querySelectorAll('button')].filter(visible).map(el => ({ selector: css(el), label: label(el) })).slice(0, 50) }
  const { board, points, query } = candidates[0]
  let mapping = 'DOM-order', indexed
  if (points.every(el => el.dataset.row != null && el.dataset.col != null)) {
    const rows = points.map(el => Number(el.dataset.row)), cols = points.map(el => Number(el.dataset.col))
    const r0 = Math.min(...rows), c0 = Math.min(...cols)
    indexed = points.map((el, i) => ({ index: (rows[i] - r0) * 9 + cols[i] - c0, selector: css(el) })); mapping = 'data-row/col'
  } else if (points.every(el => el.dataset.index != null)) {
    const values = points.map(el => Number(el.dataset.index)), first = Math.min(...values)
    indexed = points.map((el, i) => ({ index: values[i] - first, selector: css(el) })); mapping = 'data-index'
  } else indexed = points.map((el, index) => ({ index, selector: css(el) }))
  indexed.sort((a, b) => a.index - b.index)
  if (indexed.some((point, index) => point.index !== index)) return { error: 'Point coordinates are not a unique contiguous 9x9 mapping', indexed }
  const controls = [...document.querySelectorAll('button,[role="button"],input[type="button"]')].filter(visible).map(el => ({ selector: css(el), label: label(el) }))
  const control = (name, expression) => {
    if (overrides[name]) return overrides[name]
    const found = controls.filter(item => expression.test(item.label))
    return found.length === 1 ? found[0].selector : null
  }
  return { board: css(board), points: indexed, mapping, pointQuery: query,
    restart: control('restart', /^(重新开始|重新开局|重开|重置棋盘|新对局|restart|new game)$/i),
    pass: control('pass', /^(停一手|虚着|过|跳过|弃着|让一手|pass)(\s*\(.*\))?$/i),
    undo: control('undo', /^(撤销|悔棋|撤销一手|undo)$/i), redo: control('redo', /^(重做|恢复一步|redo)$/i),
    replayEnter: control('replayEnter', /^(进入复盘|复盘|查看棋谱|review|replay)$/i),
    replayPrevious: control('replayPrevious', /^(上一步|上一手|前一步|previous)$/i), replayNext: control('replayNext', /^(下一步|下一手|next)$/i),
    replayExit: control('replayExit', /^(退出复盘|返回对局|exit review)$/i),
    importText: overrides.importText || null, importApply: control('importApply', /^(导入|导入棋谱|确认导入|import)$/i),
    turn: overrides.turn || '#turn-label,#status-turn', moves: overrides.moves || '#move-count,#status-moves',
    captures: overrides.captures || ['#capture-black', '#capture-white'],
    controls, title: document.title, status: overrides.status || '[role="status"],[aria-live],#status,#status-turn,#game-status,.status,.game-status' }
}

function readPositionDOM(adapter) {
  const color = element => {
    const nodes = [element, ...element.querySelectorAll('[data-stone],[data-color],.stone,.black,.white,[class*="stone"]')]
    for (const el of nodes) {
      for (const text of [el.dataset.stone, el.dataset.color, el.getAttribute('aria-label'), String(el.className)]) {
        if (!text) continue
        if (/(?:^|[\s_-])black(?:$|[\s_-])|黑(?:棋|子)/i.test(text)) return 'black'
        if (/(?:^|[\s_-])white(?:$|[\s_-])|白(?:棋|子)/i.test(text)) return 'white'
      }
    }
    return null
  }
  return { board: adapter.points.map(point => { const el = document.querySelector(point.selector); if (!el) throw new Error('Point disappeared: ' + point.selector); return color(el) }),
    turn: document.querySelector(adapter.turn || '#turn-label,#status-turn')?.textContent?.trim(),
    moves: document.querySelector(adapter.moves || '#move-count,#status-moves')?.textContent?.trim(),
    captures: (adapter.captures || ['#capture-black', '#capture-white']).map(selector => document.querySelector(selector)?.textContent?.trim()),
    status: [...document.querySelectorAll(adapter.status)].filter(el => el.getClientRects().length).map(el => el.textContent.trim()).join('\n'),
    passDisabled: !!document.querySelector(adapter.pass)?.matches(':disabled,[aria-disabled="true"]'),
    disabledPoints: adapter.points.filter(point => document.querySelector(point.selector)?.matches(':disabled,[aria-disabled="true"]')).length }
}

async function clickVisible(h, selector, options) {
  for (let i = 0; i < 12; i++) {
    const box = await h.readDOM(selector => {
      const matches = document.querySelectorAll(selector)
      if (matches.length !== 1) return { count: matches.length }
      const r = matches[0].getBoundingClientRect()
      return { count: 1, y: r.y, height: r.height, x: r.x, width: r.width, vh: innerHeight, vw: innerWidth }
    }, selector)
    assert.equal(box.count, 1, 'Control must be unique: ' + selector)
    assert.ok(box.x >= -1 && box.x + box.width <= box.vw + 1, 'Control overflows horizontally')
    if (box.y >= 0 && box.y + box.height <= box.vh) return h.click(selector, options)
    await h.scroll(box.y < 0 ? Math.max(-400, box.y - 60) : Math.min(400, box.y + box.height - box.vh + 60))
    await poll(() => h.readDOM(selector => document.querySelector(selector).getBoundingClientRect().y, selector), y => Math.abs(y - box.y) > .5, 'Native scrolling must move target')
  }
  throw new Error('Control remains outside viewport: ' + selector)
}

/** Iteration checks are explicit: missing controls/format evidence fail rather
 * than silently counting the baseline board as R2-R5 coverage. */
async function auditIterations({ h, adapter, check, read, play, sequence, restart, oracle, input, artifact }) {
  const requested = new Set(input.requirements || [])
  const gameFields = value => ({ board: value.board, turn: value.turn, moves: value.moves, captures: value.captures, passDisabled: value.passDisabled })
  const sameGame = (actual, expected) => assert.deepEqual(gameFields(actual), gameFields(expected))
  const disabled = selector => h.readDOM(selector => !!document.querySelector(selector)?.matches(':disabled,[aria-disabled="true"]'), selector)
  if (requested.has('R2')) {
    await check('R2: undo restores captured stones and counters; redo restores the capture', async () => {
      assert.ok(adapter.undo && adapter.redo, 'Undo/redo controls not yet implemented or reviewed')
      await restart(); await sequence([1, 0]); const before = await read(); await play(9); const after = await read()
      await clickVisible(h, adapter.undo); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(before.board), 'Undo capture'); sameGame(await read(), before)
      await clickVisible(h, adapter.redo); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(after.board), 'Redo capture'); sameGame(await read(), after)
      await clickVisible(h, adapter.undo)
      await clickVisible(h, adapter.points[40].selector)
      await poll(read, value => value.board[40] === 'black', 'Alternate black move after undo')
      assert.equal(await disabled(adapter.redo), true, 'New branch must discard redo')
      return { actions: [1, 0, 9, 'undo', 'redo', 'undo', 40], capturesBefore: before.captures, capturesAfter: after.captures }
    })
    await check('R2: undo and redo cross the second pass terminal boundary', async () => {
      assert.ok(adapter.undo && adapter.redo, 'Undo/redo controls missing')
      await restart(); await play(40); await clickVisible(h, adapter.pass); const beforeEnd = await read()
      await clickVisible(h, adapter.pass); await poll(read, value => value.passDisabled, 'Second pass ends game'); const ended = await read()
      await clickVisible(h, adapter.undo); await poll(read, value => !value.passDisabled, 'Undo must reopen game'); sameGame(await read(), beforeEnd)
      await clickVisible(h, adapter.redo); await poll(read, value => value.passDisabled, 'Redo must restore ending'); sameGame(await read(), ended)
    })
  }
  if (requested.has('R3')) {
    await check('R3: refresh restores actual board, turn, capture counts and terminal state', async () => {
      assert.equal(typeof h.reload, 'function', 'Native reload operation required')
      await restart(); await sequence([1, 0, 9, 40]); const playing = await read(); await h.reload(); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(playing.board), 'Saved game after reload'); sameGame(await read(), playing)
      await clickVisible(h, adapter.pass); await clickVisible(h, adapter.pass); await poll(read, value => value.passDisabled, 'Two passes end saved game')
      const ended = await read(); await h.reload(); await poll(read, value => value.passDisabled, 'Saved terminal state'); sameGame(await read(), ended)
    })
    await check('R3: corrupt only the reviewed storage key, report recovery and restore the saved bytes', async () => {
      assert.ok(input.storageKey && input.allowStorageFaultInjection === true && h.storage, 'Provide source-reviewed storageKey and explicit single-key fault injection capability')
      await restart(); await sequence([1, 0, 9]); const saved = await h.storage.read(input.storageKey), before = await read()
      assert.ok(saved && saved.length > 2, 'Actual game must already have saved this storage key')
      try {
        await h.storage.write(input.storageKey, '{"audit-corrupt":')
        await h.reload()
        const recovered = await poll(read, value => /损坏|恢复失败|无效|重置|corrupt|invalid|recover/i.test(value.status), 'Corrupt storage needs visible recovery feedback')
        assert.ok(recovered.board.every(value => value === null), 'Corrupt record must not leave a partially applied board')
        await clickVisible(h, adapter.points[40].selector); await poll(read, value => value.board[40] === 'black', 'Fresh game still accepts legal input after corrupt recovery')
        return { key: input.storageKey, injected: 'malformed JSON', message: recovered.status }
      } finally {
        await h.storage.write(input.storageKey, saved); await h.reload(); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(before.board), 'Restore exact pre-fault stored game')
      }
    })
  }
  if (requested.has('R4')) {
    await check('R4: invalid imports are atomic and a valid record replays only legal moves', async () => {
      const importMode = input.recordImport?.mode || 'text'
      const submit = async (text, name) => {
        if (importMode === 'text') {
          assert.ok(adapter.importText && adapter.importApply && h.fill, 'Provide reviewed text-import selectors')
          await h.fill(adapter.importText, text); await clickVisible(h, adapter.importApply)
        } else {
          assert.ok(['file-auto', 'file-confirm'].includes(importMode) && input.recordImport.selector && h.importFile, 'Provide reviewed file-import selector/mode')
          await h.importFile(input.recordImport.selector, text, name + '.json')
          if (importMode === 'file-confirm') { assert.ok(adapter.importApply); await clickVisible(h, adapter.importApply) }
        }
      }
      const fixtures = input.recordFixtures
      assert.ok(fixtures && typeof fixtures.valid === 'string' && Array.isArray(fixtures.invalid) && fixtures.invalid.length >= 3 && Array.isArray(fixtures.expectedBoard), 'Provide reviewed record schema fixtures: valid, >=3 invalid, expectedBoard')
      await restart(); await sequence([1, 0, 9, 40]); const original = await read()
      for (const [index, fixture] of fixtures.invalid.entries()) {
        const text = typeof fixture === 'string' ? fixture : fixture.text
        await submit(text, 'invalid-' + index)
        const rejected = await poll(read, value => /失败|无效|错误|不合法|不支持|invalid|failed|error/i.test(value.status), 'Invalid import must report why')
        sameGame(rejected, original)
      }
      await submit(fixtures.valid, 'valid-record')
      await poll(read, value => JSON.stringify(value.board) === JSON.stringify(fixtures.expectedBoard), 'Valid import final board')
      return { invalidCases: fixtures.invalid.map(value => typeof value === 'string' ? 'malformed record' : value.name), validExpectedStones: fixtures.expectedBoard.filter(Boolean).length }
    })
    await check('R4: replay navigation is read-only and exiting restores the live game', async () => {
      assert.ok(adapter.replayEnter && adapter.replayPrevious && adapter.replayNext && adapter.replayExit, 'Review/replay controls missing')
      await restart(); await sequence([1, 0, 9, 40]); const live = await read()
      await clickVisible(h, adapter.replayEnter); await clickVisible(h, adapter.replayPrevious)
      const previous = await poll(read, value => JSON.stringify(value.board) !== JSON.stringify(live.board), 'Previous replay frame must differ')
      await clickVisible(h, adapter.points[60].selector, { allowDisabled: true }); await delay(120); sameGame(await read(), previous)
      await clickVisible(h, adapter.replayNext); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(live.board), 'Next replay frame')
      await clickVisible(h, adapter.replayExit); sameGame(await read(), live)
      await play(60); return { reviewedFrames: 2, liveGamePreserved: true }
    })
  }
  if (requested.has('R5')) {
    await check('R5: genuine touch inputs hit corners and center once without mouse substitution', async () => {
      assert.equal(typeof h.touch, 'function', 'Real touch input capability is required; responsive mouse input is insufficient')
      const touch = (selector, options) => clickVisible({ readDOM: (fn, value) => h.readDOM(fn, value), scroll: amount => h.scroll(amount), click: (target, settings) => h.touch(target, settings) }, selector, options)
      const evidence = []
      for (const viewport of VIEWPORTS.slice(0, 2)) {
        await h.setViewport(viewport); await restart()
        for (const point of [0, 8, 72, 80, 40]) {
          assert.equal(oracle.play(point).ok, true); await touch(adapter.points[point].selector)
          await poll(read, value => JSON.stringify(value.board) === JSON.stringify(oracle.snapshot().board), 'Touch exact point ' + point)
        }
        const before = await read(); await touch(adapter.points[40].selector, { allowDisabled: true }); await delay(160); sameGame(await read(), before)
        evidence.push({ viewport: viewport.name, touchPoints: [0, 8, 72, 80, 40], noDoubleMove: true })
      }
      return evidence
    })
    await check('R5: directional keys move board focus and Space/Enter each place once', async () => {
      await h.setViewport(VIEWPORTS[3]); await restart()
      let focused
      for (let i = 0; i < 110; i++) { await h.key('Tab'); focused = await h.readDOM(adapter => adapter.points.find(point => document.querySelector(point.selector) === document.activeElement)?.index, adapter); if (focused != null) break }
      assert.ok(focused != null, 'Grid must be keyboard reachable')
      const key = focused % 9 === 8 ? 'ArrowLeft' : 'ArrowRight', next = focused + (key === 'ArrowLeft' ? -1 : 1)
      await h.key(key); await poll(() => h.readDOM(adapter => adapter.points.find(point => document.querySelector(point.selector) === document.activeElement)?.index, adapter), value => value === next, 'Arrow key moves one board intersection')
      oracle.play(next); await h.key(' '); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(oracle.snapshot().board), 'Space places focused point')
      const secondKey = next < 72 ? 'ArrowDown' : 'ArrowUp', second = next + (secondKey === 'ArrowDown' ? 9 : -9)
      await h.key(secondKey); oracle.play(second); await h.key('Enter'); await poll(read, value => JSON.stringify(value.board) === JSON.stringify(oracle.snapshot().board), 'Enter places second focused point')
      return { keys: ['Tab', key, 'Space', secondKey, 'Enter'], points: [next, second] }
    })
  }
  artifact(`go-${slug(input.label || 'project')}-iteration-coverage.json`, { requested: [...requested], mapping: adapter.mapping, requiresReviewedRecordFixtures: requested.has('R4'), singleKeyStorageFault: requested.has('R3') ? input.storageKey || null : null })
}

/** Minimal bridge for an already selected, visible, identity-bound native tab.
 * Caller selects the correct Work session/browser tab before invoking audit. */
export async function nativeHandle({ app, page, artifact = () => {}, state = {} }, input) {
  assert.ok(app && page && input.tabId && input.sessionId && input.origin, 'Supply app/page and exact tabId, sessionId, origin')
  const origin = originOf(input.origin), initial = (await page.evaluate(() => window.aether.browser.list())).find(tab => tab.tabId === input.tabId)
  assert.ok(initial, 'Existing tab missing'); assert.equal(initial.context?.sessionId, input.sessionId); assert.equal(originOf(initial.url), origin)
  const engineId = initial.context.engineId, evidenceRoot = resolve(input.output || state.evidenceRoot || '.e2e-tmp/four-role-go-audit')
  mkdirSync(evidenceRoot, { recursive: true })
  let guestId
  const locate = async () => {
    const tab = (await page.evaluate(() => window.aether.browser.list())).find(tab => tab.tabId === input.tabId)
    assert.ok(tab && tab.context?.sessionId === input.sessionId && tab.context.engineId === engineId && originOf(tab.url) === origin, 'Native tab owner/origin changed')
    const guests = await app.evaluate(({ BrowserWindow, WebContentsView }, url) => BrowserWindow.getAllWindows().flatMap(host => host.contentView.children
      .filter(view => view instanceof WebContentsView && !view.webContents.isDestroyed() && view.webContents.getURL() === url)
      .map(view => ({ id: view.webContents.id, url, bounds: view.getBounds(), visible: view.getVisible() && host.isVisible() && !host.isMinimized() }))), tab.url)
    assert.equal(guests.length, 1, 'Exact native guest must be unique'); assert.ok(guests[0].visible, 'Reveal existing guest before audit')
    if (guestId) assert.equal(guests[0].id, guestId, 'Native guest replaced during audit')
    guestId = guests[0].id
    return guests[0]
  }
  const readDOM = async (fn, argument) => app.evaluate(({ webContents }, data) => {
    const wc = webContents.fromId(data.target.id)
    if (!wc || wc.isDestroyed() || wc.getURL() !== data.target.url) throw new Error('Guest changed')
    return wc.executeJavaScript(`(${data.source})(${JSON.stringify(data.argument) ?? 'undefined'})`)
  }, { target: await locate(), source: fn.toString(), argument })
  const send = async (kind, payload) => app.evaluate(async ({ BrowserWindow, WebContentsView }, data) => {
    const pairs = BrowserWindow.getAllWindows().flatMap(host => host.contentView.children.filter(view => view instanceof WebContentsView && view.webContents.id === data.target.id).map(view => ({ host, view })))
    if (pairs.length !== 1) throw new Error('Native guest changed')
    const { host, view } = pairs[0], wc = view.webContents, bounds = view.getBounds()
    if (!view.getVisible() || !host.isVisible() || host.isMinimized() || wc.getURL() !== data.target.url) throw new Error('Guest hidden or navigated')
    host.focus(); wc.focus()
    if (data.kind === 'key') {
      const keyCode = ({ ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space' })[data.payload.key] || data.payload.key
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: data.payload.modifiers || [] }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: data.payload.modifiers || [] }); return
    }
    if (data.kind === 'text') { await wc.insertText(data.payload.text); return }
    const geometry = await wc.executeJavaScript('({width:visualViewport?.width||innerWidth,height:visualViewport?.height||innerHeight,left:visualViewport?.offsetLeft||0,top:visualViewport?.offsetTop||0})')
    const sx = bounds.width / geometry.width, sy = bounds.height / geometry.height
    if (Math.abs(sx / sy - 1) > .02) throw new Error('Inconsistent native viewport scaling')
    if (data.kind === 'scroll') { wc.sendInputEvent({ type: 'mouseWheel', x: Math.floor(bounds.width / 2), y: Math.floor(bounds.height / 2), deltaX: 0, deltaY: -data.payload.deltaY, canScroll: true }); return }
    const target = await wc.executeJavaScript(`((selector, allowDisabled) => {
      const all=document.querySelectorAll(selector); if(all.length!==1)throw Error('Nonunique target'); const el=all[0],r=el.getBoundingClientRect(),style=getComputedStyle(el);
      if(!allowDisabled&&el.matches(':disabled,[aria-disabled="true"]'))throw Error('Target disabled');
      if(style.visibility!=='visible'||Number(style.opacity)===0||r.width<=0||r.height<=0)throw Error('Target hidden');
      const x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);if(!top||!el.contains(top))throw Error('Target covered or offscreen');return{x,y};
    })(${JSON.stringify(data.payload.selector)},${data.payload.allowDisabled === true})`)
    if (data.kind === 'touch') {
      const attachedHere = !wc.debugger.isAttached()
      if (attachedHere) wc.debugger.attach('1.3')
      try {
        await wc.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] })
        await wc.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } finally { if (attachedHere && wc.debugger.isAttached()) wc.debugger.detach() }
      return { input: 'chromium-touch', x: target.x, y: target.y }
    }
    const x = Math.round((target.x - geometry.left) * sx), y = Math.round((target.y - geometry.top) * sy)
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw new Error('Native target outside viewport')
    wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }, { target: await locate(), kind, payload })
  const read = async kind => {
    const result = await page.evaluate(input => window.aether.browser.read(input.tabId, input.kind), { tabId: input.tabId, kind })
    assert.equal(result.success, true, 'Browser read ' + kind); return result.output
  }
  const telemetry = async () => {
    const entries = [], pages = []; let offset = 0
    for (let i = 0; i < 10; i++) {
      const result = await page.evaluate(input => window.aether.browser.network(input.tabId, { offset: input.offset, limit: 200 }), { tabId: input.tabId, offset })
      entries.push(...result.entries); pages.push({ ...result, entries: undefined })
      if (!result.hasMore || result.nextOffset <= offset) break; offset = result.nextOffset
    }
    return { console: await read('console'), network: { entries, pages, truncated: pages.at(-1)?.hasMore === true } }
  }
  const viewport = async value => {
    await page.evaluate(input => window.aether.browser.action({ tabId: input.tabId, action: 'zoom', zoomFactor: 1 }), { tabId: input.tabId })
    await page.evaluate(input => window.aether.browser.action({ tabId: input.tabId, action: 'viewport', viewport: input.viewport }), { tabId: input.tabId, viewport: value })
    await poll(() => readDOM(() => ({ width: innerWidth, height: innerHeight })), current => !value || Math.abs(current.width - value.width) <= 1 && Math.abs(current.height - value.height) <= 1, 'Viewport did not settle')
  }
  return { identity: { kind: 'native-electron-guest', tabId: input.tabId, sessionId: input.sessionId, origin, engineId, provenance: 'existing-tab' }, readDOM,
    click: (selector, options = {}) => send('click', { selector, ...options }), touch: (selector, options = {}) => send('touch', { selector, ...options }),
    key: (key, options = {}) => send('key', { key, ...options }), scroll: deltaY => send('scroll', { deltaY }), setViewport: viewport, telemetry,
    async fill(selector, text) { await send('click', { selector }); await send('key', { key: 'A', modifiers: ['control'] }); await send('text', { text }) },
    async importFile(selector, text, name) {
      const file = join(evidenceRoot, 'input-' + slug(name) + '.json')
      writeFileSync(file, text, 'utf8')
      return app.evaluate(async ({ webContents }, data) => {
        const wc = webContents.fromId(data.target.id)
        if (!wc || wc.isDestroyed() || wc.getURL() !== data.target.url) throw new Error('Import target navigated')
        const isFile = await wc.executeJavaScript(`document.querySelectorAll(${JSON.stringify(data.selector)}).length===1 && document.querySelector(${JSON.stringify(data.selector)}).matches('input[type="file"]')`)
        if (!isFile) throw new Error('Reviewed import target is not a unique file input')
        const attachedHere = !wc.debugger.isAttached(); if (attachedHere) wc.debugger.attach('1.3')
        try {
          const document = await wc.debugger.sendCommand('DOM.getDocument'), node = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: data.selector })
          if (!node.nodeId) throw new Error('Import file input disappeared')
          await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [data.file] })
          return { method: 'chromium-file-input', file: data.file }
        } finally { if (attachedHere && wc.debugger.isAttached()) wc.debugger.detach() }
      }, { target: await locate(), selector, file })
    },
    async reload() {
      const before = (await page.evaluate(() => window.aether.browser.list())).find(tab => tab.tabId === input.tabId)
      await page.evaluate(tabId => window.aether.browser.action({ tabId, action: 'reload' }), input.tabId)
      await poll(async () => (await page.evaluate(() => window.aether.browser.list())).find(tab => tab.tabId === input.tabId), tab => tab && tab.navigationId !== before.navigationId && !tab.loading, 'Native reload must complete')
      await poll(() => readDOM(() => document.readyState), value => value === 'complete', 'Reloaded document readiness')
    },
    storage: {
      read: key => readDOM(key => localStorage.getItem(key), key),
      async write(key, value) {
        assert.ok(input.allowStorageFaultInjection === true && key === input.storageKey, 'Single reviewed storage key fault injection must be explicitly enabled')
        return readDOM(({ key, value }) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) }, { key, value })
      },
    },
    async capture(label) { const shot = await read('screenshot'); assert.match(shot.dataUrl || '', /^data:image\/png;base64,/); const file = join(evidenceRoot, `go-${slug(input.label || input.sessionId)}-${slug(label)}.png`); writeFileSync(file, Buffer.from(shot.dataUrl.split(',')[1], 'base64')); return { imagePath: file } },
    async restore() { await viewport(initial.viewport || null); await page.evaluate(input => window.aether.browser.action({ tabId: input.tabId, action: 'zoom', zoomFactor: input.zoom }), { tabId: input.tabId, zoom: initial.zoomFactor }) },
  }
}

export async function audit(context = {}, input = {}) {
  if (input.appendRecovery) {
    const recovery = new URL('./append-mode-recovery.mjs', import.meta.url)
    recovery.searchParams.set('sha', createHash('sha256').update(readFileSync(new URL('./append-mode-recovery.mjs', import.meta.url))).digest('hex'))
    return (await import(recovery.href)).auditAppendRecovery(context, input.appendRecovery)
  }
  const { artifact = () => {}, log = () => {}, request } = context
  const checks = [], evidence = [], limitations = [], startedAt = new Date().toISOString()
  const check = async (name, run) => {
    const start = Date.now()
    try { const detail = await run(); checks.push({ name, passed: true, elapsedMs: Date.now() - start, detail }) }
    catch (error) { checks.push({ name, passed: false, elapsedMs: Date.now() - start, error: error.stack || String(error) }) }
    log('go-independent-check', checks.at(-1))
  }
  let h, adapter, beforeTelemetry
  try {
    if (request) for (const sessionId of input.sessions || [input.sessionId].filter(Boolean)) {
      const status = await request('GET', '/chat/status', undefined, { sessionId })
      assert.ok(!active.has(status?.run?.status), 'Wait for all four roles to settle before user-input audit: ' + sessionId)
    }
    h = input.handle || await nativeHandle(context, input)
    beforeTelemetry = h.telemetry ? await h.telemetry() : null
    adapter = input.adapter || await h.readDOM(discoverDOM, input.selectors || {})
    artifact(`go-${slug(input.label || 'project')}-dom-inventory.json`, adapter)
    assert.ok(!adapter.error, adapter.error); assert.equal(adapter.points.length, 81); assert.ok(adapter.restart && adapter.pass, 'Review discovered controls and provide exact restart/pass selectors')
    if (adapter.mapping === 'DOM-order') limitations.push('Point mapping uses visible DOM order; coordinate semantics require source review if source order differs from row-major board order.')
    const read = () => h.readDOM(readPositionDOM, adapter)
    const oracle = createGoOracle({ ko: input.ko || 'simple' })
    const equalBoard = async label => poll(read, value => JSON.stringify(value.board) === JSON.stringify(oracle.snapshot().board), label)
    const restart = async () => { await clickVisible(h, adapter.restart); oracle.reset(); await equalBoard('Restart must clear all 81 points') }
    const play = async index => { const result = oracle.play(index); assert.equal(result.ok, true, 'Audit fixture legal move'); await clickVisible(h, adapter.points[index].selector); return equalBoard('Rendered position must match independent oracle after ' + index) }
    const sequence = async values => { for (const index of values) await play(index) }
    const reject = async (index, reason) => {
      const before = await read(), result = oracle.play(index); assert.equal(result.ok, false); assert.equal(result.reason, reason)
      await clickVisible(h, adapter.points[index].selector, { allowDisabled: true })
      await delay(160)
      const after = await read(); assert.deepEqual(after.board, before.board, 'Rejected move may not mutate board')
      return { rejectedPoint: index, expectedReason: reason, beforeStatus: before.status, afterStatus: after.status }
    }
    await h.setViewport(VIEWPORTS[3])
    await check('9x9 restart, alternating players and occupied rejection', async () => { await restart(); await play(40); await play(41); return reject(40, 'occupied-or-invalid') })
    await check('Three legal moves capture a corner stone', async () => { await restart(); await sequence(SCENARIOS.capture.setup); await play(SCENARIOS.capture.move); assert.equal(oracle.snapshot().captured.black, 1); return oracle.snapshot() })
    await check('Suicide is rejected atomically, then the same player can legally move', async () => { await restart(); await sequence(SCENARIOS.suicide.setup); const detail = await reject(SCENARIOS.suicide.rejected, 'suicide'); await play(72); return detail })
    await check('Immediate ko is rejected; a genuine threat and reply permit recapture', async () => { await restart(); await sequence(SCENARIOS.ko.setup); const detail = await reject(SCENARIOS.ko.rejected, 'ko'); await sequence(SCENARIOS.ko.threatAndReply); await play(SCENARIOS.ko.recapture); return detail })
    await check('Pass changes turn; two consecutive passes end placement; restart reopens black', async () => {
      await restart(); oracle.pass(); await clickVisible(h, adapter.pass); await play(40)
      oracle.pass(); await clickVisible(h, adapter.pass); oracle.pass(); await clickVisible(h, adapter.pass)
      const ended = await poll(read, value => value.passDisabled || value.disabledPoints === 81 || /终局|结束|计分|数子|结算|scoring|finished|game over/i.test(value.status), 'Two passes must expose an ending/scoring state')
      await clickVisible(h, adapter.points[41].selector, { allowDisabled: true }); await delay(160)
      assert.deepEqual((await read()).board, ended.board, 'Scoring/ended board cannot accept normal moves')
      await restart(); await play(40); return { status: ended.status, passDisabled: ended.passDisabled }
    })
    await check('Keyboard can reach an enabled game point and place a stone', async () => {
      await restart(); let focused
      for (let i = 0; i < 110; i++) {
        await h.key('Tab')
        focused = await h.readDOM(adapter => {
          const el = document.activeElement, point = adapter.points.find(point => document.querySelector(point.selector) === el)
          const r = el?.getBoundingClientRect(), style = el ? getComputedStyle(el) : null
          const pseudos = el ? ['::before', '::after'].map(name => { const s = getComputedStyle(el, name); return { name, content: s.content, display: s.display, boxShadow: s.boxShadow, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle } }) : []
          return { point: point?.index, tag: el?.tagName, label: el?.getAttribute('aria-label'), visible: !!r && r.width > 0 && r.height > 0 && r.y >= 0 && r.bottom <= innerHeight,
            focusVisible: !!el?.matches(':focus-visible'), outlineWidth: style?.outlineWidth, outlineStyle: style?.outlineStyle, boxShadow: style?.boxShadow, pseudos }
        }, adapter)
        if (focused.point != null) break
      }
      assert.ok(focused?.point != null, 'No board point reachable with Tab'); assert.ok(focused.visible && focused.focusVisible, 'Keyboard focus must remain visible')
      const outlined = style => Number.parseFloat(style.outlineWidth) > 0 && !['none', 'hidden'].includes(style.outlineStyle) || style.boxShadow && style.boxShadow !== 'none'
      assert.ok(outlined(focused) || focused.pseudos.some(style => !['none', 'normal'].includes(style.content) && style.display !== 'none' && outlined(style)), 'Focused point needs a visible outline or shadow, including pseudo-element indicators')
      oracle.play(focused.point); await h.key('Enter'); await equalBoard('Enter must place the focused point'); return focused
    })
    await auditIterations({ h, adapter, check, read, play, sequence, restart, oracle, input, artifact })
    for (const viewport of VIEWPORTS) await check(`Responsive ${viewport.name}: no horizontal overflow and accurate placement`, async () => {
      await h.setViewport(viewport); await restart(); await play(10)
      const layout = await h.readDOM(selector => {
        const board = document.querySelector(selector), rect = board.getBoundingClientRect()
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, viewportMeta: document.querySelector('meta[name="viewport"]')?.content,
          board: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      }, adapter.board)
      assert.ok(layout.scrollWidth <= layout.width + 1, 'Horizontal page overflow'); assert.ok(layout.board.x >= -1 && layout.board.x + layout.board.width <= layout.width + 1, 'Board clips horizontally')
      assert.match(layout.viewportMeta || '', /width\s*=\s*device-width/)
      if (h.capture) evidence.push({ viewport: viewport.name, ...await h.capture(viewport.name) })
      return layout
    })
    await check('Browser console and network contain no observed errors', async () => {
      assert.equal(typeof h.telemetry, 'function', 'Handle must expose console/network evidence')
      const after = await h.telemetry(), entries = after.console?.entries || after.console || []
      const consoleErrors = entries.filter(entry => entry.level === 'error' || entry.type === 'error')
      const networkErrors = (after.network?.entries || []).filter(entry => entry.error || entry.failure || Number(entry.status ?? entry.statusCode) >= 400)
      artifact(`go-${slug(input.label || 'project')}-telemetry.json`, { before: beforeTelemetry, after, consoleErrors, networkErrors })
      assert.equal(after.network?.truncated, false, 'Network evidence must not silently truncate'); assert.deepEqual(consoleErrors, [], 'Observed browser errors'); assert.deepEqual(networkErrors, [], 'Observed network failures')
      return { consoleEntries: entries.length, networkEntries: after.network?.entries?.length || 0 }
    })
  } catch (error) { checks.push({ name: 'Audit setup and observed DOM contract', passed: false, error: error.stack || String(error) }) }
  finally { if (h?.restore) try { await h.restore() } catch (error) { checks.push({ name: 'Restore original viewport and zoom', passed: false, error: error.message }) } }
  const result = { startedAt, finishedAt: new Date().toISOString(), passed: checks.length >= 11 && checks.every(item => item.passed),
    identity: h?.identity, workspace: input.workspace, checks, evidence, limitations: [...limitations,
      'This audit changes the temporary game through genuine user input. Optional R3 fault testing corrupts one explicitly reviewed storage key and restores its original bytes. It does not install a fabricated valid game, validate document content, or establish full feature coverage beyond these named checks.',
      h?.identity?.kind === 'standalone-chromium' ? 'Standalone Chromium checks are not evidence of Aether native browser interoperability.' : 'Native inputs use the existing Aether guest. Screenshots still require visual review; capture alone is not a visual pass.'] }
  artifact(`go-${slug(input.label || 'project')}-audit.json`, result)
  return result
}

export function selfTest() {
  const o = createGoOracle(), play = n => assert.equal(o.play(n).ok, true)
  for (const n of SCENARIOS.capture.setup) play(n); play(SCENARIOS.capture.move); assert.equal(o.snapshot().captured.black, 1)
  o.reset(); for (const n of SCENARIOS.suicide.setup) play(n); const before = o.snapshot(); assert.equal(o.play(20).reason, 'suicide'); assert.deepEqual(o.snapshot(), before)
  o.reset(); for (const n of SCENARIOS.ko.setup) play(n); assert.equal(o.play(20).reason, 'ko'); for (const n of SCENARIOS.ko.threatAndReply) play(n); play(20)
  o.reset(); o.pass(); assert.equal(o.snapshot().turn, 'white'); play(40); assert.equal(o.snapshot().passes, 0); o.pass(); o.pass(); assert.equal(o.play(41).reason, 'ended'); o.reset(); assert.ok(o.snapshot().board.every(value => value === null))
  return { passed: true, checks: ['capture', 'suicide atomicity', 'ko and legal recapture', 'pass reset and terminal placement', 'restart'] }
}

async function cli() {
  if (process.argv.includes('--self-test')) { console.log(JSON.stringify(selfTest())); return }
  const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
  const origin = arg('--origin'), workspace = arg('--workspace')
  if (!origin || !workspace) throw new Error('Usage: node scripts/four-role-go-audit.mjs --workspace PATH --origin http://127.0.0.1:PORT [--output PATH] [--channel chrome] | --self-test')
  const url = new URL(origin)
  assert.ok(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Audit CLI requires the local generated project origin')
  const output = resolve(arg('--output') || '.e2e-tmp/four-role-go-audit'), { chromium } = await import('@playwright/test')
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, ...(arg('--channel') ? { channel: arg('--channel') } : {}) })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true }), page = await context.newPage(), consoleEntries = [], network = []
    page.on('console', message => consoleEntries.push({ level: message.type(), text: message.text() }))
    page.on('pageerror', error => consoleEntries.push({ level: 'error', text: error.message }))
    page.on('response', response => network.push({ url: response.url(), status: response.status() }))
    page.on('requestfailed', request => network.push({ url: request.url(), error: request.failure()?.errorText }))
    page.on('dialog', dialog => dialog.accept())
    await page.goto(origin, { waitUntil: 'networkidle' })
    const storageKey = arg('--storage-key')
    const handle = { identity: { kind: 'standalone-chromium', origin: url.origin }, readDOM: (fn, input) => page.evaluate(fn, input),
      click: async selector => { const box = await page.locator(selector).boundingBox(); assert.ok(box); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) },
      touch: async selector => { const box = await page.locator(selector).boundingBox(); assert.ok(box); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2) },
      fill: (selector, text) => page.locator(selector).fill(text), reload: () => page.reload({ waitUntil: 'networkidle' }),
      importFile: (selector, text, name) => page.locator(selector).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) }),
      key: key => page.keyboard.press(key), scroll: deltaY => page.mouse.wheel(0, deltaY), setViewport: value => page.setViewportSize({ width: value.width, height: value.height }),
      storage: { read: key => page.evaluate(key => localStorage.getItem(key), key), write: (key, value) => {
        assert.ok(storageKey && key === storageKey, 'Only the explicitly supplied storage key may be fault-injected')
        return page.evaluate(({ key, value }) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) }, { key, value })
      } },
      telemetry: async () => ({ console: { entries: clone(consoleEntries) }, network: { entries: clone(network), truncated: false } }),
      capture: async label => { const file = join(output, slug(label) + '.png'); await page.screenshot({ path: file }); return { imagePath: file } } }
    const result = await audit({ artifact: (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2)), log: (_, entry) => console.log(JSON.stringify({ check: entry.name, passed: entry.passed })) },
      { workspace: resolve(workspace), origin, handle, output, requirements: (arg('--requirements') || '').split(',').filter(Boolean),
        storageKey, allowStorageFaultInjection: Boolean(storageKey), selectors: arg('--selectors') ? JSON.parse(readFileSync(arg('--selectors'), 'utf8')) : undefined,
        recordFixtures: arg('--record-fixtures') ? JSON.parse(readFileSync(arg('--record-fixtures'), 'utf8')) : undefined,
        recordImport: arg('--record-import') ? JSON.parse(readFileSync(arg('--record-import'), 'utf8')) : undefined })
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, output, kind: 'standalone-chromium' })); if (!result.passed) process.exitCode = 1
  } finally { await browser.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
