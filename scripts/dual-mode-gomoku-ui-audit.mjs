/** Native acceptance for the inspected generated Gomoku UI, through G06.
 * The root invokes this only after both durable tasks settle. This module never
 * launches a browser, invokes window.__gomoku or installs test game state.
 * Add advanced adapters only after inspecting their generated source and DOM.
 */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const point = (row, col) => `#board .point[data-row="${row}"][data-col="${col}"]`
const occupied = board => board.points.filter(cell => cell.stone === 'black' || cell.stone === 'white')
const position = board => board.points.map(cell => cell.stone)
const reviewed = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06']
const unreviewed = {
  G07: 'The requested single Tab entry and continuous focus behavior have not been delivered; baseline buttons are still all tabbable.',
  G08: 'No explicit theme controls exist in the inspected source; root tests the four viewport baselines separately.',
  G09: 'No settings/result panel exists in the inspected source; root tests the baseline victory and highlight separately.',
  G10: 'No practice scenarios or isolation controls exist in the inspected source.'
}

// These are acceptance designs, never successful checks. They stay visible in
// the evidence until the delivered UI can be inspected and genuinely operated.
const pendingAcceptance = {
  G07: [
    'Count visible enabled board Tab stops; require exactly one. Reach it through native Tab from a real toolbar control.',
    'Move focus with arrows, then Enter and Space for at least two alternating legal moves without any intervening pointer or focus injection. Verify board cells and saved history.',
    'Attempt an occupied point through keyboard; verify no move, turn or history mutation. Read its coordinate and stone-color semantics.',
    'Tab out and Shift+Tab back, then continue moving and placing. Check the documented cursor policy after native Undo and Restart.',
    'Verify real turn and victory changes reach an existing live region. If a modal is delivered, verify initial focus, bounded Tab traversal, Escape and trigger-focus restoration.'
  ],
  G08: [
    'Reuse the four root CSS viewports; inspect scrollWidth and actual core-control bounds, including after history and settings expand.',
    'At both phone sizes, click independently chosen center, edge and corner intersections, then Undo and Restart; compare exact row, column, color and save state.',
    'Use actual light, dark and system controls; verify distinct computed colors, retained board/history and persisted preference after reload.',
    'Inspect delivered reduced-motion CSS and effective animation values when the real environment requests reduced motion. Without supported media emulation, report that runtime preference transition as unverified.',
    'Verify main touch controls have practical hit areas and no fixed panel covers an actionable board point; small intersections require an explicit precision interaction if directly unusable.'
  ],
  G09: [
    'Enter two distinct names and inspect result and save metadata. Editing rule-affecting drafts must preserve the existing board before the explicit new-game boundary.',
    'Exercise cancel and confirm paths for mode, human side and clock changes; compare history and settings before cancel and after the confirmed new game.',
    'Play four independently constructed horizontal, vertical and diagonal wins using real controls; compare highlighted coordinates exactly with the five winning stones.',
    'Toggle move numbers both ways; verify visible numbering and last-move marker while board, turn, clock and history remain unchanged.',
    'Produce readable result text through the delivered Copy control, verify both names and finish reason, and record any clipboard-permission limitation honestly.'
  ],
  G10: [
    'Read the actual exported exercise catalog. Require at least three distinct positions and independently enumerate legal immediate wins or compulsory blocking responses without trusting the catalog answer.',
    'For every delivered exercise type, enter through its real control, submit an independently incorrect legal point and a validated answer, and inspect feedback and reset behavior.',
    'Bracket practice with a real formal game and save snapshot; after return verify identical board, turn, settings, history and preserved clock semantics. Continue with a real legal formal move.',
    'Read actual run/deploy, rule, versioned-save and limitation documentation; inspect static entry references for local resource existence.',
    'Use the final native root capture for fresh console exceptions and failed core resources. Never infer deployed-browser success from a source-only check.'
  ]
}

export async function auditUI({ h, check, click, poll, boardState, reload, artifact }) {
  // reload is supplied by the root for later persistence/AI cancellation cases.
  assert.equal(typeof reload, 'function')
  const inventory = await h.readDOM(() => ({
    title: document.title,
    controlIds: [...document.querySelectorAll('button[id],select[id],input[id],textarea[id]')].map(el => el.id),
    pointCount: document.querySelectorAll('#board .point').length,
    boardTabEntries: [...document.querySelectorAll('#board,#board .point')].filter(el => el.tabIndex >= 0).length,
    liveRegions: [...document.querySelectorAll('[aria-live]')].map(el => ({ id: el.id, mode: el.getAttribute('aria-live') }))
  }))
  const scope = { reviewed, uncovered: Object.entries(unreviewed).map(([id, reason]) => ({ id, reason, plannedChecks: pendingAcceptance[id] })), inventory }
  scope.limitations = [
    'G04 background gaps are independently checked through timestamp inputs; this native handle cannot move the guest to a genuinely hidden background tab.',
    'G05 corrupt persisted bytes are tested through the public storage API. Native corrupt-storage recovery UI is unverified because this audit never injects browser storage.',
    'G06 native acceptance uses the real Copy and Paste controls. It does not open an OS file dialog or certify downloaded file bytes.'
  ]
  artifact('independent-code-ui-reviewed-scope.json', scope)

  async function exitReview() {
    const visible = await h.readDOM(() => {
      const button = document.querySelector('#rv-exit')
      return !!button && !button.hidden && button.getBoundingClientRect().width > 0
    })
    if (visible) {
      await click(h, '#rv-exit')
      await poll(() => h.readDOM(() => document.querySelector('#rv-exit').hidden), value => value, 'Exit replay restores actual game')
    }
  }

  async function prepareThreeMoves() {
    await exitReview()
    await click(h, '#btn-restart')
    await poll(() => boardState(h), value => occupied(value).length === 0, 'G02 setup restart')
    for (const [index, coordinates] of [[7, 7], [7, 8], [8, 8]].entries()) {
      await click(h, point(...coordinates))
      await poll(() => boardState(h), value => occupied(value).length === index + 1, 'G02 setup legal move')
    }
    return boardState(h)
  }

  await check('G02: enabled previous control enters replay from the live game', ['G02'], async () => {
    const before = await prepareThreeMoves()
    try {
      assert.equal(await h.readDOM(() => document.querySelector('#rv-prev').disabled), false)
      await click(h, '#rv-prev')
      const previous = await poll(() => boardState(h), value => occupied(value).length === 2, 'Enabled previous button must display the second move')
      assert.match(previous.status, /复盘/)
      await exitReview()
      const after = await boardState(h)
      assert.deepEqual(position(after), position(before)); assert.equal(after.status, before.status)
      return { liveMoves: 3, reviewMoves: 2, restoredMoves: occupied(after).length }
    } finally { await exitReview() }
  })

  await check('G02: replay first, empty and last positions preserve the live game', ['G02'], async () => {
    const before = await prepareThreeMoves()
    try {
      await click(h, '#rv-first')
      await poll(() => boardState(h), value => occupied(value).length === 1, '首手 must display the actual first move')
      const first = await h.readDOM(() => ({
        text: document.querySelector('#replay-now').textContent,
        undo: document.querySelector('#btn-undo').disabled,
        redo: document.querySelector('#btn-redo').disabled
      }))
      assert.match(first.text, /第\s*1\s*手.*黑.*H8/)
      assert.equal(first.undo, true); assert.equal(first.redo, true)
      // A real pointer attempt must not mutate either replay or the hidden live
      // board; reading a private game object would miss UI wiring defects.
      await click(h, point(0, 0), { allowDisabled: true })
      assert.equal(occupied(await boardState(h)).length, 1)
      await click(h, '#rv-prev')
      await poll(() => boardState(h), value => occupied(value).length === 0, 'Previous from first move reaches initial position')
      assert.equal(await h.readDOM(() => document.querySelector('#rv-first').disabled), false,
        'At the initial position, the first-move control must remain usable when moves exist')
      await click(h, '#rv-first')
      await poll(() => boardState(h), value => occupied(value).length === 1, 'First move can be reached again from the initial position')
      await click(h, '#rv-last')
      await poll(() => boardState(h), value => occupied(value).length === 3, 'Last move reconstructs all three moves')
      await exitReview()
      const after = await boardState(h)
      assert.deepEqual(position(after), position(before)); assert.equal(after.status, before.status)
      return { prefixCounts: [1, 0, 1, 3], attemptedReviewMove: [0, 0], livePositionUnchanged: true }
    } finally { await exitReview() }
  })

  await check('G02: direct history selection and native select keys reconstruct the exact prefix', ['G02'], async () => {
    const before = await prepareThreeMoves()
    try {
      const records = await h.readDOM(() => [...document.querySelectorAll('#replay-list .move-chip')].map(el => ({
        index: el.dataset.moveIndex, label: el.getAttribute('aria-label')
      })))
      assert.deepEqual(records.map(record => record.index), ['1', '2', '3'])
      assert.match(records[0].label, /黑.*H8/); assert.match(records[1].label, /白.*I8/); assert.match(records[2].label, /黑.*I7/)
      await click(h, '#replay-list .move-chip[data-move-index="2"]')
      const second = await poll(() => boardState(h), value => occupied(value).length === 2, 'Clicking second history row selects its prefix')
      assert.equal(second.points.find(cell => cell.row === '8' && cell.col === '8').stone, null)
      await click(h, '#rv-select')
      await h.key('Home'); await h.key('ArrowDown'); await h.key('Enter')
      await poll(() => boardState(h), value => occupied(value).length === 1, 'Native select keyboard chooses the first move')
      await exitReview()
      assert.deepEqual(position(await boardState(h)), position(before))
      return { records, selectedPrefixes: [2, 1], restoredMoves: 3 }
    } finally { await exitReview() }
  })

  await check('G03: both AI difficulties and human colors produce legal alternating moves through real controls', ['G03'], async () => {
    await exitReview()
    const results = []
    try {
      await click(h, '#mode-pve')
      for (const difficulty of ['easy', 'hard']) {
        await click(h, '#diff-' + difficulty)
        assert.equal(await h.readDOM(selector => document.querySelector(selector).getAttribute('aria-checked'), '#diff-' + difficulty), 'true')
        await click(h, '#side-black'); await click(h, '#btn-restart')
        await poll(() => boardState(h), value => occupied(value).length === 0, 'Human black starts on an empty board')
        await click(h, point(7,7))
        const reply = await poll(() => boardState(h), value => occupied(value).length === 2, 'AI white replies once', 5000)
        assert.equal(reply.points.filter(cell => cell.stone === 'white').length, 1)
        assert.equal(reply.points.find(cell => cell.row === '7' && cell.col === '7').stone, 'black')
        await click(h, '#side-white')
        const opening = await poll(() => boardState(h), value => occupied(value).length === 1, 'AI black starts a new board', 5000)
        assert.equal(occupied(opening)[0].stone, 'black')
        const free = opening.points.find(cell => cell.stone == null && cell.row === '6')
        await click(h, point(free.row, free.col))
        const continued = await poll(() => boardState(h), value => occupied(value).length === 3, 'Human white and AI black both move', 5000)
        assert.equal(continued.points.filter(cell => cell.stone === 'white').length, 1)
        assert.equal(continued.points.filter(cell => cell.stone === 'black').length, 2)
        results.push({ difficulty, humanBlackMoves: occupied(reply).length, humanWhiteMoves: occupied(continued).length })
      }
      return results
    } finally {
      await click(h, '#mode-pvp'); await click(h, '#btn-restart')
    }
  })

  await check('G03: switching to two-player mode restores independent human turns', ['G03'], async () => {
    await click(h, '#mode-pve'); await click(h, '#side-black'); await click(h, '#btn-restart')
    await click(h, point(7,7)); await click(h, '#mode-pvp')
    await poll(() => boardState(h), value => occupied(value).length === 0, 'Switching mode explicitly starts a clean board')
    for (const [index, coordinates] of [[6,6],[6,7],[8,8]].entries()) {
      await click(h, point(...coordinates))
      await poll(() => boardState(h), value => occupied(value).length === index + 1, 'No AI move may be admitted into the new human game')
    }
    const result = await boardState(h)
    assert.equal(result.points.find(cell => cell.row === '6' && cell.col === '7').stone, 'white')
    return { moves: occupied(result).length, limitation: 'Native inputs verify mode transition; the fast AI may settle before the switch, so cancellation-race coverage is established separately in the public API test.' }
  })

  const clocks = () => h.readDOM(() => ({
    black: document.querySelector('#clock-black-time')?.textContent?.trim(),
    white: document.querySelector('#clock-white-time')?.textContent?.trim(),
    active: ['black', 'white'].filter(color => document.querySelector('#clock-' + color)?.classList.contains('is-active')),
    paused: document.querySelector('#board')?.dataset.clockPaused,
    timedOut: document.querySelector('#board')?.dataset.timedOut,
    pauseLabel: document.querySelector('#btn-pause')?.textContent?.trim(),
    pauseDisabled: document.querySelector('#btn-pause')?.disabled,
    state: document.querySelector('#clock-state')?.textContent?.trim()
  }))
  const seconds = value => {
    assert.match(value, /^\d+:\d{2}(?::\d{2})?$/)
    return value.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  }
  async function observeStableClocks(expected, minimumMs = 1400) {
    const started = Date.now(), samples = []
    do {
      const value = await clocks()
      assert.equal(value.black, expected.black); assert.equal(value.white, expected.white)
      assert.equal(value.paused, 'true')
      samples.push({ at: Date.now(), black: value.black, white: value.white })
      await delay(250)
    } while (Date.now() - started < minimumMs)
    return samples
  }
  async function restoreUnlimited() {
    if (await h.readDOM(() => {
      const panel = document.querySelector('#resume-panel')
      return !!panel && !panel.hidden && panel.getBoundingClientRect().height > 0
    })) await click(h, '#btn-new-game')
    await exitReview(); await click(h, '#mode-pvp'); await click(h, '#clock-none'); await click(h, '#btn-restart')
    await poll(clocks, value => value.black === '—' && value.white === '—' && value.pauseDisabled, 'Restore unlimited game')
  }

  await check('G04: actual finite presets charge the active side, pause blocks moves, resume preserves time', ['G04'], async () => {
    await exitReview(); await click(h, '#mode-pvp')
    const results = []
    try {
      for (const [preset, initial] of [['fast', 60], ['standard', 300]]) {
        await click(h, '#clock-' + preset); await click(h, '#btn-restart')
        assert.equal(await h.readDOM(selector => document.querySelector(selector).getAttribute('aria-checked'), '#clock-' + preset), 'true')
        await poll(() => boardState(h), value => occupied(value).length === 0, 'A preset starts a fresh board')
        const first = await clocks()
        assert.deepEqual(first.active, ['black']); assert.equal(seconds(first.white), initial)
        const countingBlack = await poll(clocks, value => seconds(value.black) < seconds(first.black), 'Black time visibly decreases', 5000)
        assert.equal(seconds(countingBlack.white), initial)
        await click(h, point(7, 7))
        await poll(() => boardState(h), value => occupied(value).length === 1, 'Timed black move is admitted')
        const whiteStarts = await poll(clocks, value => value.active.length === 1 && value.active[0] === 'white', 'Clock transfers to white')
        const countingWhite = await poll(clocks, value => seconds(value.white) < seconds(whiteStarts.white), 'White time visibly decreases', 5000)
        assert.equal(countingWhite.black, whiteStarts.black)
        await click(h, '#btn-pause')
        const paused = await poll(clocks, value => value.paused === 'true' && value.pauseLabel === '继续', 'Pause reflects real clock state')
        const before = await boardState(h)
        await click(h, point(7, 8), { allowDisabled: true })
        assert.deepEqual(position(await boardState(h)), position(before), 'Paused board must reject native placement')
        const frozenSamples = await observeStableClocks(paused)
        await click(h, '#btn-pause')
        const resumed = await poll(clocks, value => value.paused === 'false' && value.pauseLabel === '暂停', 'Resume continues the same side')
        assert.deepEqual(resumed.active, ['white']); assert.equal(resumed.black, paused.black)
        const running = await poll(clocks, value => seconds(value.white) < seconds(resumed.white), 'Resumed time decreases', 5000)
        await click(h, point(7, 8))
        const moved = await poll(() => boardState(h), value => occupied(value).length === 2, 'Resume allows exactly the pending white move')
        assert.equal(moved.points.find(cell => cell.row === '7' && cell.col === '8').stone, 'white')
        results.push({ preset, initialSeconds: initial, first, countingBlack, whiteStarts, countingWhite, paused, frozenSamples, resumed, running })
      }
      return results
    } finally { await restoreUnlimited() }
  })

  for (const action of ['undo', 'redo']) await check(`G04: paused ${action} is disabled with context or performs a legal history change`, ['G04'], async () => {
    await exitReview(); await click(h, '#mode-pvp'); await click(h, '#clock-fast'); await click(h, '#btn-restart')
    try {
      for (const [index, coordinates] of [[7, 7], [7, 8], [8, 8]].entries()) {
        await click(h, point(...coordinates))
        await poll(() => boardState(h), value => occupied(value).length === index + 1, 'Prepare real history for paused affordance')
      }
      await click(h, '#btn-undo')
      await poll(() => boardState(h), value => occupied(value).length === 2, 'Prepare available undo and redo before pausing')
      await click(h, '#btn-pause')
      await poll(clocks, value => value.paused === 'true', 'Pause the history affordance fixture')
      const before = await boardState(h)
      const button = await h.readDOM(selector => {
        const element = document.querySelector(selector)
        return { disabled: element.matches(':disabled,[aria-disabled="true"]'), title: element.title,
          describedBy: element.getAttribute('aria-describedby'), clockState: document.querySelector('#clock-state').textContent }
      }, '#btn-' + action)
      artifact(`independent-code-paused-${action}-affordance.json`, { button, before, clock: await clocks(), capture: await h.capture('g04-paused-' + action) })
      if (button.disabled) {
        assert.match([button.title, button.clockState].join(' '), /暂停|继续/)
        return { policy: 'disabled with visible paused context', button }
      }
      await click(h, '#btn-' + action)
      const expected = action === 'undo' ? 1 : 3
      const after = await poll(() => boardState(h), value => occupied(value).length === expected,
        `Enabled paused ${action} must perform the offered action, not silently return`, 2500)
      assert.notDeepEqual(position(after), position(before))
      return { policy: 'enabled and acted', button, beforeMoves: 2, afterMoves: expected }
    } finally { await restoreUnlimited() }
  })

  await check('G04: a real one-minute timeout ends play and restart clears the terminal clock', ['G04'], async () => {
    await exitReview(); await click(h, '#mode-pvp'); await click(h, '#clock-fast'); await click(h, '#btn-restart')
    await click(h, point(7, 7))
    await poll(() => boardState(h), value => occupied(value).length === 1, 'Prepare an actual move before white times out')
    const whiteStarts = await poll(clocks, value => value.active.includes('white'), 'White clock starts after black move')
    const started = Date.now(), samples = []
    try {
      let ended
      do {
        const value = await clocks()
        samples.push({ at: Date.now(), ...value })
        if (value.timedOut) { ended = value; break }
        assert.deepEqual(value.active, ['white']); assert.equal(value.black, whiteStarts.black)
        if (Date.now() - started > 5000) assert.ok(seconds(value.white) < seconds(whiteStarts.white), 'The advertised running clock froze instead of beginning the real timeout')
        assert.ok(Date.now() - started <= 75_000, 'Real one-minute timer never reached timeout')
        await delay(400)
      } while (!ended)
      assert.equal(ended.timedOut, 'white'); assert.equal(ended.white, '00:00'); assert.equal(ended.black, whiteStarts.black)
      assert.equal(ended.pauseDisabled, true); assert.match(ended.state, /白.*超时.*结束/)
      const before = await boardState(h)
      assert.equal(occupied(before).length, 1); assert.match(before.status, /白.*超时.*黑.*胜/)
      await click(h, point(7, 8), { allowDisabled: true })
      assert.deepEqual(position(await boardState(h)), position(before), 'Terminal timeout must reject native placement')
      await check('G04: timeout undo is disabled with context or genuinely reopens the game', ['G04'], async () => {
        const disabled = await h.readDOM(() => document.querySelector('#btn-undo').matches(':disabled,[aria-disabled="true"]'))
        artifact('independent-code-timeout-undo-affordance.json', { disabled, before, clock: await clocks(), capture: await h.capture('g04-timeout-undo') })
        if (disabled) {
          assert.match((await clocks()).state, /超时|结束/)
          return { policy: 'disabled with visible terminal context' }
        }
        await click(h, '#btn-undo')
        const undone = await poll(() => boardState(h), value => occupied(value).length === 0 && !/超时|胜出/.test(value.status),
          'Enabled timeout undo must really reopen the game instead of silently returning', 2500)
        assert.equal((await clocks()).timedOut, '')
        return { policy: 'enabled and reopened', moves: occupied(undone).length }
      })
      await click(h, '#btn-restart')
      const restarted = await poll(clocks, value => value.timedOut === '' && value.active.includes('black') && seconds(value.black) >= 58, 'Restart resets clock and timeout')
      await click(h, point(7, 7))
      await poll(() => boardState(h), value => occupied(value).length === 1, 'Restarted game accepts a real move')
      artifact('independent-code-native-clock-timeout.json', { started, endedAt: Date.now(), samples, restarted })
      return { elapsedMs: samples.at(-1).at - started, samples: samples.length, actualTime: true, ended, restarted }
    } finally {
      artifact('independent-code-native-clock-observations.json', { started, finishedAt: Date.now(), initial: whiteStarts, samples })
      await restoreUnlimited()
    }
  })

  const persisted = () => h.readDOM(() => {
    const raw = localStorage.getItem('gomoku15:save')
    return { raw, save: raw ? JSON.parse(raw) : null,
      foreign: Object.fromEntries(Object.keys(localStorage).filter(key => !key.startsWith('gomoku15:')).sort().map(key => [key, localStorage.getItem(key)])) }
  })
  const waitResumeChoice = () => poll(() => h.readDOM(() => {
    const panel = document.querySelector('#resume-panel'), button = document.querySelector('#btn-resume')
    return { visible: !!panel && !panel.hidden && panel.getBoundingClientRect().height > 0,
      canResume: !!button && !button.hidden, message: document.querySelector('#resume-text')?.textContent }
  }), value => value.visible && value.canResume, 'Reload offers a real saved-game choice')

  await check('G05: explicit resume restores AI ownership, history and exact paused clock balances', ['G05'], async () => {
    await restoreUnlimited()
    const baseline = await persisted()
    try {
      await click(h, '#mode-pve'); await click(h, '#side-white'); await click(h, '#diff-hard'); await click(h, '#clock-standard')
      const opening = await poll(() => boardState(h), value => occupied(value).length === 1, 'AI opens the actual timed game', 6000)
      const free = opening.points.find(cell => cell.stone === null && cell.row === '6')
      await click(h, point(free.row, free.col))
      await poll(() => boardState(h), value => occupied(value).length === 3, 'A real white move and AI reply establish the saved history', 6000)
      await click(h, '#btn-pause')
      const frozen = await poll(clocks, value => value.paused === 'true', 'Save fixture is explicitly paused')
      const before = await boardState(h)
      const saved = await poll(persisted, value => value.save?.moves.length === 3 && value.save.clock?.status === 'paused', 'Auto-save must actually persist the live board')
      assert.equal(saved.save.version, 2); assert.equal(saved.save.namespace, 'gomoku15')
      assert.equal(saved.save.mode, 'pve'); assert.equal(saved.save.difficulty, 'hard'); assert.equal(saved.save.humanColor, 'white')
      assert.equal(saved.save.clock.presetId, 'standard')
      assert.deepEqual(saved.foreign, baseline.foreign)
      await reload(h)
      const choice = await waitResumeChoice()
      assert.equal((await persisted()).raw, saved.raw, 'Opening the choice must not overwrite the original saved game')
      await click(h, '#btn-resume')
      const restored = await poll(() => boardState(h), value => occupied(value).length === 3, 'Continue uses the actual saved history')
      assert.deepEqual(position(restored), position(before)); assert.equal(restored.status, before.status)
      const controls = await h.readDOM(() => Object.fromEntries(['mode-pve', 'side-white', 'diff-hard', 'clock-standard'].map(id => [id, document.getElementById(id).getAttribute('aria-checked')])))
      assert.ok(Object.values(controls).every(value => value === 'true'))
      const restoredSave = await persisted(), restoredClock = await clocks()
      assert.deepEqual(restoredSave.save.moves, saved.save.moves)
      assert.deepEqual(restoredSave.save.clock.remainingMs, saved.save.clock.remainingMs)
      assert.deepEqual(restoredSave.foreign, baseline.foreign)
      assert.equal(restoredClock.paused, 'true'); assert.equal(restoredClock.black, frozen.black); assert.equal(restoredClock.white, frozen.white)
      const pausedSamples = await observeStableClocks(restoredClock)
      const evidence = { choice, controls, before, restored, saved: saved.save, restoredSave: restoredSave.save, pausedSamples,
        foreignKeyCount: Object.keys(baseline.foreign).length, capture: await h.capture('g05-resumed-paused-clock') }
      artifact('independent-code-native-save-resume.json', evidence)
      await click(h, '#btn-pause')
      await poll(clocks, value => value.active.includes('white') && seconds(value.white) < seconds(restoredClock.white), 'Only explicit Continue resumes the restored white clock', 5000)
      return { restoredMoves: 3, controls, clockRestoresPaused: true, remainingMs: saved.save.clock.remainingMs }
    } finally { await restoreUnlimited() }
  })

  await check('G05: choosing New Game replaces only this project save and preserves foreign keys', ['G05'], async () => {
    await restoreUnlimited()
    try {
      const before = await prepareThreeMoves()
      const old = await poll(persisted, value => value.save?.moves.length === 3, 'Save the actual old game before testing explicit discard')
      assert.equal(occupied(before).length, 3)
      await reload(h); await waitResumeChoice()
      await click(h, '#btn-new-game')
      await poll(() => boardState(h), value => occupied(value).length === 0, 'New Game must actually discard the old board')
      await click(h, point(0, 0))
      const next = await poll(persisted, value => value.save?.moves.length === 1, 'New game writes its own fresh history')
      assert.deepEqual(next.save.moves, [{ row: 0, col: 0, color: 'black' }])
      assert.deepEqual(next.foreign, old.foreign)
      await reload(h); await waitResumeChoice(); await click(h, '#btn-resume')
      const restored = await poll(() => boardState(h), value => occupied(value).length === 1, 'The newly saved branch survives another refresh')
      assert.equal(occupied(restored)[0].row, '0'); assert.equal(occupied(restored)[0].col, '0')
      return { discardedMoves: 3, newMoves: next.save.moves, foreignKeyCount: Object.keys(old.foreign).length }
    } finally { await restoreUnlimited() }
  })

  const recordPanel = () => h.readDOM(() => ({
    text: document.querySelector('#import-text').value,
    message: document.querySelector('#record-status').textContent,
    state: document.querySelector('#record-status').dataset.state
  }))
  async function pasteRecord(text) {
    // The shared click wrapper scrolls with native wheels before locating the
    // input. h.fill itself only accepts a field already visible in the guest.
    await click(h, '#import-text')
    await h.fill('#import-text', text)
  }
  await check('G06: real text export and import restore the exact current game and saved history', ['G06'], async () => {
    await restoreUnlimited()
    try {
      const before = await prepareThreeMoves()
      await click(h, '#btn-copy')
      const exported = await poll(recordPanel, value => value.text.includes('gomoku15-record'), 'Copy action must expose the actual exported JSON')
      const record = JSON.parse(exported.text)
      assert.equal(record.format, 'gomoku15-record'); assert.equal(record.version, 1); assert.equal(record.size, 15)
      const expectedMoves = [{ row: 7, col: 7, color: 'black' }, { row: 7, col: 8, color: 'white' }, { row: 8, col: 8, color: 'black' }]
      assert.deepEqual(record.moves.map(({ row, col, color }) => ({ row, col, color })), expectedMoves)
      assert.equal(record.moveCount, 3)
      await click(h, '#btn-restart')
      await poll(() => boardState(h), value => occupied(value).length === 0, 'Import must replace a genuinely empty board')
      await pasteRecord(exported.text)
      await click(h, '#btn-import-text')
      const restored = await poll(() => boardState(h), value => occupied(value).length === 3, 'Pasted export rebuilds all three moves')
      assert.deepEqual(position(restored), position(before)); assert.equal(restored.status, before.status)
      const panel = await recordPanel()
      assert.equal(panel.state, 'ok'); assert.match(panel.message, /导入\s*3\s*手/)
      const saved = await poll(persisted, value => value.save?.moves.length === 3, 'Imported history must reach the actual save')
      assert.deepEqual(saved.save.moves, expectedMoves)
      artifact('independent-code-native-record-roundtrip.json', { exported: record, exportMessage: exported.message, before, restored, saved: saved.save, panel, capture: await h.capture('g06-record-roundtrip') })
      return { moves: 3, exportMessage: exported.message, importMessage: panel.message, boardAndSaveMatch: true }
    } finally { await restoreUnlimited() }
  })

  const nativeRecord = moves => ({ format: 'gomoku15-record', version: 1, size: 15, moveCount: moves.length, moves })
  const normalRecord = () => nativeRecord([{ row: 7, col: 7, color: 'black' }, { row: 7, col: 8, color: 'white' }, { row: 8, col: 8, color: 'black' }])
  const invalidRecords = [
    ['duplicate', () => { const value = normalRecord(); value.moves[2] = { row: 7, col: 7, color: 'black' }; return JSON.stringify(value) }, /重复/],
    ['out-of-bounds', () => { const value = normalRecord(); value.moves[2].col = 15; return JSON.stringify(value) }, /越界/],
    ['wrong-color', () => { const value = normalRecord(); value.moves[1].color = 'black'; return JSON.stringify(value) }, /颜色/],
    ['post-terminal', () => {
      const moves = []
      for (let index = 0; index < 5; index += 1) {
        moves.push({ row: 5, col: 5 + index, color: 'black' })
        if (index < 4) moves.push({ row: 0, col: index * 2, color: 'white' })
      }
      moves.push({ row: 14, col: 14, color: 'white' })
      return JSON.stringify(nativeRecord(moves))
    }, /终局/],
    ['malformed-json', () => '{"format":', /JSON/],
    ['unsupported-version', () => { const value = normalRecord(); value.version = 999; return JSON.stringify(value) }, /版本/]
  ]
  for (const [name, payload, reason] of invalidRecords) await check(`G06: rejected ${name} paste preserves board, save and redo branch atomically`, ['G06'], async () => {
    await restoreUnlimited()
    try {
      const complete = await prepareThreeMoves()
      await click(h, '#btn-undo')
      const before = await poll(() => boardState(h), value => occupied(value).length === 2, 'Prepare a real game with an available redo branch')
      const saved = await poll(persisted, value => value.save?.moves.length === 2, 'Wait for original game save before invalid paste')
      assert.equal(await h.readDOM(() => document.querySelector('#btn-redo').disabled), false)
      await pasteRecord(payload())
      await click(h, '#btn-import-text')
      const panel = await poll(recordPanel, value => value.state === 'error', 'Invalid record must produce an explicit error')
      assert.match(panel.message, reason); assert.match(panel.message, /当前对局未变/)
      const after = await boardState(h)
      assert.deepEqual(position(after), position(before)); assert.equal(after.status, before.status)
      assert.equal((await persisted()).raw, saved.raw, 'Invalid import must preserve actual saved bytes')
      assert.equal(await h.readDOM(() => document.querySelector('#btn-redo').disabled), false)
      artifact(`independent-code-native-record-reject-${name}.json`, { before, after, panel, originalSave: saved.save, capture: await h.capture('g06-reject-' + name) })
      await click(h, '#btn-redo')
      const redone = await poll(() => boardState(h), value => occupied(value).length === 3, 'Rejected paste must not destroy the redo branch')
      assert.deepEqual(position(redone), position(complete))
      return { rejected: name, message: panel.message, preservedMoves: 2, redoMoves: 3, saveBytesUnchanged: true }
    } finally { await restoreUnlimited() }
  })

  return scope
}
