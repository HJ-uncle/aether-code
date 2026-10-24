/** Native acceptance for the inspected W01-W04 Go UI.
 * No app/browser creation, game-state injection, project writes or direct
 * localStorage access. Root supplies the existing idle native guest handle.
 * Future features need source-reviewed adapters, not guessed selectors.
 */
import assert from 'node:assert/strict'

const point = index => `#board .point[data-index="${index}"]`
const occupied = board => board.points.filter(cell => cell.stone === 'black' || cell.stone === 'white')
const position = board => board.points.map(cell => cell.stone)
const stoneAt = (board, index) => board.points.find(cell => Number(cell.index) === index)?.stone
const readLabels = h => h.readDOM(() => ({
  title: document.querySelector('#page-title').textContent,
  subtitle: document.querySelector('#page-subtitle').textContent,
  size: document.querySelector('#size-summary').textContent,
  komi: document.querySelector('#komi-summary').textContent,
  black: document.querySelector('#label-black').textContent,
  white: document.querySelector('#label-white').textContent,
  dirty: !document.querySelector('#config-dirty').hidden
}))
const readScoring = h => h.readDOM(() => ({
  visible: !document.querySelector('#scoring-panel').hidden,
  black: document.querySelector('#score-black').textContent,
  white: document.querySelector('#score-white').textContent,
  blackDetail: document.querySelector('#score-black-detail').textContent,
  whiteDetail: document.querySelector('#score-white-detail').textContent,
  neutral: document.querySelector('#score-neutral').textContent,
  dead: document.querySelector('#score-dead').textContent,
  result: document.querySelector('#scoring-result').textContent,
  blackConfirmed: document.querySelector('#btn-confirm-black').disabled,
  whiteConfirmed: document.querySelector('#btn-confirm-white').disabled,
  passDisabled: document.querySelector('#btn-pass').disabled,
  markedPoints: [...document.querySelectorAll('#board .point--dead')].map(cell => Number(cell.dataset.index))
}))
const readReview = h => h.readDOM(() => ({
  cursor: Number(document.querySelector('#review-cursor').textContent),
  total: Number(document.querySelector('#review-total').textContent),
  undoDisabled: document.querySelector('#btn-undo').disabled,
  redoDisabled: document.querySelector('#btn-redo').disabled,
  enterDisabled: document.querySelector('#btn-review-enter').disabled,
  prevDisabled: document.querySelector('#btn-review-prev').disabled,
  nextDisabled: document.querySelector('#btn-review-next').disabled,
  exitDisabled: document.querySelector('#btn-review-exit').disabled,
  passDisabled: document.querySelector('#btn-pass').disabled,
  resignDisabled: document.querySelector('#btn-resign').disabled,
  boardReadOnly: [...document.querySelectorAll('#board .point')].every(cell => cell.disabled)
}))

export async function auditUI({ h, check, click, poll, boardState, reload, artifact }) {
  assert.equal(typeof reload, 'function')
  const scope = { reviewed: ['W01', 'W02', 'W03', 'W04'],
    uncovered: ['W05', 'W06', 'W07', 'W08', 'W09', 'W10'].map(id => ({ id,
      reason: 'Feature not yet generated and reviewed. Root covers baseline responsive layout separately; no unsupported selector or private game API is assumed.' })),
    inventory: await h.readDOM(() => ({ title: document.title,
      controls: [...document.querySelectorAll('button[id],select[id],input[id],textarea[id]')].map(el => ({ id: el.id, tag: el.tagName })),
      size: document.querySelector('#board')?.dataset.size,
      liveRegions: [...document.querySelectorAll('[aria-live]')].map(el => ({ id: el.id, mode: el.getAttribute('aria-live') }))
    })) }
  artifact('independent-work-ui-reviewed-scope.json', scope)

  async function selectSize(size) {
    const index = [9, 13, 19].indexOf(size)
    assert.ok(index >= 0)
    await click(h, '#config-size')
    await h.key('Home')
    for (let step = 0; step < index; step++) await h.key('ArrowDown')
    await h.key('Enter')
    await poll(() => h.readDOM(() => document.querySelector('#config-size').value), value => value === String(size), 'Native board-size selection')
  }
  async function fill(selector, value) {
    await click(h, selector)
    await h.fill(selector, value)
    await poll(() => h.readDOM(selector => document.querySelector(selector).value, selector), current => current === value, 'Native field input ' + selector)
  }
  async function newGame(size = 9, komi = '7.5') {
    await selectSize(size)
    await fill('#config-komi', komi)
    await fill('#config-black-name', '黑方验收')
    await fill('#config-white-name', '白方验收')
    await click(h, '#btn-apply-config')
    return poll(() => boardState(h), value => value.points.length === size * size && occupied(value).length === 0 && /黑方验收/.test(value.status), 'Explicit configured new game')
  }
  async function legalMoves(moves, expectedCounts = moves.map((_, index) => index + 1)) {
    for (const [index, coordinate] of moves.entries()) {
      await click(h, point(coordinate))
      await poll(() => boardState(h), value => occupied(value).length === expectedCounts[index], `Native legal move ${index + 1} at ${coordinate}`)
    }
    return boardState(h)
  }
  const assertSameGame = (actual, before) => {
    assert.deepEqual(position(actual), position(before)); assert.deepEqual(actual.captures, before.captures)
    assert.equal(actual.status, before.status); assert.equal(actual.moves, before.moves)
  }
  async function enterScoring() {
    await click(h, '#btn-pass'); await click(h, '#btn-pass')
    await poll(() => boardState(h), value => /计分确认中/.test(value.status), 'Two passes enter score review')
    return poll(() => readScoring(h), value => value.visible && /尚未锁定/.test(value.result), 'Provisional scores have not announced a winner')
  }
  async function confirmScoring() {
    await click(h, '#btn-confirm-black'); await click(h, '#btn-confirm-white')
    await poll(() => readScoring(h), value => /结果已锁定/.test(value.result), 'Both players explicitly confirm the score')
    return poll(() => boardState(h), value => /已确认/.test(value.status), 'Confirmed score is final')
  }

  await check('W01: drafted configuration cannot mutate the current position before explicit new game', ['W01'], async () => {
    await newGame(9, '6.5'); await legalMoves([40])
    const before = await boardState(h), labelsBefore = await readLabels(h)
    await selectSize(13); await fill('#config-komi', '7.5')
    await fill('#config-black-name', '甲队'); await fill('#config-white-name', '乙队')
    assertSameGame(await boardState(h), before)
    const pending = await readLabels(h)
    assert.equal(pending.size, labelsBefore.size); assert.equal(pending.komi, labelsBefore.komi)
    assert.equal(pending.subtitle, labelsBefore.subtitle); assert.equal(pending.dirty, true)
    await click(h, '#btn-apply-config')
    const applied = await poll(() => boardState(h), value => value.points.length === 169 && occupied(value).length === 0, 'Explicit new game applies drafted size')
    const labels = await readLabels(h)
    assert.match(applied.status, /甲队.*黑棋/); assert.match(labels.komi, /7\.5/)
    assert.match(labels.subtitle, /甲队.*乙队.*中国数子法/)
    assert.match(labels.black, /甲队/); assert.match(labels.white, /乙队/); assert.equal(labels.dirty, false)
    return { beforeSize: 9, appliedSize: 13, originalMovesPreservedUntilApply: 1, labels }
  })

  await check('W01: all three sizes expose exact corners, coordinate labels and alternating stones', ['W01'], async () => {
    const evidence = []
    for (const size of [9, 13, 19]) {
      await newGame(size)
      const indices = [0, size - 1, size * (size - 1), size * size - 1]
      const after = await legalMoves(indices)
      assert.equal(after.points.length, size * size)
      for (const [ordinal, index] of indices.entries()) {
        const cell = after.points.find(value => Number(value.index) === index)
        const row = Math.floor(index / size), col = index % size
        assert.equal(Number(cell.row), row); assert.equal(Number(cell.col), col)
        assert.equal(cell.stone, ordinal % 2 ? 'white' : 'black')
        assert.match(cell.aria, new RegExp(`第 ${row + 1} 行 第 ${col + 1} 列.*${ordinal % 2 ? '白棋' : '黑棋'}`))
      }
      await click(h, '#btn-restart')
      const restarted = await poll(() => boardState(h), value => occupied(value).length === 0, 'Configured restart clears only the game')
      assert.equal(restarted.points.length, size * size)
      const labels = await readLabels(h); assert.match(labels.komi, /7\.5/); assert.match(labels.subtitle, /黑方验收.*白方验收/)
      evidence.push({ size, points: after.points.length, indices })
    }
    return evidence
  })

  await check('W01/W03: white receives configured komi only after both players confirm, then can restart', ['W01', 'W03'], async () => {
    await newGame(9)
    await click(h, '#btn-pass')
    await poll(() => boardState(h), value => /白方验收.*落子/.test(value.status), 'One pass changes the current player')
    await click(h, '#btn-pass')
    const provisional = await poll(() => readScoring(h), value => value.visible && /尚未锁定/.test(value.result), 'Two passes enter provisional score review')
    assert.equal(Number(provisional.black), 0); assert.equal(Number(provisional.white), 7.5); assert.equal(provisional.passDisabled, true)
    await click(h, '#btn-confirm-black')
    const partial = await poll(() => readScoring(h), value => value.blackConfirmed, 'Black confirmation is visible')
    assert.equal(partial.whiteConfirmed, false); assert.match(partial.result, /尚未锁定/)
    await click(h, '#btn-confirm-white')
    const ended = await poll(() => boardState(h), value => /已确认/.test(value.status), 'Both confirmations finish the game')
    assert.match(ended.status, /白方验收.*胜/)
    assert.match(ended.message, /中国数子法 黑 0\s*:\s*白 7\.5/)
    assert.match(ended.message, /白=0\s*\+\s*贴目 7\.5/)
    await click(h, point(40), { allowDisabled: true })
    assertSameGame(await boardState(h), ended)
    await click(h, '#btn-restart')
    await poll(() => boardState(h), value => occupied(value).length === 0 && /黑方验收.*落子/.test(value.status), 'Restart clears finished status')
    await legalMoves([40]); assert.equal(stoneAt(await boardState(h), 40), 'black')
    return { emptyBlackArea: 0, emptyWhiteArea: 0, komi: 7.5, winner: '白方验收', restartAcceptsBlackMove: true }
  })

  await check('W01/W03: legal small and large corner enclosures count all edge territory', ['W01', 'W03'], async () => {
    const evidence = []
    for (const fixture of [
      { moves: [2, 79, 11, 80, 18, 70, 19, 71, 20], blackStones: 5, blackTerritory: 4, whiteStones: 4 },
      { moves: [3, 80, 12, 79, 21, 78, 27, 77, 28, 76, 29, 75, 30], blackStones: 7, blackTerritory: 9, whiteStones: 6 }
    ]) {
      await newGame(9); await legalMoves(fixture.moves)
      const provisional = await enterScoring()
      assert.equal(Number(provisional.black), fixture.blackStones + fixture.blackTerritory,
        `${fixture.blackTerritory} corner empties are enclosed by black stones and board edges`)
      assert.equal(Number(provisional.white), fixture.whiteStones + 7.5)
      const ended = await confirmScoring()
      evidence.push({ ...fixture, komi: 7.5, message: ended.message })
    }
    return evidence
  })

  await check('W02: one real move captures two separate enemy blocks', ['W02'], async () => {
    await newGame(9)
    const moves = [2, 11, 10, 19, 12, 80, 18, 78, 28, 76, 20]
    const result = await legalMoves(moves, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9])
    assert.equal(stoneAt(result, 11), null); assert.equal(stoneAt(result, 19), null)
    assert.equal(stoneAt(result, 20), 'black'); assert.equal(Number(result.captures[0]), 2)
    assert.match(result.message, /提掉对方 2 子/)
    return { moves, capturedPoints: [11, 19], blackPrisoners: 2 }
  })

  await check('W02: native suicide and duplicate attempts preserve board, turn and captures', ['W02'], async () => {
    await newGame(9)
    const moves = [80, 11, 78, 19, 76, 21, 74, 29]
    const before = await legalMoves(moves)
    await click(h, point(20), { allowDisabled: true })
    const rejected = await poll(() => boardState(h), value => /自杀/.test(value.message), 'Suicide has actionable visible feedback')
    assertSameGame(rejected, before)
    await click(h, point(80), { allowDisabled: true })
    const duplicate = await poll(() => boardState(h), value => /已有棋子/.test(value.message), 'Duplicate point has visible feedback')
    assertSameGame(duplicate, before)
    return { moves, rejectedSuicide: 20, rejectedDuplicate: 80, preservedMoves: occupied(before).length }
  })

  await check('W02: native ko rejects immediate recapture then permits a real threat and reply', ['W02'], async () => {
    await newGame(9)
    const moves = [11, 20, 19, 12, 29, 30, 72, 22, 21]
    const captured = await legalMoves(moves, [1, 2, 3, 4, 5, 6, 7, 8, 8])
    assert.equal(stoneAt(captured, 20), null); assert.equal(Number(captured.captures[0]), 1)
    await click(h, point(20), { allowDisabled: true })
    const rejected = await poll(() => boardState(h), value => /劫|重复/.test(value.message), 'Immediate recapture receives a visible ko explanation')
    assertSameGame(rejected, captured)
    await legalMoves([80, 78, 20], [9, 10, 10])
    const recaptured = await boardState(h)
    assert.equal(stoneAt(recaptured, 20), 'white'); assert.equal(stoneAt(recaptured, 21), null)
    assert.equal(Number(recaptured.captures[1]), 1)
    return { moves, immediateRecaptureRejected: 20, threatAndReply: [80, 78], legalRecapture: 20 }
  })

  await check('W02: native undo restores captured stones and pass state without ghost superko', ['W02'], async () => {
    await newGame(9)
    const beforeCapture = await legalMoves([1, 0])
    await legalMoves([9], [2])
    assert.equal(Number((await boardState(h)).captures[0]), 1)
    await click(h, '#btn-undo')
    const undone = await poll(() => boardState(h), value => stoneAt(value, 0) === 'white' && stoneAt(value, 9) === null,
      'Undo restores the captured white stone and removes black capture')
    assertSameGame(undone, beforeCapture)
    await legalMoves([9], [2])
    const capturedAgain = await boardState(h)
    assert.equal(Number(capturedAgain.captures[0]), 1)
    await click(h, '#btn-pass')
    const firstPass = await poll(() => boardState(h), value => /黑方验收.*落子/.test(value.status), 'White pass changes current player')
    await click(h, '#btn-pass')
    await poll(() => boardState(h), value => /计分确认中/.test(value.status), 'Second pass enters scoring')
    await click(h, '#btn-undo')
    const liveAgain = await poll(() => boardState(h), value => /黑方验收.*落子/.test(value.status), 'Undo final pass restores a live black turn')
    assertSameGame(liveAgain, firstPass)
    await click(h, '#btn-undo')
    const beforePasses = await poll(() => boardState(h), value => /白方验收.*落子/.test(value.status), 'Undo first pass restores the white turn')
    assertSameGame(beforePasses, capturedAgain)
    assert.equal(await h.readDOM(() => document.querySelector('#move-stack').textContent), '3')
    return { capture: [1, 0, 9], restoredCaptureAndTurn: true, replayedCaptureAccepted: true, restoredPasses: 2 }
  })

  await check('W03: native dead-stone review changes scores, invalidates consent and preserves the legal game', ['W03'], async () => {
    await newGame(9)
    const moves = [2, 0, 11, 80, 18, 79, 19, 71, 20]
    const original = await legalMoves(moves)
    const provisional = await enterScoring()
    assert.equal(Number(provisional.black), 5); assert.equal(Number(provisional.white), 11.5)
    await click(h, '#btn-confirm-black')
    await poll(() => readScoring(h), value => value.blackConfirmed && !value.whiteConfirmed, 'One player has confirmed the original score')
    await click(h, point(0))
    const marked = await poll(() => readScoring(h), value => value.markedPoints.includes(0), 'Native stone click marks a dead stone')
    assert.equal(marked.blackConfirmed, false); assert.equal(marked.whiteConfirmed, false)
    assert.equal(Number(marked.black), 9); assert.equal(Number(marked.white), 10.5)
    assert.match(marked.blackDetail, /^5\s*\+\s*4$/); assert.match(marked.whiteDetail, /^3\s*\+\s*0\s*\+\s*7\.5$/)
    assert.match(marked.dead, /^1.*黑 0.*白 1/)
    assert.deepEqual(position(await boardState(h)), position(original))
    await click(h, point(0))
    const unmarked = await poll(() => readScoring(h), value => value.markedPoints.length === 0, 'Second stone click reverses dead marking')
    assert.equal(unmarked.black, provisional.black); assert.equal(unmarked.white, provisional.white)
    await click(h, point(0)); await click(h, '#btn-confirm-white'); await click(h, '#btn-clear-dead')
    const cleared = await poll(() => readScoring(h), value => value.markedPoints.length === 0 && !value.whiteConfirmed, 'Clear marks also invalidates earlier consent')
    assert.equal(cleared.black, provisional.black); assert.equal(cleared.white, provisional.white)
    await click(h, point(0)); await click(h, '#btn-resume')
    const resumed = await poll(() => boardState(h), value => /白方验收.*落子/.test(value.status), 'Resume returns to the original white turn')
    assert.deepEqual(position(resumed), position(original)); assert.deepEqual(resumed.captures, original.captures)
    const hidden = await readScoring(h); assert.equal(hidden.visible, false); assert.equal(hidden.markedPoints.length, 0)
    await legalMoves([40], [10]); assert.equal(stoneAt(await boardState(h), 40), 'white')
    return { moves, manualDeadPoint: 0, blackAreaAfterAgreement: 9, whiteAfterKomi: 10.5, priorConsentInvalidated: true, originalPositionPreserved: true }
  })

  await check('W03: resignation identifies its reason and never displays an invented area result', ['W03'], async () => {
    for (const whiteToPlay of [false, true]) {
      await newGame(9)
      if (whiteToPlay) await legalMoves([40])
      const original = await boardState(h)
      await click(h, '#btn-resign')
      const ended = await poll(() => boardState(h), value => /对方认输/.test(value.status), 'Resignation ends the current player’s game')
      assert.match(ended.status, new RegExp(`${whiteToPlay ? '黑方验收' : '白方验收'}.*胜`))
      assert.match(ended.message, /认输不计子/); assert.equal((await readScoring(h)).visible, false)
      await click(h, point(41), { allowDisabled: true })
      assert.deepEqual(position(await boardState(h)), position(original))
    }
    return { blackAndWhiteResignationVerified: true, areaScoreHidden: true }
  })

  await check('W04: native continuous undo and redo restore captures and both passes', ['W04'], async () => {
    await newGame(9)
    const states = [await boardState(h)], actions = [1, 0, 9, 'pass', 40, 'pass', 'pass']
    const counts = [1, 2, 2, 2, 3, 3, 3]
    for (const [index, action] of actions.entries()) {
      if (action === 'pass') await click(h, '#btn-pass')
      else await legalMoves([action], [counts[index]])
      await poll(() => h.readDOM(() => document.querySelector('#move-stack').textContent), value => Number(value) === index + 1, 'Native action is recorded')
      states.push(await boardState(h))
    }
    for (let index = actions.length - 1; index >= 0; index--) {
      await click(h, '#btn-undo')
      await poll(() => h.readDOM(() => document.querySelector('#move-stack').textContent), value => Number(value) === index, 'Native undo removes exactly one action')
      assertSameGame(await boardState(h), states[index])
    }
    assert.equal((await readReview(h)).redoDisabled, false)
    for (let index = 1; index <= actions.length; index++) {
      await click(h, '#btn-redo')
      await poll(() => h.readDOM(() => document.querySelector('#move-stack').textContent), value => Number(value) === index, 'Native redo restores exactly one action')
      assertSameGame(await boardState(h), states[index])
      assert.equal((await readReview(h)).redoDisabled, index === actions.length)
    }
    return { actions, nativeCheckpointsRestored: actions.length, blackPrisoners: Number(states.at(-1).captures[0]) }
  })

  await check('W04: rejected placement preserves redo, and a new branch discards it', ['W04'], async () => {
    await newGame(9); await legalMoves([1, 0, 9, 40], [1, 2, 2, 3])
    await click(h, '#btn-undo'); await click(h, '#btn-undo')
    const before = await poll(() => boardState(h), value => stoneAt(value, 0) === 'white' && stoneAt(value, 9) === null, 'Two undos return before the capture')
    assert.equal((await readReview(h)).redoDisabled, false)
    await click(h, point(1)); assertSameGame(await boardState(h), before)
    assert.equal((await readReview(h)).redoDisabled, false)
    await legalMoves([10], [3]); assert.equal((await readReview(h)).redoDisabled, true)
    return { rejectedOccupied: 1, alternativeBranch: 10, oldRedoDiscarded: true }
  })

  await check('W04: native review reconstructs captures and cannot mutate the official position', ['W04'], async () => {
    await newGame(9)
    const second = await legalMoves([1, 0]); const third = await legalMoves([9], [2])
    const official = await legalMoves([40], [3])
    await click(h, '#btn-review-enter')
    await poll(() => boardState(h), value => /复盘视图/.test(value.status), 'Review is visibly separate from the official game')
    const reviewing = await readReview(h)
    assert.equal(reviewing.total, 4); assert.equal(reviewing.cursor, 4); assert.equal(reviewing.boardReadOnly, true)
    assert.equal(reviewing.undoDisabled, true); assert.equal(reviewing.redoDisabled, true)
    assert.equal(reviewing.passDisabled, true); assert.equal(reviewing.resignDisabled, true)
    const jump = async count => {
      await fill('#review-jump-input', String(count)); await click(h, '#btn-review-jump')
      await poll(() => readReview(h), value => value.cursor === count, 'Jump reaches the requested historical move')
      return boardState(h)
    }
    const early = await jump(2)
    assert.deepEqual(position(early), position(second)); assert.deepEqual(early.captures, second.captures); assert.equal(early.moves, second.moves)
    await click(h, '#btn-review-next')
    await poll(() => readReview(h), value => value.cursor === 3, 'Next advances one historical move')
    const capture = await boardState(h)
    assert.deepEqual(position(capture), position(third)); assert.deepEqual(capture.captures, third.captures); assert.equal(capture.moves, third.moves)
    await click(h, '#btn-review-prev'); await poll(() => readReview(h), value => value.cursor === 2, 'Previous restores the captured white stone')
    assert.equal(stoneAt(await boardState(h), 0), 'white')
    const empty = await jump(0); assert.equal(occupied(empty).length, 0); assert.equal((await readReview(h)).prevDisabled, true)
    await click(h, point(41), { allowDisabled: true }); await click(h, '#btn-pass', { allowDisabled: true }); await click(h, '#btn-undo', { allowDisabled: true })
    assert.equal(occupied(await boardState(h)).length, 0)
    await click(h, '#btn-review-exit')
    const restored = await poll(() => boardState(h), value => /落子/.test(value.status), 'Exit returns to the official game')
    assertSameGame(restored, official); assert.equal((await readReview(h)).total, 4)
    await legalMoves([41], [4]); assert.equal(stoneAt(await boardState(h), 41), 'black')
    return { reviewedMoves: [4, 2, 3, 2, 0], officialMoveCountPreserved: 4, originalCaptureCountRestored: 1 }
  })

  // Restore a conventional 9x9, empty, live game for root's subsequent layout
  // scenarios by ordinary controls; do not restore by mutating model globals.
  await check('Work native audit resets its own test position', [], async () => {
    const result = await newGame(9)
    return { size: 9, stones: occupied(result).length }
  })
  return scope
}
