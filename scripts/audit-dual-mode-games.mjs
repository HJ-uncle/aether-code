/** Independent acceptance, invoked inside the campaign's existing idle Electron.
 * Inputs go through the real Aether guest; DOM inspection never installs game state.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createNativeAudit, AUDIT_VIEWPORTS } from './dual-mode-native-audit.mjs'
import { summarizeCampaign } from './summarize-dual-mode-campaign.mjs'

async function poll(read, test, description, timeout = 8000) {
  const end = Date.now() + timeout
  let value
  do { value = await read(); if (test(value)) return value; await delay(80) } while (Date.now() < end)
  throw new Error(description + ': ' + JSON.stringify(value).slice(0, 1200))
}

/** Offscreen controls are reached by native wheel input, not element.click(). */
async function click(h, selector, options) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const box = await h.readDOM(selector => {
      const nodes = document.querySelectorAll(selector)
      if (nodes.length !== 1) return { count: nodes.length }
      const r = nodes[0].getBoundingClientRect()
      return { count: 1, x: r.x, y: r.y, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight }
    }, selector)
    assert.equal(box.count, 1, `Unique control ${selector}`)
    if (box.y >= 0 && box.y + box.height <= box.vh && box.x >= 0 && box.x + box.width <= box.vw) return h.click(selector, options)
    const amount = box.y < 0 ? Math.max(-450, box.y - 80) : Math.min(450, box.y + box.height - box.vh + 80)
    await h.scroll(amount)
    await poll(() => h.readDOM(selector => document.querySelector(selector).getBoundingClientRect().y, selector), y => Math.abs(y - box.y) > .5,
      `Native scrolling did not reach ${selector}`, 1500)
  }
  throw new Error('Control remains outside viewport: ' + selector)
}

const codePoint = (r, c) => `#board .point[data-row="${r}"][data-col="${c}"]`
const goPoint = i => `#board .point[data-index="${i}"]`
const boardState = h => h.readDOM(() => ({
  points: [...document.querySelectorAll('#board .point')].map(el => ({ row: el.dataset.row, col: el.dataset.col, index: el.dataset.index,
    stone: el.dataset.stone || (el.classList.contains('point--black') ? 'black' : el.classList.contains('point--white') ? 'white' : null),
    aria: el.getAttribute('aria-label'), tabIndex: el.tabIndex, win: el.classList.contains('is-win'),
    stones: el.querySelectorAll('.stone').length })),
  moves: document.querySelector('#status-moves')?.textContent ?? document.querySelector('#move-count')?.textContent,
  status: document.querySelector('#status-turn')?.textContent?.trim(),
  captures: [document.querySelector('#capture-black')?.textContent, document.querySelector('#capture-white')?.textContent],
  message: document.querySelector('#message')?.textContent
}))
const occupied = board => board.points.filter(point => point.stone === 'black' || point.stone === 'white')
const position = board => board.points.map(point => point.stone)

async function reload(h) { return h.reload() }

export async function audit(context) {
  const { state, artifact, log } = context
  const checks = [], coverage = new Set(), evidence = []
  const native = createNativeAudit(context)
  const check = async (name, requirements, run) => {
    try { const detail = await run(); checks.push({ name, requirements, passed: true, detail }); requirements.forEach(id => coverage.add(id)) }
    catch (error) { checks.push({ name, requirements, passed: false, error: error.stack || String(error) }) }
    log('independent-check', { name, passed: checks.at(-1).passed })
  }

  await check('Two independent durable owners and twenty individually admitted requirements', [], async () => {
    assert.notEqual(state.modes.code.sessionId, state.modes.work.sessionId)
    assert.notEqual(state.origins.code, state.origins.work)
    const ids = new Set()
    for (const mode of ['code', 'work']) {
      const submissions = state.modes[mode].submissions.filter(item => item.kind === 'requirement')
      assert.equal(submissions.length, 10)
      for (const item of submissions) {
        assert.ok(item.admittedRunId, item.id + ' needs its own admission')
        assert.ok(!ids.has(item.admittedRunId), 'Requirements may not share one completion receipt')
        ids.add(item.admittedRunId)
        assert.ok(item.terminalOutcome === 'succeeded' || item.resolution?.verified, item.id + ' is unresolved')
      }
      const sentinel = await readFile(join(state.workspaces[mode], '.campaign-sentinel.txt'), 'utf8')
      assert.match(sentinel, new RegExp(`owned project ${mode}; do not edit this isolation sentinel`))
    }
    return { separateAdmissions: ids.size, fileWriteIsolation: state.fileWriteIsolation }
  })

  // Cache-busted imports allow adapters to be reviewed as the real game evolves.
  for (const [mode, moduleName] of [['code', 'gomoku'], ['work', 'go']]) {
    await check(`${mode}: independent rule modules`, [], async () => {
      const url = new URL(`./dual-mode-${moduleName}-audit.mjs`, import.meta.url); url.search = '?audit=' + Date.now()
      const result = await (await import(url.href)).auditRules(state.workspaces[mode])
      artifact(`independent-${mode}-rules.json`, result)
      assert.equal(result.passed, true, JSON.stringify(result.checks.filter(item => !item.passed)).slice(0, 3000))
      return result
    })
  }
  await check('G03: independent AI tactics, cancellation and snapshot ownership', [], async () => {
    const url = new URL('./dual-mode-gomoku-ai-audit.mjs', import.meta.url); url.search = '?audit=' + Date.now()
    const result = await (await import(url.href)).auditAi(state.workspaces.code)
    artifact('independent-code-ai.json', result)
    assert.equal(result.passed, true, JSON.stringify(result.checks.filter(item => !item.passed)).slice(0, 3000))
    return result
  })
  await check('G04: independent timestamp and background-gap arithmetic', [], async () => {
    const url = new URL('./dual-mode-gomoku-clock-audit.mjs', import.meta.url); url.search = '?audit=' + Date.now()
    const result = await (await import(url.href)).auditClock(state.workspaces.code)
    artifact('independent-code-clock.json', result)
    assert.equal(result.passed, true, JSON.stringify(result.checks.filter(item => !item.passed)).slice(0, 3000))
    return result
  })
  await check('G05: independent versioned storage and malformed-history rejection', [], async () => {
    const url = new URL('./dual-mode-gomoku-storage-audit.mjs', import.meta.url); url.search = '?audit=' + Date.now()
    const result = await (await import(url.href)).auditStorage(state.workspaces.code)
    artifact('independent-code-storage.json', result)
    assert.equal(result.passed, true, JSON.stringify(result.checks.filter(item => !item.passed)).slice(0, 3000))
    return result
  })
  await check('G06: independent record format, legal replay and terminal boundary', [], async () => {
    const url = new URL('./dual-mode-gomoku-record-audit.mjs', import.meta.url); url.search = '?audit=' + Date.now()
    const result = await (await import(url.href)).auditRecord(state.workspaces.code)
    artifact('independent-code-record.json', result)
    assert.equal(result.passed, true, JSON.stringify(result.checks.filter(item => !item.passed)).slice(0, 3000))
    return result
  })

  try {
    const code = await native.open('code')
    await code.setViewport(AUDIT_VIEWPORTS[3])
    if (await code.readDOM(() => {
      const button = document.querySelector('#btn-resume')
      return !!button && button.getClientRects().length > 0
    })) await click(code, '#btn-resume')
    if (await code.readDOM(() => !!document.querySelector('#mode-pvp'))) await click(code, '#mode-pvp')
    if (await code.readDOM(() => !!document.querySelector('#clock-none'))) await click(code, '#clock-none')
    await check('G01: real victory, undo, redo and replacement branch', ['G01'], async () => {
      await click(code, '#btn-restart')
      await poll(() => boardState(code), value => occupied(value).length === 0, 'Restart did not clear board')
      const blacks = [[2, 2], [2, 3], [2, 4], [2, 5], [2, 6]], whites = [[14, 0], [14, 2], [14, 4], [12, 1]]
      for (let index = 0; index < blacks.length; index++) {
        await click(code, codePoint(...blacks[index]))
        await poll(() => boardState(code), value => occupied(value).length === index * 2 + 1, 'Black move not rendered')
        if (index < whites.length) {
          await click(code, codePoint(...whites[index]))
          await poll(() => boardState(code), value => occupied(value).length === index * 2 + 2, 'White move not rendered')
        }
      }
      const win = await boardState(code)
      assert.match(win.status, /黑.*胜|胜.*黑/); assert.equal(win.points.filter(point => point.win).length, 5)
      await click(code, '#btn-undo')
      await poll(() => boardState(code), value => occupied(value).length === 8 && !/胜/.test(value.status), 'Undo must reopen victory')
      await click(code, '#btn-redo')
      await poll(() => boardState(code), value => occupied(value).length === 9 && /胜/.test(value.status), 'Redo must restore victory')
      await click(code, '#btn-undo'); await click(code, codePoint(3, 6))
      await poll(() => boardState(code), value => occupied(value).length === 9 && !/胜/.test(value.status), 'Alternate move must create a new branch')
      assert.equal(await code.readDOM(() => document.querySelector('#btn-redo').disabled), true)
      return { movesToWin: 9, winningPoints: win.points.filter(point => point.win) }
    })
    await check('G02: replay is separate from the current game', ['G02'], async () => {
      const before = await boardState(code)
      await click(code, '#rv-first')
      await poll(() => boardState(code), value => occupied(value).length === 1, 'Replay first move')
      await click(code, '#rv-prev')
      await poll(() => boardState(code), value => occupied(value).length === 0, 'Replay starting position')
      await click(code, '#rv-next')
      await poll(() => boardState(code), value => occupied(value).length === 1, 'Replay next position')
      await click(code, '#rv-exit')
      const restored = await poll(() => boardState(code), value => occupied(value).length === occupied(before).length, 'Replay exit')
      assert.deepEqual(position(restored), position(before))
    })
    await check('G05: refresh restores the live position', ['G05'], async () => {
      const before = await boardState(code); await reload(code)
      if (await code.readDOM(() => {
        const button = document.querySelector('#btn-resume')
        return !!button && button.getClientRects().length > 0
      })) await click(code, '#btn-resume')
      const after = await poll(() => boardState(code), value => occupied(value).length === occupied(before).length, 'Persisted board')
      assert.deepEqual(position(after), position(before)); assert.equal(after.status, before.status)
    })
    await check('Code advanced native scenarios loaded', [], async () => {
      const url = new URL('./dual-mode-gomoku-ui-audit.mjs', import.meta.url); url.search = '?audit=' + Date.now()
      const module = await import(url.href)
      return module.auditUI({ h: code, check, click, poll, boardState, reload, artifact })
    })

    const work = await native.open('work')
    await work.setViewport(AUDIT_VIEWPORTS[3])
    await check('W02: three real clicks capture the corner stone', ['W02'], async () => {
      await click(work, '#btn-restart')
      await poll(() => boardState(work), value => occupied(value).length === 0, 'Restart Go board')
      const initial = await boardState(work), size = Math.sqrt(initial.points.length)
      assert.ok([9, 13, 19].includes(size))
      await click(work, goPoint(1)); await poll(() => boardState(work), value => occupied(value).length === 1, 'First Go move')
      await click(work, goPoint(0)); await poll(() => boardState(work), value => occupied(value).length === 2, 'White corner move')
      await click(work, goPoint(size))
      const captured = await poll(() => boardState(work), value => value.points[0].stone === null && occupied(value).length === 2, 'Corner capture')
      assert.equal(Number(captured.captures[0]), 1)
      return { boardSize: size, blackPrisoners: captured.captures[0] }
    })
    await check('W06: refresh restores a captured position', ['W06'], async () => {
      const before = await boardState(work); await reload(work)
      const after = await poll(() => boardState(work), value => occupied(value).length === occupied(before).length, 'Persisted Go board')
      assert.deepEqual(position(after), position(before)); assert.deepEqual(after.captures, before.captures)
    })
    await check('Work advanced native scenarios loaded', [], async () => {
      const url = new URL('./dual-mode-go-ui-audit.mjs', import.meta.url); url.search = '?audit=' + Date.now()
      const module = await import(url.href)
      return module.auditUI({ h: work, check, click, poll, boardState, reload, artifact })
    })

    for (const [mode, h, req] of [['code', code, 'G08'], ['work', work, 'W08']]) {
      await h.activate()
      await check(`${req}: four native viewports, no overflow and accurate board input`, [req], async () => {
        const layouts = []
        for (const viewport of AUDIT_VIEWPORTS) {
          await h.setViewport(viewport)
          const layout = await h.readDOM(() => {
            const board = document.querySelector('#board'), rect = board.getBoundingClientRect()
            return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, board: { x: rect.x, width: rect.width, height: rect.height },
              viewportMeta: document.querySelector('meta[name="viewport"]')?.content }
          })
          assert.ok(layout.scrollWidth <= layout.width + 1, 'Horizontal overflow: ' + JSON.stringify(layout))
          assert.ok(layout.board.x >= -1 && layout.board.x + layout.board.width <= layout.width + 1)
          assert.match(layout.viewportMeta || '', /width=device-width/)
          await click(h, '#btn-restart')
          await poll(() => boardState(h), value => occupied(value).length === 0, 'Responsive restart')
          const selector = mode === 'code' ? codePoint(1, 1) : goPoint(Math.sqrt((await boardState(h)).points.length) + 1)
          await click(h, selector)
          await poll(() => boardState(h), value => occupied(value).length === 1, 'Responsive exact point placement')
          const color = await h.readDOM(selector => { const el = document.querySelector(selector); return el.dataset.stone || (el.classList.contains('point--black') ? 'black' : null) }, selector)
          assert.equal(color, 'black')
          const captured = await h.capture(viewport.name); evidence.push({ mode, label: viewport.name, path: captured.imagePath })
          assert.equal(captured.newConsole.filter(item => item.level === 'error').length, 0, 'New browser console errors')
          layouts.push({ viewport: viewport.name, ...layout })
        }
        return layouts
      })
    }
  } catch (error) { checks.push({ name: 'Native browser audit setup', passed: false, error: error.stack || String(error) }) }
  finally { try { await native.restore() } catch (error) { checks.push({ name: 'Restore preview viewport', passed: false, error: error.message }) } }

  // Expanded acceptance must explicitly cover every delivered feature. A basic
  // working board must never silently stand in for clocks, imports, or practice.
  const required = ['G', 'W'].flatMap(prefix => Array.from({ length: 10 }, (_, i) => prefix + String(i + 1).padStart(2, '0')))
  const missing = required.filter(id => !coverage.has(id))
  checks.push({ name: 'All twenty feature acceptance scenarios covered', passed: missing.length === 0, missing })
  const summary = await summarizeCampaign(state.runRoot)
  artifact('independent-resource-summary.json', summary)
  return { passed: checks.every(item => item.passed), checks, evidence, coverage: [...coverage], missing,
    limitations: summary.limitations }
}
