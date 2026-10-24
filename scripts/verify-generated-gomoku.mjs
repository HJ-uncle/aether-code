/** Independent UI acceptance for a generated Gomoku workspace.
 * Usage: node scripts/verify-generated-gomoku.mjs <workspace> [--output <directory>]
 * Run serially, after the producing Work window has closed. This does not use
 * generated tests or access the game's debug API/state; all moves are real input.
 */
import { _electron as electron, expect as playwrightExpect } from '@playwright/test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('--')) {
  throw new Error('Usage: node scripts/verify-generated-gomoku.mjs <workspace> [--output <directory>]')
}
const workspace = path.resolve(args[0])
const gameDirectory = fs.existsSync(path.join(workspace, 'game', 'index.html')) ? path.join(workspace, 'game') : workspace
const entry = path.join(gameDirectory, 'index.html')
if (!fs.statSync(entry).isFile()) throw new Error(`Game entry is not a file: ${entry}`)
const outputIndex = args.indexOf('--output')
if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output requires a directory')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const output = outputIndex >= 0 ? path.resolve(args[outputIndex + 1])
  : path.join(path.dirname(workspace), `${path.basename(workspace)}-verification-${runId}`)
fs.mkdirSync(output, { recursive: true })
const temporary = fs.mkdtempSync(path.join(output, 'electron-harness-'))
const mainFile = path.join(temporary, 'main.cjs')
fs.mkdirSync(path.join(temporary, 'profile'), { recursive: true })
fs.writeFileSync(mainFile, `
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', process.env.GOMOKU_VERIFIER_USER_DATA);
let gameWindow;
globalThis.__gomokuVerifierLoad = app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = new BrowserWindow({ width: 1000, height: 1000, show: false, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  gameWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('render-process-gone', (_event, details) => console.error('render-process-gone', JSON.stringify(details)));
  await window.loadFile(process.env.GOMOKU_VERIFIER_ENTRY);
});
globalThis.__gomokuVerifierLoad.catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
`, 'utf8')

const expect = playwrightExpect.configure({ timeout: 4000 })
const report = {
  schemaVersion: 1, runId, startedAt: new Date().toISOString(), workspace, gameDirectory, entry, output,
  method: 'Actual Electron renderer; only pointer, focus and keyboard input; no generated tests or game-state injection.',
  selectors: { point: '#board .point[data-row][data-col]', stone: '[data-stone]', winning: '[data-win="1"]',
    status: '#status-heading', moveCount: '#moveCount', undo: '#undoBtn', restart: '#restartBtn' },
  sourceBefore: [], sourceAfter: [], checks: [], pageErrors: [], consoleErrors: [], mainErrors: [], screenshots: []
}
function sourceManifest() {
  return fs.readdirSync(gameDirectory, { withFileTypes: true })
    .filter(item => item.isFile() && /\.(?:html|js|css)$/i.test(item.name) && !/^tests?\./i.test(item.name))
    .map(item => {
      const file = path.join(gameDirectory, item.name)
      const data = fs.readFileSync(file)
      return { file: item.name, bytes: data.byteLength, sha256: crypto.createHash('sha256').update(data).digest('hex') }
    }).sort((a, b) => a.file.localeCompare(b.file))
}
report.sourceBefore = sourceManifest()
let application
let page
let screenshotIndex = 0

async function screenshot(label) {
  const name = `${String(++screenshotIndex).padStart(2, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}.png`
  const file = path.join(output, name)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push({ label, path: file })
  return file
}
const point = (row, col) => page.locator(`#board .point[data-row="${row}"][data-col="${col}"]`)
async function snapshot() {
  return page.evaluate(() => ({
    heading: document.querySelector('#status-heading')?.textContent,
    moveCount: document.querySelector('#moveCount')?.textContent,
    blackCount: document.querySelector('#blackCount')?.textContent,
    whiteCount: document.querySelector('#whiteCount')?.textContent,
    turn: document.querySelector('#turnStone')?.getAttribute('data-color'),
    stones: [...document.querySelectorAll('#board .point[data-stone]')].map(element => ({
      row: element.getAttribute('data-row'), col: element.getAttribute('data-col'),
      color: element.getAttribute('data-stone'), winning: element.getAttribute('data-win') === '1'
    }))
  }))
}
async function freshGame() {
  await page.reload({ waitUntil: 'load' })
  await expect(page.locator('#board .point')).toHaveCount(225)
  await expect(page.locator('#moveCount')).toHaveText('0')
  await expect(page.locator('#status-heading')).toHaveText('轮到黑棋落子')
}
async function counts(total) {
  await expect(page.locator('#moveCount')).toHaveText(String(total))
  await expect(page.locator('#blackCount')).toHaveText(String(Math.ceil(total / 2)))
  await expect(page.locator('#whiteCount')).toHaveText(String(Math.floor(total / 2)))
  await expect(page.locator('#board .point[data-stone]')).toHaveCount(total)
  await expect(page.locator('#board .point .stone:not([hidden])')).toHaveCount(total)
  const duplicateCells = await page.locator('#board .point').evaluateAll(cells => cells.filter(cell => cell.querySelectorAll('.stone').length > 1).length)
  assert.equal(duplicateCells, 0, 'A cell may retain one hidden stone slot, but must never accumulate duplicate nodes')
  const malformed = await page.locator('#board .point .stone:not([hidden])').evaluateAll(stones => stones.flatMap(stone => {
    const bounds = stone.getBoundingClientRect()
    const cell = stone.parentElement.getBoundingClientRect()
    return Math.abs(bounds.width - bounds.height) > 1 ||
      Math.abs(bounds.x + bounds.width / 2 - cell.x - cell.width / 2) > 1 ||
      Math.abs(bounds.y + bounds.height / 2 - cell.y - cell.height / 2) > 1
      ? [{ width: bounds.width, height: bounds.height, row: stone.parentElement.dataset.row, col: stone.parentElement.dataset.col }] : []
  }))
  assert.deepEqual(malformed, [], 'Each placed stone must remain a single centered circle after every render')
}
async function play(row, col, color, total, winning = false) {
  await expect(point(row, col)).toBeEnabled()
  await point(row, col).click()
  await expect(point(row, col)).toHaveAttribute('data-stone', color)
  await expect(point(row, col).locator(`.stone.${color}`)).toHaveCount(1)
  await counts(total)
  if (!winning) {
    await expect(page.locator('#turnStone')).toHaveAttribute('data-color', color === 'black' ? 'white' : 'black')
    await expect(page.locator('#statusBadge')).toBeHidden()
    await expect(page.locator('#board')).not.toHaveClass(/is-locked/)
  }
}
async function pointerAttempt(row, col) {
  const bounds = await point(row, col).boundingBox()
  assert(bounds, `Intersection ${row},${col} must have pointer geometry`)
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
}
async function check(name, execute) {
  const start = performance.now()
  try {
    const evidence = await execute()
    report.checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - start), evidence })
    console.log(`PASS ${name}`)
  } catch (error) {
    let image
    try { image = await screenshot(`failure-${name}`) } catch { /* Preserve the original failed assertion. */ }
    report.checks.push({ name, status: 'failed', durationMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : String(error), screenshot: image })
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  application = await electron.launch({
    args: [mainFile], cwd: projectRoot, timeout: 30000,
    env: { ...process.env, GOMOKU_VERIFIER_ENTRY: entry, GOMOKU_VERIFIER_USER_DATA: path.join(temporary, 'profile') }
  })
  application.process().stderr?.on('data', data => {
    const text = data.toString('utf8')
    if (/render-process-gone|Uncaught|Error:/.test(text)) report.mainErrors.push(text.slice(0, 4000))
  })
  page = await application.firstWindow()
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => report.pageErrors.push({ message: error.message, stack: error.stack }))
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
  page.on('dialog', async dialog => {
    report.consoleErrors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`)
    await dialog.dismiss()
  })
  // A URL/load-state observation can still describe a navigation being committed.
  // Wait for main's actual loadFile promise before any reload can interrupt it.
  await application.evaluate(async () => { await globalThis.__gomokuVerifierLoad; return true })
  await page.waitForURL(pathToFileURL(entry).href, { waitUntil: 'load', timeout: 15000 })

  await check('board-225-and-initial-state', async () => {
    await freshGame()
    const coordinates = await page.locator('#board .point').evaluateAll(elements => elements.map(element => ({
      row: Number(element.getAttribute('data-row')), col: Number(element.getAttribute('data-col')),
      label: element.getAttribute('aria-label'), type: element.getAttribute('type')
    })))
    assert.equal(new Set(coordinates.map(({ row, col }) => `${row},${col}`)).size, 225)
    for (const { row, col, label, type } of coordinates) {
      assert(Number.isInteger(row) && row >= 0 && row < 15 && Number.isInteger(col) && col >= 0 && col < 15)
      assert.equal(type, 'button')
      assert(label?.includes(`第${col + 1}列`) && label.includes(`第${row + 1}行`) && label.includes('空位'))
    }
    await counts(0)
    await expect(page.locator('#undoBtn')).toBeDisabled()
    await expect(page.locator('#board .point:not(:disabled)[tabindex="0"]')).toHaveCount(1)
    await screenshot('desktop-initial')
    return { coordinateCount: coordinates.length, state: await snapshot() }
  })

  await check('alternation-and-occupied-intersection', async () => {
    await freshGame()
    await play(7, 7, 'black', 1)
    const before = await snapshot()
    await pointerAttempt(7, 7)
    assert.deepEqual(await snapshot(), before, 'A real pointer click on an occupied intersection must not change the board or turn')
    await play(7, 8, 'white', 2)
    await play(8, 7, 'black', 3)
    return { occupiedClickUnchanged: true, state: await snapshot() }
  })

  const blackFillers = [[0, 0], [0, 2], [0, 4], [0, 6], [0, 8]]
  const scenarios = [
    { name: 'horizontal', winner: 'black', line: [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]] },
    { name: 'vertical', winner: 'black', line: [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]] },
    { name: 'diagonal-down', winner: 'black', line: [[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]] },
    { name: 'diagonal-up', winner: 'black', line: [[3, 11], [4, 10], [5, 9], [6, 8], [7, 7]] },
    { name: 'white-horizontal', winner: 'white', line: [[9, 3], [9, 4], [9, 5], [9, 6], [9, 7]] }
  ]
  for (const scenario of scenarios) {
    await check(`win-${scenario.name}-lock-undo-restart`, async () => {
      await freshGame()
      const moves = []
      for (let index = 0; index < 5; index++) {
        if (scenario.winner === 'white') {
          moves.push({ coordinate: blackFillers[index], color: 'black' })
          moves.push({ coordinate: scenario.line[index], color: 'white' })
        } else {
          moves.push({ coordinate: scenario.line[index], color: 'black' })
          if (index < 4) moves.push({ coordinate: blackFillers[index], color: 'white' })
        }
      }
      for (let index = 0; index < moves.length; index++) {
        const move = moves[index]
        await play(...move.coordinate, move.color, index + 1, index === moves.length - 1)
      }
      await expect(page.locator('#status-heading')).toHaveText(scenario.winner === 'black' ? '黑棋获胜！' : '白棋获胜！')
      await expect(page.locator('#statusBadge')).toBeVisible()
      await expect(page.locator('#statusBadge')).toHaveText('五子连珠')
      await expect(page.locator('#board .point[data-win="1"]')).toHaveCount(5)
      for (const coordinate of scenario.line) await expect(point(...coordinate)).toHaveAttribute('data-win', '1')
      const won = await snapshot()
      await pointerAttempt(14, 14)
      assert.deepEqual(await snapshot(), won, 'A real pointer click after game over must leave all state unchanged')
      await screenshot(`win-${scenario.name}`)

      await page.locator('#undoBtn').click()
      await counts(moves.length - 1)
      const last = moves.at(-1)
      await expect(point(...last.coordinate)).not.toHaveAttribute('data-stone', /.+/)
      await expect(page.locator('#turnStone')).toHaveAttribute('data-color', scenario.winner)
      await expect(page.locator('#statusBadge')).toBeHidden()
      await expect(page.locator('#board .point[data-win="1"]')).toHaveCount(0)
      await expect(point(...last.coordinate)).toBeEnabled()
      await play(...last.coordinate, scenario.winner, moves.length, true)
      await expect(page.locator('#statusBadge')).toBeVisible()

      await page.locator('#restartBtn').click()
      await counts(0)
      await expect(page.locator('#turnStone')).toHaveAttribute('data-color', 'black')
      await expect(page.locator('#statusBadge')).toBeHidden()
      await expect(page.locator('#undoBtn')).toBeDisabled()
      await expect(page.locator('#board .point:not(:disabled)')).toHaveCount(225)
      return { legalMoves: moves, winningState: won, blockedAfterWin: true, undoneAndWonAgain: true, restarted: true }
    })
  }

  await check('undo-step-by-step-and-empty-boundary', async () => {
    await freshGame()
    await play(7, 7, 'black', 1)
    await play(7, 8, 'white', 2)
    await play(8, 7, 'black', 3)
    for (const [total, row, col, color] of [[2, 8, 7, 'black'], [1, 7, 8, 'white'], [0, 7, 7, 'black']]) {
      await page.locator('#undoBtn').click()
      await counts(total)
      await expect(point(row, col)).toBeEnabled()
      await expect(point(row, col)).not.toHaveAttribute('data-stone', /.+/)
      await expect(page.locator('#turnStone')).toHaveAttribute('data-color', color)
    }
    await expect(page.locator('#undoBtn')).toBeDisabled()
    await page.keyboard.press('u')
    await counts(0)
    return { undoSteps: 3, emptyUndoUnchanged: true }
  })

  await check('keyboard-navigation-and-board-edges', async () => {
    await freshGame()
    await point(7, 7).focus()
    const directions = [['ArrowRight', 7, 8], ['ArrowDown', 8, 8], ['ArrowLeft', 8, 7], ['ArrowUp', 7, 7],
      ['Home', 0, 0], ['ArrowUp', 0, 0], ['ArrowLeft', 0, 0], ['End', 14, 14], ['ArrowRight', 14, 14], ['ArrowDown', 14, 14]]
    for (const [key, row, col] of directions) {
      await page.keyboard.press(key)
      await expect(point(row, col)).toBeFocused()
      await expect(page.locator('#board .point[tabindex="0"]')).toHaveCount(1)
    }
    await counts(0)
    return { keys: directions.map(([key, row, col]) => ({ key, row, col })) }
  })

  await check('keyboard-enter-then-navigation-and-space', async () => {
    await freshGame()
    await point(7, 7).focus()
    await page.keyboard.press('Enter')
    await counts(1)
    await expect(point(7, 7)).toHaveAttribute('data-stone', 'black')
    // A disabled occupied button cannot retain focus in Chromium. Accept the
    // accessible auto-advance, then verify navigation from its actual location.
    const afterEnter = await page.evaluate(() => ({
      inBoard: document.activeElement?.matches('#board .point:not(:disabled)') ?? false,
      row: Number(document.activeElement?.getAttribute('data-row')),
      col: Number(document.activeElement?.getAttribute('data-col'))
    }))
    assert(afterEnter.inBoard, 'Enter must leave keyboard focus on an enabled board intersection')
    assert(afterEnter.col < 14, 'The next focus after a center move must allow a rightward navigation check')
    await page.keyboard.press('ArrowRight')
    await expect(point(afterEnter.row, afterEnter.col + 1)).toBeFocused()
    await page.keyboard.press('Space')
    await counts(2)
    await expect(point(afterEnter.row, afterEnter.col + 1)).toHaveAttribute('data-stone', 'white')
    return { enterPlacedBlack: [7, 7], afterEnter, spacePlacedWhite: [afterEnter.row, afterEnter.col + 1] }
  })

  await check('keyboard-tab-reentry-after-placement', async () => {
    await freshGame()
    await play(7, 7, 'black', 1)
    await page.locator('#restartBtn').focus()
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => ({
      inBoard: document.activeElement?.matches('#board .point') ?? false,
      disabled: document.activeElement?.matches(':disabled') ?? false,
      element: document.activeElement?.outerHTML.slice(0, 300),
      enabledTabStops: document.querySelectorAll('#board .point:not(:disabled)[tabindex="0"]').length
    }))
    assert(focus.inBoard && !focus.disabled, `Tab must reenter an enabled intersection after a move: ${JSON.stringify(focus)}`)
    assert.equal(focus.enabledTabStops, 1)
    await page.keyboard.press('Space')
    await counts(2)
    return focus
  })

  await check('keyboard-undo-and-restart-shortcuts', async () => {
    await freshGame()
    await play(7, 7, 'black', 1)
    await play(7, 8, 'white', 2)
    await page.keyboard.press('u')
    await counts(1)
    await expect(point(7, 8)).not.toHaveAttribute('data-stone', /.+/)
    await page.keyboard.press('r')
    await counts(0)
    await expect(page.locator('#turnStone')).toHaveAttribute('data-color', 'black')
    return { undoKey: 'u', restartKey: 'r', finalState: await snapshot() }
  })

  await check('mobile-375-width-no-horizontal-overflow', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(375, 812))
    // Windows rounds native content dimensions at fractional DPR. Set the CSS
    // viewport explicitly so a 376px native rounding is not a product failure.
    await page.setViewportSize({ width: 375, height: 812 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(375)
    await freshGame()
    const geometry = await page.evaluate(() => {
      const board = document.querySelector('#board').getBoundingClientRect()
      return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        rootScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
        board: { left: board.left, right: board.right, top: board.top, width: board.width, height: board.height },
        outOfBoundsPoints: [...document.querySelectorAll('#board .point')].filter(element => {
          const rectangle = element.getBoundingClientRect()
          return rectangle.left < -1 || rectangle.right > window.innerWidth + 1
        }).length }
    })
    assert(geometry.rootScrollWidth <= 375 && geometry.bodyScrollWidth <= 375, JSON.stringify(geometry))
    assert(geometry.board.left >= 0 && geometry.board.right <= 375 && geometry.board.width > 250, JSON.stringify(geometry))
    assert(Math.abs(geometry.board.width - geometry.board.height) <= 1, JSON.stringify(geometry))
    assert.equal(geometry.outOfBoundsPoints, 0)
    await play(7, 7, 'black', 1)
    await play(7, 8, 'white', 2)
    await screenshot('mobile-375-played')
    return { ...geometry, method: '375 CSS-pixel Chromium viewport in the actual Electron renderer' }
  })
} catch (error) {
  report.checks.push({ name: 'electron-launch-or-harness', status: 'failed', error: error instanceof Error ? error.stack : String(error) })
} finally {
  if (application) {
    try { await application.close() } catch (error) { report.mainErrors.push(`close: ${String(error)}`) }
  }
  report.sourceAfter = sourceManifest()
  try {
    assert.deepEqual(report.sourceAfter, report.sourceBefore)
    report.checks.push({ name: 'source-files-unchanged-during-verification', status: 'passed' })
  } catch {
    report.checks.push({ name: 'source-files-unchanged-during-verification', status: 'failed', error: 'Game source changed during verification; rerun against the final source.' })
  }
  report.checks.push({ name: 'renderer-runtime-errors', status: report.pageErrors.length || report.consoleErrors.length || report.mainErrors.length ? 'failed' : 'passed',
    evidence: { pageErrors: report.pageErrors.length, consoleErrors: report.consoleErrors.length, mainErrors: report.mainErrors.length } })
  report.finishedAt = new Date().toISOString()
  report.passed = report.checks.filter(check => check.status === 'passed').length
  report.failed = report.checks.filter(check => check.status === 'failed').length
  report.ok = report.failed === 0
  const reportFile = path.join(output, 'gomoku-verification.json')
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: report.ok, passed: report.passed, failed: report.failed, report: reportFile }))
  if (!report.ok) process.exitCode = 1
}
